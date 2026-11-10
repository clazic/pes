"""SEL-47 최종 리뷰 1/2 회귀 (tester, 회귀 모드): serve.py ApiBudget. 리뷰 전문: logs/SEL-47-final-review-1.md

  S2  매번 다른 가짜 Bearer(또는 세션 헤더)로 보내는 요청, 그리고 프로젝트 밖 경로(project-registrations·
      capabilities·projects)도 서버 전체 상한에 걸려 결국 거절(rate_limited 가 되는 rejection)된다.
      정상 자격 하나의 일반·제어 예산은 그대로다.
  S3  같은 자격으로 창 밖 시각에 환불(형식이 틀린 요청)이 오래 반복돼도 저장된 환불 목록은 창 안 개수로 유지된다.

Node 도 HOME 도 쓰지 않는다: ApiBudget 만 합성 정책·합성 시계로 부른다. 합성 값만 쓴다.
"""
import hashlib
import sys

import pytest

from conftest import ROOT

sys.path.insert(0, str(ROOT / "scripts"))
import serve  # noqa: E402

WINDOW = 60_000
POLICY = {
    "window_ms": WINDOW,
    "agent_requests_per_minute": 60,
    "agent_control_requests_per_minute": 120,
    "owner_requests_per_minute": 600,
    "coarse_requests_per_minute": 300,
    "min_poll_interval_ms": 1000,
    "control_routes": ["POST /api/v1/projects/{id}/runs/{r}/heartbeat"],
    "poll_routes": ["GET /api/v1/projects/{id}/runs/{r}/inputs"],
    "refund_codes": ["invalid_payload", "cursor_invalid"],
}
PROJECT_PATH = "/api/v1/projects/synthetic-project/context"
OUTSIDE_PATHS = [
    ("POST", "/api/v1/project-registrations"),
    ("GET", "/api/v1/capabilities"),
    ("GET", "/api/v1/projects"),
]


class Clock:
    def __init__(self):
        self.now = 1_000_000

    def __call__(self):
        return self.now


@pytest.fixture
def clock(monkeypatch):
    c = Clock()
    monkeypatch.setattr(serve.ApiBudget, "_now", staticmethod(c))
    return c


def _budget():
    return serve.ApiBudget(dict(POLICY))


def _bearer(i):
    return {"authorization": f"Bearer synthetic-fake-token-{i}"}


def _rejections(budget, clock, method, path, headers_for, count):
    rejected = 0
    for i in range(count):
        clock.now += 1  # 5000 건이 5초 안에: 모두 같은 창
        _, rejection = budget.admit(method, path, headers_for(i))
        if rejection is not None:
            rejected += 1
    return rejected


def test_s2_different_fake_bearers_on_a_project_path_end_in_a_rejection(clock):
    budget = _budget()
    rejected = _rejections(budget, clock, "GET", PROJECT_PATH, _bearer, 5000)
    assert rejected > 0, "5000 건의 서로 다른 가짜 Bearer 요청이 하나도 거절되지 않았다 (Node 가 5000번 뜬다)"
    assert 5000 - rejected < 5000, "일부는 통과한다"


def test_s2_different_fake_session_headers_end_in_a_rejection(clock):
    budget = _budget()
    rejected = _rejections(budget, clock, "GET", PROJECT_PATH, lambda i: {"x-pes-session": f"synthetic-fake-session-{i}"}, 5000)
    assert rejected > 0


@pytest.mark.parametrize("method,path", OUTSIDE_PATHS)
def test_s2_paths_outside_a_project_are_bounded_server_wide_too(clock, method, path):
    budget = _budget()
    # 자격 없음, 매번 다른 가짜 자격, 두 경우 모두.
    anonymous = _rejections(budget, clock, method, path, lambda i: {}, 5000)
    assert anonymous > 0, f"{path} 무자격 5000건이 모두 통과했다"
    clock.now += 10 * WINDOW
    fresh = _budget()
    spread = _rejections(fresh, clock, method, path, _bearer, 5000)
    assert spread > 0, f"{path} 서로 다른 가짜 Bearer 5000건이 모두 통과했다"


def test_s2_one_real_credential_keeps_its_ordinary_budget(clock):
    budget = _budget()
    token = {"authorization": "Bearer synthetic-real-token"}
    # 일반 60 건은 모두 통과하고 61번째가 거절된다 (자격 단위 예산은 그대로).
    for i in range(60):
        clock.now += 1
        ticket, rejection = budget.admit("GET", PROJECT_PATH, token)
        assert rejection is None, f"{i + 1} 번째가 거절됐다: {rejection}"
    clock.now += 1
    _, rejection = budget.admit("GET", PROJECT_PATH, token)
    assert rejection is not None and rejection[0] == "general"
    # 제어 경로는 따로 120 건.
    other = {"authorization": "Bearer synthetic-other-token"}
    heartbeat = "/api/v1/projects/synthetic-project/runs/r1/heartbeat"
    for i in range(120):
        clock.now += 1
        _, rejection = budget.admit("POST", heartbeat, other)
        assert rejection is None, f"제어 {i + 1} 번째가 거절됐다: {rejection}"
    clock.now += 1
    _, rejection = budget.admit("POST", heartbeat, other)
    assert rejection is not None and rejection[0] == "control"


def _digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _stored_refunds(budget):
    return [at for key, hits in budget._hits.items() if key.startswith("refund:") for at in hits]


def test_s3_refund_timestamps_outside_the_window_are_not_kept(clock):
    budget = _budget()
    headers = {"authorization": "Bearer synthetic-s3-token"}
    body = b'{"error":{"code":"invalid_payload"}}'
    for _ in range(1000):
        clock.now += WINDOW + 1  # 환불 시각이 매번 이전 창 밖
        ticket, rejection = budget.admit("GET", PROJECT_PATH, headers)
        assert rejection is None
        budget.settle(ticket, 400, body)
    kept = _stored_refunds(budget)
    assert kept, "마지막 환불은 창 안이라 남는다"
    assert all(at > clock.now - WINDOW for at in kept), "창 밖 환불 시각이 남아 있다"
    assert len(kept) <= 2, f"저장된 환불 목록이 {len(kept)} 개로 자랐다 (창 안 개수는 1)"


def test_s3_refunds_inside_the_window_still_count_toward_the_coarse_ceiling(clock):
    budget = _budget()
    headers = {"authorization": "Bearer synthetic-s3-inside"}
    body = b'{"error":{"code":"invalid_payload"}}'
    refused_at = None
    for i in range(400):
        clock.now += 1
        ticket, rejection = budget.admit("GET", PROJECT_PATH, headers)
        if rejection is not None:
            refused_at = i
            break
        budget.settle(ticket, 400, body)
    assert refused_at is not None, "창 안의 환불은 거친 상한(300)까지만 공짜다"
    assert refused_at >= 300
