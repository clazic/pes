"""SEL-47 r1 회귀 (tester, 회귀 모드): serve.py 경로.

  R1  세션 비밀·커서 키를 설정하지 않은 기본 상태(PES_LOCAL_SESSION_SECRET 없음, ~/.pes/config.json 없음)에서
      GET changes 가 준 next_cursor 를 서버를 껐다 켠 뒤에도(다른 프로세스) 쓸 수 있다. 비밀은 격리 HOME 의
      ~/.pes 아래 0600 파일, 원문은 응답·서버 로그에 없다.
  S1  자격 없는 요청, 그리고 환불 대상(형식이 틀린) 요청도 전체 거친 버킷에 걸려 결국 429 가 된다.
  S10 DELETE·PATCH 도 나쁜 Origin 이면 403 (브리지까지 가지 않는다).

모든 프로세스는 conftest 의 격리 HOME/PES_HOME 에서만 실행한다. 합성 자료만 쓴다.
"""
import http.client
import json
import os
import re
import shutil
import stat
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

import pytest

from conftest import ROOT
from test_serve import Server, _make_home

BOOT = ROOT / "tests" / "helpers" / "bootstrap_agent.ts"
SCOPES = "context:read,run:claim,run:submit,file:write,file:read"
EVIL = "https://evil.example"

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node 가 필요하다")


def _http(server, method, path, payload=b"", headers=None):
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
        return response.status, {k.lower(): v for k, v in response.getheaders()}, body
    finally:
        conn.close()


def _get(server, path, token=None):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    status, response_headers, body = _http(server, "GET", path, b"", headers)
    try:
        doc = json.loads(body.decode("utf-8"))
    except ValueError:
        doc = None
    return status, doc, body.decode("utf-8", "replace"), response_headers


def _bootstrap(isolated_home, slug):
    env = dict(os.environ)
    env.pop("PES_LOCAL_SESSION_SECRET", None)
    env.update({"HOME": str(isolated_home), "USERPROFILE": str(isolated_home), "PES_HOME": str(isolated_home / "pes-projects")})
    out = subprocess.run([shutil.which("node"), str(BOOT), slug, SCOPES], cwd=str(ROOT), env=env,
                         capture_output=True, timeout=120)
    assert out.returncode == 0, out.stderr.decode("utf-8", "replace")
    return json.loads(out.stdout.decode("utf-8"))


@pytest.fixture
def plain(isolated_home, tmp_path, monkeypatch):
    """PES_LOCAL_SESSION_SECRET 도 config.json 도 없는 기본 상태의 서버 + 합성 프로젝트·토큰."""
    monkeypatch.delenv("PES_LOCAL_SESSION_SECRET", raising=False)
    boot = _bootstrap(isolated_home, "synthetic-r1")
    assert not (isolated_home / ".pes" / "config.json").exists()
    instance = Server(_make_home(isolated_home), tmp_path)
    try:
        instance.start()
        yield instance, boot, isolated_home, tmp_path
    finally:
        instance.stop()


# ---------------------------------------------------------------------------
# R1

def test_changes_cursor_works_in_another_server_process_with_no_secret_configured(plain):
    server, boot, home, tmp_path = plain
    path = f"/api/v1/projects/{boot['project_id']}/changes"
    status, doc, text1, _ = _get(server, f"{path}?limit=1", boot["token"])
    assert status == 200, text1
    cursor = doc["data"]["next_cursor"]
    assert isinstance(cursor, str) and cursor

    # 같은 서버의 다음 요청(새 브리지 프로세스)
    status, doc2, text2, _ = _get(server, f"{path}?limit=1&cursor={cursor}", boot["token"])
    assert status == 200, text2

    # 서버 프로세스까지 새로 띄운다
    server.stop()
    second = Server(_make_home_again(home), tmp_path / "again")
    try:
        second.start()
        status, doc3, text3, _ = _get(second, f"{path}?cursor={doc2['data']['next_cursor']}", boot["token"])
        assert status == 200, text3
        status, bad, _, _ = _get(second, f"{path}?cursor={cursor[:-1]}{'B' if cursor[-1] == 'A' else 'A'}", boot["token"])
        assert status == 400 and bad["error"]["code"] == "cursor_invalid"
        log = second.log_text()
    finally:
        second.stop()

    secrets = _secret_files(home)
    assert secrets, "~/.pes 아래에 영속 비밀 파일이 생긴다"
    for name, content in secrets.items():
        if sys.platform != "win32":
            assert stat.S_IMODE((home / ".pes" / name).stat().st_mode) == 0o600, name
        for seen in (text1, text2, text3, log, server.log_text()):
            assert content not in seen, f"{name} 의 원문이 응답·로그에 있다"


