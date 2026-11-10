"""serve API 시험이 서버 자식 프로세스에 넣는 조이기 값 (PES_API_BUDGET_TEST_OVERRIDE).

실서버로 요청 한도를 채우는 시험이 수백 번 요청(요청마다 Node 브리지 프로세스)을 보내지 않도록 한도 숫자만
작게 줄인다. 창(window_ms)은 그대로 둬서 "한 창 안에서" 성질은 같다. 기본 숫자(60/분 등)는 요청을 퍼붓지 않고
`api_bridge.ts --limits` 출력으로 따로 확인한다 (test_serve_budget_override.py).
"""
import json

ENV_NAME = "PES_API_BUDGET_TEST_OVERRIDE"

TIGHT = {
    "agent_requests_per_minute": 6,
    "agent_control_requests_per_minute": 10,
    "owner_requests_per_minute": 60,
    "coarse_requests_per_minute": 12,
    "min_poll_interval_ms": 500,
}


def tighten(monkeypatch, override=None):
    """서버를 띄우기 전에 부른다. Server.start 는 os.environ 을 자식에게 그대로 넘긴다."""
    monkeypatch.setenv(ENV_NAME, json.dumps(TIGHT if override is None else override))
    return dict(TIGHT if override is None else override)
