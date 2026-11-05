// Process-tree CPU/RSS sampling for local platform proxies.
// Values are proxies, not per-request platform CPU metrics.

import { execFileSync } from "node:child_process";

export interface TreeStats {
  cpuMs: number;
  rssKb: number;
  processes: number;
}

interface Row {
  pid: number;
  ppid: number;
  rssKb: number;
  cpuMs: number;
}

function parseCpuTime(value: string): number {
  const trimmed = value.trim();
  const daySplit = trimmed.split("-");
  let days = 0;
  let rest = trimmed;
  if (daySplit.length === 2) {
    days = Number(daySplit[0]);
    rest = daySplit[1] ?? "0";
  }
  const parts = rest.split(":").map(Number);
  if (parts.some((part) => Number.isNaN(part))) return 0;
  let seconds = 0;
  if (parts.length === 3) seconds = (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
  else if (parts.length === 2) seconds = (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
  else seconds = parts[0] ?? 0;
  return (days * 86400 + seconds) * 1000;
}

function readRows(): Row[] {
  const out = execFileSync("ps", ["-Ao", "pid=,ppid=,rss=,time="], { encoding: "utf8" });
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        rssKb: Number(match[3]),
        cpuMs: parseCpuTime(match[4] ?? "0"),
      };
    })
    .filter((row): row is Row => row !== null);
}

export function snapshotTree(rootPid: number): TreeStats {
  const rows = readRows();
  const children = new Map<number, Row[]>();
  for (const row of rows) {
    const list = children.get(row.ppid) ?? [];
    list.push(row);
    children.set(row.ppid, list);
  }
  const root = rows.find((row) => row.pid === rootPid);
  if (!root) return { cpuMs: 0, rssKb: 0, processes: 0 };
  const queue: Row[] = [root];
  let cpuMs = 0;
  let rssKb = 0;
  let processes = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    processes += 1;
    cpuMs += current.cpuMs;
    rssKb += current.rssKb;
    queue.push(...(children.get(current.pid) ?? []));
  }
  return { cpuMs, rssKb, processes };
}

export async function measureTree<T>(
  rootPid: number,
  fn: () => Promise<T>,
): Promise<{ result: T; cpuMs: number; rssMb: number }> {
  const before = snapshotTree(rootPid);
  const result = await fn();
  const after = snapshotTree(rootPid);
  const rssMb = Math.max(before.rssKb, after.rssKb) / 1024;
  return { result, cpuMs: Math.max(0, after.cpuMs - before.cpuMs), rssMb };
}
