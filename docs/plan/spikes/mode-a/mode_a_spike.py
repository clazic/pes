#!/usr/bin/env python3
"""SEL-18 방식 A 시험 — opencode serve HTTP API로 PES 한 라운드 왕복.

표준 라이브러리만 쓴다. 실행 방법은 같은 폴더의 README.md 참고.

안전 규칙(코드가 지키는 것):
- PES 는 항상 PES_HOME=<임시 폴더> 로만 실행한다. ~/pes-projects, ~/.pes 를 쓰지 않는다.
  opencode 서버 프로세스와 세션 환경에도 임시 PES_HOME 을 넣고, 상속된 PES_PROJECT 를 지운다.
  도구 안에서 실제 값이 임시 폴더인지 확인한다(프롬프트 문자열에만 의존하지 않는다).
- opencode serve 는 개인 서버만 띄운다. `--service` 를 쓰지 않고, 기본 포트가 아니라
  빈 포트를 골라 127.0.0.1 에만 연다. 끝나면 반드시 종료하고 포트가 비었는지 확인한다.
- 모델은 opencode-go/deepseek-v4.1-flash 하나만 쓴다.
- 시험에서 만든 세션은 만든 직후 소유 목록에 넣고, 서버가 살아 있는 finally 에서 ID 로만 지운다.
  다른 세션은 건드리지 않는다. 서버 장애로 못 지우면 남은 ID 와 실패를 결과에 보존한다.
- 비밀번호·토큰은 화면·저장소에 남기지 않는다. 서버 로그는 임시 폴더 안에만 두고,
  남길 때도 비밀번호를 마스킹한다. 결과 JSON 은 경로·비밀번호를 지운 뒤 저장한다.
"""

from __future__ import annotations

import argparse
import base64
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

# 서버가 출력하는 비밀번호를 결과·예외에 남기지 않기 위한 전역 목록
SECRETS: set[str] = set()


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
    # 자르기 전에 정제한다. 잘린 뒤에는 경로 전체가 남지 않아 치환이 실패할 수 있다.
    text = " ".join(scrub(str(text)).split())
    return text[:n] + ("…" if len(text) > n else "")


def scrub(text: str, base: Path | None = None) -> str:
    """비밀번호·로컬 경로를 지운다. 결과 JSON·예외 문자열에 쓴다."""
    text = str(text)
    for s in list(SECRETS):
        if s:
            text = text.replace(s, "***")
    text = re.sub(r"server password \S+", "server password ***", text)
    text = re.sub(r"(?i)authorization:\s*\S+", "authorization: ***", text)
    if base is not None:
        for candidate in sorted({str(base), str(base.resolve())}, key=len, reverse=True):
            text = text.replace(candidate, "<TMP>")
    # macOS 는 임시 폴더 경로가 두 형태로 나온다. 둘 다 잡는다.
    # 패턴을 런타임에 조립해 소스·바이트코드에 경로 문자열이 그대로 남지 않게 한다.
    tmp_pat = "(?:/private)?" + "".join(["/var", "/folders/"]) + r"[^\s\"']*"
    text = re.sub(tmp_pat, "<TMP>", text)
    # 공개 저장소에 로컬 홈 경로를 남기지 않는다.
    home_pat = "".join(["/", "Users", "/"]) + r"[^\s\"']+"
    text = re.sub(home_pat, "<HOME>", text)
    return text


def sanitize(obj, base: Path):
    if isinstance(obj, dict):
        return {k: sanitize(v, base) for k, v in obj.items()}
    if isinstance(obj, list):
        return [sanitize(v, base) for v in obj]
    if isinstance(obj, str):
        return scrub(obj, base)
    return obj


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

    def put(self, path, body=None, timeout=60):
        return self._req("PUT", path, body or {}, timeout=timeout)[1]

    def delete(self, path, timeout=60):
        return self._req("DELETE", path, timeout=timeout)


