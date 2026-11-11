// Node version guard of the PES entry points (scripts/pes.ts, setup.ts, serve.ts): PES needs Node 26 or newer (node:sqlite, type stripping).
// An older Node gets one Korean line and exit 1 here, before any PES module loads — not an English loader error halfway through a command.
// This file uses only what every Node that can strip types has (no import, no type-only syntax), so it runs on the old Node it refuses.

export const NODE_MAJOR_MIN = 26;

const major = Number.parseInt(String(process.versions.node).split(".")[0] ?? "", 10);
if (!(major >= NODE_MAJOR_MIN)) {
  process.stderr.write(`PES 는 Node.js ${NODE_MAJOR_MIN} 이상이 필요합니다 (지금 ${process.versions.node}) — https://nodejs.org 에서 ${NODE_MAJOR_MIN} 이상을 설치한 뒤 다시 실행하세요\n`);
  process.exit(1);
}
