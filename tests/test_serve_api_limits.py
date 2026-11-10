"""SEL-47 PR14 serve.py 경로: 요청 예산·poll 간격·쿼리스트링 전달 (tester, 작성 모드).

실제 serve.py 프로세스(+ Node 브리지)를 conftest 의 격리 HOME/PES_HOME 에서 띄워 고정한다.
한도 숫자는 GET /api/v1/capabilities 가 알려 주는 값에서 읽는다 (여기에 하드코딩하지 않는다).
토큰은 격리 DB 에 합성 에이전트를 만들어 발급한다 (tests/helpers/mint_agent_token.ts). 실키·실자료 없음.

  (1) 같은 에이전트 토큰의 (한도+1)번째 프로젝트 경로 요청은 429 rate_limited — 한국어 message, retryable true,
      next_action retry_after, details.scope, retry-after 헤더. 다른 토큰·소유자 세션 예산은 별개.
      토큰 원문은 서버 로그에 남지 않는다.
  (2) inputs 빈 poll 이 최소 간격보다 빠르면 429 details.scope='poll', 간격이 지나면 통과한다.
  (3) 쿼리스트링이 브리지·ApiApp 까지 그대로 전달된다 (limit=1 이면 1건, 변조 cursor 는 400 cursor_invalid,
      wait_ms 범위 밖은 400).
"""
import http.client
import json
import re
import shutil
import sqlite3
import subprocess
import time

import pytest

from conftest import ROOT
from serve_budget import start_shared_server
from test_serve import Server, _make_home

SECRET = "synthetic-limits-session-secret"
P_ROOT = "/api/v1/projects"
MINT = ROOT / "tests" / "helpers" / "mint_agent_token.ts"
AGENT_SCOPES = "context:read,run:claim,run:submit,file:write,file:read"
HANGUL = re.compile(r"[가-힣]")

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


def _call(server, method, path, auth, obj=None, key=None):
    headers = {}
    if auth == "owner":
        headers["x-pes-session"] = SECRET
    elif auth:
        headers["Authorization"] = f"Bearer {auth}"
    payload = b""
    if obj is not None:
        payload = json.dumps(obj).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if method != "GET":
        headers["Idempotency-Key"] = key or f"k-{time.monotonic_ns()}"
    status, response_headers, body = _http(server, method, path, payload, headers)
    try:
        doc = json.loads(body.decode("utf-8"))
    except ValueError:
        doc = None
    return status, doc, response_headers


class Env:
    def __init__(self, server, home, override=None):
        self.server = server
        self.override = override or {}
        self.db_path = home / ".pes" / "pes.db"
        self.env_vars = {"HOME": str(home), "USERPROFILE": str(home), "PES_HOME": str(home / "pes-projects"),
                         "PES_LOCAL_SESSION_SECRET": SECRET}
        status, doc, _ = _call(server, "POST", P_ROOT, "owner",
                               {"slug": "synthetic-limits", "topic": "합성", "owner_display_name": "합성"}, "create-limits")
        assert status == 201, doc
        self.project = doc["data"]["project_id"]
        self.P = f"{P_ROOT}/{self.project}"
        status, doc, _ = _call(server, "GET", "/api/v1/capabilities", None)
        assert status == 200, doc
        self.caps = doc["data"]
        self.agents = {}

    @property
    def limits(self):
        # 문서 계약: capabilities.limits. 지금 구현의 최상위 limits 도 같은 값이다 (둘 다 본다).
        merged = dict(self.caps.get("limits") or {})
        merged.update(self.caps["capabilities"]["limits"])
        # capabilities 는 Node 의 기본 숫자를 내준다. 서버가 실제로 쓰는 조인 값이 있으면 그것이 유효 한도다.
        merged.update(self.override)
        return merged

    def make_agent(self, name):
        import os
        db = sqlite3.connect(str(self.db_path))
        try:
            owner_user = db.execute("SELECT owner_user_id FROM projects WHERE id = ?", (self.project,)).fetchone()[0]
            owner_actor = db.execute("SELECT id FROM actors WHERE user_id = ? AND kind = 'human'", (owner_user,)).fetchone()[0]
            actor_id = f"agent-{name}"
            db.execute("INSERT INTO actors (id, kind, user_id, display_name) VALUES (?, 'external_agent', ?, ?)",
                       (actor_id, owner_user, f"합성 {name}"))
            db.commit()
        finally:
            db.close()
        env = dict(os.environ)
        env.update(self.env_vars)
        out = subprocess.run(
            [shutil.which("node"), str(MINT), self.project, owner_actor, actor_id, AGENT_SCOPES],
            cwd=str(ROOT), env=env, capture_output=True, timeout=120)
        assert out.returncode == 0, out.stderr.decode("utf-8", "replace")
        agent = json.loads(out.stdout.decode("utf-8"))
        self.agents[name] = agent
        return agent

    def owner_creates_run(self, agent):
        status, doc, _ = _call(self.server, "POST", f"{self.P}/runs", "owner",
                               {"actor_id": agent["actor_id"], "mode": "B", "runtime": "synthetic-runtime",
                                "provider": "synthetic", "model": "synthetic-model"})
        assert status == 201, doc
        return doc["data"]["run_id"]


