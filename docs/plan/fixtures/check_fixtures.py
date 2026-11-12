#!/usr/bin/env python3
"""PES API v1 계약 예제 검사기.

표준 라이브러리만 사용한다. docs/plan/fixtures/api-v1/*.json 을 읽어
문법·봉투·오류·번호 문자열·6절 경로/이름을 검사한다.
코드나 계획서를 수정하지 않는다.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIXTURES = HERE / "api-v1"
API_DOC = HERE.parent / "stage-1-api.md"

FORMAT_VERSION = "1.0"
DECIMAL_KEYS = {"rev", "control_rev", "fence", "event_seq", "receipt_no"}
CODE_RE = re.compile(r"^[a-z][a-z0-9_]*$")
DECIMAL_RE = re.compile(r"^[0-9]+$")
HANGUL_RE = re.compile(r"[가-힣]")

# 6절 표를 계약 예제의 기준으로 옮긴 목록.
# doc_fragments는 stage-1-api.md 6절 본문에 실제로 있어야 하는 문자열이다.
# inferred=True는 6절에 경로가 약칭(…)으로만 있어 예제에서 경로를 정한 경우다.
SPECS = [
    {
        "file": "capabilities.json",
        "operation": "capabilities.get",
        "method": "GET",
        "path": "/api/v1/capabilities",
        "doc_fragments": ["GET /api/v1/capabilities"],
    },
    {
        "file": "context.json",
        "operation": "context.get",
        "method": "GET",
        "path": "/api/v1/projects/{project_id}/context",
        "doc_fragments": ["GET P/context"],
    },
    {
        "file": "versions.json",
        "operation": "object.version.get",
        "method": "GET",
        "path": "/api/v1/projects/{project_id}/objects/{object_id}/versions/{version_id}",
        "doc_fragments": ["GET P/objects/{o}/versions/{v}"],
    },
    {
        "file": "runs.json",
        "operation": "runs.create",
        "method": "POST",
        "path": "/api/v1/projects/{project_id}/runs",
        "doc_fragments": ["POST P/runs"],
    },
    {
        "file": "claims.json",
        "operation": "runs.claim",
        "method": "POST",
        "path": "/api/v1/projects/{project_id}/claims",
        "doc_fragments": ["POST P/claims"],
    },
    {
        "file": "heartbeat.json",
        "operation": "runs.heartbeat",
        "method": "POST",
        "path": "/api/v1/projects/{project_id}/runs/{run_id}/heartbeat",
        "doc_fragments": ["P/runs/{r}/heartbeat"],
    },
    {
        "file": "wait.json",
        "operation": "runs.wait",
        "method": "POST",
        "path": "/api/v1/projects/{project_id}/runs/{run_id}/wait",
        "doc_fragments": ["/wait"],
    },
    {
        "file": "complete.json",
        "operation": "runs.complete",
        "method": "POST",
        "path": "/api/v1/projects/{project_id}/runs/{run_id}/complete",
        "doc_fragments": ["/complete"],
    },
    {
        "file": "interrupt.json",
        "operation": "runs.interrupt",
        "method": "POST",
        "path": "/api/v1/projects/{project_id}/runs/{run_id}/interrupt",
        "doc_fragments": ["POST P/runs/{r}/interrupt"],
    },
    {
        "file": "cancel.json",
        "operation": "runs.cancel",
        "method": "POST",
        "path": "/api/v1/projects/{project_id}/runs/{run_id}/cancel",
        "doc_fragments": ["/cancel"],
    },
    {
        "file": "handoffs.json",
        "operation": "runs.handoff",
        "method": "POST",
        "path": "/api/v1/projects/{project_id}/runs/{run_id}/handoffs",
        "doc_fragments": ["POST P/runs/{r}/handoffs"],
    },
    {
        "file": "results.json",
        "operation": "results.submit",
        "method": "POST",
        "path": "/api/v1/projects/{project_id}/runs/{run_id}/results",
        "doc_fragments": ["POST P/runs/{r}/results"],
    },
    {
        "file": "questions.json",
        "operation": "questions.create",
        "method": "POST",
        "path": "/api/v1/projects/{project_id}/questions",
        "doc_fragments": ["POST P/questions"],
    },
    {
        "file": "question-revisions.json",
        "operation": "questions.revise",
        "method": "POST",
        "path": "/api/v1/projects/{project_id}/questions/{question_id}/revisions",
        "doc_fragments": ["P/questions/{q}/revisions"],
    },
    {
        "file": "question-withdraw.json",
        "operation": "questions.withdraw",
        "method": "POST",
        "path": "/api/v1/projects/{project_id}/questions/{question_id}/withdraw",
        "doc_fragments": ["P/questions/{q}/withdraw"],
    },
    {
        "file": "question-defer.json",
        "operation": "questions.defer",
        "method": "POST",
        "path": "/api/v1/projects/{project_id}/questions/{question_id}/defer",
        "doc_fragments": ["P/questions/{q}/defer"],
    },
    {
        "file": "question-merge.json",
        "operation": "questions.merge",
        "method": "POST",
        "path": "/api/v1/projects/{project_id}/questions/{question_id}/merge",
        "doc_fragments": ["P/questions/{q}/merge"],
    },
    {
        "file": "question-set-order.json",
        "operation": "question_sets.order",
        "method": "POST",
        "path": "/api/v1/projects/{project_id}/question-sets/{set}/order",
        "doc_fragments": ["POST P/question-sets/{set}/order"],
    },
    {
        "file": "submissions.json",
        "operation": "submissions.create",
        "method": "POST",
        "path": "/api/v1/projects/{project_id}/submissions",
        "doc_fragments": ["POST P/submissions"],
    },
    {
        "file": "inputs.json",
        "operation": "runs.inputs",
        "method": "GET",
        "path": "/api/v1/projects/{project_id}/runs/{run_id}/inputs",
        "doc_fragments": ["GET P/runs/{r}/inputs?cursor=&wait_ms="],
    },
    {
        "file": "input-receipts.json",
        "operation": "runs.input_receipts",
        "method": "POST",
        "path": "/api/v1/projects/{project_id}/runs/{run_id}/input-receipts",
        "doc_fragments": ["POST P/runs/{r}/input-receipts"],
    },
    {
        "file": "changes.json",
        "operation": "changes.list",
        "method": "GET",
        "path": "/api/v1/projects/{project_id}/changes",
        "doc_fragments": ["GET P/changes?cursor="],
    },
    {
        "file": "uploads.json",
        "operation": "uploads.create",
        "method": "POST",
        "path": "/api/v1/projects/{project_id}/uploads",
        "doc_fragments": ["POST P/uploads"],
    },
    {
        "file": "uploads-put.json",
        "operation": "uploads.put",
        "method": "PUT",
        "path": "/api/v1/projects/{project_id}/uploads/{blob_id}",
        "doc_fragments": ["PUT"],
        "inferred": True,
    },
    {
        "file": "uploads-complete.json",
        "operation": "uploads.complete",
        "method": "POST",
        "path": "/api/v1/projects/{project_id}/uploads/{upload_id}/complete",
        "doc_fragments": ["POST P/uploads/{u}/complete"],
    },
    {
        "file": "files-content.json",
        "operation": "files.content",
        "method": "GET",
        "path": "/api/v1/projects/{project_id}/files/{blob_id}/content",
        "doc_fragments": ["GET P/files/{b}/content"],
    },
    {
        "file": "threads.json",
        "operation": "threads.create",
        "method": "POST",
        "path": "/api/v1/projects/{project_id}/threads",
        "doc_fragments": ["POST P/threads"],
    },
    {
        "file": "thread-messages.json",
        "operation": "threads.messages.create",
        "method": "POST",
        "path": "/api/v1/projects/{project_id}/threads/{thread_id}/messages",
        "doc_fragments": ["P/threads/{t}/messages"],
    },
    {
        "file": "thread-resolutions.json",
        "operation": "threads.resolutions.create",
        "method": "POST",
        "path": "/api/v1/projects/{project_id}/threads/{thread_id}/resolutions",
        "doc_fragments": ["POST P/threads/{t}/resolutions"],
    },
    {
        "file": "followup-apply.json",
        "operation": "followups.apply",
        "method": "POST",
        "path": "/api/v1/projects/{project_id}/followups/{followup_id}/apply",
        "doc_fragments": ["P/followups/{f}/apply"],
    },
    {
        "file": "assumptions.json",
        "operation": "assumptions.create",
        "method": "POST",
        "path": "/api/v1/projects/{project_id}/assumptions",
        "doc_fragments": ["POST P/assumptions"],
    },
    {
        "file": "decisions.json",
        "operation": "decisions.create",
        "method": "POST",
        "path": "/api/v1/projects/{project_id}/decisions",
        "doc_fragments": ["/decisions"],
    },
    {
        "file": "reflections.json",
        "operation": "reflections.create",
        "method": "POST",
        "path": "/api/v1/projects/{project_id}/reflections",
        "doc_fragments": ["/reflections"],
    },
    {
        "file": "rounds.json",
        "operation": "rounds.create",
        "method": "POST",
        "path": "/api/v1/projects/{project_id}/stages/{stage_id}/rounds",
        "doc_fragments": ["POST P/stages/{s}/rounds"],
    },
    {
        "file": "round-seal.json",
        "operation": "rounds.seal",
        "method": "POST",
        "path": "/api/v1/projects/{project_id}/rounds/{round_id}/seal",
        "doc_fragments": ["P/rounds/{r}/seal"],
    },
    {
        "file": "stage-approve.json",
        "operation": "stages.approve",
        "method": "POST",
        "path": "/api/v1/projects/{project_id}/stages/{stage_id}/approve",
        "doc_fragments": ["POST P/stages/{s}/approve"],
    },
    {
        "file": "stage-reopen.json",
        "operation": "stages.reopen",
        "method": "POST",
        "path": "/api/v1/projects/{project_id}/stages/{stage_id}/reopen",
        "doc_fragments": ["/reopen"],
    },
    {
        "file": "editions.json",
        "operation": "editions.create",
        "method": "POST",
        "path": "/api/v1/projects/{project_id}/editions",
        "doc_fragments": ["P/editions"],
    },
    {
        "file": "policy-revisions.json",
        "operation": "policies.opencode_go.revise",
        "method": "POST",
        "path": "/api/v1/projects/{project_id}/policies/opencode-go/revisions",
        "doc_fragments": ["P/policies/opencode-go/revisions"],
    },
    {
        "file": "agent-tokens.json",
        "operation": "agent_tokens.create",
        "method": "POST",
        "path": "/api/v1/projects/{project_id}/agent-tokens",
        "doc_fragments": ["P/agent-tokens"],
    },
    {
        "file": "project-deletion.json",
        "operation": "projects.delete",
        "method": "DELETE",
        "path": "/api/v1/projects/{project_id}",
        "doc_fragments": ["삭제"],
        "inferred": True,
    },
    {
        "file": "exports.json",
        "operation": "exports.create",
        "method": "POST",
        "path": "/api/v1/projects/{project_id}/exports",
        "doc_fragments": ["POST P/exports"],
    },
]


def doc_section_6() -> str:
    if not API_DOC.exists():
        raise SystemExit(f"stage-1-api.md를 찾을 수 없습니다: {API_DOC}")
    text = API_DOC.read_text(encoding="utf-8")
    start = text.find("## 6.")
    end = text.find("## 7.", start + 1)
    if start < 0 or end < 0:
        raise SystemExit("stage-1-api.md에서 6절 범위를 찾을 수 없습니다.")
    return text[start:end]


def walk_decimal(node, path, errors):
    if isinstance(node, dict):
        for key, value in node.items():
            child = f"{path}.{key}" if path else key
            if key in DECIMAL_KEYS:
                if not isinstance(value, str):
                    errors.append(f"{child}: 10진 문자열이어야 하는데 {type(value).__name__}이다")
                elif not DECIMAL_RE.fullmatch(value):
                    errors.append(f"{child}: 10진 문자열이 아니다: {value!r}")
            walk_decimal(value, child, errors)
    elif isinstance(node, list):
        for index, value in enumerate(node):
            walk_decimal(value, f"{path}[{index}]", errors)


def check_success_body(body, label, errors):
    if not isinstance(body, dict):
        errors.append(f"{label}: 성공 응답 body가 객체가 아니다")
        return
    if body.get("format_version") != FORMAT_VERSION:
        errors.append(f"{label}: format_version이 {FORMAT_VERSION!r}이 아니다")
    if not isinstance(body.get("data"), dict):
        errors.append(f"{label}: data 객체가 없다")
    request_id = body.get("request_id")
    if not isinstance(request_id, str) or not request_id:
        errors.append(f"{label}: 최상위 request_id가 비어 있다")
    if "meta" in body:
        errors.append(f"{label}: meta는 쓰지 않는다(request_id는 최상위)")


def check_error_body(body, label, errors):
    if not isinstance(body, dict):
        errors.append(f"{label}: 오류 응답 body가 객체가 아니다")
        return
    if body.get("format_version") != FORMAT_VERSION:
        errors.append(f"{label}: format_version이 {FORMAT_VERSION!r}이 아니다")
    error = body.get("error")
    if not isinstance(error, dict):
        errors.append(f"{label}: error 객체가 없다")
        return
    code = error.get("code")
    if not isinstance(code, str) or not CODE_RE.fullmatch(code):
        errors.append(f"{label}: error.code가 영어 snake_case가 아니다: {code!r}")
    message = error.get("message")
    if not isinstance(message, str) or not HANGUL_RE.search(message):
        errors.append(f"{label}: error.message에 한국어가 없다: {message!r}")
    if not isinstance(error.get("retryable"), bool):
        errors.append(f"{label}: error.retryable이 bool이 아니다")
    target = error.get("target")
    # target and details are always present; null means "no single field" / "nothing machine-readable".
    if "target" not in error or (target is not None and (not isinstance(target, str) or not target.startswith("$"))):
        errors.append(f"{label}: error.target이 JSON 경로나 null이 아니다: {target!r}")
    if "details" not in error or (error["details"] is not None and not isinstance(error["details"], dict)):
        errors.append(f"{label}: error.details가 객체나 null이 아니다")
    if not (isinstance(body.get("request_id"), str) or isinstance(body.get("meta"), dict)):
        errors.append(f"{label}: request_id(또는 meta.request_id)가 없다")


def check_fixture(spec, errors):
    path = FIXTURES / spec["file"]
    if not path.exists():
        errors.append(f"{spec['file']}: 파일이 없다")
        return
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        errors.append(f"{spec['file']}: JSON 문법 오류: {exc}")
        return

    optional_error = spec["operation"] == "capabilities.get"  # 열려 있어 오류 예제가 없다
    for key in ("operation", "method", "path", "auth", "normal", "error"):
        if key == "error" and optional_error:
            continue
        if key not in data:
            errors.append(f"{spec['file']}: {key}가 없다")
    if data.get("operation") != spec["operation"]:
        errors.append(f"{spec['file']}: operation이 {spec['operation']!r}이 아니다: {data.get('operation')!r}")
    if data.get("method") != spec["method"]:
        errors.append(f"{spec['file']}: method가 {spec['method']!r}이 아니다: {data.get('method')!r}")
    if data.get("path") != spec["path"]:
        errors.append(f"{spec['file']}: path가 {spec['path']!r}이 아니다: {data.get('path')!r}")

    for case_name in ("normal", "error"):
        case = data.get(case_name)
        if case is None and case_name == "error" and optional_error:
            continue
        if not isinstance(case, dict):
            errors.append(f"{spec['file']}: {case_name} 객체가 없다")
            continue
        for part in ("request", "response"):
            if not isinstance(case.get(part), dict):
                errors.append(f"{spec['file']}: {case_name}.{part} 객체가 없다")
        response = case.get("response", {})
        if not isinstance(response.get("status"), int):
            errors.append(f"{spec['file']}: {case_name}.response.status가 정수가 아니다")
        if not isinstance(response.get("headers"), dict):
            errors.append(f"{spec['file']}: {case_name}.response.headers가 객체가 아니다")
        request = case.get("request", {})
        if not isinstance(request.get("headers"), dict):
            errors.append(f"{spec['file']}: {case_name}.request.headers가 객체가 아니다")
        request_body = request.get("body")
        if request_body is not None:
            if not isinstance(request_body, dict):
                errors.append(f"{spec['file']}: {case_name}.request.body가 객체가 아니다")
            elif request_body.get("format_version", FORMAT_VERSION) != FORMAT_VERSION:
                errors.append(f"{spec['file']}: {case_name}.request.body의 format_version이 {FORMAT_VERSION!r}이 아니다")

    normal_response = data.get("normal", {}).get("response", {})
    if "body_base64" in normal_response:
        # A raw-bytes success (files content): no JSON envelope, only the bytes.
        if not isinstance(normal_response["body_base64"], str) or "body" in normal_response:
            errors.append(f"{spec['file']} normal.response: body_base64는 문자열이고 body와 함께 두지 않는다")
    else:
        check_success_body(normal_response.get("body"), f"{spec['file']} normal.response.body", errors)
    error_body = data.get("error", {}).get("response", {}).get("body")
    if not (optional_error and "error" not in data):
        check_error_body(error_body, f"{spec['file']} error.response.body", errors)

    replay = data.get("replay")
    if replay is not None:
        if not isinstance(replay, dict):
            errors.append(f"{spec['file']}: replay가 객체가 아니다")
        else:
            check_success_body(replay.get("response", {}).get("body"),
                               f"{spec['file']} replay.response.body", errors)

    walk_decimal(data, spec["file"], errors)


def main() -> int:
    errors = []
    section6 = doc_section_6()

    expected_files = {spec["file"] for spec in SPECS}
    actual_files = {path.name for path in FIXTURES.glob("*.json")}
    for name in sorted(expected_files - actual_files):
        errors.append(f"{name}: 기대하는 예제 파일이 없다")
    for name in sorted(actual_files - expected_files):
        errors.append(f"{name}: 6절 기준 목록에 없는 예제 파일이다")

    for spec in SPECS:
        for fragment in spec["doc_fragments"]:
            if fragment not in section6:
                errors.append(f"{spec['file']}: stage-1-api.md 6절에 {fragment!r}가 없다")
        if spec.get("inferred"):
            # 6절에 경로가 약칭으로만 있는 경우, 경로 자체는 예제에서 정한 값임을 확인한다.
            if not spec["path"].startswith("/api/v1/"):
                errors.append(f"{spec['file']}: 추론 경로가 /api/v1/로 시작하지 않는다")
        check_fixture(spec, errors)

    total = len(SPECS)
    if errors:
        print(f"검사 실패: {total}개 중 문제 {len(errors)}건")
        for error in errors:
            print(f"- {error}")
        return 1

    print(f"검사 통과 {total}/{total}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
