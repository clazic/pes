#!/usr/bin/env python3
"""PES 설치 도우미 — 필요한 도구(CLI·스킬·MCP)를 확인·설치하고, API 키를 로컬 웹 폼으로 받아 등록한다.

사용: python3 -I setup.py <명령>
  check [--json]            설치·키 상태 (항목마다 ok|missing|user|optional)
  install <이름…|missing>    설치: kosis vworld korean-law korean-law-mcp ego-browser  (missing = 빠진 것 전부)
  upgrade [이름…|all]        이미 설치된 것을 최신으로: kosis(CLI+스킬) vworld(CLI+스킬) korean-law(CLI·MCP 공용 npm)
                            ego-browser(ego lite 앱) — 줄마다 "UPGRADED|OK|FAIL|SKIP <이름> <버전>"
  keys [--no-open] [--wait] API 키 입력 화면(127.0.0.1:8759)을 띄우고 주소 출력. 결과는 ~/.pes/setup.log 에
                            "SETUP keys …" 한 줄로 남는다 (Monitor 로 기다린다). 키 값은 Claude 대화로 오지 않는다.
  mark                      설치 완료 표시 (~/.pes/setup.json) — 다른 PES 명령이 이것을 보고 setup 필요 여부를 안다
  needed                    setup 이 필요하면 이유를 출력하고 종료 코드 1, 아니면 0

키 값은 화면 → 이 프로그램 → 각 도구(kosis·vworld 설정, Claude Code 설정 env)로만 간다. 출력에는 가린 값만.
"""
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import pes  # noqa: E402  (같은 폴더의 pes.py — find_tool·run_quiet 재사용)

