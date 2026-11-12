// SEL-116 — supervisor thread of an isolated extraction. Runs inside a worker_threads Worker; do not import it.
//
// Why a supervisor: the server runs file.extract inside a synchronous write transaction, so the main thread BLOCKS (Atomics.wait)
// while the extraction runs, and a blocked main thread cannot hear "the worker ran out of memory" (that event needs its event
// loop). This thread has an event loop of its own. It starts the extraction Worker with hard resource limits, listens for
// message / error / exit, enforces the wall-time limit with worker.terminate(), and tells the blocked main thread how it ended
// through one shared Int32 (the outcome itself travels on a MessagePort that goes main <-> extraction worker directly).
//
// This file imports nothing from file_extract.ts on purpose: the supervisor stays tiny
// (and nothing imports THIS file: loading it starts a Worker).

import { Worker, workerData, type MessagePort } from "node:worker_threads";

import { FLAG_DONE, FLAG_ERROR, FLAG_OUT_OF_MEMORY, FLAG_TIMEOUT } from "./file_extract_flags.ts";

interface SupervisorData {
  flag: Int32Array;
  input: ArrayBuffer;
  name: string | null;
  port: MessagePort;
  worker_url: string;
  heap_mb: number;
  young_mb: number;
  stack_mb: number;
  timeout_ms: number;
}

const data = workerData as SupervisorData;
let settled = false;

function settle(code: number): void {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  Atomics.store(data.flag, 0, code);
  Atomics.notify(data.flag, 0);
  worker.terminate().then(
    () => process.exit(0),
    () => process.exit(0),
  );
}

const worker = new Worker(new URL(data.worker_url), {
  workerData: { input: data.input, name: data.name, port: data.port },
  transferList: [data.input, data.port],
  resourceLimits: {
    maxOldGenerationSizeMb: data.heap_mb,
    maxYoungGenerationSizeMb: data.young_mb,
    stackSizeMb: data.stack_mb,
  },
});
const timer = setTimeout(() => settle(FLAG_TIMEOUT), data.timeout_ms);

worker.on("message", (message: unknown) => {
  // The outcome was already posted on the port (before this message), so it is waiting in the main thread's queue.
  settle(message === "done" ? FLAG_DONE : FLAG_ERROR);
});
worker.on("error", (error: Error & { code?: string }) => {
  settle(error.code === "ERR_WORKER_OUT_OF_MEMORY" ? FLAG_OUT_OF_MEMORY : FLAG_ERROR);
});
worker.on("exit", () => {
  settle(FLAG_ERROR); // an exit without "done" (settle ignores it when the run already ended)
});
