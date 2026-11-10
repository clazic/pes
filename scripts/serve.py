#!/usr/bin/env python3
"""PES 로컬 서버 (포트 하나): PES 홈 폴더 전체를 127.0.0.1 에서 서빙한다.

사용: python3 -I serve.py <PES 홈 폴더> [포트=8760]   (보통 pes.py serve / hub 로 띄운다)
 - GET /                  → 프로젝트 목록 (index.html)
 - GET /<slug>/           → 그 프로젝트 대시보드 (index.html, 없으면 가장 최근 질문 폼)
 - GET /ping, /<slug>/ping → {"ok": true}
 - GET /whoami            → {"root": "<홈 폴더>"}  (pes.py 가 같은 홈의 서버인지 확인)
 - POST /<slug>/feedback  {"stage", "round", "kind", "text", "answers", ...}
   → <slug>/feedback/<stage>-R<round>-<시각>.json 저장, <slug>/feedback.log 에 "FEEDBACK <stage> R<round> <kind> <경로>" 한 줄
   (PES_DB_CORE=1 이고 그 프로젝트가 DB 에 있으면: 파일 대신 코어 명령 서비스에 사람 제출 한 번 — feedback.log 줄만 남는다)
 - 홈 폴더 자체가 프로젝트면(예전 방식) POST /feedback 도 받는다. 0.8 이전 화면의 POST /feedback 은 Referer 로 프로젝트를 찾는다
   (그 프로젝트가 DB 에 있으면 위와 같이 DB 제출 — 폴더에 쓰지 않는다).
 - 다른 출처(Origin)의 POST 는 거부한다.
"""
import base64
import hashlib
import json
import os
import re
import shutil
import math
import socketserver
import subprocess
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

MAX_BODY = 256 * 1024
MAX_API_BODY = 2 * MAX_BODY
# 쿼리스트링 상한(서명된 cursor 와 limit·wait_ms 가 들어가기에 넉넉하고, 브리지 stdin 이 부풀지 않게 하는 값).
MAX_API_QUERY = 2048
# 상한을 넘는 본문이라도 이 크기 안이면 읽어 버린 뒤 413 을 보낸다(보내는 중인 클라이언트가 끊기지 않게).
DRAIN_LIMIT = 8 * 1024 * 1024
DRAIN_CHUNK = 64 * 1024
DRAIN_IO_TIMEOUT = 10
NODE_BRIDGE = Path(__file__).resolve().parent / "pes_core" / "api_bridge.ts"
CLI_BRIDGE = Path(__file__).resolve().parent / "pes_core" / "cli_bridge.ts"
# 같은 주소로 서빙하는 DB 화면 보고서 파일의 종류 (확장자 → Content-Type)
REPORT_TYPES = {".html": "text/html; charset=utf-8", ".md": "text/plain; charset=utf-8", ".json": "application/json; charset=utf-8"}
ROUTE_TTL = 2.0

# 서버가 직접 내는 API 오류의 한국어 message 와 next_action (Node ApiApp 의 봉투와 같은 규칙).
_API_ERROR_TEXT = {
    "forbidden": ("이 요청은 허용되지 않습니다.", "use_owner_session"),
    "invalid_payload": ("요청 내용이 올바르지 않습니다.", "fix_request"),
    "payload_too_large": ("요청 본문이 너무 큽니다.", "fix_request"),
    "internal_error": ("서버 안에서 문제가 생겼습니다. 잠시 뒤 다시 시도해 주세요.", "retry_later"),
    "schema_not_ready": ("PES 데이터베이스가 아직 준비되지 않았습니다.", "migrate_database"),
    "rate_limited": ("요청이 너무 잦습니다. 잠시 뒤 다시 시도해 주세요.", "retry_after"),
}
# 상주 프로세스인 이 서버만 요청 예산을 기억한다(브리지는 요청마다 새 Node 프로세스다).
# 한도 숫자와 제어·poll 경로는 Node ApiApp.budget_policy() 가 한곳에서 정해 `--limits` 로 내준다.
_API_PATH = re.compile(r"/api/v1(/.*)?")
_API_PROJECT_PATH = re.compile(r"/api/v1/projects/[^/]+/.*")
_BEARER = re.compile(r"\s*bearer\s+(.*?)\s*", re.IGNORECASE | re.DOTALL)
_BUDGET_MAX_KEYS = 20000


def _route_pattern(template):
    """"GET /api/v1/projects/{id}/x" -> (method, compiled path regex)."""
    method, path = template.split(" ", 1)
    parts = re.split(r"\{[a-z_]+\}", path)
    return method, re.compile("[^/]+".join(re.escape(part) for part in parts))


# 시험 전용 조이기 변수: 환경 변수에 JSON 객체를 주면 Node 가 내준 요청 개수 한도를 더 작게만 덮어쓴다(풀 수는 없다).
# 받는 키는 개수 4종뿐이다. window_ms·min_poll_interval_ms 는 줄이면 오히려 한도가 풀리므로 받지 않는다(모르는 키로 거부).
# 변수가 없으면 아무것도 바뀌지 않는다. 잘못된 값은 조용히 무시하지 않고 서버를 띄우지 않는다.
BUDGET_OVERRIDE_ENV = "PES_API_BUDGET_TEST_OVERRIDE"
_BUDGET_OVERRIDE_KEYS = (
    "agent_requests_per_minute",
    "agent_control_requests_per_minute",
    "owner_requests_per_minute",
    "coarse_requests_per_minute",
)