ROOT = HERE.parent
HOME = Path.home()
PESDIR = HOME / ".pes"
LOG = PESDIR / "setup.log"
MARK = PESDIR / "setup.json"
SETTINGS = HOME / ".claude" / "settings.json"
WIN = os.name == "nt"
KEY_PORT = 8759
VERSION = json.loads((ROOT / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8")).get("version", "")


def mask(v):
    v = str(v or "")
    return v[:2] + "*" * max(0, len(v) - 4) + v[-2:] if len(v) > 4 else "****"


def tool(name):
    return pes.find_tool(name)


def settings_env():
    try:
        return json.loads(SETTINGS.read_text(encoding="utf-8")).get("env", {}) or {}
    except Exception:
        return {}


def node_env(extra=None):
    e = dict(os.environ)
    se = settings_env()
    for k in ("LAW_OC", "NODE_EXTRA_CA_CERTS"):
        if not e.get(k) and se.get(k):
            e[k] = se[k]
    if extra:
        e.update(extra)
    return e


def run(cmd, timeout=600, env=None, shell=False):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                           timeout=timeout, env=env, shell=shell)
        return r.returncode, (r.stdout or "") + (r.stderr or "")
    except Exception as e:
        return -1, str(e)


# ---------- 상태 ----------
def kosis_keys():
    t = tool("kosis")
    if not t:
        return 0
    _, out = run([t, "config", "key-list"], 20)
    return len(re.findall(r"^\s*\[\d+\]", out, re.M)) or (1 if os.environ.get("KOSIS_API_KEY") else 0)


def vworld_keys():
    t = tool("vworld")
    if not t:
        return 0
    _, out = run([t, "config", "list-keys"], 20)
    return out.count('"masked"')


def gitbash():
    if not WIN:
        return shutil.which("bash")
    for c in (shutil.which("bash"), r"C:\Program Files\Git\bin\bash.exe", r"C:\Program Files (x86)\Git\bin\bash.exe",
              str(Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Git" / "bin" / "bash.exe")):
        if c and Path(c).exists():
            return c
    return None


def mcp_status():
    c = shutil.which("claude")
    if not c:
        return None  # claude CLI 가 없으면 확인 불가 (Desktop 만 설치된 경우)
    code, out = run([c, "mcp", "get", "korean-law"], 30)
    return code == 0 and "korean-law" in out


def check():
    S = []

    def add(name, state, label, detail="", group="도구"):
        S.append({"name": name, "state": state, "label": label, "detail": detail, "group": group})

    v = sys.version_info
    add("python", "ok" if v >= (3, 9) else "missing", f"Python {v.major}.{v.minor}", "", "기본")
    add("git", "ok" if shutil.which("git") else "missing", "Git", "" if shutil.which("git") else "bootstrap 으로 설치", "기본")
    if WIN:
        gb = gitbash()
        add("gitbash", "ok" if gb else "missing", "Git Bash", gb or "답 자동 수신(Monitor)에 필요 — Git for Windows", "기본")
    add("node", "ok" if shutil.which("node") and shutil.which("npm") else "missing", "Node.js·npm",
        "" if shutil.which("npm") else "korean-law 설치에 필요", "기본")

    t = tool("ego-browser")
    add("ego-browser", "ok" if t else "user", "ego lite (ego-browser)", t or "앱 설치 + 첫 실행 안내(온보딩)는 사용자가 직접")
    sk = HOME / ".claude" / "skills"
    t = tool("kosis")
    add("kosis", "ok" if t and (sk / "kosis" / "SKILL.md").exists() else "missing", "kosis CLI + 스킬",
        t or "통계청 KOSIS")
    t = tool("vworld")
    add("vworld", "ok" if t and (sk / "vworld" / "SKILL.md").exists() else "missing", "vworld CLI + 스킬", t or "국가공간정보")
    t = tool("korean-law")
    add("korean-law", "ok" if t else "missing", "korean-law CLI", t or "법령 조회")
    m = mcp_status()
    add("korean-law-mcp", "ok" if m else "optional", "korean-law MCP (선택)",
        "claude CLI 가 없어 확인 생략 — CLI 만으로 충분" if m is None else ("" if m else "Claude 에 MCP 로도 등록"))

    n = kosis_keys()
    add("key-kosis", "ok" if n else "key", "KOSIS API 키", f"{n}개" if n else "https://kosis.kr/openapi/", "API 키")
    n = vworld_keys()
    add("key-vworld", "ok" if n else "key", "VWorld API 키", f"{n}개" if n else "https://www.vworld.kr", "API 키")
    oc = os.environ.get("LAW_OC") or settings_env().get("LAW_OC")
    add("key-law", "ok" if oc else "key", "법령 LAW_OC", mask(oc) if oc else "https://open.law.go.kr", "API 키")
    return S


# ---------- 설치 ----------
def sh_pipe(url, envs):
    """macOS·Linux: curl URL | env sh"""
    ev = " ".join(f"{k}={v}" for k, v in envs.items())
    shell = "bash" if url.endswith(".sh") and "vworld" in url else "sh"
    return run(["sh", "-c", f"curl -fsSL {url} | {ev} {shell}"], 900)


def ps_pipe(url, envs):
    """Windows: PowerShell irm URL | iex"""
    ev = "; ".join(f"$env:{k}='{v}'" for k, v in envs.items())
    return run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
                f"{ev}{'; ' if ev else ''}irm {url} | iex"], 900)


def install_one(name):
    if name == "kosis":
        envs = {"KOSIS_TARGET": "claude", "KOSIS_CLAUDE_SCOPE": "global"}
        if WIN:
            return ps_pipe("https://raw.githubusercontent.com/clazic/kosis/master/scripts/install.ps1", envs)
        return sh_pipe("https://raw.githubusercontent.com/clazic/kosis/master/scripts/install.sh", envs)
    if name == "vworld":
        if WIN:
            return ps_pipe("https://raw.githubusercontent.com/clazic/vworld/main/scripts/install.ps1", {})
        return sh_pipe("https://raw.githubusercontent.com/clazic/vworld/main/scripts/install.sh", {"VWORLD_SCOPE": "user"})
    if name == "korean-law":
        npm = shutil.which("npm")
        if not npm:
            return 1, "npm 없음 — bootstrap 으로 Node.js 먼저 설치"
        cmd = [npm, "install", "-g", "korean-law-mcp", "--ignore-scripts", "--omit=optional"]
        ca = node_env().get("NODE_EXTRA_CA_CERTS")
        if ca and Path(ca).exists():
            cmd += ["--cafile", ca]
        return run(cmd, 900, env=node_env())
    if name == "korean-law-mcp":
        return register_mcp()
    if name == "ego-browser":
        sc = HOME / ".claude" / "skills" / "ego-browser" / "scripts" / "install.sh"
        if sys.platform == "darwin" and sc.exists():
            code, out = run(["sh", str(sc)], 900)
            return (2 if code == 0 else code), out + "\nUSER ego lite 앱에서 첫 실행 안내(온보딩)를 마쳐 주세요."
        webbrowser.open("https://lite.ego.app/")
        return 2, ("USER https://lite.ego.app/ 에서 ego lite 를 내려받아 설치하고, 앱을 열어 첫 실행 안내(온보딩)를 마쳐 주세요."
                   + (" Windows SmartScreen 이 막으면 '추가 정보 → 실행'." if WIN else ""))
    return 1, f"알 수 없는 항목: {name}"


def register_mcp(law_oc=None):
    c = shutil.which("claude")
    srv = tool("korean-law-mcp")
    if not c:
        return 3, "claude CLI 가 없어 MCP 등록을 건너뜀 (PES 는 korean-law CLI 를 쓰므로 없어도 됨)"
    if not srv:
        return 1, "korean-law-mcp 실행 파일 없음 — korean-law 먼저 설치"
    e = node_env()
    oc = law_oc or e.get("LAW_OC")
    run([c, "mcp", "remove", "korean-law", "-s", "user"], 60)
    cmd = [c, "mcp", "add", "korean-law", "-s", "user"]
    if oc:
        cmd += ["-e", f"LAW_OC={oc}"]
    if e.get("NODE_EXTRA_CA_CERTS"):
        cmd += ["-e", f"NODE_EXTRA_CA_CERTS={e['NODE_EXTRA_CA_CERTS']}"]
    cmd += ["--", srv]
    code, out = run(cmd, 60)
    return code, ("MCP 등록됨" if code == 0 else out[-300:]).replace(oc or "\0", mask(oc))


def cmd_install(args):
    names = args
    if not names or names == ["missing"]:
        names = [x["name"] for x in check() if x["state"] in ("missing", "user") and x["name"] in
                 ("kosis", "vworld", "korean-law", "korean-law-mcp", "ego-browser")]
        if not names:
            print("OK 설치할 것 없음")
            return
    for n in names:
        print(f"... {n} 설치 중", flush=True)
        code, out = install_one(n)
        tail = [l for l in out.strip().splitlines() if l.strip()][-3:]
        state = "OK" if code == 0 else ("USER" if code == 2 else ("SKIP" if code == 3 else "FAIL"))
        print(f"{state} {n}" + (" — " + " / ".join(tail) if state != "OK" and tail else ""), flush=True)


# ---------- 업그레이드 ----------
def _vers(out):
    cur = re.search(r"현재 버전:\s*(\S+)", out)
    new = re.search(r"최신 버전:\s*(\S+)", out)
    return (cur.group(1) if cur else None), (new.group(1) if new else None)


def upgrade_selfupdating(name, extra):
    """kosis·vworld: '<cli> update --check' 로 비교 → 새 버전이면 '<cli> update' (바이너리 + 스킬 문서)"""
    t = tool(name)
    if not t:
        return "SKIP", "설치되어 있지 않음"
    code, out = run([t, "update", "--check"], 120)
    cur, new = _vers(out)
    if code != 0 or not new:
        return "FAIL", "최신 버전 확인 실패: " + ((out.strip().splitlines() or ["응답 없음"])[-1][:120])
    if "이미 최신" in out or cur == new:
        return "OK", f"{cur} (최신)"
    try:  # kosis 는 y/N 을 묻는다(바이너리·스킬) — 표준입력으로 y 를 준다. vworld 는 --yes
        r = subprocess.run([t, "update"] + extra, input="y\ny\ny\ny\n", capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=900, env=node_env())
        code, out2 = r.returncode, (r.stdout or "") + (r.stderr or "")
    except Exception as e:
        code, out2 = -1, str(e)
    after, _ = _vers(run([tool(name) or t, "update", "--check"], 120)[1])
    if after == new:
        return "UPGRADED", f"{cur} → {new}"
    return "FAIL", f"{cur} → {new} 실패 (지금 {after or '?'}): " + ((out2.strip().splitlines() or ["?"])[-1][:120])


def upgrade_korean_law():
    npm = shutil.which("npm")
    if not npm or not tool("korean-law"):
        return "SKIP", "설치되어 있지 않음"
    code, out = run([npm, "ls", "-g", "korean-law-mcp", "--json"], 60)
    try:
        cur = json.loads(out)["dependencies"]["korean-law-mcp"]["version"]
    except Exception:
        cur = None
    code, out = run([npm, "view", "korean-law-mcp", "version"], 60, env=node_env())
    new = (out.strip().splitlines() or [""])[-1].strip() if code == 0 else None
    if not new or not re.fullmatch(r"\d+(\.\d+)*", new):
        return "FAIL", "최신 버전 확인 실패 (인증서 오류면 NODE_EXTRA_CA_CERTS)"
    if cur == new:
        return "OK", f"{cur} (최신)"
    cmd = [npm, "install", "-g", f"korean-law-mcp@{new}", "--ignore-scripts", "--omit=optional"]
    ca = node_env().get("NODE_EXTRA_CA_CERTS")
    if ca and Path(ca).exists():
        cmd += ["--cafile", ca]
    code, out = run(cmd, 900, env=node_env())
    return ("UPGRADED", f"{cur} → {new} (CLI·MCP 함께)") if code == 0 else ("FAIL", out.strip()[-160:])


def upgrade_ego():
    t = tool("ego-browser")
    if not t:
        return "SKIP", "설치되어 있지 않음"
    _, v0 = run([t, "--version"], 30)
    cur = (v0.split() + ["", ""])[1]
    code, out = run([t, "upgrade"], 600)
    _, v1 = run([t, "--version"], 30)
    new = (v1.split() + ["", ""])[1]
    last = (out.strip().splitlines() or [""])[-1][:140]
    if code != 0:
        if "Unknown command" in out:
            return "FAIL", "이 ego lite 는 너무 오래되어 자동 업그레이드가 안 됨 — https://lite.ego.app/ 에서 다시 설치"
        return "FAIL", last or "업그레이드 실패 (진행 중인 브라우저 작업이 있으면 ego lite 창의 확인 대화상자를 보세요)"
    if new and new != cur:
        return "UPGRADED", f"{cur} → {new}"
    return "OK", f"{cur} ({last or '최신'})"


UPGRADERS = {
    "kosis": lambda: upgrade_selfupdating("kosis", []),
    "vworld": lambda: upgrade_selfupdating("vworld", ["--yes"]),
    "korean-law": upgrade_korean_law,
    "ego-browser": upgrade_ego,
}


def cmd_upgrade(args):
    names = [a for a in args if a != "all"] or list(UPGRADERS)
    for n in names:
        if n not in UPGRADERS:
            print(f"FAIL {n} 알 수 없는 항목")
            continue
        print(f"... {n} 최신 버전 확인", flush=True)
        try:
            state, msg = UPGRADERS[n]()
        except Exception as e:
            state, msg = "FAIL", str(e)[:160]
        print(f"{state} {n} {msg}", flush=True)


# ---------- API 키 화면 ----------
def test_kosis(k):
    t = tool("kosis")
    if not t:
        return False, "kosis 미설치"
    code, out = run([t, "s", "인구", "-n", "1"], 60, env=node_env({"KOSIS_API_KEY": k}))
    return code == 0, "" if code == 0 else (out.strip().splitlines() or ["응답 없음"])[-1][:160]


def reg_kosis(k):
    ok, why = test_kosis(k)
    if not ok:
        return False, f"키 확인 실패: {why}"
    code, out = run([tool("kosis"), "config", "add-key", k], 30)
    return code == 0, "등록·확인 완료" if code == 0 else out[-200:]


def reg_vworld(k):
    t = tool("vworld")
    if not t:
        return False, "vworld 미설치"
    code, out = run([t, "config", "add-key", k, "--alias", "pes"], 30)
    if code != 0 and "중복" not in out and "exist" not in out.lower():
        return False, out.strip()[-200:].replace(k, mask(k))
    code, out = run([t, "config", "test-keys"], 120)
    verdict = None
    try:
        for r in json.loads(out[out.index("{"):]).get("results", []):
            mk = str(r.get("key", ""))
            if mk[:4] == k[:4] and mk[-4:] == k[-4:]:
                verdict = r.get("verdict")
    except Exception:
        pass
    if verdict != "유효":
        run([t, "config", "remove-key", k], 30)
        return False, f"VWorld 확인 결과: {verdict or '알 수 없음'} — 등록하지 않음 (발급 직후면 몇 분 뒤 다시)"
    return True, "등록·확인 완료"


def reg_law(k):
    t = tool("korean-law")
    if t:
        code, out = run([t, "search_law", "--query", "민법"], 90, env=node_env({"LAW_OC": k}))
        if "검색 결과" not in out:
            why = "인증서 오류 — NODE_EXTRA_CA_CERTS 확인" if "CERT" in out else (out.strip().splitlines() or ["응답 없음"])[-1][:160]
            return False, f"확인 실패: {why}".replace(k, mask(k))
    SETTINGS.parent.mkdir(parents=True, exist_ok=True)
    d = {}
    if SETTINGS.exists():
        shutil.copy2(SETTINGS, SETTINGS.with_suffix(".json.bak-pes"))
        d = json.loads(SETTINGS.read_text(encoding="utf-8"))
    d.setdefault("env", {})["LAW_OC"] = k
    SETTINGS.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
    msg = ("Claude Code 설정(env)에 등록 · 법령 API 접속 정상 (법령 API 는 틀린 값에도 응답해 값 자체는 확인할 수 없음 — "
           "발급받은 이메일 ID 앞부분이 맞는지 한 번 더 보세요)" if t else "Claude Code 설정(env)에 등록 (korean-law 미설치라 접속 확인은 나중에)")
    if t and shutil.which("claude") and tool("korean-law-mcp"):
        c, _ = register_mcp(k)
        msg += " · MCP 갱신" if c == 0 else ""
    return True, msg


KEYS = [
    {"id": "kosis", "label": "KOSIS (통계청 국가통계포털) API 키", "check": "key-kosis", "reg": reg_kosis,
     "url": "https://kosis.kr/openapi/",
     "steps": ["kosis.kr/openapi 접속 → 로그인(회원가입)", "상단 '활용신청' → 활용 목적 입력 후 신청", "마이페이지 → 인증키 확인 → 복사"]},
    {"id": "vworld", "label": "VWorld (국가공간정보) API 키", "check": "key-vworld", "reg": reg_vworld,
     "url": "https://www.vworld.kr/dev/v4dv_apikey_s001.do",
     "steps": ["vworld.kr 로그인(회원가입)", "오픈API → 인증키 발급", "서비스 URL 없이(무도메인) · 활용 API 전체 선택 → 발급된 키 복사"]},
    {"id": "law", "label": "법령 API (국가법령정보 공동활용) — LAW_OC", "check": "key-law", "reg": reg_law,
     "url": "https://open.law.go.kr/LSO/openApi/cuAskList.do",
     "steps": ["open.law.go.kr 로그인(회원가입)", "OPEN API → 활용 신청 (법령·판례 등 체크)", "승인 후 이메일 ID 앞부분(@ 앞)이 LAW_OC 값 — 그 값을 입력"]},
]


PAGE = """<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>PES 설치 — API 키</title><style>
:root{--bg:#f7f7f4;--fg:#1f2328;--muted:#6a737d;--card:#fff;--line:#e2e2dc;--accent:#2f6fde;--ok:#2e8b57;--bad:#c0392b;--chip:#efefea}
@media (prefers-color-scheme: dark){:root{--bg:#16181c;--fg:#e6e6e6;--muted:#9aa0a6;--card:#1f2227;--line:#33373d;--accent:#6ea0ff;--ok:#5fcf8f;--bad:#ff7a6b;--chip:#2a2e34;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif}
main{max-width:860px;margin:0 auto;padding:28px 20px 60px}h1{font-size:22px;margin:0 0 4px}.meta{color:var(--muted);font-size:13px}
.st{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 16px;margin:16px 0;display:grid;grid-template-columns:1fr 90px 1.4fr;gap:4px 12px;font-size:13px}
.st b{font-weight:600}.ok{color:var(--ok);font-weight:600}.no{color:var(--bad);font-weight:600}.mu{color:var(--muted)}
.key{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin:12px 0}
.key h2{font-size:16px;margin:0 0 6px}.key ol{margin:6px 0 10px;padding-left:20px;font-size:13px;color:var(--muted)}
.row{display:flex;gap:8px}.row input{flex:1;font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg)}
button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}.res{font-size:13px;margin-top:6px;min-height:1em}
.bar{display:flex;gap:10px;justify-content:flex-end;margin-top:18px}.done{border:2px solid var(--ok)}
</style></head><body><main id="app"></main>
<script id="data" type="application/json">__DATA__</script><script>
const D=JSON.parse(document.getElementById('data').textContent);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ST={ok:['정상','ok'],missing:['없음','no'],user:['직접 설치','no'],optional:['선택','mu'],key:['키 필요','no']};
function render(){document.getElementById('app').innerHTML=`<h1>PES 설치 — API 키 등록</h1>
<div class="meta">키는 이 화면에서 이 컴퓨터의 각 도구 설정으로 바로 등록됩니다. Claude 대화로는 전달되지 않습니다. 필요 없는 기능은 비워 두고 '마치기'를 누르세요.</div>
<div class="st">${D.status.map(s=>`<b>${esc(s.label)}</b><span class="${ST[s.state][1]}">${ST[s.state][0]}</span><span class="mu">${esc(s.detail)}</span>`).join('')}</div>
${D.keys.map(k=>`<div class="key ${k.has?'done':''}" id="k-${k.id}"><h2>${esc(k.label)} ${k.has?'<span class="ok">· 등록되어 있음</span>':''}</h2>
<ol>${k.steps.map(s=>`<li>${esc(s)}</li>`).join('')}</ol><div class="meta" style="margin:-4px 0 8px"><a href="${esc(k.url)}" target="_blank" rel="noopener">발급 페이지 열기</a></div>
<div class="row"><input type="password" autocomplete="off" spellcheck="false" placeholder="${k.has?'새 키를 추가하려면 입력':'발급받은 키 붙여넣기'}" data-k="${k.id}"><button data-show="${k.id}">보기</button><button class="primary" data-reg="${k.id}">등록·확인</button></div>
<div class="res" id="r-${k.id}"></div></div>`).join('')}
<div class="bar"><button class="primary" id="fin">마치기 — Claude 에게 알리기</button></div>`;}
async function post(path,body){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:D.token,...body})});return r.json();}
document.addEventListener('click',async e=>{
 const s=e.target.closest('[data-show]');if(s){const i=document.querySelector(`[data-k="${s.dataset.show}"]`);i.type=i.type==='password'?'text':'password';return;}
 const b=e.target.closest('[data-reg]');if(b){const id=b.dataset.reg,i=document.querySelector(`[data-k="${id}"]`),r=document.getElementById('r-'+id);
  if(!i.value.trim()){r.textContent='키를 입력하세요.';return;}b.disabled=true;r.textContent='확인 중… (최대 1분)';
  try{const j=await post('/key',{id,value:i.value.trim()});r.innerHTML=j.ok?`<span class="ok">${esc(j.msg)}</span>`:`<span class="no">${esc(j.msg)}</span>`;if(j.ok){i.value='';document.getElementById('k-'+id).classList.add('done');}}
  catch{r.innerHTML='<span class="no">보내기 실패</span>';}b.disabled=false;return;}
 if(e.target.id==='fin'){e.target.disabled=true;try{await post('/finish',{});document.getElementById('app').innerHTML='<h1>완료</h1><p>Claude 가 이어서 점검(/pes:doctor)을 진행합니다. 이 창은 닫아도 됩니다.</p>';}catch{e.target.disabled=false;}}
});render();
</script></body></html>"""


def log(line):
    PESDIR.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {line}\n")


def cmd_keys_serve(args):
    token = args[0]
    results = {}

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, body, ctype="application/json; charset=utf-8"):
            b = body.encode("utf-8") if isinstance(body, str) else body
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)

        def do_GET(self):
            if self.path.split("?")[0] == "/ping":
                return self._send(200, '{"ok":true}')
            if self.path != f"/?t={token}":
                return self._send(403, "주소가 바뀌었습니다. Claude 가 알려 준 주소로 다시 여세요.", "text/plain; charset=utf-8")
            st = check()
            have = {x["name"]: x["state"] == "ok" for x in st}
            data = {"token": token, "status": st,
                    "keys": [{k2: v for k2, v in k.items() if k2 != "reg"} | {"has": have.get(k["check"], False)} for k in KEYS]}
            self._send(200, PAGE.replace("__DATA__", json.dumps(data, ensure_ascii=False).replace("</", "<\\/")),
                       "text/html; charset=utf-8")

        def do_POST(self):
            if self.headers.get("Origin") not in (f"http://127.0.0.1:{KEY_PORT}", f"http://localhost:{KEY_PORT}"):
                return self._send(403, '{"ok":false}')
            n = int(self.headers.get("Content-Length") or 0)
            try:
                d = json.loads(self.rfile.read(n) if 0 < n < 8192 else b"{}")
            except Exception:
                d = {}
            if d.get("token") != token:
                return self._send(403, '{"ok":false}')
            if self.path == "/key":
                k = next((x for x in KEYS if x["id"] == d.get("id")), None)
                v = str(d.get("value") or "").strip()
                if not k or not re.fullmatch(r"[A-Za-z0-9+/=_\-.@]{2,200}", v):
                    return self._send(200, json.dumps({"ok": False, "msg": "형식이 맞지 않습니다"}, ensure_ascii=False))
                try:
                    ok, msg = k["reg"](v)
                except Exception as e:
                    ok, msg = False, f"오류: {e}"
                msg = msg.replace(v, mask(v))
                results[k["id"]] = "ok" if ok else "fail"
                log(f"KEY {k['id']} {'ok' if ok else 'fail'}")
                return self._send(200, json.dumps({"ok": ok, "msg": msg}, ensure_ascii=False))
            if self.path == "/finish":
                summ = " ".join(f"{a}={b}" for a, b in results.items()) or "none"
                log(f"SETUP keys {summ}")
                self._send(200, '{"ok":true}')
                time.sleep(0.3)
                os._exit(0)
            return self._send(404, '{"ok":false}')

    srv = ThreadingHTTPServer(("127.0.0.1", KEY_PORT), H)
    srv.timeout = 1
    end = time.time() + 3 * 3600
    while time.time() < end:
        srv.handle_request()
    log("SETUP keys timeout")


