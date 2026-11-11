// The Claude app side of method B: an explicit hand-off (stage 2 PR20a, SEL-53).
//
// The Claude app is not connected to PES here. The human copies a bundle out of PES, talks to the app, and pastes the
// app's answer back. Two steps, and only the second one writes:
//
//   export_bundle  a pure read. The bundle names the request (project, edition, stage, round, base versions,
//                  control_rev, a request id) and carries an integrity hash. It holds no token, no session secret, no
//                  lease and no fence. Copying creates no run and takes no lease, so waiting costs nothing.
//   import_result  the human's act. The pasted result is checked against the bundle, then PES records it as an
//                  IMPORT by the human owner (a human actor, via 'import'), on the owner's own hand-off run
//                  (runtime claude_app_handoff, model unknown), in one step. It is never an agent's claim: there is
//                  no agent token, no lease. What the app says about itself (tool, model) is kept only as a claim
//                  with provenance.verified = false.
//
// manifest_hash is an integrity check against accidents (a half-edited bundle). It proves nothing about who sent the
// text and it grants nothing: the owner session is what PES checks.

import { createHash, randomUUID } from "node:crypto";

import { api_request, project_path, type ApiLike, type ApiResult } from "./api_client.ts";

export interface ClaudeAppAdapterOptions {
  /** ApiApp-shaped: the local PES API. */
  api: ApiLike;
  project_id: string;
  /** The human owner's local session. It approves the import (the human pressed "가져오기"). */
  owner_session: string;
}

/** The apps an explicit hand-off can come from: the closed `app` list of the server's import (PR20c). */
export type HandoffApp = "claude_app" | "codex_app" | "opencode_app";

export interface BundleBaseVersion {
  object_id: string;
  version_id: string;
}

export interface HandoffBundle {
  format_version: "1.0";
  kind: "pes.handoff";
  project_id: string;
  edition_id: string;
  stage_id: string;
  stage_key: string;
  round_id: string;
  base_control_rev: string;
  base_versions: BundleBaseVersion[];
  request_id: string;
  manifest_hash: string;
  instructions: string;
}

export interface ImportInput {
  bundle_text: string;
  result_text: string;
  /** Files the pasted result names. Names only are checked in this version; storing attachments is not supported yet. */
  attachments?: Array<{ name: string }>;
}

export interface ImportOutcome {
  status: "imported";
  run_id: string;
  results: Array<{ object_id: string; version_id: string; version_no: number }>;
  adopted_by: string;
  via: "import";
  provenance: { source: "manual_import"; claimed_tool: string | null; claimed_model: string | null; verified: false };
}

/** A refusal of the hand-off. `code` is a bundle code below, or the PES API error code when PES refused. */
export class HandoffError extends Error {
  readonly code: string;
  readonly next_action: string | null;
  readonly details: unknown;
  constructor(code: string, message: string, next_action: string | null = null, details: unknown = null) {
    super(message);
    this.name = "HandoffError";
    this.code = code;
    this.next_action = next_action;
    this.details = details;
  }
}

const DECIMAL = /^(0|[1-9][0-9]*)$/;
/** The most base versions a bundle may carry. The same number as MAX_EXPECTED_HEADS in commands/handoff_import.ts (the adapter only talks to the API, so it does not import server code). */
export const MAX_BUNDLE_BASE_VERSIONS = 1000;
const HEX64 = /^[0-9a-f]{64}$/;
const BUNDLE_FIELDS = [
  "format_version",
  "kind",
  "project_id",
  "edition_id",
  "stage_id",
  "stage_key",
  "round_id",
  "base_control_rev",
  "base_versions",
  "request_id",
  "manifest_hash",
  "instructions",
] as const;
const APPENDABLE_KINDS = new Set(["artifact", "source"]);
const MAX_CLAIM_CHARS = 200;

function is_record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical_json(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonical_json(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical_json(record[key])}`).join(",")}}`;
}

function hash_of(bundle: Omit<HandoffBundle, "manifest_hash">): string {
  return createHash("sha256").update(canonical_json(bundle), "utf8").digest("hex");
}

