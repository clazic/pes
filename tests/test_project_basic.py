import json
from pathlib import Path
import sys
import time
import warnings

import pytest

STAGES = ("plan", "research", "analyze", "write", "verify", "publish")


def test_isolated_home(pes, isolated_home, monkeypatch):
    assert Path.home() == isolated_home
    assert pes.pes_home() == isolated_home / "pes-projects"
    assert pes.CONFIG == isolated_home / ".pes" / "config.json"
    monkeypatch.delenv("PES_HOME")
    assert pes.pes_home() == isolated_home / "pes-projects"


def test_guard_rejects_real_home(monkeypatch):
    from conftest import REAL_HOME
    for folder in (".pes", "pes-projects"):
        with pytest.raises(AssertionError, match="real PES home"):
            (REAL_HOME / folder / "project.json").exists()


def test_cli_init_and_duplicate(cli, tmp_path):
    project = tmp_path / "한글 공백 경로" / "새 프로젝트"
    code, out, err = cli("init", project, "--topic", "합성 주제")
    assert code == 0, (out, err)
    data = json.loads((project / "project.json").read_text(encoding="utf-8"))
    assert data["pes"] == 1
    assert data["topic"] == "합성 주제"
    assert data["slug"] == "새 프로젝트"
    assert data["current"] == "plan"
    assert set(data["stages"]) == set(STAGES)
    assert data["stages"]["plan"]["status"] == "asking"
    assert all(data["stages"][s]["status"] == "pending" for s in STAGES[1:])
    assert data["processed"] == [] and data["settings"] == {} and data["complete"] is False
    before = (project / "project.json").read_bytes()
    code, out, err = cli("init", project, "--topic", "다른 주제")
    assert code == 2, (out, err)
    assert (project / "project.json").read_bytes() == before


def test_load_fills_legacy_fields(pes, synthetic_project):
    data = pes.load(synthetic_project("legacy"))
    assert set(data["stages"]) == set(STAGES)
    assert data["processed"] == [] and data["notes"] == []
    plan = data["stages"]["plan"]
    assert plan["status"] == "pending" and plan["round"] == 0
    assert plan["settings"] == {} and plan["reports"] == []
    item = plan["items"][0]
    assert item["id"] == 1 and item["title"] == "합성 항목"
    assert item["status"] == "new" and item["sources"] == [] and item["links"] == {}


def test_load_broken_json(pes, synthetic_project):
    with pytest.raises(json.JSONDecodeError):
        pes.load(synthetic_project("broken"))


def test_large_project_load_save(pes, synthetic_project):
    project = synthetic_project("large")
    assert 2 * 1024 * 1024 <= (project / "project.json").stat().st_size < 3 * 1024 * 1024
    start = time.perf_counter()
    data = pes.load(project)
    loaded = time.perf_counter()
    pes.save(project, data)
    saved = time.perf_counter()
    warnings.warn("Synthetic 2MB project: load {:.3f}s, save {:.3f}s".format(loaded - start, saved - loaded))
    assert json.loads((project / "project.json").read_text(encoding="utf-8"))["synthetic_payload"] == data["synthetic_payload"]


def test_main_explicit_argv_init(pes, tmp_path):
    project = tmp_path / "명시 경로"
    pes.main(["init", str(project), "--topic", "주제"])
    assert json.loads((project / "project.json").read_text(encoding="utf-8"))["topic"] == "주제"


def test_main_default_argv_init(pes, tmp_path, monkeypatch):
    project = tmp_path / "기본 경로"
    monkeypatch.setattr(sys, "argv", ["pes.py", "init", str(project), "--topic", "주제"])
    pes.main()
    assert json.loads((project / "project.json").read_text(encoding="utf-8"))["topic"] == "주제"


@pytest.mark.parametrize("argv", [[], ["unknown", "project"]])
def test_main_invalid_command_prints_usage(pes, capsys, argv):
    with pytest.raises(SystemExit) as exc:
        pes.main(argv)
    assert exc.value.code == 1
    assert pes.__doc__.strip() in capsys.readouterr().out


def test_main_preserves_die_exit_code(pes, tmp_path):
    project = tmp_path / "duplicate"
    project.mkdir()
    (project / "project.json").write_text("{}", encoding="utf-8")
    with pytest.raises(SystemExit) as exc:
        pes.main(["init", str(project), "--topic", "주제"])
    assert exc.value.code == 2


@pytest.mark.parametrize("command", ["list", "hub", "home", "doctor", "stop", "remote"])
def test_main_single_argument_dispatch_does_not_mutate_argv(pes, monkeypatch, command):
    received = []
    monkeypatch.setitem(pes.CMDS, command, lambda args: received.append(args))
    argv = [command]
    pes.main(argv)
    assert argv == [command]
    assert received == [["--"]]


@pytest.mark.parametrize("command", ["list", "home", "remote"])
def test_main_matches_subprocess_for_safe_single_command(pes, cli, capsys, command):
    code, stdout, stderr = cli(command)
    pes.main([command])
    captured = capsys.readouterr()
    assert (code, stdout, stderr) == (0, captured.out, captured.err)


@pytest.mark.parametrize("command", ["init", "status", "unknown"])
def test_main_single_non_special_command_prints_usage(pes, capsys, command):
    argv = [command]
    with pytest.raises(SystemExit) as exc:
        pes.main(argv)
    assert exc.value.code == 1
    assert pes.__doc__.strip() in capsys.readouterr().out
    assert argv == [command]


def test_main_default_argv_does_not_mutate_sys_argv(pes, monkeypatch):
    seen = []
    monkeypatch.setitem(pes.CMDS, "home", lambda args: seen.append(args))
    argv = ["pes.py", "home"]
    monkeypatch.setattr(sys, "argv", argv)
    pes.main()
    assert argv == ["pes.py", "home"]
    assert seen == [["--"]]


def test_main_passes_multiple_arguments_unchanged(pes, monkeypatch):
    received = []
    monkeypatch.setitem(pes.CMDS, "init", lambda args: received.append(args))
    argv = ["init", "경로 공백", "--topic", "합성 주제"]
    pes.main(argv)
    assert argv == ["init", "경로 공백", "--topic", "합성 주제"]
    assert received == [["경로 공백", "--topic", "합성 주제"]]
