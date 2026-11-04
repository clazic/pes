"""scripts/serve.py: 답 수신·거부·미처리 답 유지·상태 응답을 실제 서버 프로세스로 고정한다."""
import builtins
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

import pytest

from conftest import GUARD, ROOT

SERVE = ROOT / "scripts" / "serve.py"
MAX_BODY = 256 * 1024
HTTP_TIMEOUT = 30
# 배리어는 HTTP 타임아웃보다 훨씬 짧게 둔다. 결함을 잠금으로 직렬화한 서버에서도
# 첫 요청이 잠깐 기다린 뒤 정상 진행해 모든 요청이 끝나야 한다 (SEL-31 수정 대비).
BARRIER_TIMEOUT = 3

# 충돌 재현용: 서버 안에서만 시각을 고정하고 같은 후보 파일의 exists() 구간에
# 배리어를 넣어, 경쟁이 우연에 기대지 않게 만든다 (제품 코드는 건드리지 않는다).
COLLISION_STAGE = "plan"
COLLISION_ROUND = 1
COLLISION_TS = "20260101-000000"
COLLISION_COUNT = 12
COLLISION_NAME = f"{COLLISION_STAGE}-R{COLLISION_ROUND}-{COLLISION_TS}.json"


class AnswerLoss(AssertionError):
    """같은 초 동시 제출로 답 파일이 덮어써져 사라진 경우 (SEL-31에서 고칠 결함)."""


def _free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _collision_injection(directory, name, count, serialize=False):
    """serve.py 를 띄운 자식 프로세스에만 적용하는 테스트용 동기화 주입."""
    serialized = """
# 직렬화된(고친) 서버 양성 대조: 한 번에 한 요청만 처리하도록 잠금을 건다.
import http.server as _race_http
import threading as _race_lock_threading
_race_http.HTTPServer.request_queue_size = 64
_race_handler_lock = _race_lock_threading.Lock()
_race_handle_one = _race_http.BaseHTTPRequestHandler.handle_one_request
def _race_serialized(self):
    with _race_handler_lock:
        return _race_handle_one(self)
_race_http.BaseHTTPRequestHandler.handle_one_request = _race_serialized
""" if serialize else ""
    return '''
# ---- SEL-13 test-only: deterministic same-second feedback filename race ----
import os as _race_os
import threading as _race_threading
import time as _race_time
from pathlib import Path as _RacePath
%(serialized)s
_race_time.strftime = lambda *_args, **_kwargs: %(ts)r
_race_dir = %(directory)r
_race_name = %(name)r
_race_count = %(count)d
_race_first = _race_threading.Barrier(_race_count)
_race_second = _race_threading.Barrier(_race_count)
_race_original_exists = _RacePath.exists

def _race_exists(self):
    try:
        candidate = (self.name == _race_name and
                     _race_os.path.normcase(str(self.parent)) == _race_os.path.normcase(_race_dir))
    except Exception:
        candidate = False
    if not candidate:
        return _race_original_exists(self)
    try:
        _race_first.wait(timeout=%(barrier)d)
        found = _race_original_exists(self)
        _race_second.wait(timeout=%(barrier)d)
        return found
    except _race_threading.BrokenBarrierError:
        return _race_original_exists(self)

_RacePath.exists = _race_exists
''' % {"serialized": serialized, "ts": COLLISION_TS, "directory": str(directory),
       "name": name, "count": count, "barrier": BARRIER_TIMEOUT}


