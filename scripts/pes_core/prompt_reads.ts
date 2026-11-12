// SEL-118 U5a: two read models of the work space — the prompt that a human copies (or Go would send) and the state
// of the human -> AI questions. Both only read. They write no row, create no run and no waiting_human, and invent no
// state: every stamp below comes from a row or an event that already exists (docs/plan/stage-1-api.md, prompt-builds
// and question-statuses).

import { assumption_rows, decision_rows } from "./commands/api_reads.ts";
import { file_ai_denied, material_object_denied } from "./commands/file_access.ts";
import type { Db } from "./db.ts";
import { check_go_allowed } from "./policy.ts";

export const DRAFT_LABEL = "미제출 초안";
const SECRET_MARK = "[지움: 비밀]";
const PATH_MARK = "[지움: 경로]";

export const PROMPT_TARGETS = ["A", "B"] as const;
export type PromptTarget = (typeof PROMPT_TARGETS)[number];

/** Longest piece of text taken from one source (a version body, a draft): longer text is cut and the cut is announced. */
const MAX_PIECE_CHARS = 20_000;
const MAX_RECORDS_PER_KIND = 50;

// ---------------------------------------------------------------------------
// redaction: a secret or a local path never reaches the prompt (it is erased, and the erasure is announced)

// A value that follows a secret-looking name. `[` is left out of the value so a mark that was already written
// (`[지움: 비밀]`) is never eaten again and leaves no leftover.
const VALUE_CHARS = String.raw`[^\s"'\x60,;\[]`;
const SECRET_PATTERNS: readonly RegExp[] = [
  // a JSON-quoted name ("x-pes-session":"…") has a closing quote after the name and an opening quote before the value
  /x-pes-session["']?\s*[:=]\s*["']?[^\s"'`,;\[]+/gi,
  // PEM private keys: the whole block (an unterminated block is erased to the end of the text)
  /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  // Authorization headers with their scheme (Basic / Bearer / Token …), then a bare Bearer
  new RegExp(String.raw`\bauthorization["']?\s*[:=]\s*["']?(?:(?:basic|bearer|token|digest|negotiate)\s+${VALUE_CHARS}+|${VALUE_CHARS}{6,})`, "gi"),
  /\bBearer\s+[^\s"'`,;\[]+/gi,
  // Cookie headers that carry name=value pairs: the rest of the line. The name before the first `=` is short, so the
  // look-ahead is bounded (an unbounded `[^\r\n]*=` rescans the whole line for every `cookie:` on it).
  /\b(?:set-)?cookie["']?\s*:[^\r\n=]{0,200}=[^\r\n]*/gi,
  // credentials inside a URL: user:pass@host, or a token used as the user name
  // (every pattern below that scans a run of name characters starts only at the start of a run — a `\b` or an unanchored
  // start inside the run would rescan the same run from every position, which is quadratic on long unbroken text)
  /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\/\s:@"'`]+:[^\/\s@"'`]+@/gi,
  /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9_.~%-]{20,}@/gi,
  /\bpes_[A-Za-z0-9_-]{16,}/g,
  /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{12,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  // a JWT may follow a hyphen (`x-eyJ…`); the first segment is bounded so that a long run of `eyJ…-` does not rescan
  /(?<![A-Za-z0-9_])eyJ[A-Za-z0-9_-]{8,512}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // name = value where the name ENDS in a secret word (access_token, client_secret, x-api-key …). The whole name is erased:
  // it starts at the start of a word and reaches the secret word lazily — a `[\w-]*` prefix with no such anchor tries every
  // position of a long word and reads to its end each time (quadratic).
  new RegExp(String.raw`(?<![\w-])[\w-]*?(?:api[_-]?key|(?:secret|private|access|signing|encryption|master)[_-]?key|session[_-]?id|sessid|secret|passw(?:or)?d|token|credential|signature)["']?\s*[:=]\s*["']?${VALUE_CHARS}{6,}`, "gi"),
  // Korean labels for a password / token / secret key, followed by a value
  new RegExp(String.raw`(?:비밀번호|암호|토큰|비밀키)\s*[:=]\s*${VALUE_CHARS}{4,}`, "g"),
  // short query-string names that are secrets by themselves: ?key=… ?sig=… ?sid=…
  /(?<=[?&;\s])(?:key|sig|sid)=[^\s"'`,;&\[]{6,}/gi,
  // a long run of letters and digits with no separator is a key whatever it is called (UUIDs and file names have separators)
  /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{32,}(?![A-Za-z0-9_-])/g,
  // base64url-ish: 40+ characters that mix upper case, lower case and digits (a file name or sentence does not)
  /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/g,
];

const PATH_PATTERNS: readonly RegExp[] = [
  // file: URLs and percent-encoded home roots go whole
  /\bfile:\/\/[^\s"'<>|`]*/gi,
  /%2F(?:Users|home)%2F[^\s"'<>|`&]*/gi,
  // Windows drive paths and UNC paths (the JSON-escaped form with doubled backslashes is the same shape)
  /\b[A-Za-z]:[\\/][^\s"'<>|`]*/g,
  /\\\\[\w.$-]+\\[^\s"'<>|`]*/g,
  // Git Bash / Cygwin drives (/c/<home root>/…, /cygdrive/c/…) and a root-less backslash home root or ~\…
  /(?<![\w.\-/:])\/(?:cygdrive\/)?[A-Za-z]\/(?:Users|Documents and Settings)\/[^\s"'<>|`]*/g,
  /(?<![\w.\-\\])\\(?:Users|home)\\[^\s"'<>|`]*/g,
  /(?<!\w)~\\[^\s"'<>|`]*/g,
  // POSIX paths that start at a system or home root; "/p/<slug>/…" app links do not
  /(?<![\w.\-/])\/(?:Users|home|root|var|private|tmp|opt|etc|mnt|Volumes|usr|srv|Library|Applications|proc|dev|run)\b(?:\/[^\s"'<>|`)\]}]*)?/g,
  /(?<!\w)~\/[^\s"'<>|`]*/g,
];

/** What redaction must also erase although no pattern says so: the session secret and this machine's own folders. */
export interface RedactLiterals {
  secrets: readonly string[];
  paths: readonly string[];
}

export interface Redacted {
  text: string;
  hits: number;
}

function replace_literal(text: string, literal: string, mark: string): Redacted {
  if (literal.length < 5 || literal === "/" || !text.includes(literal)) return { text, hits: 0 };
  const parts = text.split(literal);
  return { text: parts.join(mark), hits: parts.length - 1 };
}

export function redact_text(input: string, literals: RedactLiterals): Redacted {
  let text = input;
  let hits = 0;
  // Patterns first: a header such as `x-pes-session: <secret>` goes whole, so no half-erased mark is left behind.
  // The literals (the session secret, this machine's own folders) then catch what no pattern named.
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, () => {
      hits += 1;
      return SECRET_MARK;
    });
  }
  for (const secret of literals.secrets) {
    const out = replace_literal(text, secret, SECRET_MARK);
    text = out.text;
    hits += out.hits;
  }
  for (const path of [...literals.paths].sort((a, b) => b.length - a.length)) {
    const out = replace_literal(text, path, PATH_MARK);
    text = out.text;
    hits += out.hits;
  }
  for (const pattern of PATH_PATTERNS) {
    text = text.replace(pattern, () => {
      hits += 1;
      return PATH_MARK;
    });
  }
  return { text, hits };
}

// ---------------------------------------------------------------------------
// files

/*
 * Whether a file or a file material is closed to AI is decided in ONE place: commands/file_access.ts (SEL-115).
 * A file attached to the version is judged per blob (file_ai_denied), the selected version itself per material object
 * (material_object_denied), the same units as the version read.
 */

// ---------------------------------------------------------------------------
// the prompt

export interface PromptInput {
  question: string;
  version_id: string;
  quote: string | null;
  drafts: readonly string[];
  target: PromptTarget;
}

export interface PromptContext {
  slug: string;
  project_id: string;
  literals: RedactLiterals;
  /** who reads the build: a caller that is not the human never learns that a file is closed to AI (not even its id) */
  audience: "human" | "ai";
  /** the content of one version as the version read gives it (the caller owns that read) */
  content_of: (kind: string, version_id: string) => unknown;
}

interface IncludedItem {
  kind: string;
  id: string | null;
  version_id: string | null;
  label: string;
}
interface ExcludedItem {
  kind: string;
  id: string | null;
  version_id: string | null;
  reason: string;
}

export interface PromptBuild {
  target: PromptTarget;
  prompt_text: string;
  selection: { object_id: string; version_id: string; version_no: number; quote: string | null };
  included: IncludedItem[];
  excluded: ExcludedItem[];
  warnings: Array<{ code: string; message: string }>;
  constraints: Array<{ code: string; text: string }>;
  return_link: string;
}

/** The words of a version's content that are worth sending: its named text fields, else a short JSON. */
function content_lines(content: unknown): string[] {
  if (content === null || typeof content !== "object") return [];
  const record = content as Record<string, unknown>;
  const lines: string[] = [];
  for (const key of ["title", "summary", "body_md", "text", "statement", "quote", "url", "help"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) lines.push(key === "body_md" ? value : `${key}: ${value}`);
  }
  if (lines.length === 0) lines.push(JSON.stringify(record));
  return lines;
}

const ASSUMPTION_STATE: Record<string, string> = { proposed: "제안됨", confirmed: "확인됨", revised: "고쳐짐" };
const DECISION_STATE: Record<string, string> = { proposed: "제안됨", adopted: "채택됨" };

function fixed_constraints(version_id: string): Array<{ code: string; text: string }> {
  return [
    { code: "exact_version", text: `답은 위에 적힌 정확한 버전(${version_id})만 기준으로 한다. 다른 버전을 읽은 것처럼 말하지 않는다.` },
    { code: "no_state_write", text: "PES의 상태 파일이나 데이터베이스를 직접 고치지 않는다. 답은 사람에게 보여 줄 글로만 돌려준다." },
    { code: "no_secrets", text: "비밀번호·토큰·내 컴퓨터의 폴더 경로는 묻지도, 답에 쓰지도 않는다." },
    { code: "no_invention", text: "근거가 글에 없으면 모른다고 쓴다. 지어내지 않는다." },
  ];
}

/**
 * Assemble the prompt of one question about one exact version. Returns null when the version is not in this project, and
 * "forbidden" when a caller that is not the human asks about a file material closed to AI (the version read answers the same).
 */
export function build_prompt(db: Db, ctx: PromptContext, input: PromptInput): PromptBuild | null | "forbidden" {
  const version = db.get<{
    object_id: string;
    version_no: bigint;
    kind: string;
    edition_id: string | null;
    edition_no: bigint | null;
  }>(
    `SELECT v.object_id AS object_id, v.version_no AS version_no, o.kind AS kind, o.edition_id AS edition_id,
            e.edition_no AS edition_no
       FROM object_versions v
       JOIN objects o ON o.project_id = v.project_id AND o.id = v.object_id
       LEFT JOIN editions e ON e.project_id = o.project_id AND e.id = o.edition_id
      WHERE v.project_id = ? AND v.id = ?`,
    ctx.project_id,
    input.version_id,
  );
  if (version === undefined) return null;
  // A closed file material's own text names the file (its title defaults to the file name, later versions inherit it).
  const material_closed = version.kind === "source" && material_object_denied(db, ctx.project_id, version.object_id);
  if (material_closed && ctx.audience !== "human") return "forbidden";

  let redactions = 0;
  let truncated = false;
  const clean = (text: string): string => {
    const out = redact_text(text, ctx.literals);
    redactions += out.hits;
    return out.text;
  };
  const clip = (text: string): string => {
    if (text.length <= MAX_PIECE_CHARS) return text;
    truncated = true;
    return `${text.slice(0, MAX_PIECE_CHARS)}\n…(길이 제한으로 여기서 자름)`;
  };

  const go = check_go_allowed(db, ctx.project_id);
  const send_off = !go.allowed;
  // Only the text that Go would send is held back; a human who pastes by hand (B) decides for themself, so B only warns.
  const hold_back = send_off && input.target === "A";

  const version_no = Number(version.version_no);
  const question = clean(input.question);
  const quote = input.quote === null ? null : clean(input.quote);
  const return_link = `/p/${ctx.slug}/`;

  const included: IncludedItem[] = [];
  const excluded: ExcludedItem[] = [];
  const warnings: Array<{ code: string; message: string }> = [];

  // The selected text leaves the prompt when Go would carry it (send_off, A) or when the material is closed to AI (any target,
  // like a closed file): only the human reads the build then, and is told why.
  const withhold_reason: string | null = hold_back ? "send_off" : material_closed ? "ai_access_denied" : null;
  included.push({
    kind: "selection",
    id: version.object_id,
    version_id: input.version_id,
    label: withhold_reason !== null ? `선택한 버전 ${version_no} (글은 뺌)` : quote === null ? `선택한 버전 ${version_no}` : `선택한 글 (버전 ${version_no})`,
  });
  const sections: string[] = [];
  sections.push(`## 질문\n${question}`);
  const selection_lines = [`개체: ${version.object_id}`, `버전: ${input.version_id} (버전 ${version_no})`];
  if (quote !== null && withhold_reason === null) selection_lines.push(`선택한 글:\n${quote}`);
  sections.push(`## 선택 범위\n${selection_lines.join("\n")}`);
  if (withhold_reason !== null) {
    if (quote !== null) excluded.push({ kind: "selection", id: version.object_id, version_id: input.version_id, reason: withhold_reason });
    excluded.push({ kind: "version", id: version.object_id, version_id: input.version_id, reason: withhold_reason });
  } else {
    const lines = content_lines(ctx.content_of(version.kind, input.version_id));
    included.push({ kind: "version", id: version.object_id, version_id: input.version_id, label: `버전 ${version_no} 내용` });
    if (lines.length > 0) sections.push(`## 이 버전의 내용\n${clip(clean(lines.join("\n")))}`);
  }

  // every assumption and decision of the version's edition, not only those that bear on this question (decisions with scope project included)
  const edition_id = version.edition_id ?? (db.get<{ id: string }>("SELECT active_edition_id AS id FROM projects WHERE id = ?", ctx.project_id)?.id ?? null);
  const assumptions = edition_id === null ? [] : assumption_rows(db, ctx.project_id, edition_id).filter((row) => row.state !== "rejected");
  const decisions = edition_id === null ? [] : decision_rows(db, ctx.project_id, edition_id).filter((row) => row.state === "proposed" || row.state === "adopted");
  if (assumptions.length > MAX_RECORDS_PER_KIND || decisions.length > MAX_RECORDS_PER_KIND) truncated = true;
  if (hold_back) {
    for (const row of assumptions.slice(0, MAX_RECORDS_PER_KIND)) excluded.push({ kind: "assumption", id: row.id, version_id: row.version_id, reason: "send_off" });
    for (const row of decisions.slice(0, MAX_RECORDS_PER_KIND)) excluded.push({ kind: "decision", id: row.id, version_id: row.version_id, reason: "send_off" });
  } else {
    const lines: string[] = [];
    for (const row of assumptions.slice(0, MAX_RECORDS_PER_KIND)) {
      included.push({ kind: "assumption", id: row.id, version_id: row.version_id, label: `가정 ${row.id}` });
      lines.push(`- 가정 ${row.id} (버전 ${row.version_id}, ${ASSUMPTION_STATE[row.state] ?? row.state}): ${clean(row.statement)}`);
    }
    if (lines.length > 0) sections.push(`## 이 판의 가정\n${lines.join("\n")}`);
    const decision_lines: string[] = [];
    for (const row of decisions.slice(0, MAX_RECORDS_PER_KIND)) {
      included.push({ kind: "decision", id: row.id, version_id: row.version_id, label: `결정 ${row.id}` });
      const where = row.scope === "project" ? "프로젝트 전체" : "이 판";
      decision_lines.push(`- 결정 ${row.id} (버전 ${row.version_id}, ${where}, ${DECISION_STATE[row.state] ?? row.state}): ${clean(row.statement)}`);
    }
    if (decision_lines.length > 0) sections.push(`## 이 판의 결정\n${decision_lines.join("\n")}`);
  }

  // files attached to this exact version: a file the AI may not read is listed as excluded, never described
  const files = db.all<{ blob_id: string; role: string; original_name: string | null }>(
    `SELECT f.blob_id AS blob_id, f.role AS role, b.original_name AS original_name
       FROM version_files f
       JOIN blobs b ON b.project_id = f.project_id AND b.id = f.blob_id
      WHERE f.project_id = ? AND f.version_id = ? ORDER BY f.role, f.blob_id`,
    ctx.project_id,
    input.version_id,
  );
  const file_lines: string[] = [];
  for (const file of files) {
    const denied = file_ai_denied(db, ctx.project_id, file.blob_id);
    // The version read hides a closed file from a non-human caller; so does the build, in every list (also the send_off one).
    if (denied && ctx.audience !== "human") continue;
    if (hold_back) {
      excluded.push({ kind: "file", id: file.blob_id, version_id: input.version_id, reason: "send_off" });
    } else if (denied) {
      excluded.push({ kind: "file", id: file.blob_id, version_id: input.version_id, reason: "ai_access_denied" });
    } else {
      const base = file.original_name === null ? "" : (file.original_name.split(/[\\/]/).pop() ?? "");
      const name = base.length === 0 ? "이름 없음" : clean(base);
      included.push({ kind: "file", id: file.blob_id, version_id: input.version_id, label: `${file.role}: ${name}` });
      file_lines.push(`- ${file.role}: ${name} (파일 ${file.blob_id}) — 내용은 이 글에 넣지 않았다`);
    }
  }
  if (file_lines.length > 0) sections.push(`## 붙은 파일\n${file_lines.join("\n")}`);

  // drafts the human has not submitted: the client sends them (they live only in the browser), and they are marked
  const draft_texts = input.drafts.filter((text) => text.trim().length > 0).map((text) => clip(clean(text)));
  if (draft_texts.length > 0) {
    if (hold_back) {
      for (let i = 0; i < draft_texts.length; i += 1) excluded.push({ kind: "draft", id: null, version_id: null, reason: "send_off" });
    } else {
      const lines = draft_texts.map((text) => `${DRAFT_LABEL}:\n${text}`);
      for (let i = 0; i < draft_texts.length; i += 1) included.push({ kind: "draft", id: null, version_id: null, label: DRAFT_LABEL });
      sections.push(lines.join("\n\n"));
      warnings.push({ code: "unsubmitted_draft", message: "아직 제출하지 않은 초안이 들어 있습니다. 제출한 답이 아닙니다." });
    }
  }

  const constraints = fixed_constraints(input.version_id);
  for (const item of constraints) included.push({ kind: "constraint", id: item.code, version_id: null, label: item.code });
  sections.push(`## 지킬 것\n${constraints.map((item) => `- ${item.text}`).join("\n")}`);
  included.push({ kind: "return_link", id: null, version_id: null, label: return_link });
  sections.push(`## 돌아올 곳\n${return_link}`);

  if (send_off) {
    warnings.push({
      code: "send_off",
      message: hold_back
        ? "OpenCode Go 전송이 꺼져 있어 질문 외 자료를 모두 뺐습니다."
        : "OpenCode Go 전송이 꺼져 있습니다. 직접 붙여 넣는 글이라 자료는 그대로 넣었습니다. 붙여 넣을 곳을 확인하세요.",
    });
  }
  if (redactions > 0) {
    warnings.push({ code: "redacted", message: `비밀이나 내 컴퓨터의 경로로 보이는 ${redactions}곳을 지웠습니다.` });
  }
  if (truncated) {
    warnings.push({ code: "truncated", message: "너무 긴 자료는 잘라서 넣었습니다." });
  }

  return {
    target: input.target,
    prompt_text: `# 사람이 AI에게 묻는 글\n\n${sections.join("\n\n")}\n`,
    selection: { object_id: version.object_id, version_id: input.version_id, version_no, quote },
    included,
    excluded,
    warnings,
    constraints,
    return_link,
  };
}

// ---------------------------------------------------------------------------
// the state of a human -> AI question

export type AskState = "accepted" | "external_received" | "read" | "answered";

export interface QuestionStatus {
  question_id: string;
  version_id: string;
  text: string;
  intended_actor_id: string | null;
  state: AskState;
  accepted_at: number;
  external_received_at: number | null;
  read_at: number | null;
  answered_at: number | null;
  elapsed_ms: number;
}

/**
 * The human -> AI questions of a project (or the one named), oldest first, each with what is known of it:
 *   accepted           — the first version of the question was written (the server took it);
 *   external_received  — a run reported the current question version as seen (an input receipt event);
 *   read               — a run reported that version as applied;
 *   answered           — a submitted answer version exists for that version.
 * A stamp without its evidence is null. The state is the furthest stage that has evidence; time passing never moves it.
 * The text goes through the prompt's erasure (`literals`: the session secret and this machine's folders).
 * Returns null when `only_question_id` names no human -> AI question of this project.
 */
export function question_statuses(
  db: Db,
  project_id: string,
  now_ms: number,
  only_question_id: string | null,
  literals: RedactLiterals,
): QuestionStatus[] | null {
  const rows = db.all<{
    question_id: string;
    version_id: string;
    text: string;
    intended_actor_id: string | null;
    accepted_at: bigint;
  }>(
    `SELECT q.object_id AS question_id, o.current_version_id AS version_id, qv.text AS text,
            q.intended_actor_id AS intended_actor_id, ov0.created_at AS accepted_at
       FROM questions q
       JOIN objects o ON o.project_id = q.project_id AND o.id = q.object_id
       JOIN question_versions qv ON qv.project_id = o.project_id AND qv.version_id = o.current_version_id
       JOIN object_versions ov0 ON ov0.project_id = q.project_id AND ov0.id = q.original_version_id
      WHERE q.project_id = ? AND q.direction = 'human_to_agent' AND (? IS NULL OR q.object_id = ?)
      ORDER BY ov0.created_at, q.rowid`,
    project_id,
    only_question_id,
    only_question_id,
  );
  if (only_question_id !== null && rows.length === 0) return null;
  if (rows.length === 0) return [];

  // first time each question version was reported seen / applied (the event of the input receipt route)
  const events = db.all<{ version_id: string; state: string; at: bigint }>(
    `SELECT json_extract(payload, '$.input_version_id') AS version_id, json_extract(payload, '$.state') AS state,
            min(created_at) AS at
       FROM events
      WHERE project_id = ? AND type = 'run.input_receipt_recorded'
      GROUP BY version_id, state`,
    project_id,
  );
  const first = new Map<string, { seen: number | null; applied: number | null }>();
  for (const event of events) {
    const entry = first.get(event.version_id) ?? { seen: null, applied: null };
    const at = Number(event.at);
    if (event.state === "seen") entry.seen = at;
    if (event.state === "applied") entry.applied = at;
    first.set(event.version_id, entry);
  }

  return rows.map((row) => {
    const accepted_at = Number(row.accepted_at);
    const receipt = first.get(row.version_id) ?? { seen: null, applied: null };
    // An applied receipt means the AI had the version, so it also stands as the first sign of receiving it.
    const read_at = receipt.applied;
    const external_received_at = receipt.seen === null ? read_at : read_at === null ? receipt.seen : Math.min(receipt.seen, read_at);
    const answer = db.get<{ at: bigint | null }>(
      `SELECT min(ov.created_at) AS at
         FROM answer_versions av
         JOIN object_versions ov ON ov.project_id = av.project_id AND ov.id = av.version_id
        WHERE av.project_id = ? AND av.question_id = ? AND av.question_version_id = ? AND av.state = 'submitted'`,
      project_id,
      row.question_id,
      row.version_id,
    );
    const answered_at = answer?.at === null || answer?.at === undefined ? null : Number(answer.at);
    const state: AskState =
      answered_at !== null ? "answered" : read_at !== null ? "read" : external_received_at !== null ? "external_received" : "accepted";
    return {
      question_id: row.question_id,
      version_id: row.version_id,
      // the same erasure as the prompt: the text is read for every reader, so a secret or a local path never leaves in it
      text: redact_text(row.text, literals).text,
      intended_actor_id: row.intended_actor_id,
      state,
      accepted_at,
      external_received_at,
      read_at,
      answered_at,
      elapsed_ms: Math.max(0, (answered_at ?? now_ms) - accepted_at),
    };
  });
}