def _parse_budget_override(raw):
    """Returns None (변수 없음) or a validated {key: positive int}. Raises ValueError with a clear message."""
    if raw is None:
        return None
    name = BUDGET_OVERRIDE_ENV
    try:
        value = json.loads(raw)
    except ValueError as err:
        raise ValueError(f"{name}: JSON 이 아닙니다 ({err})")
    if not isinstance(value, dict):
        raise ValueError(f"{name}: JSON 객체여야 합니다")
    unknown = sorted(k for k in value if k not in _BUDGET_OVERRIDE_KEYS)
    if unknown:
        raise ValueError(f"{name}: 모르는 키 {', '.join(unknown)} (받는 키: {', '.join(_BUDGET_OVERRIDE_KEYS)})")
    for key, number in value.items():
        if isinstance(number, bool) or not isinstance(number, int) or number <= 0:
            raise ValueError(f"{name}: {key} 는 양의 정수여야 합니다 (받은 값: {number!r})")
    return value


def _apply_budget_override(policy, override):
    """Node 정책에 조이기 덮어쓰기를 적용한 새 정책. 기본값보다 큰 값은 ValueError (더 조이기만 가능)."""
    if not override:
        return policy
    merged = dict(policy)
    for key, number in override.items():
        default = int(policy[key])
        if number > default:
            raise ValueError(f"{BUDGET_OVERRIDE_ENV}: {key}={number} 는 기본값 {default} 보다 큽니다 (더 조이기만 할 수 있습니다)")
        merged[key] = number
    return merged


def _digest(value):
    # 자격 원문은 저장하지 않고 sha256 만 키로 쓴다.
    return hashlib.sha256(value.encode("utf-8", "surrogatepass")).hexdigest()


