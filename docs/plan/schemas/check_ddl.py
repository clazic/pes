#!/usr/bin/env python3
"""Design-only SQLite checks. Reads this directory's SQL; uses ONLY :memory:.

No PES imports, actual project/config reads, filesystem databases, network, or deps.
The CAS/guard examples below are design experiments, not a production service.
"""

import sqlite3


HASH = "a" * 64
KEYS = ("plan", "research", "analyze", "write", "verify", "publish")


def require(condition, message):
    if not condition:
        raise AssertionError(message)


class Checks:
    def __init__(self):
        self.db = sqlite3.connect(":memory:", isolation_level=None)
        self.db.execute("PRAGMA foreign_keys=ON")
        require(self.scalar("PRAGMA foreign_keys") == 1, "foreign_keys is not ON")
        self.rejections = 0
        self.positive_checks = 0

    def scalar(self, sql, parameters=()):
        return self.db.execute(sql, parameters).fetchone()[0]

    def insert(self, table, **values):
        # Identifiers are hard-coded test constants; VALUES are always bound.
        columns = ",".join('"' + column + '"' for column in values)
        placeholders = ",".join("?" for _ in values)
        return self.db.execute(
            'INSERT INTO "' + table + '" (' + columns + ') VALUES (' + placeholders + ')',
            tuple(values.values()),
        )

    def rejected(self, label, operation, expected="FOREIGN KEY"):
        self.db.execute("SAVEPOINT rejected_case")
        try:
            operation()
            # RELEASE also checks initially-deferred constraints at this boundary.
            self.db.execute("RELEASE rejected_case")
        except sqlite3.IntegrityError as error:
            self.db.execute("ROLLBACK TO rejected_case")
            self.db.execute("RELEASE rejected_case")
            require(expected in str(error), label + ": unexpected rejection: " + str(error))
            self.rejections += 1
        except Exception:
            self.db.execute("ROLLBACK TO rejected_case")
            self.db.execute("RELEASE rejected_case")
            raise
        else:
            raise AssertionError(label + ": invalid write was accepted")

    def object(self, p, name, kind, number, edition=True):
        self.insert("objects", id=name, project_id=p, edition_id="edition-" + p if edition else None,
                    kind=kind, display_no=number)

    def version(self, p, obj, kind, vid, number=1, actor=None, run=None, tx=None):
        self.insert("object_versions", id=vid, project_id=p, object_id=obj, kind=kind,
                    version_no=number, actor_id=actor or "human-" + p,
                    created_in_round_id="round-" + p, run_id=run,
                    tx_id=tx or "tx-" + p, content_hash=HASH)

    def current(self, obj, vid, rev=0):
        self.db.execute("UPDATE objects SET current_version_id=?, rev=? WHERE id=?", (vid, rev, obj))

    def seed_project(self, p):
        human, user = "human-" + p, "user-" + p
        self.insert("users", id=user, display_name="합성 사용자 " + p)
        self.insert("actors", id=human, kind="human", user_id=user, display_name="합성 사람")
        self.insert("projects", id=p, slug="synthetic-" + p, topic="가상 정책 연구", owner_user_id=user)
        self.insert("project_members", project_id=p, user_id=user, role="owner")
        self.insert("mutation_commits", id="tx-" + p, project_id=p, actor_id=human,
                    via="import", client_request_id="bootstrap", request_hash=HASH, action="fixture.created")
        # Omit allow_opencode_go to check the confirmed ON initialization default.
        self.insert("project_policy_versions", id="policy-" + p, project_id=p, policy_rev=1,
                    changed_by=human, changed_by_user_id=user, reason="합성 초기 정책", tx_id="tx-" + p)
        self.insert("editions", id="edition-" + p, project_id=p, edition_no=1, status="active")
        for ordinal, key in enumerate(KEYS, 1):
            self.insert("stages", id="stage-" + p + "-" + key, project_id=p,
                        edition_id="edition-" + p, key=key, ordinal=ordinal)
        self.insert("rounds", id="round-" + p, project_id=p, edition_id="edition-" + p,
                    stage_id="stage-" + p + "-plan", round_no=1)
        self.db.execute("UPDATE stages SET current_round_id=?, status='active' WHERE id=?",
                        ("round-" + p, "stage-" + p + "-plan"))
        self.db.execute("UPDATE editions SET current_stage_id=? WHERE id=?",
                        ("stage-" + p + "-plan", "edition-" + p))
        self.db.execute("UPDATE projects SET active_edition_id=?, current_policy_id=?, status='active' WHERE id=?",
                        ("edition-" + p, "policy-" + p, p))
        self.insert("counters", project_id=p, namespace="question", next_no=2)

        self.object(p, "artifact-" + p, "artifact", 1)
        self.insert("artifacts", project_id=p, object_id="artifact-" + p,
                    stage_id="stage-" + p + "-plan", kind="section")
        self.version(p, "artifact-" + p, "artifact", "artifact-v1-" + p)
        self.insert("artifact_versions", project_id=p, object_id="artifact-" + p,
                    version_id="artifact-v1-" + p, title="합성 결과", body_md="합성 문장", status="done")
        self.current("artifact-" + p, "artifact-v1-" + p)
        self.insert("round_contents", project_id=p, round_id="round-" + p,
                    object_id="artifact-" + p, version_id="artifact-v1-" + p, position=0, role="result")

        self.object(p, "source-" + p, "source", 1)
        self.insert("sources", project_id=p, object_id="source-" + p, kind="web")
        self.version(p, "source-" + p, "source", "source-v1-" + p)
        self.insert("source_versions", project_id=p, object_id="source-" + p,
                    version_id="source-v1-" + p, title="가상 출처", url="https://example.invalid/source",
                    retrieved_at=1000, method="browser", verification_state="verified", quote="합성 근거")
        self.current("source-" + p, "source-v1-" + p)
        self.insert("citations", project_id=p, artifact_version_id="artifact-v1-" + p,
                    citation_no=1, source_version_id="source-v1-" + p)

        self.object(p, "question-" + p, "question", 1)
        self.insert("questions", project_id=p, object_id="question-" + p, asked_by_actor_id="ai",
                    intended_actor_id=human, direction="agent_to_human", origin="bank",
                    original_version_id="question-v1-" + p)
        self.version(p, "question-" + p, "question", "question-v1-" + p)
        self.insert("question_versions", project_id=p, object_id="question-" + p,
                    version_id="question-v1-" + p, text="첫 질문", type="single", required=1,
                    default_value='"yes"', options='[{"value":"yes","label":"예","recommended":true}]')
        self.current("question-" + p, "question-v1-" + p)
        self.insert("question_sets", id="form-" + p, project_id=p, stage_id="stage-" + p + "-plan",
                    purpose="stage_start", form_key="plan-start", version_no=1)
        self.insert("question_set_members", project_id=p, set_id="form-" + p,
                    question_id="question-" + p, question_version_id="question-v1-" + p, position=0)
        self.insert("submissions", id="submission-" + p, project_id=p, actor_id=human,
                    set_id="form-" + p, via="web", tx_id="tx-" + p)
        self.object(p, "answer-" + p, "answer", 1)
        self.insert("answers", project_id=p, object_id="answer-" + p, question_id="question-" + p,
                    respondent_actor_id=human, submission_id="submission-" + p)
        self.version(p, "answer-" + p, "answer", "answer-v1-" + p)
        self.insert("answer_versions", project_id=p, object_id="answer-" + p,
                    version_id="answer-v1-" + p, question_id="question-" + p,
                    question_version_id="question-v1-" + p, value='"yes"', used_default=1)
        self.current("answer-" + p, "answer-v1-" + p)

        is_a = p == "p1"
        self.insert("runs", id="run-" + p, project_id=p, edition_id="edition-" + p,
                    stage_id="stage-" + p + "-plan", round_id="round-" + p, actor_id="ai" if is_a else "code",
                    mode="A" if is_a else "B", runtime="opencode" if is_a else "claude_code",
                    provider="opencode-go" if is_a else "anthropic",
                    model="opencode-go/deepseek-v4.1-flash" if is_a else "unknown",
                    status="running", base_control_rev=0)
        self.insert("project_leases", project_id=p, lease_id="lease-" + p, run_id="run-" + p,
                    owner_actor_id="ai" if is_a else "code", fence=1,
                    acquired_at=1000, heartbeat_at=2000, expires_at=10000)
        self.insert("run_targets", project_id=p, run_id="run-" + p, object_id="artifact-" + p,
                    base_version_id="artifact-v1-" + p, base_rev=0)
        self.insert("run_input_receipts", project_id=p, run_id="run-" + p,
                    input_version_id="answer-v1-" + p, state="seen")
        self.insert("events", id="event-" + p, project_id=p, run_id="run-" + p, tx_id="tx-" + p,
                    tx_index=0, tx_size=1, type="fixture.created", object_id="artifact-" + p,
                    after_version_id="artifact-v1-" + p)
        seq = self.scalar("SELECT event_seq FROM events WHERE id=?", ("event-" + p,))
        self.insert("blobs", id="blob-" + p, project_id=p, storage_key="synthetic/" + p + "/manifest",
                    sha256=("b" if is_a else "c") * 64, size=20, media_type="application/json", state="ready",
                    created_by=human)
        self.insert("snapshots", id="snapshot-" + p, project_id=p, edition_id="edition-" + p,
                    stage_id="stage-" + p + "-plan", round_id="round-" + p, scope="round",
                    manifest_blob_id="blob-" + p, through_event_seq=seq, control_rev=0, content_hash=HASH)

    def seed_details(self):
        p = "p1"
        self.insert("editions", id="draft-p1", project_id=p, edition_no=3, status="draft")
        self.object(p, "source-twin", "source", 2)
        self.insert("sources", project_id=p, object_id="source-twin", kind="web")
        self.version(p, "source-twin", "source", "source-twin-v1")
        self.insert("source_versions", project_id=p, object_id="source-twin", version_id="source-twin-v1",
                    title="같은 URL의 다른 자료", url="https://example.invalid/source",
                    method="fetch", verification_state="unverified")
        self.current("source-twin", "source-twin-v1")
        self.insert("agent_tokens", id="synthetic-token", project_id=p, actor_id="ai",
                    scopes='["context.read","result.submit"]', token_hash="d" * 64)
        self.insert("approvals", id="legacy-approval", project_id=p, stage_id="stage-p1-plan",
                    snapshot_id="snapshot-p1", actor_id="legacy", actor_kind="legacy_unknown",
                    origin="legacy", assurance="legacy_unverified", tx_id="tx-p1")
        self.insert("approvals", id="human-approval", project_id=p, stage_id="stage-p1-plan",
                    snapshot_id="snapshot-p1", actor_id="human-p1", actor_kind="human", human_user_id="user-p1",
                    origin="new", assurance="verified", tx_id="tx-p1")

        self.version(p, "artifact-p1", "artifact", "artifact-v2-p1", 2, actor="ai", run="run-p1")
        self.insert("artifact_versions", project_id=p, object_id="artifact-p1", version_id="artifact-v2-p1",
                    title="수정 결과", body_md="합성 문장 / 합성 문장", status="done")
        self.current("artifact-p1", "artifact-v2-p1", 1)
        self.insert("version_relations", project_id=p, from_version_id="artifact-v2-p1",
                    to_version_id="artifact-v1-p1", kind="supersedes")

        self.version(p, "question-p1", "question", "question-v2-p1", 2)
        self.insert("question_versions", project_id=p, object_id="question-p1", version_id="question-v2-p1",
                    text="수정 질문", type="single", required=1, default_value='"no"',
                    options='[{"value":"no","label":"아니오"}]')
        self.current("question-p1", "question-v2-p1", 1)
        self.insert("question_sets", id="form-p1-v2", project_id=p, stage_id="stage-p1-plan",
                    purpose="stage_start", form_key="plan-start", version_no=2, previous_set_id="form-p1")
        self.insert("question_set_members", project_id=p, set_id="form-p1-v2", question_id="question-p1",
                    question_version_id="question-v2-p1", position=0)

        for number, target, target_version, context in (
            (1, "question-p1", "question-v1-p1", "question_comment"),
            (2, "artifact-p1", "artifact-v1-p1", "annotation"),
        ):
            tid, mid = "thread-" + str(number), "message-" + str(number)
            anchor = None
            if context == "annotation":
                anchor = "anchor-1"
                self.insert("anchors", id=anchor, project_id=p, target_object_id=target,
                            target_version_id=target_version, exact_quote="합성", prefix="", suffix=" 문장",
                            start_cp=0, end_cp=2)
            self.object(p, tid, "thread", number)
            self.insert("threads", project_id=p, object_id=tid, target_object_id=target,
                        target_version_id=target_version, context_kind=context, anchor_id=anchor)
            self.version(p, tid, "thread", tid + "-v1")
            self.insert("thread_versions", project_id=p, object_id=tid, version_id=tid + "-v1")
            self.current(tid, tid + "-v1")
            self.object(p, mid, "message", number)
            self.insert("messages", project_id=p, object_id=mid, thread_id=tid, submission_id="submission-p1")
            self.version(p, mid, "message", mid + "-v1")
            self.insert("message_versions", project_id=p, object_id=mid, version_id=mid + "-v1",
                        thread_id=tid, body_md="합성 덧붙임" if number == 1 else "합성 수정 제안")
            self.current(mid, mid + "-v1")

        self.insert("anchor_resolutions", id="anchor-exact", project_id=p, anchor_id="anchor-1",
                    target_object_id="artifact-p1", evaluated_version_id="artifact-v1-p1", status="exact",
                    start_cp=0, end_cp=2, method="synthetic")
        self.insert("anchor_resolutions", id="anchor-ambiguous", project_id=p, anchor_id="anchor-1",
                    target_object_id="artifact-p1", evaluated_version_id="artifact-v2-p1", status="ambiguous",
                    method="synthetic")
        self.version(p, "thread-2", "thread", "thread-2-v2", 2)
        self.insert("thread_versions", project_id=p, object_id="thread-2", version_id="thread-2-v2",
                    state="resolved", resolved_by_message_version_id="message-2-v1", summary="합성 결론")
        self.current("thread-2", "thread-2-v2", 1)

        self.object(p, "assumption-1", "assumption", 1)
        self.insert("assumptions", project_id=p, object_id="assumption-1", proposed_by_actor_id="ai")
        self.version(p, "assumption-1", "assumption", "assumption-v1")
        self.insert("assumption_versions", project_id=p, object_id="assumption-1", version_id="assumption-v1",
                    statement="합성 가정", state="proposed", needs_review=1)
        self.current("assumption-1", "assumption-v1")
        self.object(p, "decision-1", "decision", 1, edition=False)
        self.insert("decisions", project_id=p, object_id="decision-1", scope="project")
        self.version(p, "decision-1", "decision", "decision-v1")
        self.insert("decision_versions", project_id=p, object_id="decision-1", version_id="decision-v1",
                    statement="합성 결정", state="adopted", decided_by="human-p1")
        self.current("decision-1", "decision-v1")

        self.object(p, "report-1", "artifact", 2)
        self.insert("artifacts", project_id=p, object_id="report-1", kind="report")
        self.version(p, "report-1", "artifact", "report-v1")
        self.insert("artifact_versions", project_id=p, object_id="report-1", version_id="report-v1",
                    title="합성 보고서", body_blob_id="blob-p1", status="published")
        self.current("report-1", "report-v1")
        self.insert("artifact_components", project_id=p, parent_version_id="report-v1", position=0,
                    child_version_id="artifact-v1-p1")
        self.insert("version_files", project_id=p, version_id="report-v1", blob_id="blob-p1", role="rendered")

        self.object(p, "followup-1", "followup", 1)
        self.insert("followups", project_id=p, object_id="followup-1", origin_thread_id="thread-2",
                    origin_message_version_id="message-2-v1")
        self.version(p, "followup-1", "followup", "followup-v1")
        self.insert("followup_versions", project_id=p, object_id="followup-1", version_id="followup-v1",
                    kind="edit_text", state="applied", description="합성 수정",
                    base_artifact_version_id="artifact-v1-p1", proposed_artifact_version_id="artifact-v2-p1",
                    result_version_id="artifact-v2-p1", confirmed_by_actor_id="human-p1", applied_tx_id="tx-p1")
        self.current("followup-1", "followup-v1")
        self.insert("reflection_entries", id="reflection-1", project_id=p, source_version_id="answer-v1-p1",
                    target_round_id="round-p1", disposition="applied", rationale="합성 반영",
                    result_version_id="artifact-v2-p1", followup_id="followup-1", applied_tx_id="tx-p1",
                    actor_id="human-p1", tx_id="tx-p1")
        self.insert("outbound_dispatches", id="dispatch-1", project_id=p, run_id="run-p1", provider="opencode-go",
                    policy_version_id="policy-p1", manifest_blob_id="blob-p1", payload_hash=HASH,
                    state="prepared", request_key="synthetic-dispatch")
        self.insert("import_batches", id="import-1", project_id=p, source_fingerprint="synthetic-source-v1",
                    source_schema="synthetic-legacy", importer_version="draft-1",
                    source_manifest_blob_id="blob-p1", state="validated")
        self.insert("legacy_mappings", project_id=p, import_batch_id="import-1", legacy_kind="item",
                    legacy_scope="plan:R1", legacy_key="1", content_hash=HASH,
                    new_object_id="artifact-p1", new_version_id="artifact-v1-p1")
        self.insert("db_meta", id=1, schema_version=1, database_instance_id="synthetic-memory-db", cursor_epoch=1)

    def seed(self):
        self.db.execute("BEGIN")
        try:
            for aid, kind, runtime in (("ai", "internal_ai", "opencode"),
                                       ("code", "external_agent", "claude_code"),
                                       ("browser", "browser_agent", "webmcp"),
                                       ("legacy", "legacy_unknown", None)):
                self.insert("actors", id=aid, kind=kind, runtime=runtime, display_name="합성 에이전트")
            self.seed_project("p1")
            self.seed_project("p2")
            self.seed_details()
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK")
            raise
        require(self.scalar("SELECT count(*) FROM stages") == 12, "Expected six stages per project")
        require(self.scalar("SELECT allow_opencode_go FROM project_policy_versions WHERE id='policy-p1'") == 1,
                "Go initialization must be ON")
        require(self.scalar("SELECT count(*) FROM approvals WHERE human_user_id IS NULL AND origin='legacy'") == 1,
                "Uncertain legacy approval must be representable")
        require(self.scalar("SELECT count(*) FROM source_versions WHERE project_id='p1' AND url='https://example.invalid/source'") == 2,
                "Distinct source records with the same URL must be preserved")
        require(self.scalar("SELECT count(*) FROM editions WHERE project_id='p1'") == 2,
                "Inactive editions must be allowed alongside the active edition")
        tables = [r[0] for r in self.db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
        require(all(self.scalar('SELECT count(*) FROM "' + name + '"') > 0 for name in tables),
                "Every design table must receive at least one synthetic row")
        print("PASS synthetic hierarchy: 2 projects, 12 stages, all " + str(len(tables)) + " tables populated")
        print("PASS allowed cases: inactive edition, duplicate URL sources, uncertain legacy approval, Go initialized ON")

    def negative_checks(self):
        x = self.rejected
        sql = self.db.execute
        x("missing reference", lambda: self.insert("version_files", project_id="p1", version_id="missing",
                                                  blob_id="blob-p1", role="attachment"))
        x("foreign edition parent", lambda: self.insert("editions", id="bad-edition", project_id="p1",
                                                        edition_no=9, parent_edition_id="edition-p2"))
        x("foreign active edition", lambda: sql("UPDATE projects SET active_edition_id='edition-p2' WHERE id='p1'"))
        x("foreign policy pointer", lambda: sql("UPDATE projects SET current_policy_id='policy-p2' WHERE id='p1'"))
        x("foreign stage pointer", lambda: sql("UPDATE editions SET current_stage_id='stage-p2-plan' WHERE id='edition-p1'"))
        x("foreign round pointer", lambda: sql("UPDATE stages SET current_round_id='round-p2' WHERE id='stage-p1-plan'"))
        x("foreign object pointer", lambda: sql("UPDATE objects SET current_version_id='artifact-v1-p2' WHERE id='artifact-p1'"))
        x("same-project wrong object version", lambda: sql("UPDATE objects SET current_version_id='source-v1-p1' WHERE id='artifact-p1'"))
        x("wrong payload subtype", lambda: self.insert("artifact_versions", project_id="p1", version_id="question-v1-p1",
                                                      object_id="question-p1", title="wrong"))
        x("foreign answer question version", lambda: sql("UPDATE answer_versions SET question_version_id='question-v1-p2' WHERE version_id='answer-v1-p1'"))
        x("foreign form question", lambda: self.insert("question_set_members", project_id="p1", set_id="form-p1",
                                                      question_id="question-p2", question_version_id="question-v1-p2", position=1))
        x("foreign citation", lambda: self.insert("citations", project_id="p1", artifact_version_id="artifact-v1-p1",
                                                 citation_no=2, source_version_id="source-v1-p2"))
        x("foreign file", lambda: self.insert("version_files", project_id="p1", version_id="artifact-v1-p1",
                                             blob_id="blob-p2", role="attachment"))
        x("foreign relation", lambda: self.insert("version_relations", project_id="p1", from_version_id="report-v1",
                                                 to_version_id="artifact-v1-p2", kind="related"))
        x("foreign anchor resolution", lambda: self.insert("anchor_resolutions", id="bad-anchor", project_id="p1",
                anchor_id="anchor-1", target_object_id="artifact-p1", evaluated_version_id="artifact-v1-p2",
                status="lost", method="synthetic"))
        x("reply in another thread", lambda: sql("UPDATE messages SET reply_to='message-1' WHERE object_id='message-2'"))
        x("foreign run target", lambda: self.insert("run_targets", project_id="p1", run_id="run-p1",
                                                    object_id="artifact-p2", base_rev=0))
        x("foreign lease run", lambda: sql("UPDATE project_leases SET run_id='run-p2',owner_actor_id='code' WHERE project_id='p1'"))
        x("foreign event transaction", lambda: self.insert("events", id="bad-event", project_id="p1", tx_id="tx-p2",
                                                           tx_index=1, tx_size=2, type="bad"))
        x("foreign event version", lambda: self.insert("events", id="bad-event", project_id="p1", tx_id="tx-p1",
                tx_index=1, tx_size=2, type="bad", object_id="artifact-p1", after_version_id="artifact-v1-p2"))
        x("foreign dispatch policy", lambda: sql("UPDATE outbound_dispatches SET policy_version_id='policy-p2' WHERE id='dispatch-1'"))
        x("foreign submission file", lambda: sql("UPDATE submissions SET raw_blob_id='blob-p2' WHERE id='submission-p1'"))
        x("foreign legacy target", lambda: sql("UPDATE legacy_mappings SET new_object_id='artifact-p2',new_version_id='artifact-v1-p2'"))
        x("ownerless project", lambda: self.insert("projects", id="ownerless", slug="synthetic-ownerless",
                                                  topic="합성", owner_user_id="user-p1"))
        x("duplicate display number", lambda: self.object("p1", "duplicate-object", "question", 1), "UNIQUE")
        x("duplicate version number", lambda: self.version("p1", "artifact-p1", "artifact", "duplicate-v", 1), "UNIQUE")
        x("duplicate idempotency key", lambda: self.insert("mutation_commits", id="duplicate-tx", project_id="p1",
                actor_id="human-p1", via="web", client_request_id="bootstrap", request_hash="f" * 64, action="bad"), "UNIQUE")
        x("duplicate event position", lambda: self.insert("events", id="duplicate-event", project_id="p1",
                                                         tx_id="tx-p1", tx_index=0, tx_size=1, type="bad"), "UNIQUE")
        x("two active editions", lambda: self.insert("editions", id="second-active", project_id="p1",
                                                       edition_no=2, status="active"), "UNIQUE")
        x("activate another existing edition", lambda: sql("UPDATE editions SET status='active' WHERE id='draft-p1'"), "UNIQUE")
        x("two open rounds", lambda: self.insert("rounds", id="second-open", project_id="p1", edition_id="edition-p1",
                                                   stage_id="stage-p1-plan", round_no=2), "UNIQUE")
        x("wrong stage ordinal", lambda: sql("UPDATE stages SET ordinal=7 WHERE id='stage-p1-plan'"), "CHECK")
        x("negative revision", lambda: sql("UPDATE objects SET rev=-1 WHERE id='artifact-p1'"), "CHECK")
        x("invalid policy boolean", lambda: sql("UPDATE project_policy_versions SET allow_opencode_go=2 WHERE id='policy-p1'"), "CHECK")
        x("invalid JSON", lambda: sql("UPDATE artifact_versions SET stats='not-json' WHERE version_id='artifact-v1-p1'"), "CHECK")
        x("invalid question options shape", lambda: sql("UPDATE question_versions SET options='{}' WHERE version_id='question-v1-p1'"), "CHECK")
        x("malformed question options JSON", lambda: sql("UPDATE question_versions SET options='{' WHERE version_id='question-v1-p1'"), "CHECK")
        x("malformed token scopes JSON", lambda: sql("UPDATE agent_tokens SET scopes='{' WHERE id='synthetic-token'"), "CHECK")
        x("A must retain chosen model", lambda: sql("UPDATE runs SET model='another-model' WHERE id='run-p1'"), "CHECK")
        x("agent cannot impersonate human approval", lambda: self.insert("approvals", id="bad-approval", project_id="p1",
                stage_id="stage-p1-plan", snapshot_id="snapshot-p1", actor_id="ai", actor_kind="human",
                human_user_id="user-p1", origin="new", assurance="verified", tx_id="tx-p1"))
        x("agent cannot reallow Go", lambda: self.insert("project_policy_versions", id="bad-policy", project_id="p1",
                policy_rev=2, changed_by="ai", changed_by_user_id="user-p1", reason="bad", tx_id="tx-p1"))
        x("other owner cannot change this policy", lambda: self.insert("project_policy_versions", id="other-policy", project_id="p1",
                policy_rev=2, changed_by="human-p2", changed_by_user_id="user-p2", reason="bad", tx_id="tx-p1"))
        x("anonymous new approval", lambda: self.insert("approvals", id="anonymous-approval", project_id="p1",
                stage_id="stage-p1-plan", snapshot_id="snapshot-p1", actor_id="legacy", actor_kind="legacy_unknown",
                origin="new", assurance="verified", tx_id="tx-p1"), "CHECK")
        x("applied receipt needs transaction", lambda: sql("UPDATE run_input_receipts SET state='applied' WHERE run_id='run-p1'"), "CHECK")
        x("applied reflection needs evidence", lambda: self.insert("reflection_entries", id="bad-reflection", project_id="p1",
                source_version_id="answer-v1-p1", target_round_id="round-p1", disposition="applied", rationale="bad",
                actor_id="human-p1", tx_id="tx-p1"), "CHECK")
        x("approval requires snapshot", lambda: sql("UPDATE stages SET status='approved' WHERE id='stage-p1-research'"), "CHECK")
        x("referenced file delete", lambda: sql("DELETE FROM blobs WHERE id='blob-p1'"))
        x("duplicate import", lambda: self.insert("import_batches", id="duplicate-import", project_id="p1",
                source_fingerprint="synthetic-source-v1", source_schema="synthetic", importer_version="draft",
                source_manifest_blob_id="blob-p1", state="staging"), "UNIQUE")
        print("PASS constraints: " + str(self.rejections) + " invalid/reference/cross-project/duplicate writes rejected")
        print("PASS partial UNIQUE: second active edition and second open round rejected")

    def queries(self):
        hierarchy = self.db.execute("""
            SELECT p.id, count(DISTINCT s.id), count(DISTINCT r.id)
            FROM projects p JOIN editions e ON e.id=p.active_edition_id AND e.project_id=p.id
            JOIN stages s ON s.edition_id=e.id AND s.project_id=p.id
            LEFT JOIN rounds r ON r.stage_id=s.id AND r.project_id=p.id
            GROUP BY p.id ORDER BY p.id
        """).fetchall()
        require(hierarchy == [("p1", 6, 1), ("p2", 6, 1)], "Hierarchy query mismatch")
        answers = self.db.execute("""
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
        """, ("p1",)).fetchall()
        require(answers == [("첫 질문", "수정 질문", '"yes"', "합성 덧붙임")], "Historical answer/comment query mismatch")
        changes_sql = "SELECT event_seq,type FROM events WHERE project_id=? AND event_seq>? ORDER BY event_seq LIMIT 10"
        changes = self.db.execute(changes_sql, ("p1", 0)).fetchall()
        require(len(changes) == 1 and changes[0][1] == "fixture.created", "Project cursor leaked or lost events")
        plan = self.db.execute("EXPLAIN QUERY PLAN " + changes_sql, ("p1", 0)).fetchall()
        require(any("SEARCH" in row[3] and "project_id" in row[3] for row in plan), "Change query did not use scoped search")
        self.positive_checks += 3
        print("PASS representative queries: hierarchy, historical answer + comment, scoped change cursor (indexed)")

    def state_signature(self):
        return (
            self.scalar("SELECT count(*) FROM mutation_commits"),
            self.scalar("SELECT count(*) FROM object_versions"),
            self.scalar("SELECT count(*) FROM artifact_versions"),
            self.scalar("SELECT count(*) FROM events"),
            self.db.execute("SELECT current_version_id,rev FROM objects WHERE id='artifact-p1'").fetchone(),
        )

    def candidate_change(self, tx, vid, expected_rev):
        self.insert("mutation_commits", id=tx, project_id="p1", actor_id="ai", run_id="run-p1", via="http",
                    client_request_id=tx, request_hash=HASH, action="result.submit", lease_id="lease-p1", fence=1)
        self.version("p1", "artifact-p1", "artifact", vid, 3, actor="ai", run="run-p1", tx=tx)
        self.insert("artifact_versions", project_id="p1", object_id="artifact-p1", version_id=vid,
                    title="합성 커밋 후보", body_md="새 합성 본문", status="done")
        self.insert("events", id="event-" + tx, project_id="p1", run_id="run-p1", tx_id=tx,
                    tx_index=0, tx_size=1, type="result.submitted", object_id="artifact-p1", after_version_id=vid)
        return self.db.execute("""
            UPDATE objects SET current_version_id=?, rev=rev+1
            WHERE project_id='p1' AND id='artifact-p1' AND rev=?
        """, (vid, expected_rev)).rowcount

    def atomic_checks(self):
        before = self.state_signature()
        rev = before[-1][1]
        class RevisionConflict(Exception):
            pass
        self.db.execute("BEGIN")
        try:
            changed = self.candidate_change("tx-stale", "v-stale", rev - 1)
            if changed != 1:
                require(changed == 0, "Expected an actual zero-row UPDATE")
                raise RevisionConflict("conditional UPDATE changed zero rows")
            self.db.execute("COMMIT")
        except RevisionConflict:
            self.db.execute("ROLLBACK")
        else:
            raise AssertionError("Stale revision unexpectedly committed")
        require(self.state_signature() == before, "Zero-row CAS left partial writes")
        print("PASS zero-row CAS: explicit failure; version, payload, pointer, event, receipt all rolled back")

        self.db.execute("BEGIN")
        try:
            require(self.candidate_change("tx-late-failure", "v-late-failure", rev) == 1, "Valid CAS failed")
            self.db.execute("UPDATE mutation_commits SET guard_ok=0 WHERE id='tx-late-failure'")
            self.db.execute("COMMIT")
        except sqlite3.IntegrityError as error:
            require("CHECK" in str(error), "Expected guard CHECK failure")
            self.db.execute("ROLLBACK")
        else:
            raise AssertionError("Guard failure was not raised")
        require(self.state_signature() == before, "Late SQL failure left a changed pointer or rows")
        print("PASS late SQL failure: successful CAS and all other writes rolled back")

        self.db.execute("BEGIN")
        try:
            require(self.candidate_change("tx-success", "v-success", rev) == 1, "Current revision CAS failed")
            self.db.execute("UPDATE mutation_commits SET result_json=? WHERE id='tx-success'",
                            ('{"version_id":"v-success"}',))
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK")
            raise
        require(self.db.execute("SELECT current_version_id,rev FROM objects WHERE id='artifact-p1'").fetchone()
                == ("v-success", rev + 1), "Successful change was not published")
        require(self.state_signature()[:4] == tuple(n + 1 for n in before[:4]),
                "Successful command did not commit all four related records")
        require(self.scalar("SELECT body_md FROM artifact_versions WHERE version_id='artifact-v1-p1'") == "합성 문장",
                "Old content was overwritten")
        print("PASS successful command: new version + pointer + event + idempotency receipt committed; old version retained")

        # SQL-level D1-style guard experiment; execution here is SQLite only.
        guard_sql = """
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
        """
        self.db.execute("UPDATE project_leases SET fence=2,lease_id='lease-p1-next' WHERE project_id='p1'")
        self.rejected("stale fence SQL guard", lambda: self.db.execute(guard_sql, ("guard-old", "guard-old", HASH, 1)), "CHECK")
        self.db.execute("BEGIN")
        try:
            self.insert("project_policy_versions", id="policy-off", project_id="p1", policy_rev=2,
                        allow_opencode_go=0, changed_by="human-p1", changed_by_user_id="user-p1",
                        reason="합성 차단 시험", tx_id="tx-p1")
            self.db.execute("UPDATE projects SET current_policy_id='policy-off',control_rev=control_rev+1 WHERE id='p1'")
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK")
            raise
        self.rejected("Go OFF SQL guard with fresh fence", lambda: self.db.execute(guard_sql, ("guard-off", "guard-off", HASH, 2)), "CHECK")
        print("PASS SQL guard examples: stale fence and synthetic Go OFF rejected (SQLite only)")

    def run(self):
        sql_path = __file__.replace("\\", "/").rsplit("/", 1)[0] + "/stage-1-ddl-draft.sql"
        with open(sql_path, encoding="utf-8") as source:
            self.db.executescript(source.read())
        require(self.scalar("SELECT count(*) FROM sqlite_master WHERE type='trigger'") == 0, "Triggers forbidden")
        require(self.scalar("SELECT count(*) FROM sqlite_master WHERE sql LIKE 'CREATE VIRTUAL TABLE%'") == 0,
                "Virtual/FTS tables forbidden")
        require(self.db.execute("PRAGMA database_list").fetchall() == [(0, "main", "")],
                "Only the in-memory main database may be connected")
        print("SQLite " + sqlite3.sqlite_version + "; foreign_keys=ON; database=:memory:")
        print("PASS DDL execution; no triggers or external databases")
        self.seed()
        self.negative_checks()
        self.queries()
        self.atomic_checks()
        require(self.db.execute("PRAGMA foreign_key_check").fetchall() == [], "Dangling foreign keys")
        require(self.scalar("PRAGMA integrity_check") == "ok", "SQLite integrity check failed")
        print("PASS foreign_key_check and integrity_check")
        print("RESULT PASS; rejected cases=" + str(self.rejections) + "; representative queries=" + str(self.positive_checks))
        print("D1 NOT TESTED: batch/guard, deferred FKs, partial indexes, JSON functions, migrations, runtime limits")


if __name__ == "__main__":
    checks = Checks()
    try:
        checks.run()
    finally:
        checks.db.close()
