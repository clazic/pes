"""SEL-47: 시험 전용 조이기 변수 PES_API_BUDGET_TEST_OVERRIDE (serve.py).

  - 변수가 없으면 기본 한도 그대로다 (api_bridge.ts --limits 출력 = ApiApp.budget_policy 로 확인, 요청을 퍼붓지 않는다).
  - 모르는 키·양의 정수 아님·0 이하·기본값 초과·JSON 아님이면 서버가 뜨지 않고 오류 메시지와 함께 종료한다.
  - 올바른 값(기본값 이하)은 실제로 적용된다: agent 한도와 창(window_ms)이 줄어든다.

모든 프로세스는 conftest 의 격리 HOME/PES_HOME 에서만 실행한다. 합성 자료만 쓴다.
"""
import json
import os
import shutil
import subprocess
import sys
import time

import pytest

from conftest import ROOT
from serve_budget import ENV_NAME
from test_serve import Server, _free_port, _make_home
from test_serve_api_r1_regression import SCOPES, _bootstrap, _get

SERVE = ROOT / "scripts" / "serve.py"
BRIDGE = ROOT / "scripts" / "pes_core" / "api_bridge.ts"

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node 가 필요하다")

DEFAULTS = {
    "window_ms": 60000,
    "agent_requests_per_minute": 60,
    "agent_control_requests_per_minute": 120,
    "owner_requests_per_minute": 600,
    "coarse_requests_per_minute": 300,
    "min_poll_interval_ms": 1000,
}


def _child_env(isolated_home, value):
    env = dict(os.environ)
    env.pop("PES_LOCAL_SESSION_SECRET", None)
    env.pop(ENV_NAME, None)
    env.update({"HOME": str(isolated_home), "USERPROFILE": str(isolated_home),
                "PES_HOME": str(isolated_home / "pes-projects")})
    if value is not None:
        env[ENV_NAME] = value
    return env


def _node_limits(isolated_home):
    out = subprocess.run([shutil.which("node"), str(BRIDGE), "--limits"], cwd=str(ROOT),
                         env=_child_env(isolated_home, None), capture_output=True, timeout=60)
    assert out.returncode == 0, out.stderr.decode("utf-8", "replace")
    return json.loads(out.stdout.decode("utf-8"))


def test_the_default_policy_from_the_bridge_is_unchanged(isolated_home):
    policy = _node_limits(isolated_home)
    for key, value in DEFAULTS.items():
        assert policy[key] == value, (key, policy[key])
    # 거친 상한은 agent 한도의 5배, 제어 경로 한도는 agent 의 2배.
    assert policy["coarse_requests_per_minute"] == policy["agent_requests_per_minute"] * 5
    assert policy["agent_control_requests_per_minute"] == policy["agent_requests_per_minute"] * 2


def _run_serve(isolated_home, tmp_path, value):
    """serve.py 를 직접 띄운다. 일찍 끝나면 (종료 코드, stderr+stdout), 15초 안에 안 끝나면 (None, 출력)."""
    root = _make_home(isolated_home)
    guard = Server(root, tmp_path)   # 실제 홈 접근 감사 훅(sitecustomize)을 만들어 쓴다.
    env = _child_env(isolated_home, value)
    env["PYTHONPATH"] = str(guard.startup)
    env["PYTHONIOENCODING"] = "utf-8"
    proc = subprocess.Popen([sys.executable, str(SERVE), str(root), str(_free_port())],
                            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env)
    try:
        try:
            out, _ = proc.communicate(timeout=15)
            return proc.returncode, out.decode("utf-8", "replace")
        except subprocess.TimeoutExpired:
            return None, ""
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.communicate()


