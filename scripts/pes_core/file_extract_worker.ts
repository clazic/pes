// SEL-116 — the extraction thread of an isolated extraction. Runs inside a worker_threads Worker started by the supervisor
// (file_extract_supervisor.ts) with resourceLimits; do not import it. Gets only the original bytes and the file name, touches no
// database, no disk, no network: bytes in, outcome out (posted straight to the main thread's port, then "done" to the supervisor).

import { parentPort, workerData, type MessagePort } from "node:worker_threads";

import { extract_text } from "./file_extract.ts";

const { input, name, port } = workerData as { input: ArrayBuffer; name: string | null; port: MessagePort };
const outcome = extract_text(name, new Uint8Array(input));
port.postMessage(outcome);
parentPort?.postMessage("done");
