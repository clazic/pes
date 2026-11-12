// SEL-116 — a stand-in for the extraction thread that misbehaves on purpose, so a test can see that the isolation (worker limits,
// supervisor, time limit) holds even when the extractor's own Budget is out of the picture. Chosen by the file name it is "given":
//   oom.txt   keeps allocating small strings in a JavaScript loop until the heap limit ends the thread
//   spin.txt  loops forever
//   native.txt  sorts a 2,000,000 element array: ONE native V8 step (about 2-3 s) that worker.terminate() cannot cut, so the thread
//               stays alive after the time limit (the case the unfinished-thread counter is for)
//   throw.txt throws
//   exit.txt  ends the thread without answering
//   ok.txt    answers like a normal extraction
// Same contract as scripts/pes_core/file_extract_worker.ts: workerData {input, name, port}; the outcome goes to the port, then "done".

import { parentPort, workerData, type MessagePort } from "node:worker_threads";

const { name, port } = workerData as { input: ArrayBuffer; name: string; port: MessagePort };

if (name === "oom.txt") {
  const keep: string[] = [];
  for (let i = 0; ; i += 1) keep.push(`${"x".repeat(64)}${i}`);
} else if (name === "spin.txt") {
  for (;;) {
    /* never returns */
  }
} else if (name === "native.txt") {
  const numbers = new Array<number>(2_000_000);
  for (let i = 0; i < numbers.length; i += 1) numbers[i] = ((i * 7919) % 100003) + 0.5;
  numbers.sort(); // default comparator: one long native step
  port.postMessage({ status: "extracted", reason: null, text: "late", page_count: null, table_count: 0, warnings: [] });
  parentPort?.postMessage("done");
} else if (name === "throw.txt") {
  throw new Error("synthetic failure inside the extraction thread");
} else if (name === "exit.txt") {
  process.exit(3);
} else {
  port.postMessage({ status: "extracted", reason: null, text: "ok", page_count: null, table_count: 0, warnings: [] });
  parentPort?.postMessage("done");
}
