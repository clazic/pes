// 설계 전용 SQLite 검사 (stage 2 PR26d) — 옛 Python 검사기(check_ddl.py)의 TS 이전. Python 검사기는 SEL-74 에서 지웠다.
//
// 사용: node scripts/check_ddl.ts [--ddl <sql 파일>]      (npm run check:ddl)
//   --ddl 이 없으면 docs/plan/schemas/stage-1-ddl-draft.sql 을 읽는다.
//   통과: 표준출력에 옛 검사기와 같은 줄(첫 줄의 SQLite 버전만 다를 수 있음), 종료 코드 0.
//   실패: 실패 메시지(옛 검사기의 AssertionError/SQLite 오류와 같은 문장)를 표준오류에, 종료 코드 1.
//
// 이 검사는 `:memory:` 데이터베이스만 쓴다. PES 코어·실제 프로젝트/설정·파일 DB·네트워크·자식 프로세스를 쓰지 않는다.
// DDL 파일은 읽기만 한다. 아래 CAS/가드 예는 설계 실험이지 운영 서비스가 아니다.
// 옛 검사기가 낸 줄은 tests/helpers/ddl_check_env.ts 의 PY_REFERENCE_LINES 에 고정돼 있다.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const HASH = "a".repeat(64);
const KEYS = ["plan", "research", "analyze", "write", "verify", "publish"] as const;

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DDL = resolve(HERE, "..", "docs", "plan", "schemas", "stage-1-ddl-draft.sql");

type Value = string | number | bigint | null;
type Row = unknown[];

export interface DdlCheckResult {
  ok: boolean;
  /** 표준출력과 같은 줄들(줄바꿈 없음). 실패하면 실패 전까지의 PASS 줄. */
  lines: string[];
  rejected_cases: number;
  representative_queries: number;
  /** 적재한 설계 표 수. */
  table_count: number;
  /** ok=false 일 때 실패 메시지. */
  error?: string;
}

function require(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** SQLite 제약 위반(CONSTRAINT·MISMATCH) 여부 — Python sqlite3.IntegrityError 와 같은 범위. */
function is_integrity_error(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { errcode?: unknown }).errcode;
  if (typeof code === "number") return (code & 0xff) === 19 || (code & 0xff) === 20;
  return /constraint failed|datatype mismatch/i.test(error.message);
}

