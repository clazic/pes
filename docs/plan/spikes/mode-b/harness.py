#!/usr/bin/env python3
"""SEL-19 방식 B 시험 공통 하네스 (표준 라이브러리만).

- 저장소 밖 임시 루트를 만들고, Claude Code 비대화형 호출의 권한을 그 루트 안으로 묶는다.
- PES CLI는 검증 래퍼(`<임시>/bin/pes`)로만 실행하고, 래퍼가 argv·exit·stdout/stderr·
  project.json 전후 해시를 기록한다.
- 서버·Claude 자식 프로세스는 프로세스 그룹으로 회수한다.
"""
import json
import os
import re
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

MODEL = "claude-sonnet-5-5"
CLAUDE_TIMEOUT = 420

UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
SESSION_FIELD_RE = re.compile(r'"session_id"\s*:\s*"(' + UUID_RE.pattern + r')"')

# 같은 실행 안에서 같은 세션 ID가 같은 자리표시를 받도록 실행 범위 사전을 쓴다.
SESSION_IDS = {}
OTHER_UUIDS = {}


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def mask_session_ids(text, session_map=None, uuid_map=None):
    """세션 ID(UUID)를 등장 순서대로 <session-1>…, 나머지 UUID는 <uuid-1>…로 바꾼다.

    session_map/uuid_map을 넘기면 호출자 범위에서 번호를 유지한다. 저장 직전에 부른다.
    """
    if not isinstance(text, str):
        return text
    session_map = SESSION_IDS if session_map is None else session_map
    uuid_map = OTHER_UUIDS if uuid_map is None else uuid_map
    session_ids = set(SESSION_FIELD_RE.findall(text))

    def repl(m):
        value = m.group(0)
        if value in session_map:
            return session_map[value]
        if value in uuid_map:
            return uuid_map[value]
        if value in session_ids:
            session_map.setdefault(value, "<session-%d>" % (len(session_map) + 1))
            return session_map[value]
        uuid_map.setdefault(value, "<uuid-%d>" % (len(uuid_map) + 1))
        return uuid_map[value]

    return UUID_RE.sub(repl, text)


def sanitize(text, temp, repo):
    """공개 저장소에 남기면 안 되는 로컬 경로·키·세션 ID를 자리표시로 바꾼다."""
    if not isinstance(text, str):
        text = "" if text is None else str(text)
    pairs = [
        (str(temp), "<임시>"),
        (str(temp.resolve()), "<임시>"),
        (str(repo), "<저장소>"),
        (str(Path.home()), "<홈>"),
    ]
    for a, b in pairs:
        if a:
            text = text.replace(a, b)
    # JSON 문자열 안에서는 경로 뒤에 \\"가 올 수 있으므로 백슬래시에서 멈춘다.
    text = re.sub(r"/[U]sers/[^\s\"'`\\]+", "<홈경로>", text)
    text = re.sub(r"/[p]rivate/[v]ar/[f]olders/[^\s\"'`\\]+", "<임시경로>", text)
    text = re.sub(r"/[v]ar/[f]olders/[^\s\"'`\\]+", "<임시경로>", text)
    text = re.sub(r"\bsk-[A-Za-z0-9_-]{10,}\b", "<키>", text)
    text = re.sub(r"(?i)\b(token|api[_-]?key|secret)\b\s*[:=]\s*[A-Za-z0-9_\-]{8,}", r"\1=<키>", text)
    text = mask_session_ids(text)
    return text


def sha(path):
    import hashlib
    try:
        return hashlib.sha256(Path(path).read_bytes()).hexdigest()[:16]
    except FileNotFoundError:
        return "-"
    except Exception:
        return "?"


def load_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return None


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def port_free(port):
    """리스너가 없고 새로 bind할 수 있는지 확인한다(TIME_WAIT는 허용)."""
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind(("127.0.0.1", port))
    except OSError:
        return False
    finally:
        s.close()
    c = socket.socket()
    c.settimeout(0.5)
    try:
        c.connect(("127.0.0.1", port))
        return False  # 아직 응답하는 리스너가 있다
    except OSError:
        return True
    finally:
        c.close()