def _secret_files(home):
    """~/.pes 아래의 DB 가 아닌 일반 파일 중 한 줄 비밀(16자 이상)."""
    found = {}
    for entry in (home / ".pes").iterdir():
        if not entry.is_file() or re.match(r"pes\.db($|-)", entry.name):
            continue
        content = entry.read_text(encoding="utf-8", errors="replace").strip()
        if len(content) >= 16 and "\n" not in content:
            found[entry.name] = content
    return found


def _make_home_again(home):
    root = home / "pes-projects"
    return root


# ---------------------------------------------------------------------------
# S1

def _hammer(server, path, token, count):
    """count 번까지 병렬로 보내 첫 429 가 나오면 멈춘다. (보낸 수, 429 응답)"""
    seen = {"limited": None, "sent": 0}

    def one(_):
        if seen["limited"] is not None:
            return
        status, doc, _, headers = _get(server, path, token)
        seen["sent"] += 1
        if status == 429:
            seen["limited"] = (doc, headers)

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(one, range(count)))
    return seen


def test_requests_without_any_credential_end_in_429_from_a_coarse_bucket(plain):
    server, boot, _, _ = plain
    status, doc, _, _ = _get(server, "/api/v1/capabilities")
    assert status == 200
    ceiling = int(doc["data"]["capabilities"]["limits"]["agent_requests_per_minute"]) * 12
    seen = _hammer(server, f"/api/v1/projects/{boot['project_id']}/changes", None, ceiling)
    assert seen["limited"] is not None, f"{seen['sent']} 건의 무자격 요청이 모두 Node 까지 갔다"
    limited, headers = seen["limited"]
    assert limited["error"]["code"] == "rate_limited" and limited["error"]["retryable"] is True
    assert headers.get("retry-after")


def test_refunded_input_errors_with_a_valid_token_end_in_429_too(plain):
    server, boot, _, _ = plain
    status, doc, _, _ = _get(server, "/api/v1/capabilities")
    ceiling = int(doc["data"]["capabilities"]["limits"]["agent_requests_per_minute"]) * 12
    path = f"/api/v1/projects/{boot['project_id']}/changes?cursor=tampered"
    seen = _hammer(server, path, boot["token"], ceiling)
    assert seen["limited"] is not None, f"{seen['sent']} 건의 형식 틀린 요청이 모두 환불돼 무제한이었다"
    assert seen["limited"][0]["error"]["code"] == "rate_limited"


# ---------------------------------------------------------------------------
# S10

@pytest.mark.parametrize("method", ["DELETE", "PATCH"])
def test_delete_and_patch_with_a_bad_origin_are_403_before_the_bridge(isolated_home, tmp_path, monkeypatch, method):
    monkeypatch.setenv("PES_LOCAL_SESSION_SECRET", "synthetic-s10-session-secret")
    server = Server(_make_home(isolated_home), tmp_path)
    try:
        server.start()
        path = "/api/v1/projects/synthetic-project"
        status, _, body = _http(server, method, path, b"", {"Origin": EVIL, "x-pes-session": "synthetic-s10-session-secret",
                                                              "Idempotency-Key": "s10"})
        assert status == 403, body
        assert not (isolated_home / ".pes" / "pes.db").exists(), "브리지(마이그레이션)까지 가지 않았다"
        # Origin 이 없는 호출은 막지 않는다 (인증이 아니라 브라우저 방어)
        status, _, _ = _http(server, method, path, b"", {"Idempotency-Key": "s10b"})
        assert status != 403
    finally:
        server.stop()
