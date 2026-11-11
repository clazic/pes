// Every Python child that tests start (pes.py, serve.py, setup.py …) must never reach a REAL PES hub: `doctor`, `init`, `status`, `open` …
// probe 127.0.0.1:8760~8775 (/whoami) and read the real project root from the answer. The audit hook only sees file access, so this module
// puts a second guard in front of the script: nothing may connect to those ports (the connection is refused, as if no server ran there).
// Use `hub_blocked_argv` for every `python -I [-X utf8] <script> <args…>` a test spawns.

export const HUB_PORT_FIRST = 8760;
export const HUB_PORT_LAST = 8775;

/**
 * Python code for the child: `urlopen` raises URLError, `socket.connect` raises ConnectionRefusedError, `connect_ex` answers 111, for ports
 * 8760~8775 — except `allow` (port(s) of a stand-in hub the test started itself).
 */
export function hub_block_code(allow?: number | readonly number[]): string {
  const allowed = allow === undefined ? [] : typeof allow === "number" ? [allow] : [...allow];
  return `
import socket as _hb_socket, urllib.error as _hb_error, urllib.request as _hb_request
_hb_allow = (${allowed.map(String).join(", ")}${allowed.length === 1 ? "," : ""})
def _hb_port(address):
    try:
        port = int(address[1])
    except Exception:
        return False
    return ${HUB_PORT_FIRST} <= port <= ${HUB_PORT_LAST} and port not in _hb_allow
_hb_connect_ex = _hb_socket.socket.connect_ex
_hb_connect = _hb_socket.socket.connect
def _hb_socket_connect_ex(self, address):
    return 111 if _hb_port(address) else _hb_connect_ex(self, address)
def _hb_socket_connect(self, address):
    if _hb_port(address):
        raise ConnectionRefusedError(111, "blocked by the test harness")
    return _hb_connect(self, address)
_hb_socket.socket.connect_ex = _hb_socket_connect_ex
_hb_socket.socket.connect = _hb_socket_connect
_hb_urlopen = _hb_request.urlopen
def _hb_guarded_urlopen(url, *args, **kwargs):
    target = url.full_url if hasattr(url, "full_url") else str(url)
    for _hb_host in ("127.0.0.1:", "localhost:", "[::1]:"):
        _hb_at = target.find(_hb_host)
        if _hb_at >= 0:
            _hb_digits = ""
            for _hb_ch in target[_hb_at + len(_hb_host):]:
                if not _hb_ch.isdigit():
                    break
                _hb_digits += _hb_ch
            if _hb_digits and _hb_port((None, _hb_digits)):
                raise _hb_error.URLError("blocked by the test harness")
    return _hb_urlopen(url, *args, **kwargs)
_hb_request.urlopen = _hb_guarded_urlopen
`;
}

export const HUB_BLOCK = hub_block_code();

/**
 * `[...python flags, script, ...args]` → `[...flags, "-c", <HUB_BLOCK>+runpy, script, ...args]`. The child behaves as `python <flags> <script> <args>`
 * (argv, __file__, __main__, exit code). Flags are `-I`, `-X <opt>`, `-u`, `-B`; the first other argument is the script.
 */
export function hub_blocked_argv(argv: readonly string[], allow?: number | readonly number[]): string[] {
  let at = 0;
  while (at < argv.length) {
    const arg = argv[at] as string;
    if (arg === "-X") at += 2;
    else if (/^-[IuBsESO]+$/.test(arg)) at += 1;
    else break;
  }
  if (at >= argv.length) throw new Error(`hub_blocked_argv: no script in ${JSON.stringify(argv)}`);
  const code = `${hub_block_code(allow)}\nimport runpy as _hb_runpy, sys as _hb_sys\n_hb_sys.argv = _hb_sys.argv[1:]\n_hb_runpy.run_path(_hb_sys.argv[0], run_name="__main__")\n`;
  return [...argv.slice(0, at), "-c", code, ...argv.slice(at)];
}