const INSTRUCTIONS = [
  "이 묶음은 PES 프로젝트에서 복사한 작업 요청입니다. 묶음 자체를 고치지 마세요.",
  "base_versions에 적힌 자료(object_id)에 대해서만 새 버전을 만들어 아래 JSON 한 개로만 답해 주세요. 다른 설명은 붙이지 마세요.",
  '{"results":[{"op":"append_version","object_id":"<base_versions의 object_id>","title":"…","summary":"…","body_md":"…"}],"claimed":{"tool":"<쓴 도구 이름>","model":"<모델 이름>"}}',
  "claimed는 선택이며, PES는 이 값을 확인하지 않고 '주장'으로만 기록합니다. 이 답은 사람이 PES에 붙여 넣어야 반영되고, 붙여 넣기 전에는 아무것도 바뀌지 않습니다.",
].join("\n");

export class ClaudeAppAdapter {
  readonly #api: ApiLike;
  readonly #project_id: string;
  readonly #session: string;

  constructor(options: ClaudeAppAdapterOptions) {
    if (options === null || typeof options !== "object") throw new TypeError("ClaudeAppAdapter options are required");
    if (typeof options.project_id !== "string" || options.project_id.length === 0) {
      throw new TypeError("project_id must be a non-empty string");
    }
    if (typeof options.owner_session !== "string") throw new TypeError("owner_session must be a string");
    this.#api = options.api;
    this.#project_id = options.project_id;
    this.#session = options.owner_session;
  }

  async #owner_call(method: string, rest: string, body: unknown, key: string | null): Promise<ApiResult> {
    const headers: Record<string, string> = { "x-pes-session": this.#session };
    let payload: string | null = null;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers["content-type"] = "application/json";
    }
    if (key !== null) headers["idempotency-key"] = key;
    return api_request(this.#api, { method, path: project_path(this.#project_id, rest), headers, body: payload });
  }

  /**
   * The app this adapter hands off for. A subclass for another app overrides it; the import request then names it
   * in the closed `app` field and the server derives the run's runtime and provider from that (PR20c). The Claude
   * app sends no `app`, which is the same request as before PR20c.
   */
  protected handoff_app(): HandoffApp {
    return "claude_app";
  }