class ApiBudget:
    """자격(Authorization 또는 x-pes-session)의 sha256 단위 요청 예산과 inputs 최소 poll 간격.

    모든 /api/v1 요청(프로젝트 밖 경로 포함)이 예산을 거친다. 자격이 없거나 아직 한 번도 통과(401 이 아닌
    프로젝트 경로 응답)하지 않은 자격의 요청은 서버 전체에 하나뿐인 거친 버킷도 함께 쓴다. 그래서 매번 다른
    가짜 자격을 보내도 Node 를 띄우는 횟수는 거친 상한을 넘지 않는다. 한도 숫자는 budget_policy() 한 곳에서 온다.
    """

    def __init__(self, policy):
        self.window_ms = int(policy["window_ms"])
        self.agent = int(policy["agent_requests_per_minute"])
        self.agent_control = int(policy["agent_control_requests_per_minute"])
        self.owner = int(policy["owner_requests_per_minute"])
        self.poll_gap_ms = int(policy["min_poll_interval_ms"])
        # 자격 없는·검증 안 된 자격의 요청 전체, 그리고 자격마다 환불된(형식이 틀린) 요청이 쓰는 거친 상한.
        self.coarse = int(policy["coarse_requests_per_minute"])
        self.control_routes = [_route_pattern(t) for t in policy["control_routes"]]
        self.poll_routes = [_route_pattern(t) for t in policy["poll_routes"]]
        self.refund_codes = set(policy["refund_codes"])
        self._hits = {}
        self._polls = {}
        # 프로젝트 경로에서 401 이 아닌 응답을 받은 자격 digest -> 마지막으로 본 시각.
        self._verified = {}
        self._lock = threading.Lock()

    @staticmethod
    def _now():
        return int(time.monotonic() * 1000)

    @staticmethod
    def _matches(routes, method, path):
        return any(m == method and r.fullmatch(path) for m, r in routes)

    def _credential(self, headers):
        session = headers.get("x-pes-session")
        if session:
            return "session", _digest(session)
        auth = headers.get("authorization")
        if auth:
            bearer = _BEARER.fullmatch(auth)
            return "token", _digest(bearer.group(1) if bearer else auth)
        return None

    def _window(self, key, now):
        """`key` 의 창 안 시각만 남겨 저장하고 돌려준다. Caller holds the lock."""
        hits = [at for at in self._hits.get(key, []) if at > now - self.window_ms]
        if hits:
            self._hits[key] = hits
        else:
            self._hits.pop(key, None)
        return hits

    def _prune(self, now):
        if len(self._hits) > _BUDGET_MAX_KEYS:
            for key in [k for k, hits in self._hits.items() if not hits or hits[-1] <= now - self.window_ms]:
                del self._hits[key]
            if len(self._hits) > _BUDGET_MAX_KEYS:
                oldest = sorted(self._hits, key=lambda k: self._hits[k][-1])
                for key in oldest[: len(self._hits) - _BUDGET_MAX_KEYS // 2]:
                    del self._hits[key]
        if len(self._polls) > _BUDGET_MAX_KEYS:
            for key in [k for k, at in self._polls.items() if at + self.poll_gap_ms <= now]:
                del self._polls[key]
            if len(self._polls) > _BUDGET_MAX_KEYS:
                self._polls.clear()
        if len(self._verified) > _BUDGET_MAX_KEYS:
            oldest = sorted(self._verified, key=self._verified.get)
            for digest in oldest[: len(self._verified) - _BUDGET_MAX_KEYS // 2]:
                del self._verified[digest]

    def admit(self, method, path, headers):
        """Returns (ticket, rejection). rejection is (scope, retry_after_ms); ticket is passed to settle()."""
        if not _API_PATH.fullmatch(path):
            return None, None
        cred = self._credential(headers)
        now = self._now()
        with self._lock:
            self._prune(now)
            if cred is None or cred[1] not in self._verified:
                # 자격이 없거나 검증 안 된 자격: 결국 401 일 수 있지만 요청마다 Node 를 띄우므로 서버 전체 버킷 하나로 묶는다.
                rejection = self._take("unverified", self.coarse, "coarse", now)
                if rejection is not None or cred is None:
                    return None, rejection
            kind, digest = cred
            # 환불받은 요청도 자격마다 거친 상한까지만 공짜다 (창 밖 환불 시각은 매번 버린다).
            refunds = self._window(f"refund:{digest}", now)
            if len(refunds) >= self.coarse:
                return None, ("refund", min(self.window_ms, max(1, refunds[0] + self.window_ms - now)))
            if kind == "session":
                scope, limit, key = "session", self.owner, f"session:{digest}"
            else:
                scope = "control" if self._matches(self.control_routes, method, path) else "general"
                limit = self.agent_control if scope == "control" else self.agent
                key = f"token:{digest}:{scope}"
            rejection = self._take(key, limit, scope, now)
            if rejection is not None:
                return None, rejection
            poll_key = None
            if kind == "token" and self._matches(self.poll_routes, method, path):
                poll_key = f"{digest}:{path}"
                last = self._polls.get(poll_key)
                if last is not None and last + self.poll_gap_ms - now > 0:
                    return None, ("poll", min(self.poll_gap_ms, last + self.poll_gap_ms - now))
        project = bool(_API_PROJECT_PATH.fullmatch(path))
        return (key, now, poll_key, digest, project), None

    def _take(self, key, limit, scope, now):
        """Count one hit on `key`; returns the rejection (scope, retry_after_ms) when full. Caller holds the lock."""
        hits = self._window(key, now)
        if len(hits) >= limit:
            return scope, min(self.window_ms, max(1, hits[0] + self.window_ms - now))
        hits.append(now)
        self._hits[key] = hits
        return None

    def settle(self, ticket, status, payload, verified=False):
        """Give the slot back for a request refused over its own input; note empty polls and proven credentials.

        `verified` 는 Node 브리지의 내부 표지다: 이 요청에서 자격 검증을 통과했을 때만 True.
        인증 전에 나오는 404(라우트)·405·401·자격 확인 전 입력 오류(400)는 False 라서 가짜 자격을 '검증됨'으로 올리지 않는다.
        Node 의 429 는 자격 확인 뒤에 나므로 True 다.
        """
        if ticket is None:
            return
        key, at, poll_key, digest, _project = ticket
        code, inputs = None, None
        if status >= 400 or poll_key is not None:
            try:
                doc = json.loads(payload.decode("utf-8"))
                if status >= 400:
                    code = doc["error"]["code"]
                else:
                    inputs = doc["data"]["inputs"]
            except (UnicodeDecodeError, ValueError, KeyError, TypeError):
                pass
        with self._lock:
            now = self._now()
            if verified and status != 401:
                self._verified[digest] = now
            elif status == 401:
                self._verified.pop(digest, None)
            if code in self.refund_codes:
                hits = self._hits.get(key)
                if hits and at in hits:
                    hits.remove(at)
                    refunds = self._window(f"refund:{digest}", now)
                    refunds.append(at)
                    self._hits[f"refund:{digest}"] = refunds
            if poll_key is not None and status == 200:
                if isinstance(inputs, list) and len(inputs) == 0:
                    self._polls[poll_key] = now
                else:
                    self._polls.pop(poll_key, None)

KINDS = {"feedback", "review", "stage_start", "approve", "resume", "reopen"}
SLUG = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,80}")
# feedback.log 한 줄이 이 서버 프로세스의 요청 스레드 사이에서 섞이지 않게 한다.
# 프로세스 사이(서버 두 개, pes.py 동시 쓰기)에는 걸리지 않는다.
FEEDBACK_LOG_LOCK = threading.Lock()


class LocalHTTPServer(ThreadingHTTPServer):
    """역DNS(getfqdn) 조회 없이 bind 하는 로컬 서버 (SEL-33).

    HTTPServer.server_bind() 는 socket.getfqdn() 으로 server_name 을 정하는데,
    일부 macOS 러너에서 이 역DNS가 30초 넘게 걸려 서버가 기동하지 못한다
    (actions/runner-images#12162). serve.py 는 server_name 을 쓰지 않으므로
    host 주소를 그대로 쓴다.
    """

    # listen() 대기열. Python 3.14 이하의 socketserver 기본값은 5 라서, 같은 순간에 여러 탭·요청이 붙으면
    # 6번째부터 연결이 거절된다(Windows ECONNREFUSED, macOS ECONNRESET) — 보낸 답이 사라진다. 3.15 기본값과 같은 128.
    request_queue_size = 128

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # The API database is migrated lazily on the first API request that
        # reaches the bridge (a GET, which has no Origin check, also does it).
        # A cross-origin POST rejected by the origin check must not create
        # ~/.pes or the database file. Only a successful migrate is cached.
        self.api_db_ready = False
        self.api_db_lock = threading.Lock()
        self.api_budget = None
        # 시험 전용 조이기 변수(main 이 시작 때 검증한 값). 없으면 None.
        self.api_budget_override = None

    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = host
        self.server_port = port


def cli_bridge(op, slug=None, args=None, timeout=60):
    """pes_core/cli_bridge.ts 를 한 번 부른다 (DB 화면 경로 — 자격 없음 = 이 컴퓨터 DB 의 사람 소유자).
    돌려주는 것: 코어의 답 dict({ok, data} | {ok:false, code, message}). 프로세스가 실패하면 None."""
    node = shutil.which("node")
    if node is None:
        return None
    request = {"op": op, "slug": slug, "session": None, "token": None, "args": args or {}}
    try:
        proc = subprocess.run([node, "--no-warnings", str(CLI_BRIDGE)], input=json.dumps(request).encode("utf-8"),
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        res = json.loads(proc.stdout.decode("utf-8").strip().splitlines()[-1])
    except (OSError, subprocess.SubprocessError, IndexError, ValueError):
        return None
    return res if isinstance(res, dict) and isinstance(res.get("ok"), bool) else None


_PES_MODULE = None


def pes_module():
    """scripts/pes.py 를 모듈로 불러 화면 짓기(fill·허브·대시보드)를 한 곳에서 쓴다. PES_DB_CORE=1 일 때만 부른다."""
    global _PES_MODULE
    if _PES_MODULE is None:
        import importlib.util
        spec = importlib.util.spec_from_file_location("pes_cli", Path(__file__).resolve().parent / "pes.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _PES_MODULE = module
    return _PES_MODULE


MAX_JSON_DEPTH = 200
SAFE_INT = 2 ** 53 - 1


def json_depth_exceeds(value, limit=MAX_JSON_DEPTH):
    """중첩 깊이가 limit 을 넘는지 — 재귀 없이 센다 (깊은 JSON 이 스택·직렬화를 터뜨리지 않도록 DB 길 입구에서 거른다)."""
    stack = [(value, 1)]
    while stack:
        v, depth = stack.pop()
        if isinstance(v, (dict, list)):
            if depth > limit:
                return True
            for child in (v.values() if isinstance(v, dict) else v):
                if isinstance(child, (dict, list)):
                    stack.append((child, depth + 1))
    return False


def main():
    root = Path(sys.argv[1]).resolve()
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8760
    allowed = {f"http://127.0.0.1:{port}", f"http://localhost:{port}"}
    CONFIG = Path.home() / ".pes" / "config.json"
    db_mode = os.environ.get("PES_DB_CORE") == "1"
    if db_mode:
        # 이 서버가 서빙하는 홈이 곧 PES 홈이다. 화면의 읽기·쓰기는 늘 이 컴퓨터 DB 의 사람 소유자 몫이므로 자격 환경변수는 지운다.
        os.environ["PES_HOME"] = str(root)
        os.environ.pop("PES_TOKEN", None)
        os.environ.pop("PES_OWNER", None)
    routes = {}

    def db_route(slug):
        """'database'(DB 가 서빙) | 'none'(DB 에 없음·아직 active 아님 → 옛 project.json) | None(DB 를 읽지 못함). 잠깐 기억한다."""
        if not db_mode or not SLUG.fullmatch(slug or ""):
            return "none"
        hit = routes.get(slug)
        if hit is not None and time.monotonic() - hit[0] < ROUTE_TTL:
            return hit[1]
        res = cli_bridge("route", slug)
        if res is None or not res["ok"]:
            return None
        serving = "database" if res["data"].get("serving") == "database" else "none"
        routes[slug] = (time.monotonic(), serving)
        return serving

    def trusted():
        """~/.pes/config.json 의 trusted_origins (예: Tailscale serve 주소) — 그 주소에서 연 화면도 답을 보낼 수 있다."""
        try:
            return set(json.loads(CONFIG.read_text(encoding="utf-8")).get("trusted_origins") or [])
        except Exception:
            return set()

    def project_of(path: str):
        """'/<slug>/...' → (프로젝트 폴더, 나머지 경로). 홈 자체가 프로젝트면 '/...' 도."""
        parts = [p for p in unquote(urlsplit(path).path).split("/") if p]
        if parts and SLUG.fullmatch(parts[0]) and (root / parts[0] / "project.json").exists():
            return root / parts[0], parts[1:]
        if (root / "project.json").exists():
            return root, parts
        return None, parts

    class H(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(root), **kw)

        def log_message(self, *a):
            pass

        def guess_type(self, path):
            p = str(path).lower()
            if p.endswith((".md", ".markdown", ".txt", ".log")):
                return "text/plain; charset=utf-8"
            t = super().guess_type(path)
            if t.startswith("text/") or t in ("application/json", "application/javascript", "image/svg+xml"):
                return t + "; charset=utf-8"
            return t

        def end_headers(self):
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def _json(self, code, obj, cors=False, close=False, extra_headers=None):
            body = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(code)
            o = self.headers.get("Origin") or ""
            if cors and re.fullmatch(r"http://(127\.0\.0\.1|localhost):87\d\d", o):
                self.send_header("Access-Control-Allow-Origin", o)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            for name, value in (extra_headers or {}).items():
                self.send_header(name, value)
            if close:
                self.send_header("Connection", "close")
                self.close_connection = True
            self.end_headers()
            self._send_body(body)

        def _send_body(self, body):
            if not getattr(self, "_head_only", False):  # HEAD: 머리글만 (DB 화면은 GET 과 같은 길이를 알린다)
                self.wfile.write(body)

        def _reject_oversize(self, length, respond):
            """상한을 넘는 본문 거부: 드레인 한도 안이면 남은 본문을 읽어 버린 뒤 413, 넘으면 바로 413 후 닫는다."""
            self.close_connection = True
            if 0 < length <= DRAIN_LIMIT:
                try:
                    self.connection.settimeout(DRAIN_IO_TIMEOUT)
                    left = length
                    while left > 0:
                        chunk = self.rfile.read(min(DRAIN_CHUNK, left))
                        if not chunk:
                            return None
                        left -= len(chunk)
                except (OSError, ValueError):
                    return None
            try:
                return respond()
            except OSError:
                return None

        def list_directory(self, path):  # 폴더 목록은 보여 주지 않는다
            self.send_error(404)
            return None

        def _redirect(self, to):
            self.send_response(302)
            self.send_header("Location", to)
            self.end_headers()

        def _api_error(self, code, message, status, close=False, details=None, extra_headers=None, target=None):
            # 봉투는 Node 쪽 ApiApp 과 같다: 한국어 message, retryable(503·429 만 true),
            # next_action 은 늘 문자열. 영어 message 인자는 기록용이라 응답에 싣지 않는다.
            ko, next_action = _API_ERROR_TEXT.get(code, _API_ERROR_TEXT["internal_error"])
            request_id = f"serve-{time.time_ns()}"
            return self._json(status, {
                "format_version": "1.0",
                "error": {
                    "code": code,
                    "message": ko,
                    "retryable": status in (429, 503),
                    "target": target,
                    "details": details,
                    "next_action": next_action,
                },
                "request_id": request_id,
            }, close=close, extra_headers={"x-request-id": request_id, **(extra_headers or {})})

        def _origin_allowed(self):
            origin = self.headers.get("Origin") or ""
            return origin == "" or origin in allowed or origin in trusted()

        def _ensure_api_db(self):
            """Migrate the API database once, on the first accepted API request."""
            srv = self.server
            if srv.api_db_ready:
                return None
            with srv.api_db_lock:
                if srv.api_db_ready:
                    return None
                node = shutil.which("node")
                if node is None:
                    return ("internal_error", "internal error", 500)
                failed = ("schema_not_ready", "the PES database could not be migrated", 503)
                try:
                    proc = subprocess.run(
                        [node, str(NODE_BRIDGE), "--migrate"],
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        timeout=60,
                    )
                except (OSError, subprocess.SubprocessError):
                    return failed
                if proc.returncode != 0:
                    return failed
                try:
                    limits = subprocess.run(
                        [node, str(NODE_BRIDGE), "--limits"],
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        timeout=60,
                    )
                    if limits.returncode != 0:
                        return failed
                    policy = json.loads(limits.stdout.decode("utf-8"))
                    srv.api_budget = ApiBudget(_apply_budget_override(policy, srv.api_budget_override))
                except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError):
                    return failed
                srv.api_db_ready = True
                return None

        def _api_query(self, query):
            """쿼리스트링 검사: 길이 상한과 올바른 퍼센트 인코딩(UTF-8). 문제가 있으면 400 봉투를 돌려준다."""
            if query == "":
                return None
            bad = len(query) > MAX_API_QUERY or any(not (0x21 <= ord(c) <= 0x7E) for c in query)
            if not bad:
                try:
                    unquote(query, errors="strict")
                except UnicodeDecodeError:
                    bad = True
            if bad:
                return self._api_error("invalid_payload", "the query string is invalid", 400, target="$.query")
            return None

        def _api(self, method, path, query=""):
            """Pass /api/v1/* to the Node ApiApp and relay its raw response.

            The Python server keeps its static-file and feedback duties; the API
            contract, credentials, transactions, and envelopes live in Node.
            `path` 는 경로만이다(요청 예산 키·라우트 판정에 쓴다). `query` 는 브리지·ApiApp 이
            받는 `경로?쿼리` 형식으로 이어 붙여 넘길 뿐 예산 키에는 들어가지 않는다.
            """
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except (TypeError, ValueError):
                length = 0
            if length < 0 or length > MAX_API_BODY:
                return self._reject_oversize(length, lambda: self._api_error(
                    "payload_too_large", "the request body is too large", 413, close=True))
            body = self.rfile.read(length) if length > 0 else b""
            if query != "":
                refused = self._api_query(query)
                if refused is not None:
                    return refused
            migration_error = self._ensure_api_db()
            if migration_error is not None:
                return self._api_error(*migration_error)
            node = shutil.which("node")
            if node is None:
                return self._api_error("internal_error", "internal error", 500)
            headers_in = {name.lower(): value for name, value in self.headers.items()}
            ticket, rejected = self.server.api_budget.admit(method, path, headers_in)
            if rejected is not None:
                scope, retry_after_ms = rejected
                return self._api_error(
                    "rate_limited", "too many requests", 429,
                    details={"retry_after_ms": retry_after_ms, "scope": scope},
                    extra_headers={"retry-after": str(max(1, math.ceil(retry_after_ms / 1000)))})
            request = {
                "method": method,
                "path": f"{path}?{query}" if query != "" else path,
                "headers": headers_in,
                "body_b64": base64.b64encode(body).decode("ascii"),
            }
            try:
                proc = subprocess.run(
                    [node, str(NODE_BRIDGE)],
                    input=json.dumps(request).encode("utf-8"),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    timeout=60,
                )
            except (OSError, subprocess.SubprocessError):
                return self._api_error("internal_error", "internal error", 500)
            if proc.returncode != 0:
                return self._api_error("internal_error", "internal error", 500)
            try:
                response = json.loads(proc.stdout.decode("utf-8"))
                status = int(response["status"])
                headers = response.get("headers") or {}
                payload = base64.b64decode(response.get("body_b64") or "")
                # 내부 표지(응답 본문·헤더 밖의 필드): Node 가 자격 검증을 끝냈을 때만 true. 클라이언트에는 보내지 않는다.
                verified = response.get("credential_verified") is True
            except (KeyError, TypeError, ValueError, json.JSONDecodeError):
                return self._api_error("internal_error", "internal error", 500)
            self.server.api_budget.settle(ticket, status, payload, verified=verified)
            self.send_response(status)
            for name, value in headers.items():
                if name.lower() in ("content-length", "connection", "transfer-encoding"):
                    continue
                name, value = str(name), str(value)
                if not name or any(c in name for c in "\r\n\0:") or any(c in value for c in "\r\n\0"):
                    continue
                self.send_header(name, value)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            if payload:
                self.wfile.write(payload)
            return None

        def _is_api_path(self, path):
            return path == "/api/v1" or path.startswith("/api/v1/")

        def _html(self, code, text, content_type="text/html; charset=utf-8"):
            body = text.encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self._send_body(body)

        def _db_down(self):
            return self._json(503, {"ok": False, "error": "db"})

        def _db_get(self, path):
            """PES_DB_CORE=1: DB 가 서빙하는 프로젝트의 화면. 처리했으면 그 결과를, 이 길이 아니면 False 를 돌려준다.
            /api/v1 은 이 앞에서 이미 갈라졌다. 옛 project.json 프로젝트와 정적 파일(ask-*.html 등)은 v0.15 길 그대로다."""
            parts = [p for p in unquote(path).split("/") if p]
            if path == "/version":  # 홈 목록: 어느 프로젝트든 바뀌면 커진다
                res = cli_bridge("version")
                return self._json(200, {"v": int(res["data"]["v"]) if res is not None and res["ok"] else 0})
            if not parts or parts == ["index.html"]:  # 홈: 허브 열기·ask 안내·보고서 링크가 /index.html 로도 온다 — 낡은 정적 파일을 내지 않는다
                if (root / "project.json").exists():  # 예전 방식(홈 폴더 자체가 프로젝트)은 v0.15 길 그대로
                    return False
                if (root / "index.html").exists() or any(f.is_dir() for f in root.iterdir()):
                    try:
                        return self._html(200, pes_module().db_hub_html(root))
                    except SystemExit:
                        return self._db_down()
                return False
            slug = parts[0]
            if not SLUG.fullmatch(slug) or slug in ("ping", "whoami"):
                return False
            tail = parts[1:]
            if tail in (["version"], ["ping"], ["index.html"]) or (tail and tail[0] in ("reports", "out")) or not tail:
                serving = db_route(slug)
                if serving is None:
                    return self._db_down()
                if serving != "database":
                    return False
            else:
                return False
            d = root / slug
            if tail == ["ping"]:
                return self._json(200, {"ok": True})
            if tail == ["version"]:
                res = cli_bridge("version", slug)
                if res is None or not res["ok"]:
                    return self._db_down()
                return self._json(200, {"v": int(res["data"]["v"])})
            if not tail or tail == ["index.html"]:
                if not tail:  # 처음 render 전 ask 리다이렉트는 /<slug>/ 에만 — /<slug>/index.html 은 늘 대시보드
                    base = f"/{slug}/"
                    if path != base:
                        return self._redirect(base)
                    if not (d / "index.html").exists():
                        asks = sorted(d.glob("ask-*.html"), key=lambda p: p.stat().st_mtime) if d.exists() else []
                        if asks:
                            return self._redirect(base + asks[-1].name)
                try:
                    return self._html(200, pes_module().db_dashboard_html(d))
                except SystemExit:
                    return self._db_down()
            # 보고서·eli5·최종 보고서: 폴더 파일이 아니라 DB 의 렌더 결과 (같은 주소)
            res = cli_bridge("report_file", slug, {"path": "/".join(tail)})
            if res is None:
                return self._db_down()
            if not res["ok"]:
                return self._json(404, {"ok": False}) if res.get("code") == "not_found" else self._db_down()
            name = res["data"]["name"]
            body = base64.b64decode(res["data"]["bytes_b64"])
            ctype = REPORT_TYPES.get(os.path.splitext(name)[1].lower(), "application/octet-stream")
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self._send_body(body)
            return None

        def do_HEAD(self):
            if db_mode:  # DB 가 짓는 화면의 HEAD 는 GET 과 같은 머리글(낡은 정적 파일의 길이가 아니다)
                path = urlsplit(self.path).path
                if not self._is_api_path(path) and path != "/whoami":
                    self._head_only = True
                    handled = self._db_get(path)
                    if handled is not False:
                        return handled
                    self._head_only = False
            return super().do_HEAD()

        def do_GET(self):
            parts = urlsplit(self.path)
            path = parts.path
            if self._is_api_path(path):
                return self._api("GET", path, parts.query)
            if path == "/whoami":
                return self._json(200, {"root": str(root), "single": True}, cors=True)
            if db_mode:
                handled = self._db_get(path)
                if handled is not False:
                    return handled
            if path == "/version" or path.endswith("/version"):  # 열린 화면이 새 결과를 알아채도록 (index.html·ask-*.html 수정 시각)
                d0, _ = project_of(path[: -len("version")] or "/")
                base = d0 if d0 is not None else root
                fs = [base / "index.html", *base.glob("ask-*.html")]
                return self._json(200, {"v": max([int(f.stat().st_mtime) for f in fs if f.exists()] or [0])})
            if path == "/ping" or path.endswith("/ping"):
                return self._json(200, {"ok": True})
            d, rest = project_of(path)
            if d is not None and not rest:
                base = "/" if d == root else f"/{d.name}/"
                if path != base:
                    return self._redirect(base)
                if not (d / "index.html").exists():
                    asks = sorted(d.glob("ask-*.html"), key=lambda p: p.stat().st_mtime)
                    if asks:
                        return self._redirect(base + asks[-1].name)
            return super().do_GET()

        def _db_feedback(self, d, slug, data, stage, rnd, kind, text, answers, origin):
            """DB 프로젝트의 답: 파일을 쓰지 않고 코어 명령 서비스에 사람 제출 한 번. 알림(feedback.log) 한 줄만 남긴다."""
            res = cli_bridge("web_feedback", slug, {
                "stage": stage, "round": rnd, "kind": kind, "text": text, "answers": answers,
                "spec": str(data.get("spec", ""))[:1024], "set_id": data.get("set_id") if isinstance(data.get("set_id"), str) else None,
                "via": "html" if origin in allowed else "remote", "origin": origin,
                "who": self.headers.get("Tailscale-User-Login") or ""})
            if res is None:
                return self._db_down()
            if not res["ok"]:
                code = res.get("code")
                if code == "form_revised":
                    return self._json(409, {"ok": False, "error": "conflict", "message": "질문이 바뀌었습니다 — 화면을 새로 불러온 뒤 다시 보내세요"})
                if code == "conflict":
                    return self._db_down()
                if code in ("invalid_payload", "unknown_command"):
                    return self._json(400, {"ok": False})
                if code == "not_found":
                    return self._json(404, {"ok": False})
                return self._db_down()
            name = res["data"]["name"]
            d.mkdir(parents=True, exist_ok=True)
            with FEEDBACK_LOG_LOCK:
                with (d / "feedback.log").open("a", encoding="utf-8") as f:
                    f.write(f"FEEDBACK {res['data'].get('stage') or stage} R{rnd} {kind} {name}\n")  # 폴더에 파일이 없다: 읽을 이름 (pes pending <프로젝트> --show <이름>)
            v = res["data"].get("v")
            return self._json(200, {"ok": True, "file": name, **({"v": v} if isinstance(v, int) else {})})

        def do_POST(self):
            path = urlsplit(self.path).path
            if self._is_api_path(path):
                if not self._origin_allowed():
                    return self._api_error("forbidden", "origin is not allowed", 403)
                return self._api("POST", path, urlsplit(self.path).query)
            d, rest = project_of(path)
            db_slug = None
            if db_mode:
                # 답을 받을 프로젝트를 먼저 정한다: '/<slug>/feedback' 은 그 slug, 호환 별칭 '/feedback'(0.8 이전 화면)은
                # 보낸 페이지 주소(Referer)의 첫 칸. 그다음 DB 서빙 여부를 이 한 곳에서 본다 — DB 프로젝트면 별칭이어도
                # 같은 명령 서비스로 제출하고(폴더에 project.json 이 남아 있어도) feedback 폴더에는 쓰지 않는다.
                pp = [p for p in unquote(path).split("/") if p]
                cand = None
                if len(pp) == 2 and pp[1] == "feedback" and SLUG.fullmatch(pp[0]):
                    cand = pp[0]
                elif path == "/feedback" and not (root / "project.json").exists():
                    rp = [p for p in unquote(urlsplit(self.headers.get("Referer") or "").path).split("/") if p]
                    if rp and SLUG.fullmatch(rp[0]):
                        cand = rp[0]
                if cand is not None:
                    serving = db_route(cand)
                    if serving is None:
                        return self._db_down()
                    if serving == "database":
                        db_slug, d, rest = cand, root / cand, ["feedback"]
            if d is None and path == "/feedback":  # 0.8 이전에 만든 화면: 보낸 페이지 주소로 프로젝트를 찾는다
                d, _ = project_of(urlsplit(self.headers.get("Referer") or "").path)
                rest = ["feedback"]
            if d is None or rest != ["feedback"]:
                return self._json(404, {"ok": False})
            origin = self.headers.get("Origin") or ""
            if origin not in allowed and origin not in trusted():
                return self._json(403, {"ok": False, "error": "origin", "hint": "pes remote add " + origin})
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0 or n > MAX_BODY:
                return self._reject_oversize(n, lambda: self._json(413, {"ok": False}, close=True))
            try:
                data = json.loads(self.rfile.read(n))
                text = str(data.get("text", "")).strip()
                rnd = int(data.get("round", 0))
                kind = str(data.get("kind") or "feedback")
                stage = re.sub(r"[^a-z]", "", str(data.get("stage") or "x"))[:12] or "x"
                answers = data.get("answers") if isinstance(data.get("answers"), dict) else {}
            except Exception:
                return self._json(400, {"ok": False})
            if kind not in KINDS:
                return self._json(400, {"ok": False, "error": "kind"})
            if not text and not answers:
                return self._json(400, {"ok": False, "error": "empty"})
            if db_slug is not None:
                # DB 길: 코어(자바스크립트 숫자·JSON 파서)가 같은 값을 보도록 입구에서 거른다. 알림 줄·처리 대기 이름·DB 가 한 round 를 말해야 한다.
                if abs(rnd) > SAFE_INT or json_depth_exceeds(data):
                    return self._json(400, {"ok": False, "error": "invalid"})
                return self._db_feedback(d, db_slug, data, stage, rnd, kind, text, answers, origin)
            fb_dir = d / "feedback"
            fb_dir.mkdir(exist_ok=True)
            ts = time.strftime("%Y%m%d-%H%M%S")
            rec = {"stage": stage, "round": rnd, "time": ts, "kind": kind, "text": text, "answers": answers,
                   "spec": str(data.get("spec", ""))[:80], "via": "html" if origin in allowed else "remote",
                   "origin": origin, "who": self.headers.get("Tailscale-User-Login") or ""}
            # 이름 예약과 파일 생성 사이에 틈이 없도록 O_CREAT|O_EXCL 로 원자적으로 만든다.
            # 같은 초에 동시에 들어온 답도 각자 다른 파일을 얻어 덮어쓰이지 않는다.
            k = 1
            while True:
                suffix = "" if k == 1 else f"-{k}"
                fp = fb_dir / f"{stage}-R{rnd}-{ts}{suffix}.json"
                try:
                    # Windows 에서도 텍스트 모드 변환이 겹치지 않도록 바이너리로 연다.
                    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_BINARY", 0)
                    fd = os.open(str(fp), flags, 0o666)
                    break
                except FileExistsError:
                    k += 1
            try:
                # fdopen 의 줄바꿈 변환을 거치지 않고 utf-8 바이트를 그대로 쓴다.
                blob = json.dumps(rec, ensure_ascii=False, indent=1).encode("utf-8")
                while blob:
                    blob = blob[os.write(fd, blob):]
            except BaseException:
                os.close(fd)
                fd = None
                try:
                    fp.unlink()
                except OSError:
                    pass
                raise
            finally:
                if fd is not None:
                    os.close(fd)
            with FEEDBACK_LOG_LOCK:
                with (d / "feedback.log").open("a", encoding="utf-8") as f:
                    f.write(f"FEEDBACK {stage} R{rnd} {kind} {fp}\n")
            return self._json(200, {"ok": True, "file": fp.name})

        def do_PUT(self):
            path = urlsplit(self.path).path
            if self._is_api_path(path):
                if not self._origin_allowed():
                    return self._api_error("forbidden", "origin is not allowed", 403)
                return self._api("PUT", path, urlsplit(self.path).query)
            return self._json(405, {"ok": False})

        def do_DELETE(self):
            path = urlsplit(self.path).path
            if self._is_api_path(path):
                if not self._origin_allowed():
                    return self._api_error("forbidden", "origin is not allowed", 403)
                return self._api("DELETE", path, urlsplit(self.path).query)
            return self.send_error(501, "Unsupported method ('DELETE')")

        def do_PATCH(self):
            path = urlsplit(self.path).path
            if self._is_api_path(path):
                if not self._origin_allowed():
                    return self._api_error("forbidden", "origin is not allowed", 403)
                return self._api("PATCH", path, urlsplit(self.path).query)
            return self.send_error(501, "Unsupported method ('PATCH')")

    try:
        override = _parse_budget_override(os.environ.get(BUDGET_OVERRIDE_ENV))
        if override:
            # 기본값과 견주려면 Node 정책이 필요하다. 변수가 있을 때만 시작 때 한 번 받아 잘못된 값이면 뜨지 않는다.
            node = shutil.which("node")
            if node is None:
                raise ValueError(f"{BUDGET_OVERRIDE_ENV}: node 를 찾을 수 없어 기본값과 견줄 수 없습니다")
            try:
                limits = subprocess.run(
                    [node, str(NODE_BRIDGE), "--limits"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60
                )
                if limits.returncode != 0:
                    raise ValueError("--limits 가 실패했습니다")
                _apply_budget_override(json.loads(limits.stdout.decode("utf-8")), override)
            except (OSError, subprocess.SubprocessError, KeyError, TypeError) as err:
                raise ValueError(f"{BUDGET_OVERRIDE_ENV}: 기본 한도를 읽지 못했습니다 ({err})")
    except ValueError as err:
        print(f"serve.py: {err}", file=sys.stderr, flush=True)
        sys.exit(2)

    srv = LocalHTTPServer(("127.0.0.1", port), H)
    srv.api_budget_override = override
    print(f"serving {root} at http://127.0.0.1:{port}/", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
