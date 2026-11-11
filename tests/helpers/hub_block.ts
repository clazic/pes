// The hub ports 8760~8775. No child a test starts may reach a REAL PES hub: `doctor`, `init`, `status`, `open` … probe 127.0.0.1:8760~8775
// (/whoami) and read the real project root from the answer. The block itself is `ts_child_guard.ts` (net.connect / fetch to these ports are
// refused and counted; a stand-in hub of a test opens only the ONE port it asks for). SEL-74: the Python wrapper that used to do this for the
// 0.15 children (`hub_blocked_argv`) is gone with Python.

export const HUB_PORT_FIRST = 8760;
export const HUB_PORT_LAST = 8775;
