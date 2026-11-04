"""pes.py 잠금: 소유자·만료·인계 동작을 실제 CLI 프로세스로 고정한다."""
import json
import time

import pytest


def _lock_path(project):
    return project / ".pes-lock"


def _lock(project):
    return json.loads(_lock_path(project).read_text(encoding="utf-8"))


def _make_stale(project, seconds):
    """잠금 기록 시각만 과거로 옮긴다 (파일 시각을 기다리지 않는다)."""
    data = _lock(project)
    data["at"] = time.time() - seconds
    _lock_path(project).write_text(json.dumps(data), encoding="utf-8")


def test_lock_requires_owner(cli, synthetic_project):
    project = synthetic_project("legacy")
    code, out, err = cli("lock", project)
    assert code == 2, (out, err)
    assert "PES_OWNER" in err
    assert not _lock_path(project).exists()


def test_other_owner_is_rejected_with_exit_code_3(cli, synthetic_project, monkeypatch):
    project = synthetic_project("legacy")
    before = (project / "project.json").read_bytes()

    monkeypatch.setenv("PES_OWNER", "alice-session")
    code, out, err = cli("lock", project)
    assert code == 0, (out, err)
    lock = _lock(project)
    assert lock["owner"] == "alice-session"
    assert lock["since"]

    monkeypatch.setenv("PES_OWNER", "bob-session")
    code, out, err = cli("lock", project)
    assert code == 3, (out, err)
    assert "다른 세션이 사용 중" in err
    assert _lock(project)["owner"] == "alice-session"

    # 쓰기 명령도 같은 이유로 거부되고 project.json 은 그대로다.
    code, out, err = cli("note", project, "합성 메모")
    assert code == 3, (out, err)
    assert "다른 세션이 이 프로젝트를 쓰고 있습니다" in err
    assert (project / "project.json").read_bytes() == before


def test_same_owner_refresh_keeps_since(cli, synthetic_project, monkeypatch):
    project = synthetic_project("legacy")
    monkeypatch.setenv("PES_OWNER", "alice-session")
    assert cli("lock", project)[0] == 0
    first = _lock(project)
    assert first["owner"] == "alice-session"

    data = _lock(project)
    data["since"] = "2026-01-01 00:00"
    old_at = time.time() - (2 * 3600 - 300)  # 아직 살아 있는 잠금이되 갱신 전 시각
    data["at"] = old_at
    _lock_path(project).write_text(json.dumps(data), encoding="utf-8")

    code, out, err = cli("lock", project)
    assert code == 0, (out, err)
    refreshed = _lock(project)
    assert refreshed["owner"] == "alice-session"
    assert refreshed["since"] == "2026-01-01 00:00"
    assert refreshed["at"] > old_at


def test_expired_lock_can_be_taken_over(cli, synthetic_project, monkeypatch):
    project = synthetic_project("legacy")
    monkeypatch.setenv("PES_OWNER", "alice-session")
    assert cli("lock", project)[0] == 0
    _make_stale(project, 2 * 3600 + 10)

    monkeypatch.setenv("PES_OWNER", "bob-session")
    code, out, err = cli("lock", project)
    assert code == 0, (out, err)
    assert _lock(project)["owner"] == "bob-session"

    # 만료된 잠금은 쓰기 명령도 막지 않는다.
    _make_stale(project, 2 * 3600 + 10)
    code, out, err = cli("note", project, "만료 뒤 인계")
    assert code == 0, (out, err)
    assert _lock(project)["owner"] == "bob-session"


def test_force_lock_and_unlock_handoff(cli, synthetic_project, monkeypatch):
    project = synthetic_project("legacy")
    monkeypatch.setenv("PES_OWNER", "alice-session")
    assert cli("lock", project)[0] == 0

    monkeypatch.setenv("PES_OWNER", "bob-session")
    code, out, err = cli("unlock", project)
    assert code == 3, (out, err)
    assert "다른 세션의 잠금" in err
    assert _lock_path(project).exists()

    code, out, err = cli("lock", project, "--force")
    assert code == 0, (out, err)
    assert _lock(project)["owner"] == "bob-session"

    monkeypatch.setenv("PES_OWNER", "alice-session")
    code, out, err = cli("unlock", project)
    assert code == 3, (out, err)
    assert _lock_path(project).exists()

    monkeypatch.setenv("PES_OWNER", "bob-session")
    code, out, err = cli("unlock", project)
    assert code == 0, (out, err)
    assert not _lock_path(project).exists()

    monkeypatch.setenv("PES_OWNER", "alice-session")
    code, out, err = cli("lock", project)
    assert code == 0, (out, err)
    assert _lock(project)["owner"] == "alice-session"


def test_lock_info_live_boundary(pes, synthetic_project, monkeypatch):
    class FrozenTime:
        def __init__(self, value):
            self.value = value

        def time(self):
            return self.value

        def strftime(self, fmt, *args):
            return time.strftime(fmt, *args)

    fixed = 2_000_000_000
    monkeypatch.setattr(pes, "time", FrozenTime(fixed))
    project = synthetic_project("legacy")
    pes.write_lock(project, "alice-session")
    info = pes.lock_info(project)
    assert info["owner"] == "alice-session"
    assert info["age"] == 0
    assert info["live"] is True
    assert pes.LOCK_TTL == 2 * 3600

    data = _lock(project)
    data["at"] = fixed - (pes.LOCK_TTL - 1)
    _lock_path(project).write_text(json.dumps(data), encoding="utf-8")
    assert pes.lock_info(project)["live"] is True

    data["at"] = fixed - pes.LOCK_TTL
    _lock_path(project).write_text(json.dumps(data), encoding="utf-8")
    assert pes.lock_info(project)["live"] is False

    data["at"] = fixed - (pes.LOCK_TTL + 1)
    _lock_path(project).write_text(json.dumps(data), encoding="utf-8")
    assert pes.lock_info(project)["live"] is False
