"""scripts/serve.py: 답 수신·거부·미처리 답 유지·상태 응답을 실제 서버 프로세스로 고정한다."""
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


def _free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Server:
    """테스트가 띄운 serve.py 프로세스 하나. 이 프로세스만 종료한다."""

    def __init__(self, root, workdir):
        self.root = Path(root).resolve()
        self.project = self.root / "synthetic"
        self.workdir = Path(workdir)
        self.startup = self.workdir / "serve-startup"
        self.startup.mkdir()
        (self.startup / "sitecustomize.py").write_text(GUARD, encoding="utf-8")
        self.log_path = self.workdir / "serve.log"
        self.port = None
        self.proc = None
        self._log = None

    def start(self):
        if self.port is None:
            self.port = _free_port()
        env = os.environ.copy()
        # 실제 홈 접근을 막는 감사 훅을 서버 프로세스에도 적용한다.
        env["PYTHONPATH"] = str(self.startup)
        env["PYTHONIOENCODING"] = "utf-8"
        self._log = open(self.log_path, "ab")
        self.proc = subprocess.Popen(
            [sys.executable, str(SERVE), str(self.root), str(self.port)],
            stdin=subprocess.DEVNULL, stdout=self._log, stderr=subprocess.STDOUT, env=env)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError("serve.py exited early:\n" + self.log_text())
            try:
                with urllib.request.urlopen(
                        f"http://127.0.0.1:{self.port}/ping", timeout=0.5) as response:
                    if response.status == 200:
                        return self
            except (OSError, urllib.error.URLError):
                pass
            time.sleep(0.05)
        raise RuntimeError("serve.py did not become ready:\n" + self.log_text())

    def restart(self):
        self.stop()
        return self.start()

    def stop(self):
        proc, self.proc = self.proc, None
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=10)
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
            with urllib.request.urlopen(request, timeout=15) as response:
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


@pytest.fixture
def server(isolated_home, tmp_path):
    root = isolated_home / "pes-projects"
    root.mkdir()
    project = root / "synthetic"
    project.mkdir()
    (project / "project.json").write_text(json.dumps(
        {"pes": 1, "topic": "합성 주제", "stages": {}}, ensure_ascii=False), encoding="utf-8")
    (project / "index.html").write_text("<html>synthetic</html>", encoding="utf-8")
    (project / "ask-plan.html").write_text("<html>ask</html>", encoding="utf-8")
    (root / "index.html").write_text("<html>home</html>", encoding="utf-8")
    instance = Server(root, tmp_path)
    instance.start()
    try:
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


@pytest.mark.xfail(strict=True, reason=(
    "serve.py:140-145 파일 이름이 초 단위라 같은 초에 동시에 들어온 답이 "
    "같은 파일을 덮어써 답이 유실된다"))
def test_simultaneous_submissions_do_not_overwrite_each_other(server):
    count = 12
    responses = []
    failures = []
    barrier = threading.Barrier(count)

    def submit(index):
        try:
            barrier.wait(timeout=10)
            status, body = _feedback(server, {"stage": "plan", "round": 1, "kind": "feedback",
                                              "text": f"동시 답 {index}"})
            responses.append((status, body))
        except Exception as error:  # pragma: no cover - 실패 진단용
            failures.append(error)

    # 같은 초 안에 들어가도록 초 경계 직후에 맞춰 보낸다.
    now = time.time()
    time.sleep(max(0.0, (int(now) + 1) - now + 0.02))
    threads = [threading.Thread(target=submit, args=(index,)) for index in range(count)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    assert not failures
    assert len(responses) == count
    assert all(status == 200 and body["ok"] for status, body in responses)
    files = _answers(server)
    assert len(files) == count
    assert len({path.name for path in files}) == count