class EventStream(threading.Thread):
    """GET /api/event (SSE) 를 읽어 (수신시각, 이벤트) 목록으로 쌓는다.

    소켓 timeout 으로 buffered reader 가 깨지는 문제를 피하려고 resp.read1() 로
    도착한 만큼만 읽는다. stop() 은 응답을 닫아 읽기를 풀고 join 한다.
    """

    def __init__(self, host: str, port: int, password: str):
        super().__init__(daemon=True)
        self.host, self.port = host, port
        self.auth = "Basic " + base64.b64encode(f"opencode:{password}".encode()).decode()
        self.events: list[tuple[float, dict]] = []
        self._stop_event = threading.Event()
        self._lock = threading.Lock()
        self._resp = None
        self.connected = False
        self.error = None

    def run(self):
        try:
            req = urllib.request.Request(
                f"http://{self.host}:{self.port}/api/event",
                headers={"Authorization": self.auth, "Accept": "text/event-stream"},
            )
            # timeout 을 두지 않는다. 읽기는 stop() 의 close 로만 풀고,
            # 연결이 끊기면 재접속하지 않고 error 로 끝난다(문서 '한계' 참고).
            resp = urllib.request.urlopen(req)
            self._resp = resp
            if getattr(resp, "status", 200) != 200:
                self.error = f"HTTP {resp.status}"
                return
            self.connected = True
            buf = b""
            while not self._stop_event.is_set():
                try:
                    chunk = resp.read1(4096)
                except Exception as exc:  # stop() 이 응답을 닫으면 여기로 온다
                    if not self._stop_event.is_set():
                        self.error = f"{type(exc).__name__}: {exc}"
                    return
                if not chunk:
                    return
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    line = line.rstrip(b"\r")
                    if not line.startswith(b"data: "):
                        continue
                    try:
                        ev = json.loads(line[6:])
                    except Exception:
                        continue
                    with self._lock:
                        self.events.append((time.monotonic(), ev))
        except Exception as exc:
            if not self._stop_event.is_set():
                self.error = f"{type(exc).__name__}: {exc}"
        finally:
            self._close()

    def _close(self):
        try:
            if self._resp is not None:
                self._resp.close()
        except Exception:
            pass

    def stop(self):
        self._stop_event.set()
        self._close()
        self.join(timeout=5)

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
    def __init__(self, directory: Path, log_path: Path, opencode_bin: str, pes_home: Path):
        self.directory = directory
        self.log_path = log_path
        self.opencode_bin = opencode_bin
        self.pes_home = pes_home
        self.port = None
        self.proc = None
        self.api = None
        self.events = None
        self.password = None

    def _env(self):
        env = os.environ.copy()
        env["PES_HOME"] = str(self.pes_home)
        env.pop("PES_PROJECT", None)
        return env

    def start(self, port: int | None = None):
        self.port = port or free_port()
        # 재시작할 때 이전 서버의 비밀번호 줄을 다시 읽지 않도록 로그를 새로 쓴다.
        log = self.log_path.open("wb")
        self.proc = subprocess.Popen(
            [self.opencode_bin, "serve", "--hostname", "127.0.0.1", "--port", str(self.port)],
            cwd=str(self.directory),
            stdout=log,
            stderr=subprocess.STDOUT,
            env=self._env(),
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
                    SECRETS.add(self.password)
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
            self.events = None
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
        # 남길 수 있는 로그에서도 비밀번호를 지운다.
        try:
            if self.log_path.exists():
                self.log_path.write_text(scrub(self.log_path.read_text(errors="replace")), encoding="utf-8")
        except Exception:
            pass
        if self.port:
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline and not port_free(self.port):
                time.sleep(0.2)

    def log_tail(self, n=800):
        try:
            return scrub(self.log_path.read_text(errors="replace")[-n:], self.directory)
        except Exception:
            return "(로그 없음)"


# ---------------------------------------------------------------- 권한 응답기
class PermissionResponder(threading.Thread):
    """대상 세션(sid)의 대기 권한 요청만 poll 해서 once/reject 로 답한다."""

    def __init__(self, api: Api, decision: str, sid: str, reject_if=None):
        super().__init__(daemon=True)
        self.api = api
        self.sid = sid
        # API enum 은 once|always|reject 다. 시험 코드에서는 allow/deny 로 부른다.
        self.decision = {"allow": "once", "deny": "reject"}.get(decision, decision)
        self.reject_if = reject_if
        self._stop_event = threading.Event()
        self.seen: set[str] = set()
        self.requests: list[dict] = []
        self.replies: list[dict] = []
        self.polls = 0
        self.errors: list[str] = []

    def run(self):
        while not self._stop_event.is_set():
            self.polls += 1
            try:
                data = self.api.get("/api/permission/request", timeout=10).get("data") or []
            except Exception as exc:
                self.errors.append(f"{type(exc).__name__}: {exc}")
                data = []
            if self._stop_event.is_set():
                return
            for r in data:
                if r.get("sessionID") != self.sid:
                    continue  # 다른 세션의 요청은 건드리지도 기록하지도 않는다
                rid = r.get("id")
                if not rid or rid in self.seen:
                    continue
                self.seen.add(rid)
                rec = {"sessionID": r.get("sessionID"), "action": r.get("action"), "resources": r.get("resources")}
                self.requests.append(rec)
                decision = "reject" if (self.reject_if and self.reject_if(rec)) else self.decision
                try:
                    self.api.post(
                        f"/api/session/{self.sid}/permission/{rid}/reply",
                        {"decision": decision, "message": "SEL-18 spike"},
                        timeout=10,
                    )
                    self.replies.append({**rec, "id": rid, "decision": decision, "ok": True})
                except urllib.error.HTTPError as exc:
                    body = ""
                    try:
                        body = exc.read().decode(errors="replace")[:300]
                    except Exception:
                        pass
                    self.replies.append({**rec, "id": rid, "decision": decision, "ok": False,
                                         "error": f"HTTP {exc.code}", "body": scrub(body)})
                except Exception as exc:
                    self.replies.append({**rec, "id": rid, "decision": decision, "ok": False,
                                         "error": type(exc).__name__})
            time.sleep(0.2)

    def stop(self):
        self._stop_event.set()
        self.join(timeout=5)


# ---------------------------------------------------------------- PES 실행
class Pes:
    def __init__(self, root: Path):
        self.root = root

    def env(self):
        env = os.environ.copy()
        env["HOME"] = str(self.root)  # ~/.pes/config.json 을 읽지 않게 격리
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
        self.owned_sessions: list[str] = []
        self.result = {
            "started": time.strftime("%Y-%m-%d %H:%M:%S"),
            "opencode_version": None,
            "results": [],
            "summary": {},
        }

    # -- 한 번의 반복 -------------------------------------------------
    def iteration(self, n: int) -> dict:
        root = self.base / f"run-{n}"
        proj = root / "proj"
        root.mkdir(parents=True)
        pes = Pes(root)
        rec = {"iteration": n, "steps": {}, "sessions": []}
        srv = None
        api = None
        first_session = len(self.owned_sessions)
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

            # 2) 개인 서버 기동 — 프로세스 환경에 임시 PES_HOME 을 넣는다
            srv = Server(proj, root / "opencode.log", self.opencode_bin, root)
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

            # 4) 항목 2 — 공통 시나리오 한 라운드 (답 처리 뒤 서버 재시작·재개 포함)
            sc = self.scenario(pes, proj, root, api, srv)
            rec["steps"]["scenario"] = sc
            api = srv.api  # 시나리오 안에서 서버를 재시작했다

            # 5) 항목 3 — 이벤트 스트림 (시나리오 첫 프롬프트 동안 수집)
            ev = sc.get("events") or {}
            terminal_seen = bool(sc.get("terminal_seen"))
            rec["steps"]["event_stream"] = {
                "ok": bool(ev.get("connected") and terminal_seen and ev.get("count", 0) > 0
                           and ev.get("execution_started_ms") is not None and ev.get("execution_end_ms") is not None),
                "connected": ev.get("connected"),
                "error": ev.get("error"),
                "terminal_seen": terminal_seen,
                "event_count": ev.get("count"),
                "type_count": ev.get("type_count"),
                "first_event_ms": ev.get("first_event_ms"),
                "execution_started_ms": ev.get("execution_started_ms"),
                "execution_end_ms": ev.get("execution_end_ms"),
                "types": ev.get("types"),
            }

            # 6) 항목 4 — 중단·재개 + 서버 재시작 복구
            rec["steps"]["interrupt_resume"] = self.interrupt_resume(proj, root, api, srv)
            api = srv.api

            # 7) 항목 5 — 권한 승인(시나리오 증거)과 거부(별도 시험)를 따로 판정
            deny = self.permission_deny(proj, root, api)
            approval = self.approval_from_scenario(sc)
            rec["steps"]["permission"] = {
                "ok": bool(approval.get("ok") and deny.get("ok")),
                "approval": approval,
                "deny": deny,
            }

            # 8) 항목 6 — 사용량 한도 (세 번 모두 있어야 성공)
            rec["steps"]["usage_2"] = self.usage(api)
            rec["steps"]["usage_3"] = self.usage(api)
        except Exception as exc:
            rec["fatal"] = scrub(f"{type(exc).__name__}: {exc}", self.base)
            rec["traceback"] = scrub(traceback.format_exc()[-3000:], self.base)
        finally:
            ids = self.owned_sessions[first_session:]
            rec["sessions"] = list(ids)
            rec["cleanup"] = self.cleanup_sessions(srv.api if srv else None, ids)
            if srv is not None:
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
        out = {"ok": False, "ms": ms(t0), "present": isinstance(d, dict)}
        if not isinstance(d, dict):
            out["reason"] = "data 없음"
            return out
        go = d.get("go")
        if not isinstance(go, dict):
            out["reason"] = "go 없음"
            return out
        meters = {}
        valid = True
        for key in ("rolling", "weekly", "monthly"):
            m = go.get(key)
            if not isinstance(m, dict):
                valid = False
                continue
            pct = m.get("percent")
            limited = m.get("limited")
            resets = m.get("resetsAt")
            good = (isinstance(pct, (int, float)) and 0 <= pct <= 100
                    and isinstance(limited, bool) and isinstance(resets, (int, float)))
            valid = valid and good
            meters[key] = {"percent": pct, "limited": limited, "resetsAt": resets, "valid": good}
        out.update({"ok": valid, "go": meters, "n_budgets": len(d.get("budgets") or [])})
        if not valid:
            out["reason"] = "Go 미터 필드 불완전"
        return out

    # -- 공통 시나리오 -------------------------------------------------
    def scenario(self, pes: Pes, proj: Path, root: Path, api: Api, srv: Server) -> dict:
        out = {"ok": False}

        rs = pes.run("round-start", proj, "plan")
        out["round_start"] = {k: rs[k] for k in ("code", "ms", "out")}
        if rs["code"] != 0:
            out["error"] = "round-start 실패: " + rs["err"]
            return out

        sid, create_ms = self.create_session(api, "SEL-18 scenario")
        out["session_ms"] = create_ms
        out["session_id"] = sid
        out["session_env"] = self.set_session_env(api, sid, root)

        prompt_text = (
            "합성 PES 프로젝트의 기획 단계 작업이다. 아래 순서대로 실행하라. "
            "PES_HOME 을 명령 앞에 직접 붙이지 말고, 이미 설정된 환경변수를 그대로 써라.\n"
            f"1) 셸 도구로 작업 폴더({proj})에서 다음을 실행하라.\n"
            "   printf '%s\\n' \"$PES_HOME\" > env-home.txt\n"
            "   printf '%s\\n' \"${PES_PROJECT:-}\" > env-project.txt\n"
            f"   {sys.executable} {PES} status {proj}\n"
            "2) status 출력에서 '현재 단계'와 기획 단계의 R 숫자를 확인하라.\n"
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
        out["tools"] = run.get("tools") or []

        # 도구 안에서 실제 환경변수 확인 (프롬프트 문자열이 아니라 파일 내용)
        env_home = self._read(proj / "env-home.txt")
        env_project = self._read(proj / "env-project.txt")
        accepted_home = {str(root), str(root.resolve())}
        out["env_check"] = {
            "home": env_home,
            "home_ok": env_home in accepted_home,
            "project": env_project,
            "project_removed": env_project == "",
        }

        # SSE 는 비동기라 idle 직후에는 마지막 이벤트가 아직 안 왔을 수 있다.
        out["terminal_seen"] = self.wait_terminal(srv, sid, t0, timeout=8)
        out["events"] = self.event_summary(srv, t0, sid)

        # 모델이 만든 결과 확인 — 실패하면 PES 쪽 파이프라인 측정용 고정 결과로 이어 간다.
        result_file = proj / "result.json"
        agent_ok = False
        agent_summary = ""
        if result_file.exists():
            try:
                rj = json.loads(result_file.read_text(encoding="utf-8"))
                agent_ok = rj.get("id") == "plan-agent-1" and bool(rj.get("summary"))
                agent_summary = str(rj.get("summary") or "")
            except Exception:
                agent_ok = False
        out["agent_summary"] = agent_summary
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
        env["HOME"] = str(root)  # ~/.pes/config.json 을 읽지 않게 격리
        env["PES_HOME"] = str(root)
        env.pop("PES_PROJECT", None)
        log = (root / "serve.log").open("ab")
        serve = subprocess.Popen(
            [sys.executable, "-I", str(SERVE), str(root), str(sport)],
            stdout=log,
            stderr=subprocess.STDOUT,
            env=env,
            start_new_session=True,
        )
        log.close()
        feedback_text = "합성 답변: 청년 정책을 우선한다. (SEL-18 시험)"
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
                "text": feedback_text,
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

        # 재개: 개인 서버를 끄고 다시 띄운 뒤, 같은 시나리오 세션을 복구해
        # 이전 결과(result.json)와 사람 답(feedback)에 의존하는 작업을 이어 쓴다.
        port = srv.port
        srv.stop()
        out["server_stop_before_resume"] = {"port": port, "port_free": port_free(port)}
        srv2 = Server(proj, srv.log_path, self.opencode_bin, root)
        t0 = time.monotonic()
        try:
            srv2.start(port=port)
        except Exception:
            srv2.stop()
            raise
        out["restart_ms"] = ms(t0)
        out["restart_port"] = port
        srv.__dict__.update(srv2.__dict__)  # 이후 단계가 같은 서버를 보게 한다
        api = srv2.api
        try:
            got = api.get(f"/api/session/{sid}")
            out["recovered"] = bool(got and (got.get("data") or {}).get("id") == sid)
        except urllib.error.HTTPError as exc:
            out["recovered"] = False
            out["recover_http"] = exc.code

        resume_text = (
            "이 세션은 서버 재시작 전에 result.json 을 만들었고, 사람이 기동 단계 질문에 답했다. "
            "아래를 이어서 하라. PES_HOME 을 명령 앞에 직접 붙이지 말고 환경변수를 그대로 써라.\n"
            f"1) 셸로 작업 폴더({proj})에서 다음을 실행하라.\n"
            "   printf '%s\\n' \"$PES_HOME\" > env-home-after-restart.txt\n"
            f"   {sys.executable} {PES} status {proj}\n"
            f"2) {proj}/result.json 과 {proj}/feedback/ 의 가장 최근 .json 파일을 읽어라.\n"
            f"3) {proj}/plan-result.md 에 다음 세 줄을 그대로 써라.\n"
            "   이전 결과: <result.json 의 summary 값>\n"
            "   사람 답: <feedback 파일의 text 값>\n"
            "   처리 안 한 답: <status 출력의 처리 안 한 답 개수>\n"
            "4) 마지막 답변에 RESUME-OK 라고만 써라."
        )
        run2 = self.prompt_with_permissions(api, sid, resume_text, "allow", timeout=180)
        out["resume"] = run2["summary"]
        out["resume"]["prompt_ms"] = run2["ms"]
        out["resume_tools"] = run2.get("tools") or []
        out["permissions"] += run2["permissions"]

        env_after = self._read(proj / "env-home-after-restart.txt")
        plan_md = self._read(proj / "plan-result.md")
        out["post_restart_env"] = {"home": env_after, "home_ok": env_after in accepted_home}
        out["plan_result"] = short(plan_md, 800)
        resume_text_ok = (
            "RESUME-OK" in (run2["summary"].get("text") or "")
            and bool(agent_summary)
            and agent_summary in plan_md
            and feedback_text in plan_md
            and "처리 안 한 답: 0" in plan_md
            and out["post_restart_env"]["home_ok"]
        )
        out["resume_ok"] = bool(resume_text_ok)

        out["ok"] = bool(
            agent_ok
            and out["env_check"]["home_ok"]
            and out["env_check"]["project_removed"]
            and out.get("ask_html")
            and out.get("index_html")
            and out.get("feedback", {}).get("http") == 200
            and out.get("pending", {}).get("count") == 1
            and out.get("pending_after_mark") == 0
            and out.get("recovered")
            and out["resume_ok"]
        )
        return out

    # -- 중단·재개·서버 재시작 -----------------------------------------
    def interrupt_resume(self, proj: Path, root: Path, api: Api, srv: Server) -> dict:
        out = {"ok": False}
        sid, create_ms = self.create_session(api, "SEL-18 interrupt")
        out["session_ms"] = create_ms
        out["session_id"] = sid
        out["session_env"] = self.set_session_env(api, sid, root)

        text = (
            "셸 도구로 정확히 다음 명령을 실행하라: sleep 45 ; echo slow > slow.txt . "
            "그 전에 다른 명령을 실행하지 마라. 끝나면 SLOW-DONE 이라고 답하라."
        )
        t0 = time.monotonic()
        resp = PermissionResponder(api, "allow", sid)
        resp.start()
        shell_seen = {"found": False, "entries": [], "ms": None}
        prompt_epoch = now_ms()
        try:
            api.post(f"/api/session/{sid}/prompt", {"text": text})
            # sleep 셸이 실제로 떠 있는지 /api/shell 로 확인한다. 대상 세션 것만 본다.
            deadline = time.monotonic() + 25
            while time.monotonic() < deadline:
                try:
                    shells = api.get("/api/shell").get("data") or []
                except Exception:
                    shells = []
                running = [s for s in shells if s.get("status") == "running"
                           and "sleep" in str(s.get("command") or "")
                           and (s.get("metadata") or {}).get("sessionID") == sid]
                if running:
                    shell_seen = {"found": True, "entries": running, "ms": ms(t0)}
                    break
                time.sleep(0.2)
            time.sleep(0.5)
            t_int = time.monotonic()
            try:
                ir = api.post(f"/api/session/{sid}/interrupt")
                out["interrupt"] = {"ok": True, "ms": ms(t_int), "response": ir}
            except Exception as exc:
                out["interrupt"] = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
            idle, wait_ms = self.wait_idle(api, sid, prompt_epoch - 1, timeout=60)
            out["interrupt"]["idle_outcome"] = idle.get("outcome")
            out["interrupt"]["settle_ms"] = wait_ms
        finally:
            resp.stop()
        out["sleep_shell"] = shell_seen
        out["permissions_interrupt"] = resp.replies

        # 중단 뒤 sleep 셸이 더 이상 running 이 아닌지 확인 (종료 반영에 잠깐 걸릴 수 있다)
        shells_after = []
        gone = False
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                shells_after = api.get("/api/shell").get("data") or []
            except Exception:
                shells_after = []
            sleeper = [s for s in shells_after if "sleep" in str(s.get("command") or "")
                       and (s.get("metadata") or {}).get("sessionID") == sid]
            if not any(s.get("status") == "running" for s in sleeper):
                gone = True
                break
            time.sleep(0.25)
        out["sleep_after"] = [s for s in shells_after if "sleep" in str(s.get("command") or "")
                              and (s.get("metadata") or {}).get("sessionID") == sid]
        out["sleep_gone"] = gone

        # 같은 세션 이어 쓰기
        run = self.prompt_with_permissions(api, sid, "정확히 RESUME-OK 라고만 답하라.", "allow", timeout=120)
        out["resume"] = run["summary"]
        out["resume_ok"] = "RESUME-OK" in (run["summary"].get("text") or "")

        # 개인 서버 재시작 후 세션 복구
        port = srv.port
        srv.stop()
        out["server_stop_before_restart"] = {"port": port, "port_free": port_free(port)}
        srv2 = Server(proj, srv.log_path, self.opencode_bin, root)
        t0 = time.monotonic()
        try:
            srv2.start(port=port)
        except Exception:
            srv2.stop()
            raise
        out["restart_ms"] = ms(t0)
        out["restart_port"] = port
        srv.__dict__.update(srv2.__dict__)
        api = srv2.api
        try:
            got = api.get(f"/api/session/{sid}")
            out["recovered"] = bool(got and (got.get("data") or {}).get("id") == sid)
        except urllib.error.HTTPError as exc:
            out["recovered"] = False
            out["recover_http"] = exc.code
        run = self.prompt_with_permissions(api, sid, "정확히 AFTER-RESTART 라고만 답하라.", "allow", timeout=120)
        out["after_restart"] = run["summary"]
        out["after_restart_ok"] = "AFTER-RESTART" in (run["summary"].get("text") or "")

        out["ok"] = bool(
            shell_seen["found"]
            and out.get("sleep_gone")
            and (out.get("interrupt", {}).get("response") or {}).get("interrupted") is True
            and out.get("interrupt", {}).get("idle_outcome") == "interrupted"
            and out.get("resume_ok")
            and out.get("recovered")
            and out.get("after_restart_ok")
        )
        return out

    # -- 권한 거부 ------------------------------------------------------
    def permission_deny(self, proj: Path, root: Path, api: Api) -> dict:
        """keep.txt 삭제 요청만 reject 한다. 다른 셸(상태 확인 등)은 허용해
        에이전트가 실제 삭제 명령까지 도달하는지 본다."""
        out = {"ok": False, "attempts": 0, "permissions": [], "agents": []}
        keep = proj / "keep.txt"
        keep.write_text("KEEP", encoding="utf-8")
        sid, create_ms = self.create_session(api, "SEL-18 deny")
        out["session_ms"] = create_ms
        out["session_id"] = sid
        out["session_env"] = self.set_session_env(api, sid, root)

        def reject_if(rec):
            # 삭제 계열 명령만 거부한다. cat/ls 같은 읽기는 허용해 rm 시도까지 도달하게 한다.
            joined = " ".join(str(r) for r in (rec.get("resources") or []))
            return bool(re.search(r"\brm\b|\bunlink\b|os\.remove|unlink\(", joined))

        def is_delete(rec):
            joined = " ".join(str(r) for r in (rec.get("resources") or []))
            return bool(re.search(r"\brm\b", joined) and "keep.txt" in joined)

        try:
            prompts = [
                "셸 도구로 정확히 rm -f keep.txt 를 실행하라. 그다음 DONE 이라고 답하라.",
                "아직 삭제 명령을 실행하지 않았다. 다른 도구를 쓰지 말고 셸 도구로 rm -f keep.txt 만 실행하라. "
                "그다음 DONE 이라고 답하라.",
            ]
            for text in prompts:
                out["attempts"] += 1
                run = self.prompt_with_permissions(api, sid, text, "allow", timeout=90, reject_if=reject_if)
                out["agents"].append(run["summary"])
                out["permissions"] += run["permissions"]
                out["tools"] = run.get("tools") or []
                target = [
                    p for p in out["permissions"]
                    if p.get("decision") == "reject" and p.get("ok") and is_delete(p)
                ]
                if target:
                    break
        finally:
            out["keep_intact"] = keep.exists() and keep.read_text(encoding="utf-8") == "KEEP"
        target = [
            p for p in out.get("permissions") or []
            if p.get("decision") == "reject" and p.get("ok") and is_delete(p)
        ]
        out["reject_target"] = target
        out["reject_ok"] = bool(target)
        out["ok"] = bool(out["reject_ok"] and out["keep_intact"])
        return out

    # -- 시나리오 증거로 승인 판정 --------------------------------------
    def approval_from_scenario(self, sc: dict) -> dict:
        # scenario 가 1차·재개 프롬프트의 승인 응답을 out["permissions"] 에 합쳐 두었다.
        repl = list(sc.get("permissions") or [])
        once_shell = [p for p in repl if p.get("action") == "shell" and p.get("decision") == "once" and p.get("ok")]
        once_edit = [p for p in repl if p.get("action") == "edit" and p.get("decision") == "once" and p.get("ok")]
        tools = list(sc.get("tools") or []) + list(sc.get("resume_tools") or [])
        shell_exec = self.tool_ok(tools, "shell")
        edit_exec = self.tool_ok(tools, "edit")
        valid = bool((sc.get("agent_result") or {}).get("valid"))
        return {
            "ok": bool(once_shell and once_edit and shell_exec and edit_exec and valid),
            "session_id": sc.get("session_id"),
            "once_shell": len(once_shell),
            "once_edit": len(once_edit),
            "shell_executed": shell_exec,
            "edit_executed": edit_exec,
            "agent_result_valid": valid,
            "replies": repl,
            "tools": tools,
        }

    def tool_ok(self, tools: list[dict], name: str) -> bool:
        # 권한 action `edit` 은 실제 도구 이름이 write/edit/patch 중 하나다.
        names = ("edit", "write", "patch") if name == "edit" else (name,)
        for t in tools:
            if t.get("name") not in names:
                continue
            if t.get("executed") is True:
                return True
            if str(t.get("status") or "").lower() in ("completed", "success", "succeeded"):
                return True
        return False

    # -- 세션·프롬프트 도우미 -------------------------------------------
    def create_session(self, api: Api, title: str):
        t0 = time.monotonic()
        r = api.post("/api/session", {"title": title, "model": MODEL})
        data = r.get("data") or {}
        sid = data.get("id")
        if sid:
            self.owned_sessions.append(sid)  # 만든 직후 소유 목록에 넣는다
        return sid, {"session_id": sid, "ms": ms(t0)}

    def set_session_env(self, api: Api, sid: str, root: Path) -> dict:
        t0 = time.monotonic()
        try:
            api.put(f"/api/session/{sid}/environment", {"variables": {"PES_HOME": str(root)}})
            return {"ok": True, "ms": ms(t0)}
        except urllib.error.HTTPError as exc:
            return {"ok": False, "http": exc.code, "ms": ms(t0)}
        except Exception as exc:
            return {"ok": False, "error": type(exc).__name__, "ms": ms(t0)}

    def wait_terminal(self, srv: Server, sid: str, t0: float, timeout=8) -> bool:
        terminal = ("session.execution.succeeded", "session.execution.failed", "session.execution.interrupted")
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            types = srv.events.types(t0, sid) if srv.events else []
            if any(t in types for t in terminal):
                return True
            time.sleep(0.1)
        return False

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

    def tool_evidence(self, api: Api, sid: str) -> list[dict]:
        out = []
        for m in self.api_get_messages(api, sid):
            if m.get("type") != "assistant":
                continue
            for c in m.get("content") or []:
                if c.get("type") != "tool":
                    continue
                st = c.get("state") or {}
                out.append({
                    "name": c.get("name"),
                    "status": st.get("status"),
                    "executed": c.get("executed"),
                    "input": short(json.dumps(st.get("input") or {}, ensure_ascii=False), 200),
                })
        return out

    def prompt_with_permissions(self, api: Api, sid: str, text: str, decision: str,
                                timeout=180, reject_if=None):
        resp = PermissionResponder(api, decision, sid, reject_if=reject_if)
        resp.start()
        t0 = time.monotonic()
        after = 0
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
                      f"requests={scrub(json.dumps(resp.requests, ensure_ascii=False), self.base)} "
                      f"replies={scrub(json.dumps(resp.replies, ensure_ascii=False), self.base)} "
                      f"errors={resp.errors[-3:]}", file=sys.stderr)
                print(f"[debug] messages={scrub(json.dumps(msgs[:4], ensure_ascii=False)[:1500], self.base)}",
                      file=sys.stderr)
                raise
            latency = ms(t0)
        finally:
            time.sleep(0.2)
            resp.stop()
        # 이번 프롬프트(after) 이후의 assistant 텍스트만 판정에 쓴다.
        msgs = [m for m in self.api_get_messages(api, sid)
                if int((m.get("time") or {}).get("created") or 0) >= after]
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
                "permission_polls": resp.polls, "permission_errors": resp.errors[-3:],
                "tools": self.tool_evidence(api, sid)}

    def session_cost(self, api: Api, sid: str):
        try:
            info = api.get(f"/api/session/{sid}")
            d = info.get("data") or {}
            return {"cost": d.get("cost"), "tokens": d.get("tokens")}
        except Exception:
            return None

    # -- 이벤트 요약 ----------------------------------------------------
    def event_summary(self, srv: Server, t0: float, sid: str) -> dict:
        if not srv.events:
            return {"connected": False, "count": 0}
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
            "connected": bool(srv.events.connected),
            "error": srv.events.error,
            "count": len(evs),
            "type_count": len(counts),
            "first_event_ms": first,
            "execution_started_ms": started,
            "execution_end_ms": ended,
            "types": counts,
        }

    # -- 정리 ----------------------------------------------------------
    def cleanup_sessions(self, api: Api | None, ids: list[str]) -> dict:
        out = {"tried": [], "deleted": [], "failed": [], "still_present": [], "leftover_ids": []}
        for sid in dict.fromkeys(ids):
            if not sid:
                continue
            out["tried"].append(sid)
            if api is None:
                out["failed"].append({"id": sid, "error": "서버 없음"})
                out["leftover_ids"].append(sid)
                continue
            try:
                api.delete(f"/api/session/{sid}")
                out["deleted"].append(sid)
            except urllib.error.HTTPError as exc:
                if exc.code == 404:  # 이미 지워졌다
                    out["deleted"].append(sid)
                else:
                    out["failed"].append({"id": sid, "http": exc.code})
                    out["leftover_ids"].append(sid)
            except Exception as exc:
                out["failed"].append({"id": sid, "error": type(exc).__name__})
                out["leftover_ids"].append(sid)
        # 지워졌는지 확인
        if api is not None:
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
            out["leftover_ids"] += [s for s in still if s not in out["leftover_ids"]]
        return out

    def _read(self, path: Path) -> str:
        try:
            return path.read_text(encoding="utf-8").strip()
        except Exception:
            return ""


