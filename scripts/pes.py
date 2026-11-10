#!/usr/bin/env python3
"""PES (Project Execution System) — 프로젝트 상태 CLI.

프로젝트 하나 = 폴더 하나. project.json 이 단일 진실 원천이고, 단계(기획→조사→분석·종합→집필→검증→산출·공유)마다
라운드를 돈다. Claude 는 이 CLI 로 상태를 바꾸고, 사용자는 대시보드(index.html)·질문 폼(ask-*.html)으로 답한다.

사용: python3 -I pes.py <명령> <프로젝트 폴더> [인자]
  init <dir> --topic "주제" [--slug s] [--import <research-loop 폴더>]   새 프로젝트 (기획 단계부터)
  ask-prep <dir> <stage|resume>        질문 은행을 ask/<id>.json 으로 복사 (Claude 가 다듬는다)
  ask <dir> <spec.json>                질문 폼 HTML 생성 → ask-<id>.html
  round-start <dir> <stage>            라운드 +1 (현재 단계로 지정, changes 비움)
  merge <dir> <stage> <result.json...> 서브에이전트 결과 병합 (출처 누적, 제안 수집)
  render <dir> [stage]                 스냅샷 저장 + 대시보드 index.html 생성
  approve <dir> <stage>                단계 승인 → 다음 단계로 (기획→조사는 조사 항목 자동 생성)
  reopen <dir> <stage>                 앞 단계 다시 열기 (뒤 단계에 '다시 확인 필요' 표시)
  status <dir>                         한눈 요약 (단계·라운드·받지 않은 답)
  pending <dir>                        처리 안 한 답 파일 경로 목록
  mark <dir> <feedback 파일...>         처리 완료 표시
  chat <dir> <stage> "텍스트" [kind]    채팅으로 받은 지시를 답 파일로 기록 (처리 완료로)
  digest <dir> <stage> [--round N]     AI 점검용 압축 요약 (항목별 요약 첫 줄·수치·충돌·신뢰도·출처 확인율·남은 질문)
  show <dir> <stage> [id...] [--fields a,b]  필요한 항목·필드만 보기 (project.json 을 통째로 읽지 않는다)
                                       (--fields 가 changes·carry_over·settings·review 뿐이고 id 가 없으면 단계 값을 보여 준다)
  note <dir> "메모"                     인계 메모 추가 (대화에서 나온 결정·선호 — 새 세션이 먼저 읽는다)
  set <dir> <stage> <field> <file|->   단계 필드 하나를 통째로 바꾼다 (허용: summary·changes·carry_over·settings·review — 값은 파일 또는 `-`(표준 입력);
                                       summary 는 텍스트, changes 는 문자열 배열, carry_over 는 객체 배열, settings·review 는 JSON 객체)
  set <dir> project <field> <file|->   프로젝트 필드 하나를 바꾼다 (허용: executive_summary·conclusion — 텍스트). 허용 밖 필드는 거부
  report <dir> <stage>                 단계 보고서: reports/<stage>/report.md·report.html 생성, eli5.json 이 있으면
                                       eli5.html 렌더, 폴더의 다른 형식(docx·hwpx·pdf…)까지 stages.<stage>.reports 에 등록
  assemble <dir>                       집필 원고를 out/report.md 로 조립 (각주 번호 정리) + out/sources.json
  web <dir> [--assemble]               최종 웹 보고서 out/report.html (표지·목차·각주·출처 부록·인쇄용). 표지 정보는 out/cover.json
  remote [list|add <주소>|remove <주소>] 다른 기기(Tailscale serve 등) 화면에서도 답 보내기 허용 — 허용한 주소의 사람은 답·승인을 보낼 수 있다
  qa-brief <dir> <stage>               독립 검토(QC/QA) 지시문 rounds/<stage>-R<n>/qa-brief.md (digest·자체 점검 초안·기준 포함)
  qa <dir> <stage> [--file f]          독립 검토 결과 qa.json 을 stages.<stage>.qa 에 기록 (자체 점검은 review_log 에)
  serve <dir>                          로컬 서버 시작 (홈마다 포트 하나 — 이미 떠 있으면 이 프로젝트 주소만)
  stop [dir]                           로컬 서버 종료 (그 홈의 목록·모든 프로젝트 화면이 함께 꺼짐)
  watch <dir>                          Monitor 에 넣을 명령 출력
  home                                 PES 홈(프로젝트들이 모이는 폴더) 보기 — 기본 ~/pes-projects
  home <새 폴더> [--from <옛 폴더>]     PES 홈 변경: 서버를 끄고 모든 프로젝트를 새 폴더로 옮긴 뒤 다시 켠다
  open <dir|주소>                      기본 브라우저로 열기 (macOS·Windows 공통)
  list                                 프로젝트 목록 (차례·단계·서버)
  hub                                  프로젝트 목록 화면 생성 + 서버(8760) 시작, 주소 출력
  <dir> 자리에 경로 대신 프로젝트 이름(slug)만 쓰면 PES 홈 아래에서 찾는다.
  doctor [dir] [--fix] [--net] [--json] 진단 (--net: 법령·KOSIS API 실제 연결 확인): 환경(Python·도구·키·포트·PES 홈)과 프로젝트(상태·잠금·답·보고서·연결)
                                       --fix 는 안전한 것만 고친다 (낡은 잠금·포트 파일, 남은 .tmp, 대시보드 재생성, 보고서 등록 갱신)
  which <도구>                          도구 경로 (PATH + ~/.local/bin, Windows LOCALAPPDATA\\Programs)
  lock <dir> [--force]                 이 세션이 프로젝트를 쓴다고 표시 (환경변수 PES_OWNER 필요)
  unlock <dir>                         표시 해제
  쓰기 명령은 다른 세션(PES_OWNER 다름)이 최근 2시간 안에 잠근 프로젝트면 거부한다.
"""
import html as htmlmod
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TPL = ROOT / "templates"
QB = ROOT / "questions"
STAGES = [("plan", "기획"), ("research", "조사"), ("analyze", "분석·종합"),
          ("write", "집필"), ("verify", "검증"), ("publish", "산출·공유")]
KEYS = [k for k, _ in STAGES]
LABEL = dict(STAGES)
VERIFIED = {"browser", "kosis", "law", "vworld"}


# ---------- 기본 ----------
def die(msg, code=1):
    print(msg, file=sys.stderr)
    sys.exit(code)


CONFIG = Path.home() / ".pes" / "config.json"


def pes_home() -> Path:
    """PES 홈: 환경변수 PES_HOME > ~/.pes/config.json 의 home > ~/pes-projects"""
    if os.environ.get("PES_HOME"):
        return Path(os.environ["PES_HOME"]).expanduser().resolve()
    try:
        h = json.loads(CONFIG.read_text(encoding="utf-8")).get("home")
        if h:
            return Path(h).expanduser().resolve()
    except Exception:
        pass
    return (Path.home() / "pes-projects").resolve()


def pdir(arg) -> Path:
    a = str(arg)
    if a and "/" not in a and "\\" not in a and not a.startswith(".") and ":" not in a and a != "~":
        return pes_home() / a
    return Path(a).expanduser().resolve()


def load(d: Path) -> dict:
    f = d / "project.json"
    if not f.exists():
        die(f"project.json 없음: {d}")
    p = json.loads(f.read_text(encoding="utf-8"))
    for k in KEYS:  # 손으로 쓴 항목에 빠진 필드를 채운다
        st = p.setdefault("stages", {}).setdefault(k, new_stage())
        for kk, v in new_stage().items():
            st.setdefault(kk, v)
        for it in st["items"]:
            for kk, v in blank_item(0, "").items():
                if kk not in ("id", "title"):
                    it.setdefault(kk, v if not isinstance(v, (list, dict)) else type(v)())
    p.setdefault("processed", [])
    p.setdefault("notes", [])
    lf = d / "library.json"
    if lf.exists() and not p.get("library"):
        p["library"] = json.loads(lf.read_text(encoding="utf-8"))
    return p


LOCK_TTL = 2 * 3600


def lock_info(d: Path):
    f = d / ".pes-lock"
    try:
        x = json.loads(f.read_text(encoding="utf-8"))
        x["age"] = time.time() - float(x.get("at", 0))
        x["live"] = x["age"] < LOCK_TTL
        return x
    except Exception:
        return None


def write_lock(d: Path, owner: str):
    x = lock_info(d)
    since = x["since"] if x and x["live"] and x.get("owner") == owner and x.get("since") else now()
    (d / ".pes-lock").write_text(json.dumps({"owner": owner, "at": time.time(), "since": since}), encoding="utf-8")


def check_lock(d: Path):
    me = os.environ.get("PES_OWNER", "")
    x = lock_info(d)
    if x and x["live"] and x.get("owner") != me:
        die(f"다른 세션이 이 프로젝트를 쓰고 있습니다 (세션 {str(x.get('owner'))[:8]}…, {x.get('since')}부터, "
            f"마지막 기록 {int(x['age'] // 60)}분 전). 그 세션을 닫았다면 `lock {d} --force`로 가져오세요.", 3)
    if me:
        write_lock(d, me)


