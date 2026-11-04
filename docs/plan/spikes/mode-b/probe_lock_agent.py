#!/usr/bin/env python3
"""agent-b Claude 호출이 agent-a의 잠금을 만났을 때의 실제 PES 호출·종료 코드를 기록한다.

본 시험(run_spike.py)의 r5와 같은 목적이지만, 권한 접두어(`PES_OWNER=...`)를 쓰지 말라고
더 분명히 지시해 에이전트가 실제로 검증 래퍼의 `lock`을 부르게 한다.
결과는 logs/lock-agent-probe.json 에 자리표시로 저장하고, 실패하면 비영 종료한다.
"""
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from harness import (  # noqa: E402
    Log, load_json, read_new_calls, run_claude, run_cmd, sanitize, sha, write_wrapper,
)

REPO = HERE.parents[3]
LOGS = HERE / "logs"
OWNER_A = "agent-a"
OWNER_B = "agent-b"


def owner(proj):
    x = load_json(Path(proj) / ".pes-lock")
    return (x or {}).get("owner")


def main():
    temp = Path(tempfile.mkdtemp(prefix="pes-mode-b-lock-")).resolve()
    home = temp / "home"
    proj = home / "proj"
    home.mkdir(parents=True)
    (temp / "logs").mkdir(parents=True, exist_ok=True)
    log = Log(temp, REPO, LOGS)
    rec = {}
    try:
        env_a = os.environ.copy()
        env_a.update({"PES_HOME": str(home), "PES_OWNER": OWNER_A, "NO_COLOR": "1"})
        env_b = os.environ.copy()
        env_b.update({"PES_HOME": str(home), "PES_OWNER": OWNER_B, "NO_COLOR": "1"})
        wrapper = write_wrapper(temp, REPO)
        calls_log = temp / "logs" / "pes-calls.log"

        init = run_cmd(
            [sys.executable, str(REPO / "scripts" / "pes.py"), "init", str(proj), "--topic", "합성 주제"],
            env=env_a,
        )
        lock_a = run_cmd([sys.executable, str(wrapper), "lock", str(proj)], env=env_a)
        all_calls, _ = read_new_calls(calls_log, 0)
        lock_a_rec = all_calls[-1] if all_calls else {}
        before_pj = sha(proj / "project.json")
        before_owner = owner(proj)

        prompt = f"""너는 두 번째 에이전트(agent-b)다. PES 프로젝트 폴더는 {proj} 이다.
환경변수 PES_OWNER=agent-b 가 이미 설정되어 있다.

규칙:
- 작업 디렉터리({proj}) 밖의 파일은 읽거나 쓰지 않는다.
- project.json 을 직접 편집하지 않는다.
- PES CLI는 반드시 `{wrapper}` 실행 파일로 실행한다. `python3`를 직접 쓰지 않는다.
- 명령 앞에 `PES_OWNER=...` 같은 환경변수 접두어를 붙이지 않는다.
- `--force` 는 절대 쓰지 않는다.
- 셸에서는 `{wrapper}` 명령만 한 줄에 하나씩 실행한다.

할 일은 정확히 하나다. 아래 한 줄만 실행해라.
`{wrapper} lock {proj}`

실행 결과(종료 코드와 출력)를 그대로 보고해라. 파일을 수정하지 마라."""

        claude = run_claude(
            "lock-agent-probe", prompt, env_b, proj, temp, log, timeout=300, max_turns=10,
        )
        calls = claude.get("pes_calls") or []
        lock_calls = [x for x in calls if (x.get("argv") or [None])[0] == "lock"]
        after_pj = sha(proj / "project.json")
        after_owner = owner(proj)
        c = claude.get("claude") or {}
        checks = []

        def chk(name, ok, detail):
            checks.append({"name": name, "status": "pass" if ok else "fail", "detail": detail})

        chk("init", init.get("exit") == 0 and isinstance(load_json(proj / "project.json"), dict), "exit=%s" % init.get("exit"))
        chk("lock_a", lock_a.get("exit") == 0 and before_owner == OWNER_A, "exit=%s owner=%s" % (lock_a.get("exit"), before_owner))
        chk("claude_exit", claude.get("exit") == 0 and not claude.get("timed_out"), "exit=%s" % claude.get("exit"))
        chk("claude_ok", c.get("is_error") is False and bool(c.get("session_id")), "is_error=%s" % c.get("is_error"))
        chk("agent_b_lock_call", len(lock_calls) >= 1, "calls=%s" % [x.get("argv") for x in calls])
        chk("agent_b_lock_exit3", bool(lock_calls) and all(x.get("exit") == 3 for x in lock_calls), "exits=%s" % [x.get("exit") for x in lock_calls])
        chk("agent_b_lock_message", any("다른 세션" in ((x.get("stderr") or "") + (x.get("stdout") or "")) for x in lock_calls), "outputs=%s" % [(x.get("stdout"), x.get("stderr")) for x in lock_calls])
        chk("project_json_unchanged", before_pj == after_pj, "%s -> %s" % (before_pj, after_pj))
        chk("lock_owner_unchanged", after_owner == OWNER_A, "%s -> %s" % (before_owner, after_owner))

        rec = {
            "ok": all(x["status"] == "pass" for x in checks),
            "checks": checks,
            "init": {k: init[k] for k in ("exit", "stdout", "stderr")},
            "lock_a": lock_a_rec,
            "agent_b": claude,
            "wrapper_calls": calls,
            "lock_owner_before": before_owner,
            "lock_owner_after": after_owner,
            "project_json_before": before_pj,
            "project_json_after": after_pj,
        }
        log.add("LOCK AGENT PROBE ok=%s checks=%s" % (
            rec["ok"], ", ".join("%s:%s" % (x["name"], x["status"]) for x in checks)
        ))
    finally:
        LOGS.mkdir(parents=True, exist_ok=True)
        (LOGS / "lock-agent-probe.json").write_text(
            sanitize(json.dumps(rec, ensure_ascii=False, indent=1), temp, REPO), encoding="utf-8"
        )
        log.save("lock-agent-probe.log")
        shutil.rmtree(temp, ignore_errors=True)
    return 0 if rec.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
