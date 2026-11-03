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
  note <dir> "메모"                     인계 메모 추가 (대화에서 나온 결정·선호 — 새 세션이 먼저 읽는다)
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
    tmp = d / "project.json.tmp"
    tmp.write_text(json.dumps(q, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(d / "project.json")


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


def import_library(d: Path, src: Path) -> dict:
    st_file = src / "state.json"
    if not st_file.exists():
        die(f"가져올 state.json 없음: {st_file}")
    st = json.loads(st_file.read_text(encoding="utf-8"))
    shots_src = src / "shots"
    if shots_src.exists():
        dst = d / "library" / "shots"
        dst.parent.mkdir(exist_ok=True)
        if not dst.exists():
            shutil.copytree(shots_src, dst)
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


def cmd_merge(args):
    d, s = pdir(args[0]), stage_arg(args[1])
    p = load(d)
    st = p["stages"][s]
    items = {it["id"]: it for it in st["items"]}
    n = 0
    for f in args[2:]:
        raw = json.loads(Path(f).read_text(encoding="utf-8"))
        for r in (raw if isinstance(raw, list) else [raw]):
            iid = r.get("id")
            it = items.get(iid)
            if it is None:
                iid = iid if iid is not None else max([0] + list(items)) + 1
                it = blank_item(iid, r.get("title", f"항목 {iid}"))
                st["items"].append(it)
                items[iid] = it
            for k in ("title", "kind", "question", "summary", "details", "confidence", "verify", "order", "verdict", "path"):
                if k in r and r[k] not in (None, ""):
                    it[k] = norm_text(r[k])
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


def cmd_render(args):
    d = pdir(args[0])
    p = load(d)
    s = stage_arg(args[1]) if len(args) > 1 else p["current"]
    st = p["stages"][s]
    if st["round"] > 0:
        snap = {"stage": s, "round": st["round"], "time": now(), "state": st}
        (d / "snapshots").mkdir(exist_ok=True)
        (d / "snapshots" / f"{s}-R{st['round']}.json").write_text(json.dumps(snap, ensure_ascii=False), encoding="utf-8")
    print(build_index(d, p))


def build_index(d: Path, p: dict) -> Path:
    snaps = []
    for f in (d / "snapshots").glob("*-R*.json") if (d / "snapshots").exists() else []:
        try:
            x = json.loads(f.read_text(encoding="utf-8"))
            snaps.append({"stage": x["stage"], "round": x["round"], "time": x.get("time"), "state": slim(x["state"])})
        except Exception:
            pass
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
    pend = pending_files(d, p)
    print(f"처리 안 한 답: {len(pend)}개")
    for f in pend:
        x = json.loads(f.read_text(encoding="utf-8"))
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
    p = load(d)
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
    p = load(d)
    rest = args[2:]
    fields = None
    if "--fields" in rest:
        k = rest.index("--fields")
        fields = rest[k + 1].split(",")
        rest = rest[:k] + rest[k + 2:]
    ids = {int(x) for x in rest if x.isdigit()}
    st = p["stages"][s]
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
    return d.parent if (d / "project.json").exists() else d


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


def cmd_watch(args):
    d = pdir(args[0])
    print(f"tail -n0 -F {d}/feedback.log | grep --line-buffered FEEDBACK")


# ---------- 여러 프로젝트 ----------
HUB_PORTS = range(8760, 8765)


def projects_root(args):
    r = Path(args[0]).expanduser().resolve() if args and not args[0].startswith("--") else pes_home()
    if (r / "project.json").exists():
        r = r.parent
    return r


def brief(d: Path) -> dict:
    p = load(d)
    cur = p.get("current", "plan")
    x = p["stages"][cur]
    pend = pending_files(d, p)
    L = LABEL[cur]
    if p.get("complete"):
        who, todo = "done", "완료 — 최종 결과물: " + (", ".join(f.name for f in sorted((d / "out").glob("*")) if f.is_file()) if (d / "out").exists() else "-")
    elif pend:
        who, todo = "ai", f"받은 답 {len(pend)}개 처리 대기"
    elif x["status"] == "asking":
        who, todo = "you", f"{L} 시작 질문에 답하기"
    elif x["status"] == "active" and x.get("review") and int(x["review"].get("round") or 0) == x["round"]:
        who, todo = "you", f"{L} R{x['round']} 결과 확인 · 점검 질문 {len(x['review'].get('questions', []))}개에 답하기"
    elif x["status"] == "active":
        who, todo = "ai", f"{L} R{x['round'] or 1} 작업 중"
    else:
        who, todo = "you", f"{L} 시작"
    lk = lock_info(d)
    times = [f.stat().st_mtime for f in [d / "project.json", *(d / "feedback").glob("*.json")] if f.exists()] if (d / "feedback").exists() else [(d / "project.json").stat().st_mtime]
    return {"slug": d.name, "path": str(d), "topic": p.get("topic", d.name), "created": p.get("created", ""), "current": cur,
            "stages": [{"key": k, "label": v, "status": p["stages"][k]["status"], "round": p["stages"][k]["round"],
                        "stale": p["stages"][k].get("stale"), "reports": [r["format"] for r in p["stages"][k].get("reports", [])]}
                       for k, v in STAGES],
            "complete": bool(p.get("complete")), "who": who, "todo": todo, "pending": len(pend),
            "updated": time.strftime("%Y-%m-%d %H:%M", time.localtime(max(times))),
            "lock": {"owner": str(lk.get("owner"))[:8], "since": lk.get("since")} if lk and lk["live"] else None}


def all_briefs(root: Path):
    out = []
    for f in sorted(root.glob("*/project.json")):
        try:
            out.append(brief(f.parent))
        except SystemExit:
            continue
        except Exception as e:
            out.append({"slug": f.parent.name, "topic": f.parent.name, "error": str(e)[:200], "stages": [], "who": "err", "todo": "읽기 실패"})
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
    on = root_port(h)
    if not on and not any(whoami(pt) is None and not port_busy(pt) for pt in HUB_PORTS):
        R.add("서버", "bad", f"포트 {HUB_PORTS.start}~{HUB_PORTS.stop - 1} 모두 사용 중", "다른 프로그램이 쓰고 있음")
    R.add("서버", "ok" if on else "info", f"PES 서버 {'http://127.0.0.1:%d/ (목록과 모든 프로젝트)' % on if on else '꺼짐'}", "" if on else "/pes:list 로 켜기")


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
    if (d / "project.json.tmp").exists():
        R.add(tag, "warn", "저장 중 끊긴 임시 파일", "project.json.tmp", fix=lambda: (d / "project.json.tmp").unlink(missing_ok=True))
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

    def add(self, group, level, title, detail="", fix=None):
        self.rows.append({"group": group, "level": level, "title": title, "detail": detail, "fix": fix})


NET = False


def cmd_doctor(args):
    global NET
    NET = "--net" in args
    fix = "--fix" in args
    as_json = "--json" in args
    tgt = [a for a in args if not a.startswith("--")]
    R = DocReport()
    doctor_env(R)
    h = pes_home()
    dirs = [pdir(tgt[0])] if tgt else (sorted(f.parent for f in h.glob("*/project.json")) if h.exists() else [])
    for d in dirs:
        if not (d / "project.json").exists():
            R.add(d.name, "bad", "project.json 없음", str(d))
            continue
        doctor_project(R, d)
    if not tgt and h.exists():
        stray = [x.name for x in h.iterdir() if x.is_dir() and not (x / "project.json").exists() and not x.name.startswith(".")]
        if stray:
            R.add("환경", "info", "PES 홈에 프로젝트가 아닌 폴더", ", ".join(stray))
    fixed = []
    if fix:
        for r in R.rows:
            if r["fix"]:
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
        print(json.dumps([{k: v for k, v in r.items() if k != "fix"} | {"fixable": bool(r["fix"])} for r in R.rows], ensure_ascii=False, indent=1))
        return
    MARK = {"ok": "[정상]", "info": "[참고]", "warn": "[주의]", "bad": "[문제]"}
    last = None
    for r in R.rows:
        if r["group"] != last:
            print(f"\n■ {r['group']}")
            last = r["group"]
        tail = " → 고침" if r.get("fixed") else (" (--fix 로 고칠 수 있음)" if r["fix"] else "")
        print(f"  {MARK[r['level']]} {r['title']}" + (f" — {r['detail']}" if r["detail"] else "") + tail)
    cnt = {k: sum(1 for r in R.rows if r["level"] == k) for k in MARK}
    nfix = sum(1 for r in R.rows if r["fix"] and not r.get("fixed"))
    print(f"\n요약: 문제 {cnt['bad']} · 주의 {cnt['warn']} · 참고 {cnt['info']} · 정상 {cnt['ok']}"
          + (f" · 고친 것 {len(fixed)}" if fix else (f" · --fix 로 고칠 수 있는 것 {nfix}" if nfix else "")))
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


CMDS = {"init": cmd_init, "ask-prep": cmd_ask_prep, "ask": cmd_ask, "round-start": cmd_round_start,
        "merge": cmd_merge, "render": cmd_render, "approve": cmd_approve, "reopen": cmd_reopen,
        "status": cmd_status, "pending": cmd_pending, "mark": cmd_mark, "chat": cmd_chat,
        "assemble": cmd_assemble, "report": cmd_report, "digest": cmd_digest, "show": cmd_show, "note": cmd_note, "web": cmd_web, "remote": cmd_remote, "qa-brief": cmd_qa_brief, "qa": cmd_qa, "serve": cmd_serve, "stop": cmd_stop, "watch": cmd_watch,
        "list": cmd_list, "hub": cmd_hub, "home": cmd_home, "open": cmd_open, "doctor": cmd_doctor, "which": cmd_which, "lock": cmd_lock, "unlock": cmd_unlock}

def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) == 1 and args[0] in ("list", "hub", "home", "doctor", "stop", "remote"):
        args.append("--")
    if len(args) < 2 or args[0] not in CMDS:
        print(__doc__)
        sys.exit(1)
    CMDS[args[0]](args[1:])


if __name__ == "__main__":
    main()