def save(d: Path, p: dict):
    check_lock(d)
    q = dict(p)
    lib = q.pop("library", None)
    if lib:  # 참고자료(기존 조사)는 따로 — project.json 을 가볍게
        lf = d / "library.json"
        blob = json.dumps(lib, ensure_ascii=False, indent=1)
        if not lf.exists() or lf.read_text(encoding="utf-8") != blob:
            lf.write_text(blob, encoding="utf-8")
    # 프로세스마다 다른 임시 이름 — 동시에 저장해도 서로의 임시 파일을 덮거나 지우지 않는다 (옛 이름 project.json.tmp 흔적은 저장 뒤 치운다)
    tmp = d / f"project.json.tmp.{os.getpid()}"
    try:
        tmp.write_text(json.dumps(q, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(d / "project.json")
    finally:
        tmp.unlink(missing_ok=True)
    (d / "project.json.tmp").unlink(missing_ok=True)


def stage_arg(s):
    if s not in KEYS:
        die(f"단계 이름은 {', '.join(KEYS)} 중 하나")
    return s


def new_stage():
    return {"status": "pending", "round": 0, "settings": {}, "items": [], "review": None,
            "suggestions": [], "warnings": [], "changes": [], "history": [], "summary": "",
            "approved_at": None, "stale": False, "reports": []}


def blank_item(i, title, **kw):
    it = {"id": i, "title": title, "kind": "", "question": "", "status": "new", "request": "",
          "depth": 0, "updated_round": 0, "summary": "", "details": "", "sources": [], "stats": [],
          "shots": [], "confidence": "", "conflicts": [], "verify": None, "links": {}, "user_links": []}
    it.update(kw)
    return it


def now():
    return time.strftime("%Y-%m-%d %H:%M")


# ---------- init ----------
def cmd_init(args):
    if not args:
        die("사용: init <dir> --topic 주제 [--slug s] [--import 폴더]")
    d = pdir(args[0])
    opt = {}
    rest = args[1:]
    while rest:
        k = rest.pop(0)
        if k in ("--topic", "--slug", "--import") and rest:
            opt[k[2:]] = rest.pop(0)
        else:
            die(f"알 수 없는 인자: {k}")
    if (d / "project.json").exists():
        die(f"이미 프로젝트가 있습니다: {d}/project.json  (이어하기는 ask-prep {d} resume)", 2)
    if not opt.get("topic"):
        die("--topic 필요")
    d.mkdir(parents=True, exist_ok=True)
    for sub in ("feedback", "ask", "snapshots", "shots", "out"):
        (d / sub).mkdir(exist_ok=True)
    (d / "feedback.log").touch()
    p = {"pes": 1, "topic": opt["topic"], "slug": opt.get("slug") or d.name, "created": time.strftime("%Y-%m-%d"),
         "current": "plan", "settings": {}, "library": None, "processed": [], "complete": False,
         "executive_summary": "", "conclusion": "",
         "stages": {k: new_stage() for k in KEYS}}
    p["stages"]["plan"]["status"] = "asking"
    if opt.get("import"):
        p["library"] = import_library(d, pdir(opt["import"]))
    save(d, p)
    print(d / "project.json")
    if p["library"]:
        print(f"참고자료로 가져옴: 항목 {len(p['library']['items'])}개 (R{p['library']['round']}까지, {p['library']['source']})")


def library_dict(src: Path) -> dict:
    st_file = src / "state.json"
    if not st_file.exists():
        die(f"가져올 state.json 없음: {st_file}")
    st = json.loads(st_file.read_text(encoding="utf-8"))
    items = []
    for it in st.get("items", []):
        if it.get("status") == "removed":
            continue
        it = dict(it)
        it["shots"] = ["library/" + s if not s.startswith("library/") else s for s in it.get("shots") or []]
        items.append(it)
    return {"source": str(src), "imported": now(), "round": st.get("round"), "topic": st.get("topic"),
            "settings": st.get("settings", {}), "items": items,
            "suggestions": st.get("suggestions", []), "warnings": st.get("warnings", [])}


def copy_library_shots(d: Path, src: Path) -> None:
    shots_src = src / "shots"
    if shots_src.exists():
        dst = d / "library" / "shots"
        dst.parent.mkdir(exist_ok=True)
        if not dst.exists():
            shutil.copytree(shots_src, dst)


def import_library(d: Path, src: Path) -> dict:
    lib = library_dict(src)
    copy_library_shots(d, src)
    return lib


# ---------- 질문 폼 ----------
def cmd_ask_prep(args):
    d, which = pdir(args[0]), args[1]
    src = QB / f"{which}.json"
    if not src.exists():
        die(f"질문 은행 없음: {src}")
    (d / "ask").mkdir(exist_ok=True)
    spec = json.loads(src.read_text(encoding="utf-8"))
    out = d / "ask" / f"{spec.get('id', which)}.json"
    if not out.exists():
        out.write_text(json.dumps(spec, ensure_ascii=False, indent=1), encoding="utf-8")
    print(out)


def strip_private(o):
    if isinstance(o, dict):
        return {k: strip_private(v) for k, v in o.items() if not k.startswith("_")}
    if isinstance(o, list):
        return [strip_private(v) for v in o]
    return o


def cmd_ask(args):
    d, spec_path = pdir(args[0]), pdir(args[1])
    spec = strip_private(json.loads(spec_path.read_text(encoding="utf-8")))
    sid = re.sub(r"[^a-z0-9-]", "-", str(spec.get("id") or spec.get("stage") or "ask").lower()).strip("-") or "ask"
    p = load(d)
    if spec.get("stage") in KEYS and spec.get("kind") == "stage_start":
        st = p["stages"][spec["stage"]]
        if st["status"] == "pending":
            st["status"] = "asking"
            save(d, p)
    data = {"spec": spec, "topic": p.get("topic", ""), "built": now(),
            "stages": [{"key": k, "label": v, "status": p["stages"][k]["status"]} for k, v in STAGES]}
    out = d / f"ask-{sid}.html"
    out.write_text(fill(TPL / "ask.html", spec.get("title", "질문"), data), encoding="utf-8")
    print(out)


def fill(tpl: Path, title: str, data: dict) -> str:
    blob = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    return (tpl.read_text(encoding="utf-8")
            .replace("__TITLE__", htmlmod.escape(str(title)))
            .replace("<!--__QUESTIONS__-->", (TPL / "_questions.html").read_text(encoding="utf-8"))
            .replace("/*__DATA__*/null", blob))


# ---------- 라운드 ----------
def cmd_round_start(args):
    d, s = pdir(args[0]), stage_arg(args[1])
    p = load(d)
    st = p["stages"][s]
    if st["round"] > 0 and st.get("changes"):  # 끝난 라운드의 변경점을 이력에 한 줄로 남긴다 (본문은 snapshots/)
        labels = [str(c).split(":", 1)[0].strip() for c in st["changes"]]
        qa = next((q for q in reversed(st.get("qa") or []) if int(q.get("round") or 0) == st["round"]), None)
        st.setdefault("history", []).append(f"R{st['round']} ({now()}): " + " · ".join(labels)
                                             + (f" / 독립 검토 {qa.get('verdict')}" if qa else "")
                                             + f" — 상세 snapshots/{s}-R{st['round']}.json")
    st["round"] += 1
    st["status"] = "active"
    st["changes"] = []
    p["current"] = s
    save(d, p)
    print(f"{LABEL[s]} R{st['round']} 시작")


def norm_text(s):
    if not isinstance(s, str):
        return s
    s = htmlmod.unescape(s)
    return re.sub(r"<br\s*/?>", "\n", s)


# 상태·요청만 담은 제안(심화·수정·삭제·원문 확인·사용자 링크 지시)의 키 — 이것만 있으면 내용 병합이 아니다
MERGE_CONTROL_KEYS = {"id", "status", "request", "user_links"}


def merge_user_links(it, links):
    """user_links 목록 추가 규칙: url(파일 경로)이 같은 줄은 주어진 칸(status·memo·added)만 고치고, 새 url 은 뒤에 붙인다."""
    if not isinstance(links, list):
        return
    cur = it.get("user_links")
    if not isinstance(cur, list):  # 손으로 고친 파일의 null 등 — 빈 목록으로 본다
        cur = it["user_links"] = []
    for x in links:
        if not isinstance(x, dict) or not x.get("url"):
            continue
        old = next((u for u in cur if isinstance(u, dict) and u.get("url") == x["url"]), None)
        if old is None:
            cur.append({k: v for k, v in x.items() if v is not None} | ({} if x.get("status") else {"status": "todo"}))
        else:
            old.update({k: v for k, v in x.items() if v not in (None, "")})


def cmd_merge(args):
    d, s = pdir(args[0]), stage_arg(args[1])
    p = load(d)
    st = p["stages"][s]
    items = {it["id"]: it for it in st["items"]}
    n = 0
    for f in args[2:]:
        raw = json.loads(Path(f).read_text(encoding="utf-8"))
        for r in (raw if isinstance(raw, list) else [raw]):
            if not isinstance(r, dict):
                die(f"merge: 결과 항목은 JSON 객체여야 합니다: {f}", 2)
            if "user_links" in r and not isinstance(r["user_links"], list):
                die(f"merge: user_links 는 객체 목록이어야 합니다 (#{r.get('id')}): {f} — 아무것도 바꾸지 않았습니다", 2)
            iid = r.get("id")
            it = items.get(iid)
            if it is None and bool(set(r) & {"status", "request", "user_links"}) and set(r) <= MERGE_CONTROL_KEYS:
                die(f"merge: 없는 항목 #{iid} 에 상태·요청만 담은 제안입니다 — `show <dir> {s}`로 번호를 확인하세요. 아무것도 바꾸지 않았습니다", 2)
            if it is None:
                iid = iid if iid is not None else max([0] + list(items)) + 1
                it = blank_item(iid, r.get("title", f"항목 {iid}"))
                st["items"].append(it)
                items[iid] = it
            control_only = bool(set(r) & {"status", "request", "user_links"}) and set(r) <= MERGE_CONTROL_KEYS  # 상태·요청만 바꾸는 제안 (옛 직접 편집과 같게 depth 를 올리지 않는다)
            for k in ("title", "kind", "question", "summary", "details", "confidence", "verify", "order", "verdict", "path"):
                if k in r and r[k] not in (None, ""):
                    it[k] = norm_text(r[k])
            if "request" in r and r["request"] is not None:  # 있을 때만 덮어쓴다 — 빈 문자열이면 비운다
                it["request"] = norm_text(r["request"]) if r["request"] != "" else ""
            for k in ("reuse", "model"):  # 기획 topic 의 참고자료 재사용(library id)·조사 모델
                if k in r and r[k] not in (None, ""):
                    it[k] = r[k]
            merge_user_links(it, r.get("user_links"))
            if s == "write" or it.get("kind") == "section":
                # 원고의 각주 [^k] 는 sources 의 순서(k번째)를 가리킨다 — 중복 제거·누적하면 번호가 밀리므로 통째로 바꾼다
                if r.get("sources") is not None:
                    it["sources"] = list(r.get("sources") or [])
            else:
                seen = {x.get("url") for x in it["sources"] if x.get("url")}
                for x in r.get("sources") or []:
                    if x.get("url") and x["url"] in seen:
                        continue
                    seen.add(x.get("url"))
                    it["sources"].append(x)
            if "stats" in r:
                it["stats"] = [dict(x, name=x.get("name") or x.get("label", "")) for x in r["stats"] or []]
            for sh in r.get("shots") or []:
                if sh not in it["shots"]:
                    it["shots"].append(sh)
            for c in r.get("conflicts") or []:
                if c not in it["conflicts"]:
                    it["conflicts"].append(c)
            for k, v in (r.get("links") or {}).items():
                cur = it.setdefault("links", {}).setdefault(k, [])
                for x in v if isinstance(v, list) else [v]:
                    if x not in cur:
                        cur.append(x)
            for q in r.get("open_questions") or []:
                st["suggestions"].append(f"[#{iid}] {q}")
            if control_only:
                if r.get("status") not in (None, ""):
                    it["status"] = r["status"]
            else:
                it["status"] = r.get("status", "done")
                it["depth"] = it.get("depth", 0) + 1
                it["updated_round"] = st["round"]
            n += 1
    save(d, p)
    print(f"{LABEL[s]}: {n}건 병합")


# ---------- 렌더 ----------
def slim(st):
    items = []
    for it in st.get("items", []):
        items.append({k: it.get(k) for k in ("id", "title", "kind", "status", "request", "depth", "updated_round",
                                               "summary", "confidence", "conflicts", "verdict")}
                     | {"n_sources": len(it.get("sources") or []), "n_stats": len(it.get("stats") or []),
                        "details_len": len(it.get("details") or "")})
    return {"round": st.get("round"), "status": st.get("status"), "changes": st.get("changes", []),
            "items": items, "n_suggestions": len(st.get("suggestions") or []),
            "review": {"round": (st.get("review") or {}).get("round"),
                       "questions": [{"id": q.get("id")} for q in (st.get("review") or {}).get("questions", [])]}
            if st.get("review") else None}


def load_feedback(d: Path, processed):
    out = []
    fb = d / "feedback"
    for f in sorted(fb.glob("*.json")) if fb.exists() else []:
        try:
            x = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        t = str(x.get("time") or "")
        if re.fullmatch(r"\d{8}-\d{6}", t):
            t = f"{t[:4]}-{t[4:6]}-{t[6:8]} {t[9:11]}:{t[11:13]}"
        out.append({"stage": x.get("stage") or "", "round": x.get("round", 0), "kind": x.get("kind", "feedback"),
                    "time": t, "text": x.get("text", ""), "via": x.get("via", "html"), "file": f.name,
                    "processed": f.name in processed})
    return out


def _write_snapshot(path: Path, snap: dict) -> bool:
    """스냅샷 파일을 원자적으로 새로 만든다. 이미 있으면 False 를 돌려준다."""
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_BINARY", 0)
    try:
        fd = os.open(str(path), flags, 0o666)
    except FileExistsError:
        return False
    try:
        blob = json.dumps(snap, ensure_ascii=False).encode("utf-8")
        while blob:
            blob = blob[os.write(fd, blob):]
    except BaseException:
        os.close(fd)
        fd = None
        try:
            path.unlink()
        except OSError:
            pass
        raise
    finally:
        if fd is not None:
            os.close(fd)
    return True


def _snapshot_versions(base: Path):
    """(번호, 경로) — 기본 파일이 1번, 같은 라운드의 추가 판은 하위 폴더의 2.json, 3.json…"""
    out = [(1, base)] if base.exists() else []
    round_dir = base.with_suffix("")
    if round_dir.is_dir():
        for f in round_dir.glob("*.json"):
            if f.is_file() and f.stem.isdigit():
                out.append((int(f.stem), f))
    return sorted(out)


def _snapshot_state(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8")).get("state")
    except Exception:
        return None


def cmd_render(args):
    d = pdir(args[0])
    p = load(d)
    s = stage_arg(args[1]) if len(args) > 1 else p["current"]
    st = p["stages"][s]
    if st["round"] > 0:
        snap = {"stage": s, "round": st["round"], "time": now(), "state": st}
        snap_dir = d / "snapshots"
        snap_dir.mkdir(exist_ok=True)
        base = snap_dir / f"{s}-R{st['round']}.json"
        _write_snapshot(base, snap)
        versions = _snapshot_versions(base)
        # 같은 라운드에서 상태가 바뀌면 첫 스냅샷을 덮어쓰지 않고 하위 폴더에 새 판으로 남긴다.
        if _snapshot_state(versions[-1][1]) != st:
            round_dir = base.with_suffix("")
            round_dir.mkdir(exist_ok=True)
            k = versions[-1][0] + 1 if versions else 1
            while not _write_snapshot(round_dir / f"{k}.json", snap):
                k += 1
    print(build_index(d, p))


def build_index(d: Path, p: dict) -> Path:
    snap_dir = d / "snapshots"
    latest = {}
    if snap_dir.exists():
        candidates = [(f, 1) for f in snap_dir.glob("*-R*.json") if f.is_file()]
        for sub in snap_dir.iterdir():
            if sub.is_dir():
                for f in sub.glob("*.json"):
                    if f.is_file() and f.stem.isdigit():
                        candidates.append((f, int(f.stem)))
        for f, version in candidates:
            try:
                x = json.loads(f.read_text(encoding="utf-8"))
                entry = {"stage": x["stage"], "round": x["round"], "time": x.get("time"), "state": slim(x["state"])}
            except Exception:
                continue
            key = (entry["stage"], entry["round"])
            if key not in latest or version > latest[key][0]:
                latest[key] = (version, entry)
    snaps = [entry for _, entry in latest.values()]
    snaps.sort(key=lambda x: (KEYS.index(x["stage"]) if x["stage"] in KEYS else 9, x["round"]))
    asks = sorted(x.name for x in d.glob("ask-*.html"))
    outs = sorted(str(x.relative_to(d)) for x in (d / "out").glob("*") if x.is_file()) if (d / "out").exists() else []
    pv = dict(p)
    if p.get("library"):
        L = p["library"]
        pv["library"] = {k: v for k, v in L.items() if k != "items"} | {"items": [
            {"id": i["id"], "title": i["title"], "summary": (i.get("summary") or "")[:240], "confidence": i.get("confidence"),
             "sources": [{"method": x.get("method")} for x in i.get("sources") or []]} for i in L.get("items", [])]}
    data = {"project": pv, "stages": [{"key": k, "label": v} for k, v in STAGES], "snapshots": snaps,
            "feedback": load_feedback(d, set(p.get("processed", []))), "asks": asks, "outputs": outs, "built": now(), "qlabels": all_qlabels()}
    out = d / "index.html"
    out.write_text(fill(TPL / "dashboard.html", p.get("topic", "프로젝트") + " · PES", data), encoding="utf-8")
    if (d.parent / ".pes-hub").exists():
        try:
            build_hub(d.parent)
        except Exception:
            pass
    return out


# ---------- 승인·되돌리기 ----------
def cmd_approve(args):
    d, s = pdir(args[0]), stage_arg(args[1])
    p = load(d)
    st = p["stages"][s]
    st["status"] = "approved"
    st["approved_at"] = now()
    st["stale"] = False
    st["history"].append(f"승인 {now()} (R{st['round']})")
    k = KEYS.index(s)
    msg = [f"{LABEL[s]} 승인"]
    if s == "plan":
        msg.append(handoff_plan(p))
    if k + 1 < len(KEYS):
        nxt = KEYS[k + 1]
        p["current"] = nxt
        if p["stages"][nxt]["status"] in ("pending",):
            p["stages"][nxt]["status"] = "asking"
        msg.append(f"다음 단계: {LABEL[nxt]} (상태 {p['stages'][nxt]['status']})")
    else:
        p["complete"] = True
        msg.append("모든 단계 완료")
    msg.append(f"단계 보고서를 만드세요: report {d} {s}  (형식: {', '.join(report_formats(p))})")
    msg.append(f"대화에서 나온 결정·선호가 파일에 없으면 note 로 남기세요. 그 뒤 대화를 비워도(/clear) `/pes:run {d.name}`로 이어집니다.")
    save(d, p)
    build_index(d, p)
    print("\n".join(m for m in msg if m))


def handoff_plan(p) -> str:
    plan, res = p["stages"]["plan"], p["stages"]["research"]
    lib = {it["id"]: it for it in (p.get("library") or {}).get("items", [])}
    have = {x for it in res["items"] for x in it.get("links", {}).get("plan", [])}
    nid = max([0] + [it["id"] for it in res["items"]]) + 1
    made = reused = 0
    for t in plan["items"]:
        if t.get("kind") != "topic" or t.get("status") == "removed" or t["id"] in have:
            continue
        links = {"plan": [t["id"]] + [x for x in t.get("links", {}).get("plan", []) if x != t["id"]]}
        it = blank_item(nid, t["title"], kind="topic", question=t.get("question") or t.get("summary", ""), links=links)
        src = lib.get(t.get("reuse"))
        if src:
            for k in ("summary", "details", "sources", "stats", "shots", "confidence", "conflicts"):
                it[k] = src.get(k) if src.get(k) is not None else it[k]
            it["status"] = "deepen"
            it["request"] = (f"기존 조사(라이브러리 #{src['id']}) 재사용 — 기획의 조사 질문에 맞게 보완하고, "
                             f"원문 미확인 출처와 충돌(⚠)은 다시 확인")
            it["links"]["library"] = [src["id"]]
            reused += 1
        res["items"].append(it)
        nid += 1
        made += 1
    return f"조사 항목 {made}개 생성 (기존 조사 재사용 {reused}개)"


def cmd_reopen(args):
    d, s = pdir(args[0]), stage_arg(args[1])
    p = load(d)
    p["stages"][s]["status"] = "active"
    p["stages"][s]["stale"] = False
    p["stages"][s]["approved_at"] = None
    p["stages"][s]["review"] = None
    p["stages"][s]["history"].append(f"다시 열기 {now()}")
    p["current"] = s
    # 마지막 단계까지 승인한 프로젝트를 다시 열면 전체 완료 표시도 푼다 (승인 오처리 방지).
    p["complete"] = False
    marked = []
    for k in KEYS[KEYS.index(s) + 1:]:
        if p["stages"][k]["status"] != "pending":
            p["stages"][k]["stale"] = True
            marked.append(LABEL[k])
    save(d, p)
    build_index(d, p)
    print(f"{LABEL[s]} 다시 열림" + (f" · 다시 확인 필요 표시: {', '.join(marked)}" if marked else ""))


# ---------- 상태·답 ----------
def pending_files(d, p):
    done = set(p.get("processed", []))
    return [f for f in sorted((d / "feedback").glob("*.json")) if f.name not in done]


def cmd_status(args):
    d = pdir(args[0])
    p = load(d)
    show_status(d, p, [(f, json.loads(f.read_text(encoding="utf-8"))) for f in pending_files(d, p)])


def show_status(d, p, pend):
    """status 출력. pend = [(표시할 경로, 답 내용 dict)] — 옛 방식은 feedback 파일, DB 방식은 DB 의 처리 안 한 답."""
    print(f"주제: {p['topic']}  ({d})")
    print(f"현재 단계: {LABEL[p['current']]}" + ("  · 전체 완료" if p.get("complete") else ""))
    for k, v in STAGES:
        st = p["stages"][k]
        live = [i for i in st["items"] if i.get("status") != "removed"]
        todo = [i for i in live if i.get("status") in ("new", "deepen", "revise", "browser")]
        rv = st.get("review") or {}
        rvq = f" · 점검 질문 {len(rv.get('questions', []))}개(R{rv.get('round')})" if rv.get("questions") else ""
        print(f"  {'▶' if k == p['current'] else ' '} {v:<6} {st['status']:<8} R{st['round']} 항목 {len(live)} (할 일 {len(todo)}){rvq}"
              + ("  ⚠다시 확인 필요" if st.get("stale") else ""))
    if p.get("library"):
        print(f"참고자료: 기존 조사 {len(p['library']['items'])}개 항목 ({p['library']['source']})")
    if p.get("notes"):
        print(f"인계 메모 {len(p['notes'])}개 (최근 5):")
        for n in p["notes"][-5:]:
            print(f"  - [{n.get('time')}] {n.get('text')}")
    print(f"처리 안 한 답: {len(pend)}개")
    for f, x in pend:
        first = (x.get("text") or "").splitlines()[:1]
        print(f"  - {f}  [{x.get('stage','')}/{x.get('kind','')}/R{x.get('round',0)}] {first[0][:80] if first else ''}")
    url = server_url(d)
    print(f"대시보드: {url or '서버 꺼짐 — serve ' + d.name}")


def cmd_pending(args):
    d = pdir(args[0])
    for f in pending_files(d, load(d)):
        print(f)


def cmd_mark(args):
    d = pdir(args[0])
    p = load(d)
    for f in args[1:]:
        name = Path(f).name
        if name not in p["processed"]:
            p["processed"].append(name)
    save(d, p)
    print(f"처리 완료 표시 {len(args) - 1}개")


def cmd_chat(args):
    d, s, text = pdir(args[0]), stage_arg(args[1]), args[2]
    kind = args[3] if len(args) > 3 else "feedback"
    p = load(d)
    ts = time.strftime("%Y%m%d-%H%M%S")
    rnd = p["stages"][s]["round"]
    f = d / "feedback" / f"{s}-R{rnd}-{ts}.json"
    f.write_text(json.dumps({"stage": s, "round": rnd, "time": ts, "kind": kind, "text": text, "answers": {},
                             "via": "chat"}, ensure_ascii=False, indent=1), encoding="utf-8")
    p["processed"].append(f.name)
    save(d, p)
    print(f)


# ---------- 토큰 절약 보기 ----------
def first_line(t, n=160):
    t = re.sub(r"\s+", " ", str(t or "")).strip()
    return t[:n] + ("…" if len(t) > n else "")


def cmd_digest(args):
    d, s = pdir(args[0]), stage_arg(args[1])
    show_digest(load(d), s, args)


def show_digest(p, s, args):
    st = p["stages"][s]
    rnd = int(args[args.index("--round") + 1]) if "--round" in args else None
    items = [i for i in st["items"] if i.get("status") != "removed" and (rnd is None or i.get("updated_round") == rnd)]
    print(f"[{LABEL[s]} R{st['round']}] 항목 {len(items)}개 · 상태 {st['status']}")
    allsrc = 0
    for it in sorted(items, key=lambda i: i["id"]):
        src = it.get("sources") or []
        ok = sum(1 for x in src if x.get("method") in VERIFIED)
        allsrc += len(src)
        lk = " ".join(f"{a}:{','.join(map(str, b))}" for a, b in (it.get("links") or {}).items() if b)
        print(f"\n#{it['id']} {it['title']} [{it.get('kind')}/{it.get('status')}/R{it.get('updated_round')}] 신뢰도 {it.get('confidence') or '-'} · 출처 {len(src)}(원문 {ok}) · {lk}")
        if it.get("summary"):
            print("  요약: " + first_line(it["summary"], 300))
        for x in (it.get("stats") or [])[:12]:
            print(f"  수치: {x.get('name')} = {x.get('value')} {x.get('unit') or ''} ({x.get('period') or '-'}; {x.get('method') or '-'})")
        if len(it.get("stats") or []) > 12:
            print(f"  수치: … 외 {len(it['stats']) - 12}개")
        for c in it.get("conflicts") or []:
            print("  충돌: " + first_line(c if isinstance(c, str) else json.dumps(c, ensure_ascii=False), 200))
        if it.get("verdict"):
            print(f"  판정: {it['verdict']}")
        if it.get("request"):
            print("  요청: " + first_line(it["request"], 160))
        for u in it.get("user_links") or []:
            print(f"  사용자 링크[{u.get('status', 'todo')}]: {u.get('url')}" + (f" — {u['memo']}" if u.get("memo") else ""))
    if st.get("suggestions"):
        print(f"\n남은 질문·제안 {len(st['suggestions'])}개:")
        for x in st["suggestions"][-15:]:
            print("  - " + first_line(x if isinstance(x, str) else x.get("text"), 160))


def cmd_show(args):
    d, s = pdir(args[0]), stage_arg(args[1])
    show_items(load(d), s, args)


# show --fields 로 단계 자체의 값을 읽는 필드 (항목 필드와 이름이 겹치지 않는 것 — summary 는 항목 요약이다)
SHOW_STAGE_FIELDS = {"changes", "carry_over", "settings", "review"}


def show_items(p, s, args):
    rest = args[2:]
    fields = None
    if "--fields" in rest:
        k = rest.index("--fields")
        fields = rest[k + 1].split(",")
        rest = rest[:k] + rest[k + 2:]
    ids = {int(x) for x in rest if x.isdigit()}
    st = p["stages"][s]
    if fields and not ids and set(fields) <= SHOW_STAGE_FIELDS:
        # 단계 필드 보기 (set 이 통째로 바꾸므로, 덧붙이기 전에 지금 값을 읽는다)
        print(json.dumps({k: st.get(k) for k in fields}, ensure_ascii=False, indent=1))
        return
    if not ids and not fields:
        print(json.dumps({k: v for k, v in st.items() if k != "items"} | {"items": [f"#{i['id']} {i['title']} [{i.get('kind')}/{i.get('status')}]" for i in st["items"]]}, ensure_ascii=False, indent=1))
        return
    out = []
    for it in st["items"]:
        if ids and it["id"] not in ids:
            continue
        out.append({k: it.get(k) for k in (["id", "title"] + fields)} if fields else it)
    print(json.dumps(out, ensure_ascii=False, indent=1))


def cmd_note(args):
    d = pdir(args[0])
    p = load(d)
    p["notes"].append({"time": now(), "stage": p.get("current"), "text": " ".join(args[1:]).strip()})
    save(d, p)
    print(f"인계 메모 {len(p['notes'])}개")


# ---------- set: 허용 필드 화이트리스트 ----------
SET_STAGE_FIELDS = {"summary": "text", "changes": "str_list", "carry_over": "obj_list", "settings": "object", "review": "object"}
SET_PROJECT_FIELDS = {"executive_summary": "text", "conclusion": "text"}
SET_USAGE = ("사용법: set <dir> <단계> <필드> <파일|->  (필드: " + "·".join(SET_STAGE_FIELDS) + ")\n"
             "        set <dir> project <필드> <파일|->  (필드: " + "·".join(SET_PROJECT_FIELDS) + ")")


def set_parse_check(kind, field, raw):
    """값 파일의 내용을 필드 형식에 맞게 해석한다. 맞지 않으면 한국어 이유로 거부한다 (아무것도 쓰기 전에)."""
    if kind == "text":
        value = raw.replace("\r\n", "\n").rstrip()
        if not value:
            die(f"set: {field} 값이 비어 있습니다 — 텍스트를 담은 파일을 주세요", 2)
    else:
        def bad_const(name):
            raise ValueError(f"{name} 는 JSON 값이 아닙니다")

        def bad_float(text):
            x = float(text)
            if x in (float("inf"), float("-inf")):
                raise ValueError(f"{text} 는 너무 큰 수입니다")
            return x
        try:
            value = json.loads(raw, parse_constant=bad_const, parse_float=bad_float)
        except RecursionError:
            die(f"set: {field} 값이 너무 깊게 중첩돼 있습니다", 2)
        except ValueError as e:
            die(f"set: {field} 값이 올바른 JSON 이 아닙니다 ({e})", 2)
        shape = {"str_list": ("문자열 배열", lambda v: isinstance(v, list) and all(isinstance(x, str) for x in v)),
                 "obj_list": ("객체 배열", lambda v: isinstance(v, list) and all(isinstance(x, dict) for x in v)),
                 "object": ("JSON 객체", lambda v: isinstance(v, dict))}[kind]
        if not shape[1](value):
            die(f"set: {field} 값은 {shape[0]}이어야 합니다", 2)
    try:  # 저장 형식(UTF-8 JSON)으로 쓸 수 있는지 미리 본다: 짝 없는 서로게이트·너무 깊은 구조는 여기서 거부
        json.dumps(value, ensure_ascii=False, indent=1).encode("utf-8")
    except (UnicodeEncodeError, RecursionError, ValueError, OverflowError) as e:
        die(f"set: {field} 값을 UTF-8 JSON 으로 저장할 수 없습니다 (짝 없는 문자·너무 깊은 구조 등)", 2)
    return value


import contextlib


@contextlib.contextmanager
def short_write_lock(d: Path):
    """읽기-수정-쓰기를 한 번에 하나만 하게 하는 아주 짧은 잠금 (`set` 전용; 세션 잠금 .pes-lock 과 다르다). 끝나면 지운다."""
    lock = d / ".project.json.lock"
    deadline = time.time() + 30
    while True:
        try:
            fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.close(fd)
            break
        except FileExistsError:
            try:
                if time.time() - lock.stat().st_mtime > 60:  # 죽은 프로세스가 남긴 흔적
                    lock.unlink(missing_ok=True)
                    continue
            except OSError:
                pass
            if time.time() > deadline:
                die("set: 다른 set 이 아직 저장 중입니다 — 잠시 뒤 다시 하세요", 3)
            time.sleep(0.02)
    try:
        yield
    finally:
        lock.unlink(missing_ok=True)


def cmd_set(args):
    if len(args) != 4:
        die("set: 인자가 맞지 않습니다\n" + SET_USAGE, 2)
    d, target, field, src = pdir(args[0]), args[1], args[2], args[3]
    if target == "project":
        kinds = SET_PROJECT_FIELDS
    elif target in KEYS:
        kinds = SET_STAGE_FIELDS
    else:
        die(f"set: 대상은 단계 이름({', '.join(KEYS)}) 또는 project 여야 합니다: {target!r}\n" + SET_USAGE, 2)
    if field not in kinds:
        die(f"set: {target} 에서 쓸 수 있는 필드는 {', '.join(kinds)} 뿐입니다: {field!r}", 2)
    try:
        raw = (sys.stdin.buffer.read() if src == "-" else Path(src).read_bytes()).decode("utf-8-sig")  # Windows 도구가 붙인 BOM 은 값이 아니다
    except (OSError, UnicodeDecodeError) as e:
        die(f"set: 값을 읽지 못했습니다 ({src}): {e}", 2)
    value = set_parse_check(kinds[field], field, raw)
    if not (d / "project.json").exists():
        die(f"project.json 없음: {d}")
    with short_write_lock(d):
        try:
            p = load(d)
        except (ValueError, OSError, AttributeError, TypeError) as e:
            die(f"set: {d.name} 의 project.json 을 읽지 못했습니다 — 파일이 깨졌거나 JSON 이 아닙니다 ({type(e).__name__}). 아무것도 바꾸지 않았습니다", 2)
        (p if target == "project" else p["stages"][target])[field] = value
        if target == "plan" and field == "settings":
            # 기획 답은 프로젝트 설정에도 둔다 (옛 문서의 두 곳 쓰기) — 보고서 형식(stage_reports)·qa-brief 의 기획 답·승인 창이 읽는다
            p["settings"] = value
        save(d, p)
    print(f"{'프로젝트' if target == 'project' else LABEL[target]} {field} 저장")


# ---------- 단계 보고서 ----------
REPORT_NAME = {"plan": "기획보고서", "research": "조사보고서", "analyze": "분석·종합보고서",
               "write": "원고 검토본", "verify": "검증보고서", "publish": "산출 보고서"}
KIND_TXT = {"rq": "연구 질문", "chapter": "목차", "topic": "조사 항목", "issue": "쟁점", "table": "비교표",
            "insight": "시사점", "section": "원고", "claim": "주장", "output": "산출물", "schedule": "일정"}
FMT_TXT = {"md": "마크다운", "html": "웹 보고서", "eli5": "그림 설명(eli5)", "docx": "Word", "hwpx": "HWPX",
           "pdf": "PDF", "pptx": "발표자료", "json": "데이터"}


def report_formats(p):
    f = (p.get("settings") or {}).get("stage_reports")
    return f if isinstance(f, list) and f else ["md", "html", "eli5"]


def qlabels(stage):
    """질문 은행에서 id→라벨, (id,value)→선택지 라벨."""
    lab, opt = {}, {}
    try:
        qs = json.loads((QB / f"{stage}.json").read_text(encoding="utf-8")).get("questions", [])
    except Exception:
        qs = []
    stack = list(qs)
    while stack:
        q = stack.pop()
        if not isinstance(q, dict) or "id" not in q:
            continue
        lab.setdefault(q["id"], q.get("label", q["id"]))
        for o in q.get("options") or []:
            if isinstance(o, dict):
                opt[(q["id"], str(o.get("value")))] = o.get("label", o.get("value"))
    return lab, opt


EXTRA_LABELS = {"client_city": "발주처 도시", "client_city=ulsan": "울산", "seoul_station": "서울 역세권형 집계",
                "seoul_station=split": "유형 분리", "seoul_station=merge": "합산", "asof": "기준일", "official": "집계 근거",
                "official=self": "고시 원문 전수 대조", "official=foia": "정보공개청구 병행", "outside": "특·광역시 밖 사례",
                "outside=compare": "제언 장에서 인용만", "outside=full": "현황까지 포함"}


def all_qlabels():
    out = {}
    for k in KEYS:
        lab, opt = qlabels(k)
        m = dict(EXTRA_LABELS)
        m.update(lab)
        m.update({f"{a}={b}": c for (a, b), c in opt.items()})
        out[k] = m
    return out


def show_val(qid, v, opt):
    if isinstance(v, list):
        return ", ".join(show_val(qid, x, opt) for x in v)
    if isinstance(v, dict):
        return "; ".join(f"{k}: {show_val(qid, x, opt)}" for k, x in v.items())
    return str(opt.get((qid, str(v)), v))


def stage_md(d: Path, p: dict, s: str) -> str:
    st = p["stages"][s]
    items = [i for i in st["items"] if i.get("status") != "removed"]
    srcs, seen = [], set()
    for it in items:
        for x in it.get("sources") or []:
            k = x.get("url") or x.get("title")
            if k and k not in seen:
                seen.add(k)
                srcs.append(x)
    ok = sum(1 for x in srcs if x.get("method") in VERIFIED)
    sidx = {(x.get("url") or x.get("title")): k for k, x in enumerate(srcs, 1)}
    L = [f"# {p.get('topic', '')} — {REPORT_NAME[s]}", "",
         f"- 단계: {LABEL[s]} · 라운드 {st['round']}회 · 승인 {st.get('approved_at') or '미승인'}",
         f"- 항목 {len(items)}개 · 출처 {len(srcs)}개 (원문 확인 {ok}개)", f"- 작성 {now()} · PES", ""]
    L += ["## 1. 요약", "", (st.get("summary") or "(요약 없음 — stages.%s.summary 를 채우세요)" % s).strip(), ""]
    lab, opt = qlabels(s)
    sets = {k: v for k, v in (st.get("settings") or {}).items() if v not in (None, "", [], {})}
    if sets:
        L += ["## 2. 이 단계에서 정한 것 (시작 질문 답)", "", "| 질문 | 답 |", "|---|---|"]
        L += [f"| {lab.get(k, k)} | {show_val(k, v, opt).replace('|', '/')} |" for k, v in sets.items()]
        L.append("")
    L += ["## 3. 결과", ""]
    groups = {}
    for it in sorted(items, key=lambda i: (i.get("order", i["id"]), i["id"])):
        groups.setdefault(it.get("kind") or "", []).append(it)
    n = 0
    for k, lst in groups.items():
        n += 1
        L += [f"### 3.{n} {KIND_TXT.get(k, k or '항목')} ({len(lst)})", ""]
        for it in lst:
            L += [f"#### #{it['id']} {it['title']}", ""]
            if it.get("question"):
                L += [f"- 질문: {it['question']}"]
            meta = [x for x in [it.get("confidence") and f"신뢰도 {it['confidence']}",
                                it.get("verdict") and f"판정 {it['verdict']}",
                                it.get("updated_round") and f"R{it['updated_round']} 갱신"] if x]
            lk = "; ".join(f"{LABEL.get(a, a)} {', '.join('#' + str(x) for x in b)}" for a, b in (it.get("links") or {}).items() if b)
            if meta:
                L.append("- " + " · ".join(meta))
            if lk:
                L.append(f"- 연결: {lk}")
            refs = []
            for sx in it.get("sources") or []:
                k2 = sx.get("url") or sx.get("title")
                if k2 in sidx:
                    refs.append(f"[{sidx[k2]}{'' if sx.get('method') in VERIFIED else '·미확인'}]")
            if refs:
                L.append(f"- 근거 출처: {' '.join(refs)} (아래 「출처」 번호, 원문 확인 {sum(1 for r in refs if '미확인' not in r)}/{len(refs)})")
            elif it.get("kind") not in ("rq", "chapter", "schedule", "topic") or s != "plan":
                L.append("- 근거 출처: 없음 ⚠ — 이 항목의 내용은 출처로 뒷받침되지 않았다")
            L.append("")
            if it.get("summary"):
                L += [it["summary"].strip(), ""]
            if it.get("details") and it["details"].strip() != (it.get("summary") or "").strip():
                L += [it["details"].strip(), ""]
            if it.get("stats"):
                L += ["| 지표 | 값 | 기준 | 원표 |", "|---|---|---|---|"]
                for x in it["stats"]:
                    t = f"{x.get('orgId')}/{x.get('tblId')}" if x.get("tblId") else (x.get("method") or "")
                    L.append(f"| {x.get('name', '')} | {x.get('value', '')} {x.get('unit', '')} | {x.get('period', '')} | {t} |")
                L.append("")
            for c in it.get("conflicts") or []:
                L.append(f"- ⚠ 충돌: {c if isinstance(c, str) else json.dumps(c, ensure_ascii=False)}")
            if it.get("conflicts"):
                L.append("")
    fbs = [f for f in load_feedback(d, set(p.get("processed", []))) if f.get("stage") == s and f.get("kind") in ("review", "feedback", "approve")]
    if fbs or st.get("history"):
        L += ["## 4. 라운드 경과와 사용자 결정", ""]
        for h in st.get("history") or []:
            L.append(f"- {h}")
        for f in fbs:
            t = (f.get("text") or "").strip().replace("\n", " / ")
            if t:
                L.append(f"- R{f.get('round')} {f.get('kind')}: {t[:400]}")
        L.append("")
    if st.get("carry_over"):
        L += ["## 4-1. 남은 일 — 다음 단계로 넘김", "", "승인 때 끝내지 못한 할 일이다. 다음 단계 첫 라운드에서 먼저 처리한다.", ""]
        L += [f"- #{c.get('item')} {c.get('title', '')}: {c.get('request', '')}" for c in st["carry_over"]]
        L.append("")
    qas = st.get("qa") or []
    rlog = {int(r.get("round") or 0): r for r in st.get("review_log") or []}
    if qas or rlog:
        L += ["## 5. 검토 기록 (자체 점검 → 독립 QC/QA 검토)", ""]
        for q in sorted(qas, key=lambda q: int(q.get("round") or 0)):
            r = int(q.get("round") or 0)
            rv = rlog.get(r) or {}
            L += [f"### R{r}", ""]
            if rv.get("questions"):
                L.append(f"- 자체 점검: 질문 {len(rv['questions'])}개 — " + "; ".join(
                    f"[{(qq.get('gap') or {}).get('kind', '-')}] {qq.get('label')}" for qq in rv["questions"]))
            sc = q.get("spot_checks") or []
            L.append(f"- 독립 검토(pes:reviewer): 판정 **{q.get('verdict')}** — {q.get('summary', '')}")
            if sc:
                L.append(f"- 표본 대조: {sum(1 for c in sc if c.get('result') == 'match')}/{len(sc)} 일치")
            L.append("")
            fs = (q.get("qc") or []) + (q.get("qa") or [])
            if fs:
                L += ["| 구분 | 항목 | 심각도 | 지적 | 근거 | 조치 권고 |", "|---|---|---|---|---|---|"]
                cell = lambda v: str(v or "").replace("|", "/").replace("\n", " ")
                L += [f"| {cell(f.get('id'))} | #{cell(f.get('item'))} | {cell(f.get('severity'))} | {cell(f.get('finding'))} | {cell(f.get('evidence'))} | {cell(f.get('recommendation'))} |" for f in fs]
                L.append("")
            if sc:
                L += ["| 항목 | 대조한 주장 | 출처 | 결과 | 메모 |", "|---|---|---|---|---|"]
                cell = lambda v: str(v or "").replace("|", "/").replace("\n", " ")
                L += [f"| #{cell(c.get('item'))} | {cell(c.get('claim'))} | {cell(c.get('source'))} | {cell(c.get('result'))} | {cell(c.get('note'))} |" for c in sc]
                L.append("")
            if q.get("missed_by_self_review"):
                L += ["- 자체 점검이 놓친 것: " + "; ".join(map(str, q["missed_by_self_review"])), ""]
            if q.get("evidence_gaps"):
                L += ["- 근거가 부족한 문장: " + "; ".join(f"#{g.get('item')} {g.get('statement')} → {g.get('needed')}" for g in q["evidence_gaps"]), ""]
    if srcs:
        L += [f"## {6 if (qas or rlog) else 5}. 출처", ""]
        for k, x in enumerate(srcs, 1):
            mark = "확인됨" if x.get("method") in VERIFIED else "미확인"
            L.append(f"{k}. {x.get('title') or x.get('url')}" + (f" — {x['url']}" if x.get("url") else "")
                     + (f" ({x['date']})" if x.get("date") else "") + f" [{mark}]")
        L.append("")
    return "\n".join(L) + "\n"


def cmd_report(args):
    d, s = pdir(args[0]), stage_arg(args[1])
    p = load(d)
    st = p["stages"][s]
    rd = d / "reports" / s
    rd.mkdir(parents=True, exist_ok=True)
    fm = report_formats(p)
    txt = stage_md(d, p, s)
    (rd / "report.md").write_text(txt, encoding="utf-8")
    title = f"{p.get('topic', '')} — {REPORT_NAME[s]}"
    meta = {"title": title, "stage": s, "label": LABEL[s], "name": REPORT_NAME[s], "md": txt, "built": now(),
            "round": st["round"], "approved_at": st.get("approved_at")}
    (rd / "report.html").write_text(fill(TPL / "stage-report.html", title, meta), encoding="utf-8")
    notes = []
    ej = rd / "eli5.json"
    if ej.exists():
        e = json.loads(ej.read_text(encoding="utf-8"))
        e.setdefault("title", REPORT_NAME[s])
        e["stage_label"], e["topic"], e["name"] = LABEL[s], p.get("topic", ""), REPORT_NAME[s]
        (rd / "eli5.html").write_text(fill(TPL / "eli5.html", e["title"], e), encoding="utf-8")
    elif "eli5" in fm:
        notes.append(f"eli5: {ej} 를 써야 합니다 (스키마는 pes:core 「단계 보고서」) — 쓴 뒤 report 를 다시 실행")
    reg = []
    for f in sorted(rd.iterdir()):
        if f.is_file() and f.suffix.lower() in (".md", ".html", ".docx", ".hwpx", ".pdf", ".pptx") and not f.name.startswith("."):
            fmt = "eli5" if f.stem == "eli5" else f.suffix.lower()[1:]
            reg.append({"format": fmt, "label": FMT_TXT.get(fmt, fmt), "path": str(f.relative_to(d)),
                        "bytes": f.stat().st_size, "round": st["round"]})
    st["reports"] = reg
    st["reports_built"] = now()
    have = {r["format"] for r in reg}
    for x in fm:
        if x not in have and x != "eli5":
            notes.append(f"{x}: 아직 없음 — report.md 로 해당 스킬을 써서 {rd}/report.{x} 로 만든 뒤 report 를 다시 실행")
    save(d, p)
    build_index(d, p)
    print("\n".join([f"{REPORT_NAME[s]}: " + ", ".join(f"{r['label']} {r['path']}" for r in reg)] + notes))


# ---------- 조립 ----------
def cmd_assemble(args):
    d = pdir(args[0])
    p = load(d)
    items = [i for i in p["stages"]["write"]["items"] if i.get("status") != "removed"]
    items.sort(key=lambda i: (i.get("order", i["id"]), i["id"]))
    out, notes, key, srcs_out = [f"# {p['topic']}", ""], [], {}, []
    if p.get("executive_summary"):
        out += ["## 요약", "", p["executive_summary"], ""]
    for it in items:
        srcs = it.get("sources") or []

        def sub(m):
            k = int(m.group(1))
            if not 1 <= k <= len(srcs):
                return m.group(0)
            s = srcs[k - 1]
            ident = (s.get("url") or "", s.get("title") or "")  # 같은 주소라도 제목(조문·문서)이 다르면 다른 각주
            if ident not in key:
                key[ident] = len(key) + 1
                srcs_out.append({"n": key[ident], "title": s.get("title", ""), "url": s.get("url", ""), "date": s.get("date", ""),
                                 "method": s.get("method", ""), "verified": s.get("method") in VERIFIED_METHODS})
                notes.append(f"[^{key[ident]}]: {s.get('title', '')}" + (f", {s['url']}" if s.get("url") else "")
                             + (f" ({s['date']})" if s.get("date") else ""))
            return f"[^{key[ident]}]"
        bad = sorted({int(k) for k in re.findall(r"\[\^(\d+)\]", it.get("details") or "") if not 1 <= int(k) <= len(srcs)})
        if bad:
            print(f"경고: #{it['id']} 각주 번호 {bad} 가 이 장 출처({len(srcs)}개) 범위 밖 — 원고와 sources 순서를 확인", file=sys.stderr)
        body = re.sub(r"\[\^(\d+)\]", sub, it.get("details") or "")
        out += [body.strip(), ""]
    if p.get("conclusion"):
        out += ["## 결론", "", p["conclusion"], ""]
    if notes:
        out += [""] + notes
    (d / "out").mkdir(exist_ok=True)
    f = d / "out" / "report.md"
    f.write_text("\n".join(out) + "\n", encoding="utf-8")
    print(f"{f}  (장·절 {len(items)}개, 각주 {len(notes)}개)")
    (d / "out" / "sources.json").write_text(json.dumps(srcs_out, ensure_ascii=False, indent=1), encoding="utf-8")


VERIFIED_METHODS = VERIFIED  # 원문·원자료를 직접 확인한 방법 (대시보드와 같은 기준)


def cmd_web(args):
    """최종 웹 보고서: out/report.md(+sources.json, cover.json) → out/report.html"""
    d = pdir(args[0])
    p = load(d)
    od = d / "out"
    if not (od / "report.md").exists() or "--assemble" in args:
        cmd_assemble([str(d)])
    md = (od / "report.md").read_text(encoding="utf-8")
    if (od / "appendix.md").exists():  # 부록(통계 원표·계산 방법·확인 과제 등) — 본문 뒤, 각주·출처 목록 앞
        md = md.rstrip() + "\n\n" + (od / "appendix.md").read_text(encoding="utf-8")
    srcs = []
    if (od / "sources.json").exists():
        srcs = json.loads((od / "sources.json").read_text(encoding="utf-8"))
    cover = {}
    if (od / "cover.json").exists():
        cover = json.loads((od / "cover.json").read_text(encoding="utf-8"))
    data = {"topic": p.get("topic", ""), "md": md, "sources": srcs, "cover": cover, "built": now(), "built_date": now()[:10]}
    f = od / "report.html"
    f.write_text(fill(TPL / "final-report.html", cover.get("title") or p.get("topic", "최종 보고서"), data), encoding="utf-8")
    ok = sum(1 for s in srcs if s.get("verified"))
    print(f"{f}  (출처 {len(srcs)}개 · 확인됨 {ok}개{'' if cover else ' · 표지 정보 없음: out/cover.json 을 쓰면 연구진·기관·발주처가 표지에 나온다'})")


# ---------- 독립 검토 (QC/QA) ----------
def cmd_qa_brief(args):
    """pes:reviewer 지시문을 rounds/<stage>-R<n>/qa-brief.md 로 쓴다 (digest·자체 점검 초안·기준 포함)."""
    d, s = pdir(args[0]), stage_arg(args[1])
    p = load(d)
    st = p["stages"][s]
    rnd = st["round"]
    rd = d / "rounds" / f"{s}-R{rnd}"
    rd.mkdir(parents=True, exist_ok=True)
    import io, contextlib
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        cmd_digest([str(d), s] + (["--round", str(rnd)] if s != "plan" else []))
    (rd / "digest.txt").write_text(buf.getvalue(), encoding="utf-8")
    (rd / "self-review.json").write_text(json.dumps(st.get("review") or {}, ensure_ascii=False, indent=1), encoding="utf-8")
    basis = [f"- 주제: {p.get('topic', '')}"]
    ps = p.get("settings") or {}
    if ps:
        basis.append("- 기획 답(사용자): " + ", ".join(f"{k}={v}" for k, v in ps.items() if k not in ("stage_reports",))[:1500])
    if st.get("settings"):
        basis.append(f"- {LABEL[s]} 시작 답(사용자): " + ", ".join(f"{k}={v}" for k, v in st["settings"].items())[:1500])
    rqs = [i for i in p["stages"]["plan"]["items"] if i.get("kind") == "rq" and i.get("status") != "removed"]
    if rqs:
        basis.append("- 연구 질문(기획): " + " / ".join(f"#{i['id']} {i['title']}" for i in rqs))
    for n in (p.get("notes") or [])[-5:]:
        basis.append(f"- 인계 메모: {n.get('text')}")
    pes = Path(__file__).resolve()
    b = f"""[검토 대상] {p.get('topic', '')} — {LABEL[s]} 단계 R{rnd} 결과 (프로젝트 폴더 {d})
[단계 목적] {STAGE_GOAL.get(s, '')}
[읽을 것]
1. 요약: {rd / 'digest.txt'}
2. 항목 본문: python3 -I {pes} show {d} {s} <id...> --fields summary,details,sources,stats,conflicts,links
3. 메인의 자체 점검 초안(마지막에): {rd / 'self-review.json'}
[기준 — 사용자가 정한 것]
""" + "\n".join(basis) + f"""
[이번 라운드 변경점(메인)]
""" + "\n".join(f"- {c}" for c in st.get("changes") or []) + f"""
[결과 파일] {rd / 'qa.json'}
pes:reviewer 형식대로 QC·QA·표본 대조(3~5개)를 하고 결과 파일에 쓴 뒤 한 줄만 돌려준다. project.json 은 고치지 않는다.
"""
    f = rd / "qa-brief.md"
    f.write_text(b, encoding="utf-8")
    print(f)


STAGE_GOAL = {"plan": "연구 질문·목차·조사 항목·일정이 주제와 사용자 답에 맞고 서로 연결되어 있는가",
              "research": "기획의 조사 질문에 출처 있는 사실로 답했는가 (원문 확인·수치 정합·충돌 표시)",
              "analyze": "조사 사실에서 쟁점·표·시사점을 근거 연결과 함께 끌어냈는가",
              "write": "원고의 모든 주장·수치가 분석·조사 근거와 각주로 이어지는가, 목차·분량·문체",
              "verify": "핵심 주장 검증이 충분하고 판정이 원문에 근거하는가",
              "publish": "산출물이 승인된 원고와 같고 형식·부록·근거 표기가 빠짐없는가"}


def cmd_qa(args):
    """독립 검토 결과(qa.json)를 stages.<s>.qa 에 기록하고, 그때의 자체 점검도 review_log 에 남긴다."""
    d, s = pdir(args[0]), stage_arg(args[1])
    p = load(d)
    st = p["stages"][s]
    rnd = st["round"]
    f = Path(args[args.index("--file") + 1]) if "--file" in args else d / "rounds" / f"{s}-R{rnd}" / "qa.json"
    if not f.exists():
        die(f"검토 결과 없음: {f} — qa-brief 로 지시문을 만들고 pes:reviewer 를 먼저 돌리세요")
    q = json.loads(f.read_text(encoding="utf-8"))
    q["round"] = int(q.get("round") or rnd)
    q["recorded"] = now()
    st["qa"] = [x for x in st.get("qa") or [] if int(x.get("round") or 0) != q["round"]] + [q]
    if st.get("review"):
        st["review_log"] = [x for x in st.get("review_log") or [] if int(x.get("round") or 0) != q["round"]] + [dict(st["review"], round=q["round"])]
    save(d, p)
    fs = (q.get("qc") or []) + (q.get("qa") or [])
    hi = [x for x in fs if x.get("severity") == "high"]
    sc = q.get("spot_checks") or []
    print(f"{LABEL[s]} R{q['round']} 독립 검토: {q.get('verdict')} · QC {len(q.get('qc') or [])} · QA {len(q.get('qa') or [])} · high {len(hi)}"
          f" · 표본 일치 {sum(1 for x in sc if x.get('result') == 'match')}/{len(sc)} · 자체 점검이 놓친 것 {len(q.get('missed_by_self_review') or [])}")
    for x in hi:
        print(f"  [{x.get('id')}] #{x.get('item')} {x.get('finding')}")


def cmd_remote(args):
    """다른 기기에서 연 화면(Tailscale serve 등)도 답을 보낼 수 있게 허용할 주소 관리 — ~/.pes/config.json trusted_origins."""
    args = [a for a in args if a != "--"]
    cfg = {}
    try:
        cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    except Exception:
        pass
    cur = list(cfg.get("trusted_origins") or [])
    if not args or args[0] == "list":
        print("답을 보낼 수 있는 다른 주소: " + (", ".join(cur) if cur else "없음 (이 컴퓨터의 127.0.0.1·localhost 만)"))
        return
    op, vals = args[0], [v.rstrip("/") for v in args[1:]]
    for v in vals:
        if not re.fullmatch(r"https?://[A-Za-z0-9.-]+(:\d+)?", v):
            die(f"주소 형식이 아닙니다: {v} (예: https://m5.example.ts.net)")
    if op == "add":
        cur += [v for v in vals if v not in cur]
    elif op in ("remove", "rm"):
        cur = [v for v in cur if v not in vals]
    elif op == "clear":
        cur = []
    else:
        die("사용: remote [list|add <주소>|remove <주소>|clear]")
    cfg["trusted_origins"] = cur
    CONFIG.parent.mkdir(parents=True, exist_ok=True)
    CONFIG.write_text(json.dumps(cfg, ensure_ascii=False, indent=1), encoding="utf-8")
    print("답을 보낼 수 있는 다른 주소: " + (", ".join(cur) if cur else "없음"))


# ---------- 서버 ----------
def spawn(cmd, log):
    kw = dict(stdout=log, stderr=log, stdin=subprocess.DEVNULL)
    if os.name == "nt":
        kw["creationflags"] = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    else:
        kw["start_new_session"] = True
    return subprocess.Popen(cmd, **kw)


def kill_pid(pid):
    import signal
    try:
        os.kill(int(pid), signal.SIGTERM)
        return True
    except Exception:
        return False


def whoami_info(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/whoami", timeout=1) as r:
            return json.loads(r.read())
    except Exception:
        return None


def whoami(port):
    return (whoami_info(port) or {}).get("root")


def port_busy(port):
    import socket
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) == 0


# 서버는 PES 홈마다 하나(포트 하나, 기본 8760). 프로젝트는 그 아래 /<slug>/ 로 열린다.
# 예전 버전의 프로젝트별 서버(8765~8775)는 보이면 끈다.
LEGACY_PORTS = range(8765, 8776)


def serve_root(d: Path) -> Path:
    """d 를 서빙할 서버의 루트: 프로젝트면 그 부모(홈), 아니면 d 자신."""
    return d.parent if (d / "project.json").exists() or is_db_served(d) else d


def root_port(root: Path):
    """root 를 서빙하는 (포트 하나 방식) 서버의 포트."""
    for pt in HUB_PORTS:
        i = whoami_info(pt) or {}
        if i.get("root") == str(root) and i.get("single"):
            return pt
    return None


def server_url(d: Path):
    """켜져 있으면 d(프로젝트 또는 홈)의 주소, 꺼져 있으면 None."""
    root = serve_root(d)
    port = root_port(root)
    if not port:
        return None
    return f"http://127.0.0.1:{port}/" + ("" if d == root else f"{d.name}/")


def server_port(d):
    return root_port(serve_root(d))


def ensure_server(root: Path) -> int:
    root.mkdir(parents=True, exist_ok=True)
    port = root_port(root)
    if port:
        return port
    if any(whoami(pt) == str(root) for pt in HUB_PORTS):  # 예전 버전의 목록 전용 서버
        stop_server(root, old=True)
    port = next((pt for pt in HUB_PORTS if whoami(pt) is None and not port_busy(pt)), None)
    if not port:
        die(f"{HUB_PORTS.start}~{HUB_PORTS.stop - 1} 포트가 모두 사용 중 — 다른 PES 홈의 서버나 다른 프로그램을 끄세요")
    log = open(root / ".pes-hub.out", "a", encoding="utf-8")
    pr = spawn([sys.executable, "-I", str(ROOT / "scripts" / "serve.py"), str(root), str(port)], log)
    (root / ".pes-hub-server").write_text(json.dumps({"pid": pr.pid, "port": port}), encoding="utf-8")
    for _ in range(30):
        if whoami(port) == str(root):
            break
        time.sleep(0.1)
    return port


def stop_legacy(d: Path):
    """예전 프로젝트별 서버(8765~)를 끄고 기록 파일을 지운다."""
    f = d / ".pes-server"
    try:
        kill_pid(json.loads(f.read_text(encoding="utf-8")).get("pid"))
    except Exception:
        pass
    for name in (".pes-server", ".pes-port"):
        (d / name).unlink(missing_ok=True)
    for pt in LEGACY_PORTS:
        if whoami(pt) == str(d):
            if os.name != "nt":
                subprocess.run(["pkill", "-f", f"serve.py {d} "], check=False)
            break


def cmd_serve(args):
    d = pdir(args[0])
    p = load(d)
    stop_legacy(d)
    if not (d / "index.html").exists():
        build_index(d, p)
    root = serve_root(d)
    if (root / ".pes-hub").exists() or not (root / "index.html").exists():
        build_hub(root)
    ensure_server(root)
    print(server_url(d))


def cmd_stop(args):
    args = [a for a in args if a != "--"]
    d = pdir(args[0]) if args else pes_home()
    root = serve_root(d)
    stop_legacy(d) if (d / "project.json").exists() else None
    stop_server(root, old=True)
    print(f"서버 종료 ({root} — 이 홈의 모든 프로젝트 화면이 함께 꺼집니다)")


def stop_server(root: Path, old=False):
    """홈 서버를 pid 파일로 끄고, 그래도 떠 있으면 프로세스 이름으로 찾는다. old=True 면 예전 목록 전용 서버."""
    alive = (lambda: any(whoami(pt) == str(root) for pt in HUB_PORTS)) if old else (lambda: bool(root_port(root)))
    f = root / ".pes-hub-server"
    try:
        kill_pid(json.loads(f.read_text(encoding="utf-8")).get("pid"))
    except Exception:
        pass
    f.unlink(missing_ok=True)
    for _ in range(20):
        if not alive():
            return True
        time.sleep(0.1)
    if os.name != "nt":
        subprocess.run(["pkill", "-f", f"serve.py {root} "], check=False)
    return not alive()


SHELL_SAFE = re.compile(r"[\w@%+=:,./~-]+")


def shell_quote(text: str) -> str:
    """셸 한 단어로: 공백·따옴표·괄호 같은 문자가 없으면 그대로, 있으면 작은따옴표로 감싼다."""
    return text if SHELL_SAFE.fullmatch(text) else "'" + text.replace("'", "'\\''") + "'"


def cmd_watch(args):
    d = pdir(args[0])
    print(f"tail -n0 -F {shell_quote(f'{d}/feedback.log')} | grep --line-buffered FEEDBACK")


# ---------- 여러 프로젝트 ----------
HUB_PORTS = range(8760, 8765)


def projects_root(args):
    r = Path(args[0]).expanduser().resolve() if args and not args[0].startswith("--") else pes_home()
    if (r / "project.json").exists():
        r = r.parent
    return r


def brief(d: Path) -> dict:
    p = load(d)
    pend = pending_files(d, p)
    lk = lock_info(d)
    times = [f.stat().st_mtime for f in [d / "project.json", *(d / "feedback").glob("*.json")] if f.exists()] if (d / "feedback").exists() else [(d / "project.json").stat().st_mtime]
    outs = ", ".join(f.name for f in sorted((d / "out").glob("*")) if f.is_file()) if (d / "out").exists() else "-"
    return brief_of(d, p, len(pend), {"owner": str(lk.get("owner"))[:8], "since": lk.get("since")} if lk and lk["live"] else None,
                    time.strftime("%Y-%m-%d %H:%M", time.localtime(max(times))), outs)


def brief_of(d: Path, p: dict, npend: int, lock, updated: str, outs: str) -> dict:
    cur = p.get("current", "plan")
    x = p["stages"][cur]
    L = LABEL[cur]
    if p.get("complete"):
        who, todo = "done", "완료 — 최종 결과물: " + outs
    elif npend:
        who, todo = "ai", f"받은 답 {npend}개 처리 대기"
    elif x["status"] == "asking":
        who, todo = "you", f"{L} 시작 질문에 답하기"
    elif x["status"] == "active" and x.get("review") and int(x["review"].get("round") or 0) == x["round"]:
        who, todo = "you", f"{L} R{x['round']} 결과 확인 · 점검 질문 {len(x['review'].get('questions', []))}개에 답하기"
    elif x["status"] == "active":
        who, todo = "ai", f"{L} R{x['round'] or 1} 작업 중"
    else:
        who, todo = "you", f"{L} 시작"
    return {"slug": d.name, "path": str(d), "topic": p.get("topic", d.name), "created": p.get("created", ""), "current": cur,
            "stages": [{"key": k, "label": v, "status": p["stages"][k]["status"], "round": p["stages"][k]["round"],
                        "stale": p["stages"][k].get("stale"), "reports": [r["format"] for r in p["stages"][k].get("reports", [])]}
                       for k, v in STAGES],
            "complete": bool(p.get("complete")), "who": who, "todo": todo, "pending": npend,
            "updated": updated, "lock": lock}


def all_briefs(root: Path):
    out = []
    db_here = db_core() and root.exists() and root.resolve() == pes_home()
    served = db_served_slugs() if db_here else set()
    for f in sorted(root.glob("*/project.json")):
        if f.parent.name in served:
            continue  # 이 프로젝트는 DB 에서 읽는다 (폴더에 옛 project.json 이 남아 있어도 한 번만)
        try:
            out.append(brief(f.parent))
        except SystemExit:
            continue
        except Exception as e:
            out.append({"slug": f.parent.name, "topic": f.parent.name, "error": str(e)[:200], "stages": [], "who": "err", "todo": "읽기 실패"})
    for slug in sorted(served):
        data = bridge_soft("read_project", slug)
        if data is None:
            out.append({"slug": slug, "topic": slug, "error": "DB 읽기 실패", "stages": [], "who": "err", "todo": "읽기 실패"})
            continue
        out.append(brief_of(root / slug, data["project"], len(data["pending"]), data.get("lock"), data.get("updated", ""), "-"))
    rank = {"you": 0, "ai": 1, "err": 2, "done": 3}
    out.sort(key=lambda b: b.get("updated", ""), reverse=True)
    out.sort(key=lambda b: rank.get(b.get("who"), 9))
    return out


def cmd_list(args):
    root = projects_root(args)
    bs = all_briefs(root)
    if not bs:
        print(f"프로젝트 없음: {root}")
        return
    W = {"you": "내 차례", "ai": "Claude", "done": "완료", "err": "오류"}
    url = server_url(root)
    for k, b in enumerate(bs, 1):
        cur = next((x for x in b["stages"] if x["key"] == b.get("current")), None)
        print(f"{k}. [{W.get(b['who'], b['who'])}] {b['topic']}  ({b['slug']})")
        print(f"   {cur['label'] + ' R' + str(cur['round']) if cur else '-'} · {b['todo']} · 갱신 {b.get('updated', '')}"
              f" · {(url + b['slug'] + '/') if url else '서버 꺼짐'}" + (f" · 사용 중 세션 {b['lock']['owner']}" if b.get("lock") else ""))


def build_hub(root: Path) -> Path:
    bs = all_briefs(root)
    data = {"projects": bs, "root": str(root), "built": now(), "stages": [{"key": k, "label": v} for k, v in STAGES]}
    out = root / "index.html"
    out.write_text(fill(TPL / "hub.html", "PES 프로젝트", data), encoding="utf-8")
    (root / ".pes-hub").write_text("1", encoding="utf-8")
    return out


def cmd_hub(args):
    root = projects_root(args)
    root.mkdir(parents=True, exist_ok=True)
    for d in (f.parent for f in root.glob("*/project.json")):
        if (d / ".pes-server").exists() or (d / ".pes-port").exists():
            stop_legacy(d)
    build_hub(root)
    ensure_server(root)
    print(server_url(root))


def cmd_open(args):
    import webbrowser
    a = args[0]
    if not a.startswith("http"):
        d = pdir(a)
        a = server_url(d) or (d / "index.html").as_uri()
    webbrowser.open(a)
    print(a)


def cmd_home(args):
    args = [a for a in args if a != "--"]
    cur = pes_home()
    if not args or args[0].startswith("--"):
        src = "PES_HOME 환경변수" if os.environ.get("PES_HOME") else ("설정 파일 " + str(CONFIG) if CONFIG.exists() else "기본값")
        n = len(list(cur.glob("*/project.json"))) if cur.exists() else 0
        print(f"PES 홈: {cur}  ({src}) · 프로젝트 {n}개")
        return
    new = Path(args[0]).expanduser().resolve()
    old = Path(args[args.index("--from") + 1]).expanduser().resolve() if "--from" in args else cur
    force = "--force" in args
    if new == old:
        print(f"이미 PES 홈입니다: {new}")
        return
    if new.is_relative_to(old) or old.is_relative_to(new):
        die("새 폴더와 옛 폴더가 서로 안에 들어 있으면 옮길 수 없습니다")
    projects = sorted(f.parent for f in old.glob("*/project.json")) if old.exists() else []
    clash = [d.name for d in projects if (new / d.name).exists()]
    if clash:
        die(f"새 폴더에 같은 이름이 이미 있습니다: {', '.join(clash)} — 아무것도 옮기지 않았습니다")
    me = os.environ.get("PES_OWNER", "")
    busy = [d.name for d in projects if (lambda x: x and x["live"] and x.get("owner") != me)(lock_info(d))]
    if busy and not force:
        die(f"다른 Claude 세션이 쓰는 프로젝트가 있습니다: {', '.join(busy)} — 그 세션을 닫고 다시 하거나 --force", 3)
    # 1) 서버 끄기 (켜져 있던 것만 기억)
    hub_on = any(whoami(pt) == str(old) for pt in HUB_PORTS)
    for d in projects:
        stop_legacy(d)
    if old.exists():
        stop_server(old, old=True)
    # 2) 옮기기
    new.mkdir(parents=True, exist_ok=True)
    moved = []
    for d in projects:
        shutil.move(str(d), str(new / d.name))
        moved.append(d.name)
        lg = new / d.name / "feedback.log"
        if lg.exists():
            lg.write_text(lg.read_text(encoding="utf-8").replace(str(d), str(new / d.name)), encoding="utf-8")
        for junk in (".pes-port", ".pes-server"):
            (new / d.name / junk).unlink(missing_ok=True)
    for junk in ("index.html", ".pes-hub", ".pes-hub.out", ".pes-hub-server"):
        (old / junk).unlink(missing_ok=True) if old.exists() else None
    if old.exists():
        for junk in (".DS_Store", "Thumbs.db", "desktop.ini"):
            (old / junk).unlink(missing_ok=True)
        if not any(old.iterdir()):
            old.rmdir()
    # 3) 설정 저장
    CONFIG.parent.mkdir(parents=True, exist_ok=True)
    cfg = {}
    try:
        cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    except Exception:
        pass
    cfg["home"] = str(new)
    CONFIG.write_text(json.dumps(cfg, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"PES 홈 변경: {old} → {new}  (프로젝트 {len(moved)}개 이동{': ' + ', '.join(moved) if moved else ''})")
    if os.environ.get("PES_HOME") and Path(os.environ["PES_HOME"]).expanduser().resolve() != new:
        print("주의: PES_HOME 환경변수가 설정 파일보다 우선합니다 — 환경변수도 바꾸거나 지우세요")
    # 4) 다시 켜기
    for d in projects:
        build_index(new / d.name, load(new / d.name))
    if hub_on:
        cmd_hub([str(new)])
    print("Monitor 가 옛 경로의 feedback.log 를 보고 있었다면 새 경로로 다시 거세요.")


# ---------- 진단 ----------
def find_tool(name):
    p = shutil.which(name)
    if p:
        return p
    H = Path.home()
    cands = [H / ".local" / "bin" / name]
    if sys.platform == "darwin":
        cands += [Path("/opt/homebrew/bin") / name, Path("/usr/local/bin") / name]
        if name == "vworld":
            cands += [H / ".claude" / "skills" / "vworld" / "app" / "vworld-macos"]
    if os.name == "nt":
        la = Path(os.environ.get("LOCALAPPDATA", H / "AppData" / "Local"))
        ap = Path(os.environ.get("APPDATA", H / "AppData" / "Roaming"))
        cands += [la / "Programs" / name / f"{name}.exe", la / name / f"{name}.exe", H / ".local" / "bin" / f"{name}.exe",
                  ap / "npm" / f"{name}.cmd", la / "Programs" / "ego lite" / f"{name}.exe"]
        if name == "vworld":
            cands += [H / ".claude" / "skills" / "vworld" / "app" / "vworld-windows.exe"]
    for c in cands:
        if c.exists():
            return str(c)
    return None


def cmd_which(args):
    t = find_tool(args[0])
    if not t:
        die(f"{args[0]} 를 찾지 못함 — /pes:doctor 로 설치 상태 확인", 1)
    print(t)


def run_quiet(cmd, timeout=15):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, encoding="utf-8", errors="replace")
        return r.returncode, (r.stdout or "") + (r.stderr or "")
    except Exception as e:
        return -1, str(e)


def doctor_env(R):
    v = sys.version_info
    R.add("환경", "ok" if v >= (3, 9) else "bad", f"Python {v.major}.{v.minor}.{v.micro}", "" if v >= (3, 9) else "3.9 이상 필요")
    R.add("환경", "ok", f"PES 플러그인 {ROOT}", "")
    miss = [t for t in ("dashboard.html", "ask.html", "_questions.html", "hub.html", "stage-report.html", "eli5.html", "final-report.html") if not (TPL / t).exists()]
    R.add("환경", "bad" if miss else "ok", "템플릿", "없음: " + ", ".join(miss) if miss else "")
    h = pes_home()
    src = "PES_HOME 환경변수" if os.environ.get("PES_HOME") else ("설정 파일" if CONFIG.exists() else "기본값")
    if not h.exists():
        R.add("환경", "warn", f"PES 홈 {h} ({src})", "폴더가 아직 없음 — 첫 /pes:start 때 생김", fix=lambda: h.mkdir(parents=True, exist_ok=True))
    else:
        ok = os.access(h, os.W_OK)
        R.add("환경", "ok" if ok else "bad", f"PES 홈 {h} ({src})", "" if ok else "쓰기 권한 없음")
        cloud = next((c for c in ("OneDrive", "CloudStorage", "iCloud", "Mobile Documents", "Dropbox", "Google Drive") if c.lower() in str(h).lower()), None)
        if cloud:
            R.add("환경", "info", f"PES 홈이 클라우드 동기화 폴더({cloud}) 안에 있음",
                  "한 번에 한 컴퓨터에서만 작업, 폴더는 '항상 이 장치에 유지', 다른 컴퓨터로 옮기기 전 동기화 완료 확인 (README 「OneDrive」)")
    try:
        cfg = json.loads(CONFIG.read_text(encoding="utf-8")) if CONFIG.exists() else {}
        if os.environ.get("PES_HOME") and cfg.get("home") and Path(cfg["home"]).expanduser().resolve() != h:
            R.add("환경", "warn", "PES_HOME 환경변수와 설정 파일이 다름", f"환경변수가 우선: {h} (설정 파일: {cfg['home']})")
    except Exception as e:
        R.add("환경", "bad", "설정 파일 읽기 실패", f"{CONFIG}: {e}")
    if not os.environ.get("PES_OWNER"):
        R.add("환경", "warn", "PES_OWNER 없음", "Claude 세션 표시가 없어 잠금이 동작하지 않음 (pes:core 「여러 프로젝트」)")
    # 도구
    t = find_tool("ego-browser")
    if t:
        _, out = run_quiet([t, "--version"])
        R.add("도구", "ok", f"ego-browser {out.split()[1] if len(out.split()) > 1 else ''}".strip(), "" if shutil.which("ego-browser") else f"PATH 밖: {t}")
        try:
            import importlib
            sys.path.insert(0, str(Path(__file__).resolve().parent))
            st_, why, _, _ = importlib.import_module("setup").ego_skill()
            R.add("도구", {"ok": "ok", "missing": "warn"}.get(st_, "info"), "ego-browser 스킬", why)
        except Exception as e:
            R.add("도구", "info", "ego-browser 스킬 확인 못함", str(e)[:100])
    else:
        R.add("도구", "warn", "ego-browser 없음", "브라우저 조사 불가 — ego-browser 스킬의 설치 안내")
    t = find_tool("kosis")
    if t:
        _, out = run_quiet([t, "config", "key-list"])
        n = len(re.findall(r"^\s*\[\d+\]", out, re.M))
        R.add("도구", "ok" if n or os.environ.get("KOSIS_API_KEY") else "warn", f"kosis (API 키 {n}개)", ("" if shutil.which("kosis") else f"PATH 밖: {t}") if n else "키 없음 — https://kosis.kr/openapi/")
    else:
        R.add("도구", "warn", "kosis 없음", "통계 API 불가 — npm install -g @clazic/kosis")
    try:
        import importlib
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        _su = importlib.import_module("setup")
        for nm in ("kosis", "vworld"):
            sv = _su.skill_version(nm)
            if find_tool(nm) and not sv:
                R.add("도구", "warn", f"{nm} 스킬 없음", "CLI 만 있음 — /pes:setup 이 스킬을 설치")
            elif sv:
                _, vo = run_quiet([find_tool(nm), "--version"]) if find_tool(nm) else (0, "")
                cv = re.search(r"v?(\d+\.\d+\.\d+)", vo)
                if cv and sv not in ("?", "v" + cv.group(1)):
                    R.add("도구", "warn", f"{nm} 스킬 {sv} ≠ CLI v{cv.group(1)}", "/pes:setup 으로 맞추기")
                else:
                    R.add("도구", "ok", f"{nm} 스킬 {sv}" + (" (CLI 와 같음)" if cv else ""), "")
    except Exception as e:
        R.add("도구", "info", "스킬 버전 확인 못함", str(e)[:100])
    t = find_tool("korean-law")
    if t:
        oc = os.environ.get("LAW_OC")
        try:
            cs = json.loads((Path.home() / ".claude" / "settings.json").read_text(encoding="utf-8")).get("env", {}).get("LAW_OC")
        except Exception:
            cs = None
        if oc:
            R.add("도구", "ok", "korean-law (LAW_OC 있음)", "")
        elif cs:
            R.add("도구", "info", "korean-law (LAW_OC: Claude Code 설정에 등록됨)", "새 Claude Code 세션부터 적용 — 지금 세션은 다시 시작해야 함")
        else:
            R.add("도구", "warn", "korean-law", "LAW_OC 없음 — ~/.claude/settings.json 의 env 에 LAW_OC 를 등록 (Windows 포함 모든 세션에 적용)")
    else:
        R.add("도구", "warn", "korean-law 없음", "법령 조회 불가")
    t = find_tool("vworld")
    if t:
        _, out = run_quiet([t, "config", "list-keys"])
        n = out.count('"masked"')
        R.add("도구", "ok" if n else "warn", f"vworld (키 {n}개)", ("" if shutil.which("vworld") else f"PATH 밖: {t}") if n else "키 없음")
    else:
        R.add("도구", "info", "vworld 없음", "공간정보가 필요할 때만 (조사 시작 질문에서 설치 여부를 묻는다)")
    ca = os.environ.get("NODE_EXTRA_CA_CERTS")
    if ca and not Path(ca).expanduser().exists():
        R.add("도구", "bad", "NODE_EXTRA_CA_CERTS 파일 없음", ca)
    if NET:
        t = find_tool("korean-law")
        if t:
            _, out = run_quiet([t, "search_law", "--query", "민법"], 40)
            ok = "검색 결과" in out
            R.add("연결", "ok" if ok else "bad", "법령 API (law.go.kr)", "" if ok else (
                "인증서 오류 — 회사·기관 망이면 NODE_EXTRA_CA_CERTS 에 루트 인증서 파일을 등록 (~/.claude/settings.json env)"
                if "CERT" in out else out.strip().splitlines()[-1][:160] if out.strip() else "응답 없음"))
        t = find_tool("kosis")
        if t:
            code, out = run_quiet([t, "s", "인구", "-n", "1"], 40)
            R.add("연결", "ok" if code == 0 else "bad", "통계 API (kosis.kr)", "" if code == 0 else (out.strip().splitlines() or ["응답 없음"])[-1][:160])
    for tool in ("tail", "grep"):
        if not shutil.which(tool):
            R.add("도구", "bad", f"{tool} 없음", "답 자동 수신(Monitor)에 필요 — Windows는 Git Bash")
    # 서버 (홈마다 포트 하나)
    owners = listening_owners(set(HUB_PORTS)) if db_core() else {}  # 소켓에 접속하기 전에 먼저 소유자를 알아 둔다
    hubs = [(pt, whoami(pt)) for pt in HUB_PORTS]
    for pt, root in hubs:
        if root and not Path(root).exists():
            R.add("서버", "warn", f":{pt} 고아 서버", f"폴더가 없는 서버가 떠 있음: {root} — 필요 없으면 끄세요")
        elif root and Path(root).resolve() != h:
            R.add("서버", "info", f":{pt} 다른 폴더를 서빙 중", root)
        elif root and not (whoami_info(pt) or {}).get("single"):
            R.add("서버", "warn", f":{pt} 예전 방식 목록 서버", "프로젝트 화면이 안 열림 — /pes:list 로 다시 켜면 바뀜")
    legacy = [(pt, r) for pt, r in ((pt, whoami(pt)) for pt in LEGACY_PORTS) if r]
    if legacy:
        R.add("서버", "warn", f"예전 방식 프로젝트별 서버 {len(legacy)}개", ", ".join(f":{pt}" for pt, _ in legacy) + " — 이제 포트 하나로 충분",
              fix=lambda: [stop_legacy(Path(r)) for _, r in legacy])
    if db_core():
        for pt, root in hubs:
            if root is None and port_busy(pt):
                R.add("서버", "warn", f":{pt} 다른 프로그램이 사용 중", port_owner_text(owners.get(pt)))
    on = root_port(h)
    if not on and not any(whoami(pt) is None and not port_busy(pt) for pt in HUB_PORTS):
        R.add("서버", "bad", f"포트 {HUB_PORTS.start}~{HUB_PORTS.stop - 1} 모두 사용 중", "다른 프로그램이 쓰고 있음")
    R.add("서버", "ok" if on else "info", f"PES 서버 {'http://127.0.0.1:%d/ (목록과 모든 프로젝트)' % on if on else '꺼짐'}", "" if on else "/pes:list 로 켜기")


RISKY_PATH = re.compile(r"[\s'\"`()$&;|<>*?\[\]{}!#^]")


def listening_owners(ports):
    """{포트: [(pid, 이름)]} — 그 포트를 LISTEN 중인 프로세스. 한 번만 묻고, 소켓에 접속하지 않는다.
    (접속하면 점유한 쪽 프로그램이 놀라 죽을 수 있다 — 소유자를 먼저 알아낸 뒤에 whoami 로 확인한다.)
    macOS lsof(없으면 netstat -anv) · Linux ss · Windows netstat -ano. 도구가 없거나 못 알아내면 그 포트는 목록에 없다."""
    lo, hi = min(ports), max(ports)
    found = {}
    try:
        if sys.platform == "darwin":
            if shutil.which("lsof"):
                _, out = run_quiet(["lsof", "-nP", f"-iTCP:{lo}-{hi}", "-sTCP:LISTEN", "-Fpcn"], 20)
                pid = name = None
                for line in out.splitlines():
                    if line.startswith("p") and line[1:].isdigit():
                        pid, name = line[1:], ""
                    elif line.startswith("c") and pid:
                        name = line[1:]
                    elif line.startswith("n") and pid:
                        m = re.search(r":(\d+)$", line)
                        if m and int(m.group(1)) in ports and (pid, name) not in found.setdefault(int(m.group(1)), []):
                            found[int(m.group(1))].append((pid, name))
            if not found and shutil.which("netstat"):
                _, out = run_quiet(["netstat", "-anv", "-p", "tcp"], 20)
                for m in re.finditer(r"^tcp\S*\s+\d+\s+\d+\s+\S+\.(\d+)\s+\S+\s+LISTEN\s.*?\s(\S+):(\d+)\s", out, re.M):
                    if int(m.group(1)) in ports:
                        found.setdefault(int(m.group(1)), []).append((m.group(3), m.group(2)))
        elif os.name == "nt":
            if shutil.which("netstat"):
                _, out = run_quiet(["netstat", "-ano", "-p", "TCP"], 15)
                for m in re.finditer(r"^\s*TCP\s+\S+:(\d+)\s+(?:0\.0\.0\.0:0|\[::\]:0)\s+\S+\s+(\d+)", out, re.M):  # 상태 문구는 로캘마다 다르다: 외부 주소가 *:0 이면 LISTEN
                    if int(m.group(1)) in ports:
                        name = ""
                        if shutil.which("tasklist"):
                            _, t = run_quiet(["tasklist", "/FI", f"PID eq {m.group(2)}", "/FO", "CSV", "/NH"], 10)
                            tm = re.match(r'"([^"]+)"', t.strip())
                            name = tm.group(1) if tm else ""
                        found.setdefault(int(m.group(1)), []).append((m.group(2), name))
        elif shutil.which("ss"):
            _, out = run_quiet(["ss", "-ltnpH"], 10)
            for line in out.splitlines():
                m = re.search(r":(\d+)\s", line)
                if m and int(m.group(1)) in ports:
                    for um in re.finditer(r'\("([^"]+)",pid=(\d+)', line):
                        found.setdefault(int(m.group(1)), []).append((um.group(2), um.group(1)))
    except Exception:
        return {}
    return found


def port_owner_text(owners):
    if not owners:
        return "PES 가 아닌 프로그램이 쓰는 중 — 소유 프로세스 확인 불가 (lsof·ss·netstat 이 없거나 권한이 없음)"
    return "PES 가 아닌 프로그램이 쓰는 중 — 소유 프로세스 " + ", ".join(f"pid {pid}" + (f" ({name})" if name else "") for pid, name in owners)


# SQLite 3.53 소스 기준: os_unix.c UNIX_SHM_DMS 와 os_win.c WIN_SHM_DMS 는 같은 값 ((22+8)*4+8 = 128),
# RESERVED_BYTE = PENDING_BYTE(0x40000000)+1 도 두 플랫폼이 같다
SQLITE_SHM_DMS = 128  # -shm 의 DMS 잠금 바이트: 연결이 열려 있는 동안 그 연결이 공유 잠금을 쥔다
SQLITE_RESERVED_BYTE = 0x40000001  # DB 파일의 RESERVED 잠금 바이트: 쓰기 트랜잭션 중인 연결이 쥔다


def lock_held_elsewhere(path: Path, offset: int):
    """다른 프로세스가 path 의 offset 바이트에 SQLite 잠금을 쥐고 있으면 True, 아니면 False, 알 수 없으면 None.
    배타 잠금을 잠깐 시도하고 바로 푼다 — 파일 내용·mtime 은 바꾸지 않는다."""
    try:
        with open(path, "r+b") as fh:
            if os.name == "nt":
                import msvcrt
                fh.seek(offset)
                try:
                    msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
                except OSError:
                    return True
                fh.seek(offset)
                msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
                return False
            import fcntl
            try:
                fcntl.lockf(fh, fcntl.LOCK_EX | fcntl.LOCK_NB, 1, offset)
            except OSError:
                return True
            fcntl.lockf(fh, fcntl.LOCK_UN, 1, offset)
            return False
    except OSError:
        return None


def db_journal_residue():
    """DB 곁에 남은 -wal·-journal 중 연결을 여는 순간 SQLite 가 DB 에 반영(복구·checkpoint)할 것의 파일 이름들.
    기본 doctor 는 이때 DB 를 열지 않는다(원본 불변). 빈(0바이트) -wal 은 정상이라 세지 않는다. 다른 PES 가 지금 그 DB 를
    열고 있으면(-wal: -shm 의 DMS 잠금, -journal: DB 의 RESERVED 잠금) 실행 중인 정상 상태라 복구가 일어나지 않으므로 세지 않는다."""
    db_file = Path.home() / ".pes" / "pes.db"
    out = []
    for suffix in ("-wal", "-journal"):
        f = db_file.with_name(db_file.name + suffix)
        try:
            if not (f.is_file() and f.stat().st_size > 0):
                continue
        except OSError:
            continue
        if suffix == "-wal":
            shm = db_file.with_name(db_file.name + "-shm")
            live = lock_held_elsewhere(shm, SQLITE_SHM_DMS) if shm.is_file() else False
        else:
            live = lock_held_elsewhere(db_file, SQLITE_RESERVED_BYTE)
        if live is not True:
            out.append(f.name)
    return out


def doctor_db_residue(R, residue):
    db_file = Path.home() / ".pes" / "pes.db"
    R.add("데이터베이스", "warn", f"다른 PES 가 실행 중이거나 비정상 종료 흔적 {db_file}",
          f"{', '.join(residue)} 가 남아 있음 — 진단이 DB 를 열면 SQLite 가 이를 DB 에 반영하므로 기본 진단은 DB 를 열지 않았습니다(프로젝트 진단도 건너뜀). "
          f"다른 PES(서버·명령)를 끈 뒤 doctor 를 다시 실행하고, 그래도 남으면 doctor --fix(또는 pes 명령 한 번)로 정상 복구하세요")


def doctor_path_risk(R, h: Path):
    if RISKY_PATH.search(str(h)):
        R.add("환경", "warn", "PES 홈 경로에 공백·따옴표·괄호 같은 특수 문자가 있음 (명령 quoting 위험)",
              f"{h} — watch 는 경로를 스스로 따옴표로 묶지만, 이 경로를 셸 명령에 직접 붙이는 다른 곳(Monitor 명령·스크립트)에는 따옴표가 필요합니다. 공백·따옴표 없는 폴더로 `home` 명령으로 옮기는 편이 안전합니다")


def doctor_db(R, h: Path):
    """2단계 DB 진단: 데이터베이스 상태(읽기만 — 스스로 고치지 않는다)와 PES 홈 경로의 명령 quoting 위험."""
    db_file = Path.home() / ".pes" / "pes.db"
    st = bridge_soft("db_status")
    if st is None:
        R.add("데이터베이스", "bad", f"데이터베이스를 점검하지 못함 {db_file}", "코어(node)를 실행하지 못했습니다 — Node 26 이상이 필요합니다")
    elif st.get("state") == "missing":
        R.add("데이터베이스", "info", f"데이터베이스 아직 없음 {db_file}", "첫 init 이나 이전 때 만들어집니다")
    elif st.get("state") == "broken":
        R.add("데이터베이스", "bad", f"데이터베이스를 열 수 없음 {db_file}", f"{st.get('message', '')} — doctor 는 DB 를 고치지 않습니다. 백업에서 복원하거나 파일을 옮겨 두고 다시 시작하세요")
    elif not st.get("schema_current"):
        R.add("데이터베이스", "warn", f"데이터베이스 스키마가 최신이 아님 {db_file}", "새 코어 버전으로 DB 를 올려야 합니다")
    else:
        R.add("데이터베이스", "ok", f"데이터베이스 {db_file}", f"프로젝트 {st.get('projects', 0)}개 · 스키마 최신")
    doctor_path_risk(R, h)


def doctor_project_db(R, d: Path):
    tag = d.name
    data = bridge_soft("read_project", tag)
    if data is None:
        R.add(tag, "bad", "DB 에서 프로젝트를 읽지 못함", "")
        return
    p, pend = data["project"], data["pending"]
    R.add(tag, "ok", f"{p.get('topic', '')}", f"현재 {LABEL.get(p.get('current'), p.get('current'))} · DB")
    cur = p.get("current")
    if cur in KEYS:
        ci = KEYS.index(cur)
        for k in KEYS[:ci]:
            if p["stages"][k]["status"] != "approved":
                R.add(tag, "warn", f"{LABEL[k]}이(가) 승인되지 않았는데 뒤 단계가 현재", f"{LABEL[k]}: {p['stages'][k]['status']}")
    for k in KEYS:
        st = p["stages"][k]
        if st["status"] == "approved" and not st.get("reports"):
            R.add(tag, "warn", f"{LABEL[k]} 승인됐는데 단계 보고서 없음", f"report {tag} {k}")
    if pend:
        R.add(tag, "warn", f"처리 안 한 답 {len(pend)}개", f"/pes:run {tag}")
    lk = data.get("lock")
    if lk and lk.get("owner") != os.environ.get("PES_OWNER"):
        R.add(tag, "info", "다른 세션이 사용 중", f"{str(lk.get('owner'))[:8]}… · {lk.get('since')}부터")
    url = server_url(d)
    R.add(tag, "ok" if url else "info", f"대시보드 {url or '서버 꺼짐'}", "" if url else f"/pes:status {tag}")


def doctor_project(R, d: Path):
    tag = d.name
    try:
        raw = json.loads((d / "project.json").read_text(encoding="utf-8"))
    except Exception as e:
        R.add(tag, "bad", "project.json 읽기 실패", str(e)[:200])
        return
    p = load(d)
    R.add(tag, "ok", f"{p.get('topic', '')}", f"현재 {LABEL.get(p.get('current'), p.get('current'))}")
    dup = [x.name for x in d.glob("*.json") if x.name not in ("project.json", "library.json")
           and re.match(r"(project|library)[ _-].+\.json$|(project|library) \(\d+\)\.json$", x.name)]
    if dup:
        R.add(tag, "bad", "클라우드 동기화 충돌 사본", ", ".join(dup) + " — 두 컴퓨터에서 동시에 고친 흔적. 어느 쪽이 최신인지 확인 후 사본을 정리 (README 「OneDrive」)")
    stale_tmp = sorted(d.glob("project.json.tmp*"))
    if stale_tmp:
        R.add(tag, "warn", "저장 중 끊긴 임시 파일", ", ".join(x.name for x in stale_tmp),
              fix=lambda: [x.unlink(missing_ok=True) for x in stale_tmp])
    # 단계 일관성
    cur = p.get("current")
    if cur not in KEYS:
        R.add(tag, "bad", "현재 단계 값이 잘못됨", str(cur))
    else:
        ci = KEYS.index(cur)
        for k in KEYS[:ci]:
            if p["stages"][k]["status"] != "approved":
                R.add(tag, "warn", f"{LABEL[k]}이(가) 승인되지 않았는데 뒤 단계가 현재", f"{LABEL[k]}: {p['stages'][k]['status']}")
        for k in KEYS[ci + 1:]:
            if p["stages"][k]["status"] in ("active", "approved") and not p["stages"][k].get("stale"):
                R.add(tag, "warn", f"{LABEL[k]}이(가) 현재 단계보다 앞서 있음", p["stages"][k]["status"])
    for k in KEYS:
        st = p["stages"][k]
        ids = [i["id"] for i in st["items"]]
        dup = sorted({i for i in ids if ids.count(i) > 1})
        if dup:
            R.add(tag, "bad", f"{LABEL[k]} 항목 번호 중복", ", ".join(map(str, dup)))
        rv = st.get("review")
        if rv and st["status"] == "active" and int(rv.get("round") or 0) != st["round"]:
            R.add(tag, "info", f"{LABEL[k]} AI 점검이 지난 라운드 것", f"점검 R{rv.get('round')} · 현재 R{st['round']} — 대시보드에 표시 안 됨")
        snaps = {int(f.stem.split("-R")[1]) for f in (d / "snapshots").glob(f"{k}-R*.json")} if (d / "snapshots").exists() else set()
        lost = [r for r in range(1, st["round"] + 1) if r not in snaps]
        if lost:
            R.add(tag, "info", f"{LABEL[k]} 라운드 기록 없음", "R" + ", R".join(map(str, lost)) + " — 진행 표에서 빠짐")
        if st["status"] == "approved":
            reps = st.get("reports") or []
            if not reps:
                R.add(tag, "warn", f"{LABEL[k]} 승인됐는데 단계 보고서 없음", f"report {d.name} {k}")
            else:
                gone = [r["path"] for r in reps if not (d / r["path"]).exists()]
                if gone:
                    R.add(tag, "warn", f"{LABEL[k]} 보고서 파일 없음", ", ".join(gone), fix=lambda k=k: cmd_report([str(d), k]))
                want = set(report_formats(p)) - {r["format"] for r in reps}
                if want:
                    R.add(tag, "info", f"{LABEL[k]} 보고서 형식 빠짐", ", ".join(sorted(want)))
    # 연결
    allids = {k: {i["id"] for i in p["stages"][k]["items"]} for k in KEYS}
    broken = []
    for k in KEYS:
        for it in p["stages"][k]["items"]:
            for lk, xs in (it.get("links") or {}).items():
                if lk in allids:
                    broken += [f"{LABEL[k]} #{it['id']} → {LABEL[lk]} #{x}" for x in xs if x not in allids[lk]]
    if broken:
        R.add(tag, "warn", f"끊긴 연결 {len(broken)}개", "; ".join(broken[:5]) + (" …" if len(broken) > 5 else ""))
    # 답
    bad_fb = []
    for f in sorted((d / "feedback").glob("*.json")) if (d / "feedback").exists() else []:
        try:
            json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            bad_fb.append(f.name)
    if bad_fb:
        R.add(tag, "bad", "읽을 수 없는 답 파일", ", ".join(bad_fb))
    pend = pending_files(d, p)
    if pend:
        R.add(tag, "warn", f"처리 안 한 답 {len(pend)}개", f"/pes:run {d.name}")
    # 잠금·서버
    lk = lock_info(d)
    if lk and not lk["live"]:
        R.add(tag, "info", "만료된 잠금 파일", f"{lk.get('since')} 세션", fix=lambda: (d / ".pes-lock").unlink(missing_ok=True))
    elif lk and lk.get("owner") != os.environ.get("PES_OWNER"):
        R.add(tag, "info", "다른 Claude 세션이 사용 중", f"{str(lk.get('owner'))[:8]}… · {lk.get('since')}부터 · {int(lk['age'] // 60)}분 전 기록")
    url = server_url(d)
    for name in (".pes-port", ".pes-server"):
        fp = d / name
        if fp.exists():
            R.add(tag, "info", f"예전 방식 서버 기록 파일 {name}", "", fix=lambda: stop_legacy(d))
    idx = d / "index.html"
    if not idx.exists() or idx.stat().st_mtime + 1 < (d / "project.json").stat().st_mtime:
        R.add(tag, "info", "대시보드가 최신 상태보다 오래됨", "", fix=lambda: build_index(d, load(d)))
    R.add(tag, "ok" if url else "info", f"대시보드 {url or '서버 꺼짐'}", "" if url else f"/pes:status {d.name}")


class DocReport:
    def __init__(self):
        self.rows = []
        self.no_fix = False  # True 동안 더하는 행은 진단만 하고 --fix 대상에서 뺀다
        self.ro = False  # True 동안 더하는 행은 고칠 수 있다고 알리되 --fix 로는 고치지 않는다 (이전 전 프로젝트)

    def add(self, group, level, title, detail="", fix=None):
        if self.no_fix:
            fix = None
        self.rows.append({"group": group, "level": level, "title": title, "detail": detail, "fix": fix, "ro": self.ro and fix is not None})


NET = False


def cmd_doctor(args):
    global NET, SOFT_DB
    NET = "--net" in args
    SOFT_DB = True
    fix = "--fix" in args
    as_json = "--json" in args
    tgt = [a for a in args if not a.startswith("--")]
    R = DocReport()
    doctor_env(R)
    h = pes_home()
    # 기본 진단(--fix 아님)은 원본을 바꾸지 않는다: DB 곁에 남은 -wal·-journal 은 연결을 여는 순간 DB 에 반영되므로 DB 를 열지 않는다
    residue = db_journal_residue() if db_core() and not fix else []
    if residue:
        doctor_db_residue(R, residue)
        if not tgt:
            doctor_path_risk(R, h)
    elif db_core() and not tgt:
        doctor_db(R, h)  # DB 상태는 홈 전체 진단에서만 (프로젝트 하나를 지정하면 그 프로젝트만)
    served = db_served_slugs() if db_core() and not residue else set()
    if residue:
        dirs = []  # 어느 프로젝트가 DB 프로젝트인지 DB 를 열지 않고는 모른다
    elif tgt:
        dirs = [pdir(tgt[0])]
    else:
        names = {f.parent.name for f in h.glob("*/project.json")} | served if h.exists() else set(served)
        dirs = [h / n for n in sorted(names)]
    for d in dirs:
        if d.parent == h and d.name in served:
            doctor_project_db(R, d)
            continue
        if not (d / "project.json").exists():
            R.add(d.name, "bad", "project.json 없음", str(d))
            continue
        outside = db_core() and (d.is_symlink() or not d.resolve().is_relative_to(h.resolve()))
        if outside:
            R.add(d.name, "info", "PES 홈 밖을 가리키는 폴더(심볼릭 링크)", f"{d} — 진단만 하고 --fix 로 고치지 않습니다 (임시 파일·잠금·서버 기록을 지우지 않음)")
        R.no_fix = bool(outside)
        R.ro = db_core() and not outside  # 이 줄에 닿은 폴더는 DB 가 서비스하는 프로젝트가 아니다: 진단만 하고 쓰지 않는다
        try:
            doctor_project(R, d)
        finally:
            R.no_fix = False
            R.ro = False
    if not tgt and h.exists() and not residue:
        stray = [x.name for x in h.iterdir() if x.is_dir() and not (x / "project.json").exists() and not x.name.startswith(".") and x.name not in served]
        if stray:
            R.add("환경", "info", "PES 홈에 프로젝트가 아닌 폴더", ", ".join(stray))
    fixed = []
    if fix:
        for r in R.rows:
            if r["fix"] and r.get("ro"):
                r["skipped"] = "이전 전 프로젝트라 고치지 않음 — 먼저 이전하세요"
            elif r["fix"]:
                try:
                    r["fix"]()
                    r["fixed"] = True
                    fixed.append(f"{r['group']}: {r['title']}")
                except Exception as e:
                    r["detail"] += f" (고치기 실패: {e})"
        if (h / ".pes-hub").exists():
            try:
                build_hub(h)
            except Exception:
                pass
    if as_json:
        # --json 은 legacy 읽기가 v0.15 와 같은 출력이어야 해서 이전 전 프로젝트(ro) 행도 v0.15 처럼 fixable 로 둔다 (본문·요약만 구분)
        print(json.dumps([{k: v for k, v in r.items() if k not in ("fix", "ro")} | {"fixable": bool(r["fix"])} for r in R.rows], ensure_ascii=False, indent=1))
        if db_core() and any(r["level"] == "bad" for r in R.rows):
            sys.exit(1)  # DB 경로: 문제가 있으면 --json 도 종료 1
        return
    MARK = {"ok": "[정상]", "info": "[참고]", "warn": "[주의]", "bad": "[문제]"}
    last = None
    for r in R.rows:
        if r["group"] != last:
            print(f"\n■ {r['group']}")
            last = r["group"]
        tail = " → 고침" if r.get("fixed") else (f" ({r['skipped']})" if r.get("skipped") else (
            " (이전 후 --fix 로 고칠 수 있음)" if r["fix"] and r.get("ro") else (" (--fix 로 고칠 수 있음)" if r["fix"] else "")))
        print(f"  {MARK[r['level']]} {r['title']}" + (f" — {r['detail']}" if r["detail"] else "") + tail)
    cnt = {k: sum(1 for r in R.rows if r["level"] == k) for k in MARK}
    nfix = sum(1 for r in R.rows if r["fix"] and not r.get("fixed") and not r.get("ro"))  # 이전 전 프로젝트의 행은 --fix 가 건너뛰므로 세지 않는다
    nlater = sum(1 for r in R.rows if r["fix"] and r.get("ro"))
    print(f"\n요약: 문제 {cnt['bad']} · 주의 {cnt['warn']} · 참고 {cnt['info']} · 정상 {cnt['ok']}"
          + (f" · 고친 것 {len(fixed)}" if fix else (f" · --fix 로 고칠 수 있는 것 {nfix}" if nfix else ""))
          + (f" · 이전 후 고칠 수 있는 것 {nlater}" if nlater else ""))
    if cnt["bad"]:
        sys.exit(1)


def cmd_lock(args):
    d = pdir(args[0])
    load(d)
    me = os.environ.get("PES_OWNER", "")
    if not me:
        die("PES_OWNER 환경변수(이 세션 ID)가 필요합니다", 2)
    x = lock_info(d)
    if x and x["live"] and x.get("owner") != me and "--force" not in args:
        die(f"다른 세션이 사용 중: {str(x.get('owner'))[:8]}… ({x.get('since')}부터, 마지막 기록 {int(x['age'] // 60)}분 전). "
            f"그 세션이 끝났으면 --force", 3)
    write_lock(d, me)
    print(f"잠금: {d.name} (세션 {me[:8]}…)")


def cmd_unlock(args):
    d = pdir(args[0])
    x = lock_info(d)
    me = os.environ.get("PES_OWNER", "")
    if x and x["live"] and x.get("owner") != me and "--force" not in args:
        die("다른 세션의 잠금입니다 (--force 로 해제)", 3)
    (d / ".pes-lock").unlink(missing_ok=True)
    print("잠금 해제")


# ---------- DB 쓰기 경로 (PES_DB_CORE=1 일 때만) ----------
# 개발 플래그. 꺼져 있으면 위의 v0.15 동작(project.json·.pes-lock 직접 쓰기)이 그대로다.
# 켜져 있으면 쓰기 명령은 project.json 을 쓰지 않고, scripts/pes_core/cli_bridge.ts(Node)를 프로세스로 불러
# 코어 명령 서비스를 지난다. Python 은 TypeScript 를 import 하지 않고 JSON 한 쌍으로만 주고받는다.
# 자격: PES_TOKEN 없음 = 이 컴퓨터 DB 의 사람 소유자, PES_TOKEN=<에이전트 토큰> = 그 에이전트. PES_OWNER 는 잠금 표지일 뿐 자격이 아니다.
BRIDGE = Path(__file__).resolve().parent / "pes_core" / "cli_bridge.ts"
ASK_PURPOSES = {"stage_start", "review", "resume"}
NEW_QUESTION_TYPES = {"single", "multi", "text", "textarea", "number", "scale", "file"}
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


def db_core() -> bool:
    return os.environ.get("PES_DB_CORE") == "1"


def need_db_core(name):
    if not db_core():
        die(f"{name}: PES_DB_CORE=1 일 때만 쓸 수 있는 명령입니다 (개발 플래그 — 2단계 DB 경로)", 2)


def bridge_soft(op, slug=None, args=None):
    """bridge 와 같지만 실패해도 아무것도 출력하지 않고 None 을 돌려준다 (읽기 전용 점검용)."""
    import contextlib
    import io
    global _LAST_BRIDGE_ERROR
    buf = io.StringIO()
    try:
        with contextlib.redirect_stderr(buf):
            return bridge(op, slug, args)
    except SystemExit:
        _LAST_BRIDGE_ERROR = (buf.getvalue().strip().splitlines() or [""])[0][:120]
        return None


def bridge(op, slug=None, args=None):
    """cli_bridge.ts 를 한 번 실행한다. 실패하면 메시지를 내고 종료 코드(기본 1)로 끝낸다."""
    node = shutil.which("node")
    if node is None:
        die("node 를 찾을 수 없습니다 — Node 26 이상이 필요합니다", 1)
    req = {"op": op, "slug": slug, "session": os.environ.get("PES_OWNER") or None,
           "token": os.environ.get("PES_TOKEN") or None, "args": args or {}}
    try:
        proc = subprocess.run([node, "--no-warnings", str(BRIDGE)], input=json.dumps(req).encode("utf-8"),
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
    except (OSError, subprocess.SubprocessError) as e:
        die(f"코어를 실행하지 못했습니다: {e}", 1)
    try:
        res = json.loads(proc.stdout.decode("utf-8").strip().splitlines()[-1])
    except (IndexError, ValueError):
        die("코어가 올바른 답을 주지 않았습니다" + (": " + proc.stderr.decode("utf-8", "replace").strip()[-300:] if proc.stderr else ""), 1)
    if not isinstance(res, dict) or not isinstance(res.get("ok"), bool):
        die("코어가 올바른 답을 주지 않았습니다 (형식이 맞지 않음)", 1)
    if not res["ok"]:
        if res.get("code") == "internal_error" and proc.stderr:
            print(proc.stderr.decode("utf-8", "replace").strip()[:600], file=sys.stderr)
        try:
            code = int(res.get("exit") or 1)
        except (TypeError, ValueError):
            code = 1
        die(str(res.get("message") or "실패"), code)
    if not isinstance(res.get("data"), dict):
        die("코어가 올바른 답을 주지 않았습니다 (결과가 없음)", 1)
    return res["data"]


def read_json_file(path, what="입력 파일"):
    """JSON 파일을 읽는다. 없거나 깨졌으면 스택 추적 대신 한국어 오류 한 줄로 끝낸다."""
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        die(f"{what}이 없습니다: {path}", 2)
    except (OSError, UnicodeDecodeError) as e:
        die(f"{what}을 읽지 못했습니다: {path} ({e.__class__.__name__})", 2)
    except ValueError as e:
        die(f"{what}이 올바른 JSON이 아닙니다: {path} ({e})", 2)


def db_slugs():
    try:
        return set(bridge("slugs").get("slugs") or [])
    except SystemExit:
        return set()


def db_set(args):
    die("set: PES_DB_CORE=1 에서는 아직 쓸 수 없습니다 — 단계 요약·변경점·남은 일·설정·점검과 최종 요약·결론에 대응하는 DB 명령이 아직 없습니다 "
        "(DB 는 바뀌지 않았습니다). 플래그 없이(v0.15) 쓰거나 이후 PR 을 기다리세요", 2)


def db_name(arg) -> str:
    d = pdir(arg)
    if d.parent != pes_home():
        refuse_legacy_write("쓰기", d)
    return d.name


def db_init(args):
    if not args:
        die("사용: init <dir> --topic 주제 [--slug s] [--import 폴더]")
    d = pdir(args[0])
    opt = {}
    rest = args[1:]
    while rest:
        k = rest.pop(0)
        if k in ("--topic", "--slug", "--import") and rest:
            opt[k[2:]] = rest.pop(0)
        else:
            die(f"알 수 없는 인자: {k}")
    if (d / "project.json").exists():
        die(f"이미 프로젝트가 있습니다: {d}/project.json  (이어하기는 ask-prep {d} resume)", 2)
    if not opt.get("topic"):
        die("--topic 필요")
    slug = opt.get("slug") or d.name
    if not SLUG_RE.match(slug):
        die("프로젝트 이름은 소문자·숫자·하이픈(1~64자)만 쓸 수 있습니다", 2)
    if slug != d.name:
        # 이후 명령은 프로젝트를 폴더 이름으로 찾는다 — 이름이 다르면 만든 프로젝트를 다시 찾을 수 없다.
        die(f"--slug({slug})는 폴더 이름({d.name})과 같아야 합니다 — 폴더 이름으로 프로젝트를 찾습니다", 2)
    lib = None
    if opt.get("import"):
        lib = library_dict(pdir(opt["import"]))
    # DB 쪽 검사(중복 이름·참고자료 거부 사유)를 먼저 하고, 통과한 뒤에야 폴더와 참고자료 파일을 만든다.
    data = bridge("init", None, {"slug": slug, "topic": opt["topic"], "library": lib})
    d.mkdir(parents=True, exist_ok=True)
    if opt.get("import"):
        copy_library_shots(d, pdir(opt["import"]))
    for sub in ("feedback", "ask", "snapshots", "shots", "out"):
        (d / sub).mkdir(exist_ok=True)
    (d / "feedback.log").touch()
    print(d)
    if lib:
        print(f"참고자료로 가져옴: 항목 {len(lib['items'])}개 (R{lib['round']}까지, {lib['source']})")


def legacy_question(q: dict) -> dict:
    """옛 질문 은행 항목 -> question.publish_set 의 새 질문. 답은 채우지 않는다(추천 표시만 옵션에 남긴다)."""
    qt = q.get("type") if q.get("type") in NEW_QUESTION_TYPES else "text"
    opts = []
    for o in q.get("options") or []:
        if isinstance(o, dict) and o.get("value") not in (None, ""):
            item = {"value": str(o["value"]), "label": str(o.get("label") or o["value"])}
            if o.get("recommended"):
                item["recommended"] = True
            opts.append(item)
        elif isinstance(o, str) and o:
            opts.append({"value": o, "label": o})
    out = {"text": str(q.get("label") or q.get("id") or "질문"), "type": qt, "required": bool(q.get("required")),
           "allow_comment_as_answer": bool(q.get("other"))}
    if opts:
        out["options"] = opts
    helptext = q.get("help") or q.get("desc")
    if isinstance(helptext, str) and helptext:
        out["help"] = helptext
    if isinstance(q.get("show_if"), dict):
        out["show_if"] = q["show_if"]
    return out


def db_ask_prep(args):
    d, which = pdir(args[0]), args[1]
    src = QB / f"{which}.json"
    if not src.exists():
        die(f"질문 은행 없음: {src}")
    spec = read_json_file(src, "질문 은행")
    bank_key = re.sub(r"[^A-Za-z0-9_-]", "-", str(spec.get("id", which)))[:64] or which
    bridge("ask-prep", d.name, {"stage": which if which in KEYS else None, "bank_key": bank_key})
    (d / "ask").mkdir(parents=True, exist_ok=True)
    out = d / "ask" / f"{spec.get('id', which)}.json"
    if not out.exists():
        out.write_text(json.dumps(spec, ensure_ascii=False, indent=1), encoding="utf-8")
    print(out)


def db_ask(args):
    d, spec_path = pdir(args[0]), pdir(args[1])
    spec = strip_private(read_json_file(spec_path, "질문 폼 파일"))
    if not isinstance(spec, dict):
        die(f"질문 폼 파일은 JSON 객체여야 합니다: {spec_path}", 2)
    sid = re.sub(r"[^a-z0-9-]", "-", str(spec.get("id") or spec.get("stage") or "ask").lower()).strip("-") or "ask"
    stage = spec.get("stage") if spec.get("stage") in KEYS else None
    purpose = spec.get("kind") if spec.get("kind") in ASK_PURPOSES else "stage_start"
    questions = [legacy_question(q) for q in spec.get("questions") or [] if isinstance(q, dict)]
    if not questions:
        die("질문 폼에 질문이 없습니다", 2)
    bridge("ask", d.name, {"stage": stage, "purpose": purpose, "form_key": sid, "questions": questions})
    ov = bridge("overview", d.name)
    status = {x["key"]: x["status"] for x in ov["stages"]}
    data = {"spec": spec, "topic": ov["topic"], "built": now(),
            "stages": [{"key": k, "label": v, "status": status.get(k, "pending")} for k, v in STAGES]}
    out = d / f"ask-{sid}.html"
    d.mkdir(parents=True, exist_ok=True)
    out.write_text(fill(TPL / "ask.html", spec.get("title", "질문"), data), encoding="utf-8")
    print(out)


def db_round_start(args):
    d, s = pdir(args[0]), stage_arg(args[1])
    data = bridge("round-start", d.name, {"stage": s})
    print(f"{LABEL[s]} R{data['round_no']} 시작")


def db_merge(args):
    d, s = pdir(args[0]), stage_arg(args[1])
    results = []
    for f in args[2:]:
        raw = read_json_file(f, "병합할 결과 파일")
        for r in (raw if isinstance(raw, list) else [raw]):
            if not isinstance(r, dict):
                die(f"결과 항목은 JSON 객체여야 합니다: {f}", 2)
            r = dict(r)
            for k in ("title", "kind", "question", "summary", "details", "confidence", "verify", "order", "verdict", "path", "request"):
                if k in r and r[k] not in (None, ""):
                    r[k] = norm_text(r[k])
            results.append(r)
    data = bridge("merge", d.name, {"stage": s, "results": results})
    print(f"{LABEL[s]}: {data['merged']}건 병합")


def db_render(args):
    d = pdir(args[0])
    s = stage_arg(args[1]) if len(args) > 1 else None
    data = bridge("render", d.name, {"stage": s})
    st = data.get("stage") or s
    print(f"{LABEL[st]} R{data['round_no']} 봉인: 스냅샷 {str(data['snapshot_id'])[:8]} (항목 {data.get('items', data['versions'])}개)")


def db_approve(args):
    d, s = pdir(args[0]), stage_arg(args[1])
    data = bridge("approve", d.name, {"stage": s})
    msg = [f"{LABEL[s]} 승인"]
    if s == "plan" and isinstance(data.get("handed_over"), int):
        # v0.15 handoff_plan 과 같은 줄. 기존 조사 재사용(라이브러리)은 DB 경로에 아직 없어 0개다.
        msg.append(f"조사 항목 {data['handed_over']}개 생성 (기존 조사 재사용 0개)")
    if data.get("next"):
        nxt = data["next"]
        msg.append(f"다음 단계: {LABEL[nxt['key']]} (상태 {nxt['status']})")
    elif data.get("complete"):
        msg.append("모든 단계 완료")
    msg.append(f"단계 보고서를 만드세요: report {d} {s}")
    msg.append(f"대화에서 나온 결정·선호가 DB 에 없으면 note 로 남기세요. 그 뒤 대화를 비워도(/clear) `/pes:run {d.name}`로 이어집니다.")
    print("\n".join(msg))


def db_reopen(args):
    d, s = pdir(args[0]), stage_arg(args[1])
    data = bridge("reopen", d.name, {"stage": s})
    marked = [LABEL[k] for k in data.get("marked") or []]
    print(f"{LABEL[s]} 다시 열림" + (f" · 다시 확인 필요 표시: {', '.join(marked)}" if marked else ""))


def db_mark(args):
    d = pdir(args[0])
    names = [Path(f).name for f in args[1:]]
    if not names:
        die("사용: mark <dir> <feedback 파일...>")
    bridge("mark", d.name, {"names": names})
    print(f"처리 완료 표시 {len(args) - 1}개")


def db_chat(args):
    d, s, text = pdir(args[0]), stage_arg(args[1]), args[2]
    kind = args[3] if len(args) > 3 else "feedback"
    data = bridge("chat", d.name, {"stage": s, "text": text, "kind": kind})
    print(f"채팅 입력 기록: {data['object_id']}")


def db_note(args):
    d = pdir(args[0])
    text = " ".join(args[1:]).strip()
    if not text:
        die("사용: note <dir> \"메모\"")
    data = bridge("note", d.name, {"text": text})
    print(f"인계 메모 {data['note_count']}개")


def db_qa_brief(args):
    """독립 검토 지시문을 DB(qa.record_brief)에 기록하고, 읽기 편하게 rounds/<stage>-R<n>/qa-brief.md 에도 쓴다."""
    d, s = pdir(args[0]), stage_arg(args[1])
    info = bridge("qa-data", d.name, {"stage": s})
    rnd = info["round_no"]
    rd = d / "rounds" / f"{s}-R{rnd}"
    lines = [f"[{LABEL[s]} R{rnd}] 항목 {len(info['items'])}개"]
    for it in info["items"]:
        lines.append(f"\n#{it['id']} {it['title']} [{it.get('kind')}/{it.get('status')}] 신뢰도 {it.get('confidence') or '-'} · 출처 {it.get('sources')}")
        if it.get("summary"):
            lines.append("  요약: " + first_line(it["summary"], 300))
    basis = [f"- 주제: {info['topic']}"] + [f"- 인계 메모: {first_line(n, 300)}" for n in info.get("notes") or []]
    text = f"""[검토 대상] {info['topic']} — {LABEL[s]} 단계 R{rnd} 결과 (프로젝트 {d.name})
[단계 목적] {STAGE_GOAL.get(s, '')}
[읽을 것]
{chr(10).join(lines)}
[기준 — 사용자가 정한 것]
""" + "\n".join(basis) + f"""
[결과 파일] {rd / 'qa.json'}
pes:reviewer 형식대로 QC·QA·표본 대조(3~5개)를 하고 결과 파일에 쓴 뒤 한 줄만 돌려준다. 프로젝트 상태 파일은 고치지 않는다.
"""
    bridge("qa-brief", d.name, {"stage": s, "text": text})
    rd.mkdir(parents=True, exist_ok=True)
    f = rd / "qa-brief.md"
    f.write_text(text, encoding="utf-8")
    print(f)


def db_qa(args):
    d, s = pdir(args[0]), stage_arg(args[1])
    info = bridge("qa-data", d.name, {"stage": s})
    rnd = info["round_no"]
    f = Path(args[args.index("--file") + 1]) if "--file" in args else d / "rounds" / f"{s}-R{rnd}" / "qa.json"
    if not f.exists():
        die(f"검토 결과 없음: {f} — qa-brief 로 지시문을 만들고 pes:reviewer 를 먼저 돌리세요")
    q = read_json_file(f, "검토 결과 파일")
    if not isinstance(q, dict):
        die(f"검토 결과는 JSON 객체여야 합니다: {f}", 2)
    q["round"] = int(q.get("round") or rnd)
    q["recorded"] = now()
    bridge("qa", d.name, {"stage": s, "qa": q})
    fs = (q.get("qc") or []) + (q.get("qa") or [])
    hi = [x for x in fs if x.get("severity") == "high"]
    sc = q.get("spot_checks") or []
    print(f"{LABEL[s]} R{q['round']} 독립 검토: {q.get('verdict')} · QC {len(q.get('qc') or [])} · QA {len(q.get('qa') or [])} · high {len(hi)}"
          f" · 표본 일치 {sum(1 for x in sc if x.get('result') == 'match')}/{len(sc)} · 자체 점검이 놓친 것 {len(q.get('missed_by_self_review') or [])}")
    for x in hi:
        print(f"  [{x.get('id')}] #{x.get('item')} {x.get('finding')}")


def db_lock(args):
    d = pdir(args[0])
    me = os.environ.get("PES_OWNER", "")
    if not me:
        die("PES_OWNER 환경변수(이 세션 ID)가 필요합니다", 2)
    bridge("lock", d.name, {"force": "--force" in args})
    print(f"잠금: {d.name} (세션 {me[:8]}…)")


def db_unlock(args):
    d = pdir(args[0])
    bridge("unlock", d.name, {"force": "--force" in args})
    print("잠금 해제")


def db_serve(args):
    d = pdir(args[0])
    if (d / "project.json").exists():
        return cmd_serve(args)  # 이전 전의 옛 프로젝트: 읽기만 하는 옛 경로
    bridge("overview", d.name)  # DB 에 있는 프로젝트인지 확인 (없으면 거부)
    root = d.parent
    stop_legacy(d)
    if (root / ".pes-hub").exists() or not (root / "index.html").exists():
        build_hub(root)
    port = ensure_server(root)
    print(f"http://127.0.0.1:{port}/{d.name}/")


def db_stop(args):
    args = [a for a in args if a != "--"]
    d = pdir(args[0]) if args else pes_home()
    if args and ((d / "project.json").exists() or d.name in db_slugs()):
        root = d.parent
        stop_legacy(d)
    else:
        root = d
    stop_server(root, old=True)
    print(f"서버 종료 ({root} — 이 홈의 모든 프로젝트 화면이 함께 꺼집니다)")


def db_project_dirs(root: Path):
    """PES 홈 아래 프로젝트 폴더: project.json 이 있는 옛 프로젝트 + DB 에 있는 프로젝트."""
    if not root.exists():
        return []
    slugs = db_slugs()
    return sorted(f for f in root.iterdir() if f.is_dir() and ((f / "project.json").exists() or f.name in slugs))


def db_home(args):
    """pes home: 프로젝트 폴더와 화면 서버만 옮긴다. DB(~/.pes/pes.db)·객체 폴더는 건드리지 않는다."""
    args = [a for a in args if a != "--"]
    cur = pes_home()
    if not args or args[0].startswith("--"):
        src = "PES_HOME 환경변수" if os.environ.get("PES_HOME") else ("설정 파일 " + str(CONFIG) if CONFIG.exists() else "기본값")
        print(f"PES 홈: {cur}  ({src}) · 프로젝트 {len(db_project_dirs(cur))}개")
        return
    new = Path(args[0]).expanduser().resolve()
    old = Path(args[args.index("--from") + 1]).expanduser().resolve() if "--from" in args else cur
    force = "--force" in args
    if new == old:
        print(f"이미 PES 홈입니다: {new}")
        return
    if new.is_relative_to(old) or old.is_relative_to(new):
        die("새 폴더와 옛 폴더가 서로 안에 들어 있으면 옮길 수 없습니다")
    projects = db_project_dirs(old)
    clash = [d.name for d in projects if (new / d.name).exists()]
    if clash:
        die(f"새 폴더에 같은 이름이 이미 있습니다: {', '.join(clash)} — 아무것도 옮기지 않았습니다")
    me = os.environ.get("PES_OWNER", "")
    locks = (bridge("live_locks") or {}).get("locks") or {}
    busy = [d.name for d in projects
            if (lambda x: x and x["live"] and x.get("owner") != me)(lock_info(d)) or (d.name in locks and locks[d.name] != me)]
    if busy and not force:
        die(f"다른 Claude 세션이 쓰는 프로젝트가 있습니다: {', '.join(busy)} — 그 세션을 닫고 다시 하거나 --force", 3)
    hub_on = any(whoami(pt) == str(old) for pt in HUB_PORTS)
    for d in projects:
        stop_legacy(d)
    if old.exists():
        stop_server(old, old=True)
    new.mkdir(parents=True, exist_ok=True)
    moved = []
    for d in projects:
        shutil.move(str(d), str(new / d.name))
        moved.append(d.name)
        lg = new / d.name / "feedback.log"
        if lg.exists():
            lg.write_text(lg.read_text(encoding="utf-8").replace(str(d), str(new / d.name)), encoding="utf-8")
        for junk in (".pes-port", ".pes-server"):
            (new / d.name / junk).unlink(missing_ok=True)
    for junk in ("index.html", ".pes-hub", ".pes-hub.out", ".pes-hub-server"):
        (old / junk).unlink(missing_ok=True) if old.exists() else None
    if old.exists():
        for junk in (".DS_Store", "Thumbs.db", "desktop.ini"):
            (old / junk).unlink(missing_ok=True)
        if not any(old.iterdir()):
            old.rmdir()
    CONFIG.parent.mkdir(parents=True, exist_ok=True)
    cfg = {}
    try:
        cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    except Exception:
        pass
    cfg["home"] = str(new)
    CONFIG.write_text(json.dumps(cfg, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"PES 홈 변경: {old} → {new}  (프로젝트 {len(moved)}개 이동{': ' + ', '.join(moved) if moved else ''})")
    if os.environ.get("PES_HOME") and Path(os.environ["PES_HOME"]).expanduser().resolve() != new:
        print("주의: PES_HOME 환경변수가 설정 파일보다 우선합니다 — 환경변수도 바꾸거나 지우세요")
    for name in moved:  # 옛 project.json 프로젝트만 화면을 다시 만든다 (DB 프로젝트의 화면은 PR16·18 몫)
        if (new / name / "project.json").exists():
            build_index(new / name, load(new / name))
    if hub_on:
        cmd_hub([str(new)])
    print("Monitor 가 옛 경로의 feedback.log 를 보고 있었다면 새 경로로 다시 거세요.")



# ---------- DB 읽기 경로 (PES_DB_CORE=1 일 때만) ----------
# 읽기는 PR12 serving_path 를 따른다: 프로젝트가 DB 에 있고 active 이면 DB, 그 밖(DB 에 없음·staging·failed·archived)은
# 옛 project.json 을 읽는다 (바이트·mtime 불변). 옛 프로젝트의 쓰기(report·assemble·web 포함)는 '이전' 안내로 막는다.
_SERVING = {}
_LAST_BRIDGE_ERROR = ""
SOFT_DB = False  # doctor 만 True: DB 를 못 읽어도 진단을 계속한다


def db_unreadable(why=""):
    die("DB 를 읽지 못했습니다 — `doctor` 로 확인하세요" + (f" ({why})" if why else "") + ". "
        "읽을 수 없는 DB 를 없는 것으로 보고 옛 project.json 을 현재 상태처럼 보여 주지 않습니다", 1)


def serving(slug) -> str:
    """'database' | 'legacy'(DB 에 있으나 아직 active 아님) | 'none'(DB 에 없음). 플래그가 꺼져 있으면 항상 'none'.
    DB 파일이 없을 때만 코어가 'none' 으로 답한다. DB 를 열지 못하거나 스키마가 덜 올라갔으면(판정 실패) 종료 1."""
    if not db_core():
        return "none"
    if slug not in _SERVING:
        data = bridge_soft("route", slug)
        if data is None:
            if not SOFT_DB:
                db_unreadable(_LAST_BRIDGE_ERROR)
            return "none"
        _SERVING[slug] = data.get("serving", "none")
    return _SERVING[slug]


def is_db_served(d: Path) -> bool:
    return db_core() and d.parent == pes_home() and serving(d.name) == "database"


def db_served_slugs():
    data = bridge_soft("active_slugs")
    if data is None and not SOFT_DB:
        db_unreadable(_LAST_BRIDGE_ERROR)
    return set((data or {}).get("slugs") or [])


def refuse_legacy_write(name, d: Path):
    die(f"{name}: {d.name} 는 아직 DB 로 이전하지 않은 옛 project.json 프로젝트라 쓸 수 없습니다 — 먼저 이전(import → 검증 → 활성화)하세요. "
        f"읽기(status·digest·show 등)는 그대로 됩니다", 2)


def read_db_project(d: Path):
    """DB 에서 옛 project.json 모양으로 다시 만든 프로젝트와 처리 안 한 답."""
    data = bridge("read_project", d.name)
    return data["project"], data["pending"]


def db_pending_entries(d: Path, pend):
    return [(d / "feedback" / e["name"], e) for e in pend]


def dbr_status(args):
    d = pdir(args[0])
    if not is_db_served(d):
        return cmd_status(args)
    p, pend = read_db_project(d)
    show_status(d, p, db_pending_entries(d, pend))


def dbr_pending(args):
    d = pdir(args[0])
    if not is_db_served(d):
        return cmd_pending(args)
    _, pend = read_db_project(d)
    for f, _ in db_pending_entries(d, pend):
        print(f)


def dbr_digest(args):
    d, s = pdir(args[0]), stage_arg(args[1])
    if not is_db_served(d):
        return cmd_digest(args)
    show_digest(read_db_project(d)[0], s, args)


def dbr_show(args):
    d, s = pdir(args[0]), stage_arg(args[1])
    if not is_db_served(d):
        return cmd_show(args)
    show_items(read_db_project(d)[0], s, args)


def dbr_report(args):
    d, s = pdir(args[0]), stage_arg(args[1])
    if not is_db_served(d):
        refuse_legacy_write("report", d)
    eli5 = None
    ej = d / "reports" / s / "eli5.json"
    if ej.exists():  # 읽기만 한다 — 폴더에는 아무것도 쓰지 않는다
        eli5 = read_json_file(ej, "eli5.json")
    data = bridge("report", d.name, {"stage": s, "eli5": eli5})
    lines = [f"{REPORT_NAME[s]}: 새 버전 {data['version_id']} (v{data['version_no']})"]
    lines += [f"  {f['name']} → blob {f['blob_id']}" for f in data["files"]]
    if not data.get("eli5") and "eli5" in data.get("formats", []):
        lines.append(f"eli5: {ej} 를 써야 합니다 (스키마는 pes:core 「단계 보고서」) — 쓴 뒤 report 를 다시 실행")
    for x in data.get("formats", []):
        if x not in ("md", "html", "eli5"):
            lines.append(f"{x}: 아직 없음 — report.md 로 해당 스킬을 써서 만든 뒤 file.attach_version 으로 붙이세요")
    print("\n".join(lines))


def print_output_files(data):
    for f in data["files"]:
        print(f"  {f['name']} → blob {f['blob_id']}")


def dbr_assemble(args):
    d = pdir(args[0])
    if not is_db_served(d):
        refuse_legacy_write("assemble", d)
    data = bridge("assemble", d.name)
    for w in data.get("warnings") or []:
        print(w, file=sys.stderr)
    print(f"최종 보고서 새 버전 {data['version_id']} (v{data['version_no']})  (장·절 {data['sections']}개, 각주 {data['footnotes']}개)")
    print_output_files(data)


def dbr_web(args):
    d = pdir(args[0])
    if not is_db_served(d):
        refuse_legacy_write("web", d)
    od = d / "out"
    cover = read_json_file(od / "cover.json", "out/cover.json") if (od / "cover.json").exists() else {}
    appendix = (od / "appendix.md").read_text(encoding="utf-8") if (od / "appendix.md").exists() else None
    data = bridge("web", d.name, {"assemble": "--assemble" in args, "cover": cover, "appendix": appendix})
    for w in data.get("warnings") or []:
        print(w, file=sys.stderr)
    print(f"최종 웹 보고서 새 버전 {data['version_id']} (v{data['version_no']})  (출처 {data['sources']}개 · 확인됨 {data['verified']}개"
          f"{'' if cover else ' · 표지 정보 없음: out/cover.json 을 쓰면 연구진·기관·발주처가 표지에 나온다'})")
    print_output_files(data)


DB_PROJECT_WRITES = {"ask-prep", "ask", "round-start", "merge", "render", "approve", "reopen", "mark", "chat", "note",
                     "qa-brief", "qa", "lock", "unlock", "report", "assemble", "web", "set"}

DB_CMDS = {"init": db_init, "ask-prep": db_ask_prep, "ask": db_ask, "round-start": db_round_start, "merge": db_merge,
           "render": db_render, "approve": db_approve, "reopen": db_reopen, "mark": db_mark, "chat": db_chat,
           "note": db_note, "qa-brief": db_qa_brief, "qa": db_qa, "serve": db_serve, "stop": db_stop,
           "home": db_home, "lock": db_lock, "unlock": db_unlock, "set": db_set,
           "status": dbr_status, "pending": dbr_pending, "digest": dbr_digest, "show": dbr_show,
           "report": dbr_report, "assemble": dbr_assemble, "web": dbr_web}


# ---------- 새 CLI 명령 5개 (PES_DB_CORE=1 전용): 에이전트가 PES_TOKEN 으로 쓴다 ----------
def _opts(args, names):
    """--이름 값 쌍을 모은다 (이름 목록 밖은 거부)."""
    out, rest = {}, list(args)
    while rest:
        k = rest.pop(0)
        if k.startswith("--") and k[2:] in names and rest:
            out[k[2:]] = rest.pop(0)
        else:
            die(f"알 수 없는 인자: {k}", 2)
    return out


def _guard(opt):
    for k in ("run", "lease", "fence"):
        if k not in opt:
            die(f"--{k} 필요 (claim 결과의 run_id·lease_id·fence)", 2)
    try:
        fence = int(opt["fence"])
    except ValueError:
        die("--fence 는 정수여야 합니다", 2)
    return {"run_id": opt["run"], "lease_id": opt["lease"], "fence": fence}


def _print_json(data):
    print(json.dumps(data, ensure_ascii=False))


def cmd_context(args):
    need_db_core("context")
    _print_json(bridge("context", db_name(args[0])))


def cmd_claim(args):
    need_db_core("claim")
    opt = _opts(args[1:], {"run", "mode", "runtime", "provider", "model"})
    a = {k: opt[k] for k in ("mode", "runtime", "provider", "model") if k in opt}
    if "run" in opt:
        a = {"run_id": opt["run"]}
    _print_json(bridge("claim", db_name(args[0]), a))


def cmd_submit(args):
    need_db_core("submit")
    opt = _opts(args[1:], {"run", "lease", "fence", "file"})
    if "file" not in opt:
        die("--file <결과.json> 필요", 2)
    raw = read_json_file(opt["file"], "결과 파일")
    results = raw.get("results") if isinstance(raw, dict) else raw
    a = _guard(opt)
    a["results"] = results
    _print_json(bridge("submit", db_name(args[0]), a))


def cmd_wait(args):
    need_db_core("wait")
    opt = _opts(args[1:], {"run", "lease", "fence", "reason"})
    a = _guard(opt)
    if opt.get("reason"):
        a["reason"] = opt["reason"]
    _print_json(bridge("wait", db_name(args[0]), a))


def cmd_complete(args):
    need_db_core("complete")
    opt = _opts(args[1:], {"run", "lease", "fence", "status"})
    a = _guard(opt)
    if opt.get("status"):
        a["status"] = opt["status"]
    _print_json(bridge("complete", db_name(args[0]), a))


CMDS = {"init": cmd_init, "ask-prep": cmd_ask_prep, "ask": cmd_ask, "round-start": cmd_round_start,
        "merge": cmd_merge, "render": cmd_render, "approve": cmd_approve, "reopen": cmd_reopen,
        "status": cmd_status, "pending": cmd_pending, "mark": cmd_mark, "chat": cmd_chat,
        "assemble": cmd_assemble, "report": cmd_report, "digest": cmd_digest, "show": cmd_show, "note": cmd_note, "set": cmd_set, "web": cmd_web, "remote": cmd_remote, "qa-brief": cmd_qa_brief, "qa": cmd_qa, "serve": cmd_serve, "stop": cmd_stop, "watch": cmd_watch,
        "list": cmd_list, "hub": cmd_hub, "home": cmd_home, "open": cmd_open, "doctor": cmd_doctor, "which": cmd_which, "lock": cmd_lock, "unlock": cmd_unlock,
        "context": cmd_context, "claim": cmd_claim, "submit": cmd_submit, "wait": cmd_wait, "complete": cmd_complete}

def _utf8_stdio():
    """stdout·stderr 를 UTF-8 로. Windows 파이프·리디렉션은 기본 cp1252 라 한글 print 가 UnicodeEncodeError 로 죽는다.
    `python -I` 는 PYTHONIOENCODING 을 무시하므로 환경 변수에 기대지 않고 여기서 직접 바꾼다. stdin 은 건드리지 않는다."""
    for stream in (sys.stdout, sys.stderr):
        enc = (getattr(stream, "encoding", None) or "").lower().replace("_", "-")
        if enc in ("utf-8", "utf8"):
            continue
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError, OSError):
            pass


def main(argv=None):
    _utf8_stdio()
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) == 1 and args[0] in ("list", "hub", "home", "doctor", "stop", "remote"):
        args.append("--")
    if len(args) < 2 or args[0] not in CMDS:
        print(__doc__)
        sys.exit(1)
    if db_core() and args[0] in DB_PROJECT_WRITES and not args[1].startswith("-"):
        d = pdir(args[1])
        if d.parent != pes_home():  # PES 홈 밖 절대 경로 폴더는 DB 가 서비스하는 프로젝트가 아니다: 같은 이름이 DB 에 있어도 쓰지 않는다
            refuse_legacy_write(args[0], d)
    (DB_CMDS[args[0]] if db_core() and args[0] in DB_CMDS else CMDS[args[0]])(args[1:])


if __name__ == "__main__":
    main()
