#!/usr/bin/env python3
"""SEL-19 방식 B 시험 실행기 (표준 라이브러리만).

합성 PES 프로젝트를 저장소 밖 임시 디렉터리에 만들고, 빈 포트에 serve.py를 띄운 뒤
Claude Code 비대화형(-p) 세션으로 공통 시나리오 한 라운드 + 재개 + 잠금을 시험한다.

핵심 안전장치:
- Claude Code 권한은 `--restricted` + cwd(프로젝트 폴더)로 묶는다. 파일 도구는 cwd 밖으로
  나갈 수 없고, `project.json`/`.pes-lock` 직접 Write/Edit는 명시적으로 거부한다.
- Bash는 `<임시>/bin/pes` 검증 래퍼만 허용한다. 래퍼는 허용 명령·시험 루트 안 경로만 실행하고
  호출별 exit/stdout/stderr/project.json 전후 해시를 기록한다.
- 각 단계의 기대값을 검사하고, 하나라도 실패하면 비영(1)으로 끝난다. 실패한 선행 단계 뒤의
  유료 호출은 중단한다.
- 서버·Claude 자식 프로세스는 finally에서 프로세스 그룹으로 회수하고 포트가 비었는지 확인한다.

실행:
    python3 docs/plan/spikes/mode-b/run_spike.py [--keep-temp] [--timeout 초]
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from harness import (  # noqa: E402
    Log, free_port, kill_tree, load_json, port_free, post_feedback, run_claude,
    run_cmd, sanitize, sha, wait_http, write_wrapper,
)
from probe_permissions import run_probe as run_permission_probe  # noqa: E402

REPO = HERE.parents[3]
LOGS = HERE / "logs"
OWNER_A = "agent-a"
OWNER_B = "agent-b"


class SpikeFailure(Exception):
    pass


def read_lock_owner(proj):
    x = load_json(Path(proj) / ".pes-lock")
    return (x or {}).get("owner")


def state(proj):
    proj = Path(proj)
    pj = load_json(proj / "project.json")
    if not isinstance(pj, dict):
        return None
    plan = (pj.get("stages") or {}).get("plan") or {}
    processed = pj.get("processed") or []
    pending = [
        f.name for f in (proj / "feedback").glob("*.json")
        if f.name not in set(processed)
    ]
    return {"project": pj, "plan": plan, "processed": processed, "pending": pending}


def direct_edit_gaps(rec):
    """Claude 호출 구간에서 래퍼 호출 사이의 project.json 해시 단절을 찾는다."""
    calls = rec.get("pes_calls") or []
    before = rec.get("project_json_before")
    after = rec.get("project_json_after")
    gaps = []
    if not calls:
        if before != after:
            gaps.append("PES 호출 없이 project.json 해시가 바뀜: %s -> %s" % (before, after))
        return gaps
    if calls[0].get("project_json_before") != before:
        gaps.append("첫 PES 호출 전 해시 불일치: %s -> %s" % (before, calls[0].get("project_json_before")))
    if calls[-1].get("project_json_after") != after:
        gaps.append("마지막 PES 호출 뒤 해시 불일치: %s -> %s" % (calls[-1].get("project_json_after"), after))
    for a, b in zip(calls, calls[1:]):
        if a.get("project_json_after") != b.get("project_json_before"):
            gaps.append(
                "PES 호출 사이 해시 단절: %s -> %s (다음 호출 %s)"
                % (a.get("project_json_after"), b.get("project_json_before"), b.get("argv"))
            )
    return gaps


def project_json_write_attempts(rec):
    out = []
    for d in (rec.get("claude") or {}).get("permission_denials") or []:
        ti = d.get("tool_input") or {}
        target = ti.get("file_path") or ti.get("path") or ""
        if d.get("tool_name") in ("Write", "Edit") and "project.json" in str(target):
            out.append({"tool": d.get("tool_name"), "target": str(target)})
    return out


def prompt_r1(temp, proj, wrapper):
    return f"""너는 PES 프로젝트의 작업 에이전트다. PES 프로젝트 폴더는 {proj} 이다.

