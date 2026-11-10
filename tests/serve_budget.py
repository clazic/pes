"""serve API 시험이 서버 자식 프로세스에 넣는 조이기 값 (PES_API_BUDGET_TEST_OVERRIDE).

실서버로 요청 한도를 채우는 시험이 수백 번 요청(요청마다 Node 브리지 프로세스)을 보내지 않도록 요청 개수 한도만
작게 줄인다. 창(window_ms)·poll 간격(min_poll_interval_ms)은 줄이면 오히려 한도가 풀리므로 변수가 받지도 않고,
기본값 그대로 둔다. 기본 숫자(60/분 등)는 요청을 퍼붓지 않고 `api_bridge.ts --limits` 출력으로 따로 확인한다
(test_serve_budget_override.py).
"""
import json

ENV_NAME = "PES_API_BUDGET_TEST_OVERRIDE"

TIGHT = {
    "agent_requests_per_minute": 6,
    "agent_control_requests_per_minute": 10,
    "owner_requests_per_minute": 60,
    "coarse_requests_per_minute": 12,
}


def tighten(monkeypatch, override=None):
    """서버를 띄우기 전에 부른다. Server.start 는 os.environ 을 자식에게 그대로 넘긴다."""
    monkeypatch.setenv(ENV_NAME, json.dumps(TIGHT if override is None else override))
    return dict(TIGHT if override is None else override)


def start_shared_server(tmp_path_factory, secret=None, override=None):
    """module 범위 fixture 용 격리 서버. (server, home) 를 돌려준다. 호출한 쪽이 server.stop() 한다.

    함수 범위 isolated_home 과 같은 격리(HOME·USERPROFILE·PES_HOME·실홈 감사 훅)를 모듈 하나가 쓰는 임시 폴더에 만들고,
    서버를 띄우는 순간에만 환경 변수를 바꾼다 (Server.start 는 os.environ 을 자식에게 넘긴다). 띄운 뒤 환경은 원래대로 돌린다.
    """
    from _pytest.monkeypatch import MonkeyPatch
    from conftest import REAL_HOME
    from test_serve import Server, _make_home

    base = tmp_path_factory.mktemp("shared-serve")
    home = base / "home"
    home.mkdir()
    work = base / "work"
    work.mkdir()
    mp = MonkeyPatch()
    server = None
    try:
        mp.setenv("HOME", str(home))
        mp.setenv("USERPROFILE", str(home))
        mp.setenv("PES_HOME", str(home / "pes-projects"))
        mp.setenv("PES_TEST_REAL_HOME", str(REAL_HOME))
        mp.setenv("PES_TEST_GUARD", "1")
        mp.delenv("PES_OWNER", raising=False)
        mp.delenv(ENV_NAME, raising=False)
        if secret is None:
            mp.delenv("PES_LOCAL_SESSION_SECRET", raising=False)
        else:
            mp.setenv("PES_LOCAL_SESSION_SECRET", secret)
        if override is not None:
            mp.setenv(ENV_NAME, json.dumps(override))
        server = Server(_make_home(home), work)
        server.start()
        return server, home
    except BaseException:
        if server is not None:
            server.stop()
        raise
    finally:
        mp.undo()
