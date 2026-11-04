#!/usr/bin/env python3
"""SEL-19 방식 B 시험 실행기 (표준 라이브러리만 사용).

합성 PES 프로젝트를 저장소 밖 임시 디렉터리에 만들고, 빈 포트에 serve.py를 띄운 뒤
Claude Code 비대화형(-p) 세션으로 공통 시나리오 한 라운드 + 재개 + 잠금을 시험한다.

실행:
    python3 docs/plan/spikes/mode-b/run_spike.py [--keep-temp] [--timeout 초]

- 실제 ~/pes-projects, ~/.pes 는 건드리지 않는다. PES_HOME은 임시 디렉터리다.
- 결과 로그는 docs/plan/spikes/mode-b/logs/ 에 자리표시로 정리해 저장한다.
- 임시 디렉터리는 끝나면 지운다(--keep-temp면 경로만 출력하고 남긴다).
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
LOGS = HERE / "logs"
MODEL = "claude-sonnet-5-5"
OWNER_A = "agent-a"
OWNER_B = "agent-b"
CLAUDE_TIMEOUT = 420


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def sha(path: Path) -> str:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()[:16]
    except FileNotFoundError:
        return "-"


def load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def sanitize(text: str, temp: Path) -> str:
    """공개 저장소에 남기면 안 되는 로컬 경로·키를 자리표시로 바꾼다."""
    if not isinstance(text, str):
        text = str(text)
    pairs = [
        (str(temp), "<임시>"),
        (str(temp.resolve()), "<임시>"),
        (str(REPO), "<저장소>"),
        (str(Path.home()), "<홈>"),
    ]
    for a, b in pairs:
        if a:
            text = text.replace(a, b)
    text = re.sub(r"/[U]sers/[^\s\"'`]+", "<홈경로>", text)
    text = re.sub(r"/private/var/folders/[^\s\"'`]+", "<임시경로>", text)
    text = re.sub(r"/var/folders/[^\s\"'`]+", "<임시경로>", text)
    text = re.sub(r"\bsk-[A-Za-z0-9_-]{10,}\b", "<키>", text)
    text = re.sub(r"(?i)\b(token|api[_-]?key|secret)\b\s*[:=]\s*[A-Za-z0-9_\-]{8,}", r"\1=<키>", text)
    return text


class Log:
    def __init__(self, temp: Path):
        self.temp = temp
        self.lines = []

    def add(self, msg: str):
        line = f"[{now_iso()}] {msg}"
        self.lines.append(line)
        print(line, flush=True)

    def save(self):
        LOGS.mkdir(parents=True, exist_ok=True)
        (LOGS / "run.log").write_text(
            sanitize("\n".join(self.lines) + "\n", self.temp), encoding="utf-8"
        )


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def port_free(port: int) -> bool:
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


def wait_http(url: str, timeout=15.0):
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


def post_feedback(port: int, slug: str, body: dict):
    url = f"http://127.0.0.1:{port}/{slug}/feedback"
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Origin": f"http://127.0.0.1:{port}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def run_cmd(cmd, env, cwd=None, timeout=60):
    t0 = time.time()
    p = subprocess.run(
        cmd, cwd=str(cwd) if cwd else None, env=env,
        capture_output=True, text=True, timeout=timeout,
    )
    return {
        "cmd": [str(x) for x in cmd],
        "exit": p.returncode,
        "stdout": p.stdout,
        "stderr": p.stderr,
        "duration_ms": int((time.time() - t0) * 1000),
    }


def parse_claude_json(stdout: str):
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


def write_wrapper(temp: Path, repo: Path) -> Path:
    """pes.py 호출을 기록하는 얇은 래퍼. 에이전트는 이 경로로만 PES CLI를 부른다."""
    wrapper = temp / "pesw.py"
    logf = temp / "logs" / "pes-calls.log"
    real = repo / "scripts" / "pes.py"
    wrapper.write_text(
        "#!/usr/bin/env python3\n"
        "import json, os, sys, time\n"
        f"LOG = {str(logf)!r}\n"
        f"REAL = {str(real)!r}\n"
        "os.makedirs(os.path.dirname(LOG), exist_ok=True)\n"
        "rec = {'time': time.strftime('%Y-%m-%dT%H:%M:%S'),\n"
        "       'owner': os.environ.get('PES_OWNER', ''),\n"
        "       'cwd': os.getcwd(), 'argv': sys.argv[1:]}\n"
        "with open(LOG, 'a', encoding='utf-8') as f:\n"
        "    f.write(json.dumps(rec, ensure_ascii=False) + '\\n')\n"
        "os.execv(sys.executable, [sys.executable, REAL] + sys.argv[1:])\n",
        encoding="utf-8",
    )
    return wrapper


def read_new_calls(logf: Path, offset: int):
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


def is_write_call(argv):
    if not argv:
        return False
    return argv[0] in {
        "merge", "round-start", "mark", "note", "ask", "approve", "reopen",
        "chat", "report", "assemble", "web", "qa", "init", "home", "stop",
        "lock", "unlock",
    }


def claude_call(name, prompt, env, cwd, temp, add_dirs, log: Log, timeout, extra_args=None):
    before = sha(cwd / "project.json")
    calls_log = temp / "logs" / "pes-calls.log"
    offset = calls_log.stat().st_size if calls_log.exists() else 0
    cmd = [
        shutil.which("claude") or "claude",
        "-p", prompt,
        "--model", MODEL,
        "--max-turns", "30",
        "--output-format", "json",
        "--allowedTools", "Bash(python3:*)", "Read", "Write", "Edit",
        "--add-dir", *[str(d) for d in add_dirs],
        *(extra_args or []),
    ]
    log.add(f"CLAUDE {name} 시작 (model={MODEL}, cwd=<임시>/proj)")
    try:
        r = run_cmd(cmd, env=env, cwd=cwd, timeout=timeout)
    except subprocess.TimeoutExpired as e:
        r = {"cmd": cmd, "exit": -9, "stdout": e.stdout or "", "stderr": "TIMEOUT", "duration_ms": timeout * 1000}
    out = parse_claude_json(r["stdout"]) or {}
    after = sha(cwd / "project.json")
    calls, _ = read_new_calls(calls_log, offset)
    write_calls = [c for c in calls if is_write_call(c.get("argv"))]
    direct = (before != after) and not write_calls
    rec = {
        "name": name,
        "exit": r["exit"],
        "duration_ms": r["duration_ms"],
        "project_json_before": before,
        "project_json_after": after,
        "project_json_changed": before != after,
        "pes_calls": calls,
        "pes_write_calls": write_calls,
        "direct_project_json_edit_suspected": direct,
        "claude": {
            k: out.get(k) for k in (
                "session_id", "num_turns", "duration_ms", "duration_api_ms",
                "total_cost_usd", "is_error", "subtype", "stop_reason",
                "permission_denials", "result",
            )
        },
        "stderr": r["stderr"],
    }
    LOGS.mkdir(parents=True, exist_ok=True)
    (LOGS / f"claude-{name}.json").write_text(
        sanitize(json.dumps(rec, ensure_ascii=False, indent=1), temp), encoding="utf-8"
    )
    c = rec["claude"]
    log.add(
        f"CLAUDE {name} 종료 exit={r['exit']} turns={c.get('num_turns')} "
        f"duration_ms={c.get('duration_ms')} cost_usd={c.get('total_cost_usd')} "
        f"is_error={c.get('is_error')} project.json변경={rec['project_json_changed']} "
        f"직접편집의심={direct} pes호출={len(calls)}"
    )
    return rec


def build_prompt_r1(temp: Path, proj: Path, wrapper: Path) -> str:
    return f"""너는 PES 프로젝트의 작업 에이전트다. PES 프로젝트 폴더는 {proj} 이다.