@pytest.fixture
def env(isolated_home, tmp_path, monkeypatch):
    monkeypatch.setenv("PES_LOCAL_SESSION_SECRET", SECRET)
    instance = Server(_make_home(isolated_home), tmp_path)
    try:
        instance.start()
        yield Env(instance, isolated_home)
    finally:
        instance.stop()


@pytest.fixture(scope="module")
def shared_env(tmp_path_factory):
    """서버와 프로젝트 하나를 이 파일의 시험이 나눠 쓴다. 에이전트 한도(분당 6)와 poll 간격(500ms)만 조였다.

    시험마다 새 에이전트 토큰·새 run 을 쓰므로 예산·poll 간격(자격 sha256 단위)은 시험끼리 섞이지 않는다. 거친 버킷(300)·
    소유자 세션(600)·제어(120)는 기본값 그대로라 이 파일 전체가 써도 차지 않고, 그 한도에 닿는 시험은 이 파일에 없다
    (거친 버킷을 채우는 시험은 r1_3·r1_regression 의 자기 서버). 서버 로그 시험은 공유 로그 전체를 보므로 더 엄격해질 뿐이다.
    """
    override = {"agent_requests_per_minute": 6, "min_poll_interval_ms": 500}
    server, home = start_shared_server(tmp_path_factory, SECRET, override)
    try:
        yield Env(server, home, override)
    finally:
        server.stop()


def _poll_gap_s(env):
    return int(env.limits["min_poll_interval_ms"]) / 1000.0


def _assert_rate_limited(status, doc, headers, scope):
    assert status == 429, doc
    error = doc["error"]
    assert error["code"] == "rate_limited"
    assert HANGUL.search(error["message"]), error["message"]
    assert error["retryable"] is True
    assert error["next_action"] == "retry_after"
    assert error["details"]["scope"] == scope
    assert isinstance(error["details"]["retry_after_ms"], int) and error["details"]["retry_after_ms"] > 0
    assert doc["request_id"]
    retry_after = headers.get("retry-after")
    assert retry_after is not None and retry_after.isdigit() and int(retry_after) >= 1, headers
    assert int(retry_after) * 1000 >= error["details"]["retry_after_ms"] - 999


# ---------------------------------------------------------------------------
# (1) 요청 예산

def test_the_request_after_the_agent_limit_is_429_with_the_whole_error_contract(shared_env):
    agent = shared_env.make_agent("budget")
    limit = int(shared_env.limits["agent_requests_per_minute"])
    for i in range(limit):
        status, doc, _ = _call(shared_env.server, "GET", f"{shared_env.P}/changes", agent["token"])
        assert status == 200, (i, doc)
    status, doc, headers = _call(shared_env.server, "GET", f"{shared_env.P}/changes", agent["token"])
    _assert_rate_limited(status, doc, headers, "general")
    # 한 번 더 보내도 같은 창 안에서는 계속 거절된다.
    status, doc, headers = _call(shared_env.server, "GET", f"{shared_env.P}/context", agent["token"])
    _assert_rate_limited(status, doc, headers, "general")


def test_other_tokens_the_owner_session_and_the_control_bucket_have_their_own_budget(shared_env):
    spent = shared_env.make_agent("spent")
    fresh = shared_env.make_agent("fresh")
    limit = int(shared_env.limits["agent_requests_per_minute"])
    for _ in range(limit):
        assert _call(shared_env.server, "GET", f"{shared_env.P}/changes", spent["token"])[0] == 200
    assert _call(shared_env.server, "GET", f"{shared_env.P}/changes", spent["token"])[0] == 429
    # 다른 토큰은 영향이 없다.
    assert _call(shared_env.server, "GET", f"{shared_env.P}/changes", fresh["token"])[0] == 200
    # 소유자 세션 예산은 별개다.
    assert _call(shared_env.server, "GET", f"{shared_env.P}/changes", "owner")[0] == 200
    # 같은 토큰의 control 경로(operations 조회)는 별도 예산이라 429 가 아니다 (없는 id 는 404).
    status, doc, _ = _call(shared_env.server, "GET", f"{shared_env.P}/operations/no-such-operation", spent["token"])
    assert status != 429, doc
    # 프로젝트 경로가 아닌 열린 경로는 예산을 쓰지 않는다.
    assert _call(shared_env.server, "GET", "/api/v1/capabilities", None)[0] == 200


