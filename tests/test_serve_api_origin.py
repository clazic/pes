"""SEL-46 PR13 정정: /api/v1 의 POST·PUT 도 serve.py 의 기존 Origin 검사를 거친다.

결정 12: Origin 검사는 유지하되 인증을 대신하지 않는다. 그래서
- 나쁜 Origin 은 올바른 세션 비밀이 있어도 거부(403)되고, 브리지(Node)까지 가지 않아 아무것도 쓰이지 않는다.
- 허용된 Origin(서버 자신의 주소)이나 Origin 이 없는 호출(에이전트 curl)은 API 까지 간다: 자격이 없으면 401.
격리된 HOME/PES_HOME 에서 실제 serve.py 프로세스를 띄운다. 합성 자료만 쓴다.
"""
import json

import pytest

from test_serve import Server, _make_home

SECRET = "synthetic-origin-session-secret"
EVIL = "https://evil.example"
PROJECT_BODY = json.dumps({"slug": "synthetic-origin", "topic": "t", "owner_display_name": "o"}).encode("utf-8")
UPLOAD_PATH = "/api/v1/projects/synthetic-project/uploads/synthetic-blob"


@pytest.fixture
def api_server(isolated_home, tmp_path, monkeypatch):
    monkeypatch.setenv("PES_LOCAL_SESSION_SECRET", SECRET)
    instance = Server(_make_home(isolated_home), tmp_path)
    try:
        instance.start()
        yield instance
    finally:
        instance.stop()


def _headers(origin=None, session=True, key="origin-1", content_type="application/json"):
    headers = {"Content-Type": content_type, "Idempotency-Key": key}
    if session:
        headers["x-pes-session"] = SECRET
    if origin is not None:
        headers["Origin"] = origin
    return headers


def test_post_with_a_bad_origin_is_403_even_with_the_right_session_and_writes_nothing(api_server, isolated_home):
    status, _ = api_server.request(
        "/api/v1/projects", method="POST", payload=PROJECT_BODY, headers=_headers(origin=EVIL))
    assert status == 403
    # the request never reached the Node bridge: no database was created, nothing was written
    assert not (isolated_home / ".pes" / "pes.db").exists()


def test_put_with_a_bad_origin_is_403(api_server, isolated_home):
    status, _ = api_server.request(
        UPLOAD_PATH, method="PUT", payload=b"synthetic-bytes",
        headers=_headers(origin=EVIL, content_type="application/octet-stream"))
    assert status == 403
    assert not (isolated_home / ".pes" / "pes.db").exists()


@pytest.mark.parametrize("origin", ["null", "http://127.0.0.1:1", "http://localhost.evil.example", "HTTP://EVIL.EXAMPLE"])
def test_other_foreign_origins_are_403_on_post(api_server, origin):
    status, _ = api_server.request(
        "/api/v1/projects", method="POST", payload=PROJECT_BODY, headers=_headers(origin=origin))
    assert status == 403


def test_own_origin_reaches_the_api_and_still_needs_credentials(api_server):
    status, body = api_server.request(
        "/api/v1/projects", method="POST", payload=PROJECT_BODY,
        headers=_headers(origin=api_server.origin(), session=False))
    assert status == 401
    assert json.loads(body.decode("utf-8"))["error"]["code"] == "unauthenticated"


def test_no_origin_header_is_not_blocked(api_server):
    """에이전트(curl)는 Origin 을 보내지 않는다. Origin 검사는 브라우저 호출을 막는 것이지 인증이 아니다."""
    status, body = api_server.request(
        "/api/v1/projects", method="POST", payload=PROJECT_BODY, headers=_headers(session=False))
    assert status == 401
    assert json.loads(body.decode("utf-8"))["error"]["code"] == "unauthenticated"


def test_get_and_the_feedback_route_keep_their_behavior(api_server):
    status, _ = api_server.request("/api/v1/capabilities", headers={"Origin": EVIL})
    assert status == 200  # 읽기 전용 공개 경로는 Origin 검사 대상이 아니다 (기존 GET 과 같다)
    status, body = api_server.post("/synthetic/feedback", {"text": "x", "round": 1, "stage": "plan"}, origin=EVIL)
    assert status == 403
