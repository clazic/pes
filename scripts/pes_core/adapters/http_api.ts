// An ApiLike that talks to a running local PES server over HTTP (stage 2 PR20a, SEL-53).
//
// Used by the MCP server process, which is started by an AI tool and has no database of its own. The base URL must
// be a loopback address: the agent token is sent there, so it must never leave this computer.

import type { ApiLike, ApiRequestLike, ApiResponseLike } from "./api_client.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export class HttpApi implements ApiLike {
  readonly #base: string;

  constructor(base_url: string) {
    let url: URL;
    try {
      url = new URL(base_url);
    } catch {
      throw new Error("PES_API_BASE_URL이 올바른 주소가 아닙니다.");
    }
    if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
      throw new Error("PES_API_BASE_URL은 이 컴퓨터의 http 주소(127.0.0.1)여야 합니다.");
    }
    this.#base = `${url.protocol}//${url.host}`;
  }

  async handle(request: ApiRequestLike): Promise<ApiResponseLike> {
    const response = await fetch(`${this.#base}${request.path}`, {
      method: request.method,
      headers: request.headers,
      body: request.body === null ? undefined : request.body,
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name] = value;
    });
    const buffer = new Uint8Array(await response.arrayBuffer());
    const type = headers["content-type"] ?? "";
    if (type.startsWith("application/json")) {
      let json: unknown = null;
      try {
        json = JSON.parse(new TextDecoder("utf-8").decode(buffer));
      } catch {
        json = null;
      }
      return { status: response.status, headers, json, bytes: null };
    }
    return { status: response.status, headers, json: null, bytes: buffer };
  }
}
