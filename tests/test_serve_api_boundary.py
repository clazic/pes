"""SEL-46 PR13 보강: serve.py 의 /api/v1 경계가 그 밖의 경로를 바꾸지 않고, 격리된 HOME 밖을 건드리지 않는다.

모든 시험은 conftest 의 격리 HOME/PES_HOME 에서 실제 serve.py 프로세스를 띄운다.
실제 ~/.pes·~/pes-projects 는 읽지도 쓰지도 않는다 (GUARD 감사 훅이 서버 프로세스에도 걸려 있다).
"""
import json
import os

import pytest

from test_serve import MAX_BODY, Server, _make_home

SECRET = "synthetic-boundary-session-secret"


@pytest.fixture
def api_server(isolated_home, tmp_path, monkeypatch):
    monkeypatch.setenv("PES_LOCAL_SESSION_SECRET", SECRET)
    root = _make_home(isolated_home)
    instance = Server(root, tmp_path)
    try:
        instance.start()
        yield instance
    finally:
        instance.stop()


def _envelope(body):
    data = json.loads(body.decode("utf-8"))
    assert data["format_version"] == "1.0"
    assert isinstance(data["request_id"], str) and data["request_id"]
    return data


def _tree(root):
    out = {}
    for base, _dirs, files in os.walk(root):
        for name in files:
            path = os.path.join(base, name)
            out[os.path.relpath(path, root)] = os.path.getsize(path)
    return out


@pytest.mark.parametrize("path", [
    "/api/v1",
    "/api/v1/",
    "/api/v1/nothing",
    "/api/v1/../whoami",
    "/api/v1/projects/x/unknown",
])
def test_api_prefix_paths_are_the_json_envelope_never_static_files(api_server, path):
    status, body = api_server.request(path)
    assert status == 404
    assert _envelope(body)["error"]["code"] == "not_found"


@pytest.mark.parametrize("path", ["/api/v10/capabilities", "/api/v1x", "/api/v", "/apiv1/capabilities", "/API/v1/capabilities"])
def test_lookalike_paths_are_not_routed_to_the_api(api_server, path):
    """/api/v1 만 API 다. 비슷한 이름은 예전 정적 서버 응답 그대로 (JSON 봉투가 아니다)."""
    status, body = api_server.request(path)
    assert status == 404
    try:
        parsed = json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        parsed = None
    assert not (isinstance(parsed, dict) and parsed.get("format_version") == "1.0")


def test_non_api_routes_answer_as_before_after_api_traffic(api_server):
    status, body = api_server.request("/api/v1/capabilities")
    assert status == 200
    status, body = api_server.get_json("/whoami")
    assert status == 200 and body["single"] is True
    status, body = api_server.request("/synthetic/")
    assert status == 200 and b"synthetic" in body
    status, body = api_server.request("/version")
    assert status == 200
    # 예전 PUT 은 405 {"ok": false} 그대로
    status, body = api_server.request("/anything", method="PUT", payload=b"x")
    assert status == 405 and json.loads(body.decode("utf-8")) == {"ok": False}
    status, body = api_server.request("/synthetic/ask-plan.html")
    assert status == 200 and b"ask" in body


def test_feedback_post_is_unchanged_and_not_an_api_route(api_server):
    status, body = api_server.post("/feedback", {"kind": "nonsense"})
    assert status in (400, 404)
    assert not (isinstance(body, dict) and body.get("format_version") == "1.0")


def test_api_calls_write_only_under_the_isolated_home(api_server, isolated_home):
    """DB 는 격리 HOME 의 .pes 에만 생기고, 프로젝트 폴더(PES_HOME)에는 파일이 늘지 않는다."""
    projects_before = _tree(api_server.root)
    status, body = api_server.request("/api/v1/capabilities")
    assert status == 200
    status, body = api_server.post(
        "/api/v1/projects",
        {"slug": "synthetic-boundary", "topic": "합성", "owner_display_name": "합성"},
    )
    assert status == 401  # 세션 헤더 없음
    status, text = api_server.request(
        "/api/v1/projects",
        method="POST",
        payload=json.dumps({"slug": "synthetic-boundary", "topic": "합성", "owner_display_name": "합성"}).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-pes-session": SECRET, "Idempotency-Key": "boundary-1"},
    )
    assert status == 201, text
    created = _envelope(text)["data"]
    assert created["project_id"]
    assert (isolated_home / ".pes" / "pes.db").is_file(), "the database lives under the isolated HOME"
    assert _tree(api_server.root) == projects_before, "no file appeared in the project folders"


