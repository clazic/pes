#!/usr/bin/env python3
"""PES 로컬 서버: 프로젝트 폴더를 127.0.0.1 에서 서빙하고, 대시보드·질문 폼의 '보내기'를 받는다.

사용: python3 -I serve.py <프로젝트 폴더> <포트>   (보통 pes.py serve 로 띄운다)
 - GET /           → index.html (없으면 가장 최근 질문 폼)
 - GET /ping       → {"ok": true}
 - GET /whoami     → {"root": "<폴더>"}  (pes.py 가 같은 프로젝트 서버인지 확인)
 - POST /feedback  {"stage", "round", "kind", "text", "answers", ...}
   → feedback/<stage>-R<round>-<시각>.json 저장, feedback.log 에 "FEEDBACK <stage> R<round> <kind> <경로>" 한 줄
 - 다른 출처(Origin)의 POST 는 거부한다.
"""
import json
import re
import sys
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MAX_BODY = 256 * 1024
KINDS = {"feedback", "review", "stage_start", "approve", "resume", "reopen"}


def main():
    root = Path(sys.argv[1]).resolve()
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8765
    hub = len(sys.argv) > 3 and sys.argv[3] == "hub"
    fb_dir = root / "feedback"
    if not hub:
        fb_dir.mkdir(exist_ok=True)
    log = root / "feedback.log"
    allowed = {f"http://127.0.0.1:{port}", f"http://localhost:{port}"}

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

        def do_GET(self):
            if self.path == "/ping":
                return self._json(200, {"ok": True})
            if self.path == "/whoami":
                return self._json(200, {"root": str(root), "hub": hub}, cors=True)
            if self.path in ("/", ""):
                asks = sorted(root.glob("ask-*.html"), key=lambda p: p.stat().st_mtime)
                target = "index.html" if (root / "index.html").exists() else (asks[-1].name if asks else "")
                self.send_response(302)
                self.send_header("Location", "/" + target)
                self.end_headers()
                return
            return super().do_GET()

        def do_POST(self):
            if hub and self.path == "/start":
                return self._start()
            if hub or self.path != "/feedback":
                return self._json(404, {"ok": False})
            if self.headers.get("Origin") not in allowed:
                return self._json(403, {"ok": False, "error": "origin"})
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
            ts = time.strftime("%Y%m%d-%H%M%S")
            path = fb_dir / f"{stage}-R{rnd}-{ts}.json"
            rec = {"stage": stage, "round": rnd, "time": ts, "kind": kind, "text": text, "answers": answers,
                   "spec": str(data.get("spec", ""))[:80], "via": "html"}
            path.write_text(json.dumps(rec, ensure_ascii=False, indent=1), encoding="utf-8")
            with log.open("a", encoding="utf-8") as f:
                f.write(f"FEEDBACK {stage} R{rnd} {kind} {path}\n")
            return self._json(200, {"ok": True, "file": path.name})

    def _start(self):
        if self.headers.get("Origin") not in allowed:
            return self._json(403, {"ok": False, "error": "origin"})
        n = int(self.headers.get("Content-Length") or 0)
        try:
            slug = str(json.loads(self.rfile.read(n) if 0 < n < 4096 else b"{}").get("slug", ""))
        except Exception:
            slug = ""
        d = root / slug
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,80}", slug) or not (d / "project.json").exists():
            return self._json(400, {"ok": False, "error": "slug"})
        import subprocess
        pes = Path(__file__).resolve().parent / "pes.py"
        r = subprocess.run([sys.executable, "-I", str(pes), "serve", str(d)], capture_output=True, text=True, timeout=20)
        url = (r.stdout.strip().splitlines() or [""])[-1]
        return self._json(200 if url.startswith("http") else 500, {"ok": url.startswith("http"), "url": url, "err": r.stderr[-300:]})
    H._start = _start

    srv = ThreadingHTTPServer(("127.0.0.1", port), H)
    print(f"serving {root} at http://127.0.0.1:{port}/", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
