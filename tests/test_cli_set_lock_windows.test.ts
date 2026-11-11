/**
 * SEL-75 [결함] Windows 에서 set 동시 실행 시 .project.json.lock PermissionError 로 죽는다 — 작성 모드 시험.
 *
 * 원인: scripts/pes.py short_write_lock 이 os.open(O_CREAT|O_EXCL) 실패를 FileExistsError 로만 잡는다.
 * Windows 는 다른 프로세스가 잠금 파일을 지우는 중(삭제 대기)이면 PermissionError 가 난다. stat·unlink 도 마찬가지.
 *
 * 이 시험은 OS 와 무관하게(macOS 에서도) 그 오류를 주입해서 재현한다:
 *   python -I -X utf8 -c "<주입 코드>"  — 새 .py 파일 없이 -c 문자열만 쓴다. 주입 코드는 os.open·Path.stat·Path.unlink 를
 *   `.project.json.lock` 이름에만 PermissionError 로 바꾸고(처음 k 번, -1 이면 계속), 그 뒤는 진짜 동작을 부른다.
 *   마감(30초)은 time.time/time.sleep 을 합성 시계로 바꿔 실제로 기다리지 않는다.
 * 모든 합성 자료이고 HOME·USERPROFILE·PES_HOME 은 임시 폴더다 (set_env.ts → isolated_home).
 *
 * 공통 기대: 스택 추적(Traceback·PermissionError) 없음, project.json 은 유효한 JSON, project.json.tmp* 가 남지 않음.
 * Windows 점검표: 자식은 -I -X utf8, 출력은 CRLF→LF, 경로는 인자·환경 변수(JSON)로만 넘긴다(코드 문자열에 박지 않음), 셸·which 없음.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { PES_PY } from "./helpers/cli_write_env.ts";
import { PY } from "./helpers/cli_read_env.ts";
import { make_set_env, type SetEnv } from "./helpers/set_env.ts";

const LOCK = ".project.json.lock";

interface Inject {
  /** 처음 k 번 os.open(잠금) 이 PermissionError. -1 = 계속. */
  open_fail?: number;
  /** 처음 k 번 Path.stat(잠금) 이 PermissionError. -1 = 계속. */
  stat_fail?: number;
  /** 처음 k 번 Path.unlink(잠금) 이 PermissionError. -1 = 계속. */
  unlink_fail?: number;
  /** open 이 PermissionError 를 내기 전에 진짜 O_EXCL 로 잠금 파일을 먼저 만들어 둔다(=남의 잠금이 있는 상태 흉내)가 아니라, 처음 k 번을 FileExistsError 로 바꾼다. */
  exists_fail?: number;
  /** time.time/time.sleep 을 합성 시계로 바꿔 마감(30초)을 기다리지 않게 한다. */
  fake_clock?: boolean;
}

interface Counts {
  open: number;
  stat: number;
  unlink: number;
  exists: number;
  slept: number;
}

// 주입 코드. 인자·경로는 환경 변수(SEL75_INJECT, SEL75_PES, SEL75_ARGV, SEL75_REPORT)로 받는다.
const INJECT_CODE = `
import atexit, json, os, pathlib, runpy, sys, time
cfg = json.loads(os.environ["SEL75_INJECT"])
LOCK = ".project.json.lock"
left = {k: cfg.get(k + "_fail", 0) for k in ("open", "stat", "unlink", "exists")}
hit = {"open": 0, "stat": 0, "unlink": 0, "exists": 0, "slept": 0}

def take(kind):
    if left[kind] == 0:
        return False
    if left[kind] > 0:
        left[kind] -= 1
    hit[kind] += 1
    return True

_open = os.open
def fake_open(path, *a, **k):
    if os.path.basename(os.fspath(path)) == LOCK:
        if take("open"):
            raise PermissionError(13, "Permission denied", os.fspath(path))
        if take("exists"):
            raise FileExistsError(17, "File exists", os.fspath(path))
    return _open(path, *a, **k)
os.open = fake_open

_stat = pathlib.Path.stat
def fake_stat(self, *a, **k):
    if self.name == LOCK and take("stat"):
        raise PermissionError(13, "Permission denied", str(self))
    return _stat(self, *a, **k)
pathlib.Path.stat = fake_stat

_unlink = pathlib.Path.unlink
def fake_unlink(self, *a, **k):
    if self.name == LOCK and take("unlink"):
        raise PermissionError(13, "Permission denied", str(self))
    return _unlink(self, *a, **k)
pathlib.Path.unlink = fake_unlink

if cfg.get("fake_clock"):
    _time = time.time
    skew = [0.0]
    time.time = lambda: _time() + skew[0]
    def fake_sleep(s):
        hit["slept"] += 1
        skew[0] += s
    time.sleep = fake_sleep

def report():
    with open(os.environ["SEL75_REPORT"], "w", encoding="utf-8") as f:
        json.dump(hit, f)
atexit.register(report)

sys.argv = [os.environ["SEL75_PES"]] + json.loads(os.environ["SEL75_ARGV"])
runpy.run_path(os.environ["SEL75_PES"], run_name="__main__")
`;

interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
  counts: Counts;
}

let report_seq = 0;

function child_env(e: SetEnv, args: string[], inject: Inject): { env: NodeJS.ProcessEnv; report: string } {
  const report = join(e.home.root, `inject-report-${report_seq++}.json`);
  const env: Record<string, string | undefined> = {
    ...e.home.env,
    PES_OWNER: undefined,
    PES_TOKEN: undefined,
    PES_DB_CORE: undefined,
    SEL75_INJECT: JSON.stringify(inject),
    SEL75_PES: PES_PY,
    SEL75_ARGV: JSON.stringify(args),
    SEL75_REPORT: report,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return { env: env as NodeJS.ProcessEnv, report };
}

function read_counts(report: string): Counts {
  const empty: Counts = { open: 0, stat: 0, unlink: 0, exists: 0, slept: 0 };
  return existsSync(report) ? { ...empty, ...JSON.parse(readFileSync(report, "utf8")) } : empty;
}

function norm(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function run_inject(e: SetEnv, args: string[], inject: Inject, timeout = 60_000): Ran {
  const { env, report } = child_env(e, args, inject);
  const res = spawnSync(PY, ["-I", "-X", "utf8", "-c", INJECT_CODE], { env, cwd: e.home.root, encoding: "utf8", timeout });
  if (res.error !== undefined) throw res.error;
  return { status: res.status, stdout: norm(res.stdout ?? ""), stderr: norm(res.stderr ?? ""), counts: read_counts(report) };
}

function run_inject_async(e: SetEnv, args: string[], inject: Inject): Promise<Ran> {
  const { env, report } = child_env(e, args, inject);
  return new Promise((resolve, reject) => {
    const child = spawn(PY, ["-I", "-X", "utf8", "-c", INJECT_CODE], { env, cwd: e.home.root });
    let out = "";
    let err = "";
    child.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (err += b.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ status: code, stdout: norm(out), stderr: norm(err), counts: read_counts(report) }));
  });
}

const CRASH = /Traceback|PermissionError|FileExistsError|WinError/;

function lock_path(e: SetEnv): string {
  return join(e.folder, LOCK);
}

function age_lock(e: SetEnv, seconds: number): void {
  const t = new Date(Date.now() - seconds * 1000);
  utimesSync(lock_path(e), t, t);
}

function put_lock(e: SetEnv, age_seconds: number): void {
  writeFileSync(lock_path(e), "", "utf8");
  if (age_seconds > 0) age_lock(e, age_seconds);
}

function assert_clean(e: SetEnv, what: string): void {
  JSON.parse(e.raw()); // 유효한 JSON
  const left = readdirSync(e.folder).filter((n) => n.startsWith("project.json.tmp"));
  assert.deepEqual(left, [], `${what}: tmp 가 남지 않는다`);
}

function value(e: SetEnv, name: string, text: string): string {
  return e.value_file(name, text);
}

function set_ok(e: SetEnv, inject: Inject, text: string, what: string): Ran {
  const r = run_inject(e, ["set", e.slug, "plan", "summary", value(e, `v-${report_seq}.txt`, text)], inject);
  assert.doesNotMatch(r.stderr, CRASH, `${what}: 스택 추적 없이 끝나야 한다\n${r.stderr}`);
  assert.equal(r.status, 0, `${what}: set 이 성공해야 한다 (종료 ${r.status})\n${r.stderr}`);
  assert.equal(e.state().stages.plan.summary, text, `${what}: 값이 저장됐다`);
  assert_clean(e, what);
  return r;
}

// ---------------------------------------------------------------------------
// 주입 장치 자체 (시험이 헛돌지 않게)

test("주입 장치: 오류를 주입하지 않으면 평범한 set 과 같다 — 성공·잠금 없음·주입 0회", () => {
  const e = make_set_env();
  try {
    const r = set_ok(e, {}, "주입 없음", "무주입");
    assert.deepEqual(r.counts, { open: 0, stat: 0, unlink: 0, exists: 0, slept: 0 });
    assert.ok(!existsSync(lock_path(e)), "끝나면 잠금 파일이 없다");
  } finally {
    e.cleanup();
  }
});

