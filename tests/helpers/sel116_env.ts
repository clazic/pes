// SEL-116 (3단계 MAT1b) 공용 준비물 — 내 자료 글자·표 추출(file_extract·file_extractions) 시험. 합성 값만 쓴다.
//
// 선행 계약: SEL-115(MAT1a)의 표 (tests/helpers/sel115_env.ts 머리말) — file.upload / POST P/materials / GET P/materials /
//   file.ai_access_set / POST P/file-policies/{fp}/ai-access / GET P/files/{b}/content·preview. 이 파일은 그 표를 그대로 쓰는
//   작은 복사본(http_blob·upload_material·set_access)을 따로 둔다 — SEL-115 가 main 에 들어오기 전에도 이 시험이 "추출이 아직
//   없어서" 실패하도록, 그리고 SEL-115 위로 올릴 때 sel115_env 와 이름이 겹치지 않도록.
//
// ── SEL-116 이 정한 인터페이스 (구현이 이 표를 따른다. 이름이 바뀌면 이 파일과 머리말만 고친다) ─────────────────────────
//
// 명령 (CommandService.execute 이름 / 영수증 action = 사건 type):
//   file.extract       {version_id, blob_id}   — 그 버전에 붙은 원본 blob 하나의 글자·표를 뽑는다. 영수증 action·사건 type: file.extracted
//                      (성공·부분·실패·미지원 **모두** 한 번씩 기록 — "시도했다"는 사실이 남는다).
//                      결과 {extraction_id, version_id, blob_id, source_file_policy_id, source_format, extractor, extractor_version,
//                            status:"extracted"|"partial"|"unsupported"|"failed", reason:string|null,
//                            text_blob_id|null, text_file_policy_id|null, text_hash|null (= 추출 글자 sha256 hex),
//                            page_count:number|null, table_count:number, warnings:[{code, message}], changed:boolean}
//   DB 행 file_extractions: status 'extracted'→'ready', 'partial'→'partial', 'failed'→'failed', 'unsupported'→'unsupported'(001_initial 의 CHECK).
//                      source_file_policy_id = 원본 blob 의 file_policies.id, text_file_policy_id = 추출 글자 blob 의 **따로 만든** 정책 id.
//                      unsupported·failed 행은 text_* 가 모두 NULL, warnings_json 은 비지 않는다.
//   사건 payload 에는 글자 본문·원본 이름이 들어가지 않는다(/changes 는 에이전트도 읽는다) — extraction_id·status·source_format·개수 정도만.
//
// HTTP (/api/v1/projects/{id} 아래, Success/Error 봉투):
//   POST /file-extractions   Idempotency-Key 필수, **소유자 세션 또는 file:write 토큰**(file:write 없는 토큰 403, 인증 없음 401).
//                            본문 {version_id, blob_id}. 201 data = file.extract 결과(같은 키·본문 다시 = replayed:true).
//                            모르는 version/blob·그 버전에 안 붙은 blob·다른 프로젝트 것 404, 모르는 칸·타입 틀림 400.
//                            deny 원본은 에이전트에게 403(이름·id·해시 비노출), 소유자는 가능.
//                            **이미 같은 (version_id, blob_id, extractor, extractor_version) 추출이 있으면 새 행·blob·사건 없이
//                            기존 결과를 changed:false 로 돌려준다**(다른 키로 다시 눌러도 멱등).
//   GET  /materials          각 항목에 두 칸이 더해진다 — extraction_status: "extracted"|"partial"|"unsupported"|"failed"|"not_extracted",
//                            extraction: null | {extraction_id, status, source_format, extractor, extractor_version, text_blob_id|null,
//                            text_file_policy_id|null, text_hash|null, page_count, table_count, warnings, reason, text_ai_access?}.
//                            agent 에게는: 원본이 deny 면 항목 통째로 없음(SEL-115). 원본 allow 라도 추출 글자 정책이 deny 면
//                            extraction 의 text_* 칸은 null 이고 status 만 보인다. text_ai_access 칸은 사람에게만.
//   GET  /context            data.materials = GET /materials 와 같다(agent 는 같은 규칙).
//   GET  /files/{text_blob_id}/content·preview   추출 글자 blob 읽기. 규칙은 다른 blob 과 같다 + **원본 정책이 deny 면 막는다(엄격한 쪽 우선)**.
//
// 추출 글자 blob:
//   media_type 은 "text/plain" 로 시작, original_name 은 ".txt" 로 끝나고 원본 이름을 포함, 글자는 UTF-8(BOM 없음), 줄바꿈 LF.
//   새 blob + 새 file_policies 행(원본 정책과 다른 id·다른 blob). 정책은 원본을 **자동 상속하지 않고** 따로 둔다:
//     - 추출본 정책은 **항상 allow rev 1 로 만든다**(원본이 deny 여도) — 원본 deny 는 읽기 쪽에서 엄격 우선으로 막는다.
//     - 읽기 허용 = 원본 정책 allow **그리고** 추출본 정책 allow (둘 중 하나라도 deny 면 에이전트에게 비노출).
//     - 사람이 추출본 정책을 따로 deny 로 둔 것은 원본 스위치가 바뀌어도 사라지지 않는다.
//   같은 바이트로 추출되면 blob 이 같아서 정책도 같다(blob 당 정책 하나).
//
// 형식별 결정 (docs/plan/stage-3.md 35행 '옛 형식은 시험 후 결정'의 시험 결과):
//   형식은 원본 이름의 확장자(소문자)로 정한다: txt md csv docx xlsx pptx hwpx hwp doc xls ppt pdf, 그 밖은 "unknown".
//   · txt·md·csv : 그대로 읽는다. 허용 인코딩 UTF-8 (UTF-8 BOM 은 벗긴다). CRLF·CR → LF. 그 밖 인코딩(UTF-16·CP949 등 UTF-8 로
//     해석 안 되는 바이트)은 글자를 짐작하지 않고 failed (warning code "invalid_encoding"). 빈 파일은 extracted, 글자 "" (blob 은 만든다).
//     csv 의 표 구조는 **원래 csv 글자를 그대로 둔다**(따옴표·쉼표·줄 유지, BOM·줄바꿈만 정리). table_count: csv 비어 있지 않으면 1, txt·md 0.
//   · docx·xlsx·pptx·hwpx : zip + XML 이다. **Node 기본 기능(node:zlib 의 inflateRawSync, 직접 만든 zip 목록 읽기, 직접 만든 XML 읽기)만으로
//     가능 — 새 npm 의존성·외부 프로그램 없음.** 문단은 한 줄(문단 사이 "\n"), 표는 마크다운 파이프 표
//     한 행당 한 줄 `| 칸1 | 칸2 |` (칸 안 `|` 는 `\|`, 칸 안 줄바꿈은 공백) + 첫 행 뒤 `| --- | --- |` 구분줄.
//     · docx: word/document.xml 의 w:p/w:t, 표 w:tbl/w:tr/w:tc. table_count = 표 수. page_count = null.
//     · pptx: ppt/slides/slideN.xml 을 **N 의 숫자 순서**(slide2 < slide10)로, 슬라이드마다 `## 슬라이드 N` 머리, a:p/a:t, 표 a:tbl.
//             page_count = 슬라이드 수.
//     · xlsx: xl/workbook.xml 시트 순서대로 `## 시트이름` 머리 + 파이프 표(비어 있지 않은 행만, 빈 칸은 빈 글자). 공유 문자열·인라인 문자열·숫자
//             (값 그대로 "12.5"). table_count = 비어 있지 않은 시트 수, page_count = 시트 수.
//     · hwpx: Contents/section*.xml(번호 순) 의 hp:p/hp:t, 표 hp:tbl/hp:tr/hp:tc. page_count = null.
//     부분 실패: 본문 주 부품은 읽었는데 일부 부품(슬라이드·시트·구역) 하나가 깨졌으면 status "partial", 읽은 부분 글자는 남기고
//     warnings 에 {code:"part_unreadable"}. 주 부품이 없거나 깨졌으면 failed (code "invalid_document"), zip 이 아니거나 잘렸으면 failed (code "invalid_container").
//   · hwp doc xls ppt pdf unknown : 이 컴퓨터엔 추출 도구(pdftotext·hwp5txt·libreoffice 등)가 없고 순수 Node 로 믿을 만하게 읽을 수 없다.
//     status "unsupported", reason "unsupported_format", warnings[0].code "unsupported_format" 이고 message 에 형식 이름이 들어간다.
//     글자를 짐작해서 만들지 않는다: text_blob_id·text_file_policy_id·text_hash 모두 null, blob·정책이 새로 생기지 않는다.
//   · 상한(기본값): 원본 크기 > 32 MiB → failed (code "too_large"); zip 안 XML 을 펼친 합계 > 64 MiB(zip 폭탄) → failed (code "too_large"),
//     펼치기 전에 중단한다. 상한 넘는 파일의 글자를 일부만 돌려주지 않는다.