class Server:
    """테스트가 띄운 serve.py 프로세스 하나. 이 프로세스만 종료한다."""

    def __init__(self, root, workdir, collision=None, serialize=False):
        self.root = Path(root).resolve()
        self.project = self.root / "synthetic"
        self.workdir = Path(workdir)
        self.startup = self.workdir / "serve-startup"
        self.startup.mkdir(parents=True)
        script = GUARD
        if collision is not None:
            script += _collision_injection(*collision, serialize=serialize)
        (self.startup / "sitecustomize.py").write_text(script, encoding="utf-8")
        self.log_path = self.workdir / "serve.log"
        self.port = None
        self.proc = None
        self._log = None

    def start(self):
        errors = []
        for _ in range(3):
            self.port = _free_port()
            self._log = open(self.log_path, "ab")
            try:
                env = os.environ.copy()
                # 실제 홈 접근을 막는 감사 훅을 서버 프로세스에도 적용한다.
                env["PYTHONPATH"] = str(self.startup)
                env["PYTHONIOENCODING"] = "utf-8"
                self.proc = subprocess.Popen(
                    [sys.executable, str(SERVE), str(self.root), str(self.port)],
                    stdin=subprocess.DEVNULL, stdout=self._log, stderr=subprocess.STDOUT, env=env)
                if self._wait_ready():
                    return self
                errors.append(f"port {self.port}: readiness timeout\n{self.log_text()}")
            except OSError as error:
                errors.append(f"port {self.port}: {error}\n{self.log_text()}")
            self.stop()
        raise RuntimeError("serve.py did not start after 3 attempts:\n" + "\n".join(errors))

    def _wait_ready(self):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                return False
            try:
                with urllib.request.urlopen(self.url("/whoami"), timeout=0.5) as response:
                    info = json.loads(response.read().decode("utf-8"))
                # 포트를 다른 PES 홈의 서버가 선점했으면 준비된 것으로 보지 않는다.
                if info.get("root") == str(self.root) and info.get("single") is True:
                    return True
            except (OSError, urllib.error.URLError, ValueError):
                pass
            time.sleep(0.05)
        return False

    def restart(self):
        self.stop()
        self.port = None
        return self.start()

    def stop(self):
        proc, self.proc = self.proc, None
        try:
            if proc is not None and proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=10)
        finally:
            if self._log is not None:
                self._log.close()
                self._log = None

    def log_text(self):
        try:
            return self.log_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return ""

    def origin(self):
        return f"http://127.0.0.1:{self.port}"

    def url(self, path):
        return f"http://127.0.0.1:{self.port}{path}"

    def request(self, path, method="GET", payload=None, headers=None):
        data = payload
        if isinstance(payload, str):
            data = payload.encode("utf-8")
        request = urllib.request.Request(self.url(path), data=data, method=method,
                                         headers=headers or {})
        try:
            with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.read()

    def get_json(self, path):
        status, body = self.request(path)
        return status, json.loads(body.decode("utf-8"))

    def post(self, path, payload, origin=None):
        data = payload if isinstance(payload, (bytes, bytearray)) else json.dumps(
            payload, ensure_ascii=False).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if origin is not None:
            headers["Origin"] = origin
        status, body = self.request(path, method="POST", payload=data, headers=headers)
        try:
            return status, json.loads(body.decode("utf-8"))
        except json.JSONDecodeError:
            return status, body


def _make_home(isolated_home):
    root = isolated_home / "pes-projects"
    root.mkdir()
    project = root / "synthetic"
    project.mkdir()
    (project / "project.json").write_text(json.dumps(
        {"pes": 1, "topic": "합성 주제", "stages": {}}, ensure_ascii=False), encoding="utf-8")
    (project / "index.html").write_text("<html>synthetic</html>", encoding="utf-8")
    (project / "ask-plan.html").write_text("<html>ask</html>", encoding="utf-8")
    (root / "index.html").write_text("<html>home</html>", encoding="utf-8")
    return root


@pytest.fixture
def server(isolated_home, tmp_path):
    instance = Server(_make_home(isolated_home), tmp_path)
    try:
        instance.start()
        yield instance
    finally:
        instance.stop()


@pytest.fixture
def collision_server(isolated_home, tmp_path):
    root = _make_home(isolated_home)
    directory = root / "synthetic" / "feedback"
    instance = Server(root, tmp_path / "collision",
                      collision=(str(directory), COLLISION_NAME, COLLISION_COUNT))
    try:
        instance.start()
        yield instance
    finally:
        instance.stop()