규칙:
- {temp} 밖의 파일은 읽거나 쓰지 않는다. 단, PES CLI와 저장소 scripts/ 폴더만 예외다.
- project.json 을 직접 편집하지 않는다. 모든 상태 변경은 PES CLI로만 한다.
- PES CLI는 반드시 `python3 {wrapper}` 로 실행한다. 환경변수 PES_HOME과 PES_OWNER=agent-a는 이미 설정되어 있다.
- 셸에서는 python3 명령만 쓴다. 다른 셸 명령은 쓰지 않는다.
- 사용자 홈의 설정을 바꾸지 않는다.

할 일(순서대로):
1. `python3 {wrapper} lock {proj}` 로 이 세션이 프로젝트를 쓴다고 표시한다.
2. `python3 {wrapper} status {proj}` 로 맥락을 읽는다.
3. Write 도구로 {proj}/result-r1.json 을 만든다. 내용은 JSON 객체 하나:
   {{"id": 1, "title": "합성 주제 범위 정리", "kind": "section", "summary": "합성 주제의 범위를 한 문장으로 정리", "details": "합성 자료만 사용한 시험용 계획이다.", "confidence": "medium", "sources": []}}
4. `python3 {wrapper} merge {proj} plan {proj}/result-r1.json`
5. `python3 {wrapper} render {proj} plan`
6. `python3 {wrapper} ask-prep {proj} plan`
7. `python3 {wrapper} ask {proj} {proj}/ask/plan-start.json`
8. `python3 {wrapper} status {proj}` 로 결과를 확인한다.
마지막에 한 줄로 무엇을 했는지 요약한다."""


def build_prompt_resume(temp: Path, proj: Path, wrapper: Path, variant: str) -> str:
    common = f"""너는 PES 프로젝트의 작업 에이전트다. PES 프로젝트 폴더는 {proj} 이다.