규칙:
- 작업 디렉터리({proj}) 밖의 파일은 읽거나 쓰지 않는다.
- project.json 을 직접 편집하지 않는다. 모든 상태 변경은 PES CLI로만 한다.
- PES CLI는 반드시 `{wrapper}` 실행 파일로 실행한다. `python3`를 직접 쓰지 않는다.
- 환경변수 PES_HOME과 PES_OWNER=agent-a는 이미 설정되어 있다.
- 셸에서는 `{wrapper}` 명령만 한 줄에 하나씩 실행한다.

할 일(순서대로):
1. `{wrapper} lock {proj}` 로 이 세션이 프로젝트를 쓴다고 표시한다.
2. `{wrapper} status {proj}` 로 맥락을 읽는다.
3. Write 도구로 {proj}/result-r1.json 을 만든다. 내용은 JSON 객체 하나:
   {{"id": 1, "title": "합성 주제 범위 정리", "kind": "section", "summary": "합성 주제의 범위를 한 문장으로 정리", "details": "합성 자료만 사용한 시험용 계획이다.", "confidence": "medium", "sources": []}}
4. `{wrapper} merge {proj} plan {proj}/result-r1.json`
5. `{wrapper} render {proj} plan`
6. `{wrapper} ask-prep {proj} plan`
7. `{wrapper} ask {proj} {proj}/ask/plan-start.json`
8. `{wrapper} status {proj}` 로 결과를 확인한다.
마지막에 한 줄로 무엇을 했는지 요약한다."""


def prompt_resume(temp, proj, wrapper, variant):
    common = f"""너는 PES 프로젝트의 작업 에이전트다. PES 프로젝트 폴더는 {proj} 이다.

규칙:
- 작업 디렉터리({proj}) 밖의 파일은 읽거나 쓰지 않는다.
- project.json 을 직접 편집하지 않는다. 모든 상태 변경은 PES CLI로만 한다.
- PES CLI는 반드시 `{wrapper}` 실행 파일로 실행한다. `python3`를 직접 쓰지 않는다.
- 환경변수 PES_HOME과 PES_OWNER=agent-a는 이미 설정되어 있다.
- 셸에서는 `{wrapper}` 명령만 한 줄에 하나씩 실행한다.
"""
    if variant == "resume":
        body = f"""이전 세션에서 이어서 작업한다.
1. `{wrapper} pending {proj}` 로 처리 안 한 답 파일을 모두 찾는다.
2. 찾은 파일을 Read로 읽고 stage/kind/text/answers를 확인한다.
3. 답을 반영해 `{wrapper} round-start {proj} plan` 을 실행한다.
4. `{wrapper} mark {proj} <찾은 파일들>` 로 처리 완료 표시한다.
5. `{wrapper} render {proj} plan`
6. `{wrapper} status {proj}` 로 미처리 답이 0인지 확인한다.
답 파일이 없으면 아무것도 바꾸지 말고 "미처리 답 없음"이라고만 답한다.
마지막에 처리한 파일 이름과 미처리 답 개수를 한 줄로 요약한다."""
    elif variant == "continue":
        body = f"""같은 프로젝트에서 계속한다.
1. `{wrapper} pending {proj}` 로 처리 안 한 답 파일을 모두 찾는다.
2. 찾은 파일을 Read로 읽고 내용을 확인한다.
3. `{wrapper} round-start {proj} plan` 으로 다음 라운드를 시작한다.
4. Write 도구로 {proj}/result-r2.json 을 만든다. 내용은 JSON 객체 하나:
   {{"id": 2, "title": "합성 출처 보강", "kind": "section", "summary": "합성 출처를 하나 더 붙인다", "details": "시험용 합성 출처다.", "confidence": "medium", "sources": [{{"title": "합성 자료 A", "url": "https://example.invalid/a"}}]}}
5. `{wrapper} merge {proj} plan {proj}/result-r2.json`
6. `{wrapper} mark {proj} <찾은 파일들>`
7. `{wrapper} render {proj} plan`
8. `{wrapper} status {proj}` 로 미처리 답이 0인지 확인한다.
답 파일이 없으면 아무것도 바꾸지 말고 "미처리 답 없음"이라고만 답한다.
마지막에 처리한 파일 이름과 미처리 답 개수를 한 줄로 요약한다."""
    else:  # fresh
        body = f"""새 세션이다. 이전 대화 기억이 없다. PES 상태만 보고 이어서 작업한다.
