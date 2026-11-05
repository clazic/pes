// Shared SQLite/D1 contract checks from web0-plan 4.2 and delete web0-measure ③.
// The same suite runs on node:sqlite in tests and through the Worker on local D1.

import type { Db, SqlStatement } from "./db.ts";
import { newId, sha256Hex } from "./store.ts";

export interface ContractCheck {
  name: string;
  status: "pass" | "fail" | "info";
  detail: string;
}

export interface ContractResult {
  tables: number;
  checks: ContractCheck[];
  unsupportedSql: string[];
}

type Attempt = { ok: true } | { ok: false; error: string };

async function attempt(fn: () => Promise<unknown>): Promise<Attempt> {
  try {
    await fn();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function record(
  checks: ContractCheck[],
  name: string,
  passed: boolean,
  detail: string,
): void {
  checks.push({ name, status: passed ? "pass" : "fail", detail });
}

async function seedProjectGraph(
  db: Db,
  suffix: string,
  putTwoOwners: boolean,
): Promise<{ projectId: string; userId: string; secondUserId: string; actorId: string }> {
  const projectId = `prj_ct_${suffix}`;
  const userId = `usr_ct_${suffix}_a`;
  const secondUserId = `usr_ct_${suffix}_b`;
  const actorId = `act_ct_${suffix}`;
  const editionId = `edt_ct_${suffix}`;
  const stageId = `stg_ct_${suffix}`;
  const roundId = `rnd_ct_${suffix}`;
  const t = 1762311600000;
  const statements: SqlStatement[] = [
    {
      sql: `INSERT INTO users (id, display_name, created_at) VALUES (?, '합성 계약 사용자', ?)`,
      params: [userId, t],
    },
    {
      sql: `INSERT INTO users (id, display_name, created_at) VALUES (?, '합성 계약 사용자 2', ?)`,
      params: [secondUserId, t],
    },
    {
      sql: `INSERT INTO actors (id, kind, display_name)
            VALUES (?, 'internal_ai', '합성 계약 실행기')`,
      params: [actorId],
    },
    {
      sql: `INSERT INTO projects
        (id, slug, topic, owner_user_id, status, control_rev, created_at)
        VALUES (?, ?, '합성 계약', ?, 'staging', 0, ?)`,
      params: [projectId, `ct-${suffix}`, userId, t],
    },
    {
      sql: `INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'owner')`,
      params: [projectId, userId],
    },
    {
      sql: `INSERT INTO editions (id, project_id, edition_no, status) VALUES (?, ?, 1, 'active')`,
      params: [editionId, projectId],
    },
    {
      sql: `INSERT INTO stages (id, project_id, edition_id, key, ordinal, status)
            VALUES (?, ?, ?, 'plan', 1, 'active')`,
      params: [stageId, projectId, editionId],
    },
    {
      sql: `INSERT INTO rounds (id, project_id, edition_id, stage_id, round_no, state)
            VALUES (?, ?, ?, ?, 1, 'open')`,
      params: [roundId, projectId, editionId, stageId],
    },
  ];
  if (putTwoOwners) {
    statements.push({
      sql: `INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'owner')`,
      params: [projectId, secondUserId],
    });
  }
  await db.batch(statements);
  return { projectId, userId, secondUserId, actorId };
}

export async function runContractSuite(db: Db): Promise<ContractResult> {
  const checks: ContractCheck[] = [];
  const unsupportedSql: string[] = [];
  const t = 1762311600000;

  const tables = await db.all<{ n: number }>(
    `SELECT COUNT(*) AS n FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`,
  );
  const tableCount = tables[0]?.n ?? 0;
  record(checks, "table_count_61", tableCount === 61, `tables=${tableCount}`);

  // CHECK
  const checkAttempt = await attempt(() =>
    db.run(`INSERT INTO users (id, display_name, created_at) VALUES (?, '', ?)`, [
      `usr_bad_${newId("x")}`,
      t,
    ]),
  );
  record(checks, "check_constraint", !checkAttempt.ok, checkAttempt.ok ? "accepted empty name" : checkAttempt.error);

  // 0-row CAS
  const cas = await db.run(
    `UPDATE projects SET control_rev = control_rev + 1
     WHERE id = ? AND control_rev = 999999`,
    ["prj_ct_missing"],
  );
  record(checks, "zero_row_cas", cas === 0, `changes=${cas}`);

  // Partial UNIQUE (one_project_owner)
  const twoOwners = await attempt(() => seedProjectGraph(db, newId("own"), true));
  record(
    checks,
    "partial_unique_one_project_owner",
    !twoOwners.ok,
    twoOwners.ok ? "second owner accepted" : twoOwners.error,
  );

  // FK enforcement
  const fk = await attempt(() =>
    db.run(`INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'reader')`, [
      "prj_ct_missing",
      "usr_ct_missing",
    ]),
  );
  record(checks, "foreign_key_enforced", !fk.ok, fk.ok ? "orphan member accepted" : fk.error);

  // Deferred FK: project -> project_members, insert both in one atomic batch.
  const suffix = newId("dfr");
  const deferredId = `prj_ct_${suffix}`;
  const deferredUser = `usr_ct_${suffix}`;
  const deferred = await attempt(() =>
    db.batch([
      {
        sql: `INSERT INTO users (id, display_name, created_at) VALUES (?, '합성 지연 사용자', ?)`,
        params: [deferredUser, t],
      },
      {
        sql: `INSERT INTO projects
          (id, slug, topic, owner_user_id, status, control_rev, created_at)
          VALUES (?, ?, '합성 지연', ?, 'staging', 0, ?)`,
        params: [deferredId, `dfr-${suffix}`, deferredUser, t],
      },
      {
        sql: `INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'owner')`,
        params: [deferredId, deferredUser],
      },
    ]),
  );
  if (!deferred.ok && /not supported|syntax/i.test(deferred.error)) {
    unsupportedSql.push(`deferred FK batch: ${deferred.error}`);
  }
  record(checks, "deferred_fk_atomic_batch", deferred.ok, deferred.ok ? "batch accepted" : deferred.error);

  const missingMemberSuffix = newId("dfm");
  const missingMemberId = `prj_ct_${missingMemberSuffix}`;
  const missingMemberUser = `usr_ct_${missingMemberSuffix}`;
  const missingMember = await attempt(() =>
    db.batch([
      {
        sql: `INSERT INTO users (id, display_name, created_at) VALUES (?, '합성 누락 사용자', ?)`,
        params: [missingMemberUser, t],
      },
      {
        sql: `INSERT INTO projects
          (id, slug, topic, owner_user_id, status, control_rev, created_at)
          VALUES (?, ?, '합성 누락', ?, 'staging', 0, ?)`,
        params: [missingMemberId, `dfm-${missingMemberSuffix}`, missingMemberUser, t],
      },
    ]),
  );
  record(
    checks,
    "deferred_fk_missing_member_rejected",
    !missingMember.ok,
    missingMember.ok ? "project without member accepted" : missingMember.error,
  );

  // Atomic rollback: second statement violates CHECK.
  const rollbackUser = `usr_ct_${newId("rb")}`;
  const rollback = await attempt(() =>
    db.batch([
      {
        sql: `INSERT INTO users (id, display_name, created_at) VALUES (?, '합성 롤백', ?)`,
        params: [rollbackUser, t],
      },
      {
        sql: `INSERT INTO users (id, display_name, created_at) VALUES (?, '', ?)`,
        params: [`usr_ct_${newId("bad")}`, t],
      },
    ]),
  );
  const rollbackRows = await db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE id = ?`, [
    rollbackUser,
  ]);
  const rolledBack = !rollback.ok && (rollbackRows[0]?.n ?? 0) === 0;
  record(
    checks,
    "batch_atomic_rollback",
    rolledBack,
    `failed=${!rollback.ok} first_row_count=${rollbackRows[0]?.n ?? 0}`,
  );

  // Atomic CAS guard: a 0-row conditional update must abort the whole batch.
  const guardCycle = await seedProjectGraph(db, newId("cas"), false);
  const guardId = `grd_${newId("g")}`;
  const guard = await attempt(() =>
    db.batch([
      {
        sql: `UPDATE projects SET control_rev = control_rev
              WHERE id = ? AND CAST(control_rev AS TEXT) = '999999999'`,
        params: [guardCycle.projectId],
      },
      {
        sql: `INSERT INTO mutation_commits
          (id, project_id, actor_id, via, client_request_id, request_hash,
           action, guard_ok, result_json, created_at)
          SELECT ?, ?, ?, 'http', ?, ?, 'spike_guard', 0, '{}', ?
          WHERE changes() = 0`,
        params: [
          guardId,
          guardCycle.projectId,
          guardCycle.actorId,
          `guard:${guardId}`,
          sha256Hex(guardId),
          t,
        ],
      },
    ]),
  );
  record(
    checks,
    "cas_guard_zero_row_rolls_back",
    !guard.ok,
    guard.ok ? "zero-row CAS committed" : guard.error,
  );
  const guardRows = await db.all<{ n: number }>(
    `SELECT COUNT(*) AS n FROM mutation_commits WHERE id = ?`,
    [guardId],
  );
  record(
    checks,
    "cas_guard_left_no_receipt",
    (guardRows[0]?.n ?? 0) === 0,
    `guard_rows=${guardRows[0]?.n ?? 0}`,
  );

  const okGuardId = `grd_${newId("g")}`;
  const okControl = await db.all<{ v: string }>(
    `SELECT CAST(control_rev AS TEXT) AS v FROM projects WHERE id = ?`,
    [guardCycle.projectId],
  );
  const okGuard = await attempt(() =>
    db.batch([
      {
        sql: `UPDATE projects SET control_rev = control_rev
              WHERE id = ? AND CAST(control_rev AS TEXT) = ?`,
        params: [guardCycle.projectId, okControl[0]?.v ?? "0"],
      },
      {
        sql: `INSERT INTO mutation_commits
          (id, project_id, actor_id, via, client_request_id, request_hash,
           action, guard_ok, result_json, created_at)
          SELECT ?, ?, ?, 'http', ?, ?, 'spike_guard', 0, '{}', ?
          WHERE changes() = 0`,
        params: [
          okGuardId,
          guardCycle.projectId,
          guardCycle.actorId,
          `guard:${okGuardId}`,
          sha256Hex(okGuardId),
          t,
        ],
      },
    ]),
  );
  record(
    checks,
    "cas_guard_matching_row_commits",
    okGuard.ok,
    okGuard.ok ? "matching CAS committed" : okGuard.error,
  );

  // Decimal roundtrip above Number.MAX_SAFE_INTEGER.
  // Reuse a full project graph (active edition, open round) for the constraint checks below.
  const decimalGraph = await seedProjectGraph(db, newId("dec"), false);
  const decimalProject = decimalGraph.projectId;
  const decimalUser = decimalGraph.userId;
  const big = "9007199254740993"; // 2^53 + 1
  const decimalAttempt = await attempt(() =>
    db.run(`UPDATE projects SET control_rev = ? WHERE id = ?`, [big, decimalProject]),
  );
  let decimalText = "";
  if (decimalAttempt.ok) {
    const textRows = await db.all<{ v: string }>(
      `SELECT CAST(control_rev AS TEXT) AS v FROM projects WHERE id = ?`,
      [decimalProject],
    );
    decimalText = textRows[0]?.v ?? "";
  }
  record(
    checks,
    "decimal_roundtrip_cast_text",
    decimalAttempt.ok && decimalText === big,
    `stored=${decimalText} expected=${big}`,
  );
  // Informational: reading the raw INTEGER as a JS number loses precision.
  if (decimalAttempt.ok) {
    try {
      const rawRows = await db.all<{ v: number }>(
        `SELECT control_rev AS v FROM projects WHERE id = ?`,
        [decimalProject],
      );
      const raw = rawRows[0]?.v ?? 0;
      checks.push({
        name: "decimal_raw_number_precision_loss",
        status: "info",
        detail: `raw=${String(raw)} exact=${String(raw) === big} (adapter must CAST to TEXT)`,
      });
    } catch (error) {
      checks.push({
        name: "decimal_raw_number_precision_loss",
        status: "info",
        detail: `raw INTEGER read threw: ${error instanceof Error ? error.message : String(error)}; adapter must CAST to TEXT`,
      });
    }
  }

  // JSON CHECK functions.
  const badJson = await attempt(() =>
    db.run(
      `INSERT INTO agent_tokens (id, project_id, actor_id, scopes, token_hash, created_at)
       VALUES (?, ?, ?, 'not-json', ?, ?)`,
      [`agt_${newId("x")}`, decimalProject, decimalUser, sha256Hex("x"), t],
    ),
  );
  const jsonCheckWorks = !badJson.ok;
  record(checks, "json_valid_check", jsonCheckWorks, badJson.ok ? "invalid JSON accepted" : badJson.error);

  const badJsonType = await attempt(() =>
    db.run(
      `INSERT INTO agent_tokens (id, project_id, actor_id, scopes, token_hash, created_at)
       VALUES (?, ?, ?, '{}', ?, ?)`,
      [`agt_${newId("x")}`, decimalProject, decimalUser, sha256Hex("y"), t],
    ),
  );
  record(
    checks,
    "json_type_array_check",
    !badJsonType.ok,
    badJsonType.ok ? "object accepted for array" : badJsonType.error,
  );

  // Partial UNIQUE (one_active_edition).
  const secondEdition = await attempt(() =>
    db.run(`INSERT INTO editions (id, project_id, edition_no, status) VALUES (?, ?, 2, 'active')`, [
      `edt_${newId("x")}`,
      decimalProject,
    ]),
  );
  record(
    checks,
    "partial_unique_one_active_edition",
    !secondEdition.ok,
    secondEdition.ok ? "second active edition accepted" : secondEdition.error,
  );

  // Partial UNIQUE (one_open_round).
  const rounds = await db.all<{ stage_id: string; edition_id: string }>(
    `SELECT stage_id, edition_id FROM rounds WHERE project_id = ? LIMIT 1`,
    [decimalProject],
  );
  const secondRound = rounds[0]
    ? await attempt(() =>
        db.run(
          `INSERT INTO rounds (id, project_id, edition_id, stage_id, round_no, state)
           VALUES (?, ?, ?, ?, 2, 'open')`,
          [
            `rnd_${newId("x")}`,
            decimalProject,
            rounds[0]?.edition_id ?? "",
            rounds[0]?.stage_id ?? "",
          ],
        ),
      )
    : { ok: false as const, error: "no stage" };
  record(
    checks,
    "partial_unique_one_open_round",
    !secondRound.ok,
    secondRound.ok ? "second open round accepted" : secondRound.error,
  );

  const failed = checks.filter((check) => check.status === "fail");
  return { tables: tableCount, checks, unsupportedSql: failed.map((check) => `${check.name}: ${check.detail}`) };
}