import assert from "node:assert/strict";
import { crc32, deflateRawSync } from "node:zlib";

import { sha256_hex } from "./backup_fixture.ts";
import { call, project_path, type ApiEnv, type ApiResponse, type Auth } from "./api_env.ts";
import type { Db } from "../../scripts/pes_core/db.ts";

export const P = (env: ApiEnv, rest = ""): string => project_path(env, rest);

export interface Blob {
  blob_id: string;
  sha256: string;
  size: number;
}

/** POST /uploads → PUT → complete (이미 있는 동작). 같은 바이트면 dedup 된 같은 blob. */
export async function http_blob(
  env: ApiEnv,
  bytes: Uint8Array,
  opts: { media_type?: string; name?: string; auth?: Auth } = {},
): Promise<Blob> {
  const auth = opts.auth ?? "owner";
  const sha = sha256_hex(bytes);
  const media_type = opts.media_type ?? "application/octet-stream";
  const reserved = await call(env, {
    method: "POST",
    path: P(env, "/uploads"),
    auth,
    body: { sha256: sha, size: bytes.byteLength, media_type, original_name: opts.name ?? "합성자료.txt" },
  });
  assert.ok(reserved.status === 200 || reserved.status === 201, `reserve ${reserved.status} ${JSON.stringify(reserved.json)}`);
  const blob_id = reserved.json.data.blob_id as string;
  if (reserved.json.data.state !== "ready") {
    const put = await call(env, { method: "PUT", path: P(env, `/uploads/${blob_id}`), auth, raw: bytes, headers: { "content-type": media_type } });
    assert.equal(put.status, 200, `put ${JSON.stringify(put.json)}`);
    const done = await call(env, { method: "POST", path: P(env, `/uploads/${blob_id}/complete`), auth, body: {} });
    assert.equal(done.status, 200, `complete ${JSON.stringify(done.json)}`);
    assert.equal(done.json.data.state, "ready");
  }
  return { blob_id, sha256: sha, size: bytes.byteLength };
}

