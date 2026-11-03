#!/usr/bin/env python3
"""SEL-18 방식 A 시험 — opencode serve HTTP API로 PES 한 라운드 왕복.

표준 라이브러리만 쓴다. 실행 방법은 같은 폴더의 README.md 참고.

안전 규칙(코드가 지키는 것):
- PES 는 항상 PES_HOME=<임시 폴더> 로만 실행한다. ~/pes-projects, ~/.pes 를 쓰지 않는다.
- opencode serve 는 개인 서버만 띄운다. `--service` 를 쓰지 않고, 기본 포트가 아니라
  빈 포트를 골라 127.0.0.1 에만 연다. 끝나면 반드시 종료하고 포트가 비었는지 확인한다.
- 모델은 opencode-go/deepseek-v4.1-flash 하나만 쓴다.
- 시험에서 만든 세션 ID 만 지운다. 다른 세션은 건드리지 않는다.
- 비밀번호·토큰은 화면·파일에 남기지 않는다. (서버 로그는 임시 폴더 안에만 둔다.)
"""

from __future__ import annotations

import argparse
import base64
import http.client
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
PES = REPO / "scripts" / "pes.py"
SERVE = REPO / "scripts" / "serve.py"

MODEL = {"providerID": "opencode-go", "id": "deepseek-v4.1-flash"}
MODEL_LABEL = "opencode-go/deepseek-v4.1-flash"
PES_OWNER = "sel18-spike"

REPEATS = 3


# ---------------------------------------------------------------- 유틸
def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def port_free(port: int) -> bool:
    s = socket.socket()
    s.settimeout(0.5)
    try:
        return s.connect_ex(("127.0.0.1", port)) != 0
    finally:
        s.close()


def now_ms() -> int:
    return int(time.time() * 1000)


def ms(t0: float) -> int:
    return int((time.monotonic() - t0) * 1000)


def short(text, n=300) -> str:
    text = " ".join(str(text).split())
    return text[:n] + ("…" if len(text) > n else "")