# ---------------------------------------------------------------- 요약
def summarize(results: list[dict]) -> dict:
    """반복 결과에서 항목별 성공 횟수·지연을 뽑는다. 미실행은 실패로 센다."""
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
            "ok": bool(im.get("target_found") and (im.get("info") or {}).get("version")),
            "ms": im.get("ms"),
            "server_start_ms": (s.get("server_start") or {}).get("ms"),
            "models": im.get("model_count"),
        })
        sc = s.get("scenario") or {}
        items["2_scenario"].append({
            "ok": bool(sc.get("ok")),
            "agent_ok": bool((sc.get("agent_result") or {}).get("valid")),
            "env_home_ok": bool((sc.get("env_check") or {}).get("home_ok")),
            "env_project_removed": bool((sc.get("env_check") or {}).get("project_removed")),
            "prompt_ms": (sc.get("agent") or {}).get("prompt_ms"),
            "round_ms": sum((sc.get(k) or {}).get("ms") or 0 for k in ("round_start", "merge", "render", "ask_prep", "ask", "feedback")),
            "restart_ms": sc.get("restart_ms"),
            "recovered": sc.get("recovered"),
            "resume_ms": (sc.get("resume") or {}).get("prompt_ms"),
            "resume_ok": sc.get("resume_ok"),
            "pending_count": (sc.get("pending") or {}).get("count"),
            "pending_after_mark": sc.get("pending_after_mark"),
            "cost": (sc.get("agent") or {}).get("cost"),
        })
        ev = s.get("event_stream") or {}
        items["3_events"].append({
            "ok": bool(ev.get("ok")),
            "connected": ev.get("connected"),
            "terminal_seen": ev.get("terminal_seen"),
            "count": ev.get("event_count"),
            "type_count": ev.get("type_count"),
            "first_event_ms": ev.get("first_event_ms"),
            "execution_ms": (
                (ev.get("execution_end_ms") - ev.get("execution_started_ms"))
                if ev.get("execution_end_ms") is not None and ev.get("execution_started_ms") is not None else None
            ),
            "types": ev.get("types"),
        })
        ir = s.get("interrupt_resume") or {}
        items["4_interrupt_resume"].append({
            "ok": bool(ir.get("ok")),
            "sleep_seen": bool((ir.get("sleep_shell") or {}).get("found")),
            "sleep_gone": ir.get("sleep_gone"),
            "interrupted": (ir.get("interrupt", {}).get("response") or {}).get("interrupted"),
            "idle_outcome": (ir.get("interrupt") or {}).get("idle_outcome"),
            "interrupt_settle_ms": (ir.get("interrupt") or {}).get("settle_ms"),
            "resume_ok": ir.get("resume_ok"),
            "recovered": ir.get("recovered"),
            "after_restart_ok": ir.get("after_restart_ok"),
            "restart_ms": ir.get("restart_ms"),
        })
        pm = s.get("permission") or {}
        ap = pm.get("approval") or {}
        dn = pm.get("deny") or {}
        items["5_permission"].append({
            "ok": bool(pm.get("ok")),
            "approval_ok": bool(ap.get("ok")),
            "once_shell": ap.get("once_shell"),
            "once_edit": ap.get("once_edit"),
            "shell_executed": ap.get("shell_executed"),
            "edit_executed": ap.get("edit_executed"),
            "deny_ok": bool(dn.get("ok")),
            "keep_intact": dn.get("keep_intact"),
            "reject_target": bool(dn.get("reject_ok")),
            "deny_attempts": dn.get("attempts"),
        })
        us = [s.get("usage"), s.get("usage_2"), s.get("usage_3")]
        items["6_usage"].append({
            "ok": bool(all(isinstance(u, dict) and u.get("ok") for u in us)),
            "ms": [u.get("ms") if isinstance(u, dict) else None for u in us],
            "present": [u.get("present") if isinstance(u, dict) else None for u in us],
            "go": (us[0] or {}).get("go") if isinstance(us[0], dict) else None,
        })
    return items


