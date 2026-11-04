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
    from conftest import PESHomeAccessViolation, REAL_HOME
    for folder in (".pes", "pes-projects"):
        with pytest.raises(PESHomeAccessViolation, match="real PES home"):
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


def test_guard_exception_escapes_product_exception_handler(pes, tmp_path, monkeypatch):
    from conftest import PESHomeAccessViolation
    fake_home = tmp_path / "fake real home"
    config = fake_home / ".pes" / "config.json"
    config.parent.mkdir(parents=True)
    config.write_text('{"home": "synthetic"}', encoding="utf-8")
    monkeypatch.setenv("PES_TEST_REAL_HOME", str(fake_home))
    monkeypatch.delenv("PES_HOME")
    monkeypatch.setattr(pes, "CONFIG", config)
    with pytest.raises(PESHomeAccessViolation, match="real PES home"):
        pes.pes_home()


@pytest.mark.parametrize("folder", [".pes", "pes-projects"])
@pytest.mark.parametrize("operation", ["read", "write"])
def test_guard_blocks_symlink_aliases(tmp_path, monkeypatch, folder, operation):
    from conftest import PESHomeAccessViolation
    fake_home = tmp_path / "fake real home"
    protected = fake_home / folder
    protected.mkdir(parents=True)
    (protected / "existing.json").write_text("synthetic", encoding="utf-8")
    alias = tmp_path / "alias"
    try:
        alias.symlink_to(protected, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("Creating directory symlinks is unavailable")
    monkeypatch.setenv("PES_TEST_REAL_HOME", str(fake_home))
    with pytest.raises(PESHomeAccessViolation, match="real PES home"):
        if operation == "read":
            (alias / "existing.json").read_text(encoding="utf-8")
        else:
            (alias / "new.json").write_text("synthetic", encoding="utf-8")


def test_cli_helper_fails_on_guard_violation(cli, tmp_path, monkeypatch):
    fake_home = tmp_path / "fake real home"
    (fake_home / ".pes").mkdir(parents=True)
    monkeypatch.setenv("PES_TEST_REAL_HOME", str(fake_home))
    monkeypatch.setenv("HOME", str(fake_home))
    monkeypatch.setenv("USERPROFILE", str(fake_home))
    with pytest.raises(pytest.fail.Exception, match="CLI attempted to access protected PES data"):
        cli("remote")


@pytest.mark.parametrize("folder", [".pes", "pes-projects"])
def test_guard_never_probes_protected_paths(tmp_path, monkeypatch, folder):
    import os
    from conftest import PESHomeAccessViolation, _guard_namespace

    fake_home = tmp_path / "fake home"
    protected = fake_home / folder
    protected.mkdir(parents=True)
    (protected / "existing.json").write_text("synthetic", encoding="utf-8")
    safe = tmp_path / "safe.txt"
    safe.write_text("safe", encoding="utf-8")
    alias = tmp_path / "linked directory"
    try:
        alias.symlink_to(protected, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("Creating directory symlinks is unavailable")

    monkeypatch.setenv("PES_TEST_REAL_HOME", str(fake_home))
    observed = []
    original_lstat = _guard_namespace["_lstat"]
    original_readlink = _guard_namespace["_readlink"]

    def record_lstat(path, *args, **kwargs):
        observed.append(("lstat", os.path.normcase(os.path.abspath(path))))
        return original_lstat(path, *args, **kwargs)

    def record_readlink(path, *args, **kwargs):
        observed.append(("readlink", os.path.normcase(os.path.abspath(path))))
        return original_readlink(path, *args, **kwargs)

    monkeypatch.setitem(_guard_namespace, "_lstat", record_lstat)
    monkeypatch.setitem(_guard_namespace, "_readlink", record_readlink)
    assert safe.read_text(encoding="utf-8") == "safe"
    with pytest.raises(PESHomeAccessViolation):
        (protected / "existing.json").read_text(encoding="utf-8")
    with pytest.raises(PESHomeAccessViolation):
        (alias / "existing.json").read_text(encoding="utf-8")
    with pytest.raises(PESHomeAccessViolation):
        (alias / "missing.json").write_text("synthetic", encoding="utf-8")

    protected_path = os.path.normcase(os.path.abspath(protected))
    assert observed
    assert any(kind == "readlink" and path == os.path.normcase(os.path.abspath(alias))
               for kind, path in observed)
    assert not [entry for entry in observed
                if entry[1] == protected_path or entry[1].startswith(protected_path + os.sep)]
