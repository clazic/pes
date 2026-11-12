import type { AiAccess, MaterialRow } from "@/api/types";

/**
 * 내 자료의 화면 낱말(MAT1c) — 서버는 기계 값만 싣고 보이는 말은 여기서 만든다.
 * 형식: text/plain → TXT · application/pdf → PDF · 그 밖은 파일 확장자 대문자. 모르면 지어내지 않고 “형식 모름”.
 */
export function formatWord(row: Pick<MaterialRow, "media_type" | "original_name">): string {
  const type = row.media_type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "text/plain") return "TXT";
  if (type === "application/pdf") return "PDF";
  const dot = row.original_name.lastIndexOf(".");
  const ext = dot > 0 ? row.original_name.slice(dot + 1) : "";
  return /^[A-Za-z0-9]{1,8}$/.test(ext) ? ext.toUpperCase() : "형식 모름";
}

/** 바이트 → “10 B” · “2 KB” · “1.5 MB” (1024 단위, 소수는 한 자리, .0 은 뺀다) */
export function sizeWord(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "크기 모름";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  const shown = i === 0 ? String(value) : String(Math.round(value * 10) / 10);
  return `${shown} ${units[i]}`;
}

export const ACCESS_WORD: Record<AiAccess, string> = { allow: "AI 참조 허용", deny: "AI 참조 금지" };

/** 행의 data-ai-access 값 — 서버가 안 주면 unknown (허용으로 간주하지 않는다) */
export const accessState = (a: AiAccess | null): AiAccess | "unknown" => a ?? "unknown";