class Checks {
  readonly db: DatabaseSync;
  readonly lines: string[] = [];
  rejections = 0;
  positive_checks = 0;
  table_count = 0;

  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec("PRAGMA foreign_keys=ON");
    require(this.scalar("PRAGMA foreign_keys") === 1, "foreign_keys is not ON");
  }

  print(line: string): void {
    this.lines.push(line);
  }

  /** 정수는 BigInt 로 묶어 INTEGER 로 저장한다(JS number 는 실수로 묶인다). */
  private bind(params: Value[]): Array<string | bigint | null> {
    return params.map((v) => {
      if (typeof v !== "number") return v;
      if (!Number.isInteger(v)) throw new Error(`non-integer number cannot be bound: ${v}`);
      return BigInt(v);
    });
  }

  sql(text: string, params: Value[] = []): { changes: number } {
    const result = this.db.prepare(text).run(...(this.bind(params) as never[]));
    return { changes: Number(result.changes) };
  }

  rows(text: string, params: Value[] = []): Row[] {
    const statement = this.db.prepare(text);
    statement.setReturnArrays(true);
    return statement.all(...(this.bind(params) as never[])) as unknown as Row[];
  }

  scalar(text: string, params: Value[] = []): unknown {
    const first = this.rows(text, params)[0];
    require(first !== undefined, `no row: ${text}`);
    return first[0];
  }

  insert(table: string, values: Record<string, Value>): void {
    // 식별자는 시험이 정한 상수이고, 값은 항상 묶는다.
    const columns = Object.keys(values).map((c) => `"${c}"`).join(",");
    const placeholders = Object.keys(values).map(() => "?").join(",");
    this.sql(`INSERT INTO "${table}" (${columns}) VALUES (${placeholders})`, Object.values(values));
  }

  rejected(label: string, operation: () => void, expected = "FOREIGN KEY"): void {
    this.db.exec("SAVEPOINT rejected_case");
    let accepted = false;
    try {
      operation();
      // RELEASE 는 이 경계에서 초기 지연(deferred) 제약도 검사한다.
      this.db.exec("RELEASE rejected_case");
      accepted = true;
    } catch (error) {
      this.db.exec("ROLLBACK TO rejected_case");
      this.db.exec("RELEASE rejected_case");
      if (!is_integrity_error(error)) throw error;
      const message = (error as Error).message;
      require(message.includes(expected), `${label}: unexpected rejection: ${message}`);
      this.rejections += 1;
    }
    if (accepted) throw new Error(`${label}: invalid write was accepted`);
  }

  object(p: string, name: string, kind: string, number: number, edition = true): void {
    this.insert("objects", {
      id: name,
      project_id: p,
      edition_id: edition ? `edition-${p}` : null,
      kind,
      display_no: number,
    });
  }

  version(
    p: string,
    obj: string,
    kind: string,
    vid: string,
    number = 1,
    actor: string | null = null,
    run: string | null = null,
    tx: string | null = null,
  ): void {
    this.insert("object_versions", {
      id: vid,
      project_id: p,
      object_id: obj,
      kind,
      version_no: number,
      actor_id: actor ?? `human-${p}`,
      created_in_round_id: `round-${p}`,
      run_id: run,
      tx_id: tx ?? `tx-${p}`,
      content_hash: HASH,
    });
  }

  current(obj: string, vid: string, rev = 0): void {
    this.sql("UPDATE objects SET current_version_id=?, rev=? WHERE id=?", [vid, rev, obj]);
  }

  seed_project(p: string): void {
    const human = `human-${p}`;
    const user = `user-${p}`;
    this.insert("users", { id: user, display_name: `합성 사용자 ${p}` });
    this.insert("actors", { id: human, kind: "human", user_id: user, display_name: "합성 사람" });
    this.insert("projects", { id: p, slug: `synthetic-${p}`, topic: "가상 정책 연구", owner_user_id: user });
    this.insert("project_members", { project_id: p, user_id: user, role: "owner" });
    this.insert("mutation_commits", {
      id: `tx-${p}`,
      project_id: p,
      actor_id: human,
      via: "import",
      client_request_id: "bootstrap",
      request_hash: HASH,
      action: "fixture.created",
    });
    // allow_opencode_go 를 빼서 확정된 ON 초기값을 확인한다.
    this.insert("project_policy_versions", {
      id: `policy-${p}`,
      project_id: p,
      policy_rev: 1,
      changed_by: human,
      changed_by_user_id: user,
      reason: "합성 초기 정책",
      tx_id: `tx-${p}`,
    });
    this.insert("editions", { id: `edition-${p}`, project_id: p, edition_no: 1, status: "active" });
    KEYS.forEach((key, index) => {
      this.insert("stages", {
        id: `stage-${p}-${key}`,
        project_id: p,
        edition_id: `edition-${p}`,
        key,
        ordinal: index + 1,
      });
    });
    this.insert("rounds", {
      id: `round-${p}`,
      project_id: p,
      edition_id: `edition-${p}`,
      stage_id: `stage-${p}-plan`,
      round_no: 1,
    });
    this.sql("UPDATE stages SET current_round_id=?, status='active' WHERE id=?", [`round-${p}`, `stage-${p}-plan`]);
    this.sql("UPDATE editions SET current_stage_id=? WHERE id=?", [`stage-${p}-plan`, `edition-${p}`]);
    this.sql("UPDATE projects SET active_edition_id=?, current_policy_id=?, status='active' WHERE id=?", [
      `edition-${p}`,
      `policy-${p}`,
      p,
    ]);
    this.insert("counters", { project_id: p, namespace: "question", next_no: 2 });

    this.object(p, `artifact-${p}`, "artifact", 1);
    this.insert("artifacts", { project_id: p, object_id: `artifact-${p}`, stage_id: `stage-${p}-plan`, kind: "section" });
    this.version(p, `artifact-${p}`, "artifact", `artifact-v1-${p}`);
    this.insert("artifact_versions", {
      project_id: p,
      object_id: `artifact-${p}`,
      version_id: `artifact-v1-${p}`,
      title: "합성 결과",
      body_md: "합성 문장",
      status: "done",
    });
    this.current(`artifact-${p}`, `artifact-v1-${p}`);
    this.insert("round_contents", {
      project_id: p,
      round_id: `round-${p}`,
      object_id: `artifact-${p}`,
      version_id: `artifact-v1-${p}`,
      position: 0,
      role: "result",
    });

    this.object(p, `source-${p}`, "source", 1);
    this.insert("sources", { project_id: p, object_id: `source-${p}`, kind: "web" });
    this.version(p, `source-${p}`, "source", `source-v1-${p}`);
    this.insert("source_versions", {
      project_id: p,
      object_id: `source-${p}`,
      version_id: `source-v1-${p}`,
      title: "가상 출처",
      url: "https://example.invalid/source",
      retrieved_at: 1000,
      method: "browser",
      verification_state: "verified",
      quote: "합성 근거",
    });
    this.current(`source-${p}`, `source-v1-${p}`);
    this.insert("citations", {
      project_id: p,
      artifact_version_id: `artifact-v1-${p}`,
      citation_no: 1,
      source_version_id: `source-v1-${p}`,
    });

    this.object(p, `question-${p}`, "question", 1);
    this.insert("questions", {
      project_id: p,
      object_id: `question-${p}`,
      asked_by_actor_id: "ai",
      intended_actor_id: human,
      direction: "agent_to_human",
      origin: "bank",
      original_version_id: `question-v1-${p}`,
    });
    this.version(p, `question-${p}`, "question", `question-v1-${p}`);
    this.insert("question_versions", {
      project_id: p,
      object_id: `question-${p}`,
      version_id: `question-v1-${p}`,
      text: "첫 질문",
      type: "single",
      required: 1,
      default_value: '"yes"',
      options: '[{"value":"yes","label":"예","recommended":true}]',
    });
    this.current(`question-${p}`, `question-v1-${p}`);
    this.insert("question_sets", {
      id: `form-${p}`,
      project_id: p,
      stage_id: `stage-${p}-plan`,
      purpose: "stage_start",
      form_key: "plan-start",
      version_no: 1,
    });
    this.insert("question_set_members", {
      project_id: p,
      set_id: `form-${p}`,
      question_id: `question-${p}`,
      question_version_id: `question-v1-${p}`,
      position: 0,
    });
    this.insert("submissions", {
      id: `submission-${p}`,
      project_id: p,
      actor_id: human,
      set_id: `form-${p}`,
      via: "web",
      tx_id: `tx-${p}`,
    });
    this.object(p, `answer-${p}`, "answer", 1);
    this.insert("answers", {
      project_id: p,
      object_id: `answer-${p}`,
      question_id: `question-${p}`,
      respondent_actor_id: human,
      submission_id: `submission-${p}`,
    });
    this.version(p, `answer-${p}`, "answer", `answer-v1-${p}`);
    this.insert("answer_versions", {
      project_id: p,
      object_id: `answer-${p}`,
      version_id: `answer-v1-${p}`,
      question_id: `question-${p}`,
      question_version_id: `question-v1-${p}`,
      value: '"yes"',
      used_default: 1,
    });
    this.current(`answer-${p}`, `answer-v1-${p}`);

    const is_a = p === "p1";
    this.insert("runs", {
      id: `run-${p}`,
      project_id: p,
      edition_id: `edition-${p}`,
      stage_id: `stage-${p}-plan`,
      round_id: `round-${p}`,
      actor_id: is_a ? "ai" : "code",
      mode: is_a ? "A" : "B",
      runtime: is_a ? "pes_builtin" : "claude_code",
      provider: is_a ? "opencode-go" : "anthropic",
      model: is_a ? "opencode-go/deepseek-v4.1-flash" : "unknown",
      status: "running",
      base_control_rev: 0,
    });
    this.insert("project_leases", {
      project_id: p,
      lease_id: `lease-${p}`,
      run_id: `run-${p}`,
      owner_actor_id: is_a ? "ai" : "code",
      fence: 1,
      acquired_at: 1000,
      heartbeat_at: 2000,
      expires_at: 10000,
    });
    this.insert("run_targets", {
      project_id: p,
      run_id: `run-${p}`,
      object_id: `artifact-${p}`,
      base_version_id: `artifact-v1-${p}`,
      base_rev: 0,
    });
    this.insert("run_input_receipts", {
      project_id: p,
      run_id: `run-${p}`,
      input_version_id: `answer-v1-${p}`,
      state: "seen",
    });
    this.insert("events", {
      id: `event-${p}`,
      project_id: p,
      run_id: `run-${p}`,
      tx_id: `tx-${p}`,
      tx_index: 0,
      tx_size: 1,
      type: "fixture.created",
      object_id: `artifact-${p}`,
      after_version_id: `artifact-v1-${p}`,
    });
    const seq = this.scalar("SELECT event_seq FROM events WHERE id=?", [`event-${p}`]) as number;
    this.insert("blobs", {
      id: `blob-${p}`,
      project_id: p,
      storage_key: `synthetic/${p}/manifest`,
      sha256: (is_a ? "b" : "c").repeat(64),
      size: 20,
      media_type: "application/json",
      state: "ready",
      created_by: human,
    });
    this.insert("file_policies", {
      id: `fp-${p}`,
      project_id: p,
      blob_id: `blob-${p}`,
      ai_access: "allow",
      rev: 1,
      changed_by_actor_id: human,
      changed_by_user_id: user,
      changed_at: 1000,
      tx_id: `tx-${p}`,
    });
    this.insert("snapshots", {
      id: `snapshot-${p}`,
      project_id: p,
      edition_id: `edition-${p}`,
      stage_id: `stage-${p}-plan`,
      round_id: `round-${p}`,
      scope: "round",
      manifest_blob_id: `blob-${p}`,
      through_event_seq: seq,
      control_rev: 0,
      content_hash: HASH,
    });
  }

  seed_details(): void {
    const p = "p1";
    this.insert("project_references", {
      id: "ref-p1-p2",
      project_id: p,
      referenced_project_id: "p2",
      referenced_project_key: "p2",
      source_snapshot_id: "snapshot-p2",
      source_snapshot_key: "snapshot-p2",
      source_label: "p2 최종 보고서 v1",
      latest_snapshot_id: "snapshot-p2",
      scope_json: '["final_report","sources"]',
      attached_by_actor_id: "human-p1",
      attached_by_user_id: "user-p1",
      attached_at: 1000,
    });
    this.insert("project_references", {
      id: "ref-missing-source",
      project_id: p,
      referenced_project_id: null,
      referenced_project_key: "p2@remote",
      source_snapshot_id: null,
      source_snapshot_key: "snapshot-p2",
      source_label: "p2 원본 미이전",
      latest_snapshot_id: null,
      scope_json: '["final_report"]',
      status: "source_missing",
      attached_by_actor_id: "human-p1",
      attached_by_user_id: "user-p1",
      attached_at: 1000,
    });
    const p2_seq = this.scalar("SELECT event_seq FROM events WHERE id=?", ["event-p2"]) as number;
    this.insert("snapshots", {
      id: "snapshot-ref-del",
      project_id: "p2",
      edition_id: "edition-p2",
      stage_id: "stage-p2-plan",
      scope: "stage",
      manifest_blob_id: "blob-p2",
      through_event_seq: p2_seq,
      control_rev: 0,
      content_hash: HASH,
    });
    this.insert("project_references", {
      id: "ref-delete",
      project_id: p,
      referenced_project_id: "p2",
      referenced_project_key: "p2",
      source_snapshot_id: "snapshot-ref-del",
      source_snapshot_key: "snapshot-ref-del",
      source_label: "삭제 시험",
      latest_snapshot_id: "snapshot-ref-del",
      scope_json: '["final_report"]',
      attached_by_actor_id: "human-p1",
      attached_by_user_id: "user-p1",
      attached_at: 1000,
    });
    this.insert("editions", { id: "draft-p1", project_id: p, edition_no: 3, status: "draft" });
    this.object(p, "source-twin", "source", 2);
    this.insert("sources", { project_id: p, object_id: "source-twin", kind: "web" });
    this.version(p, "source-twin", "source", "source-twin-v1");
    this.insert("source_versions", {
      project_id: p,
      object_id: "source-twin",
      version_id: "source-twin-v1",
      title: "같은 URL의 다른 자료",
      url: "https://example.invalid/source",
      method: "fetch",
      verification_state: "unverified",
    });
    this.current("source-twin", "source-twin-v1");
    this.insert("agent_tokens", {
      id: "synthetic-token",
      project_id: p,
      actor_id: "ai",
      scopes: '["context.read","result.submit"]',
      token_hash: "d".repeat(64),
    });
    this.insert("approvals", {
      id: "legacy-approval",
      project_id: p,
      stage_id: "stage-p1-plan",
      snapshot_id: "snapshot-p1",
      actor_id: "legacy",
      actor_kind: "legacy_unknown",
      origin: "legacy",
      assurance: "legacy_unverified",
      tx_id: "tx-p1",
    });
    this.insert("approvals", {
      id: "human-approval",
      project_id: p,
      stage_id: "stage-p1-plan",
      snapshot_id: "snapshot-p1",
      actor_id: "human-p1",
      actor_kind: "human",
      human_user_id: "user-p1",
      origin: "new",
      assurance: "verified",
      tx_id: "tx-p1",
    });

    this.version(p, "artifact-p1", "artifact", "artifact-v2-p1", 2, "ai", "run-p1");
    this.insert("artifact_versions", {
      project_id: p,
      object_id: "artifact-p1",
      version_id: "artifact-v2-p1",
      title: "수정 결과",
      body_md: "합성 문장 / 합성 문장",
      status: "done",
    });
    this.current("artifact-p1", "artifact-v2-p1", 1);
    this.insert("version_relations", {
      project_id: p,
      from_version_id: "artifact-v2-p1",
      to_version_id: "artifact-v1-p1",
      kind: "supersedes",
    });

    this.version(p, "question-p1", "question", "question-v2-p1", 2);
    this.insert("question_versions", {
      project_id: p,
      object_id: "question-p1",
      version_id: "question-v2-p1",
      text: "수정 질문",
      type: "single",
      required: 1,
      default_value: '"no"',
      options: '[{"value":"no","label":"아니오"}]',
    });
    this.current("question-p1", "question-v2-p1", 1);
    this.insert("question_sets", {
      id: "form-p1-v2",
      project_id: p,
      stage_id: "stage-p1-plan",
      purpose: "stage_start",
      form_key: "plan-start",
      version_no: 2,
      previous_set_id: "form-p1",
    });
    this.insert("question_set_members", {
      project_id: p,
      set_id: "form-p1-v2",
      question_id: "question-p1",
      question_version_id: "question-v2-p1",
      position: 0,
    });

    const threads: Array<[number, string, string, string]> = [
      [1, "question-p1", "question-v1-p1", "question_comment"],
      [2, "artifact-p1", "artifact-v1-p1", "annotation"],
    ];
    for (const [number, target, target_version, context] of threads) {
      const tid = `thread-${number}`;
      const mid = `message-${number}`;
      let anchor: string | null = null;
      if (context === "annotation") {
        anchor = "anchor-1";
        this.insert("anchors", {
          id: anchor,
          project_id: p,
          target_object_id: target,
          target_version_id: target_version,
          exact_quote: "합성",
          prefix: "",
          suffix: " 문장",
          start_cp: 0,
          end_cp: 2,
        });
      }
      this.object(p, tid, "thread", number);
      this.insert("threads", {
        project_id: p,
        object_id: tid,
        target_object_id: target,
        target_version_id: target_version,
        context_kind: context,
        anchor_id: anchor,
      });
      this.version(p, tid, "thread", `${tid}-v1`);
      this.insert("thread_versions", { project_id: p, object_id: tid, version_id: `${tid}-v1` });
      this.current(tid, `${tid}-v1`);
      this.object(p, mid, "message", number);
      this.insert("messages", { project_id: p, object_id: mid, thread_id: tid, submission_id: "submission-p1" });
      this.version(p, mid, "message", `${mid}-v1`);
      this.insert("message_versions", {
        project_id: p,
        object_id: mid,
        version_id: `${mid}-v1`,
        thread_id: tid,
        body_md: number === 1 ? "합성 덧붙임" : "합성 수정 제안",
      });
      this.current(mid, `${mid}-v1`);
    }

    this.insert("anchor_resolutions", {
      id: "anchor-exact",
      project_id: p,
      anchor_id: "anchor-1",
      target_object_id: "artifact-p1",
      evaluated_version_id: "artifact-v1-p1",
      status: "exact",
      start_cp: 0,
      end_cp: 2,
      method: "synthetic",
    });
    this.insert("anchor_resolutions", {
      id: "anchor-ambiguous",
      project_id: p,
      anchor_id: "anchor-1",
      target_object_id: "artifact-p1",
      evaluated_version_id: "artifact-v2-p1",
      status: "ambiguous",
      method: "synthetic",
    });
    this.version(p, "thread-2", "thread", "thread-2-v2", 2);
    this.insert("thread_versions", {
      project_id: p,
      object_id: "thread-2",
      version_id: "thread-2-v2",
      state: "resolved",
      resolved_by_message_version_id: "message-2-v1",
      summary: "합성 결론",
    });
    this.current("thread-2", "thread-2-v2", 1);

    this.object(p, "assumption-1", "assumption", 1);
    this.insert("assumptions", { project_id: p, object_id: "assumption-1", proposed_by_actor_id: "ai" });
    this.version(p, "assumption-1", "assumption", "assumption-v1");
    this.insert("assumption_versions", {
      project_id: p,
      object_id: "assumption-1",
      version_id: "assumption-v1",
      statement: "합성 가정",
      state: "proposed",
      needs_review: 1,
    });
    this.current("assumption-1", "assumption-v1");
    this.object(p, "decision-1", "decision", 1, false);
    this.insert("decisions", { project_id: p, object_id: "decision-1", scope: "project" });
    this.version(p, "decision-1", "decision", "decision-v1");
    this.insert("decision_versions", {
      project_id: p,
      object_id: "decision-1",
      version_id: "decision-v1",
      statement: "합성 결정",
      state: "adopted",
      decided_by: "human-p1",
    });
    this.current("decision-1", "decision-v1");

    this.object(p, "report-1", "artifact", 2);
    this.insert("artifacts", { project_id: p, object_id: "report-1", kind: "report" });
    this.version(p, "report-1", "artifact", "report-v1");
    this.insert("artifact_versions", {
      project_id: p,
      object_id: "report-1",
      version_id: "report-v1",
      title: "합성 보고서",
      body_blob_id: "blob-p1",
      status: "published",
    });
    this.current("report-1", "report-v1");
    this.insert("artifact_components", {
      project_id: p,
      parent_version_id: "report-v1",
      position: 0,
      child_version_id: "artifact-v1-p1",
    });
    this.insert("version_files", {
      project_id: p,
      version_id: "report-v1",
      blob_id: "blob-p1",
      role: "rendered",
      file_policy_id: "fp-p1",
    });
    this.insert("file_ai_access_versions", {
      id: "ai-access-p1",
      project_id: p,
      file_policy_id: "fp-p1",
      ai_access: "allow",
      changed_by_actor_id: "human-p1",
      changed_by_user_id: "user-p1",
      changed_at: 1000,
      rev: 1,
      tx_id: "tx-p1",
    });
    this.insert("file_extractions", {
      id: "extract-p1",
      project_id: p,
      version_id: "report-v1",
      blob_id: "blob-p1",
      source_file_policy_id: "fp-p1",
      source_format: "md",
      extractor: "synthetic",
      extractor_version: "1",
      status: "ready",
      text_blob_id: "blob-p1",
      text_file_policy_id: "fp-p1",
      text_hash: HASH,
      page_count: 1,
      table_count: 0,
      tx_id: "tx-p1",
    });
    // 같은 바이트(같은 blob)를 나중 버전에 붙이면 같은 정책을 다시 써야 한다.
    this.object(p, "report-2", "artifact", 3);
    this.insert("artifacts", { project_id: p, object_id: "report-2", kind: "report" });
    this.version(p, "report-2", "artifact", "report-v2", 1);
    this.insert("artifact_versions", {
      project_id: p,
      object_id: "report-2",
      version_id: "report-v2",
      title: "합성 보고서 2",
      body_blob_id: "blob-p1",
      status: "published",
    });
    this.current("report-2", "report-v2");
    this.insert("version_files", {
      project_id: p,
      version_id: "report-v2",
      blob_id: "blob-p1",
      role: "rendered",
      file_policy_id: "fp-p1",
    });
    // 거부 정책은 blob 단위다: rendered/source 역할이 더 너그러워질 수 없다.
    this.insert("blobs", {
      id: "blob-deny",
      project_id: p,
      storage_key: "synthetic/p1/deny",
      sha256: "d".repeat(64),
      size: 20,
      media_type: "text/plain",
      state: "ready",
      created_by: "human-p1",
    });
    this.insert("file_policies", {
      id: "fp-deny",
      project_id: p,
      blob_id: "blob-deny",
      ai_access: "deny",
      rev: 1,
      changed_by_actor_id: "human-p1",
      changed_by_user_id: "user-p1",
      changed_at: 1000,
      tx_id: "tx-p1",
    });
    this.insert("file_ai_access_versions", {
      id: "ai-access-deny",
      project_id: p,
      file_policy_id: "fp-deny",
      ai_access: "deny",
      changed_by_actor_id: "human-p1",
      changed_by_user_id: "user-p1",
      changed_at: 1000,
      rev: 1,
      tx_id: "tx-p1",
    });
    this.insert("version_files", {
      project_id: p,
      version_id: "report-v1",
      blob_id: "blob-deny",
      role: "rendered",
      file_policy_id: "fp-deny",
    });
    this.insert("version_files", {
      project_id: p,
      version_id: "report-v1",
      blob_id: "blob-deny",
      role: "source",
      file_policy_id: "fp-deny",
    });
    this.insert("file_extractions", {
      id: "extract-deny",
      project_id: p,
      version_id: "report-v1",
      blob_id: "blob-deny",
      source_file_policy_id: "fp-deny",
      source_format: "txt",
      extractor: "synthetic",
      extractor_version: "1",
      status: "ready",
      text_blob_id: "blob-deny",
      text_file_policy_id: "fp-deny",
      text_hash: HASH,
      page_count: 1,
      table_count: 0,
      tx_id: "tx-p1",
    });
    this.insert("sync_links", {
      id: "link-p1",
      project_id: p,
      device_id: "device-p1",
      credential_kind: "helper_device",
      helper_actor_id: "code",
      created_by_user_id: "user-p1",
    });
    this.insert("sync_items", {
      id: "sync-p1",
      project_id: p,
      link_id: "link-p1",
      direction: "up",
      version_id: "report-v1",
      blob_id: "blob-p1",
      local_label: "synthetic/report.md",
      remote_hash: HASH,
      local_hash: HASH,
      state: "synced",
      tx_id: "tx-p1",
    });
    this.insert("agent_schedules", {
      id: "schedule-p1",
      project_id: p,
      link_id: "link-p1",
      run_id: "run-p1",
      title: "합성 작업",
      status: "done",
      seq: 1,
      summary: "완료",
      tx_id: "tx-p1",
    });

    this.object(p, "followup-1", "followup", 1);
    this.insert("followups", {
      project_id: p,
      object_id: "followup-1",
      origin_thread_id: "thread-2",
      origin_message_version_id: "message-2-v1",
    });
    this.version(p, "followup-1", "followup", "followup-v1");
    this.insert("followup_versions", {
      project_id: p,
      object_id: "followup-1",
      version_id: "followup-v1",
      kind: "edit_text",
      state: "applied",
      description: "합성 수정",
      base_artifact_version_id: "artifact-v1-p1",
      proposed_artifact_version_id: "artifact-v2-p1",
      result_version_id: "artifact-v2-p1",
      confirmed_by_actor_id: "human-p1",
      applied_tx_id: "tx-p1",
    });
    this.current("followup-1", "followup-v1");
    this.insert("reflection_entries", {
      id: "reflection-1",
      project_id: p,
      source_version_id: "answer-v1-p1",
      target_round_id: "round-p1",
      disposition: "applied",
      rationale: "합성 반영",
      result_version_id: "artifact-v2-p1",
      followup_id: "followup-1",
      applied_tx_id: "tx-p1",
      actor_id: "human-p1",
      tx_id: "tx-p1",
    });
    this.insert("outbound_dispatches", {
      id: "dispatch-1",
      project_id: p,
      run_id: "run-p1",
      provider: "opencode-go",
      policy_version_id: "policy-p1",
      manifest_blob_id: "blob-p1",
      payload_hash: HASH,
      state: "prepared",
      request_key: "synthetic-dispatch",
    });
    this.insert("import_batches", {
      id: "import-1",
      project_id: p,
      source_fingerprint: "synthetic-source-v1",
      source_schema: "synthetic-legacy",
      importer_version: "draft-1",
      source_manifest_blob_id: "blob-p1",
      state: "validated",
    });
    this.insert("legacy_mappings", {
      project_id: p,
      import_batch_id: "import-1",
      legacy_kind: "item",
      legacy_scope: "plan:R1",
      legacy_key: "1",
      content_hash: HASH,
      new_object_id: "artifact-p1",
      new_version_id: "artifact-v1-p1",
    });
    this.insert("db_meta", { id: 1, schema_version: 1, database_instance_id: "synthetic-memory-db", cursor_epoch: 1 });
  }

  seed(): void {
    this.db.exec("BEGIN");
    try {
      const actors: Array<[string, string, string | null]> = [
        ["ai", "internal_ai", "opencode"],
        ["code", "external_agent", "claude_code"],
        ["browser", "browser_agent", "webmcp"],
        ["legacy", "legacy_unknown", null],
      ];
      for (const [aid, kind, runtime] of actors) {
        this.insert("actors", { id: aid, kind, runtime, display_name: "합성 에이전트" });
      }
      this.seed_project("p1");
      this.seed_project("p2");
      this.seed_details();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    require(this.scalar("SELECT count(*) FROM stages") === 12, "Expected six stages per project");
    require(
      this.scalar("SELECT allow_opencode_go FROM project_policy_versions WHERE id='policy-p1'") === 1,
      "Go initialization must be ON",
    );
    require(
      this.scalar("SELECT count(*) FROM approvals WHERE human_user_id IS NULL AND origin='legacy'") === 1,
      "Uncertain legacy approval must be representable",
    );
    require(
      this.scalar("SELECT count(*) FROM source_versions WHERE project_id='p1' AND url='https://example.invalid/source'") === 2,
      "Distinct source records with the same URL must be preserved",
    );
    require(
      this.scalar("SELECT count(*) FROM editions WHERE project_id='p1'") === 2,
      "Inactive editions must be allowed alongside the active edition",
    );
    const tables = this.rows("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map(
      (r) => r[0] as string,
    );
    require(
      tables.every((name) => (this.scalar(`SELECT count(*) FROM "${name}"`) as number) > 0),
      "Every design table must receive at least one synthetic row",
    );
    this.table_count = tables.length;
    this.print(`PASS synthetic hierarchy: 2 projects, 12 stages, all ${tables.length} tables populated`);
    this.print("PASS allowed cases: inactive edition, duplicate URL sources, uncertain legacy approval, Go initialized ON");
  }

  negative_checks(): void {
    const x = (label: string, operation: () => void, expected?: string): void =>
      this.rejected(label, operation, expected);
    const sql = (text: string, params: Value[] = []): void => {
      this.sql(text, params);
    };
    x("missing reference", () =>
      this.insert("version_files", {
        project_id: "p1",
        version_id: "missing",
        blob_id: "blob-p1",
        role: "attachment",
        file_policy_id: "fp-p1",
      }),
    );
    x("file policy for another blob", () =>
      this.insert("version_files", {
        project_id: "p1",
        version_id: "artifact-v1-p1",
        blob_id: "blob-p1",
        role: "attachment",
        file_policy_id: "fp-p2",
      }),
    );
    x("file history without policy", () =>
      this.insert("file_ai_access_versions", {
        id: "bad-ai-history",
        project_id: "p1",
        file_policy_id: "missing",
        ai_access: "allow",
        changed_by_actor_id: "human-p1",
        changed_by_user_id: "user-p1",
        changed_at: 1000,
        rev: 1,
        tx_id: "tx-p1",
      }),
    );
    x("extraction policy mismatch", () =>
      this.insert("file_extractions", {
        id: "bad-extract",
        project_id: "p1",
        version_id: "report-v1",
        blob_id: "blob-p1",
        source_file_policy_id: "fp-p2",
        source_format: "md",
        extractor: "synthetic",
        extractor_version: "1",
        status: "pending",
        tx_id: "tx-p1",
      }),
    );
    x(
      "duplicate blob policy",
      () =>
        this.insert("file_policies", {
          id: "fp-dup",
          project_id: "p1",
          blob_id: "blob-p1",
          ai_access: "allow",
          rev: 2,
          changed_by_actor_id: "human-p1",
          changed_by_user_id: "user-p1",
          changed_at: 1000,
          tx_id: "tx-p1",
        }),
      "UNIQUE",
    );
    x("foreign edition parent", () =>
      this.insert("editions", { id: "bad-edition", project_id: "p1", edition_no: 9, parent_edition_id: "edition-p2" }),
    );
    x("foreign active edition", () => sql("UPDATE projects SET active_edition_id='edition-p2' WHERE id='p1'"));
    x("foreign policy pointer", () => sql("UPDATE projects SET current_policy_id='policy-p2' WHERE id='p1'"));
    x("foreign stage pointer", () => sql("UPDATE editions SET current_stage_id='stage-p2-plan' WHERE id='edition-p1'"));
    x("foreign round pointer", () => sql("UPDATE stages SET current_round_id='round-p2' WHERE id='stage-p1-plan'"));
    x("foreign object pointer", () =>
      sql("UPDATE objects SET current_version_id='artifact-v1-p2' WHERE id='artifact-p1'"),
    );
    x("same-project wrong object version", () =>
      sql("UPDATE objects SET current_version_id='source-v1-p1' WHERE id='artifact-p1'"),
    );
    x("wrong payload subtype", () =>
      this.insert("artifact_versions", {
        project_id: "p1",
        version_id: "question-v1-p1",
        object_id: "question-p1",
        title: "wrong",
      }),
    );
    x("foreign answer question version", () =>
      sql("UPDATE answer_versions SET question_version_id='question-v1-p2' WHERE version_id='answer-v1-p1'"),
    );
    x("foreign form question", () =>
      this.insert("question_set_members", {
        project_id: "p1",
        set_id: "form-p1",
        question_id: "question-p2",
        question_version_id: "question-v1-p2",
        position: 1,
      }),
    );
    x("foreign citation", () =>
      this.insert("citations", {
        project_id: "p1",
        artifact_version_id: "artifact-v1-p1",
        citation_no: 2,
        source_version_id: "source-v1-p2",
      }),
    );
    x("foreign file", () =>
      this.insert("version_files", {
        project_id: "p1",
        version_id: "artifact-v1-p1",
        blob_id: "blob-p2",
        role: "attachment",
        file_policy_id: "fp-p2",
      }),
    );
    x("foreign relation", () =>
      this.insert("version_relations", {
        project_id: "p1",
        from_version_id: "report-v1",
        to_version_id: "artifact-v1-p2",
        kind: "related",
      }),
    );
    x("foreign anchor resolution", () =>
      this.insert("anchor_resolutions", {
        id: "bad-anchor",
        project_id: "p1",
        anchor_id: "anchor-1",
        target_object_id: "artifact-p1",
        evaluated_version_id: "artifact-v1-p2",
        status: "lost",
        method: "synthetic",
      }),
    );
    x("reply in another thread", () => sql("UPDATE messages SET reply_to='message-1' WHERE object_id='message-2'"));
    x("foreign run target", () =>
      this.insert("run_targets", { project_id: "p1", run_id: "run-p1", object_id: "artifact-p2", base_rev: 0 }),
    );
    x("reference snapshot project mismatch", () =>
      this.insert("project_references", {
        id: "bad-ref",
        project_id: "p1",
        referenced_project_id: "p2",
        referenced_project_key: "p2",
        source_snapshot_id: "snapshot-p1",
        source_snapshot_key: "snapshot-p1",
        source_label: "wrong",
        attached_by_actor_id: "human-p1",
        attached_by_user_id: "user-p1",
      }),
    );
    x(
      "missing source project cannot point at a local snapshot",
      () =>
        this.insert("project_references", {
          id: "bad-missing-source",
          project_id: "p1",
          referenced_project_id: null,
          referenced_project_key: "p2@remote",
          source_snapshot_id: "snapshot-p2",
          source_snapshot_key: "snapshot-p2",
          source_label: "wrong",
          attached_by_actor_id: "human-p1",
          attached_by_user_id: "user-p1",
        }),
      "CHECK",
    );
    x("foreign lease run", () =>
      sql("UPDATE project_leases SET run_id='run-p2',owner_actor_id='code' WHERE project_id='p1'"),
    );
    x("foreign event transaction", () =>
      this.insert("events", { id: "bad-event", project_id: "p1", tx_id: "tx-p2", tx_index: 1, tx_size: 2, type: "bad" }),
    );
    x("foreign event version", () =>
      this.insert("events", {
        id: "bad-event",
        project_id: "p1",
        tx_id: "tx-p1",
        tx_index: 1,
        tx_size: 2,
        type: "bad",
        object_id: "artifact-p1",
        after_version_id: "artifact-v1-p2",
      }),
    );
    x("foreign dispatch policy", () =>
      sql("UPDATE outbound_dispatches SET policy_version_id='policy-p2' WHERE id='dispatch-1'"),
    );
    x(
      "dispatch response without hash",
      () => sql("UPDATE outbound_dispatches SET state='response' WHERE id='dispatch-1'"),
      "CHECK",
    );
    x(
      "dispatch adopted without version",
      () => sql(`UPDATE outbound_dispatches SET state='adopted', response_hash='${HASH}' WHERE id='dispatch-1'`),
      "CHECK",
    );
    x(
      "dispatch unknown without time",
      () => sql("UPDATE outbound_dispatches SET state='unknown' WHERE id='dispatch-1'"),
      "CHECK",
    );
    x(
      "sync helper without helper actor",
      () =>
        this.insert("sync_links", {
          id: "bad-link",
          project_id: "p1",
          device_id: "device-bad",
          credential_kind: "helper_device",
          created_by_user_id: "user-p1",
        }),
      "CHECK",
    );
    x(
      "sync item without transaction",
      () =>
        this.insert("sync_items", {
          id: "bad-sync",
          project_id: "p1",
          link_id: "link-p1",
          direction: "up",
          local_label: "synthetic/bad.md",
          state: "synced",
          tx_id: "missing",
        }),
      "FOREIGN KEY",
    );
    x("foreign submission file", () => sql("UPDATE submissions SET raw_blob_id='blob-p2' WHERE id='submission-p1'"));
    x("foreign legacy target", () =>
      sql("UPDATE legacy_mappings SET new_object_id='artifact-p2',new_version_id='artifact-v1-p2'"),
    );
    x("ownerless project", () =>
      this.insert("projects", { id: "ownerless", slug: "synthetic-ownerless", topic: "합성", owner_user_id: "user-p1" }),
    );
    x("duplicate display number", () => this.object("p1", "duplicate-object", "question", 1), "UNIQUE");
    x("duplicate version number", () => this.version("p1", "artifact-p1", "artifact", "duplicate-v", 1), "UNIQUE");
    x(
      "duplicate idempotency key",
      () =>
        this.insert("mutation_commits", {
          id: "duplicate-tx",
          project_id: "p1",
          actor_id: "human-p1",
          via: "web",
          client_request_id: "bootstrap",
          request_hash: "f".repeat(64),
          action: "bad",
        }),
      "UNIQUE",
    );
    x(
      "duplicate event position",
      () =>
        this.insert("events", {
          id: "duplicate-event",
          project_id: "p1",
          tx_id: "tx-p1",
          tx_index: 0,
          tx_size: 1,
          type: "bad",
        }),
      "UNIQUE",
    );
    x(
      "two active editions",
      () => this.insert("editions", { id: "second-active", project_id: "p1", edition_no: 2, status: "active" }),
      "UNIQUE",
    );
    x("activate another existing edition", () => sql("UPDATE editions SET status='active' WHERE id='draft-p1'"), "UNIQUE");
    x(
      "two open rounds",
      () =>
        this.insert("rounds", {
          id: "second-open",
          project_id: "p1",
          edition_id: "edition-p1",
          stage_id: "stage-p1-plan",
          round_no: 2,
        }),
      "UNIQUE",
    );
    x("wrong stage ordinal", () => sql("UPDATE stages SET ordinal=7 WHERE id='stage-p1-plan'"), "CHECK");
    x("negative revision", () => sql("UPDATE objects SET rev=-1 WHERE id='artifact-p1'"), "CHECK");
    x(
      "invalid policy boolean",
      () => sql("UPDATE project_policy_versions SET allow_opencode_go=2 WHERE id='policy-p1'"),
      "CHECK",
    );
    x(
      "invalid JSON",
      () => sql("UPDATE artifact_versions SET stats='not-json' WHERE version_id='artifact-v1-p1'"),
      "CHECK",
    );
    x(
      "invalid question options shape",
      () => sql("UPDATE question_versions SET options='{}' WHERE version_id='question-v1-p1'"),
      "CHECK",
    );
    x(
      "malformed question options JSON",
      () => sql("UPDATE question_versions SET options='{' WHERE version_id='question-v1-p1'"),
      "CHECK",
    );
    x(
      "malformed token scopes JSON",
      () => sql("UPDATE agent_tokens SET scopes='{' WHERE id='synthetic-token'"),
      "CHECK",
    );
    x("A must retain chosen model", () => sql("UPDATE runs SET model='another-model' WHERE id='run-p1'"), "CHECK");
    x("agent cannot impersonate human approval", () =>
      this.insert("approvals", {
        id: "bad-approval",
        project_id: "p1",
        stage_id: "stage-p1-plan",
        snapshot_id: "snapshot-p1",
        actor_id: "ai",
        actor_kind: "human",
        human_user_id: "user-p1",
        origin: "new",
        assurance: "verified",
        tx_id: "tx-p1",
      }),
    );
    x("agent cannot reallow Go", () =>
      this.insert("project_policy_versions", {
        id: "bad-policy",
        project_id: "p1",
        policy_rev: 2,
        changed_by: "ai",
        changed_by_user_id: "user-p1",
        reason: "bad",
        tx_id: "tx-p1",
      }),
    );
    x("other owner cannot change this policy", () =>
      this.insert("project_policy_versions", {
        id: "other-policy",
        project_id: "p1",
        policy_rev: 2,
        changed_by: "human-p2",
        changed_by_user_id: "user-p2",
        reason: "bad",
        tx_id: "tx-p1",
      }),
    );
    x(
      "anonymous new approval",
      () =>
        this.insert("approvals", {
          id: "anonymous-approval",
          project_id: "p1",
          stage_id: "stage-p1-plan",
          snapshot_id: "snapshot-p1",
          actor_id: "legacy",
          actor_kind: "legacy_unknown",
          origin: "new",
          assurance: "verified",
          tx_id: "tx-p1",
        }),
      "CHECK",
    );
    x(
      "applied receipt needs transaction",
      () => sql("UPDATE run_input_receipts SET state='applied' WHERE run_id='run-p1'"),
      "CHECK",
    );
    x(
      "applied reflection needs evidence",
      () =>
        this.insert("reflection_entries", {
          id: "bad-reflection",
          project_id: "p1",
          source_version_id: "answer-v1-p1",
          target_round_id: "round-p1",
          disposition: "applied",
          rationale: "bad",
          actor_id: "human-p1",
          tx_id: "tx-p1",
        }),
      "CHECK",
    );
    x("approval requires snapshot", () => sql("UPDATE stages SET status='approved' WHERE id='stage-p1-research'"), "CHECK");
    x("referenced file delete", () => sql("DELETE FROM blobs WHERE id='blob-p1'"));
    x("referenced snapshot delete", () => sql("DELETE FROM snapshots WHERE id='snapshot-ref-del'"));
    sql(
      "UPDATE project_references SET source_snapshot_id=NULL, latest_snapshot_id=NULL, " +
        "status='source_missing' WHERE id='ref-delete'",
    );
    sql("DELETE FROM snapshots WHERE id='snapshot-ref-del'");
    require(
      this.scalar(
        "SELECT count(*) FROM project_references WHERE id='ref-delete' " +
          "AND status='source_missing' AND source_snapshot_id IS NULL " +
          "AND source_snapshot_key='snapshot-ref-del'",
      ) === 1,
      "Explicit release must keep the source key and tombstone",
    );
    x("blocked usage without reason", () => sql("UPDATE runs SET status='blocked_usage' WHERE id='run-p1'"), "CHECK");
    x(
      "waiting_human cannot carry a usage block",
      () =>
        sql(
          "UPDATE runs SET status='waiting_human', " +
            "go_block_reason='usage_limit', go_blocked_at=3000 WHERE id='run-p1'",
        ),
      "CHECK",
    );
    sql("SAVEPOINT f13");
    sql(
      "UPDATE runs SET status='blocked_usage', go_block_reason='usage_limit', " +
        "go_blocked_at=3000, go_block_reset_at=NULL WHERE id='run-p1'",
    );
    require(
      this.scalar(
        "SELECT count(*) FROM runs WHERE id='run-p1' AND status='blocked_usage' AND go_block_reason='usage_limit'",
      ) === 1,
      "Usage block must be representable",
    );
    sql(
      "UPDATE runs SET status='waiting_human', go_block_reason=NULL, go_blocked_at=NULL, " +
        "go_block_reset_at=NULL WHERE id='run-p1'",
    );
    require(
      this.scalar("SELECT count(*) FROM runs WHERE id='run-p1' AND status='waiting_human'") === 1,
      "waiting_human must remain available for human input",
    );
    sql("ROLLBACK TO f13");
    sql("RELEASE f13");
    require(
      this.scalar(
        "SELECT count(*) FROM version_files WHERE version_id='report-v2' AND blob_id='blob-p1' AND file_policy_id='fp-p1'",
      ) === 1,
      "Same blob reattached to a new version must reuse its policy",
    );
    require(
      this.scalar(
        "SELECT count(*) FROM version_files vf JOIN file_policies fp " +
          "ON fp.id=vf.file_policy_id AND fp.project_id=vf.project_id " +
          "WHERE vf.blob_id='blob-deny' AND fp.ai_access='deny'",
      ) === 2,
      "Deny must apply to every role sharing the blob",
    );
    require(
      this.scalar(
        "SELECT count(*) FROM file_extractions e JOIN file_policies s " +
          "ON s.id=e.source_file_policy_id AND s.project_id=e.project_id " +
          "JOIN file_policies t ON t.id=e.text_file_policy_id AND t.project_id=e.project_id " +
          "WHERE e.id='extract-deny' AND s.ai_access='deny' AND t.ai_access='deny'",
      ) === 1,
      "Extraction must inherit the deny policy",
    );
    sql("SAVEPOINT f07");
    sql(
      "UPDATE outbound_dispatches SET state='response', response_hash=?, response_at=3000, " +
        "external_request_id='synthetic-ext-1', usage_json='{}', billing_source='go_subscription', " +
        "allowance_json='{}', cost_json='{}' WHERE id='dispatch-1'",
      [HASH],
    );
    sql(
      "UPDATE outbound_dispatches SET state='adopted', adopted_version_id='artifact-v1-p1', " +
        "adopted_at=3000 WHERE id='dispatch-1'",
    );
    require(
      this.scalar(
        "SELECT count(*) FROM outbound_dispatches WHERE id='dispatch-1' " +
          "AND state='adopted' AND adopted_version_id='artifact-v1-p1' " +
          "AND response_hash IS NOT NULL AND billing_source='go_subscription'",
      ) === 1,
      "Persisted response/adoption must be representable",
    );
    sql("ROLLBACK TO f07");
    sql("RELEASE f07");
    x(
      "duplicate import",
      () =>
        this.insert("import_batches", {
          id: "duplicate-import",
          project_id: "p1",
          source_fingerprint: "synthetic-source-v1",
          source_schema: "synthetic",
          importer_version: "draft",
          source_manifest_blob_id: "blob-p1",
          state: "staging",
        }),
      "UNIQUE",
    );
    this.print(`PASS constraints: ${this.rejections} invalid/reference/cross-project/duplicate writes rejected`);
    this.print("PASS partial UNIQUE: second active edition and second open round rejected");
  }

  queries(): void {
    const hierarchy = this.rows(`
            SELECT p.id, count(DISTINCT s.id), count(DISTINCT r.id)
            FROM projects p JOIN editions e ON e.id=p.active_edition_id AND e.project_id=p.id
            JOIN stages s ON s.edition_id=e.id AND s.project_id=p.id
            LEFT JOIN rounds r ON r.stage_id=s.id AND r.project_id=p.id
            GROUP BY p.id ORDER BY p.id
        `);
    require(
      same(hierarchy, [
        ["p1", 6, 1],
        ["p2", 6, 1],
      ]),
      "Hierarchy query mismatch",
    );
    const answers = this.rows(
      `
            SELECT old.text, current.text, av.value, m.body_md
            FROM answers a JOIN objects o ON o.id=a.object_id AND o.project_id=a.project_id
            JOIN answer_versions av ON av.version_id=o.current_version_id AND av.project_id=a.project_id
            JOIN question_versions old ON old.version_id=av.question_version_id AND old.project_id=a.project_id
            JOIN objects qo ON qo.id=a.question_id AND qo.project_id=a.project_id
            JOIN question_versions current ON current.version_id=qo.current_version_id AND current.project_id=a.project_id
            JOIN threads t ON t.target_object_id=a.question_id AND t.project_id=a.project_id
            JOIN messages mi ON mi.thread_id=t.object_id AND mi.project_id=a.project_id
            JOIN objects mo ON mo.id=mi.object_id AND mo.project_id=a.project_id
            JOIN message_versions m ON m.version_id=mo.current_version_id AND m.project_id=a.project_id
            WHERE a.project_id=?
        `,
      ["p1"],
    );
    require(same(answers, [["첫 질문", "수정 질문", '"yes"', "합성 덧붙임"]]), "Historical answer/comment query mismatch");
    const changes_sql = "SELECT event_seq,type FROM events WHERE project_id=? AND event_seq>? ORDER BY event_seq LIMIT 10";
    const changes = this.rows(changes_sql, ["p1", 0]);
    require(changes.length === 1 && changes[0]![1] === "fixture.created", "Project cursor leaked or lost events");
    const plan = this.rows(`EXPLAIN QUERY PLAN ${changes_sql}`, ["p1", 0]);
    require(
      plan.some((row) => String(row[3]).includes("SEARCH") && String(row[3]).includes("project_id")),
      "Change query did not use scoped search",
    );
    this.positive_checks += 3;
    this.print("PASS representative queries: hierarchy, historical answer + comment, scoped change cursor (indexed)");
  }

  state_signature(): unknown[] {
    return [
      this.scalar("SELECT count(*) FROM mutation_commits"),
      this.scalar("SELECT count(*) FROM object_versions"),
      this.scalar("SELECT count(*) FROM artifact_versions"),
      this.scalar("SELECT count(*) FROM events"),
      this.rows("SELECT current_version_id,rev FROM objects WHERE id='artifact-p1'")[0],
    ];
  }

  candidate_change(tx: string, vid: string, expected_rev: number): number {
    this.insert("mutation_commits", {
      id: tx,
      project_id: "p1",
      actor_id: "ai",
      run_id: "run-p1",
      via: "http",
      client_request_id: tx,
      request_hash: HASH,
      action: "result.submit",
      lease_id: "lease-p1",
      fence: 1,
    });
    this.version("p1", "artifact-p1", "artifact", vid, 3, "ai", "run-p1", tx);
    this.insert("artifact_versions", {
      project_id: "p1",
      object_id: "artifact-p1",
      version_id: vid,
      title: "합성 커밋 후보",
      body_md: "새 합성 본문",
      status: "done",
    });
    this.insert("events", {
      id: `event-${tx}`,
      project_id: "p1",
      run_id: "run-p1",
      tx_id: tx,
      tx_index: 0,
      tx_size: 1,
      type: "result.submitted",
      object_id: "artifact-p1",
      after_version_id: vid,
    });
    return this.sql(
      `
            UPDATE objects SET current_version_id=?, rev=rev+1
            WHERE project_id='p1' AND id='artifact-p1' AND rev=?
        `,
      [vid, expected_rev],
    ).changes;
  }

  atomic_checks(): void {
    const before = this.state_signature();
    const rev = (before[4] as Row)[1] as number;

    this.db.exec("BEGIN");
    let conflict = false;
    try {
      const changed = this.candidate_change("tx-stale", "v-stale", rev - 1);
      if (changed !== 1) {
        require(changed === 0, "Expected an actual zero-row UPDATE");
        conflict = true; // 조건부 UPDATE 가 0행을 바꿨다 — 명시적 충돌.
      } else {
        this.db.exec("COMMIT");
      }
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (!conflict) throw new Error("Stale revision unexpectedly committed");
    this.db.exec("ROLLBACK");
    require(same(this.state_signature(), before), "Zero-row CAS left partial writes");
    this.print("PASS zero-row CAS: explicit failure; version, payload, pointer, event, receipt all rolled back");

    this.db.exec("BEGIN");
    let raised = false;
    try {
      require(this.candidate_change("tx-late-failure", "v-late-failure", rev) === 1, "Valid CAS failed");
      this.sql("UPDATE mutation_commits SET guard_ok=0 WHERE id='tx-late-failure'");
      this.db.exec("COMMIT");
    } catch (error) {
      if (!is_integrity_error(error)) throw error;
      require((error as Error).message.includes("CHECK"), "Expected guard CHECK failure");
      this.db.exec("ROLLBACK");
      raised = true;
    }
    if (!raised) throw new Error("Guard failure was not raised");
    require(same(this.state_signature(), before), "Late SQL failure left a changed pointer or rows");
    this.print("PASS late SQL failure: successful CAS and all other writes rolled back");

    this.db.exec("BEGIN");
    try {
      require(this.candidate_change("tx-success", "v-success", rev) === 1, "Current revision CAS failed");
      this.sql("UPDATE mutation_commits SET result_json=? WHERE id='tx-success'", ['{"version_id":"v-success"}']);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    require(
      same(this.rows("SELECT current_version_id,rev FROM objects WHERE id='artifact-p1'")[0], ["v-success", rev + 1]),
      "Successful change was not published",
    );
    require(
      same(
        this.state_signature().slice(0, 4),
        before.slice(0, 4).map((n) => (n as number) + 1),
      ),
      "Successful command did not commit all four related records",
    );
    require(
      this.scalar("SELECT body_md FROM artifact_versions WHERE version_id='artifact-v1-p1'") === "합성 문장",
      "Old content was overwritten",
    );
    this.print(
      "PASS successful command: new version + pointer + event + idempotency receipt committed; old version retained",
    );

    // SQL 수준 D1 방식 가드 실험. 여기서 실행하는 것은 SQLite 뿐이다.
    const guard_sql = `
            INSERT INTO mutation_commits
                (id,project_id,actor_id,via,client_request_id,request_hash,action,guard_ok)
            SELECT ?, 'p1', 'ai', 'http', ?, ?, 'result.submit',
                CASE WHEN EXISTS (
                    SELECT 1 FROM project_leases l
                    JOIN projects p ON p.id=l.project_id
                    JOIN project_policy_versions policy ON policy.id=p.current_policy_id AND policy.project_id=p.id
                    WHERE l.project_id='p1' AND l.state='active' AND l.fence=?
                    AND l.expires_at>3000 AND policy.allow_opencode_go=1
                ) THEN 1 ELSE 0 END
        `;
    this.sql("UPDATE project_leases SET fence=2,lease_id='lease-p1-next' WHERE project_id='p1'");
    this.rejected("stale fence SQL guard", () => this.sql(guard_sql, ["guard-old", "guard-old", HASH, 1]), "CHECK");
    this.db.exec("BEGIN");
    try {
      this.insert("project_policy_versions", {
        id: "policy-off",
        project_id: "p1",
        policy_rev: 2,
        allow_opencode_go: 0,
        changed_by: "human-p1",
        changed_by_user_id: "user-p1",
        reason: "합성 차단 시험",
        tx_id: "tx-p1",
      });
      this.sql("UPDATE projects SET current_policy_id='policy-off',control_rev=control_rev+1 WHERE id='p1'");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.rejected(
      "Go OFF SQL guard with fresh fence",
      () => this.sql(guard_sql, ["guard-off", "guard-off", HASH, 2]),
      "CHECK",
    );
    this.print("PASS SQL guard examples: stale fence and synthetic Go OFF rejected (SQLite only)");
  }

  run(ddl_path: string): void {
    let ddl: string;
    try {
      ddl = readFileSync(ddl_path, "utf8");
    } catch (error) {
      throw new Error(`cannot read DDL file ${ddl_path}: ${(error as Error).message}`);
    }
    this.db.exec(ddl);
    require(this.scalar("SELECT count(*) FROM sqlite_master WHERE type='trigger'") === 0, "Triggers forbidden");
    require(
      this.scalar("SELECT count(*) FROM sqlite_master WHERE sql LIKE 'CREATE VIRTUAL TABLE%'") === 0,
      "Virtual/FTS tables forbidden",
    );
    require(
      same(this.rows("PRAGMA database_list"), [[0, "main", ""]]),
      "Only the in-memory main database may be connected",
    );
    this.print(`SQLite ${String(this.scalar("SELECT sqlite_version()"))}; foreign_keys=ON; database=:memory:`);
    this.print("PASS DDL execution; no triggers or external databases");
    this.seed();
    this.negative_checks();
    this.queries();
    this.atomic_checks();
    require(this.rows("PRAGMA foreign_key_check").length === 0, "Dangling foreign keys");
    require(this.scalar("PRAGMA integrity_check") === "ok", "SQLite integrity check failed");
    this.print("PASS foreign_key_check and integrity_check");
    this.print(
      `RESULT PASS; rejected cases=${this.rejections}; representative queries=${this.positive_checks}`,
    );
    this.print("D1 NOT TESTED: batch/guard, deferred FKs, partial indexes, JSON functions, migrations, runtime limits");
  }
}

/** 설계 검사를 돌린다. 규칙 위반은 던지지 않고 ok=false + error 로 돌려준다. */
export function run_ddl_checks(options: { ddl_path?: string } = {}): DdlCheckResult {
  const ddl_path = options.ddl_path ?? DEFAULT_DDL;
  let checks: Checks | undefined;
  let error: string | undefined;
  try {
    checks = new Checks();
    checks.run(ddl_path);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    checks?.db.close();
  }
  const result: DdlCheckResult = {
    ok: error === undefined,
    lines: checks?.lines ?? [],
    rejected_cases: checks?.rejections ?? 0,
    representative_queries: checks?.positive_checks ?? 0,
    table_count: checks?.table_count ?? 0,
  };
  if (error !== undefined) result.error = error;
  return result;
}

function parse_args(argv: string[]): { ddl_path?: string } {
  const out: { ddl_path?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--ddl") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error("--ddl needs a path");
      out.ddl_path = value;
      i += 1;
    } else if (arg.startsWith("--ddl=")) {
      out.ddl_path = arg.slice("--ddl=".length);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

if (import.meta.main) {
  main(process.argv.slice(2));
}

function main(argv: string[]): void {
  let options: { ddl_path?: string };
  try {
    options = parse_args(argv);
  } catch (error) {
    process.stderr.write(`check_ddl: ${(error as Error).message}\nusage: node scripts/check_ddl.ts [--ddl <sql>]\n`);
    process.exitCode = 2;
    return;
  }
  const result = run_ddl_checks(options);
  for (const line of result.lines) process.stdout.write(`${line}\n`);
  if (!result.ok) {
    process.stderr.write(`check_ddl: FAIL: ${result.error}\n`);
    process.exitCode = 1;
  }
}
