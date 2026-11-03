"""Isolated PES environment and reusable synthetic project fixtures."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "pes.py"
REAL_HOME = Path.home()

# Loaded both here and by sitecustomize in the CLI subprocess. Audit hooks cover
# file opens and mutations; Path.stat/lstat additionally cover existence checks.
GUARD = '''
import os
from pathlib import Path
import sys
_forbidden = [os.path.normcase(os.path.abspath(os.path.join(os.environ.get("PES_TEST_REAL_HOME", str(Path.home())), p))) for p in (".pes", "pes-projects")]
def _check(path):
    if not os.environ.get("PES_TEST_GUARD") or not isinstance(path, (str, bytes, os.PathLike)):
        return
    p = os.path.normcase(os.path.abspath(os.fsdecode(path)))
    if any(p == root or p.startswith(root + os.sep) for root in _forbidden):
        raise AssertionError("Access to real PES home forbidden: " + p)
def _audit(event, args):
    if event == "open" or event in ("os.listdir", "os.scandir", "os.remove", "os.rmdir", "os.mkdir", "os.chdir"):
        if args: _check(args[0])
    elif event in ("os.rename", "os.replace", "os.link", "os.symlink"):
        for arg in args[:2]: _check(arg)
sys.addaudithook(_audit)
for _os_name in ("stat", "lstat"):
    _os_original = getattr(os, _os_name)
    def _os_guarded(path, *args, _original=_os_original, **kwargs):
        _check(path)
        return _original(path, *args, **kwargs)
    setattr(os, _os_name, _os_guarded)
for _name in ("stat", "lstat"):
    _original = getattr(Path, _name)
    def _guarded(self, *args, _original=_original, **kwargs):
        _check(self)
        return _original(self, *args, **kwargs)
    setattr(Path, _name, _guarded)
'''
exec(GUARD, {})


@pytest.fixture(autouse=True)
def isolated_home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("PES_HOME", str(home / "pes-projects"))
    monkeypatch.setenv("PES_TEST_REAL_HOME", str(REAL_HOME))
    monkeypatch.setenv("PES_TEST_GUARD", "1")
    monkeypatch.delenv("PES_OWNER", raising=False)
    return home


@pytest.fixture
def pes(isolated_home, monkeypatch):
    spec = importlib.util.spec_from_file_location("pes_test_module", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "CONFIG", isolated_home / ".pes" / "config.json")
    return module


@pytest.fixture
def cli(isolated_home, tmp_path):
    startup = tmp_path / "startup"
    startup.mkdir()
    (startup / "sitecustomize.py").write_text(GUARD, encoding="utf-8")
    def run(*args):
        env = os.environ.copy()
        env["PYTHONPATH"] = str(startup)
        env["PYTHONIOENCODING"] = "utf-8"
        result = subprocess.run([sys.executable, str(SCRIPT)] + list(map(str, args)), env=env,
                                capture_output=True, text=True, encoding="utf-8")
        return result.returncode, result.stdout, result.stderr
    return run


@pytest.fixture
def synthetic_project(tmp_path):
    spec = importlib.util.spec_from_file_location("synthetic_generator", ROOT / "tests" / "fixtures" / "generate.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return lambda kind: module.make_project(tmp_path / kind, kind)