규칙:
- {temp} 밖의 파일은 읽거나 쓰지 않는다. 단, PES CLI와 저장소 scripts/ 폴더만 예외다.
- project.json 을 직접 편집하지 않는다. 모든 상태 변경은 PES CLI로만 한다.
- PES CLI는 반드시 `python3 {wrapper}` 로 실행한다. 환경변수 PES_HOME과 PES_OWNER=agent-a는 이미 설정되어 있다.
- 셸에서는 python3 명령만 쓴다.
"""
    if variant == "resume":
        body = f"""이전 세션에서 이어서 작업한다.
1. `python3 {wrapper} pending {proj}` 로 처리 안 한 답 파일을 모두 찾는다.
2. 찾은 파일을 Read로 읽고 stage/kind/text/answers를 확인한다.
3. 답을 반영해 `python3 {wrapper} round-start {proj} plan` 을 실행한다.
4. `python3 {wrapper} mark {proj} <찾은 파일들>` 로 처리 완료 표시한다.
5. `python3 {wrapper} render {proj} plan`
6. `python3 {wrapper} status {proj}` 로 미처리 답이 0인지 확인한다.
답 파일이 없으면 아무것도 바꾸지 말고 "미처리 답 없음"이라고만 답한다.
마지막에 처리한 파일 이름과 미처리 답 개수를 한 줄로 요약한다."""
    elif variant == "continue":
        body = f"""같은 프로젝트에서 계속한다.
1. `python3 {wrapper} pending {proj}` 로 처리 안 한 답 파일을 모두 찾는다.
2. 찾은 파일을 Read로 읽고 내용을 확인한다.
3. `python3 {wrapper} round-start {proj} plan` 으로 다음 라운드를 시작한다.
4. Write 도구로 {proj}/result-r2.json 을 만든다. 내용은 JSON 객체 하나:
   {{"id": 2, "title": "합성 출처 보강", "kind": "section", "summary": "합성 출처를 하나 더 붙인다", "details": "시험용 합성 출처다.", "confidence": "medium", "sources": [{{"title": "합성 자료 A", "url": "https://example.invalid/a"}}]}}
5. `python3 {wrapper} merge {proj} plan {proj}/result-r2.json`
6. `python3 {wrapper} mark {proj} <찾은 파일들>`
7. `python3 {wrapper} render {proj} plan`
8. `python3 {wrapper} status {proj}` 로 미처리 답이 0인지 확인한다.
답 파일이 없으면 아무것도 바꾸지 말고 "미처리 답 없음"이라고만 답한다.
마지막에 처리한 파일 이름과 미처리 답 개수를 한 줄로 요약한다."""
    else:  # fresh
        body = f"""새 세션이다. 이전 대화 기억이 없다. PES 상태만 보고 이어서 작업한다.
