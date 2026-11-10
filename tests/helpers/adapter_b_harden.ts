// SEL-53 (보강 모드) shared pieces for the hardening tests of the method-B Claude adapter.
// Everything is synthetic and in-process: an ApiApp over a temporary HOME/PES_HOME, no real Claude, no MCP config.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { ClaudeAppAdapter, type HandoffBundle } from "../../scripts/pes_core/adapters/claude_app.ts";
import { add_artifact, create_object } from "../../scripts/pes_core/content.ts";
import { SESSION_SECRET, assert_ok, call } from "./api_env.ts";
import type { AdapterEnv, FakeMcpClient } from "./adapter_b_env.ts";
import { ctx_for } from "./blob_env.ts";

export function adapter(env: AdapterEnv, overrides: Record<string, unknown> = {}): ClaudeAppAdapter {
  return new ClaudeAppAdapter({
    api: env.app,
    project_id: env.p.project_id,
    owner_session: SESSION_SECRET,
    ...overrides,
  } as any);
}

export const export_for = (env: AdapterEnv, a: ClaudeAppAdapter = adapter(env)) =>
  a.export_bundle({ stage_id: env.stage.plan, round_id: env.round_id });

/** The pasted result an app would answer with. */
export function paste(object_id: string, title = "앱이 쓴 장", extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ results: [{ op: "append_version", object_id, title }], ...extra });
}

// The bundle hash is a plain sha256 of the key-sorted JSON (docs: "hash는 인증이 아니다"). A forger who can edit the
// text can recompute it, so these tests recompute it too: only the owner session and PES's own checks may stop them.
function canonical_json(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonical_json(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical_json(record[key])}`)
    .join(",")}}`;
}

export function forge_bundle(bundle: HandoffBundle, patch: Record<string, unknown>): string {
  const { manifest_hash: _old, ...body } = { ...bundle, ...patch } as Record<string, unknown>;
  const manifest_hash = createHash("sha256").update(canonical_json(body), "utf8").digest("hex");
  return JSON.stringify({ ...body, manifest_hash });
}

/** Await a promise that must be refused; returns the error (a HandoffError with a string code). */
export async function refused(promise: Promise<unknown>, code?: string | string[]): Promise<any> {
  try {
    await promise;
  } catch (error: any) {
    assert.equal(typeof error.code, "string", `a refusal carries a code, got ${String(error)}`);
    const wanted = code === undefined ? undefined : Array.isArray(code) ? code : [code];
    if (wanted !== undefined) assert.ok(wanted.includes(error.code), `expected ${wanted.join("|")}, got ${error.code}: ${error.message}`);
    assert.match(String(error.message), /[가-힣]/, "the message is Korean");
    return error;
  }
  assert.fail(`expected a refusal${code === undefined ? "" : ` (${String(code)})`}`);
}

export interface Second {
  project_id: string;
  token: string;
  device_actor_id: string;
  owner_actor_id: string;
  edition_id: string;
  stage_ids: Record<string, string>;
  round_id: string;
  object_id: string;
  version_id: string;
}

/** A second project on the same account, registered through the API as the owner (PR14), with a round and one artifact. */
export async function register_second(env: AdapterEnv, slug = "synthetic-second-project"): Promise<Second> {
  const body = { slug, topic: "합성 두 번째 프로젝트", owner_display_name: "합성 소유자", device_label: "합성 기기 B" };
  const reg = assert_ok(await call(env, { method: "POST", path: "/api/v1/project-registrations", auth: "owner", body }), 201);
  const owner = { project_id: reg.project_id as string, actor_id: reg.owner_actor_id as string, edition_id: reg.edition_id as string };
  const round = assert_ok(
    await call(env, { method: "POST", path: `/api/v1/projects/${reg.project_id}/stages/${reg.stage_ids.plan}/rounds`, auth: "owner", body: {} }),
    201,
  ).round;
  const created = (await create_object(env.service, ctx_for(owner, `${slug}-o`), { kind: "artifact", edition_id: owner.edition_id })).result as { object_id: string };
  const version = (
    await add_artifact(env.service, ctx_for(owner, `${slug}-v`), { object_id: created.object_id, artifact_kind: "chapter", title: "둘째 프로젝트 장", summary: "합성" })
  ).result as { version_id: string };
  return {
    project_id: reg.project_id,
    token: reg.token,
    device_actor_id: reg.device_actor_id,
    owner_actor_id: reg.owner_actor_id,
    edition_id: reg.edition_id,
    stage_ids: reg.stage_ids,
    round_id: round.id,
    object_id: created.object_id,
    version_id: version.version_id,
  };
}

export function changed_tables(before: Record<string, bigint>, after: Record<string, bigint>): string[] {
  return Object.keys(after).filter((name) => after[name] !== before[name]);
}

/** Write raw lines (already newline-terminated or not) to the fake client's stdin without waiting for answers. */
export function write_raw(client: FakeMcpClient, text: string | Uint8Array): void {
  client.input.write(text);
}

/** A ping round trip: every line written before it has been answered (the server answers in order) when it returns. */
export async function barrier(client: FakeMcpClient, from: number = client.lines.length): Promise<number> {
  await client.request("ping");
  return client.lines.length - from;
}

export const rpc_line = (message: unknown): string => `${JSON.stringify(message)}\n`;

export const tool_call = (id: number | string, name: string, args: Record<string, unknown>): unknown => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});