BAD = [
    pytest.param("not json", id="json-아님"),
    pytest.param("[1, 2]", id="배열"),
    pytest.param("5", id="숫자"),
    pytest.param('{"unknown_limit": 3}', id="모르는-키"),
    pytest.param('{"agent_requests_per_minute": 3, "typo_per_minute": 3}', id="맞는-키-옆-모르는-키"),
    pytest.param('{"agent_requests_per_minute": 0}', id="0"),
    pytest.param('{"agent_requests_per_minute": -3}', id="음수"),
    pytest.param('{"agent_requests_per_minute": "3"}', id="문자열-숫자"),
    pytest.param('{"agent_requests_per_minute": 2.5}', id="소수"),
    pytest.param('{"agent_requests_per_minute": true}', id="불리언"),
    pytest.param('{"agent_requests_per_minute": null}', id="null"),
    pytest.param('{"window_ms": 60001}', id="window_ms-기본값-초과"),
    pytest.param('{"agent_requests_per_minute": 61}', id="agent-기본값-초과"),
    pytest.param('{"agent_control_requests_per_minute": 121}', id="control-기본값-초과"),
    pytest.param('{"owner_requests_per_minute": 601}', id="owner-기본값-초과"),
    pytest.param('{"coarse_requests_per_minute": 301}', id="coarse-기본값-초과"),
    pytest.param('{"min_poll_interval_ms": 1001}', id="poll-기본값-초과"),
    pytest.param('{"agent_requests_per_minute": 3, "coarse_requests_per_minute": 301}', id="일부만-초과"),
]


@pytest.mark.parametrize("value", BAD)
def test_an_invalid_override_stops_the_server_with_a_message(isolated_home, tmp_path, value):
    code, output = _run_serve(isolated_home, tmp_path, value)
    assert code is not None, "잘못된 값인데 서버가 계속 떠 있다 (조용히 무시했다)"
    assert code != 0, output
    assert ENV_NAME in output, output   # 어떤 변수가 문제인지 알려 준다
    assert "serving" not in output, output


@pytest.mark.parametrize("value", [json.dumps(DEFAULTS), '{"agent_requests_per_minute": 1}', "{}"])
def test_a_valid_override_lets_the_server_start(isolated_home, tmp_path, monkeypatch, value):
    monkeypatch.setenv(ENV_NAME, value)
    server = Server(_make_home(isolated_home), tmp_path)
    try:
        server.start()   # 준비 확인(/whoami)까지 통과해야 한다
    finally:
        server.stop()


def test_without_the_variable_the_server_serves_with_the_default_budget(isolated_home, tmp_path, monkeypatch):
    monkeypatch.delenv("PES_LOCAL_SESSION_SECRET", raising=False)
    monkeypatch.delenv(ENV_NAME, raising=False)
    boot = _bootstrap(isolated_home, "synthetic-ovr")
    server = Server(_make_home(isolated_home), tmp_path)
    try:
        server.start()
        status, doc, _, _ = _get(server, "/api/v1/capabilities")
        assert status == 200
        assert int(doc["data"]["capabilities"]["limits"]["agent_requests_per_minute"]) == DEFAULTS["agent_requests_per_minute"]
        # 기본 한도라면 3번째 요청이 429 가 아니다 (조이기가 새어 들어오지 않았다).
        for i in range(4):
            status, _, text, _ = _get(server, f"/api/v1/projects/{boot['project_id']}/context", boot["token"])
            assert status == 200, (i, text)
    finally:
        server.stop()


def test_an_override_narrows_the_agent_limit_and_the_window(isolated_home, tmp_path, monkeypatch):
    monkeypatch.delenv("PES_LOCAL_SESSION_SECRET", raising=False)
    boot = _bootstrap(isolated_home, "synthetic-ovr2")
    monkeypatch.setenv(ENV_NAME, json.dumps({"agent_requests_per_minute": 3, "window_ms": 2000}))
    server = Server(_make_home(isolated_home), tmp_path)
    try:
        server.start()
        path = f"/api/v1/projects/{boot['project_id']}/context"
        for i in range(3):
            status, _, text, _ = _get(server, path, boot["token"])
            assert status == 200, (i, text)
        status, doc, _, headers = _get(server, path, boot["token"])
        assert status == 429, doc
        assert doc["error"]["code"] == "rate_limited" and doc["error"]["details"]["scope"] == "general"
        # 창이 2초로 줄었으니 재시도 대기는 2초를 넘지 않는다 (기본 창이면 최대 60초).
        assert 0 < doc["error"]["details"]["retry_after_ms"] <= 2000, doc
        time.sleep(2.4)
        status, _, text, _ = _get(server, path, boot["token"])
        assert status == 200, text
    finally:
        server.stop()