1. `python3 {wrapper} pending {proj}` 로 처리 안 한 답 파일을 모두 찾는다.
2. 찾은 파일을 Read로 읽고 내용을 확인한다.
3. `python3 {wrapper} note {proj} "R2까지 처리함. 다음은 R3 준비."` 로 인계 메모를 남긴다.
4. `python3 {wrapper} mark {proj} <찾은 파일들>`
5. `python3 {wrapper} render {proj} plan`
6. `python3 {wrapper} status {proj}` 로 미처리 답이 0인지 확인한다.
답 파일이 없으면 아무것도 바꾸지 말고 "미처리 답 없음"이라고만 답한다.
마지막에 처리한 파일 이름과 미처리 답 개수를 한 줄로 요약한다."""
    return common + "\n" + body


def build_prompt_lock(temp: Path, proj: Path, wrapper: Path) -> str:
    return f"""너는 두 번째 에이전트(agent-b)다. PES 프로젝트 폴더는 {proj} 이다.
환경변수 PES_OWNER=agent-b 가 설정되어 있다.
규칙:
- {temp} 밖의 파일은 읽거나 쓰지 않는다. 단, PES CLI와 저장소 scripts/ 폴더만 예외다.
- project.json 을 직접 편집하지 않는다.
- PES CLI는 반드시 `python3 {wrapper}` 로 실행한다.
- --force 는 절대 쓰지 않는다.
할 일:
1. `python3 {wrapper} lock {proj}` 를 실행한다.
2. 성공/실패와 출력 메시지를 그대로 보고한다. 파일을 수정하지 않는다.
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep-temp", action="store_true")
    ap.add_argument("--timeout", type=int, default=CLAUDE_TIMEOUT)
    args = ap.parse_args()

    if not shutil.which("claude"):
        print("claude CLI를 찾을 수 없음", file=sys.stderr)
        return 2

    temp = Path(tempfile.mkdtemp(prefix="pes-mode-b-")).resolve()
    home = temp / "home"
    proj = home / "proj"
    home.mkdir(parents=True)
    (temp / "logs").mkdir(parents=True, exist_ok=True)
    log = Log(temp)
    LOGS.mkdir(parents=True, exist_ok=True)
    for old in LOGS.glob("*"):
        if old.is_file():
            old.unlink()

    env = os.environ.copy()
    env.update({"PES_HOME": str(home), "PES_OWNER": OWNER_A, "NO_COLOR": "1"})
    base_env = os.environ.copy()
    base_env["PES_HOME"] = str(home)
    # serve.py는 trusted_origins를 ~/.pes/config.json에서 읽는다(홈 경로 고정).
    # 실제 ~/.pes를 건드리지 않도록 서버 프로세스의 HOME도 임시 홈으로 바꾼다.
    base_env["HOME"] = str(home)
    base_env["USERPROFILE"] = str(home)

    wrapper = write_wrapper(temp, REPO)
    log.add(f"임시 디렉터리 생성: <임시> (PES_HOME=<임시>/home, 프로젝트=<임시>/home/proj)")

    # 1) 합성 프로젝트
    r = run_cmd(
        [sys.executable, str(REPO / "scripts" / "pes.py"), "init", str(proj), "--topic", "합성 주제"],
        env=env,
    )
    log.add(f"init exit={r['exit']} stdout={r['stdout'].strip()} stderr={r['stderr'].strip()}")
    if r["exit"] != 0:
        log.save()
        return 1

    # 2) 서버
    port = free_port()
    srv_out = (temp / "logs" / "serve.out").open("w", encoding="utf-8")
    srv = subprocess.Popen(
        [sys.executable, "-I", str(REPO / "scripts" / "serve.py"), str(home), str(port)],
        env=base_env, stdout=srv_out, stderr=subprocess.STDOUT,
    )
    status, body = wait_http(f"http://127.0.0.1:{port}/ping")
    log.add(f"serve.py pid={srv.pid} port={port} HOME=<임시>/home /ping={status} body={body[:80]}")
    if status != 200:
        srv.terminate()
        log.save()
        return 1

    results = {}
    try:
        # 3) 라운드 1 — 새 세션
        p1 = build_prompt_r1(temp, proj, wrapper)
        results["r1"] = claude_call("r1-setup", p1, env, proj, temp, [proj, REPO / "scripts"], log, args.timeout)

        # 사람 답 흉내 1
        st, fb = post_feedback(port, proj.name, {
            "stage": "plan", "round": 0, "kind": "stage_start",
            "text": "합성 답: 보고서 작성, 내부 연구진, 범위는 현황 파악까지.",
            "answers": {"topic": "합성 주제", "purpose": "report", "audience": "internal"},
            "spec": "plan-start",
        })
        log.add(f"POST /feedback #1 status={st} resp={fb}")
        pend = run_cmd([sys.executable, str(wrapper), "pending", str(proj)], env=env)
        log.add(f"pending #1 exit={pend['exit']} files={pend['stdout'].strip().splitlines()}")

        # 4) 재개 — --resume
        p2 = build_prompt_resume(temp, proj, wrapper, "resume")
        cmd2 = [
            shutil.which("claude") or "claude", "-p", p2, "--resume",
            (results["r1"]["claude"].get("session_id") or ""),
            "--model", MODEL, "--max-turns", "30", "--output-format", "json",
            "--allowedTools", "Bash(python3:*)", "Read", "Write", "Edit",
            "--add-dir", str(proj), "--add-dir", str(REPO / "scripts"),
        ]
        before = sha(proj / "project.json")
        calls_log = temp / "logs" / "pes-calls.log"
        offset = calls_log.stat().st_size if calls_log.exists() else 0
        rr = run_cmd(cmd2, env=env, cwd=proj, timeout=args.timeout)
        out2 = parse_claude_json(rr["stdout"]) or {}
        after = sha(proj / "project.json")
        calls2, _ = read_new_calls(calls_log, offset)
        results["r2"] = {
            "name": "r2-resume", "exit": rr["exit"], "duration_ms": rr["duration_ms"],
            "project_json_before": before, "project_json_after": after,
            "project_json_changed": before != after, "pes_calls": calls2,
            "pes_write_calls": [c for c in calls2 if is_write_call(c.get("argv"))],
            "direct_project_json_edit_suspected": (before != after) and not [c for c in calls2 if is_write_call(c.get("argv"))],
            "claude": {k: out2.get(k) for k in ("session_id", "num_turns", "duration_ms", "total_cost_usd", "is_error", "subtype", "permission_denials", "result")},
            "stderr": rr["stderr"],
        }
        (LOGS / "claude-r2-resume.json").write_text(sanitize(json.dumps(results["r2"], ensure_ascii=False, indent=1), temp), encoding="utf-8")
        log.add(f"CLAUDE r2-resume 종료 exit={rr['exit']} turns={out2.get('num_turns')} duration_ms={out2.get('duration_ms')} cost_usd={out2.get('total_cost_usd')}")

        # 사람 답 흉내 2
        st, fb = post_feedback(port, proj.name, {
            "stage": "plan", "round": 1, "kind": "feedback",
            "text": "합성 답: R1 결과에 합성 출처를 하나 더 넣어라.",
            "answers": {},
        })
        log.add(f"POST /feedback #2 status={st} resp={fb}")

        # 5) 재개 — --continue
        p3 = build_prompt_resume(temp, proj, wrapper, "continue")
        results["r3"] = claude_call(
            "r3-continue", p3, env, proj, temp, [proj, REPO / "scripts"], log, args.timeout,
            extra_args=["--continue"],
        )

        # 사람 답 흉내 3
        st, fb = post_feedback(port, proj.name, {
            "stage": "plan", "round": 2, "kind": "feedback",
            "text": "합성 답: 인계 메모를 남기고 다음 라운드를 준비해라.",
            "answers": {},
        })
        log.add(f"POST /feedback #3 status={st} resp={fb}")

        # 6) 새 세션(기억 없음)
        p4 = build_prompt_resume(temp, proj, wrapper, "fresh")
        results["r4"] = claude_call("r4-fresh", p4, env, proj, temp, [proj, REPO / "scripts"], log, args.timeout)

        # 7) 잠금 — agent-b가 실제 에이전트로 시도
        env_b = env.copy()
        env_b["PES_OWNER"] = OWNER_B
        p5 = build_prompt_lock(temp, proj, wrapper)
        results["r5"] = claude_call("r5-lock-b", p5, env_b, proj, temp, [proj, REPO / "scripts"], log, args.timeout)

        # 8) 잠금 — CLI 결정적 검사
        lock_b = run_cmd([sys.executable, str(wrapper), "lock", str(proj)], env=env_b)
        log.add(f"CLI agent-b lock exit={lock_b['exit']} out={lock_b['stdout'].strip()} err={lock_b['stderr'].strip()}")
        probe = temp / "lock-probe.json"
        probe.write_text(json.dumps({"id": 99, "title": "잠금 시험", "kind": "section"}, ensure_ascii=False), encoding="utf-8")
        merge_b = run_cmd([sys.executable, str(wrapper), "merge", str(proj), "plan", str(probe)], env=env_b)
        log.add(f"CLI agent-b merge exit={merge_b['exit']} out={merge_b['stdout'].strip()} err={merge_b['stderr'].strip()}")
        force_b = run_cmd([sys.executable, str(wrapper), "lock", str(proj), "--force"], env=env_b)
        log.add(f"CLI agent-b lock --force exit={force_b['exit']} out={force_b['stdout'].strip()} err={force_b['stderr'].strip()}")
        merge_a = run_cmd([sys.executable, str(wrapper), "merge", str(proj), "plan", str(probe)], env=env)
        log.add(f"CLI agent-a merge(강제 탈취 후) exit={merge_a['exit']} out={merge_a['stdout'].strip()} err={merge_a['stderr'].strip()}")
        unlock_b = run_cmd([sys.executable, str(wrapper), "unlock", str(proj)], env=env_b)
        log.add(f"CLI agent-b unlock exit={unlock_b['exit']} out={unlock_b['stdout'].strip()} err={unlock_b['stderr'].strip()}")
        results["lock_cli"] = {
            "lock_b": {k: lock_b[k] for k in ("exit", "stdout", "stderr")},
            "merge_b": {k: merge_b[k] for k in ("exit", "stdout", "stderr")},
            "force_b": {k: force_b[k] for k in ("exit", "stdout", "stderr")},
            "merge_a_after_force": {k: merge_a[k] for k in ("exit", "stdout", "stderr")},
            "unlock_b": {k: unlock_b[k] for k in ("exit", "stdout", "stderr")},
        }

        # 9) 산출물 확인
        pj = load_json(proj / "project.json") or {}
        plan = (pj.get("stages") or {}).get("plan") or {}
        checks = {
            "project_json_exists": (proj / "project.json").exists(),
            "lock_file_exists": (proj / ".pes-lock").exists(),
            "result_r1_exists": (proj / "result-r1.json").exists(),
            "result_r2_exists": (proj / "result-r2.json").exists(),
            "plan_round": plan.get("round"),
            "plan_items": [i.get("id") for i in plan.get("items", [])],
            "processed": pj.get("processed", []),
            "notes": pj.get("notes", []),
            "ask_spec_exists": (proj / "ask" / "plan-start.json").exists(),
            "ask_html_exists": (proj / "ask-plan-start.html").exists(),
            "index_exists": (proj / "index.html").exists(),
            "snapshots": sorted(p.name for p in (proj / "snapshots").glob("*.json")),
            "feedback_files": sorted(p.name for p in (proj / "feedback").glob("*.json")),
            "pending_now": [p.name for p in (proj / "feedback").glob("*.json") if p.name not in set(pj.get("processed", []))],
        }
        results["checks"] = checks
        log.add(f"산출물 확인: {json.dumps(checks, ensure_ascii=False)}")

        # 10) 서버 응답·정리
        st, html = wait_http(f"http://127.0.0.1:{port}/{proj.name}/")
        log.add(f"GET /{proj.name}/ status={st} bytes={len(html or '')}")
    finally:
        try:
            srv.terminate()
            srv.wait(timeout=5)
        except Exception:
            try:
                srv.kill()
            except Exception:
                pass
        srv_out.close()
        time.sleep(0.5)
        freed = port_free(port)
        log.add(f"serve.py 종료 확인: port={port} 비었음={freed}")

        (LOGS / "summary.json").write_text(
            sanitize(json.dumps(results, ensure_ascii=False, indent=1, default=str), temp),
            encoding="utf-8",
        )
        if (temp / "logs" / "pes-calls.log").exists():
            (LOGS / "pes-calls.log").write_text(
                sanitize((temp / "logs" / "pes-calls.log").read_text(encoding="utf-8"), temp),
                encoding="utf-8",
            )
        log.add(f"결과 저장: <저장소>/docs/plan/spikes/mode-b/logs/")
        log.save()
        if args.keep_temp:
            print(f"임시 디렉터리 유지: {temp}")
        else:
            shutil.rmtree(temp, ignore_errors=True)

    return 0


if __name__ == "__main__":
    sys.exit(main())
