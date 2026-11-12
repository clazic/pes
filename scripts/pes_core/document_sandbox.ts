/**
 * SEL-102: which stored / served bodies must carry the response sandbox (`Content-Security-Policy: sandbox …`, opaque origin).
 *
 * A browser opens many types as a DOCUMENT that can run script (html, xhtml, svg, any xml flavour, `text/xsl` …) and the list grows with the browser, while the type is chosen
 * by whoever wrote the file. So this is NOT a list of the dangerous types: only a short list of types that cannot be a script-running document is let through, every other
 * type (empty, unknown, odd) gets the sandbox. A sandbox on a body that is not a page is harmless (only a PDF viewer minds, and PDF is on the list).
 *
 * Shared by the static fallback (serve.ts) and GET …/files/{b}/content (api.ts) so the two cannot drift apart.
 */
const SAFE_TYPE = new RegExp(
  "^(?:" +
    [
      "image/(?:png|jpeg|gif|webp|avif|bmp|vnd\\.microsoft\\.icon|x-icon)",
      "application/(?:pdf|octet-stream|json|javascript|wasm|zip|gzip|x-tar|vnd\\.openxmlformats-officedocument\\.[a-z.]+)",
      "text/(?:plain|csv|markdown|css|javascript)",
      // no "+" — a structured-syntax suffix such as video/x-foo+xml can still be opened as an xml document (SEL-102 1차 2회차)
      "(?:audio|video|font)/[a-z0-9._-]+",
    ].join("|") +
    ")$",
  "i",
);

/** `media_type` is a Content-Type value; parameters (`; charset=…`), case and surrounding blanks do not matter. */
export const needs_document_sandbox = (media_type: string): boolean => {
  // A comma list ("text/plain; x=y, text/html") is read by browsers as its LAST type (fetch "extract a MIME type"),
  // so judging only the part before the first ";" would let html through — any comma means sandbox (SEL-102 최종 권장 1).
  if (media_type.includes(",")) return true;
  const bare = (media_type.split(";", 1)[0] ?? "").trim();
  return !SAFE_TYPE.test(bare);
};
