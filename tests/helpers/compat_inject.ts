// Test-only sitecustomize snippets for serve.py children (ported verbatim in behaviour from tests/test_serve.py, SEL-70).
// They are strings handed to ServeProcess({ sitecustomize }) — no .py file is added to the repository — and they only affect the
// child process that serve.py runs in. The product code is not touched.

export const BARRIER_TIMEOUT_S = 3;
export const COLLISION_STAGE = "plan";
export const COLLISION_ROUND = 1;
export const COLLISION_TS = "20260101-000000";
export const COLLISION_COUNT = 12;
export const COLLISION_NAME = `${COLLISION_STAGE}-R${COLLISION_ROUND}-${COLLISION_TS}.json`;

const py = (value: string | number): string => JSON.stringify(value);

/**
 * Deterministic same-second feedback file-name race: the server's clock is fixed and the existence check of the same candidate
 * file waits on two barriers, so 12 requests all see "no such file" at once. With `serialize` the handler runs one request at a
 * time (the positive control: a server fixed by serialising).
 */
export function collision_injection(directory: string, name: string, count: number, serialize = false): string {
  const serialized = serialize
    ? `
import threading as _race_lock_threading
_race_handler_lock = _race_lock_threading.Lock()
_race_handle_one = _race_http.BaseHTTPRequestHandler.handle_one_request
def _race_serialized(self):
    with _race_handler_lock:
        return _race_handle_one(self)
_race_http.BaseHTTPRequestHandler.handle_one_request = _race_serialized
`
    : "";
  return `
# ---- SEL-13 test-only: deterministic same-second feedback filename race ----
import http.server as _race_http
import os as _race_os
import threading as _race_threading
import time as _race_time
from pathlib import Path as _RacePath
_race_http.HTTPServer.request_queue_size = 64
${serialized}
_race_time.strftime = lambda *_args, **_kwargs: ${py(COLLISION_TS)}
_race_dir = ${py(directory)}
_race_name = ${py(name)}
_race_count = ${count}
_race_first = _race_threading.Barrier(_race_count)
_race_second = _race_threading.Barrier(_race_count)
_race_original_exists = _RacePath.exists

def _race_exists(self):
    try:
        candidate = (self.name == _race_name and
                     _race_os.path.normcase(str(self.parent)) == _race_os.path.normcase(_race_dir))
    except Exception:
        candidate = False
    if not candidate:
        return _race_original_exists(self)
    try:
        _race_first.wait(timeout=${BARRIER_TIMEOUT_S})
        found = _race_original_exists(self)
        _race_second.wait(timeout=${BARRIER_TIMEOUT_S})
        return found
    except _race_threading.BrokenBarrierError:
        return _race_original_exists(self)

_RacePath.exists = _race_exists
`;
}

/** Slow reverse DNS (socket.getfqdn sleeps `delay` seconds) — SEL-33. */
export function slow_fqdn_injection(delay: number): string {
  return `
# ---- SEL-33 test-only: slow reverse DNS (socket.getfqdn) ----
import socket as _slow_dns_socket
import time as _slow_dns_time
_slow_dns_getfqdn = _slow_dns_socket.getfqdn
def _slow_dns_lookup(name=''):
    _slow_dns_time.sleep(${delay})
    return _slow_dns_getfqdn(name)
_slow_dns_socket.getfqdn = _slow_dns_lookup
`;
}