export function upload_material(env: ApiEnv, body: Record<string, unknown>, auth: Auth = "owner"): Promise<ApiResponse> {
  return call(env, { method: "POST", path: P(env, "/materials"), auth, body });
}

export function set_access(env: ApiEnv, file_policy_id: string, ai_access: "allow" | "deny", auth: Auth = "owner"): Promise<ApiResponse> {
  return call(env, { method: "POST", path: P(env, `/file-policies/${file_policy_id}/ai-access`), auth, body: { ai_access } });
}

export interface Mat {
  data: any;
  blob: Blob;
  name: string;
  bytes: Uint8Array;
}

/** 바이트를 올려 자료로 등록한다(201 확인). 이름의 확장자가 형식을 정한다. */
export async function material_of(env: ApiEnv, name: string, bytes: Uint8Array, media_type = "application/octet-stream"): Promise<Mat> {
  const blob = await http_blob(env, bytes, { name, media_type });
  const res = await upload_material(env, { blob_id: blob.blob_id, title: `제목 ${name}` });
  assert.equal(res.status, 201, `upload_material ${res.status} ${JSON.stringify(res.json)}`);
  return { data: res.json.data, blob, name, bytes };
}

export function extract(env: ApiEnv, m: Mat, auth: Auth = "owner", key?: string | null): Promise<ApiResponse> {
  return call(env, {
    method: "POST",
    path: P(env, "/file-extractions"),
    auth,
    body: { version_id: m.data.version_id, blob_id: m.blob.blob_id },
    ...(key === undefined ? {} : { key }),
  });
}

