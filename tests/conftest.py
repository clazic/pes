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
GUARD = r'''
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
def _strip_namespace(path):
    # os.readlink() on Windows returns NT namespace paths: the extended-length
    # prefix before a drive path, or the UNC form of it. Strip the prefix the
    # way ntpath.realpath() does, so comparisons see the ordinary path. POSIX
    # paths may legitimately contain backslash characters.
    if os.name != "nt":
        return path
    for prefix in ("\\\\?\\", "\\??\\"):
        if not path.startswith(prefix):
            continue
        rest = path[len(prefix):]
        if rest[:4].upper() == "UNC\\":
            return "\\\\" + rest[4:]
        if len(rest) >= 3 and rest[1:3] == ":\\":
            return rest
        # Volume GUID and other namespace paths cannot be stripped safely.
        return path
    return path
def _normalize(path):
    return os.path.normcase(os.path.normpath(_strip_namespace(path)))
def _roots(home, resolved_home):
    return tuple(_normalize(os.path.join(base, name))
                 for base in (os.path.abspath(home), resolved_home)
                 for name in (".pes", "pes-projects"))
_original_roots = _roots(_original_home, _real_home)
_extra_roots = {}

def _reject(path, roots):
    normalized = _normalize(path)
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
                    target = _strip_namespace(_readlink(current))
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
# No test may reach a REAL PES hub (127.0.0.1:8760~8775, /whoami returns the real project root). Same rule as tests/helpers/hub_block.ts.
HUB_BLOCK = r'''
import socket as _hb_socket
def _hb_port(address):
    try:
        return 8760 <= int(address[1]) <= 8775
    except Exception:
        return False
_hb_connect_ex = _hb_socket.socket.connect_ex
_hb_connect = _hb_socket.socket.connect
def _hb_socket_connect_ex(self, address):
    return 111 if _hb_port(address) else _hb_connect_ex(self, address)
def _hb_socket_connect(self, address):
    if _hb_port(address):
        raise ConnectionRefusedError(111, "blocked by the test harness")
    return _hb_connect(self, address)
_hb_socket.socket.connect_ex = _hb_socket_connect_ex
_hb_socket.socket.connect = _hb_socket_connect
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


@pytest.fixture(autouse=True)
def no_real_hub(monkeypatch):
    import socket
    real_connect, real_connect_ex = socket.socket.connect, socket.socket.connect_ex
    def port_blocked(address):
        try:
            return 8760 <= int(address[1]) <= 8775
        except Exception:
            return False
    def connect(self, address):
        if port_blocked(address):
            raise ConnectionRefusedError(111, "blocked by the test harness")
        return real_connect(self, address)
    def connect_ex(self, address):
        return 111 if port_blocked(address) else real_connect_ex(self, address)
    monkeypatch.setattr(socket.socket, "connect", connect)
    monkeypatch.setattr(socket.socket, "connect_ex", connect_ex)


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
    (startup / "sitecustomize.py").write_text(GUARD + HUB_BLOCK, encoding="utf-8")
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