@pytest.fixture
def serialized_collision_server(isolated_home, tmp_path):
    """결함을 직렬화로 고친 서버를 흉내 낸 양성 대조용 서버."""
    root = _make_home(isolated_home)
    directory = root / "synthetic" / "feedback"
    instance = Server(root, tmp_path / "serialized",
                      collision=(str(directory), COLLISION_NAME, COLLISION_COUNT),
                      serialize=True)
    try:
        instance.start()
        yield instance
    finally:
        instance.stop()


def _feedback(server, payload, origin="default"):
    if origin == "default":
        origin = server.origin()
    return server.post("/synthetic/feedback", payload, origin=origin)


def _answers(server):
    return sorted((server.project / "feedback").glob("*.json")) \
        if (server.project / "feedback").exists() else []


def test_post_feedback_saves_answer_and_log(server):
    status, body = _feedback(server, {
        "stage": "plan", "round": 2, "kind": "feedback", "text": "합성 답변",
        "answers": {"purpose": "report", "purpose__other": "덧붙임"}, "spec": "plan-start"})
    assert status == 200, body
    assert body["ok"] is True
    assert re.fullmatch(r"plan-R2-\d{8}-\d{6}\.json", body["file"]), body["file"]

    path = server.project / "feedback" / body["file"]
    record = json.loads(path.read_text(encoding="utf-8"))
    assert record["stage"] == "plan"
    assert record["round"] == 2
    assert record["kind"] == "feedback"
    assert record["text"] == "합성 답변"
    assert record["answers"] == {"purpose": "report", "purpose__other": "덧붙임"}
    assert record["spec"] == "plan-start"
    assert record["via"] == "html"
    assert record["origin"] == server.origin()

    log = (server.project / "feedback.log").read_text(encoding="utf-8")
    assert f"FEEDBACK plan R2 feedback {path}" in log


def test_trusted_origin_from_isolated_config(server, isolated_home):
    config = isolated_home / ".pes" / "config.json"
    config.parent.mkdir(exist_ok=True)
    config.write_text(json.dumps({"trusted_origins": ["https://remote.example"]}),
                      encoding="utf-8")
    status, body = _feedback(server, {"stage": "plan", "round": 0, "text": "원격 답"},
                             origin="https://remote.example")
    assert status == 200, body
    record = json.loads((server.project / "feedback" / body["file"]).read_text(encoding="utf-8"))
    assert record["via"] == "remote"
    assert record["origin"] == "https://remote.example"

    status, body = _feedback(server, {"stage": "plan", "round": 0, "text": "거부"},
                             origin="https://evil.example")
    assert status == 403
    assert body == {"ok": False, "error": "origin", "hint": "pes remote add https://evil.example"}


@pytest.mark.parametrize("payload,origin,status,error", [
    ({"stage": "plan", "text": "합성"}, "https://evil.example", 403, "origin"),
    ({"stage": "plan", "text": "합성"}, None, 403, "origin"),
    ({"stage": "plan", "kind": "bogus", "text": "합성"}, "default", 400, "kind"),
    ({"stage": "plan", "kind": "feedback", "text": "   ", "answers": {}}, "default", 400, "empty"),
    ({"stage": "plan", "kind": "feedback"}, "default", 400, "empty"),
])
def test_feedback_rejections(server, payload, origin, status, error):
    code, body = _feedback(server, payload, origin=origin)
    assert code == status
    assert body["ok"] is False
    assert body["error"] == error
    assert _answers(server) == []
    assert not (server.project / "feedback.log").exists() or \
        (server.project / "feedback.log").read_text(encoding="utf-8") == ""


def test_broken_json_rejected(server):
    status, body = server.post("/synthetic/feedback", b'{"stage": "plan", "text":',
                               origin=server.origin())
    assert status == 400
    assert body == {"ok": False}
    assert _answers(server) == []


def test_oversized_body_rejected(server):
    payload = b'{"stage": "plan", "text": "' + b"x" * (MAX_BODY + 1) + b'"}'
    status, body = server.post("/synthetic/feedback", payload, origin=server.origin())
    assert status == 413
    assert body == {"ok": False}
    assert _answers(server) == []


