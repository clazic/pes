"""SEL-47 r1-3 회귀 (tester, 회귀 모드): 실제 serve.py 경로. 리뷰: logs/SEL-47-r1-3.md

  N1  인증 전에 나오는 404(미지 경로)·405(잘못된 메서드) 응답이 가짜 자격을 '검증됨'으로 올리지 않는다.
      매번 다른 가짜 Bearer 로 미지 경로·잘못된 메서드·프로젝트 경로를 섞어 보내도(settle 까지 거친다)
      서버 전체 'unverified' 거친 상한(coarse = 에이전트 분당 한도 x 5)을 넘어 Node 까지 가는 요청은 없고 429 가 나온다.
      유효 토큰은 자기 첫 요청이 성공한 뒤에만 자기 예산으로 넘어가, 이후 가짜 폭주가 포화된 뒤에도 계속 쓸 수 있다.

실서버를 격리 HOME/PES_HOME 으로 띄운다. 합성 값만 쓴다.
"""
import json
import shutil
from concurrent.futures import ThreadPoolExecutor

import pytest

from serve_budget import tighten
from test_serve import Server, _make_home
from test_serve_api_r1_regression import _bootstrap, _get, _http

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node 가 필요하다")


@pytest.fixture
def plain(isolated_home, tmp_path, monkeypatch):
    monkeypatch.delenv("PES_LOCAL_SESSION_SECRET", raising=False)
    boot = _bootstrap(isolated_home, "synthetic-r13")
    # 거친 상한 12·에이전트 6/분으로 조인 서버: 수백 번 대신 수십 번 요청으로 같은 성질(429 승격 여부)을 본다.
    tighten(monkeypatch)
    instance = Server(_make_home(isolated_home), tmp_path)
    try:
        instance.start()
        yield instance, boot
    finally:
        instance.stop()


def _coarse(server):
    status, doc, _, _ = _get(server, "/api/v1/capabilities")
    assert status == 200
    # 서버가 실제로 쓰는 거친 상한 = 시험이 넣은 조임 값. (기본 300 = agent 60 의 5배는 test_serve_budget_override 가 --limits 로 확인.)
    from serve_budget import TIGHT
    return TIGHT["coarse_requests_per_minute"]


def _fake_requests(project_id, count):
    """(method, path, token) — 매번 다른 가짜 Bearer, 미지 경로·잘못된 메서드·프로젝트 경로를 번갈아."""
    base = f"/api/v1/projects/{project_id}"
    kinds = [
        ("GET", f"{base}/no-such-route"),                 # 404 not_found (인증 전)
        ("DELETE", f"{base}/context"),                    # 405 (인증 전)
        ("GET", f"{base}/context"),                       # 프로젝트 경로: 인증 단계에서 401
        ("GET", "/api/v1/no-such-top-level"),             # 프로젝트 밖 미지 경로
        ("PATCH", f"{base}/runs"),                        # 405
    ]
    for i in range(count):
        method, path = kinds[i % len(kinds)]
        yield method, path, f"synthetic-fake-token-{i}"


def _send(server, method, path, token):
    status, _, body = _http(server, method, path, b"", {"Authorization": f"Bearer {token}", "Idempotency-Key": f"k-{token}"})
    return status, body


def test_n1_pre_auth_404_and_405_do_not_promote_a_fake_credential(plain):
    server, boot = plain
    ceiling = _coarse(server)
    # 가짜 자격마다 요청 두 번(첫 요청이 404/405 면 승격 버그가 있을 때 두 번째는 자기 예산으로 통과한다).
    items = list(_fake_requests(boot["project_id"], ceiling))
    reached = []   # 429 가 아닌 응답(= Node 까지 갔다)
    limited = []

    def one(item):
        method, path, token = item
        for _ in range(2):
            status, _body = _send(server, method, path, token)
            (limited if status == 429 else reached).append((token, status))

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(one, items))
    assert limited, f"{2 * len(items)} 건의 가짜 자격 요청이 하나도 429 가 아니었다"
    # 한 창 안에서 Node 까지 가는 요청은 거친 상한을 넘지 못한다.
    assert len(reached) <= ceiling, f"Node 까지 간 요청 {len(reached)} > 거친 상한 {ceiling}"


def test_n1_a_fake_credential_that_got_404_is_not_verified_on_its_second_request(plain):
    server, boot = plain
    ceiling = _coarse(server)
    base = f"/api/v1/projects/{boot['project_id']}"
    # 1단계: 서로 다른 가짜 ceiling 개가 각각 404(미지 경로)를 한 번씩 받는다 -> 거친 버킷이 정확히 찬다.
    with ThreadPoolExecutor(max_workers=8) as pool:
        first = list(pool.map(lambda i: _send(server, "GET", f"{base}/no-such-route", f"synthetic-promote-{i}")[0], range(ceiling + 20)))
    assert 429 in first, "거친 상한에서 429 가 나와야 한다"
    # 2단계: 같은 가짜 자격들의 두 번째 요청. 검증됨으로 올랐다면 자기 예산(agent 분당 한도)으로 넘어가 통과한다 -> 안 올랐으면 모두 429.
    second = [_send(server, "GET", f"{base}/no-such-route", f"synthetic-promote-{i}")[0] for i in range(min(40, ceiling + 20))]
    assert all(status == 429 for status in second), f"404 를 받은 가짜 자격이 검증됨으로 올랐다: {sorted(set(second))}"


def test_n1_a_valid_token_moves_to_its_own_budget_only_after_its_first_success(plain):
    server, boot = plain
    ceiling = _coarse(server)
    base = f"/api/v1/projects/{boot['project_id']}"
    token = boot["token"]
    # 첫 요청이 성공(200) -> 이 자격은 검증됨.
    status, doc, text, _ = _get(server, f"{base}/context", token)
    assert status == 200, text
    # 가짜 폭주로 unverified 버킷을 포화시킨다 (미지 경로 404 포함).
    with ThreadPoolExecutor(max_workers=8) as pool:
        flood = list(pool.map(lambda i: _send(server, "GET", f"{base}/no-such-route", f"synthetic-flood-{i}")[0], range(ceiling + 20)))
    assert 429 in flood
    # 검증된 유효 토큰은 포화와 상관없이 자기 예산으로 계속 쓸 수 있다.
    for _ in range(5):
        status, _, text, _ = _get(server, f"{base}/context", token)
        assert status == 200, f"포화된 unverified 버킷이 검증된 토큰을 막았다: {status} {text}"