// ---------------------------------------------------------------------------
// os.open 이 PermissionError (Windows: 남이 잠금 파일을 지우는 중)

for (const k of [1, 2, 5, 40]) {
  test(`잠금 만들기(os.open)가 처음 ${k}번 PermissionError 여도 set 은 재시도해서 성공하고 잠금·tmp 를 남기지 않는다`, () => {
    const e = make_set_env();
    try {
      const r = set_ok(e, { open_fail: k, fake_clock: true }, `열기 ${k}번 실패 뒤 성공`, `open ${k}`);
      assert.equal(r.counts.open, k, "주입이 실제로 k 번 일어났다");
      assert.ok(!existsSync(lock_path(e)), "끝나면 잠금 파일이 없다");
      // 이어지는 평범한 set 도 막히지 않는다
      set_ok(e, {}, "그다음 set", "다음 set");
    } finally {
      e.cleanup();
    }
  });
}

test("os.open PermissionError 가 한 번 나고 그다음 진짜 FileExistsError(남의 잠금)가 나도, 묵은(60초 넘은) 잠금이면 치우고 성공한다", () => {
  const e = make_set_env();
  try {
    put_lock(e, 120);
    const r = set_ok(e, { open_fail: 1, fake_clock: true }, "묵은 잠금 뒤 성공", "PermissionError 뒤 묵은 잠금");
    assert.equal(r.counts.open, 1);
    assert.ok(!existsSync(lock_path(e)));
  } finally {
    e.cleanup();
  }
});