def test_unknown_project_rejected(server):
    status, body = server.post("/missing/feedback", {"stage": "plan", "text": "합성"},
                               origin=server.origin())
    assert status == 404
    assert body == {"ok": False}
    assert not (server.root / "missing").exists()
    assert _answers(server) == []


def test_pending_answers_survive_mark_and_server_restart(server, cli):
    names = []
    for text in ("첫 답", "둘째 답"):
        status, body = _feedback(server, {"stage": "plan", "round": 1, "kind": "feedback",
                                          "text": text})
        assert status == 200, body
        names.append(body["file"])
    assert names[0] != names[1]
    assert [path.name for path in _answers(server)] == sorted(names)

    code, out, err = cli("pending", server.project)
    assert code == 0, (out, err)
    assert sorted(Path(line).name for line in out.splitlines()) == sorted(names)

    code, out, err = cli("mark", server.project, names[0])
    assert code == 0, (out, err)
    code, out, err = cli("pending", server.project)
    assert [Path(line).name for line in out.splitlines()] == [names[1]]

    # 서버를 껐다 켜도 답 파일과 처리 표시는 그대로다.
    server.restart()
    code, out, err = cli("pending", server.project)
    assert code == 0, (out, err)
    assert [Path(line).name for line in out.splitlines()] == [names[1]]
    assert (server.project / "feedback" / names[1]).exists()

    code, out, err = cli("mark", server.project, names[1])
    assert code == 0, (out, err)
    code, out, err = cli("pending", server.project)
    assert code == 0, (out, err)
    assert out.strip() == ""
    processed = json.loads((server.project / "project.json").read_text(encoding="utf-8"))["processed"]
    assert processed == names


def test_version_ping_and_whoami(server):
    old = 1_600_000_000
    os.utime(server.project / "index.html", (old, old))
    os.utime(server.project / "ask-plan.html", (old + 10, old + 10))
    os.utime(server.root / "index.html", (old + 20, old + 20))

    status, body = server.get_json("/ping")
    assert (status, body) == (200, {"ok": True})
    status, body = server.get_json("/synthetic/ping")
    assert (status, body) == (200, {"ok": True})

    status, body = server.get_json("/whoami")
    assert status == 200
    assert body == {"root": str(server.root), "single": True}

    status, body = server.get_json("/synthetic/version")
    assert status == 200
    assert body == {"v": old + 10}
    status, body = server.get_json("/version")
    assert status == 200
    assert body == {"v": old + 20}


@pytest.mark.parametrize("failure", ["timeout", "early_exit", "spawn_error"])
def test_start_failure_terminates_child_and_closes_log(isolated_home, tmp_path, monkeypatch, failure):
    instance = Server(_make_home(isolated_home), tmp_path / "broken-start")
    children = []
    handles = []
    real_popen = subprocess.Popen
    real_open = builtins.open

    def recording_popen(*args, **kwargs):
        if failure == "spawn_error":
            raise OSError("spawn failed")
        proc = real_popen(*args, **kwargs)
        children.append(proc)
        return proc

    def recording_open(file, *args, **kwargs):
        handle = real_open(file, *args, **kwargs)
        try:
            is_log = os.fspath(file) == os.fspath(instance.log_path)
        except TypeError:
            is_log = False
        if is_log:
            handles.append(handle)
        return handle

    monkeypatch.setattr(subprocess, "Popen", recording_popen)
    monkeypatch.setattr(builtins, "open", recording_open)
    if failure == "timeout":
        monkeypatch.setattr(Server, "_wait_ready", lambda self: False)
    elif failure == "early_exit":
        monkeypatch.setattr(sys.modules[__name__], "SERVE", tmp_path / "missing-serve.py")

    try:
        with pytest.raises(RuntimeError):
            instance.start()
        # 참조를 비운 것뿐 아니라 실제 자식 종료·핸들 닫힘까지 확인한다.
        assert len(children) == (0 if failure == "spawn_error" else 3)
        assert all(proc.poll() is not None for proc in children)
        assert len(handles) == 3
        assert all(handle.closed for handle in handles)
        assert instance.proc is None
        assert instance._log is None
    finally:
        for proc in children:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=10)
        for handle in handles:
            if not handle.closed:
                handle.close()


