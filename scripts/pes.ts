#!/usr/bin/env node
// PES command line, TypeScript edition (PR26b): `node scripts/pes.ts <명령> <프로젝트 폴더> [인자]`.
// Node 26 strips the types itself — no build step, no loader. The work is in scripts/pes_core/ (cli_main.ts and the cli_*.ts modules);
// this file only starts it. Run it without arguments to see the commands.
// node_guard.ts first (Node 26 미만 → 한국어 한 줄, exit 1); the core is imported afterwards, so an old Node never meets node:sqlite.
import "./node_guard.ts";

const { main } = await import("./pes_core/cli_main.ts");
await main(process.argv.slice(2));
