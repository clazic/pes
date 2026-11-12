// SEL-96 재현·회귀 확인 — "고른 포트를 다른 서버가 먼저 잡으면 e2e 가 그 다른 서버를 시험하고 성공하는" 일이 없어야 한다.
// 실행: cd app && hc-heavy node scripts/e2e-foreign-port-race.mjs   (HOME·USERPROFILE·PES_HOME 은 임시 폴더로 바꾼 셸에서)
//
// 순서: ① 빈 포트를 골라 PES_E2E_PORT 로 준다 ② playwright 가 webServer(빌드 → preview)를 시작하면
// ③ 그 포트에 "다른 서버"를 바인딩한다(빌드가 도는 동안 다른 프로세스가 포트를 가로챈 상황) ④ playwright 가 끝나길 기다린다.
// 합격 = 아래 넷이 모두 참일 때만: ① 다른 서버가 실제로 listening 을 마쳤다 ② vite preview 가 그 포트의 바인딩 충돌 오류("Port N is already in use")를 냈다
// ③ playwright 가 일반 종료 코드(숫자, != 0)로 실패했다 ④ 다른 서버가 요청을 한 번도 받지 않았다(그 서버를 시험하지 않음).
// 시간 초과·시그널 종료(code=null)·빌드 실패처럼 포트 충돌과 무관하게 실패한 경우는 합격이 아니라 "재현 실패"(exit 2)로 따로 처리한다.
// 예전 설정(webServer.url 응답으로 준비 완료 판단)에서는 다른 서버의 200 응답을 "준비됨"으로 받아 시험하고 exit 0 으로 끝났다.
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const playwrightCli = path.join(appDir, "node_modules", "playwright", "cli.js");

const home = process.env.HOME ?? "";
// 실제 계정 홈은 HOME 을 무시하는 os.userInfo().homedir 로 구한다(이름을 코드에 적지 않는다)
const realHome = path.resolve(os.userInfo().homedir);
const looksLikeAccountHome = (p) => /^\/Users\/[^/]+\/?$/.test(p) || /^\/home\/[^/]+\/?$/.test(p) || /^[A-Za-z]:\\Users\\[^\\]+\\?$/.test(p);
const profile = process.env.USERPROFILE ?? "";
if (!home || path.resolve(home) === realHome || looksLikeAccountHome(home) || (profile && (path.resolve(profile) === realHome || looksLikeAccountHome(profile)))) {
  // 실제 홈에서 돌리지 않는다(임시 HOME 필수)
  console.error(`HOME 이 임시 폴더가 아니다: ${home}`);
  process.exit(2);
}

const freePort = await new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

let foreignHits = 0;
const foreign = http.createServer((req, res) => {
  foreignHits += 1;
  console.log(`FOREIGN 요청: ${req.method} ${req.url}`);
  res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>FOREIGN</title>");
});

let foreignBindStarted = false;
let foreignListening = false; // listen 콜백이 불린 뒤에만 true (바인딩을 "시작"한 것과 구분)
let foreignError = null;
foreign.on("error", (err) => {
  foreignError = err;
  console.error(`FOREIGN_ERROR ${err.code ?? err.message}`);
});
const bindForeign = () => {
  if (foreignBindStarted) return;
  foreignBindStarted = true;
  foreign.listen(freePort, "127.0.0.1", () => {
    foreignListening = true;
    console.log(`FOREIGN_LISTENING ${freePort}`);
  });
};

const child = spawn(
  process.execPath,
  [playwrightCli, "test", "-c", "playwright.config.ts", "e2e/u1a.spec.ts", "--grep", "1366px: 보이는 영역"],
  {
    cwd: appDir,
    env: { ...process.env, PES_E2E_PORT: String(freePort), DEBUG: "pw:webserver" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
// vite preview 가 strictPort 로 이 포트를 못 잡았을 때 찍는 줄 (예: "Error: Port 56862 is already in use")
const conflictRe = new RegExp(`Port ${freePort} is already in use`);
let conflictSeen = false;
const onData = (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);
  if (text.includes("Starting WebServer process")) bindForeign();
  if (conflictRe.test(text)) conflictSeen = true;
};
child.stdout.on("data", onData);
child.stderr.on("data", onData);

let timedOut = false;
const killTimer = setTimeout(() => {
  timedOut = true;
  child.kill("SIGKILL");
}, 300_000);
const exit = await new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
clearTimeout(killTimer);
foreign.close();

console.log(
  `PLAYWRIGHT_EXIT code=${exit.code} signal=${exit.signal} TIMED_OUT=${timedOut} FOREIGN_HITS=${foreignHits} FOREIGN_LISTENING=${foreignListening} CONFLICT_SEEN=${conflictSeen}`,
);
// 재현 실패(exit 2): 이 시험이 보려는 상황(외부 서버가 잡은 포트에 vite 가 부딪힘)이 만들어지지 않았다 — 합격으로도 불합격으로도 셀 수 없다
if (!foreignListening) {
  console.error(`재현 실패: 다른 서버가 listening 을 마치지 못했다 (${foreignBindStarted ? (foreignError?.code ?? "listen 콜백 없음") : "webServer 시작 로그를 못 봄"})`);
  process.exit(2);
}
if (timedOut || exit.signal !== null || exit.code === null) {
  console.error(`재현 실패: playwright 가 시간 초과/시그널로 끝났다 (timedOut=${timedOut} signal=${exit.signal})`);
  process.exit(2);
}
if (!conflictSeen) {
  console.error(`재현 실패: vite 의 "Port ${freePort} is already in use" 충돌 오류를 못 봤다 (빌드 실패 등 다른 이유로 끝났을 수 있다)`);
  process.exit(2);
}
if (exit.code !== 0 && foreignHits === 0) {
  console.log("합격: 외부 서버가 포트를 잡았고 vite 가 충돌 오류를 냈으며, 다른 서버를 시험하지 않고 실패로 끝났다");
  process.exit(0);
}
console.error("불합격: 다른 서버를 시험했거나(요청 받음) 성공으로 끝났다");
process.exit(1);
