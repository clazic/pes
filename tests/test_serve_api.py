"""SEL-46 PR13: serve.py 는 /api/v1 을 Node ApiApp 에 넘기는 얇은 경계일 뿐이다 (최소 연결 시험).

Python 이 Node 의 ApiApp 을 부르는 방식은 구현이 정한다. 여기서는 격리된 HOME/PES_HOME 에서
실제 serve.py 프로세스를 띄우고, /api/v1 요청이 공통 봉투로 돌아오는 것만 고정한다.
전체 계약 시험은 tests/test_api_*.test.ts 가 맡는다.
"""
import json

from test_serve import Server, _make_home  # noqa: F401  (같은 서버 도우미 재사용)
import pytest


@pytest.fixture
def api_server(isolated_home, tmp_path):
    instance = Server(_make_home(isolated_home), tmp_path)
    try:
        instance.start()
        yield instance
    finally:
        instance.stop()


def _json(body):
    return json.loads(body.decode("utf-8"))


def test_capabilities_route_is_open_through_serve(api_server):
    status, body = api_server.request("/api/v1/capabilities")
    assert status == 200
    data = _json(body)
    assert data["format_version"] == "1.0"
    assert isinstance(data["data"], dict)
    assert isinstance(data["request_id"], str) and data["request_id"]


def test_unknown_api_route_is_the_json_error_envelope_not_a_file_404(api_server):
    status, body = api_server.request("/api/v1/no-such-route")
    assert status == 404
    data = _json(body)
    assert data["format_version"] == "1.0"
    assert data["error"]["code"] == "not_found"
    assert data["error"]["retryable"] is False


def test_api_write_without_credentials_is_401_through_serve(api_server):
    status, body = api_server.post("/api/v1/projects", {"slug": "x", "topic": "t", "owner_display_name": "o"})
    assert status == 401
    assert body["error"]["code"] == "unauthenticated"


def test_existing_feedback_route_and_static_files_are_unchanged(api_server):
    status, _ = api_server.request("/whoami")
    assert status == 200
    status, body = api_server.request("/synthetic/")
    assert status == 200 and b"synthetic" in body