# ---------------------------------------------------------------- HTTP 클라이언트
class Api:
    def __init__(self, host: str, port: int, password: str):
        self.host = host
        self.port = port
        token = base64.b64encode(f"opencode:{password}".encode()).decode()
        self.auth = "Basic " + token

    def _req(self, method: str, path: str, body=None, timeout=60):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(
            f"http://{self.host}:{self.port}{path}",
            data=data,
            method=method,
            headers={"Authorization": self.auth, "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)

    def get(self, path, timeout=60):
        return self._req("GET", path, timeout=timeout)[1]

    def post(self, path, body=None, timeout=60):
        return self._req("POST", path, body or {}, timeout=timeout)[1]

    def delete(self, path, timeout=60):
        return self._req("DELETE", path, timeout=timeout)


class EventStream(threading.Thread):
    """GET /api/event (SSE) 를 읽어 (수신시각, 이벤트) 목록으로 쌓는다."""

    def __init__(self, host: str, port: int, password: str):
        super().__init__(daemon=True)
        self.host, self.port = host, port
        self.auth = "Basic " + base64.b64encode(f"opencode:{password}".encode()).decode()
        self.events: list[tuple[float, dict]] = []
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self.connected = False
        self.error = None

    def run(self):
        try:
            conn = http.client.HTTPConnection(self.host, self.port, timeout=2)
            conn.request("GET", "/api/event", headers={"Authorization": self.auth, "Accept": "text/event-stream"})
            resp = conn.getresponse()
            if resp.status != 200:
                self.error = f"HTTP {resp.status}"
                return
            self.connected = True
            while not self._stop.is_set():
                try:
                    line = resp.readline()
                except socket.timeout:
                    continue
                except Exception as exc:  # 연결이 끊기면 서버 재시작 시험에서 정상
                    self.error = type(exc).__name__
                    return
                if not line:
                    return
                if not line.startswith(b"data: "):
                    continue
                try:
                    ev = json.loads(line[6:])
                except Exception:
                    continue
                with self._lock:
                    self.events.append((time.monotonic(), ev))
            conn.close()
        except Exception as exc:
            self.error = f"{type(exc).__name__}: {exc}"

    def stop(self):
        self._stop.set()

    def since(self, t: float, session_id: str | None = None):
        with self._lock:
            evs = [(ts, e) for ts, e in self.events if ts >= t]
        if session_id is not None:
            evs = [
                (ts, e)
                for ts, e in evs
                if (e.get("data") or {}).get("sessionID") == session_id
                or (e.get("durable") or {}).get("aggregateID") == session_id
            ]
        return evs

    def types(self, t: float, session_id: str | None = None):
        return [e.get("type") for ts, e in self.since(t, session_id)]


# ---------------------------------------------------------------- opencode 서버
class Server:
    def __init__(self, directory: Path, log_path: Path, opencode_bin: str):
        self.directory = directory
        self.log_path = log_path
        self.opencode_bin = opencode_bin
        self.port = None
        self.proc = None
        self.api = None
        self.events = None
        self.password = None

    def start(self, port: int | None = None):
        self.port = port or free_port()
        # 재시작할 때 이전 서버의 비밀번호 줄을 다시 읽지 않도록 로그를 새로 쓴다.
        log = self.log_path.open("wb")
        env = os.environ.copy()
        self.proc = subprocess.Popen(
            [self.opencode_bin, "serve", "--hostname", "127.0.0.1", "--port", str(self.port)],
            cwd=str(self.directory),
            stdout=log,
            stderr=subprocess.STDOUT,
            env=env,
            start_new_session=True,
        )
        log.close()
        try:
            deadline = time.monotonic() + 40
            while time.monotonic() < deadline:
                if self.proc.poll() is not None:
                    raise RuntimeError("opencode serve 가 곧바로 종료했다: " + self.log_tail())
                text = self.log_path.read_text(errors="replace") if self.log_path.exists() else ""
                m = re.search(r"server password (\S+)", text)
                if m and "server listening" in text:
                    self.password = m.group(1)
                    self.api = Api("127.0.0.1", self.port, self.password)
                    try:
                        info = self.api.get("/api/info", timeout=5)
                    except Exception:
                        time.sleep(0.3)
                        continue
                    if info and info.get("version"):
                        self.events = EventStream("127.0.0.1", self.port, self.password)
                        self.events.start()
                        return info
                time.sleep(0.3)
            raise RuntimeError("opencode serve 기동 시간 초과: " + self.log_tail())
        except Exception:
            self.stop()
            raise

    def stop(self, grace=8):
        if self.events:
            self.events.stop()
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.terminate()
                self.proc.wait(timeout=grace)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(self.proc.pid, 15)
                except Exception:
                    pass
                try:
                    self.proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(self.proc.pid, 9)
                    except Exception:
                        pass
                    self.proc.wait(timeout=5)
        if self.port:
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline and not port_free(self.port):
                time.sleep(0.2)

    def log_tail(self, n=800):
        try:
            return self.log_path.read_text(errors="replace")[-n:]
        except Exception:
            return "(로그 없음)"


# ---------------------------------------------------------------- 권한 응답기
class PermissionResponder(threading.Thread):
    """대기 중인 권한 요청을 poll 해서 once/reject 로 답한다."""

    def __init__(self, api: Api, decision: str):
        super().__init__(daemon=True)
        self.api = api
        # API enum 은 once|always|reject 다. 시험 코드에서는 allow/deny 로 부른다.
        self.decision = {"allow": "once", "deny": "reject"}.get(decision, decision)
        self._stop = threading.Event()
        self.seen: set[str] = set()
        self.requests: list[dict] = []
        self.replies: list[dict] = []
        self.polls = 0
        self.errors: list[str] = []

    def run(self):
        while not self._stop.is_set():
            self.polls += 1
            try:
                data = self.api.get("/api/permission/request", timeout=10).get("data") or []
            except Exception as exc:
                self.errors.append(f"{type(exc).__name__}: {exc}")
                data = []
            for r in data:
                rid = r.get("id")
                if not rid or rid in self.seen:
                    continue
                self.seen.add(rid)
                rec = {"action": r.get("action"), "resources": r.get("resources")}
                self.requests.append(rec)
                try:
                    self.api.post(
                        f"/api/session/{r['sessionID']}/permission/{rid}/reply",
                        {"decision": self.decision, "message": "SEL-18 spike"},
                        timeout=10,
                    )
                    self.replies.append({**rec, "id": rid, "decision": self.decision, "ok": True})
                except urllib.error.HTTPError as exc:
                    body = ""
                    try:
                        body = exc.read().decode(errors="replace")[:300]
                    except Exception:
                        pass
                    self.replies.append({**rec, "id": rid, "decision": self.decision, "ok": False,
                                         "error": f"HTTP {exc.code}", "body": body})
                except Exception as exc:
                    self.replies.append({**rec, "id": rid, "decision": self.decision, "ok": False,
                                         "error": type(exc).__name__})
            time.sleep(0.2)

    def stop(self):
        self._stop.set()
        self.join(timeout=3)


# ---------------------------------------------------------------- PES 실행
class Pes:
    def __init__(self, root: Path):
        self.root = root

    def env(self):
        env = os.environ.copy()
        env["PES_HOME"] = str(self.root)
        env["PES_OWNER"] = PES_OWNER
        env.pop("PES_PROJECT", None)
        return env

    def run(self, *args, timeout=120):
        t0 = time.monotonic()
        p = subprocess.run(
            [sys.executable, str(PES), *map(str, args)],
            capture_output=True,
            text=True,
            env=self.env(),
            timeout=timeout,
        )
        return {
            "args": list(map(str, args)),
            "code": p.returncode,
            "out": p.stdout.strip(),
            "err": p.stderr.strip(),
            "ms": ms(t0),
        }


# ---------------------------------------------------------------- 시험 본체
class Spike:
    def __init__(self, base: Path, opencode_bin: str, keep: bool):
        self.base = base
        self.opencode_bin = opencode_bin
        self.keep = keep
        self.result = {
            "started": time.strftime("%Y-%m-%d %H:%M:%S"),
            "opencode_version": None,
            "items": {},
            "cleanup": {},
        }

    # -- 한 번의 반복 -------------------------------------------------
    def iteration(self, n: int) -> dict:
        root = self.base / f"run-{n}"
        proj = root / "proj"
        root.mkdir(parents=True)
        pes = Pes(root)
        rec = {"iteration": n, "steps": {}, "permissions": [], "events": {}, "sessions": []}
        srv = None
        api = None
        try:
            # 1) 합성 PES 프로젝트
            init = pes.run("init", proj, "--topic", "합성 주제: 지역 청년 정책 시험")
            rec["steps"]["init"] = {k: init[k] for k in ("code", "ms", "out")}
            if init["code"] != 0:
                rec["fatal"] = "init 실패: " + init["err"]
                return rec

            # 시험용 프로젝트 설정 — 이 임시 폴더 안에서만. 셸·쓰기 권한을 물어보게 한다.
            (proj / "opencode.json").write_text(
                json.dumps(
                    {
                        "$schema": "https://opencode.ai/config.json",
                        "permissions": [
                            {"action": "shell", "resource": "*", "effect": "ask"},
                            {"action": "edit", "resource": "*", "effect": "ask"},
                        ],
                    },
                    indent=1,
                ),
                encoding="utf-8",
            )

            # 2) 개인 서버 기동
            srv = Server(proj, root / "opencode.log", self.opencode_bin)
            t0 = time.monotonic()
            info = srv.start()
            rec["steps"]["server_start"] = {"ms": ms(t0), "version": info.get("version"), "pid": info.get("pid")}
            self.result["opencode_version"] = info.get("version")
            api = srv.api

            # 3) 항목 1 — 서버 정보·모델 목록
            t0 = time.monotonic()
            info_now = api.get("/api/info")
            models = api.get("/api/model")
            data = models.get("data") or []
            found = [m for m in data if m.get("providerID") == "opencode-go" and m.get("modelID") == "deepseek-v4.1-flash"]
            rec["steps"]["info_model"] = {
                "ms": ms(t0),
                "info": {
                    "version": info_now.get("version"),
                    "pid": info_now.get("pid"),
                    "n_urls": len(info_now.get("urls") or []),
                    "capabilities": info_now.get("capabilities"),
                },
                "model_count": len(data),
                "target_found": bool(found),
                "target": (found[0].get("name") if found else None),
                "target_status": (found[0].get("status") if found else None),
                "target_cost": (found[0].get("cost") if found else None),
            }
            rec["steps"]["usage"] = self.usage(api)

            # 4) 항목 2 — 공통 시나리오 한 라운드
            rec["steps"]["scenario"] = self.scenario(pes, proj, root, api, srv)
            if rec["steps"]["scenario"].get("session_id"):
                rec["sessions"].append(rec["steps"]["scenario"]["session_id"])

            # 5) 항목 3 — 이벤트 스트림 (시나리오 동안 이미 수집. 여기서 요약)
            evs = rec["steps"]["scenario"].get("events", {})
            rec["steps"]["event_stream"] = {
                "connected": bool(srv.events and srv.events.connected),
                "error": (srv.events.error if srv.events else None),
                "event_count": evs.get("count"),
                "type_count": evs.get("type_count"),
                "first_event_ms": evs.get("first_event_ms"),
                "execution_started_ms": evs.get("execution_started_ms"),
                "execution_end_ms": evs.get("execution_end_ms"),
                "types": evs.get("types"),
            }

            # 6) 항목 4 — 중단·재개 + 서버 재시작 복구
            rec["steps"]["interrupt_resume"] = self.interrupt_resume(proj, api, srv, rec)
            api = srv.api  # 재시작 뒤에는 비밀번호가 바뀌었다 — 새 클라이언트를 쓴다

            # 7) 항목 5 — 권한 거부
            rec["steps"]["permission_deny"] = self.permission_deny(proj, api)

            # 8) 항목 6 — 사용량 한도 (반복)
            rec["steps"]["usage_2"] = self.usage(api)
            rec["steps"]["usage_3"] = self.usage(api)
        except Exception as exc:
            rec["fatal"] = f"{type(exc).__name__}: {exc}"
            rec["traceback"] = traceback.format_exc()[-2000:]
        finally:
            # 세션 정리 — 이 시험에서 만든 ID 만 지운다.
            if srv is not None:
                try:
                    rec["cleanup"] = self.cleanup_sessions(srv.api or api, rec["sessions"])
                except Exception as exc:
                    rec["cleanup"] = {"error": type(exc).__name__}
                srv.stop()
                rec["steps"]["server_stop"] = {"port": srv.port, "port_free": port_free(srv.port) if srv.port else None}
        return rec

    # -- 사용량 한도 ---------------------------------------------------
    def usage(self, api: Api) -> dict:
        t0 = time.monotonic()
        try:
            r = api.get("/api/experimental/usage/limits")
        except urllib.error.HTTPError as exc:
            return {"ok": False, "http": exc.code, "ms": ms(t0)}
        except Exception as exc:
            return {"ok": False, "error": type(exc).__name__, "ms": ms(t0)}
        d = r.get("data") if isinstance(r, dict) else None
        out = {"ok": True, "ms": ms(t0), "present": d is not None}
        if isinstance(d, dict):
            go = d.get("go") or {}
            out["go"] = {
                k: {"percent": (go.get(k) or {}).get("percent"), "limited": (go.get(k) or {}).get("limited"),
                    "resetsAt": (go.get(k) or {}).get("resetsAt")}
                for k in ("rolling", "weekly", "monthly")
            }
            out["n_budgets"] = len(d.get("budgets") or [])
        return out

    # -- 공통 시나리오 -------------------------------------------------
    def scenario(self, pes: Pes, proj: Path, root: Path, api: Api, srv: Server) -> dict:
        out = {"ok": False, "events": {}}

        rs = pes.run("round-start", proj, "plan")
        out["round_start"] = {k: rs[k] for k in ("code", "ms", "out")}
        if rs["code"] != 0:
            out["error"] = "round-start 실패: " + rs["err"]
            return out

        sid, create_ms = self.create_session(api, "SEL-18 scenario")
        out["session_ms"] = create_ms
        out["session_id"] = sid

        prompt_text = (
            "합성 PES 프로젝트의 기획 단계 작업이다. 아래 순서대로 실행하라.\n"
            f"1) 셸 도구로 다음 명령을 실행해 현재 상태를 읽어라: PES_HOME={root} "
            f"{sys.executable} {PES} status {proj}\n"
            "2) 출력에서 '현재 단계'와 기획 단계의 R 숫자를 확인하라.\n"
            f"3) 다음 JSON 을 {proj}/result.json 파일에 그대로 써라. 다른 파일은 쓰지 마라.\n"
            '{"id": "plan-agent-1", "title": "합성 기획 항목", "summary": "현재 단계=<단계>, 라운드=<R숫자>", '
            '"confidence": "medium"}\n'
            "4) 마지막 답변에 RESULT-WRITTEN 이라고만 써라."
        )
        t0 = time.monotonic()
        run = self.prompt_with_permissions(api, sid, prompt_text, "allow", timeout=180)
        out["agent"] = run["summary"]
        out["agent"]["prompt_ms"] = run["ms"]
        out["agent"]["permission_polls"] = run.get("permission_polls")
        out["agent"]["permission_errors"] = run.get("permission_errors")
        out["permissions"] = run["permissions"]
        # SSE 는 비동기라 idle 직후에는 마지막 이벤트가 아직 안 왔을 수 있다. 실행 종료 이벤트를 잠깐 기다린다.
        out["terminal_seen"] = self.wait_terminal(srv, sid, t0, timeout=8)
        out["events"] = self.event_summary(srv, t0, sid)

        # 모델이 만든 결과 확인 — 실패하면 PES 쪽 파이프라인 측정용 고정 결과로 이어 간다.
        result_file = proj / "result.json"
        agent_ok = False
        if result_file.exists():
            try:
                rj = json.loads(result_file.read_text(encoding="utf-8"))
                agent_ok = rj.get("id") == "plan-agent-1" and bool(rj.get("summary"))
            except Exception:
                agent_ok = False
        out["agent_result"] = {"exists": result_file.exists(), "valid": agent_ok,
                               "text": short(result_file.read_text(encoding="utf-8")) if result_file.exists() else None}
        if not agent_ok:
            result_file.write_text(
                json.dumps({"id": "plan-agent-1", "title": "합성 기획 항목",
                            "summary": "현재 단계=기획, 라운드=1", "confidence": "medium"}, ensure_ascii=False),
                encoding="utf-8",
            )
            out["agent_result"]["fallback"] = True

        for step, args in (
            ("merge", ("merge", proj, "plan", result_file)),
            ("render", ("render", proj, "plan")),
            ("ask_prep", ("ask-prep", proj, "plan")),
        ):
            r = pes.run(*args)
            out[step] = {k: r[k] for k in ("code", "ms", "out")}
            if r["code"] != 0:
                out["error"] = step + " 실패: " + r["err"]
                return out

        ask_spec = proj / "ask" / "plan-start.json"
        r = pes.run("ask", proj, ask_spec)
        out["ask"] = {k: r[k] for k in ("code", "ms", "out")}
        if r["code"] != 0:
            out["error"] = "ask 실패: " + r["err"]
            return out
        out["ask_html"] = (proj / "ask-plan-start.html").exists()
        out["index_html"] = (proj / "index.html").exists()

        # 사람 답 흉내 — 이 홈에 serve.py 를 띄우고 POST /feedback
        sport = free_port()
        env = os.environ.copy()
        env["PES_HOME"] = str(root)
        log = (root / "serve.log").open("ab")
        serve = subprocess.Popen(
            [sys.executable, "-I", str(SERVE), str(root), str(sport)],
            stdout=log,
            stderr=subprocess.STDOUT,
            env=env,
            start_new_session=True,
        )
        log.close()
        try:
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                if not port_free(sport):
                    break
                time.sleep(0.2)
            body = {
                "stage": "plan",
                "round": 1,
                "kind": "feedback",
                "text": "합성 답변: 청년 정책을 우선한다. (SEL-18 시험)",
                "answers": {"scope": "청년 정책"},
            }
            req = urllib.request.Request(
                f"http://127.0.0.1:{sport}/proj/feedback",
                data=json.dumps(body, ensure_ascii=False).encode(),
                method="POST",
                headers={"Content-Type": "application/json", "Origin": f"http://127.0.0.1:{sport}"},
            )
            t0 = time.monotonic()
            with urllib.request.urlopen(req, timeout=15) as resp:
                fb = {"http": resp.status, "body": json.loads(resp.read() or b"{}")}
            fb["ms"] = ms(t0)
            out["feedback"] = fb
        except Exception as exc:
            out["feedback"] = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        finally:
            try:
                serve.terminate()
                serve.wait(timeout=5)
            except subprocess.TimeoutExpired:
                serve.kill()
                serve.wait(timeout=5)
            if not port_free(sport):
                out.setdefault("warnings", []).append(f"serve.py 포트 {sport} 가 비지 않음")

        pend = pes.run("pending", proj)
        paths = [p for p in pend["out"].splitlines() if p.strip()]
        out["pending"] = {"code": pend["code"], "ms": pend["ms"], "count": len(paths), "paths": [Path(p).name for p in paths]}
        if paths:
            mark = pes.run("mark", proj, *paths)
            out["mark"] = {k: mark[k] for k in ("code", "ms", "out")}
        pend2 = pes.run("pending", proj)
        out["pending_after_mark"] = len([p for p in pend2["out"].splitlines() if p.strip()])

        # 재개 — 같은 세션에 다시 프롬프트
        resume_text = (
            "사람이 방금 기획 단계 질문에 답했다. 셸로 다음을 다시 실행해 처리 안 한 답이 0개인지 확인하라: "
            f"PES_HOME={root} {sys.executable} {PES} status {proj}\n"
            f"그다음 {proj}/plan-result.md 파일에 '처리 안 한 답: <개수>' 한 줄과 이번 라운드 할 일 3개를 적어라. "
            "마지막 답변에 RESUME-OK 라고만 써라."
        )
        run2 = self.prompt_with_permissions(api, sid, resume_text, "allow", timeout=180)
        out["resume"] = run2["summary"]
        out["resume"]["prompt_ms"] = run2["ms"]
        out["permissions"] += run2["permissions"]
        out["plan_result_md"] = (proj / "plan-result.md").exists()

        out["ok"] = bool(
            agent_ok
            and out.get("ask_html")
            and out.get("index_html")
            and out.get("feedback", {}).get("http") == 200
            and out.get("pending", {}).get("count") == 1
            and out.get("pending_after_mark") == 0
            and "RESUME-OK" in (out["resume"].get("text") or "")
        )
        return out

    # -- 중단·재개·서버 재시작 -----------------------------------------
    def interrupt_resume(self, proj: Path, api: Api, srv: Server, rec: dict) -> dict:
        out = {"ok": False}
        sid, create_ms = self.create_session(api, "SEL-18 interrupt")
        out["session_ms"] = create_ms

        text = (
            "셸 도구로 정확히 다음 명령을 실행하라: sleep 30 ; echo slow > slow.txt . "
            "그 전에 다른 명령을 실행하지 마라. 끝나면 SLOW-DONE 이라고 답하라."
        )
        t0 = time.monotonic()
        resp = PermissionResponder(api, "allow")
        resp.start()
        try:
            api.post(f"/api/session/{sid}/prompt", {"text": text})
            # 셸 sleep 이 시작될 때까지 조금 기다린 뒤 중단
            deadline = time.monotonic() + 12
            started = False
            while time.monotonic() < deadline:
                types = srv.events.types(t0, sid) if srv.events else []
                if "session.tool.called" in types or "session.tool.input.started" in types:
                    started = True
                    break
                time.sleep(0.2)
            time.sleep(1.0)
            t_int = time.monotonic()
            try:
                ir = api.post(f"/api/session/{sid}/interrupt")
                out["interrupt"] = {"ok": True, "ms": ms(t_int), "response": ir}
            except Exception as exc:
                out["interrupt"] = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
            idle, wait_ms = self.wait_idle(api, sid, now_ms() - 90000, timeout=60)
            out["interrupt"]["idle_outcome"] = idle.get("outcome")
            out["interrupt"]["settle_ms"] = wait_ms
            out["interrupt"]["tool_started"] = started
        finally:
            resp.stop()
        out["permissions_interrupt"] = resp.replies

        # 같은 세션 이어 쓰기
        run = self.prompt_with_permissions(api, sid, "정확히 RESUME-OK 라고만 답하라.", "allow", timeout=120)
        out["resume"] = run["summary"]
        out["resume_ok"] = "RESUME-OK" in (run["summary"].get("text") or "")

        # 개인 서버 재시작 후 세션 복구
        port = srv.port
        srv.stop()
        out["server_stop_before_restart"] = {"port": port, "port_free": port_free(port)}
        srv2 = Server(proj, srv.log_path, self.opencode_bin)
        t0 = time.monotonic()
        try:
            srv2.start(port=port)
        except Exception:
            srv2.stop()
            raise
        out["restart_ms"] = ms(t0)
        out["restart_port"] = port
        # 이후 항목(권한 거부·사용량)도 같은 서버를 쓰도록 호출자 객체를 새 서버로 바꾼다.
        # 정지·세션 삭제는 iteration 의 finally 가 한 번에 맡는다.
        srv.__dict__.update(srv2.__dict__)
        api = srv2.api
        rec["sessions"].append(sid)
        try:
            got = api.get(f"/api/session/{sid}")
            out["recovered"] = bool(got and (got.get("data") or {}).get("id") == sid)
        except urllib.error.HTTPError as exc:
            out["recovered"] = False
            out["recover_http"] = exc.code
        run = self.prompt_with_permissions(api, sid, "정확히 AFTER-RESTART 라고만 답하라.", "allow", timeout=120)
        out["after_restart"] = run["summary"]
        out["after_restart_ok"] = "AFTER-RESTART" in (run["summary"].get("text") or "")
        out["ok"] = bool(out.get("interrupt", {}).get("ok") and out.get("resume_ok") and out.get("recovered") and out.get("after_restart_ok"))
        return out

    # -- 권한 거부 ------------------------------------------------------
    def permission_deny(self, proj: Path, api: Api) -> dict:
        out = {"ok": False}
        keep = proj / "keep.txt"
        keep.write_text("KEEP", encoding="utf-8")
        sid, create_ms = self.create_session(api, "SEL-18 deny")
        out["session_ms"] = create_ms
        out["sessions"] = [sid]
        try:
            text = "셸 도구로 정확히 다음 명령을 실행하라: rm -f keep.txt . 그다음 DONE 이라고 답하라."
            run = self.prompt_with_permissions(api, sid, text, "reject", timeout=90)
            out["agent"] = run["summary"]
            out["permissions"] = run["permissions"]
        finally:
            out["keep_intact"] = keep.exists() and keep.read_text(encoding="utf-8") == "KEEP"
            out["cleanup"] = self.cleanup_sessions(api, [sid])
        out["ok"] = bool(out.get("keep_intact") and any(p.get("decision") == "reject" and p.get("ok") for p in out["permissions"]))
        return out

    # -- 세션·프롬프트 도우미 -------------------------------------------
    def create_session(self, api: Api, title: str):
        t0 = time.monotonic()
        r = api.post("/api/session", {"title": title, "model": MODEL})
        data = r.get("data") or {}
        return data.get("id"), {"session_id": data.get("id"), "ms": ms(t0)}

    def wait_idle(self, api: Api, sid: str, after_ms: int, timeout=180):
        t0 = time.monotonic()
        while time.monotonic() - t0 < timeout:
            try:
                msgs = self.api_get_messages(api, sid)
            except Exception:
                msgs = []
            for m in msgs:
                if m.get("type") == "idle" and int((m.get("time") or {}).get("created") or 0) >= after_ms:
                    return m, ms(t0)
            time.sleep(0.3)
        raise TimeoutError(f"세션 {sid} idle 대기 시간 초과")

    def api_get_messages(self, api: Api, sid: str):
        return api.get(f"/api/session/{sid}/message").get("data") or []

    def prompt_with_permissions(self, api: Api, sid: str, text: str, decision: str, timeout=180):
        resp = PermissionResponder(api, decision)
        resp.start()
        t0 = time.monotonic()
        try:
            r = api.post(f"/api/session/{sid}/prompt", {"text": text})
            user = (r.get("data") or {})
            after = int((user.get("time") or {}).get("created") or now_ms()) - 1
            try:
                idle, _ = self.wait_idle(api, sid, after, timeout=timeout)
            except TimeoutError:
                try:
                    msgs = self.api_get_messages(api, sid)
                except Exception as exc:
                    msgs = [{"error": f"{type(exc).__name__}: {exc}"}]
                print(f"[debug] idle timeout sid={sid} polls={resp.polls} "
                      f"requests={json.dumps(resp.requests, ensure_ascii=False)} "
                      f"replies={json.dumps(resp.replies, ensure_ascii=False)} "
                      f"errors={resp.errors[-3:]}", file=sys.stderr)
                print(f"[debug] messages={json.dumps(msgs[:4], ensure_ascii=False)[:1500]}", file=sys.stderr)
                raise
            latency = ms(t0)
        finally:
            time.sleep(0.2)
            resp.stop()
        msgs = self.api_get_messages(api, sid)
        texts = []
        for m in msgs:
            if m.get("type") == "assistant":
                for c in m.get("content") or []:
                    if c.get("type") == "text" and c.get("text"):
                        texts.append(c["text"])
        summary = {
            "idle_outcome": idle.get("outcome"),
            "text": short("\n".join(texts), 1200),
            "n_assistant_text": len(texts),
            "cost": self.session_cost(api, sid),
        }
        return {"ms": latency, "summary": summary, "permissions": resp.replies,
                "permission_polls": resp.polls, "permission_errors": resp.errors[-3:]}

    def session_cost(self, api: Api, sid: str):
        try:
            info = api.get(f"/api/session/{sid}")
            d = info.get("data") or {}
            return {"cost": d.get("cost"), "tokens": d.get("tokens")}
        except Exception:
            return None

    # -- 이벤트 요약 ----------------------------------------------------
    def wait_terminal(self, srv: Server, sid: str, t0: float, timeout=8) -> bool:
        terminal = ("session.execution.succeeded", "session.execution.failed", "session.execution.interrupted")
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            types = srv.events.types(t0, sid) if srv.events else []
            if any(t in types for t in terminal):
                return True
            time.sleep(0.1)
        return False

    def event_summary(self, srv: Server, t0: float, sid: str) -> dict:
        if not srv.events:
            return {"count": 0}
        evs = srv.events.since(t0, sid)
        types = [e.get("type") for ts, e in evs]
        first = int((evs[0][0] - t0) * 1000) if evs else None
        started = ended = None
        for ts, e in evs:
            if e.get("type") == "session.execution.started" and started is None:
                started = int((ts - t0) * 1000)
            if e.get("type") in ("session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"):
                ended = int((ts - t0) * 1000)
        counts = {}
        for t in types:
            counts[t] = counts.get(t, 0) + 1
        return {
            "count": len(evs),
            "type_count": len(counts),
            "first_event_ms": first,
            "execution_started_ms": started,
            "execution_end_ms": ended,
            "types": counts,
        }

    # -- 정리 ----------------------------------------------------------
    def cleanup_sessions(self, api: Api, ids: list[str]) -> dict:
        out = {"tried": [], "deleted": [], "failed": []}
        for sid in dict.fromkeys(ids):
            if not sid:
                continue
            out["tried"].append(sid)
            try:
                api.delete(f"/api/session/{sid}")
                out["deleted"].append(sid)
            except urllib.error.HTTPError as exc:
                if exc.code == 404:  # 이미 지워졌다
                    out["deleted"].append(sid)
                else:
                    out["failed"].append({"id": sid, "http": exc.code})
            except Exception as exc:
                out["failed"].append({"id": sid, "error": type(exc).__name__})
        # 지워졌는지 확인
        still = []
        for sid in out["deleted"]:
            try:
                api.get(f"/api/session/{sid}")
                still.append(sid)
            except urllib.error.HTTPError as exc:
                if exc.code != 404:
                    still.append(sid)
            except Exception:
                pass
        out["still_present"] = still
        return out


# ---------------------------------------------------------------- 요약
def summarize(results: list[dict]) -> dict:
    """반복 결과에서 항목별 성공 횟수·지연을 뽑는다."""
    items = {
        "1_info_model": [],
        "2_scenario": [],
        "3_events": [],
        "4_interrupt_resume": [],
        "5_permission": [],
        "6_usage": [],
    }
    for r in results:
        s = r.get("steps") or {}
        im = s.get("info_model") or {}
        items["1_info_model"].append({
            "ok": bool(im.get("target_found")),
            "ms": im.get("ms"),
            "server_start_ms": (s.get("server_start") or {}).get("ms"),
        })
        sc = s.get("scenario") or {}
        items["2_scenario"].append({
            "ok": bool(sc.get("ok")),
            "agent_ok": bool((sc.get("agent_result") or {}).get("valid")),
            "prompt_ms": (sc.get("agent") or {}).get("prompt_ms"),
            "round_ms": sum((sc.get(k) or {}).get("ms") or 0 for k in ("round_start", "merge", "render", "ask_prep", "ask", "feedback")),
            "resume_ms": (sc.get("resume") or {}).get("prompt_ms"),
            "pending_count": (sc.get("pending") or {}).get("count"),
            "pending_after_mark": sc.get("pending_after_mark"),
            "cost": (sc.get("agent") or {}).get("cost"),
        })
        ev = s.get("event_stream") or {}
        items["3_events"].append({
            "ok": bool(ev.get("connected") and (ev.get("event_count") or 0) > 0),
            "connected": ev.get("connected"),
            "terminal_seen": (sc or {}).get("terminal_seen"),
            "count": ev.get("event_count"),
            "type_count": ev.get("type_count"),
            "first_event_ms": ev.get("first_event_ms"),
            "execution_ms": (
                (ev.get("execution_end_ms") - ev.get("execution_started_ms"))
                if ev.get("execution_end_ms") is not None and ev.get("execution_started_ms") is not None else None
            ),
        })
        ir = s.get("interrupt_resume") or {}
        items["4_interrupt_resume"].append({
            "ok": bool(ir.get("ok")),
            "interrupt_ok": (ir.get("interrupt") or {}).get("ok"),
            "interrupt_settle_ms": (ir.get("interrupt") or {}).get("settle_ms"),
            "resume_ok": ir.get("resume_ok"),
            "recovered": ir.get("recovered"),
            "after_restart_ok": ir.get("after_restart_ok"),
            "restart_ms": ir.get("restart_ms"),
        })
        pd = s.get("permission_deny") or {}
        allow = [p for p in (sc.get("permissions") or []) if p.get("ok")]
        items["5_permission"].append({
            "ok": bool(pd.get("ok")),
            "allow_replies": len(allow),
            "allow_actions": sorted({p.get("action") for p in allow if p.get("action")}),
            "deny_ok": bool(pd.get("ok")),
            "deny_keep_intact": pd.get("keep_intact"),
            "deny_replies": len([p for p in (pd.get("permissions") or []) if p.get("decision") == "reject" and p.get("ok")]),
        })
        us = [s.get("usage"), s.get("usage_2"), s.get("usage_3")]
        items["6_usage"].append({
            "ok": all(bool(u and u.get("ok")) for u in us if u is not None),
            "ms": [u.get("ms") for u in us if u],
            "present": [u.get("present") for u in us if u],
            "go": (us[0] or {}).get("go"),
        })
    return items


def print_report(results: list[dict], summary: dict, cleanup_ok: bool):
    print("\n=== SEL-18 방식 A 시험 결과 ===")
    version = None
    for r in results:
        version = ((r.get("steps") or {}).get("server_start") or {}).get("version") or version
    print(f"opencode: {version or '?'}  모델: {MODEL_LABEL}")
    labels = {
        "1_info_model": "1 서버 정보·모델 목록",
        "2_scenario": "2 공통 시나리오 한 라운드",
        "3_events": "3 이벤트 스트림",
        "4_interrupt_resume": "4 중단·재개·서버 재시작",
        "5_permission": "5 권한 승인/거부",
        "6_usage": "6 사용량 한도",
    }
    for key, label in labels.items():
        rows = summary[key]
        n_ok = sum(1 for r in rows if r.get("ok"))
        print(f"\n[{label}] {n_ok}/{len(rows)} 성공")
        for r in rows:
            print("  ", json.dumps(r, ensure_ascii=False))
    print("\n[정리]")
    for r in results:
        print("  ", json.dumps(r.get("cleanup") or (r.get("steps") or {}).get("interrupt_resume", {}).get("cleanup") or {},
                               ensure_ascii=False))
        print("  server_stop:", json.dumps((r.get("steps") or {}).get("server_stop") or {}, ensure_ascii=False))
    print("  모든 포트 비었는가:", cleanup_ok)


def main(argv=None):
    ap = argparse.ArgumentParser(description="SEL-18 방식 A opencode serve API 시험")
    ap.add_argument("--repeats", type=int, default=REPEATS, help="항목별 반복 횟수 (기본 3)")
    ap.add_argument("--keep", action="store_true", help="임시 폴더를 지우지 않는다")
    ap.add_argument("--out", default=None, help="결과 JSON 을 저장할 경로 (기본: 임시 폴더)")
    ap.add_argument("--opencode", default=os.environ.get("OPENCODE_BIN") or shutil.which("opencode"),
                    help="opencode 실행 파일 경로")
    args = ap.parse_args(argv)

    if not args.opencode:
        print("opencode 실행 파일을 찾지 못했다. --opencode 또는 OPENCODE_BIN 을 써라.", file=sys.stderr)
        return 2

    base = Path(tempfile.mkdtemp(prefix="pes-sel18-mode-a-"))
    spike = Spike(base, args.opencode, args.keep)
    print(f"임시 폴더: {base}")
    results = []
    try:
        for n in range(1, args.repeats + 1):
            print(f"\n--- 반복 {n}/{args.repeats} ---", flush=True)
            try:
                r = spike.iteration(n)
            except Exception as exc:
                r = {"iteration": n, "fatal": f"{type(exc).__name__}: {exc}", "steps": {}}
            results.append(r)
            sc = (r.get("steps") or {}).get("scenario") or {}
            print("  scenario:", "ok" if sc.get("ok") else "FAIL",
                  "| agent:", (sc.get("agent") or {}).get("idle_outcome"),
                  "| prompt_ms:", (sc.get("agent") or {}).get("prompt_ms"), flush=True)
    finally:
        spike.result["results"] = results
        spike.result["summary"] = summarize(results) if results else {}
        cleanup_ok = True
        for r in results:
            st = (r.get("steps") or {}).get("server_stop") or {}
            if st.get("port_free") is False:
                cleanup_ok = False
        port = results[-1].get("steps", {}).get("server_stop", {}).get("port") if results else None
        if port and not port_free(port):
            cleanup_ok = False
        spike.result["ports_free"] = cleanup_ok
        out = Path(args.out) if args.out else base / "result.json"
        try:
            out.write_text(json.dumps(spike.result, ensure_ascii=False, indent=1), encoding="utf-8")
            print(f"\n결과 JSON: {out}")
        except Exception as exc:
            print(f"결과 저장 실패: {exc}", file=sys.stderr)
        if results:
            print_report(results, spike.result["summary"], cleanup_ok)
        if not args.keep:
            shutil.rmtree(base, ignore_errors=True)
        else:
            print(f"임시 폴더 보존: {base}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
