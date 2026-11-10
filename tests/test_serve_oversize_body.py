"""SEL-66: 상한을 넘는 본문은 클라이언트가 다 보낸 뒤에도 항상 413 JSON 으로 받아야 한다.

배경: serve.py 가 Content-Length 가 상한(MAX_API_BODY, /feedback 은 MAX_BODY)을 넘으면 본문을
읽지 않고 413 을 보내고 닫으면, 클라이언트가 아직 보내는 중일 때 Windows(가끔 macOS)에서
ConnectionAbortedError / ConnectionResetError 가 난다. 결정된 동작:
  - 남은 본문이 드레인 한도(8 MiB) 안이면 서버가 다 읽어 버린 뒤 413 JSON + ``Connection: close``.
  - 드레인 한도를 넘는 Content-Length 면 그때만 바로 닫는다(오래 붙잡지 않는다).

이 시험은 urllib 대신 날 소켓을 쓴다: 본문 전부를 ``sendall`` 로 보내는 도중 연결이 끊기면 그 자체가
실패이고, 응답 헤더(``Connection: close``)와 본문 JSON 을 직접 단언해야 플랫폼과 무관하게 의미가 있다.
격리 HOME·PES_HOME 의 시험 서버 프로세스만 쓴다.
"""
import json
import os
import socket
import time

import pytest

from test_serve import MAX_BODY, Server, _make_home

SECRET = "synthetic-oversize-session-secret"
MAX_API_BODY = 2 * MAX_BODY
DRAIN_LIMIT = 8 * 1024 * 1024
REPEATS = 50
IO_TIMEOUT = 15
# 드레인 한도를 넘는 선언에 서버가 매달려 있지 않아야 하는 시간 상한(초).
GIVE_UP_LIMIT = 5


@pytest.fixture
def oversize_server(isolated_home, tmp_path, monkeypatch):
    monkeypatch.setenv("PES_LOCAL_SESSION_SECRET", SECRET)
    root = _make_home(isolated_home)
    instance = Server(root, tmp_path)
    try:
        instance.start()
        yield instance
    finally:
        instance.stop()


def _tree(root):
    out = {}
    for base, _dirs, files in os.walk(root):
        for name in files:
            path = os.path.join(base, name)
            out[os.path.relpath(path, root)] = os.path.getsize(path)
    return out


def _head(method, path, port, length, extra):
    lines = [f"{method} {path} HTTP/1.1", f"Host: 127.0.0.1:{port}",
             "Content-Type: application/json", f"Content-Length: {length}"]
    lines += [f"{k}: {v}" for k, v in extra.items()]
    return ("\r\n".join(lines) + "\r\n\r\n").encode("ascii")


def _read_response(sock):
    """상태, 소문자 헤더, 본문 바이트를 읽고, 그 뒤 서버가 연결을 닫았는지(EOF)도 돌려준다."""
    sock.settimeout(IO_TIMEOUT)
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(65536)
        if not chunk:
            raise AssertionError(f"connection closed before a full response header: {buf!r}")
        buf += chunk
    head, _, rest = buf.partition(b"\r\n\r\n")
    lines = head.decode("iso-8859-1").split("\r\n")
    status = int(lines[0].split()[1])
    headers = {}
    for line in lines[1:]:
        name, _, value = line.partition(":")
        headers[name.strip().lower()] = value.strip()
    if "content-length" in headers:
        want = int(headers["content-length"])
        while len(rest) < want:
            chunk = sock.recv(65536)
            if not chunk:
                break
            rest += chunk
        body, extra = rest[:want], rest[want:]
    else:  # 길이를 안 주면 닫힐 때까지가 본문
        body, extra = rest, b""
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                break
            body += chunk
    # 응답 뒤 서버가 연결을 닫아야 한다: 남은 바이트가 없고 곧 EOF.
    sock.settimeout(IO_TIMEOUT)
    try:
        closed = not extra and sock.recv(1) == b""
    except ConnectionError:
        closed = not extra  # 응답을 다 받은 뒤의 reset 도 닫힘이다
    except socket.timeout:
        closed = False
    return status, headers, body, closed


def _send_whole_then_read(port, method, path, body, extra):
    """요청 머리와 본문 전부를 보낸 *뒤에* 응답을 읽는다 (보내는 도중 끊기면 시험이 실패한다)."""
    with socket.create_connection(("127.0.0.1", port), timeout=IO_TIMEOUT) as sock:
        sock.sendall(_head(method, path, port, len(body), extra))
        sock.sendall(body)
        return _read_response(sock)


ROUTES = {
    "api-post": dict(method="POST", path="/api/v1/projects", limit=MAX_API_BODY,
                     headers=lambda s: {"Idempotency-Key": "oversize-1", "x-pes-session": SECRET}),
    "api-put": dict(method="PUT", path="/api/v1/projects/synthetic", limit=MAX_API_BODY,
                    headers=lambda s: {"Idempotency-Key": "oversize-2", "x-pes-session": SECRET}),
    "feedback-post": dict(method="POST", path="/synthetic/feedback", limit=MAX_BODY,
                          headers=lambda s: {"Origin": s.origin()}),
    "feedback-legacy-post": dict(method="POST", path="/feedback", limit=MAX_BODY,
                                 headers=lambda s: {"Origin": s.origin(),
                                                    "Referer": s.url("/synthetic/index.html")}),
}