test("os.open PermissionError 와 FileExistsError 가 번갈아 나와도 성공한다 (삭제 대기 ↔ 이미 있음)", () => {
  const e = make_set_env();
  try {
    const r = set_ok(e, { open_fail: 3, exists_fail: 3, fake_clock: true }, "번갈아 실패", "번갈아");
    assert.equal(r.counts.open, 3);
    assert.equal(r.counts.exists, 3);
  } finally {
    e.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Path.stat 이 PermissionError

test("묵은 잠금이 있고 lock.stat 이 처음 k번 PermissionError 여도 충돌 없이 재시도하다가 묵은 잠금을 치우고 성공한다", () => {
  for (const k of [1, 4]) {
    const e = make_set_env();
    try {
      put_lock(e, 120);
      const r = set_ok(e, { stat_fail: k, fake_clock: true }, `stat ${k}번 실패`, `stat ${k}`);
      assert.equal(r.counts.stat, k, "주입이 실제로 k 번 일어났다");
      assert.ok(!existsSync(lock_path(e)), "묵은 잠금은 치워졌다");
    } finally {
      e.cleanup();
    }
  }
});

test("open 이 PermissionError 이고 그 뒤 stat 도 PermissionError 여도(삭제 대기 파일) 재시도해서 성공한다", () => {
  const e = make_set_env();
  try {
    put_lock(e, 120);
    const r = set_ok(e, { open_fail: 2, stat_fail: 2, fake_clock: true }, "open·stat 모두 실패", "open+stat");
    assert.equal(r.counts.open, 2);
    assert.ok(r.counts.stat >= 1, "stat 실패도 일어났다");
  } finally {
    e.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Path.unlink 가 PermissionError

test("묵은 잠금을 치우는 unlink 가 처음 k번 PermissionError 여도 충돌 없이 재시도해서 성공한다", () => {
  for (const k of [1, 3]) {
    const e = make_set_env();
    try {
      put_lock(e, 120);
      const r = set_ok(e, { unlink_fail: k, fake_clock: true }, `묵은 잠금 unlink ${k}번 실패`, `stale unlink ${k}`);
      assert.equal(r.counts.unlink, k, "주입이 실제로 k 번 일어났다");
      assert.ok(!existsSync(lock_path(e)));
    } finally {
      e.cleanup();
    }
  }
});

test("저장을 마치고 잠금을 지우는 finally 의 unlink 가 PermissionError 여도 set 은 성공하고 스택 추적을 내지 않는다 (잠금이 남으면 다음 set 이 이어받는다)", () => {
  for (const k of [1, 2, -1]) {
    const e = make_set_env();
    try {
      const r = set_ok(e, { unlink_fail: k }, `끝 unlink ${k} 실패`, `finally unlink ${k}`);
      assert.ok(r.counts.unlink >= 1, "unlink 실패가 실제로 일어났다");
      if (existsSync(lock_path(e))) {
        // 지우지 못한 잠금: 방금 만든 것이라 fresh 다. 60초 넘게 묵었다고 보면 다음 set 이 치우고 진행한다.
        age_lock(e, 120);
        set_ok(e, { fake_clock: true }, `이어받은 set (k=${k})`, `다음 set k=${k}`);
        assert.ok(!existsSync(lock_path(e)), "다음 set 은 잠금을 남기지 않는다");
      }
    } finally {
      e.cleanup();
    }
  }
});

test("finally 의 unlink 가 한 번 실패했다가 되면(일시적 삭제 대기) 잠금은 남지 않는다 — 재시도", () => {
  const e = make_set_env();
  try {
    set_ok(e, { unlink_fail: 1 }, "일시 실패 뒤 정리", "일시적 unlink 실패");
    assert.ok(!existsSync(lock_path(e)), "일시적 실패는 재시도해서 잠금 파일을 남기지 않는다");
  } finally {
    e.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 마감(30초)·묵은 잠금(60초) 규칙 회귀 — 합성 시계

test("fresh 잠금이 계속 있으면 30초 마감(합성 시간) 뒤 스택 추적 없이 종료 3 으로 거절하고 값·잠금은 그대로다", () => {
  const e = make_set_env();
  try {
    put_lock(e, 0);
    const before = e.raw();
    const started = Date.now();
    const r = run_inject(e, ["set", e.slug, "plan", "summary", value(e, "late.txt", "마감 시험")], { fake_clock: true });
    assert.ok(Date.now() - started < 20_000, "실제로 30초를 기다리지 않는다");
    assert.doesNotMatch(r.stderr, CRASH, r.stderr);
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /다른 set/, "한국어 안내");
    assert.ok(r.counts.slept >= 100, `마감까지 여러 번 재시도했다 (잠 ${r.counts.slept}번)`);
    assert.equal(e.raw(), before, "project.json 불변");
    assert.ok(existsSync(lock_path(e)), "남의 잠금은 건드리지 않는다");
    assert_clean(e, "마감");
  } finally {
    e.cleanup();
  }
});

test("os.open 이 계속 PermissionError 이면(영영 풀리지 않는 삭제 대기) 마감 뒤 스택 추적 없이 종료 3 으로 거절한다", () => {
  const e = make_set_env();
  try {
    const before = e.raw();
    const started = Date.now();
    const r = run_inject(e, ["set", e.slug, "plan", "summary", value(e, "forever.txt", "영영")], { open_fail: -1, fake_clock: true });
    assert.ok(Date.now() - started < 20_000, "실제로 30초를 기다리지 않는다");
    assert.doesNotMatch(r.stderr, CRASH, r.stderr);
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /다른 set/);
    assert.equal(e.raw(), before);
    assert.ok(!existsSync(lock_path(e)), "만들지 못한 잠금 파일은 없다");
    assert_clean(e, "영영 PermissionError");
  } finally {
    e.cleanup();
  }
});

test("묵은 잠금이 있고 stat·unlink 가 계속 PermissionError 이면 마감 뒤 종료 3 으로 거절한다 (충돌 없음)", () => {
  for (const inject of [{ stat_fail: -1 }, { unlink_fail: -1 }] as const) {
    const e = make_set_env();
    try {
      put_lock(e, 120);
      const before = e.raw();
      const r = run_inject(e, ["set", e.slug, "plan", "summary", value(e, "stuck.txt", "막힘")], { ...inject, fake_clock: true });
      assert.doesNotMatch(r.stderr, CRASH, `${JSON.stringify(inject)}\n${r.stderr}`);
      assert.equal(r.status, 3, r.stderr);
      assert.equal(e.raw(), before);
      assert_clean(e, JSON.stringify(inject));
    } finally {
      e.cleanup();
    }
  }
});

test("60초 규칙 회귀: (마감까지 합쳐도) 60초가 안 된 잠금은 건드리지 않고 거절, 61초 묵은 잠금은 치우고 성공한다 (오류 주입 없음)", () => {
  const e = make_set_env();
  try {
    // 합성 시계는 마감(30초)까지 흐른다 — 잠금 나이 25초 + 30초 = 55초 < 60초 라서 끝까지 fresh 로 남아야 한다.
    put_lock(e, 25);
    const before = e.raw();
    const held = run_inject(e, ["set", e.slug, "plan", "summary", value(e, "x.txt", "아직")], { fake_clock: true });
    assert.equal(held.status, 3, held.stderr);
    assert.doesNotMatch(held.stderr, CRASH);
    assert.equal(e.raw(), before);
    assert.ok(existsSync(lock_path(e)));

    age_lock(e, 61);
    set_ok(e, {}, "61초 묵은 잠금", "61초");
    assert.ok(!existsSync(lock_path(e)));
  } finally {
    e.cleanup();
  }
});

test("30초 마감 회귀: 잠금이 마감 직전에 풀리면 성공한다 — 처음 k번 FileExistsError 뒤 진짜 동작", () => {
  const e = make_set_env();
  try {
    // 0.02초씩 자므로 1000번 = 합성 20초 < 30초 마감.
    const r = set_ok(e, { exists_fail: 1000, fake_clock: true }, "마감 안에 풀림", "마감 안");
    assert.equal(r.counts.exists, 1000);
    assert.ok(!existsSync(lock_path(e)));
  } finally {
    e.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 동시 실행 (진짜 경합 + 주입)

test("동시 set 둘 중 한쪽의 os.open 이 처음 몇 번 PermissionError 여도 둘 다 성공하고 갱신이 유실되지 않는다 (10회)", async () => {
  const e = make_set_env();
  try {
    for (let round = 0; round < 10; round++) {
      const a = value(e, `ca${round}.txt`, `에이 ${round}`);
      const b = value(e, `cb${round}.txt`, `비 ${round}`);
      const [ra, rb] = await Promise.all([
        run_inject_async(e, ["set", e.slug, "plan", "summary", a], { open_fail: 1 + (round % 4) }),
        run_inject_async(e, ["set", e.slug, "project", "conclusion", b], { open_fail: 1 + ((round + 2) % 4) }),
      ]);
      for (const [name, r] of [["a", ra], ["b", rb]] as const) {
        assert.doesNotMatch(r.stderr, CRASH, `라운드 ${round} ${name}\n${r.stderr}`);
        assert.equal(r.status, 0, `라운드 ${round} ${name}: 종료 ${r.status}\n${r.stderr}`);
      }
      const st = e.state();
      assert.equal(st.stages.plan.summary, `에이 ${round}`, `라운드 ${round}: a 갱신 유실`);
      assert.equal(st.conclusion, `비 ${round}`, `라운드 ${round}: b 갱신 유실`);
      assert_clean(e, `라운드 ${round}`);
      assert.ok(!existsSync(lock_path(e)), `라운드 ${round}: 잠금이 남는다`);
    }
  } finally {
    e.cleanup();
  }
});

// Windows 변형: 기존 '동시 실행 둘 (10회)' 은 그대로 두고, 반복을 늘린 변형 하나. Windows 에서 프로세스 시작이 3~10배 느리므로
// 시간 상한을 둔다 (macOS/Linux 에서는 수 초면 끝난다).
test("set 동시 실행 둘 — 반복 늘린 변형 (30회): 충돌·갱신 유실·잔여 파일 없음, 시간 상한 안에 끝난다", async () => {
  const e = make_set_env();
  const started = Date.now();
  try {
    for (let round = 0; round < 30; round++) {
      const a = value(e, `wa${round}.txt`, `에이 ${round}`);
      const b = value(e, `wb${round}.txt`, `비 ${round}`);
      const [ra, rb] = await Promise.all([
        run_inject_async(e, ["set", e.slug, "plan", "summary", a], {}),
        run_inject_async(e, ["set", e.slug, "project", "conclusion", b], {}),
      ]);
      for (const [name, r] of [["a", ra], ["b", rb]] as const) {
        assert.doesNotMatch(r.stderr, CRASH, `라운드 ${round} ${name}: 충돌하면 안 된다\n${r.stderr}`);
        assert.equal(r.status, 0, `라운드 ${round} ${name}: 종료 ${r.status}\n${r.stderr}`);
      }
      const st = e.state();
      assert.equal(st.stages.plan.summary, `에이 ${round}`, `라운드 ${round}: a 유실`);
      assert.equal(st.conclusion, `비 ${round}`, `라운드 ${round}: b 유실`);
      assert_clean(e, `라운드 ${round}`);
      assert.ok(!existsSync(lock_path(e)), `라운드 ${round}: 잠금이 남는다`);
    }
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 150_000, `30라운드가 ${elapsed}ms — 한 라운드가 5초를 넘으면 잠금 마감(30초)에 가깝게 기다린다는 뜻이다`);
  } finally {
    e.cleanup();
  }
});