1. `{wrapper} pending {proj}` 로 처리 안 한 답 파일을 모두 찾는다.
2. 찾은 파일을 Read로 읽고 내용을 확인한다.
3. `{wrapper} note {proj} "R2까지 처리함. 다음은 R3 준비."` 로 인계 메모를 남긴다.
4. `{wrapper} mark {proj} <찾은 파일들>`
5. `{wrapper} render {proj} plan`
6. `{wrapper} status {proj}` 로 미처리 답이 0인지 확인한다.
답 파일이 없으면 아무것도 바꾸지 말고 "미처리 답 없음"이라고만 답한다.
마지막에 처리한 파일 이름과 미처리 답 개수를 한 줄로 요약한다."""
    return common + "\n" + body


def prompt_lock_b(temp, proj, wrapper):
    return f"""너는 두 번째 에이전트(agent-b)다. PES 프로젝트 폴더는 {proj} 이다.
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep-temp", action="store_true")
    ap.add_argument("--timeout", type=int, default=420)
    args = ap.parse_args()

    temp = Path(tempfile.mkdtemp(prefix="pes-mode-b-")).resolve()
    home = temp / "home"
    proj = home / "proj"
    LOGS.mkdir(parents=True, exist_ok=True)
    log = Log(temp, REPO, LOGS)
    checks = []
    results = {}
    srv = None
    srv_out = None
    port = None
    exit_ok = False
    cleanup_ok = True

    def record(name, status, detail, required=True):
        checks.append({"name": name, "status": status, "detail": detail, "required": required})
        log.add("CHECK %s %s %s" % (name, status, detail))

    def require(ok, name, detail):
        record(name, "pass" if ok else "fail", detail)
        if not ok:
            raise SpikeFailure("%s: %s" % (name, detail))

    try:
        (temp / "logs").mkdir(parents=True, exist_ok=True)
        for old in LOGS.glob("*"):
            if old.is_file():
                old.unlink()
        log.add("임시 디렉터리 생성: <임시> (PES_HOME=<임시>/home, 프로젝트=<임시>/home/proj)")

        env = os.environ.copy()
        env.update({"PES_HOME": str(home), "PES_OWNER": OWNER_A, "NO_COLOR": "1"})
        env_b = env.copy()
        env_b["PES_OWNER"] = OWNER_B
        base_env = os.environ.copy()
        base_env["PES_HOME"] = str(home)
        # serve.py는 trusted_origins를 ~/.pes/config.json에서 읽는다(홈 경로 고정).
        # 실제 ~/.pes를 건드리지 않도록 서버 프로세스의 HOME도 임시 홈으로 바꾼다.
        base_env["HOME"] = str(home)
        base_env["USERPROFILE"] = str(home)

        wrapper = write_wrapper(temp, REPO)

        # 1) 합성 프로젝트
        r = run_cmd(
            [sys.executable, str(REPO / "scripts" / "pes.py"), "init", str(proj), "--topic", "합성 주제"],
            env=env,
        )
        pj = load_json(proj / "project.json")
        require(
            r["exit"] == 0 and isinstance(pj, dict),
            "init",
            "exit=%s project.json=%s stderr=%s" % (r["exit"], isinstance(pj, dict), r["stderr"][:200]),
        )

        # 2) 권한 한정 시험 (별도 합성 프로젝트)
        perm = run_permission_probe(temp, REPO, log)
        results["permission_probe"] = perm
        require(
            perm.get("ok") is True,
            "permission_probe",
            "checks=%s" % ", ".join("%s:%s" % (x["name"], x["status"]) for x in perm.get("checks", [])),
        )

        # 3) 서버
        port = free_port()
        srv_out = (temp / "logs" / "serve.out").open("w", encoding="utf-8")
        srv = subprocess.Popen(
            [sys.executable, "-I", str(REPO / "scripts" / "serve.py"), str(home), str(port)],
            env=base_env, stdout=srv_out, stderr=subprocess.STDOUT, start_new_session=True,
        )
        st, body = wait_http("http://127.0.0.1:%d/ping" % port)
        require(st == 200, "serve_ping", "status=%s body=%s" % (st, str(body)[:120]))
        log.add("serve.py pid=%s port=%s HOME=<임시>/home" % (srv.pid, port))

        # 4) 1라운드
        r1 = run_claude(
            "r1-setup", prompt_r1(temp, proj, wrapper), env, proj, temp, log, timeout=args.timeout,
        )
        results["r1"] = r1
        c1 = r1.get("claude") or {}
        require(
            r1["exit"] == 0 and not r1.get("timed_out") and c1.get("is_error") is False and c1.get("session_id"),
            "r1.claude",
            "exit=%s timed_out=%s is_error=%s session=%s" % (r1["exit"], r1.get("timed_out"), c1.get("is_error"), bool(c1.get("session_id"))),
        )
        cmds = [x.get("argv", [None])[0] for x in r1.get("pes_calls") or []]
        for need in ("lock", "status", "merge", "render", "ask-prep", "ask"):
            require(need in cmds, "r1.call.%s" % need, "calls=%s" % cmds)
        bad = [x for x in r1.get("pes_calls") or [] if x.get("exit") != 0]
        require(not bad, "r1.call_exits", "nonzero=%s" % [(x.get("argv"), x.get("exit")) for x in bad])
        gaps = direct_edit_gaps(r1)
        require(not gaps, "r1.project_json_direct_edit", "gaps=%s" % gaps)
        st1 = state(proj)
        require(st1 is not None, "r1.state", "project.json load")
        require(any(int(i.get("id")) == 1 for i in st1["plan"].get("items", [])), "r1.item1", "items=%s" % [i.get("id") for i in st1["plan"].get("items", [])])
        require((proj / "result-r1.json").exists() and isinstance(load_json(proj / "result-r1.json"), dict), "r1.result_json", str(proj / "result-r1.json"))
        require((proj / "ask" / "plan-start.json").exists(), "r1.ask_spec", str(proj / "ask" / "plan-start.json"))
        require((proj / "ask-plan-start.html").exists(), "r1.ask_html", str(proj / "ask-plan-start.html"))
        require((proj / "index.html").exists(), "r1.index", str(proj / "index.html"))
        results["r1"]["project_json_write_denied"] = project_json_write_attempts(r1)

        # 5) 사람 답 흉내 1
        st, fb = post_feedback(port, proj.name, {
            "stage": "plan", "round": 0, "kind": "stage_start",
            "text": "합성 답: 보고서 작성, 내부 연구진, 범위는 현황 파악까지.",
            "answers": {"topic": "합성 주제", "purpose": "report", "audience": "internal"},
            "spec": "plan-start",
        })
        f1 = (fb or {}).get("file") if isinstance(fb, dict) else None
        require(st == 200 and isinstance(fb, dict) and fb.get("ok") is True and f1, "feedback1", "status=%s resp=%s" % (st, fb))
        require((proj / "feedback" / f1).exists(), "feedback1.file", f1)
        st1 = state(proj)
        require(st1 is not None and len(st1["pending"]) == 1 and f1 in st1["pending"], "feedback1.pending", "pending=%s" % (st1 or {}).get("pending"))
        log.add("POST /feedback #1 status=%s file=%s" % (st, f1))

        # 6) 재개 --resume
        r2 = run_claude(
            "r2-resume", prompt_resume(temp, proj, wrapper, "resume"), env, proj, temp, log,
            timeout=args.timeout, extra_args=["--resume", c1.get("session_id")],
        )
        results["r2"] = r2
        c2 = r2.get("claude") or {}
        require(
            r2["exit"] == 0 and not r2.get("timed_out") and c2.get("is_error") is False and c2.get("session_id") == c1.get("session_id"),
            "r2.claude",
            "exit=%s is_error=%s session_same=%s" % (r2["exit"], c2.get("is_error"), c2.get("session_id") == c1.get("session_id")),
        )
        cmds = [x.get("argv", [None])[0] for x in r2.get("pes_calls") or []]
        for need in ("pending", "round-start", "mark", "render", "status"):
            require(need in cmds, "r2.call.%s" % need, "calls=%s" % cmds)
        bad = [x for x in r2.get("pes_calls") or [] if x.get("exit") != 0]
        require(not bad, "r2.call_exits", "nonzero=%s" % [(x.get("argv"), x.get("exit")) for x in bad])
        require(not direct_edit_gaps(r2), "r2.project_json_direct_edit", "gaps=%s" % direct_edit_gaps(r2))
        st2 = state(proj)
        require(st2 is not None, "r2.state", "project.json load")
        require(st2["plan"].get("round") == 1, "r2.round", "round=%s" % st2["plan"].get("round"))
        require(f1 in st2["processed"], "r2.marked", "processed=%s" % st2["processed"])
        require(st2["pending"] == [], "r2.pending_zero", "pending=%s" % st2["pending"])
        require((proj / "snapshots" / "plan-R1.json").exists(), "r2.snapshot", "plan-R1.json")

        # 7) 사람 답 흉내 2
        st, fb = post_feedback(port, proj.name, {
            "stage": "plan", "round": 1, "kind": "feedback",
            "text": "합성 답: R1 결과에 합성 출처를 하나 더 넣어라.",
            "answers": {},
        })
        f2 = (fb or {}).get("file") if isinstance(fb, dict) else None
        require(st == 200 and isinstance(fb, dict) and fb.get("ok") is True and f2, "feedback2", "status=%s resp=%s" % (st, fb))
        st2 = state(proj)
        require(st2 is not None and f2 in st2["pending"], "feedback2.pending", "pending=%s" % (st2 or {}).get("pending"))

        # 8) --continue
        r3 = run_claude(
            "r3-continue", prompt_resume(temp, proj, wrapper, "continue"), env, proj, temp, log,
            timeout=args.timeout, extra_args=["--continue"],
        )
        results["r3"] = r3
        c3 = r3.get("claude") or {}
        require(
            r3["exit"] == 0 and not r3.get("timed_out") and c3.get("is_error") is False and c3.get("session_id") == c1.get("session_id"),
            "r3.claude",
            "exit=%s is_error=%s session_same=%s" % (r3["exit"], c3.get("is_error"), c3.get("session_id") == c1.get("session_id")),
        )
        cmds = [x.get("argv", [None])[0] for x in r3.get("pes_calls") or []]
        for need in ("pending", "round-start", "merge", "mark", "render", "status"):
            require(need in cmds, "r3.call.%s" % need, "calls=%s" % cmds)
        bad = [x for x in r3.get("pes_calls") or [] if x.get("exit") != 0]
        require(not bad, "r3.call_exits", "nonzero=%s" % [(x.get("argv"), x.get("exit")) for x in bad])
        require(not direct_edit_gaps(r3), "r3.project_json_direct_edit", "gaps=%s" % direct_edit_gaps(r3))
        st3 = state(proj)
        require(st3 is not None, "r3.state", "project.json load")
        require(st3["plan"].get("round") == 2, "r3.round", "round=%s" % st3["plan"].get("round"))
        ids = sorted(int(i.get("id")) for i in st3["plan"].get("items", []) if str(i.get("id")).isdigit())
        require(ids == [1, 2], "r3.items", "items=%s" % ids)
        require(f2 in st3["processed"], "r3.marked", "processed=%s" % st3["processed"])
        require(st3["pending"] == [], "r3.pending_zero", "pending=%s" % st3["pending"])
        require((proj / "snapshots" / "plan-R2.json").exists(), "r3.snapshot", "plan-R2.json")

        # 9) 사람 답 흉내 3
        st, fb = post_feedback(port, proj.name, {
            "stage": "plan", "round": 2, "kind": "feedback",
            "text": "합성 답: 인계 메모를 남기고 다음 라운드를 준비해라.",
            "answers": {},
        })
        f3 = (fb or {}).get("file") if isinstance(fb, dict) else None
        require(st == 200 and isinstance(fb, dict) and fb.get("ok") is True and f3, "feedback3", "status=%s resp=%s" % (st, fb))
        st3 = state(proj)
        require(st3 is not None and f3 in st3["pending"], "feedback3.pending", "pending=%s" % (st3 or {}).get("pending"))

        # 10) 새 세션
        r4 = run_claude(
            "r4-fresh", prompt_resume(temp, proj, wrapper, "fresh"), env, proj, temp, log,
            timeout=args.timeout,
        )
        results["r4"] = r4
        c4 = r4.get("claude") or {}
        require(
            r4["exit"] == 0 and not r4.get("timed_out") and c4.get("is_error") is False and c4.get("session_id") and c4.get("session_id") != c1.get("session_id"),
            "r4.claude",
            "exit=%s is_error=%s new_session=%s" % (r4["exit"], c4.get("is_error"), c4.get("session_id") != c1.get("session_id")),
        )
        cmds = [x.get("argv", [None])[0] for x in r4.get("pes_calls") or []]
        for need in ("pending", "note", "mark", "render", "status"):
            require(need in cmds, "r4.call.%s" % need, "calls=%s" % cmds)
        bad = [x for x in r4.get("pes_calls") or [] if x.get("exit") != 0]
        require(not bad, "r4.call_exits", "nonzero=%s" % [(x.get("argv"), x.get("exit")) for x in bad])
        require(not direct_edit_gaps(r4), "r4.project_json_direct_edit", "gaps=%s" % direct_edit_gaps(r4))
        st4 = state(proj)
        require(st4 is not None, "r4.state", "project.json load")
        require(f3 in st4["processed"], "r4.marked", "processed=%s" % st4["processed"])
        require(st4["pending"] == [], "r4.pending_zero", "pending=%s" % st4["pending"])
        notes = st4["project"].get("notes") or []
        require(any("R2까지" in str(n.get("text", "")) for n in notes), "r4.note", "notes=%s" % notes)

        # 11) agent-b Claude 잠금 시도
        before_r5 = sha(proj / "project.json")
        require(read_lock_owner(proj) == OWNER_A, "r5.lock_owner_before", "owner=%s" % read_lock_owner(proj))
        r5 = run_claude(
            "r5-lock-b", prompt_lock_b(temp, proj, wrapper), env_b, proj, temp, log,
            timeout=args.timeout, max_turns=10,
        )
        results["r5"] = r5
        c5 = r5.get("claude") or {}
        require(r5["exit"] == 0 and not r5.get("timed_out") and c5.get("is_error") is False, "r5.claude", "exit=%s is_error=%s" % (r5["exit"], c5.get("is_error")))
        lock_calls = [x for x in r5.get("pes_calls") or [] if (x.get("argv") or [None])[0] == "lock"]
        require(len(lock_calls) >= 1, "r5.lock_call", "calls=%s" % [x.get("argv") for x in r5.get("pes_calls") or []])
        require(all(x.get("exit") == 3 for x in lock_calls), "r5.lock_exit", "exits=%s" % [x.get("exit") for x in lock_calls])
        require(any("다른 세션" in (x.get("stderr") or "") + (x.get("stdout") or "") for x in lock_calls), "r5.lock_message", "outputs=%s" % [(x.get("stdout"), x.get("stderr")) for x in lock_calls])
        require(sha(proj / "project.json") == before_r5, "r5.project_json", "%s -> %s" % (before_r5, sha(proj / "project.json")))
        require(read_lock_owner(proj) == OWNER_A, "r5.lock_owner_after", "owner=%s" % read_lock_owner(proj))

        # 12) CLI 잠금 검사 (하네스가 직접)
        probe = temp / "lock-probe.json"
        probe.write_text(json.dumps({"id": 99, "title": "잠금 시험", "kind": "section"}, ensure_ascii=False), encoding="utf-8")
        lock_b = run_cmd([sys.executable, str(REPO / "scripts" / "pes.py"), "lock", str(proj)], env=env_b)
        require(lock_b["exit"] == 3 and "다른 세션" in lock_b["stderr"], "cli_lock_b", "exit=%s stderr=%s" % (lock_b["exit"], lock_b["stderr"][:200]))
        merge_b = run_cmd([sys.executable, str(REPO / "scripts" / "pes.py"), "merge", str(proj), "plan", str(probe)], env=env_b)
        require(merge_b["exit"] == 3 and "다른 세션" in merge_b["stderr"], "cli_merge_b", "exit=%s stderr=%s" % (merge_b["exit"], merge_b["stderr"][:200]))
        force_b = run_cmd([sys.executable, str(REPO / "scripts" / "pes.py"), "lock", str(proj), "--force"], env=env_b)
        require(force_b["exit"] == 0 and read_lock_owner(proj) == OWNER_B, "cli_force_b", "exit=%s owner=%s" % (force_b["exit"], read_lock_owner(proj)))
        before_a = sha(proj / "project.json")
        merge_a = run_cmd([sys.executable, str(REPO / "scripts" / "pes.py"), "merge", str(proj), "plan", str(probe)], env=env)
        require(merge_a["exit"] == 3 and "다른 세션" in merge_a["stderr"], "cli_merge_a_after_force", "exit=%s stderr=%s" % (merge_a["exit"], merge_a["stderr"][:200]))
        require(sha(proj / "project.json") == before_a, "cli_merge_a_no_write", "%s -> %s" % (before_a, sha(proj / "project.json")))
        unlock_b = run_cmd([sys.executable, str(REPO / "scripts" / "pes.py"), "unlock", str(proj)], env=env_b)
        require(unlock_b["exit"] == 0 and not (proj / ".pes-lock").exists(), "cli_unlock_b", "exit=%s lock_exists=%s" % (unlock_b["exit"], (proj / ".pes-lock").exists()))
        results["lock_cli"] = {
            "lock_b": {k: lock_b[k] for k in ("exit", "stdout", "stderr")},
            "merge_b": {k: merge_b[k] for k in ("exit", "stdout", "stderr")},
            "force_b": {k: force_b[k] for k in ("exit", "stdout", "stderr")},
            "merge_a_after_force": {k: merge_a[k] for k in ("exit", "stdout", "stderr")},
            "unlock_b": {k: unlock_b[k] for k in ("exit", "stdout", "stderr")},
        }

        # 13) 최종 GET
        st, html = wait_http("http://127.0.0.1:%d/%s/" % (port, proj.name))
        require(st == 200 and isinstance(html, str) and len(html) > 1000, "final_get", "status=%s bytes=%s" % (st, len(html or "")))

        # 14) 산출물 요약
        stf = state(proj)
        require(stf is not None, "final.state", "project.json load")
        results["checks_state"] = {
            "plan_round": stf["plan"].get("round"),
            "plan_items": [i.get("id") for i in stf["plan"].get("items", [])],
            "processed": stf["processed"],
            "pending": stf["pending"],
            "notes": stf["project"].get("notes", []),
            "feedback_files": sorted(p.name for p in (proj / "feedback").glob("*.json")),
            "snapshots": sorted(p.name for p in (proj / "snapshots").glob("*.json")),
            "ask_html": (proj / "ask-plan-start.html").exists(),
            "index": (proj / "index.html").exists(),
        }
        log.add("산출물 확인: %s" % json.dumps(results["checks_state"], ensure_ascii=False))
        exit_ok = True

    except SpikeFailure as e:
        log.add("STOP: %s" % e)
    except Exception as e:
        log.add("ERROR: %r" % e)
    finally:
        # 서버 정리
        if srv is not None:
            kill_tree(srv)
            if srv.poll() is None:
                cleanup_ok = False
                log.add("serve.py가 종료되지 않음: pid=%s" % srv.pid)
        if srv_out is not None:
            try:
                srv_out.close()
            except Exception:
                pass
        if port is not None:
            time.sleep(0.3)
            freed = port_free(port)
            record("cleanup_port", "pass" if freed else "fail", "port=%s free=%s" % (port, freed))
            cleanup_ok = cleanup_ok and freed
        else:
            record("cleanup_port", "pass", "서버를 띄우기 전에 중단됨", required=False)

        results["checks"] = checks
        results["exit_ok"] = exit_ok
        results["cleanup_ok"] = cleanup_ok
        results["exit"] = 0 if (exit_ok and cleanup_ok and not [c for c in checks if c["required"] and c["status"] != "pass"]) else 1
        try:
            LOGS.mkdir(parents=True, exist_ok=True)
            (LOGS / "summary.json").write_text(
                sanitize(json.dumps(results, ensure_ascii=False, indent=1, default=str), temp, REPO),
                encoding="utf-8",
            )
            calls_log = temp / "logs" / "pes-calls.log"
            if calls_log.exists():
                (LOGS / "pes-calls.log").write_text(
                    sanitize(calls_log.read_text(encoding="utf-8"), temp, REPO), encoding="utf-8"
                )
            log.save()
        except Exception as e:
            print("로그 저장 실패: %r" % (e,), file=sys.stderr)
        if args.keep_temp:
            print("임시 디렉터리 유지: %s" % temp)
        else:
            shutil.rmtree(temp, ignore_errors=True)

    return results.get("exit", 1)


if __name__ == "__main__":
    sys.exit(main())