def test_requests_refused_over_their_own_input_do_not_spend_the_budget(shared_env):
    agent = shared_env.make_agent("refund")
    limit = int(shared_env.limits["agent_requests_per_minute"])
    # 변조 cursor -> 400 cursor_invalid 는 요청 예산을 돌려받는다 (쿼리가 전달돼야만 400 이 된다).
    for i in range(limit + 3):
        status, doc, _ = _call(shared_env.server, "GET", f"{shared_env.P}/changes?cursor=tampered-{i}", agent["token"])
        assert status == 400, (i, status, doc)
        assert doc["error"]["code"] == "cursor_invalid"
    assert _call(shared_env.server, "GET", f"{shared_env.P}/changes", agent["token"])[0] == 200


def test_the_raw_token_never_reaches_the_server_log(shared_env):
    agent = shared_env.make_agent("log")
    limit = int(shared_env.limits["agent_requests_per_minute"])
    for _ in range(limit + 1):
        _call(shared_env.server, "GET", f"{shared_env.P}/changes", agent["token"])
    for bad in (agent["token"] + "x", "synthetic-wrong-token"):
        _call(shared_env.server, "GET", f"{shared_env.P}/changes", bad)
    log = shared_env.server.log_text()
    assert agent["token"] not in log
    assert SECRET not in log
    # 본문 응답에도 토큰 원문이 없다.
    status, body_doc, headers = _call(shared_env.server, "GET", f"{shared_env.P}/changes", agent["token"])
    assert status == 429
    assert agent["token"] not in json.dumps(body_doc) + json.dumps(headers)


# ---------------------------------------------------------------------------
# (2) inputs 최소 poll 간격

def test_an_empty_inputs_poll_faster_than_the_minimum_interval_is_429_poll(shared_env):
    agent = shared_env.make_agent("poller")
    other = shared_env.make_agent("poller-other")
    run = shared_env.owner_creates_run(agent)
    other_run = shared_env.owner_creates_run(other)
    path = f"{shared_env.P}/runs/{run}/inputs"

    status, doc, _ = _call(shared_env.server, "GET", path, agent["token"])
    assert status == 200 and doc["data"]["inputs"] == [], doc
    status, doc, headers = _call(shared_env.server, "GET", path, agent["token"])
    _assert_rate_limited(status, doc, headers, "poll")
    assert doc["error"]["details"]["retry_after_ms"] <= int(shared_env.limits["min_poll_interval_ms"])
    # 다른 토큰(다른 run)의 poll 은 막히지 않는다.
    assert _call(shared_env.server, "GET", f"{shared_env.P}/runs/{other_run}/inputs", other["token"])[0] == 200

    time.sleep(_poll_gap_s(shared_env) + 0.3)
    status, doc, _ = _call(shared_env.server, "GET", path, agent["token"])
    assert status == 200, doc


def test_a_poll_refusal_leaves_the_next_allowed_time_where_it_was(shared_env):
    agent = shared_env.make_agent("poller2")
    run = shared_env.owner_creates_run(agent)
    path = f"{shared_env.P}/runs/{run}/inputs"
    assert _call(shared_env.server, "GET", path, agent["token"])[0] == 200
    for _ in range(3):
        status, doc, _ = _call(shared_env.server, "GET", path, agent["token"])
        assert status == 429 and doc["error"]["details"]["scope"] == "poll"
    # 거절된 요청들이 간격을 계속 미루지 않는다: 간격 + 여유 뒤에는 통과한다.
    time.sleep(_poll_gap_s(shared_env) + 0.3)
    assert _call(shared_env.server, "GET", path, agent["token"])[0] == 200


# ---------------------------------------------------------------------------
# (3) 쿼리스트링 전달