def _submit_concurrently(server, count):
    responses = []
    failures = []
    ready = threading.Barrier(count)

    def submit(index):
        try:
            ready.wait(timeout=20)
            status, body = _feedback(server, {"stage": COLLISION_STAGE,
                                              "round": COLLISION_ROUND,
                                              "kind": "feedback",
                                              "text": f"동시 답 {index}"})
            responses.append((index, status, body))
        except Exception as error:  # pragma: no cover - 실패 진단용
            failures.append(error)

    threads = [threading.Thread(target=submit, args=(index,)) for index in range(count)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=40)
    return responses, failures, [thread for thread in threads if thread.is_alive()]


def _assert_requests_ok(responses, failures, alive, count):
    """전송·스레드·HTTP 응답은 xfail 범위 밖에서 단언한다."""
    assert not alive
    assert not failures, failures
    assert len(responses) == count, responses
    assert all(status == 200 and isinstance(body, dict) and body.get("ok") is True
               for _, status, body in responses), responses


def _answer_loss(files, count):
    """답 파일 수와 저장된 답 내용이 기대와 다르면 설명을, 아니면 None 을 돌려준다."""
    texts = set()
    corrupt = []
    for path in files:
        try:
            texts.add(json.loads(path.read_text(encoding="utf-8"))["text"])
        except (OSError, ValueError, KeyError) as error:
            # 같은 파일에 동시에 쓴 결과가 깨진 JSON 으로 남는 것도 이 결함의 일부다.
            corrupt.append(f"{path.name}: {error}")
    expected = {f"동시 답 {index}" for index in range(count)}
    if len(files) != count or texts != expected or corrupt:
        return "응답 %d개, 파일 %d개, 깨진 파일 %s" % (count, len(files), corrupt or "없음")
    return None


@pytest.mark.xfail(strict=True, raises=AnswerLoss, reason=(
    "serve.py:140-145 파일 이름이 초 단위라 같은 초에 동시에 들어온 답이 "
    "같은 파일을 덮어써 답이 유실된다 (테스트 전용 배리어로 재현을 고정)"))
def test_simultaneous_submissions_do_not_lose_answers(collision_server):
    responses, failures, alive = _submit_concurrently(collision_server, COLLISION_COUNT)

    # 답 유실과 무관한 회귀(HTTP 500·스레드 오류·응답 누락)는 xfail 이 삼키지 않는다.
    _assert_requests_ok(responses, failures, alive, COLLISION_COUNT)

    loss = _answer_loss(_answers(collision_server), COLLISION_COUNT)
    if loss is not None:
        raise AnswerLoss("같은 초 동시 제출로 답이 유실됨: " + loss)


def test_collision_check_passes_when_server_serializes(serialized_collision_server):
    """결함을 잠금 등으로 직렬화해 고친 서버에서는 이 검사가 통과해야 한다.

    배리어 대기(BARRIER_TIMEOUT)가 HTTP 타임아웃보다 짧아야 첫 요청이 멈춰 선 채
    나머지 요청이 전송 오류로 끝나지 않는다. 여기서는 자식 서버를 단일 스레드로
    바꿔 '직렬화된 서버'를 흉내 낸다 (제품 코드는 바꾸지 않는다).
    """
    responses, failures, alive = _submit_concurrently(serialized_collision_server,
                                                      COLLISION_COUNT)
    _assert_requests_ok(responses, failures, alive, COLLISION_COUNT)
    files = _answers(serialized_collision_server)
    assert _answer_loss(files, COLLISION_COUNT) is None
    assert len({path.name for path in files}) == COLLISION_COUNT
