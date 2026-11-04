#!/usr/bin/env python3
"""CI diagnostics only: run pytest and dump every thread if it wedges.

Used by the CI workflow to find where macOS hangs. The dump goes to a file
because ``faulthandler.dump_traceback_later(exit=True)`` terminates the
process immediately, so a normal ``finally`` block cannot print it.

Usage: python .github/ci_pytest.py [pytest arguments...]
"""
import faulthandler
import os
import sys
import tempfile

DUMP_AFTER = int(os.environ.get("PES_CI_DUMP_AFTER", "240"))
# No -o faulthandler_timeout here: pytest's faulthandler plugin arms its own
# dump_traceback_later() timer at session start, which replaces ours (only one
# timer can be active), so the exit=True dump below would never fire.
PYTEST_ARGS = ["-v", "-s", "-p", "no:cacheprovider"]


def log_path():
    base = os.environ.get("RUNNER_TEMP") or tempfile.gettempdir()
    return os.path.join(base, "pytest-wedge.log")


def main(argv):
    path = log_path()
    target = " ".join(argv) or "all tests"
    saved_stderr = os.dup(2)
    with open(path, "a", encoding="utf-8") as dump:
        dump.write("\n==== ci_pytest: %s (pid %d, dump after %ds) ====\n"
                   % (target, os.getpid(), DUMP_AFTER))
        dump.flush()
        # Keep the real stderr as well: pytest replaces sys.stderr, but fd 2 is
        # still where a faulthandler dump from another thread ends up.
        os.dup2(dump.fileno(), 2)
        faulthandler.dump_traceback_later(DUMP_AFTER, exit=True, file=dump)
        try:
            import pytest
            return pytest.main(PYTEST_ARGS + list(argv))
        finally:
            faulthandler.cancel_dump_traceback_later()
            sys.stderr.flush()
            os.dup2(saved_stderr, 2)
            os.close(saved_stderr)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