def _assert_413_json(route, status, headers, body, closed):
    assert status == 413, (route, status, body[:200])
    assert headers.get("connection", "").lower() == "close", headers
    assert "application/json" in headers.get("content-type", ""), headers
    data = json.loads(body.decode("utf-8"))
    if route.startswith("api"):
        assert data["format_version"] == "1.0"
        assert isinstance(data["request_id"], str) and data["request_id"]
        assert data["error"]["code"] == "payload_too_large"
    else:
        assert data == {"ok": False}
    assert closed, "the server must close the connection after the 413"


def _assert_nothing_stored(server, before):
    assert _tree(server.root) == before, "an oversized request must not create any file"
    assert not list((server.project / "feedback").glob("*.json")) \
        if (server.project / "feedback").exists() else True


def _assert_still_serving(server):
    status, body = server.request("/api/v1/capabilities")
    assert status == 200
    status, body = server.get_json("/whoami")
    assert status == 200 and body["single"] is True


@pytest.mark.parametrize("name", sorted(ROUTES))
def test_slightly_oversized_body_fully_sent_gets_413_json_with_connection_close(oversize_server, name):
    route = ROUTES[name]
    server = oversize_server
    before = _tree(server.root)
    pad = route["limit"] + 10
    body = b'{"pad":"' + b"x" * pad + b'"}'
    status, headers, data, closed = _send_whole_then_read(
        server.port, route["method"], route["path"], body, route["headers"](server))
    _assert_413_json(name, status, headers, data, closed)
    _assert_nothing_stored(server, before)
    _assert_still_serving(server)


@pytest.mark.parametrize("name", sorted(ROUTES))
def test_multi_megabyte_body_inside_the_drain_limit_is_drained_then_413(oversize_server, name):
    route = ROUTES[name]
    server = oversize_server
    before = _tree(server.root)
    body = b'{"pad":"' + b"x" * (4 * 1024 * 1024) + b'"}'
    assert len(body) < DRAIN_LIMIT
    status, headers, data, closed = _send_whole_then_read(
        server.port, route["method"], route["path"], body, route["headers"](server))
    _assert_413_json(name, status, headers, data, closed)
    _assert_nothing_stored(server, before)
    _assert_still_serving(server)


@pytest.mark.parametrize("name", sorted(ROUTES))
def test_oversized_body_is_413_every_time_across_50_repeats(oversize_server, name):
    route = ROUTES[name]
    server = oversize_server
    before = _tree(server.root)
    body = b'{"pad":"' + b"x" * (route["limit"] + 10) + b'"}'
    for attempt in range(REPEATS):
        try:
            status, headers, data, closed = _send_whole_then_read(
                server.port, route["method"], route["path"], body, route["headers"](server))
        except (ConnectionError, socket.timeout) as error:
            raise AssertionError(f"{name} attempt {attempt + 1}/{REPEATS}: {error!r}") from error
        try:
            _assert_413_json(name, status, headers, data, closed)
        except AssertionError as error:
            raise AssertionError(f"{name} attempt {attempt + 1}/{REPEATS}: {error}") from error
    _assert_nothing_stored(server, before)
    _assert_still_serving(server)


@pytest.mark.parametrize("name", sorted(ROUTES))
def test_declared_length_beyond_the_drain_limit_is_closed_quickly(oversize_server, name):
    """Content-Length 가 드레인 한도를 넘으면(실제로는 조금만 보내고 멈춤) 서버가 오래 붙잡지 않고 닫는다."""
    route = ROUTES[name]
    server = oversize_server
    before = _tree(server.root)
    declared = DRAIN_LIMIT + 1024 * 1024
    started = time.monotonic()
    with socket.create_connection(("127.0.0.1", server.port), timeout=IO_TIMEOUT) as sock:
        sock.sendall(_head(route["method"], route["path"], server.port, declared, route["headers"](server)))
        sock.sendall(b'{"pad":"' + b"x" * 1000)  # 선언한 길이에 한참 못 미치게 보내고 멈춘다
        sock.settimeout(GIVE_UP_LIMIT)
        try:
            while True:  # 응답이 있어도 좋지만, 끝에는 EOF(또는 reset)가 와야 한다
                chunk = sock.recv(65536)
                if not chunk:
                    break
        except ConnectionError:
            pass  # 바로 닫으며 reset 이 오는 것도 허용
        except socket.timeout:
            pytest.fail(f"server held the connection for more than {GIVE_UP_LIMIT}s "
                        "after a Content-Length beyond the drain limit")
    assert time.monotonic() - started < GIVE_UP_LIMIT
    _assert_nothing_stored(server, before)
    _assert_still_serving(server)
