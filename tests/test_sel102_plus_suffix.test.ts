// SEL-102 1차 리뷰 2회차 권장: audio/video/font 형식이라도 '+xml' 같은 구조 접미사가 붙으면 문서로 열릴 수 있으니 sandbox 를 붙인다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { needs_document_sandbox } from "../scripts/pes_core/document_sandbox.ts";

test("P1 video/audio/font 에 '+' 접미사가 붙은 형식은 sandbox, 평범한 미디어 형식은 그대로", () => {
  for (const t of ["video/x-foo+xml", "audio/x-bar+xml", "font/x-baz+xml", "VIDEO/X-FOO+XML; charset=utf-8"]) assert.equal(needs_document_sandbox(t), true, t);
  for (const t of ["video/mp4", "audio/mpeg", "font/woff2", "image/png", "application/pdf"]) assert.equal(needs_document_sandbox(t), false, t);
});