def print_report(results: list[dict], summary: dict, ports_ok: bool):
    print("\n=== SEL-18 방식 A 시험 결과 ===")
    version = None
    for r in results:
        version = ((r.get("steps") or {}).get("server_start") or {}).get("version") or version
    print(f"opencode: {version or '?'}  모델: {MODEL_LABEL}")
    labels = {
        "1_info_model": "1 서버 정보·모델 목록",
        "2_scenario": "2 공통 시나리오 한 라운드(재시작·재개 포함)",
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
        print("  ", json.dumps(r.get("cleanup") or {}, ensure_ascii=False))
        print("  sessions:", json.dumps(r.get("sessions") or [], ensure_ascii=False))
        print("  server_stop:", json.dumps((r.get("steps") or {}).get("server_stop") or {}, ensure_ascii=False))
    print("  모든 포트 비었는가:", ports_ok)


def run_failed(results: list[dict], summary: dict) -> bool:
    if not results:
        return True
    for r in results:
        if r.get("fatal"):
            return True
        s = r.get("steps") or {}
        if not (s.get("info_model") or {}).get("target_found"):
            return True
        if not (s.get("scenario") or {}).get("ok"):
            return True
        if not (s.get("event_stream") or {}).get("ok"):
            return True
        if not (s.get("interrupt_resume") or {}).get("ok"):
            return True
        if not (s.get("permission") or {}).get("ok"):
            return True
        us = [s.get("usage"), s.get("usage_2"), s.get("usage_3")]
        if not all(isinstance(u, dict) and u.get("ok") for u in us):
            return True
        cl = r.get("cleanup") or {}
        if cl.get("failed") or cl.get("still_present") or cl.get("leftover_ids"):
            return True
        if ((s.get("server_stop") or {}).get("port_free")) is not True:
            return True
    return False


def main(argv=None):
    ap = argparse.ArgumentParser(description="SEL-18 방식 A opencode serve API 시험")
    ap.add_argument("--repeats", type=int, default=REPEATS, help="항목별 반복 횟수 (1 이상)")
    ap.add_argument("--keep", action="store_true", help="임시 폴더를 지우지 않는다")
    ap.add_argument("--out", default=None, help="결과 JSON 을 저장할 경로 (기본: 임시 폴더)")
    ap.add_argument("--opencode", default=os.environ.get("OPENCODE_BIN") or shutil.which("opencode"),
                    help="opencode 실행 파일 경로")
    args = ap.parse_args(argv)

    if not args.opencode:
        print("opencode 실행 파일을 찾지 못했다. --opencode 또는 OPENCODE_BIN 을 써라.", file=sys.stderr)
        return 2
    if args.repeats < 1:
        print("--repeats 는 1 이상이어야 한다.", file=sys.stderr)
        return 2

    base = Path(tempfile.mkdtemp(prefix="pes-sel18-mode-a-"))
    spike = Spike(base, args.opencode, args.keep)
    print(f"임시 폴더: {base}")
    results = []
    save_error = None
    try:
        for n in range(1, args.repeats + 1):
            print(f"\n--- 반복 {n}/{args.repeats} ---", flush=True)
            try:
                r = spike.iteration(n)
            except Exception as exc:
                r = {"iteration": n, "fatal": scrub(f"{type(exc).__name__}: {exc}", base),
                     "traceback": scrub(traceback.format_exc()[-3000:], base), "steps": {}}
            results.append(r)
            sc = (r.get("steps") or {}).get("scenario") or {}
            print("  scenario:", "ok" if sc.get("ok") else "FAIL",
                  "| env_home:", (sc.get("env_check") or {}).get("home_ok"),
                  "| restart:", sc.get("restart_ms"),
                  "| resume_ok:", sc.get("resume_ok"),
                  "| prompt_ms:", (sc.get("agent") or {}).get("prompt_ms"), flush=True)
    finally:
        spike.result["results"] = results
        spike.result["summary"] = summarize(results) if results else {}
        ports_ok = True
        for r in results:
            st = (r.get("steps") or {}).get("server_stop") or {}
            if st.get("port_free") is False:
                ports_ok = False
        spike.result["ports_free"] = ports_ok
        failed = run_failed(results, spike.result["summary"])
        spike.result["failed"] = failed

        clean = sanitize(spike.result, base)
        out = Path(args.out) if args.out else base / "result.json"
        try:
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(json.dumps(clean, ensure_ascii=False, indent=1), encoding="utf-8")
            print(f"\n결과 JSON: {out}")
        except Exception as exc:
            save_error = f"{type(exc).__name__}: {exc}"
            print(f"결과 저장 실패: {save_error}", file=sys.stderr)

        if results:
            print_report(results, spike.result["summary"], ports_ok)

        # 실패·정리 미완이면 임시 폴더와 남은 세션 ID 를 보존한다.
        keep_base = args.keep or failed or save_error is not None
        if keep_base:
            print(f"임시 폴더 보존: {base}")
        else:
            shutil.rmtree(base, ignore_errors=True)

    return 1 if (save_error is not None or run_failed(results, summarize(results) if results else {})) else 0


if __name__ == "__main__":
    sys.exit(main())
