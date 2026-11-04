#!/usr/bin/env python3
"""PES 로컬 서버 (포트 하나): PES 홈 폴더 전체를 127.0.0.1 에서 서빙한다.

사용: python3 -I serve.py <PES 홈 폴더> [포트=8760]   (보통 pes.py serve / hub 로 띄운다)
 - GET /                  → 프로젝트 목록 (index.html)
 - GET /<slug>/           → 그 프로젝트 대시보드 (index.html, 없으면 가장 최근 질문 폼)
 - GET /ping, /<slug>/ping → {"ok": true}
 - GET /whoami            → {"root": "<홈 폴더>"}  (pes.py 가 같은 홈의 서버인지 확인)
 - POST /<slug>/feedback  {"stage", "round", "kind", "text", "answers", ...}
   → <slug>/feedback/<stage>-R<round>-<시각>.json 저장, <slug>/feedback.log 에 "FEEDBACK <stage> R<round> <kind> <경로>" 한 줄
 - 홈 폴더 자체가 프로젝트면(예전 방식) POST /feedback 도 받는다.
 - 다른 출처(Origin)의 POST 는 거부한다.
"""
import json
import os
import re
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

MAX_BODY = 256 * 1024
KINDS = {"feedback", "review", "stage_start", "approve", "resume", "reopen"}
SLUG = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,80}")
# feedback.log 한 줄이 여러 요청 스레드 사이에서 섞이지 않게 한다 (Windows 포함).
FEEDBACK_LOG_LOCK = threading.Lock()


def main():
    root = Path(sys.argv[1]).resolve()
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8760
    allowed = {f"http://127.0.0.1:{port}", f"http://localhost:{port}"}
    CONFIG = Path.home() / ".pes" / "config.json"

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

        def _json(self, code, obj, cors=False):
            body = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(code)
            o = self.headers.get("Origin") or ""
            if cors and re.fullmatch(r"http://(127\.0\.0\.1|localhost):87\d\d", o):
                self.send_header("Access-Control-Allow-Origin", o)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def list_directory(self, path):  # 폴더 목록은 보여 주지 않는다
            self.send_error(404)
            return None

        def _redirect(self, to):
            self.send_response(302)
            self.send_header("Location", to)
            self.end_headers()

        def do_GET(self):
            path = urlsplit(self.path).path
            if path == "/whoami":
                return self._json(200, {"root": str(root), "single": True}, cors=True)
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

        def do_POST(self):
            path = urlsplit(self.path).path
            d, rest = project_of(path)
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
                return self._json(413, {"ok": False})
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
                    fd = os.open(str(fp), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o666)
                    break
                except FileExistsError:
                    k += 1
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    f.write(json.dumps(rec, ensure_ascii=False, indent=1))
            except BaseException:
                try:
                    fp.unlink()
                except OSError:
                    pass
                raise
            with FEEDBACK_LOG_LOCK:
                with (d / "feedback.log").open("a", encoding="utf-8") as f:
                    f.write(f"FEEDBACK {stage} R{rnd} {kind} {fp}\n")
            return self._json(200, {"ok": True, "file": fp.name})

    srv = ThreadingHTTPServer(("127.0.0.1", port), H)
    print(f"serving {root} at http://127.0.0.1:{port}/", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