/** 올리고 바로 추출해서 결과 data(201 확인)를 돌려준다. */
export async function extracted(env: ApiEnv, name: string, bytes: Uint8Array): Promise<{ m: Mat; r: any }> {
  const m = await material_of(env, name, bytes);
  const res = await extract(env, m);
  assert.equal(res.status, 201, `extract ${name}: ${res.status} ${JSON.stringify(res.json)}`);
  return { m, r: res.json.data };
}

/** 추출 글자 blob 을 소유자로 읽어 글자로 돌려준다. */
export async function text_of(env: ApiEnv, r: { text_blob_id: string | null }): Promise<string> {
  assert.ok(r.text_blob_id !== null, "text_blob_id expected");
  const got = await call(env, { method: "GET", path: P(env, `/files/${r.text_blob_id}/content`), auth: "owner" });
  assert.equal(got.status, 200, `content ${got.status}`);
  return Buffer.from(got.bytes ?? new Uint8Array()).toString("utf8");
}

// ---------------------------------------------------------------------------
// DB 읽기

export interface ExtractionRow {
  id: string;
  version_id: string;
  blob_id: string;
  source_file_policy_id: string;
  source_format: string;
  extractor: string;
  extractor_version: string;
  status: string;
  text_blob_id: string | null;
  text_file_policy_id: string | null;
  text_hash: string | null;
  page_count: bigint | null;
  table_count: bigint | null;
  warnings_json: string;
  tx_id: string;
}

export function extraction_rows(db: Db, project_id: string): ExtractionRow[] {
  return db.all<ExtractionRow>(
    `SELECT id, version_id, blob_id, source_file_policy_id, source_format, extractor, extractor_version, status,
            text_blob_id, text_file_policy_id, text_hash, page_count, table_count, warnings_json, tx_id
       FROM file_extractions WHERE project_id = ? ORDER BY rowid`,
    project_id,
  );
}

export function count(db: Db, table: string): number {
  return Number(db.get<{ n: bigint }>(`SELECT count(*) AS n FROM ${table}`)?.n ?? 0n);
}

export function events_of(db: Db, type: string): Array<{ payload: string }> {
  return db.all<{ payload: string }>("SELECT payload FROM events WHERE type = ? ORDER BY seq", type);
}

export function receipts_of(db: Db, action: string): number {
  return Number(db.get<{ n: bigint }>("SELECT count(*) AS n FROM mutation_commits WHERE action = ?", action)?.n ?? 0n);
}

export function wire_of(res: ApiResponse): string {
  const bytes = res.bytes === null ? "" : Buffer.from(res.bytes).toString("utf8");
  return JSON.stringify(res.json) + "\n" + bytes;
}

// ---------------------------------------------------------------------------
// 합성 zip / office 파일 (Node 기본 기능만, 실제 자료 아님)

export interface ZipEntry {
  name: string;
  data: string | Uint8Array;
  /** 기본 deflate. "store" 면 압축하지 않는다. */
  method?: "deflate" | "store";
  /** 헤더에 적는 풀린 크기를 일부러 속인다(zip 폭탄 시험). */
  claimed_size?: number;
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}
function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