def test_changes_limit_and_cursor_reach_the_api(env):
    agent = env.make_agent("pager")
    env.owner_creates_run(agent)
    status, doc, _ = _call(env.server, "GET", f"{env.P}/changes", "owner")
    assert status == 200
    everything = doc["data"]["events"]
    assert len(everything) >= 3, everything

    status, doc, _ = _call(env.server, "GET", f"{env.P}/changes?limit=1", "owner")
    assert status == 200, doc
    page = doc["data"]
    assert [e["event_seq"] for e in page["events"]] == [everything[0]["event_seq"]]
    assert page["has_more"] is True

    # 받은 next_cursor 로 다음 쪽을 이어 받으면 첫 쪽 다음 사건이 나온다.
    status, doc, _ = _call(env.server, "GET", f"{env.P}/changes?limit=1&cursor={page['next_cursor']}", "owner")
    assert status == 200, doc
    assert [e["event_seq"] for e in doc["data"]["events"]] == [everything[1]["event_seq"]]

    # 끝까지 한 건씩 읽으면 전체와 같다.
    seen, cursor = [], None
    for _ in range(len(everything) + 2):
        query = "limit=1" + (f"&cursor={cursor}" if cursor else "")
        status, doc, _ = _call(env.server, "GET", f"{env.P}/changes?{query}", "owner")
        assert status == 200, doc
        seen.extend(e["event_seq"] for e in doc["data"]["events"])
        cursor = doc["data"]["next_cursor"]
        if not doc["data"]["has_more"]:
            break
    assert seen == [e["event_seq"] for e in everything]


def test_a_tampered_or_foreign_changes_cursor_is_400_cursor_invalid(shared_env):
    agent = shared_env.make_agent("cursor")
    shared_env.owner_creates_run(agent)
    status, doc, _ = _call(shared_env.server, "GET", f"{shared_env.P}/changes?limit=1", "owner")
    owner_cursor = doc["data"]["next_cursor"]
    tampered = owner_cursor[:-2] + ("AA" if not owner_cursor.endswith("AA") else "BB")

    for cursor, who in ((tampered, "owner"), ("not-a-cursor", "owner"), (owner_cursor, agent["token"])):
        status, doc, _ = _call(shared_env.server, "GET", f"{shared_env.P}/changes?cursor={cursor}", who)
        assert status == 400, (cursor, doc)
        error = doc["error"]
        assert error["code"] == "cursor_invalid"
        assert error["retryable"] is False
        assert error["target"] == "$.query.cursor"
        assert HANGUL.search(error["message"])


def test_an_out_of_range_changes_limit_is_a_400_not_ignored(shared_env):
    max_items = int(shared_env.limits["list_max_items"])
    for value in ("0", str(max_items + 1), "abc", "-1"):
        status, doc, _ = _call(shared_env.server, "GET", f"{shared_env.P}/changes?limit={value}", "owner")
        assert status == 400, (value, doc)
        assert doc["error"]["target"] == "$.query.limit"


def test_inputs_wait_ms_and_cursor_reach_the_api(shared_env):
    agent = shared_env.make_agent("waiter")
    run = shared_env.owner_creates_run(agent)
    path = f"{shared_env.P}/runs/{run}/inputs"
    max_wait = int(shared_env.limits["long_poll_max_ms"])

    # 범위 밖 wait_ms 와 잘못된 cursor 는 400 (쿼리가 전달돼야만 나온다).
    status, doc, _ = _call(shared_env.server, "GET", f"{path}?wait_ms={max_wait + 1}", agent["token"])
    assert status == 400, doc
    assert doc["error"]["target"] == "$.query.wait_ms"
    status, doc, _ = _call(shared_env.server, "GET", f"{path}?wait_ms=abc", agent["token"])
    assert status == 400, doc
    status, doc, _ = _call(shared_env.server, "GET", f"{path}?cursor=tampered", agent["token"])
    assert status == 400, doc
    assert doc["error"]["code"] == "cursor_invalid"
    assert doc["error"]["target"] == "$.query.cursor"

    # 거절된 요청은 poll 간격을 쓰지 않으므로 바로 이어서 빈 poll 을 보내도 된다.
    # 입력이 없을 때 wait_ms 만큼 기다렸다가 돌려준다 (기다림 없이 즉시 오면 쿼리가 안 전달된 것).
    wait_ms = 1200
    started = time.monotonic()
    status, doc, _ = _call(shared_env.server, "GET", f"{path}?wait_ms={wait_ms}", agent["token"])
    elapsed = time.monotonic() - started
    assert status == 200, doc
    assert doc["data"]["inputs"] == []
    assert elapsed >= wait_ms / 1000.0 * 0.9, elapsed
