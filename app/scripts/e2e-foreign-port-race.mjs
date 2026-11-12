// SEL-96 재현·회귀 확인 — "고른 포트를 다른 서버가 먼저 잡으면 e2e 가 그 다른 서버를 시험하고 성공하는" 일이 없어야 한다.
// 실행: cd app && hc-heavy node scripts/e2e-foreign-port-race.mjs   (HOME·USERPROFILE·PES_HOME 은 임시 폴더로 바꾼 셸에서)
//
// 순서: ① 빈 포트를 골라 PES_E2E_PORT 로 준다 ② playwright 가 webServer(빌드 → preview)를 시작하면
// ③ 그 포트에 "다른 서버"를 바인딩한다(빌드가 도는 동안 다른 프로세스가 포트를 가로챈 상황) ④ playwright 가 끝나길 기다린다.
// 합격 = playwright 가 실패로 끝나고(exit != 0) 다른 서버가 요청을 한 번도 받지 않음(그 서버를 시험하지 않음).
// 예전 설정(webServer.url 응답으로 준비 완료 판단)에서는 다른 서버의 200 응답을 "준비됨"으로 받아 시험하고 exit 0 으로 끝났다.
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const playwrightCli = path.join(appDir, "node_modules", "playwright", "cli.js");

const home = process.env.HOME ?? "";
if (!home || home === "/Users/clazic" || /^[A-Za-z]:\\Users\\[^\\]+$/.test(process.env.USERPROFILE ?? "")) {
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

let foreignListening = false;
const bindForeign = () => {
  if (foreignListening) return;
  foreignListening = true;
  foreign.listen(freePort, "127.0.0.1", () => console.log(`FOREIGN_LISTENING ${freePort}`));
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
const onData = (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);
  if (text.includes("Starting WebServer process")) bindForeign();
};
child.stdout.on("data", onData);
child.stderr.on("data", onData);

const killTimer = setTimeout(() => child.kill("SIGKILL"), 300_000);
const exit = await new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
clearTimeout(killTimer);
foreign.close();

console.log(`PLAYWRIGHT_EXIT code=${exit.code} signal=${exit.signal} FOREIGN_HITS=${foreignHits} FOREIGN_BOUND=${foreignListening}`);
if (!foreignListening) {
  console.error("재현 실패: webServer 시작 로그를 못 봐서 다른 서버를 띄우지 못했다");
  process.exit(2);
}
if (exit.code !== 0 && foreignHits === 0) {
  console.log("합격: 다른 서버를 시험하지 않고 실패로 끝났다");
  process.exit(0);
}
console.error("불합격: 다른 서버를 시험했거나(요청 받음) 성공으로 끝났다");
process.exit(1);