export function make_zip(entries: ZipEntry[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = typeof e.data === "string" ? Buffer.from(e.data, "utf8") : Buffer.from(e.data);
    const method = e.method === "store" ? 0 : 8;
    const packed = method === 0 ? raw : deflateRawSync(raw);
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(raw);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(method), u16(0), u16(0x21),
      u32(crc), u32(packed.length), u32(e.claimed_size ?? raw.length), u16(name.length), u16(0), name, packed,
    ]);
    centrals.push(
      Buffer.concat([
        u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(method), u16(0), u16(0x21),
        u32(crc), u32(packed.length), u32(e.claimed_size ?? raw.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name,
      ]),
    );
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cd.length), u32(offset), u16(0)]);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
export const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export type Block = string | string[][];

/** docx: 문자열 = 문단, 2차원 배열 = 표. */
export function make_docx(blocks: Block[], extra: ZipEntry[] = []): Uint8Array {
  const body = blocks
    .map((b) =>
      typeof b === "string"
        ? `<w:p><w:r><w:t>${esc(b)}</w:t></w:r></w:p>`
        : `<w:tbl>${b.map((row) => `<w:tr>${row.map((c) => `<w:tc><w:p><w:r><w:t>${esc(c)}</w:t></w:r></w:p></w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`,
    )
    .join("");
  return make_zip([
    { name: "[Content_Types].xml", data: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>` },
    {
      name: "word/document.xml",
      data: `${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    },
    ...extra,
  ]);
}

/** pptx: 슬라이드마다 Block[] (이름 번호는 slide_numbers 로 지정, 기본 1..n). */
export function make_pptx(slides: Block[][], opts: { numbers?: number[]; broken?: number[] } = {}): Uint8Array {
  const entries: ZipEntry[] = [{ name: "[Content_Types].xml", data: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>` }];
  slides.forEach((blocks, i) => {
    const n = opts.numbers?.[i] ?? i + 1;
    const shapes = blocks
      .map((b) =>
        typeof b === "string"
          ? `<p:sp><p:txBody><a:p><a:r><a:t>${esc(b)}</a:t></a:r></a:p></p:txBody></p:sp>`
          : `<p:graphicFrame><a:graphic><a:graphicData><a:tbl>${b
              .map((row) => `<a:tr>${row.map((c) => `<a:tc><a:txBody><a:p><a:r><a:t>${esc(c)}</a:t></a:r></a:p></a:txBody></a:tc>`).join("")}</a:tr>`)
              .join("")}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`,
      )
      .join("");
    const xml = opts.broken?.includes(n)
      ? `${XML}<p:sld xmlns:p="x" xmlns:a="y"><p:cSld><a:p><a:t>깨짐 ${n}`
      : `${XML}<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>${shapes}</p:spTree></p:cSld></p:sld>`;
    entries.push({ name: `ppt/slides/slide${n}.xml`, data: xml });
  });
  entries.push({ name: "ppt/presentation.xml", data: `${XML}<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>` });
  return make_zip(entries);
}

export interface Sheet {
  name: string;
  /** 문자열은 공유 문자열로, number 는 숫자 칸으로, {inline} 은 인라인 문자열로, null 은 빈 칸. */
  rows: Array<Array<string | number | { inline: string } | null>>;
}

const col_letter = (i: number): string => String.fromCharCode(65 + i);

export function make_xlsx(sheets: Sheet[], opts: { broken_sheet?: number } = {}): Uint8Array {
  const shared: string[] = [];
  const si = (s: string): number => {
    const at = shared.indexOf(s);
    if (at >= 0) return at;
    shared.push(s);
    return shared.length - 1;
  };
  const sheet_xml = sheets.map((s, idx) => {
    if (opts.broken_sheet === idx + 1) return `${XML}<worksheet><sheetData><row r="1"><c r="A1"><v>깨짐`;
    const rows = s.rows
      .map((row, r) => {
        const cells = row
          .map((c, ci) => {
            const ref = `${col_letter(ci)}${r + 1}`;
            if (c === null) return "";
            if (typeof c === "number") return `<c r="${ref}"><v>${c}</v></c>`;
            if (typeof c === "string") return `<c r="${ref}" t="s"><v>${si(c)}</v></c>`;
            return `<c r="${ref}" t="inlineStr"><is><t>${esc(c.inline)}</t></is></c>`;
          })
          .join("");
        return `<row r="${r + 1}">${cells}</row>`;
      })
      .join("");
    return `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  });
  const entries: ZipEntry[] = [
    { name: "[Content_Types].xml", data: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>` },
    {
      name: "xl/workbook.xml",
      data: `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
        .map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join("")}</sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
        .map((_s, i) => `<Relationship Id="rId${i + 1}" Type="worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join("")}</Relationships>`,
    },
    ...sheet_xml.map((xml, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: xml })),
    {
      name: "xl/sharedStrings.xml",
      data: `${XML}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared
        .map((s) => `<si><t>${esc(s)}</t></si>`)
        .join("")}</sst>`,
    },
  ];
  return make_zip(entries);
}

/** hwpx: 구역마다 Block[] (Contents/section0.xml, section1.xml …). */
export function make_hwpx(sections: Block[][], opts: { broken?: number[] } = {}): Uint8Array {
  const entries: ZipEntry[] = [
    { name: "mimetype", data: "application/hwp+zip", method: "store" },
    { name: "Contents/content.hpf", data: `${XML}<opf:package xmlns:opf="http://www.idpf.org/2007/opf/"/>` },
  ];
  sections.forEach((blocks, i) => {
    const body = blocks
      .map((b) =>
        typeof b === "string"
          ? `<hp:p><hp:run><hp:t>${esc(b)}</hp:t></hp:run></hp:p>`
          : `<hp:p><hp:run><hp:tbl>${b
              .map((row) => `<hp:tr>${row.map((c) => `<hp:tc><hp:subList><hp:p><hp:run><hp:t>${esc(c)}</hp:t></hp:run></hp:p></hp:subList></hp:tc>`).join("")}</hp:tr>`)
              .join("")}</hp:tbl></hp:run></hp:p>`,
      )
      .join("");
    const xml = opts.broken?.includes(i)
      ? `${XML}<hs:sec xmlns:hs="a" xmlns:hp="b"><hp:p><hp:run><hp:t>깨짐 ${i}`
      : `${XML}<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">${body}</hs:sec>`;
    entries.push({ name: `Contents/section${i}.xml`, data: xml });
  });
  return make_zip(entries);
}

/** 옛 형식 흉내: OLE 머리 + 일부러 읽히는 ASCII 표식 (추출기가 이걸 글자로 지어내면 안 된다). */
export function fake_legacy(marker: string): Uint8Array {
  const head = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0, 0, 0, 0, 0]);
  return new Uint8Array(Buffer.concat([head, Buffer.from(`\0\0${marker}\0\0 plain readable ascii ${marker}`, "latin1")]));
}

export function fake_pdf(marker: string): Uint8Array {
  return new Uint8Array(
    Buffer.from(`%PDF-1.4\n1 0 obj<<>>endobj\nBT /F1 12 Tf (${marker}) Tj ET\ntrailer<<>>\n%%EOF\n`, "latin1"),
  );
}

/** 에이전트가 읽을 수 있는 HTTP 읽기 경로를 돌려 한 덩어리 글자로 모은다. */
export async function agent_sweep(
  env: ApiEnv,
  token: string,
  paths: Array<[string, string]>,
): Promise<{ text: string; statuses: Record<string, number> }> {
  let text = "";
  const statuses: Record<string, number> = {};
  for (const [label, path] of paths) {
    const res = await call(env, { method: "GET", path, auth: { token } });
    statuses[label] = res.status;
    text += `\n--${label}--\n${wire_of(res)}`;
  }
  return { text, statuses };
}
