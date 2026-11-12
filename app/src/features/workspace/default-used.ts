/**
 * ‘기본값 쓰기’로 채운 글의 기록(U2c) — 초안과 같은 탭 저장소(sessionStorage)에 항목 하나(JSON 맵)로 따로 둔다. 초안 칸이 아니라서 초안 키 목록·개수에 끼지 않는다.
 * 새로고침·화면 이동 뒤에도 “기본값을 썼다”(used_default)가 이어지게 하려는 것: 기록 값이 지금 초안 글과 같을 때만 쓴 것으로 본다(바꾸면 false).
 * 저장소를 못 쓰면 모듈 수준 메모리에만 둔다. 맵의 키는 답 초안 키(질문 버전마다 다름)를 그대로 쓴다.
 */
const ITEM = "pes-default-used";
let memory: Record<string, string> = {};

function load(): Record<string, string> {
  try {
    const raw = window.sessionStorage.getItem(ITEM);
    if (raw === null) return memory;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, string>;
  } catch {
    /* 저장소 막힘·깨진 값 — 메모리로 */
  }
  return memory;
}

export function readDefaultUsed(answerKey: string): string | undefined {
  const v = load()[answerKey];
  return typeof v === "string" ? v : undefined;
}

export function writeDefaultUsed(answerKey: string, value: string | null): void {
  const next = { ...load() };
  if (value === null) delete next[answerKey];
  else next[answerKey] = value;
  memory = next;
  try {
    if (Object.keys(next).length === 0) window.sessionStorage.removeItem(ITEM);
    else window.sessionStorage.setItem(ITEM, JSON.stringify(next));
  } catch {
    /* 메모리에만 */
  }
}