def cmd_keys(args):
    PESDIR.mkdir(parents=True, exist_ok=True)
    if pes.port_busy(KEY_PORT):
        try:  # 예전에 띄운 화면이 남아 있으면 끝낸다
            info = json.loads((PESDIR / "setup-keys.json").read_text(encoding="utf-8"))
            pes.kill_pid(info.get("pid"))
            time.sleep(0.5)
        except Exception:
            pass
    if pes.port_busy(KEY_PORT):
        pes.die(f"포트 {KEY_PORT} 사용 중 — 다른 프로그램을 끄거나 잠시 뒤 다시")
    token = secrets.token_urlsafe(16)
    out = open(PESDIR / "setup-keys.out", "a", encoding="utf-8")
    pr = pes.spawn([sys.executable, "-I", str(Path(__file__).resolve()), "keys-serve", token], out)
    (PESDIR / "setup-keys.json").write_text(json.dumps({"pid": pr.pid}), encoding="utf-8")
    url = f"http://127.0.0.1:{KEY_PORT}/?t={token}"
    for _ in range(40):
        if pes.port_busy(KEY_PORT):
            break
        time.sleep(0.1)
    start = LOG.stat().st_size if LOG.exists() else 0
    if "--no-open" not in args:
        webbrowser.open(url)
    print(url, flush=True)
    if "--wait" not in args:
        print(f"WATCH tail -n0 -F {LOG.as_posix()} | grep --line-buffered 'SETUP keys'")
        return
    print("브라우저의 API 키 화면에서 '마치기'를 누르면 이어서 진행합니다 (건너뛰려면 Ctrl+C).", flush=True)
    try:
        while True:
            time.sleep(1)
            if LOG.exists() and LOG.stat().st_size > start:
                with LOG.open(encoding="utf-8") as fh:
                    fh.seek(start)
                    new = [l for l in fh.read().splitlines() if "SETUP keys" in l]
                if new:
                    print(new[-1].split(" ", 2)[-1])
                    return
    except KeyboardInterrupt:
        print("API 키 입력을 건너뜀 — 나중에 /pes:setup keys")