def wait_http(url, timeout=15.0):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            with urllib.request.urlopen(url, timeout=1) as r:
                return r.status, r.read().decode("utf-8", "replace")
        except Exception as e:  # 연결 대기
            last = e
            time.sleep(0.2)
    return None, repr(last)


def post_feedback(port, slug, body):
    url = "http://127.0.0.1:%d/%s/feedback" % (port, slug)
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Origin": "http://127.0.0.1:%d" % port,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return None, repr(e)


def kill_tree(proc, grace=5.0):
    """프로세스 그룹을 terminate → wait → kill → wait 순서로 회수한다."""
    if proc is None:
        return
    if proc.poll() is not None:
        return
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except Exception:
        try:
            proc.terminate()
        except Exception:
            pass
    try:
        proc.wait(timeout=grace)
        return
    except Exception:
        pass
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
    try:
        proc.wait(timeout=grace)
    except Exception:
        pass


def run_cmd(cmd, env, cwd=None, timeout=120, input_text=None):
    """Popen으로 실행하고 timeout이면 프로세스 그룹을 회수한다. 출력은 항상 str."""
    t0 = time.time()
    try:
        proc = subprocess.Popen(
            [str(x) for x in cmd],
            cwd=str(cwd) if cwd else None,
            env=env,
            stdin=subprocess.PIPE if input_text is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
    except Exception as e:
        return {
            "cmd": [str(x) for x in cmd], "exit": -1, "stdout": "", "stderr": repr(e),
            "duration_ms": int((time.time() - t0) * 1000), "timed_out": False,
        }
    timed_out = False
    try:
        out, err = proc.communicate(input=input_text, timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        kill_tree(proc)
        try:
            out, err = proc.communicate(timeout=5)
        except Exception:
            out, err = "", ""
    except BaseException:
        # KeyboardInterrupt 등으로 빠져나가도 자식 프로세스 그룹을 남기지 않는다.
        kill_tree(proc)
        raise
    finally:
        if proc.poll() is None:
            kill_tree(proc)
    out = out if isinstance(out, str) else (out or b"").decode("utf-8", "replace")
    err = err if isinstance(err, str) else (err or b"").decode("utf-8", "replace")
    return {
        "cmd": [str(x) for x in cmd],
        "exit": -9 if timed_out else proc.returncode,
        "stdout": out,
        "stderr": err,
        "duration_ms": int((time.time() - t0) * 1000),
        "timed_out": timed_out,
    }


def parse_claude_json(stdout):
    if not isinstance(stdout, str):
        stdout = (stdout or b"").decode("utf-8", "replace") if isinstance(stdout, bytes) else str(stdout)
    try:
        return json.loads(stdout)
    except Exception:
        pass
    for line in reversed(stdout.splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except Exception:
                continue
    return None


def wrapper_source(temp, repo):
    """검증·기록 래퍼. 에이전트는 이 실행 파일만 Bash로 부를 수 있다."""
    real = str(repo / "scripts" / "pes.py")
    root = str(temp)
    logf = str(temp / "logs" / "pes-calls.log")
    allowed = [
        "lock", "unlock", "status", "pending", "mark", "merge", "render",
        "ask-prep", "ask", "round-start", "note",
    ]
    return '''#!/usr/bin/env python3
import hashlib, json, os, subprocess, sys, time
from pathlib import Path

ROOT = Path(%(root)r).resolve()
REAL = %(real)r
LOGF = Path(%(logf)r)
ALLOWED = set(%(allowed)r)

def sha(p):
    try:
        return hashlib.sha256(Path(p).read_bytes()).hexdigest()[:16]
    except Exception:
        return "-"

def log_reject(args, msg, proj=None):
    before = sha(proj / "project.json") if proj else "-"
    rec = {
        "time": time.strftime("%%Y-%%m-%%dT%%H:%%M:%%S"),
        "owner": os.environ.get("PES_OWNER", ""),
        "cwd": os.getcwd(),
        "argv": args,
        "exit": 2,
        "stdout": "",
        "stderr": msg + "\\n",
        "duration_ms": 0,
        "project_json_before": before,
        "project_json_after": before,
        "project_json_changed": False,
        "rejected": True,
    }
    LOGF.parent.mkdir(parents=True, exist_ok=True)
    with LOGF.open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\\n")

def inside(a):
    p = Path(a).expanduser()
    if not p.is_absolute():
        p = Path.cwd() / p
    try:
        rp = p.resolve()
    except Exception:
        rp = p
    return str(rp) == str(ROOT) or str(rp).startswith(str(ROOT) + os.sep)

def main():
    args = sys.argv[1:]
    proj = Path(args[1]).resolve() if len(args) > 1 else None
    if not args or args[0] not in ALLOWED:
        msg = "허용되지 않은 PES 명령: " + (args[0] if args else "(없음)")
        log_reject(args, msg, proj)
        print(msg, file=sys.stderr)
        return 2
    if "--force" in args:
        msg = "시험 래퍼에서는 --force를 허용하지 않습니다"
        log_reject(args, msg, proj)
        print(msg, file=sys.stderr)
        return 2
    if len(args) > 1 and not inside(args[1]):
        msg = "시험 디렉터리 밖 경로는 허용하지 않습니다: " + args[1]
        log_reject(args, msg, proj)
        print(msg, file=sys.stderr)
        return 2
    paths = []
    if args[0] == "merge":
        paths = args[3:]
    elif args[0] == "ask":
        paths = args[2:3]
    elif args[0] == "mark":
        paths = args[2:]
    for a in paths:
        if not inside(a):
            msg = "시험 디렉터리 밖 경로는 허용하지 않습니다: " + a
            log_reject(args, msg, proj)
            print(msg, file=sys.stderr)
            return 2
    before = sha(proj / "project.json") if proj else "-"
    t0 = time.time()
    p = subprocess.run([sys.executable, REAL] + args, capture_output=True, text=True)
    after = sha(proj / "project.json") if proj else "-"
    rec = {
        "time": time.strftime("%%Y-%%m-%%dT%%H:%%M:%%S"),
        "owner": os.environ.get("PES_OWNER", ""),
        "cwd": os.getcwd(),
        "argv": args,
        "exit": p.returncode,
        "stdout": p.stdout,
        "stderr": p.stderr,
        "duration_ms": int((time.time() - t0) * 1000),
        "project_json_before": before,
        "project_json_after": after,
        "project_json_changed": before != after,
    }
    LOGF.parent.mkdir(parents=True, exist_ok=True)
    with LOGF.open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\\n")
    if p.stdout:
        sys.stdout.write(p.stdout)
    if p.stderr:
        sys.stderr.write(p.stderr)
    return p.returncode

if __name__ == "__main__":
    sys.exit(main())
''' % {"root": root, "real": real, "logf": logf, "allowed": allowed}


def write_wrapper(temp, repo):
    bindir = temp / "bin"
    bindir.mkdir(parents=True, exist_ok=True)
    wrapper = bindir / "pes"
    wrapper.write_text(wrapper_source(temp, repo), encoding="utf-8")
    wrapper.chmod(0o755)
    return wrapper


def read_new_calls(logf, offset):
    if not logf.exists():
        return [], offset
    with logf.open("r", encoding="utf-8") as f:
        f.seek(offset)
        chunk = f.read()
        offset = f.tell()
    calls = []
    for line in chunk.splitlines():
        line = line.strip()
        if line:
            try:
                calls.append(json.loads(line))
            except Exception:
                pass
    return calls, offset


def claude_cmd(temp, prompt, cwd, extra_args=None, max_turns=30, model=MODEL):
    """권한을 프로젝트 폴더 하나로 묶은 Claude Code 비대화형 명령.

    - Bash는 검증 래퍼 실행만 허용한다(임의 python3 금지).
    - 파일 도구는 cwd(프로젝트 폴더) 아래 절대 경로만 허용한다.
    - project.json/.pes-lock 직접 쓰기는 명시적으로 거부한다.
    - `--restricted`는 프롬프트 캐시를 크게 다시 만들어 비용이 커져 쓰지 않는다.
    """
    proj = Path(cwd).resolve()
    wrapper = (Path(temp) / "bin" / "pes").resolve()
    cmd = [
        "claude",
        "-p", prompt,
        "--model", model,
        "--max-turns", str(max_turns),
        "--output-format", "json",
        "--allowedTools",
        "Bash(%s:*)" % wrapper,
        "Read(//%s/**)" % proj,
        "Write(//%s/**)" % proj,
        "Edit(//%s/**)" % proj,
        "--disallowedTools",
        "Write(//%s/project.json)" % proj,
        "Edit(//%s/project.json)" % proj,
        "Write(//%s/.pes-lock)" % proj,
        "Edit(//%s/.pes-lock)" % proj,
        "Write(project.json)",
        "Edit(project.json)",
        "Write(.pes-lock)",
        "Edit(.pes-lock)",
    ]
    cmd.extend(extra_args or [])
    return cmd


def run_claude(name, prompt, env, cwd, temp, log, timeout=CLAUDE_TIMEOUT,
               extra_args=None, max_turns=30, model=MODEL):
    """Claude 호출 1회. project.json 전후 해시와 PES 래퍼 호출을 기록한다."""
    cwd = Path(cwd)
    before = sha(cwd / "project.json")
    calls_log = temp / "logs" / "pes-calls.log"
    offset = calls_log.stat().st_size if calls_log.exists() else 0
    cmd = claude_cmd(temp, prompt, cwd, extra_args=extra_args, max_turns=max_turns, model=model)
    log.add("CLAUDE %s 시작 (model=%s, cwd=<임시>/proj)" % (name, model))
    r = run_cmd(cmd, env=env, cwd=cwd, timeout=timeout)
    out = parse_claude_json(r["stdout"]) or {}
    after = sha(cwd / "project.json")
    calls, _ = read_new_calls(calls_log, offset)
    rec = {
        "name": name,
        "exit": r["exit"],
        "timed_out": r["timed_out"],
        "duration_ms": r["duration_ms"],
        "project_json_before": before,
        "project_json_after": after,
        "project_json_changed": before != after,
        "pes_calls": calls,
        "claude": {
            k: out.get(k) for k in (
                "session_id", "num_turns", "duration_ms", "duration_api_ms",
                "total_cost_usd", "is_error", "subtype", "stop_reason",
                "permission_denials", "result",
            )
        },
        "stderr": r["stderr"],
    }
    c = rec["claude"]
    try:
        log.logs_dir.mkdir(parents=True, exist_ok=True)
        (log.logs_dir / ("claude-%s.json" % name)).write_text(
            sanitize(json.dumps(rec, ensure_ascii=False, indent=1), temp, log.repo),
            encoding="utf-8",
        )
    except Exception:
        pass
    log.add(
        "CLAUDE %s 종료 exit=%s turns=%s duration_ms=%s api_ms=%s cost_usd=%s "
        "is_error=%s project.json변경=%s pes호출=%s" % (
            name, r["exit"], c.get("num_turns"), c.get("duration_ms"),
            c.get("duration_api_ms"), c.get("total_cost_usd"), c.get("is_error"),
            rec["project_json_changed"], len(calls),
        )
    )
    return rec


class Log:
    def __init__(self, temp, repo, logs_dir):
        self.temp = temp
        self.repo = repo
        self.logs_dir = Path(logs_dir)
        self.lines = []

    def add(self, msg):
        line = "[%s] %s" % (now_iso(), msg)
        self.lines.append(line)
        print(line, flush=True)

    def save(self, filename="run.log"):
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        (self.logs_dir / filename).write_text(
            sanitize("\n".join(self.lines) + "\n", self.temp, self.repo), encoding="utf-8"
        )
