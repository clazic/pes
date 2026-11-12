// SEL-116 — run the extraction of one file in a worker thread with hard limits, so that a hostile file can end the extraction
// (failed/too_large, failed/extract_timeout) but never the server process.
//
// extract_text (file_extract.ts) stays a pure function with its own Budget — the fast refusal. This module is the second wall:
// whatever the Budget missed (a piece of work that allocates before it is counted, a regex that blows the heap, one step that runs
// too long) hits the Worker's limits instead of the server's heap:
//
//   main thread --(copy of the bytes, name)--> supervisor Worker --> extraction Worker (resourceLimits: heap, young, stack)
//        ^                                                                  |
//        +------------------ outcome on a MessagePort (nothing else) -------+
//
// The caller (a command inside a synchronous write transaction) needs the answer synchronously, so the main thread waits with
// Atomics.wait. The supervisor thread (file_extract_supervisor.ts) owns the event loop that sees ERR_WORKER_OUT_OF_MEMORY, error and
// exit, and enforces the wall-time limit with worker.terminate(). The extraction Worker has no database, disk or network access:
// it gets the original bytes and the file name and returns the outcome. Paths are file URLs (pathToFileURL), so Windows and macOS
// behave the same.
//
// Known limit: worker.terminate() cannot cut one long NATIVE step (a V8 builtin such as one huge string replace or array sort).
// The thread keeps running until that step ends, in the same process, and its memory stays used. This module therefore counts the
// threads it could not end (unfinished_extraction_threads: raised when a time limit hit and the supervisor did not report "ended"
// within a short grace, lowered when the supervisor thread really exits). While the count is above 0 a new extraction starts NO
// Worker and answers failed/extract_busy at once, so repeated hostile uploads cannot pile such threads up. The real extractor has
// no such step left (no regular-expression replace/split over file-sized text); the counter is the wall behind that rule.

import { MessageChannel, Worker, receiveMessageOnPort } from "node:worker_threads";
import { fileURLToPath, pathToFileURL } from "node:url";

import { MAX_SOURCE_BYTES, PARSED_FORMATS, extract_text, format_of, too_large_outcome, type ExtractOutcome } from "./file_extract.ts";
import { FLAG_DONE, FLAG_OUT_OF_MEMORY, FLAG_PENDING, FLAG_TIMEOUT, SLOT_ENDED, SLOT_OUTCOME } from "./file_extract_flags.ts";

/** Old-generation heap of the extraction thread. A 30万-row workbook needs well below this; a hostile file hits it quickly. */
export const EXTRACT_HEAP_MB = 256;
/** Young generation and stack of the extraction thread. */
const EXTRACT_YOUNG_MB = 32;
const EXTRACT_STACK_MB = 4;
/** Wall time of one extraction thread, starting when the supervisor starts it. Over it the thread is terminated. */
export const EXTRACT_WORKER_TIMEOUT_MS = 15_000;
/** The main thread's own fallback wait, on top of the thread's time limit (the supervisor should always answer first). */
const MAIN_WAIT_SLACK_MS = 5_000;
/** After a time limit: how long the main thread waits for the supervisor to report that the thread really ended. */
const END_GRACE_MS = 1_000;

/** Threads (a supervisor and its extraction thread) that a time limit hit and that were still running after END_GRACE_MS. */
let unfinished_threads = 0;
/** For tests and diagnostics: how many cut-off extraction threads are still running in this process. */
export function unfinished_extraction_threads(): number {
  return unfinished_threads;
}

const SUPERVISOR_URL = pathToFileURL(fileURLToPath(new URL("./file_extract_supervisor.ts", import.meta.url))).href;
const WORKER_URL = pathToFileURL(fileURLToPath(new URL("./file_extract_worker.ts", import.meta.url))).href;

function failed(code: string, message: string): ExtractOutcome {
  return { status: "failed", reason: code, text: null, page_count: null, table_count: 0, warnings: [{ code, message }] };
}

function looks_like_outcome(value: unknown): value is ExtractOutcome {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.status === "string" && Array.isArray(v.warnings) && (v.text === null || typeof v.text === "string");
}

/** Overrides for tests only (a hostile stand-in for the extraction thread, small limits). The server passes none. */
export interface IsolationOptions {
  worker_url?: string;
  heap_mb?: number;
  timeout_ms?: number;
  end_grace_ms?: number;
}