def cmd_check(args):
    st = check()
    if "--json" in args:
        print(json.dumps(st, ensure_ascii=False, indent=1))
        return
    M = {"ok": "[정상]", "missing": "[없음]", "user": "[직접]", "optional": "[선택]", "key": "[키 필요]"}
    g = None
    for x in st:
        if x["group"] != g:
            g = x["group"]
            print(f"■ {g}")
        print(f"  {M[x['state']]} {x['label']}" + (f" — {x['detail']}" if x["detail"] else ""))


def cmd_mark(args):
    PESDIR.mkdir(parents=True, exist_ok=True)
    st = check()
    MARK.write_text(json.dumps({"version": VERSION, "time": time.strftime("%Y-%m-%d %H:%M"),
                                "state": {x["name"]: x["state"] for x in st}}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"설치 완료 표시: {MARK} (PES {VERSION})")


def cmd_needed(args):
    try:
        m = json.loads(MARK.read_text(encoding="utf-8"))
    except Exception:
        print("PES 설치 점검을 한 적이 없습니다 — /pes:setup")
        sys.exit(1)
    if m.get("version") != VERSION:
        print(f"PES 가 {m.get('version')} → {VERSION} 로 바뀌었습니다 — /pes:setup 으로 다시 점검")
        sys.exit(1)
    print("OK")


CMDS = {"check": cmd_check, "install": cmd_install, "upgrade": cmd_upgrade, "keys": cmd_keys, "keys-serve": cmd_keys_serve,
        "mark": cmd_mark, "needed": cmd_needed}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in CMDS:
        print(__doc__)
        sys.exit(1)
    CMDS[sys.argv[1]](sys.argv[2:])
