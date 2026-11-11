// SEL-73 (stage 2 PR26d): 외부 도구(kosis·vworld 등)의 Python 요구를 "경계"로 문서에 표시한다.
// 어디에 두나(해석): docs/plan/migration-ts-equivalence.md 9절("옮기지 않음 / 새 코어로 대체") 안의 새 소절 "외부 Python 경계"가
// 기준이고(9절 표의 setup.py 줄이 이미 "외부 경계로 유지"를 가리킨다), 사용자 문서 README.md 에 그 소절로 가는 한 줄 포인터를 둔다.
// 시험은 사실(kosis 가 정말 Python 을 요구하는가)을 단언하지 않는다 — 표시가 있고, 도구마다 한 줄씩 "Python"과 "경계"를 같이 적었는지만 본다.
// 저장소 파일을 읽기만 한다(CRLF → LF).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const DOC = join(REPO, "docs", "plan", "migration-ts-equivalence.md");

function text(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

interface Section {
  level: number;
  heading: string;
  body: string;
}

function sections(markdown: string): Section[] {
  const lines = markdown.split("\n");
  const found: Array<{ level: number; heading: string; at: number }> = [];
  let in_fence = false;
  lines.forEach((line, at) => {
    if (/^```/.test(line)) in_fence = !in_fence;
    if (in_fence) return;
    const m = /^(#{2,6}) (.+)$/.exec(line);
    if (m) found.push({ level: m[1]!.length, heading: m[2]!.trim(), at });
  });
  return found.map((h, i) => {
    let end = lines.length;
    for (let j = i + 1; j < found.length; j += 1) {
      if (found[j]!.level <= h.level) {
        end = found[j]!.at;
        break;
      }
    }
    return { level: h.level, heading: h.heading, body: lines.slice(h.at + 1, end).join("\n") };
  });
}

function boundary_section(): Section {
  const all = sections(text(DOC));
  const nine = all.findIndex((s) => /^9\./.test(s.heading));
  assert.ok(nine >= 0, "9절 exists");
  const hit = all.find((s) => s.level >= 3 && /외부/.test(s.heading) && /Python/.test(s.heading) && /경계/.test(s.heading));
  assert.ok(hit, "a sub-section whose heading names 외부 · Python · 경계 exists under 9절");
  // 9절 본문 안에 있어야 한다(10절 앞)
  const lines = text(DOC).split("\n");
  const pos = lines.findIndex((l) => l.includes(hit.heading));
  const ten = lines.findIndex((l) => /^## 10\./.test(l));
  const nine_at = lines.findIndex((l) => /^## 9\./.test(l));
  assert.ok(nine_at < pos && pos < ten, "the boundary sub-section sits inside 9절");
  return hit;
}

test("migration-ts-equivalence.md 9절 has an '외부 Python 경계' sub-section", () => {
  boundary_section();
});

for (const tool of ["kosis", "vworld"]) {
  test(`the boundary sub-section marks ${tool}'s Python requirement as a boundary (one line: tool + Python + 경계)`, () => {
    const section = boundary_section();
    const lines = section.body.split("\n").filter((l) => new RegExp(tool, "i").test(l));
    assert.ok(lines.length >= 1, `${tool} is listed in the sub-section`);
    assert.ok(
      lines.some((l) => /Python/i.test(l) && /경계/.test(l)),
      `a ${tool} line says both Python and 경계:\n${lines.join("\n")}`,
    );
  });
}

test("the boundary sub-section says what the boundary means for the TS core (not run, not imported, not required)", () => {
  const section = boundary_section();
  assert.match(section.body, /PES (TS )?코어|TS 코어/, "names the TS core");
  assert.match(section.body, /실행하지 않|호출하지 않|필요(하지|로 하지) 않|요구하지 않|의존하지 않/, "states the core does not depend on / run it");
  assert.match(section.body, /legacy/i, "ties the legacy importer to it (it never runs Python)");
});

test("the 9절 setup.py row and the new sub-section agree (the row points to the boundary)", () => {
  const nine = text(DOC).split("\n").filter((l) => l.includes("setup.py"));
  assert.ok(nine.some((l) => /경계/.test(l)), "the setup.py row keeps saying 경계");
});

test("README.md points at the boundary sub-section from the research-tools part", () => {
  const readme = text(join(REPO, "README.md"));
  const line = readme.split("\n").find((l) => /외부 Python 경계/.test(l));
  assert.ok(line, "README.md has a line with '외부 Python 경계'");
  assert.match(line!, /migration-ts-equivalence\.md/, "…linking the document that defines it");
});

test("the boundary is not described only in a discussion file: docs/plan/README.md index lists it", () => {
  const index = text(join(REPO, "docs", "plan", "README.md"));
  const row = index.split("\n").find((l) => l.includes("migration-ts-equivalence.md")) ?? "";
  assert.match(row, /외부 Python 경계|Python 경계/, `index row mentions the boundary: ${row}`);
});
