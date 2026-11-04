#!/usr/bin/env python3
"""`claude -p --continue`가 실제로 같은 대화를 잇는지 확인하는 작은 탐침.

PES와 무관하게, 첫 호출에서 기억하라고 한 단어를 두 번째 --continue 호출이
말할 수 있는지 본다. 결과는 logs/continue-probe.json 에 자리표시로 저장한다.
"""
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
LOGS = HERE / "logs"
MODEL = "claude-sonnet-5-5"
WORD = "BANANA-7731"


def run(prompt, extra):
    cmd = [
        shutil.which("claude") or "claude",
        "-p", prompt,
        "--model", MODEL,
        "--max-turns", "3",
        "--output-format", "json",
        *extra,
    ]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    try:
        out = json.loads(p.stdout)
    except Exception:
        out = {}
    return {
        "exit": p.returncode,
        "stderr": p.stderr,
        "session_id": out.get("session_id"),
        "num_turns": out.get("num_turns"),
        "duration_ms": out.get("duration_ms"),
        "total_cost_usd": out.get("total_cost_usd"),
        "result": out.get("result"),
    }


def sanitize(text: str, temp: Path) -> str:
    text = text.replace(str(temp), "<임시>").replace(str(Path.home()), "<홈>")
    import re
    text = re.sub(r"/[U]sers/[^\s\"'`]+", "<홈경로>", text)
    text = re.sub(r"/private/var/folders/[^\s\"'`]+", "<임시경로>", text)
    return text


def main():
    temp = Path(tempfile.mkdtemp(prefix="pes-mode-b-cont-")).resolve()
    try:
        first = run(f"다음 단어를 기억해라: {WORD}. 지금은 OK라고만 답해라.", [])
        second = run("내가 기억하라고 한 단어가 뭐였지? 그 단어만 답해라.", ["--continue"])
        rec = {"word": WORD, "first": first, "second": second,
               "continued": WORD in (second.get("result") or "")}
        LOGS.mkdir(parents=True, exist_ok=True)
        (LOGS / "continue-probe.json").write_text(
            sanitize(json.dumps(rec, ensure_ascii=False, indent=1), temp), encoding="utf-8"
        )
        print(json.dumps({k: rec[k] for k in ("continued",)}, ensure_ascii=False))
        print(f"first_session={first.get('session_id')} second_session={second.get('session_id')}")
        print(f"second_result={second.get('result')!r}")
    finally:
        shutil.rmtree(temp, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