/** extract_text, run in a worker thread with a heap limit and a wall-time limit. Never throws; a limit hit is a failed outcome. */
export function extract_text_isolated(original_name: string | null, bytes: Uint8Array, options: IsolationOptions = {}): ExtractOutcome {
  if (bytes.byteLength > MAX_SOURCE_BYTES) return too_large_outcome();
  if (!PARSED_FORMATS.has(format_of(original_name))) return extract_text(original_name, bytes);

  if (unfinished_threads > 0) {
    return failed("extract_busy", "앞선 글자 뽑기의 스레드가 아직 끝나지 않아 지금은 새로 시작하지 않았습니다. 잠시 뒤 다시 시도하세요. 글자를 지어내지 않았습니다.");
  }

  const timeout_ms = options.timeout_ms ?? EXTRACT_WORKER_TIMEOUT_MS;
  const flag = new Int32Array(new SharedArrayBuffer(8));
  const { port1, port2 } = new MessageChannel();
  const input = new Uint8Array(bytes).buffer; // a private copy that is handed over (transferred), the caller's bytes stay usable
  let supervisor: Worker | null = null;
  let counted = false; // this run raised unfinished_threads and has not lowered it yet
  let exited = false; // the supervisor thread has really exited (seen on the event loop, i.e. after this call returned)
  try {
    supervisor = new Worker(new URL(SUPERVISOR_URL), {
      workerData: {
        flag,
        input,
        name: original_name,
        port: port2,
        worker_url: options.worker_url ?? WORKER_URL,
        heap_mb: options.heap_mb ?? EXTRACT_HEAP_MB,
        young_mb: EXTRACT_YOUNG_MB,
        stack_mb: EXTRACT_STACK_MB,
        timeout_ms,
      },
      transferList: [input, port2],
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
    supervisor.once("exit", () => {
      exited = true;
      if (counted) {
        counted = false;
        unfinished_threads -= 1;
      }
    });
    Atomics.wait(flag, SLOT_OUTCOME, 0, timeout_ms + MAIN_WAIT_SLACK_MS);
    const code = Atomics.load(flag, SLOT_OUTCOME);
    if (code === FLAG_DONE) {
      const message = receiveMessageOnPort(port1)?.message;
      if (looks_like_outcome(message)) return message;
      return failed("extract_error", "글자를 뽑는 중 예기치 않은 오류가 나서 멈췄습니다. 글자를 지어내지 않았습니다.");
    }
    if (code === FLAG_OUT_OF_MEMORY) {
      return failed("too_large", "글자를 뽑는 데 메모리가 상한을 넘어 멈췄습니다. 일부만 돌려주거나 글자를 지어내지 않았습니다.");
    }
    if (code === FLAG_TIMEOUT || code === FLAG_PENDING) {
      // Did the thread really end? A thread cut off at once reports it within milliseconds; one that is inside a native step does not.
      Atomics.wait(flag, SLOT_ENDED, 0, options.end_grace_ms ?? END_GRACE_MS);
      if (Atomics.load(flag, SLOT_ENDED) === 0 && !exited) {
        counted = true;
        unfinished_threads += 1;
      }
      return failed("extract_timeout", "글자를 뽑는 데 시간이 상한을 넘어 멈췄습니다. 일부만 돌려주거나 글자를 지어내지 않았습니다.");
    }
    return failed("extract_error", "글자를 뽑는 중 예기치 않은 오류가 나서 멈췄습니다. 글자를 지어내지 않았습니다.");
  } catch (error) {
    // Node's permission model (--permission without --allow-worker) refuses to start any Worker: that is the computer, not the file.
    if ((error as { code?: unknown } | null)?.code === "ERR_ACCESS_DENIED") {
      return failed("worker_unavailable", "이 실행 환경은 작업 스레드를 허용하지 않아 글자를 뽑지 못했습니다(Node --permission 에는 --allow-worker 가 필요합니다). 글자를 지어내지 않았습니다.");
    }
    return failed("extract_error", "글자를 뽑는 중 예기치 않은 오류가 나서 멈췄습니다. 글자를 지어내지 않았습니다.");
  } finally {
    port1.close();
    if (supervisor !== null) {
      supervisor.unref();
      supervisor.terminate().catch(() => undefined);
    }
  }
}
