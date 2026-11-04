#!/usr/bin/env python3
"""`claude -p --continue`가 실제로 같은 대화를 잇는지 확인하는 작은 탐침.

PES와 무관하게, 첫 호출에서 기억하라고 한 단어를 두 번째 --continue 호출이
말할 수 있는지 본다. 도구는 모두 끄고 임시 cwd에서 실행한다.
결과는 logs/continue-probe.json 에 자리표시로 저장하고, 실패하면 비영 종료한다.
"""
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from harness import Log, parse_claude_json, run_cmd, sanitize  # noqa: E402

REPO = HERE.parents[3]
LOGS = HERE / "logs"
MODEL = "claude-sonnet-5-5"
WORD = "BANANA-7731"


def call(prompt, cwd, extra=None):
    cmd = [
        "claude", "-p", prompt,
        "--model", MODEL,
        "--max-turns", "3",
        "--output-format", "json",
        "--restricted",
        "--tools", "",
    ]
    cmd.extend(extra or [])
    r = run_cmd(cmd, env=os.environ.copy(), cwd=cwd, timeout=180)
    out = parse_claude_json(r["stdout"]) or {}
    return {
        "exit": r["exit"],
        "timed_out": r["timed_out"],
        "stderr": r["stderr"],
        "session_id": out.get("session_id"),
        "num_turns": out.get("num_turns"),
        "duration_ms": out.get("duration_ms"),
        "total_cost_usd": out.get("total_cost_usd"),
        "is_error": out.get("is_error"),
        "result": out.get("result"),
    }


def main():
    temp = Path(tempfile.mkdtemp(prefix="pes-mode-b-cont-")).resolve()
    log = Log(temp, REPO, LOGS)
    rec = {}
    try:
        first = call("다음 단어를 기억해라: %s. 지금은 OK라고만 답해라." % WORD, temp)
        second = call("내가 기억하라고 한 단어가 뭐였지? 그 단어만 답해라.", temp, ["--continue"])
        same_session = bool(first.get("session_id")) and first.get("session_id") == second.get("session_id")
        checks = [
            {"name": "first_exit", "status": "pass" if first.get("exit") == 0 and not first.get("timed_out") else "fail", "detail": "exit=%s" % first.get("exit")},
            {"name": "second_exit", "status": "pass" if second.get("exit") == 0 and not second.get("timed_out") else "fail", "detail": "exit=%s" % second.get("exit")},
            {"name": "same_session", "status": "pass" if same_session else "fail", "detail": "%s / %s" % (first.get("session_id"), second.get("session_id"))},
            {"name": "word_recalled", "status": "pass" if WORD in (second.get("result") or "") else "fail", "detail": repr(second.get("result"))[:200]},
        ]
        rec = {
            "ok": all(x["status"] == "pass" for x in checks),
            "checks": checks,
            "word": WORD,
            "first": first,
            "second": second,
            "continued": same_session and WORD in (second.get("result") or ""),
        }
        log.add("CONTINUE PROBE ok=%s same_session=%s word=%s" % (rec["ok"], same_session, WORD in (second.get("result") or "")))
    finally:
        LOGS.mkdir(parents=True, exist_ok=True)
        (LOGS / "continue-probe.json").write_text(
            sanitize(json.dumps(rec, ensure_ascii=False, indent=1), temp, REPO), encoding="utf-8"
        )
        log.save("continue-probe.log")
        shutil.rmtree(temp, ignore_errors=True)
    return 0 if rec.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