  #refusal(result: ApiResult & { ok: false }): HandoffError {
    return new HandoffError(result.error.code, result.error.message, result.error.next_action, result.error.details);
  }

  async #context(): Promise<Record<string, unknown>> {
    const result = await this.#owner_call("GET", "/context", undefined, null);
    if (!result.ok) throw this.#refusal(result);
    if (!is_record(result.data)) throw new HandoffError("internal_error", "PES의 답을 읽을 수 없습니다.");
    return result.data;
  }

  /** Copy out: a pure read of the current state into a bundle. Nothing is written. */
  async export_bundle(input: { stage_id: string; round_id: string }): Promise<{ bundle: HandoffBundle; text: string }> {
    if (!is_record(input) || typeof input.stage_id !== "string" || input.stage_id.length === 0) {
      throw new HandoffError("bundle_invalid", "단계(stage_id)를 알려 주세요.");
    }
    if (typeof input.round_id !== "string" || input.round_id.length === 0) {
      throw new HandoffError("bundle_invalid", "라운드(round_id)를 알려 주세요.");
    }
    const context = await this.#context();
    const stages = Array.isArray(context.stages) ? context.stages : [];
    const stage = stages.find((entry) => is_record(entry) && entry.stage_id === input.stage_id);
    if (!is_record(stage) || typeof stage.key !== "string") {
      throw new HandoffError("not_found", "그 단계를 이 프로젝트에서 찾을 수 없습니다.", "reread_context");
    }
    // Approval is a human decision that an import cannot undo: do not hand out a copy that could never be pasted back.
    if (stage.status === "approved") {
      throw new HandoffError("conflict", "그 단계는 승인되어 있어 복사할 수 없습니다. 사람이 단계를 다시 연 뒤 복사해 주세요.", "reopen_stage");
    }
    const edition = is_record(context.edition) ? context.edition : {};
    const manifest = Array.isArray(context.manifest) ? context.manifest : [];
    const base_versions: BundleBaseVersion[] = [];
    for (const entry of manifest) {
      if (is_record(entry) && typeof entry.kind === "string" && APPENDABLE_KINDS.has(entry.kind)) {
        base_versions.push({ object_id: String(entry.object_id), version_id: String(entry.version_id) });
      }
    }
    // The import sends every base version back as expected_heads, which has a limit: say so now, not at the import.
    if (base_versions.length > MAX_BUNDLE_BASE_VERSIONS) {
      throw new HandoffError(
        "payload_too_large",
        `이 프로젝트의 보조 자료(artifact·source)가 ${base_versions.length}개라 한 묶음에 담을 수 없습니다(최대 ${MAX_BUNDLE_BASE_VERSIONS}개). 쓰지 않는 자료를 보관(archive)해 개수를 줄인 뒤 다시 복사해 주세요. 이 프로젝트는 지금 전달 묶음으로 보낼 수 없고, 같은 컴퓨터의 MCP 연결(방법 B 도구)은 쓸 수 있습니다.`,
        "archive_objects",
        { max_objects: MAX_BUNDLE_BASE_VERSIONS, objects: base_versions.length },
      );
    }
    const body: Omit<HandoffBundle, "manifest_hash"> = {
      format_version: "1.0",
      kind: "pes.handoff",
      project_id: this.#project_id,
      edition_id: String(edition.edition_id),
      stage_id: input.stage_id,
      stage_key: stage.key,
      round_id: input.round_id,
      base_control_rev: String(context.control_rev),
      base_versions,
      request_id: randomUUID(),
      instructions: INSTRUCTIONS,
    };
    const bundle: HandoffBundle = { ...body, manifest_hash: hash_of(body) };
    return { bundle, text: JSON.stringify(bundle) };
  }

  #read_bundle(text: unknown): HandoffBundle {
    const invalid = (why: string): HandoffError =>
      new HandoffError("bundle_invalid", `전달 묶음이 올바르지 않습니다: ${why}`, "export_again");
    if (typeof text !== "string") throw invalid("글자가 아닙니다");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw invalid("JSON이 아닙니다");
    }
    if (!is_record(parsed)) throw invalid("객체가 아닙니다");
    for (const name of Object.keys(parsed)) {
      if (!(BUNDLE_FIELDS as readonly string[]).includes(name)) throw invalid(`알 수 없는 항목 ${name}`);
    }
    if (parsed.kind !== "pes.handoff") throw invalid("kind가 pes.handoff가 아닙니다");
    if (parsed.format_version !== "1.0") throw invalid("지원하지 않는 format_version입니다");
    for (const name of ["project_id", "edition_id", "stage_id", "stage_key", "round_id", "request_id", "instructions"] as const) {
      const value = parsed[name];
      if (typeof value !== "string" || value.length === 0 || !value.isWellFormed()) throw invalid(`${name}이 없거나 글자가 아닙니다`);
    }
    if ((parsed.request_id as string).length < 8) throw invalid("request_id가 너무 짧습니다");
    if (typeof parsed.base_control_rev !== "string" || !DECIMAL.test(parsed.base_control_rev)) throw invalid("base_control_rev가 10진수 문자열이 아닙니다");
    if (typeof parsed.manifest_hash !== "string" || !HEX64.test(parsed.manifest_hash)) throw invalid("manifest_hash가 없거나 올바르지 않습니다");
    const versions = parsed.base_versions;
    if (!Array.isArray(versions)) throw invalid("base_versions가 배열이 아닙니다");
    if (versions.length > MAX_BUNDLE_BASE_VERSIONS) throw invalid(`base_versions가 ${MAX_BUNDLE_BASE_VERSIONS}개를 넘습니다`);
    const named = new Set<string>();
    for (const entry of versions) {
      if (
        !is_record(entry) ||
        Object.keys(entry).length !== 2 ||
        typeof entry.object_id !== "string" ||
        entry.object_id.length === 0 ||
        typeof entry.version_id !== "string" ||
        entry.version_id.length === 0
      ) {
        throw invalid("base_versions의 항목이 {object_id, version_id}가 아닙니다");
      }
      if (named.has(entry.object_id)) throw invalid("base_versions가 같은 자료(object_id)를 두 번 말합니다");
      named.add(entry.object_id);
    }
    return parsed as unknown as HandoffBundle;
  }

  #read_result(text: unknown): {
    items: Array<Record<string, unknown>>;
    claimed_tool: string | null;
    claimed_model: string | null;
    attachment_names: string[];
  } {
    const invalid = (why: string): HandoffError =>
      new HandoffError("bundle_invalid", `붙여 넣은 결과가 올바르지 않습니다: ${why}`, "fix_request");
    if (typeof text !== "string") throw invalid("글자가 아닙니다");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw invalid("JSON이 아닙니다. 앱의 답에서 JSON만 붙여 넣어 주세요");
    }
    if (!is_record(parsed)) throw invalid("객체가 아닙니다");
    for (const name of Object.keys(parsed)) {
      if (name !== "results" && name !== "claimed" && name !== "attachments") throw invalid(`알 수 없는 항목 ${name}`);
    }
    if (!Array.isArray(parsed.results) || parsed.results.length < 1 || parsed.results.length > 20) {
      throw invalid("results는 1~20개의 배열이어야 합니다");
    }
    const items: Array<Record<string, unknown>> = [];
    for (const item of parsed.results) {
      if (!is_record(item) || item.op !== "append_version" || typeof item.object_id !== "string" || item.object_id.length === 0) {
        throw invalid('각 결과는 {"op":"append_version","object_id":…}여야 합니다');
      }
      items.push(item);
    }
    let claimed_tool: string | null = null;
    let claimed_model: string | null = null;
    if (parsed.claimed !== undefined && parsed.claimed !== null) {
      if (!is_record(parsed.claimed)) throw invalid("claimed는 객체여야 합니다");
      const clip = (value: unknown): string | null =>
        typeof value === "string" && value.trim().length > 0 && value.isWellFormed() ? value.trim().slice(0, MAX_CLAIM_CHARS) : null;
      claimed_tool = clip(parsed.claimed.tool);
      claimed_model = clip(parsed.claimed.model);
    }
    const attachment_names: string[] = [];
    if (parsed.attachments !== undefined && parsed.attachments !== null) {
      if (!Array.isArray(parsed.attachments)) throw invalid("attachments는 배열이어야 합니다");
      for (const entry of parsed.attachments) {
        if (!is_record(entry) || typeof entry.name !== "string" || entry.name.length === 0) throw invalid("attachments의 항목은 {name}이어야 합니다");
        attachment_names.push(entry.name);
      }
    }
    return { items, claimed_tool, claimed_model, attachment_names };
  }

  /**
   * Paste back: the human's import. Every refusal happens before anything is written, and a refused bundle is not
   * used up: after the pasted text is fixed, the same bundle can be imported.
   */
  async import_result(input: ImportInput): Promise<ImportOutcome> {
    if (!is_record(input)) throw new HandoffError("bundle_invalid", "가져올 내용이 없습니다.");
    const bundle = this.#read_bundle(input.bundle_text);
    const { manifest_hash, ...body } = bundle;
    if (hash_of(body) !== manifest_hash) {
      throw new HandoffError("bundle_hash_mismatch", "전달 묶음이 복사한 뒤 바뀐 것 같습니다. 묶음을 다시 복사해 주세요.", "export_again");
    }
    if (bundle.project_id !== this.#project_id) {
      throw new HandoffError("bundle_wrong_project", "이 묶음은 다른 프로젝트에서 복사한 것입니다.", "export_again");
    }

    const import_key = `import-${bundle.request_id}`;
    const prior = await this.#owner_call("GET", `/requests/${encodeURIComponent(import_key)}`, undefined, null);
    if (prior.ok) {
      throw new HandoffError("duplicate_import", "이 묶음은 이미 가져왔습니다. 다시 가져오지 않습니다.", "export_again");
    }
    if (prior.error.code !== "not_found") throw this.#refusal(prior);

    const pasted = this.#read_result(input.result_text);
    const scope = new Map(bundle.base_versions.map((entry) => [entry.object_id, entry.version_id]));
    for (const item of pasted.items) {
      if (!scope.has(item.object_id as string)) {
        throw new HandoffError("result_out_of_scope", "붙여 넣은 결과가 묶음에 없는 자료를 건드립니다.", "fix_request", { object_id: item.object_id });
      }
    }
    const supplied = new Set((input.attachments ?? []).map((entry) => entry?.name));
    for (const name of pasted.attachment_names) {
      if (!supplied.has(name)) {
        throw new HandoffError("attachment_missing", `결과가 첨부 "${name}"를 말하지만 함께 주지 않았습니다.`, "fix_request", { name });
      }
    }
    if (pasted.attachment_names.length > 0) {
      throw new HandoffError("attachment_unsupported", "이 버전은 가져오기에 첨부 파일을 저장하지 않습니다. 첨부 없이 가져와 주세요.", "fix_request");
    }

    const context = await this.#context();
    // The bundle's scope must still be this project's: same edition, and the stage is the one the bundle names.
    const edition = is_record(context.edition) ? context.edition : {};
    if (String(edition.edition_id) !== bundle.edition_id) {
      throw new HandoffError("bundle_stale", "묶음을 복사한 뒤 프로젝트의 판이 바뀌었습니다. 묶음을 다시 복사해 주세요.", "export_again");
    }
    const stage = (Array.isArray(context.stages) ? context.stages : []).find(
      (entry) => is_record(entry) && entry.stage_id === bundle.stage_id,
    );
    if (!is_record(stage) || stage.key !== bundle.stage_key) {
      throw new HandoffError("not_found", "묶음이 말하는 단계가 이 프로젝트에 없습니다. 묶음을 다시 복사해 주세요.", "export_again");
    }
    if (String(context.control_rev) !== bundle.base_control_rev) {
      throw new HandoffError("bundle_stale", "묶음을 복사한 뒤 프로젝트가 바뀌었습니다. 묶음을 다시 복사해 주세요.", "export_again");
    }
    const current = new Map<string, string>();
    for (const entry of Array.isArray(context.manifest) ? context.manifest : []) {
      if (is_record(entry)) current.set(String(entry.object_id), String(entry.version_id));
    }
    for (const [object_id, version_id] of scope) {
      if (current.get(object_id) !== version_id) {
        throw new HandoffError("bundle_stale", "묶음을 복사한 뒤 자료의 현재 버전이 바뀌었습니다. 묶음을 다시 복사해 주세요.", "export_again", { object_id });
      }
    }

    if (stage.status === "approved") {
      throw new HandoffError("conflict", "그 단계는 승인되어 있어 가져올 수 없습니다. 사람이 단계를 다시 연 뒤 다시 복사해 주세요.", "reopen_stage");
    }

    const results = pasted.items.map((item) => ({
      ...item,
      based_on_version_id: item.based_on_version_id ?? scope.get(item.object_id as string),
    }));
    const request: Record<string, unknown> = {
      results,
      request_id: bundle.request_id,
      stage_id: bundle.stage_id,
      round_id: bundle.round_id,
      expected_control_rev: bundle.base_control_rev,
      // The heads read above can move before this request lands; PES compares them again inside the import's
      // own transaction, so a race ends in rev_conflict (bundle_stale here) with nothing written.
      expected_heads: bundle.base_versions.map((entry) => ({ object_id: entry.object_id, version_id: entry.version_id })),
    };
    const app = this.handoff_app();
    if (app !== "claude_app") request.app = app;
    if (pasted.claimed_tool !== null) request.claimed_tool = pasted.claimed_tool;
    if (pasted.claimed_model !== null) request.claimed_model = pasted.claimed_model;
    const done = await this.#owner_call("POST", "/runs", { import: request }, import_key);
    if (!done.ok) {
      if (done.error.code === "rev_conflict") {
        const details = is_record(done.error.details) ? done.error.details : {};
        if (typeof details.object_id === "string") {
          throw new HandoffError("bundle_stale", "묶음을 복사한 뒤 자료의 현재 버전이 바뀌었습니다. 묶음을 다시 복사해 주세요.", "export_again", { object_id: details.object_id });
        }
        throw new HandoffError("bundle_stale", "묶음을 복사한 뒤 프로젝트가 바뀌었습니다. 묶음을 다시 복사해 주세요.", "export_again");
      }
      if (done.error.code === "idempotency_key_reuse") {
        throw new HandoffError("duplicate_import", "이 묶음은 이미 가져왔습니다. 다시 가져오지 않습니다.", "export_again");
      }
      throw this.#refusal(done);
    }
    if (done.replayed) {
      throw new HandoffError("duplicate_import", "이 묶음은 이미 가져왔습니다. 다시 가져오지 않습니다.", "export_again");
    }
    const data = is_record(done.data) ? done.data : {};
    return {
      status: "imported",
      run_id: String(data.run_id),
      results: (Array.isArray(data.results) ? data.results : []) as ImportOutcome["results"],
      adopted_by: String(data.adopted_by),
      via: "import",
      provenance: data.provenance as ImportOutcome["provenance"],
    };
  }
}