def test_session_secret_from_the_environment_is_the_only_one_and_a_wrong_one_is_401(api_server):
    payload = json.dumps({"slug": "synthetic-wrong", "topic": "t", "owner_display_name": "o"}).encode("utf-8")
    for secret in ("wrong", "", SECRET + "x"):
        headers = {"Content-Type": "application/json", "Idempotency-Key": "wrong-1"}
        if secret:
            headers["x-pes-session"] = secret
        status, body = api_server.request("/api/v1/projects", method="POST", payload=payload, headers=headers)
        assert status == 401
        assert _envelope(body)["error"]["code"] == "unauthenticated"


def test_oversized_api_body_is_413_json_and_the_server_stays_up(api_server):
    huge = b"{" + b'"pad":"' + b"x" * (2 * MAX_BODY + 10) + b'"}'
    status, body = api_server.request(
        "/api/v1/projects", method="POST", payload=huge,
        headers={"Content-Type": "application/json", "Idempotency-Key": "huge-1"})
    assert status == 413
    assert _envelope(body)["error"]["code"] == "payload_too_large"
    status, body = api_server.request("/api/v1/capabilities")
    assert status == 200


def test_body_between_the_two_limits_is_still_413_from_the_api(api_server):
    mid = b'{"pad":"' + b"x" * (MAX_BODY + 100) + b'"}'
    status, body = api_server.request(
        "/api/v1/projects", method="POST", payload=mid,
        headers={"Content-Type": "application/json", "Idempotency-Key": "mid-1", "x-pes-session": SECRET})
    assert status == 413
    assert _envelope(body)["error"]["code"] == "payload_too_large"


def test_bad_json_and_headers_pass_through_with_the_envelope(api_server):
    status, body = api_server.request(
        "/api/v1/projects", method="POST", payload=b"{not json",
        headers={"Content-Type": "application/json", "Idempotency-Key": "bad-1", "x-pes-session": SECRET})
    assert status == 400
    assert _envelope(body)["error"]["code"] == "invalid_payload"
    status, body = api_server.request(
        "/api/v1/projects", method="POST", payload=b"{}",
        headers={"Content-Type": "application/json", "x-pes-session": SECRET})
    assert status == 400  # Idempotency-Key 없음
    assert _envelope(body)["error"]["code"] == "invalid_payload"


def test_wrong_method_on_an_api_path_is_the_405_envelope(api_server):
    status, body = api_server.request("/api/v1/capabilities", method="POST", payload=b"{}",
                                      headers={"Content-Type": "application/json"})
    assert status == 405
    assert _envelope(body)["error"]["code"] == "method_not_allowed"


@pytest.mark.parametrize("method", ["DELETE", "PATCH"])
def test_defect_candidate_other_verbs_on_an_api_path_are_the_405_envelope_not_a_bare_501(api_server, method):
    """DEFECT?: serve.py 는 GET/POST/PUT 만 API 로 넘긴다. DELETE·PATCH 는 http.server 의 501 이 된다."""
    status, body = api_server.request("/api/v1/capabilities", method=method)
    assert status == 405, f"{method} /api/v1/capabilities gave {status}"
    assert _envelope(body)["error"]["code"] == "method_not_allowed"


def test_content_length_mismatch_and_negative_are_not_server_errors(api_server):
    import http.client
    for length in ("-5", "abc"):
        conn = http.client.HTTPConnection("127.0.0.1", api_server.port, timeout=30)
        try:
            conn.putrequest("POST", "/api/v1/projects")
            conn.putheader("Content-Length", length)
            conn.putheader("Idempotency-Key", "cl-1")
            conn.endheaders()
            response = conn.getresponse()
            assert response.status < 500, f"Content-Length {length} gave {response.status}"
            response.read()
        finally:
            conn.close()
    status, _ = api_server.request("/api/v1/capabilities")
    assert status == 200
