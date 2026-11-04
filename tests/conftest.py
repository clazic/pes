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
import threading
import stat

class PESHomeAccessViolation(BaseException):
    """A test attempted to access protected PES data."""

_original_home = os.environ.get("PES_TEST_REAL_HOME", str(Path.home()))
# Resolve only the home itself; never resolve either protected directory.
_real_home = os.path.realpath(_original_home)
_lstat = os.lstat
_readlink = os.readlink
_check_state = threading.local()
def _roots(home, resolved_home):
    return tuple(os.path.normcase(os.path.join(base, name))
                 for base in (os.path.abspath(home), resolved_home)
                 for name in (".pes", "pes-projects"))
_original_roots = _roots(_original_home, _real_home)
_extra_roots = {}

def _reject(path, roots):
    normalized = os.path.normcase(os.path.normpath(path))
    for root in roots:
        if normalized == root or normalized.startswith(root + os.sep):
            raise PESHomeAccessViolation("Access to real PES home forbidden: " + normalized)

def _resolve(path, roots):
    # Resolve one component at a time, rejecting a protected component before
    # its lstat or readlink. Nonexistent suffixes are handled the same way.
    path = os.path.abspath(path)
    _reject(path, roots)
    links = 0
    while True:
        drive, tail = os.path.splitdrive(path)
        current = drive + os.sep
        components = [part for part in tail.replace(os.altsep or os.sep, os.sep).split(os.sep) if part]
        for index, part in enumerate(components):
            current = os.path.join(current, part)
            _reject(current, roots)
            try:
                info = _lstat(current)
            except OSError:
                continue
            reparse = getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
            if stat.S_ISLNK(info.st_mode) or reparse:
                try:
                    target = _readlink(current)
                except OSError:
                    # An opaque reparse point could hide a protected target.
                    raise PESHomeAccessViolation("Cannot safely resolve reparse point: " + current)
                links += 1
                if links > 40:
                    raise OSError("Too many symbolic links")
                if not os.path.isabs(target):
                    target = os.path.join(os.path.dirname(current), target)
                path = os.path.abspath(os.path.join(target, *components[index + 1:]))
                _reject(path, roots)
                break
        else:
            return current

def _check(path):
    if (not os.environ.get("PES_TEST_GUARD") or
            not isinstance(path, (str, bytes, os.PathLike)) or
            getattr(_check_state, "active", False)):
        return
    _check_state.active = True
    try:
        home = os.environ.get("PES_TEST_REAL_HOME", _original_home)
        if home != _original_home and home not in _extra_roots:
            # Fake homes used by tests are resolved under the original guard.
            resolved_home = _resolve(home, _original_roots)
            _extra_roots[home] = _roots(home, resolved_home)
        roots = _original_roots + _extra_roots.get(home, ())
        _resolve(os.fsdecode(path), roots)
    finally:
        _check_state.active = False
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
_guard_namespace = {}
exec(GUARD, _guard_namespace)
PESHomeAccessViolation = _guard_namespace["PESHomeAccessViolation"]


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
                                capture_output=True, text=True, encoding="utf-8", timeout=60)
        if "PESHomeAccessViolation" in result.stderr:
            pytest.fail("CLI attempted to access protected PES data: " + result.stderr)
        return result.returncode, result.stdout, result.stderr
    return run


@pytest.fixture
def synthetic_project(tmp_path):
    spec = importlib.util.spec_from_file_location("synthetic_generator", ROOT / "tests" / "fixtures" / "generate.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return lambda kind: module.make_project(tmp_path / kind, kind)
