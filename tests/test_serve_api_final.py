"""SEL-46 PR13 Codex 최종 리뷰 1/2 회귀: 실제 serve.py 프로세스 종단 (tester, 회귀 모드).

logs/SEL-46-final-review-1.md 의 합성 재현을 실제 HTTP 로 고정한다.

  F1  CR/LF 가 든 media_type 예약은 400 invalid_payload. 이미 저장된 이상한 값은 읽을 때
      application/octet-stream 이고, 응답에 삽입된 헤더(X-Pes-Probe)가 없다.
  F5  size 0 예약 -> Content-Length 0 PUT -> complete -> GET 이 성공하고 sha256 이 빈 바이트의 것이다.
  R1  첫 --migrate 가 한 번 실패해도 다음 요청은 다시 시도해 성공한다.

모든 시험은 conftest 의 격리 HOME/PES_HOME 에서 서버를 띄운다. 실제 ~/.pes·~/pes-projects 는 건드리지 않는다.
"""
import hashlib
import http.client
import json
import os
import shutil
import sqlite3
import stat
import sys

import pytest

from test_serve import Server, _make_home

SECRET = "synthetic-final-session-secret"
EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()
PROBE = "text/plain\r\nX-Pes-Probe: injected"


def _http(server, method, path, payload=b"", headers=None):
    """(status, header 목록 [(이름, 값)], 본문 bytes). 헤더를 가공하지 않고 그대로 돌려준다."""
    conn = http.client.HTTPConnection("127.0.0.1", server.port, timeout=60)
    try:
        conn.putrequest(method, path)
        sent = dict(headers or {})
        sent["Content-Length"] = str(len(payload))
        for name, value in sent.items():
            conn.putheader(name, value)
        conn.endheaders(payload)
        response = conn.getresponse()
        body = response.read()
        return response.status, response.getheaders(), body
    finally:
        conn.close()


def _owner(key=None, extra=None):
    headers = {"x-pes-session": SECRET}
    if key is not None:
        headers["Idempotency-Key"] = key
    headers.update(extra or {})
    return headers


def _json_call(server, method, path, obj, key):
    status, headers, body = _http(
        server, method, path, json.dumps(obj).encode("utf-8"),
        _owner(key, {"Content-Type": "application/json"}))
    return status, json.loads(body.decode("utf-8")), headers


def _create_project(server, slug="synthetic-final"):
    status, data, _ = _json_call(
        server, "POST", "/api/v1/projects",
        {"slug": slug, "topic": "합성", "owner_display_name": "합성"}, f"create-{slug}")
    assert status == 201, data
    return data["data"]["project_id"]


@pytest.fixture
def api_server(isolated_home, tmp_path, monkeypatch):
    monkeypatch.setenv("PES_LOCAL_SESSION_SECRET", SECRET)
    instance = Server(_make_home(isolated_home), tmp_path)
    try:
        instance.start()
        yield instance
    finally:
        instance.stop()


def _reserve(server, project, sha, size, media_type, key):
    return _json_call(
        server, "POST", f"/api/v1/projects/{project}/uploads",
        {"sha256": sha, "size": size, "media_type": media_type, "original_name": "합성.bin"}, key)


def _put_and_complete(server, project, blob_id, payload, media_type, tag):
    status, headers, body = _http(
        server, "PUT", f"/api/v1/projects/{project}/uploads/{blob_id}", payload,
        _owner(f"put-{tag}", {"Content-Type": media_type}))
    assert status == 200, body
    status, data, _ = _json_call(server, "POST", f"/api/v1/projects/{project}/uploads/{blob_id}/complete", {}, f"done-{tag}")
    assert status == 200, data
    assert data["data"]["state"] == "ready"


# ---------------------------------------------------------------------------
# F1

def test_f1_reserving_a_crlf_media_type_is_400_over_real_http(api_server):
    project = _create_project(api_server)
    payload = b"synthetic f1 bytes"
    status, data, _ = _reserve(api_server, project, hashlib.sha256(payload).hexdigest(), len(payload), PROBE, "f1-reserve")
    assert status == 400, data
    assert data["error"]["code"] == "invalid_payload"
    # 같은 예약이 정상 media_type 으로는 된다 (예약 자체가 막힌 것이 아니다).
    status, data, _ = _reserve(api_server, project, hashlib.sha256(payload).hexdigest(), len(payload), "text/plain", "f1-reserve-ok")
    assert status == 201, data


