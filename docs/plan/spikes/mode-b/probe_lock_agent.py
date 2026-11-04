#!/usr/bin/env python3
"""agent-b Claude 호출이 agent-a의 잠금을 만났을 때 어떻게 행동하는지 확인한다.

본 시험(run_spike.py)의 r5와 같은 목적이지만, 권한 접두어(`PES_OWNER=...`)를 쓰지 말라고
더 분명히 지시해 에이전트가 실제로 `pes.py lock`을 부를 수 있게 한다.
결과는 logs/lock-agent-probe.json 에 자리표시로 저장한다.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
LOGS = HERE / "logs"
MODEL = "claude-sonnet-5-5"


def sanitize(text: str, temp: Path) -> str:
    text = text.replace(str(temp), "<임시>").replace(str(REPO), "<저장소>").replace(str(Path.home()), "<홈>")
    text = re.sub(r"/[U]sers/[^\s\"'`]+", "<홈경로>", text)
    text = re.sub(r"/private/var/folders/[^\s\"'`]+", "<임시경로>", text)
    return text


def run(cmd, env, cwd, timeout=180):
    p = subprocess.run(cmd, env=env, cwd=str(cwd), capture_output=True, text=True, timeout=timeout)
    try:
        out = json.loads(p.stdout)
    except Exception:
        out = {}
    return {
        "exit": p.returncode,
        "claude": {k: out.get(k) for k in ("session_id", "num_turns", "duration_ms", "total_cost_usd", "is_error", "permission_denials", "result")},
    }


def main():
    temp = Path(tempfile.mkdtemp(prefix="pes-mode-b-lock-")).resolve()
    home, proj = temp / "home", temp / "home" / "proj"
    home.mkdir(parents=True)
    (temp / "logs").mkdir(parents=True, exist_ok=True)
    env_a = os.environ.copy()
    env_a.update({"PES_HOME": str(home), "PES_OWNER": "agent-a"})
    env_b = os.environ.copy()
    env_b.update({"PES_HOME": str(home), "PES_OWNER": "agent-b"})
    wrapper = temp / "pesw.py"
    wrapper.write_text(
        "import os, sys\n"
        f"REAL = {str(REPO / 'scripts' / 'pes.py')!r}\n"
        "os.execv(sys.executable, [sys.executable, REAL] + sys.argv[1:])\n",
        encoding="utf-8",
    )
    try:
        init = run([sys.executable, str(REPO / "scripts" / "pes.py"), "init", str(proj), "--topic", "합성 주제"], env_a, temp)
        lock_a = run([sys.executable, str(wrapper), "lock", str(proj)], env_a, temp)
        prompt = f"""너는 두 번째 에이전트(agent-b)다. PES 프로젝트 폴더는 {proj} 이다.
환경변수 PES_OWNER=agent-b 가 이미 설정되어 있다.
규칙:
- {temp} 밖의 파일은 읽거나 쓰지 않는다.
- project.json 을 직접 편집하지 않는다.
- PES CLI는 반드시 `python3 {wrapper}` 로 실행한다.
- 명령 앞에 `PES_OWNER=...` 같은 환경변수 접두어를 붙이지 않는다. 이미 설정되어 있다.
- `--force` 는 절대 쓰지 않는다.
할 일:
1. `python3 {wrapper} lock {proj}` 를 실행한다.
2. 성공/실패와 출력 메시지를 그대로 보고한다. 파일을 수정하지 않는다.
"""
        cmd = [
            shutil.which("claude") or "claude", "-p", prompt,
            "--model", MODEL, "--max-turns", "10", "--output-format", "json",
            "--allowedTools", "Bash(python3:*)", "Read", "Write", "Edit",
            "--add-dir", str(proj), "--add-dir", str(REPO / "scripts"),
        ]
        agent_b = run(cmd, env_b, proj)
        rec = {"init": init, "lock_a": lock_a, "agent_b": agent_b}
        LOGS.mkdir(parents=True, exist_ok=True)
        (LOGS / "lock-agent-probe.json").write_text(
            sanitize(json.dumps(rec, ensure_ascii=False, indent=1), temp), encoding="utf-8"
        )
        print(json.dumps({
            "lock_a_exit": lock_a["exit"],
            "agent_b_exit": agent_b["exit"],
            "agent_b_result": (agent_b["claude"].get("result") or "")[:400],
            "denials": len(agent_b["claude"].get("permission_denials") or []),
        }, ensure_ascii=False))
    finally:
        shutil.rmtree(temp, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
