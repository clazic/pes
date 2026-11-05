export interface FakeGoStats {
  requests: number;
  requestBytes: number;
  responseBytes: number;
  calls: { index: number; requestBytes: number; responseBytes: number; path: string }[];
}

export interface FakeGoServer {
  url: string;
  stats: FakeGoStats;
  reset(): void;
  stop(): Promise<void>;
}

const RESPONSE_SIZES = [8 * 1024, 16 * 1024, 12 * 1024];

function deterministicJson(callIndex: number, targetBytes: number): string {
  const head = {
    id: `fake-go-${callIndex}`,
    object: "chat.completion",
    model: "opencode-go/synthetic-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: `synthetic-call-${callIndex}` },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
    padding: "",
  };
  let padding = 0;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    head.padding = "x".repeat(Math.max(0, padding));
    const size = Buffer.byteLength(JSON.stringify(head), "utf8");
    const diff = targetBytes - size;
    if (diff === 0) break;
    padding = Math.max(0, padding + diff);
  }
  return JSON.stringify(head);
}

export async function startFakeGo(options: { delayMs?: number } = {}): Promise<FakeGoServer> {
  const { createServer } = await import("node:http");
  const delayMs = options.delayMs ?? 200;
  const stats: FakeGoStats = { requests: 0, requestBytes: 0, responseBytes: 0, calls: [] };
  let callIndex = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      callIndex += 1;
      const responseBody = deterministicJson(callIndex, RESPONSE_SIZES[(callIndex - 1) % 3] ?? 8192);
      const responseBytes = Buffer.byteLength(responseBody, "utf8");
      stats.requests += 1;
      stats.requestBytes += body.length;
      stats.responseBytes += responseBytes;
      stats.calls.push({
        index: callIndex,
        requestBytes: body.length,
        responseBytes,
        path: request.url ?? "/",
      });
      setTimeout(() => {
        response.writeHead(200, {
          "Content-Type": "application/json",
          "X-Fake-Go-Call": String(callIndex),
        });
        response.end(responseBody);
      }, delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake Go listen failed");
  return {
    url: `http://127.0.0.1:${address.port}/inference/v1/chat/completions`,
    stats,
    reset() {
      stats.requests = 0;
      stats.requestBytes = 0;
      stats.responseBytes = 0;
      stats.calls.length = 0;
      callIndex = 0;
    },
    async stop() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/** Build a caller payload of approximately the requested byte size. */
export function goRequestPayload(callIndex: number, targetBytes: number): string {
  const head = {
    model: "opencode-go/synthetic-model",
    messages: [
      { role: "system", content: "synthetic system prompt" },
      { role: "user", content: `synthetic call ${callIndex}` },
    ],
    max_tokens: 1024,
    padding: "",
  };
  let padding = Math.max(0, targetBytes - 512);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    head.padding = "y".repeat(Math.max(0, padding));
    const size = Buffer.byteLength(JSON.stringify(head), "utf8");
    const diff = targetBytes - size;
    if (diff === 0) break;
    padding = Math.max(0, padding + diff);
  }
  return JSON.stringify(head);
}
