// The one outbound HTTP helper of the built-in runner (stage 2 PR19). It never follows a redirect (a key must
// not be re-sent to another address), has a time limit, and tells apart "an answer arrived" from "no answer":
// a timeout and a lost connection are different outcomes from an HTTP error status, because only the first two
// leave a model call whose result nobody knows.
//
// SEL-79: the default fetch (undici) reuses an idle keep-alive socket. If the server closed that socket just before
// the new request's bytes arrived, undici does not retry a POST, the fetch rejects and the call would count as
// "lost" (usage_unknown) although nothing reached the server. So the DEFAULT POST path (model calls; the GET model listing is left as it was) sends `connection: close`: undici
// then ends the socket after every reply, no call ever rides on a reused socket, and that race cannot happen. Chosen
// because it is one header on Node's built-in fetch (no new dependency, no custom Agent, same on Windows and macOS)
// and it never retries anything: a request that was sent and broke is still "lost". The cost is one new connection
// per model call, small next to a model call. An injected fetch_fn is used exactly as given (no header added).

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export type HttpOutcome =
  | { kind: "reply"; status: number; headers: Record<string, string>; json: unknown; text: string; text_bytes: number }
  | { kind: "timeout"; status?: number; partial_text?: string }
  | { kind: "lost"; status?: number; partial_text?: string };

export interface HttpRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/** The most bytes of an answer body that are read; a longer body is cut off and counts as "lost" (outcome unknown). */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

class BodyTooLarge extends Error {}

/** Reads the body in pieces and stops at the limit, so a hostile or broken server cannot fill the memory. */
/** What arrived of a body before reading it stopped (a broken stream, a time-out, a body over the limit). */
interface Received {
  chunks: Uint8Array[];
}

async function read_text_limited(response: Response, max_bytes: number, received: Received): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max_bytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new BodyTooLarge();
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks = received.chunks;
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max_bytes) {
      chunks.push(value.subarray(0, Math.max(0, value.byteLength - (total - max_bytes))));
      void reader.cancel().catch(() => undefined);
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function http_json(
  request: HttpRequest,
  timeout_ms: number,
  fetch_fn: FetchFn | undefined = undefined,
  max_bytes: number = MAX_RESPONSE_BYTES,
): Promise<HttpOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout_ms);
  const received: Received = { chunks: [] };
  const send: FetchFn =
    fetch_fn ??
    ((url, init) => (request.method === "POST" ? fetch(url, { ...init, headers: { ...request.headers, connection: "close" } }) : fetch(url, init)));
  let status: number | undefined;
  try {
    const response = await send(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body }),
      redirect: "error",
      signal: controller.signal,
    });
    status = response.status;
    const text = await read_text_limited(response, max_bytes, received);
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    let json: unknown = null;
    try {
      json = text.length > 0 ? (JSON.parse(text) as unknown) : null;
    } catch {
      json = null;
    }
    return { kind: "reply", status: response.status, headers, json, text, text_bytes: Buffer.byteLength(text, "utf8") };
  } catch (error) {
    void error;
    // the status and the part of the body that did arrive (the caller reads only a billing signal from it)
    const partial = status === undefined ? {} : { status, partial_text: Buffer.concat(received.chunks).toString("utf8") };
    if (controller.signal.aborted) return { kind: "timeout", ...partial };
    return { kind: "lost", ...partial };
  } finally {
    clearTimeout(timer);
  }
}

/** retry-after as milliseconds from now: delta-seconds or an HTTP date; null when absent or unreadable. */
export function retry_after_ms(headers: Record<string, string>, now_ms: number): number | null {
  const raw = headers["retry-after"];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (/^[0-9]{1,9}$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - now_ms);
}