def test_f1_an_already_stored_crlf_media_type_never_becomes_a_response_header(api_server, isolated_home):
    project = _create_project(api_server)
    payload = b"synthetic f1 stored bytes"
    status, data, _ = _reserve(api_server, project, hashlib.sha256(payload).hexdigest(), len(payload), "text/plain", "f1s-reserve")
    assert status == 201, data
    blob_id = data["data"]["blob_id"]
    _put_and_complete(api_server, project, blob_id, payload, "text/plain", "f1s")

    # 이전 버전이 저장해 둔 이상한 값을 DB 에 직접 심는다 (격리 HOME 의 DB 만).
    db = sqlite3.connect(str(isolated_home / ".pes" / "pes.db"))
    try:
        db.execute("UPDATE blobs SET media_type = ? WHERE id = ?", (PROBE, blob_id))
        db.commit()
    finally:
        db.close()

    status, headers, body = _http(api_server, "GET", f"/api/v1/projects/{project}/files/{blob_id}/content", b"", _owner())
    assert status == 200
    assert body == payload
    names = [name.lower() for name, _ in headers]
    assert "x-pes-probe" not in names, headers
    content_types = [value for name, value in headers if name.lower() == "content-type"]
    assert len(content_types) == 1
    assert content_types[0].lower().startswith("application/octet-stream"), content_types


# ---------------------------------------------------------------------------
# F5

def test_f5_an_empty_file_round_trips_through_serve(api_server):
    project = _create_project(api_server, "synthetic-empty")
    status, data, _ = _reserve(api_server, project, EMPTY_SHA256, 0, "application/octet-stream", "f5-reserve")
    assert status == 201, data
    blob_id = data["data"]["blob_id"]

    status, headers, body = _http(
        api_server, "PUT", f"/api/v1/projects/{project}/uploads/{blob_id}", b"",
        _owner("f5-put", {"Content-Type": "application/octet-stream"}))
    assert status == 200, body
    assert json.loads(body.decode("utf-8"))["data"]["blob_id"] == blob_id

    status, data, _ = _json_call(api_server, "POST", f"/api/v1/projects/{project}/uploads/{blob_id}/complete", {}, "f5-done")
    assert status == 200, data
    assert data["data"]["state"] == "ready"

    status, headers, body = _http(api_server, "GET", f"/api/v1/projects/{project}/files/{blob_id}/content", b"", _owner())
    assert status == 200
    assert body == b""
    assert hashlib.sha256(body).hexdigest() == EMPTY_SHA256
    lengths = [value for name, value in headers if name.lower() == "content-length"]
    assert lengths == ["0"]


def test_f5_a_non_empty_size_mismatch_with_an_empty_put_is_still_rejected(api_server):
    """빈 PUT 을 받아들이는 고침이 '내용이 모자란 PUT' 까지 받아들이면 안 된다."""
    project = _create_project(api_server, "synthetic-short")
    payload = b"not empty"
    status, data, _ = _reserve(api_server, project, hashlib.sha256(payload).hexdigest(), len(payload), "application/octet-stream", "f5m-reserve")
    assert status == 201, data
    blob_id = data["data"]["blob_id"]
    status, headers, body = _http(
        api_server, "PUT", f"/api/v1/projects/{project}/uploads/{blob_id}", b"",
        _owner("f5m-put", {"Content-Type": "application/octet-stream"}))
    assert status == 400
    assert json.loads(body.decode("utf-8"))["error"]["code"] == "invalid_payload"


# ---------------------------------------------------------------------------
# R1

@pytest.mark.skipif(sys.platform == "win32", reason="sh 로 만든 node 대용 스크립트를 쓴다")
def test_r1_a_failed_first_migrate_is_retried_by_the_next_request(isolated_home, tmp_path, monkeypatch):
    real_node = shutil.which("node")
    assert real_node, "node is required"
    shim_dir = tmp_path / "shim-bin"
    shim_dir.mkdir()
    attempts = tmp_path / "migrate-attempts.log"
    shim = shim_dir / "node"
    shim.write_text(
        "#!/bin/sh\n"
        'case " $* " in\n'
        '  *" --migrate "*)\n'
        f'    echo attempt >> "{attempts}"\n'
        f'    if [ "$(wc -l < "{attempts}")" -le 1 ]; then echo "synthetic one-time failure" >&2; exit 1; fi\n'
        "    ;;\n"
        "esac\n"
        f'exec "{real_node}" "$@"\n',
        encoding="utf-8")
    shim.chmod(shim.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    monkeypatch.setenv("PATH", str(shim_dir) + os.pathsep + os.environ.get("PATH", ""))
    monkeypatch.setenv("PES_LOCAL_SESSION_SECRET", SECRET)

    server = Server(_make_home(isolated_home), tmp_path)
    try:
        server.start()

        def count():
            return len(attempts.read_text(encoding="utf-8").splitlines()) if attempts.exists() else 0

        status, headers, body = _http(server, "GET", "/api/v1/capabilities")
        assert status == 503, body
        assert json.loads(body.decode("utf-8"))["error"]["code"] == "schema_not_ready"
        assert count() == 1

        status, headers, body = _http(server, "GET", "/api/v1/capabilities")
        assert status == 200, body
        assert json.loads(body.decode("utf-8"))["format_version"] == "1.0"
        assert count() == 2, "the second request migrated again"

        # 성공은 캐시된다: 이후 요청은 더 migrate 하지 않는다.
        for _ in range(2):
            status, headers, body = _http(server, "GET", "/api/v1/capabilities")
            assert status == 200
        assert count() == 2
        # 실제로 쓸 수 있는 DB 다.
        assert _create_project(server, "synthetic-after-retry")
    finally:
        server.stop()
