import type { StatusRef } from "./types";

/**
 * “실제로 AI에 가나요?” — 서버가 목적지별로 결과와 이유를 계산한다(설계 5.3, Codex F02·B4).
 * 화면은 이 결과를 그대로 그린다. 사람이 머리로 세 겹(AI가 읽기 · 파일 AI 참조 · 참고 원본)을 합성하지 않게 한다.
 *
 * 목적지
 *  - api_a     방식 A: PES가 등록된 AI 연결(API)로 보냄 — AI가 읽기가 적용됨
 *  - b_api     방식 B 도구가 API 목적지로 보냄(예: 도구가 PES에 등록된 것과 같은 구독형 API 모델을 씀) — AI가 읽기 적용
 *  - b_other   방식 B 그 밖의 도구가 PES를 거쳐 읽음(예: Claude Code) — AI가 읽기는 적용 안 됨(이름과 달리 API 목적지에만 — 설계 15.6), 파일 AI 참조는 적용
 *  - pc_folder 내 컴퓨터 AI 작업 폴더(도우미 동기화) — 금지 파일은 받지 않지만 이미 받은 사본·다른 폴더는 PES가 못 막음
 *  - human     사람(열람·직접 인용·보관)
 * 원칙: 목적지를 모르거나 정책이 없거나 손상되면 허용으로 계산하지 않는다. 엄격한 쪽 우선.
 */
export type Destination = "api_a" | "b_api" | "b_other" | "pc_folder" | "human";

export const DEST_LABEL: Record<Destination, string> = {
  api_a: "방식 A · PES가 API로",
  b_api: "방식 B · API 목적지",
  b_other: "방식 B · 그 밖의 도구(PES 경유)",
  pc_folder: "내 컴퓨터 AI 작업 폴더",
  human: "사람",
};

export interface PolicyCase {
  id: string;
  label: string;
  api: "on" | "off" | "broken";
  file: "allow" | "deny";
  /** 참고 프로젝트에서 온 자료면 원본 정책 */
  ref?: { sourceApi: "on" | "off"; sourceFile: "allow" | "deny"; sourceAllows: string[]; tool: string };
  /** B 도구의 목적지를 모름 */
  destUnknown?: boolean;
}

export interface AccessResult {
  status: StatusRef;
  reason: string;
}

const g = (value: string, label?: string): StatusRef => ({ domain: "generic", value, label });

export function computeAccess(dest: Destination, c: PolicyCase): AccessResult {
  if (dest === "human") {
    return c.ref ? { status: g("visible"), reason: "두 프로젝트 모두 권한이 있을 때만" } : { status: g("visible"), reason: c.file === "deny" ? "봄 · 직접 인용 가능" : "봄" };
  }
  const fileAllows = c.file === "allow" && (!c.ref || c.ref.sourceFile === "allow");
  const fileReason = c.file === "deny" ? "이 파일 AI 참조 금지" : c.ref && c.ref.sourceFile === "deny" ? "원본 파일이 AI 참조 금지" : "";

  if (dest === "api_a" || dest === "b_api") {
    if (c.destUnknown && dest === "b_api") return { status: g("dest_unknown"), reason: "도구가 어떤 목적지로 보내는지 확인되지 않음 → API 목적지로 보고 엄격하게" };
    if (c.api === "broken") return { status: g("not_sent", "안 보냄 · 차단 중"), reason: "AI가 읽기 정책을 확인할 수 없음(누락·손상) → 허용으로 계산하지 않음" };
    if (c.api === "off") return { status: g("not_sent", "안 보냄"), reason: dest === "api_a" ? "AI가 읽기: 막음 — 방식 A 실행 자체가 안 됨" : "AI가 읽기: 막음 — API 목적지는 A·B 공통으로 막음" };
    if (c.ref && c.ref.sourceApi === "off") return { status: g("not_sent", "안 보냄"), reason: "원본 프로젝트가 AI가 읽기: 막음 — 엄격한 쪽을 따름" };
    if (!fileAllows) return { status: g("not_sent", "안 보냄"), reason: fileReason };
    return { status: g("sends"), reason: "AI가 읽기: 허용 · 파일 허용" };
  }

  if (dest === "b_other") {
    if (!fileAllows) return { status: g("not_given"), reason: `${fileReason} — PES(MCP·WebMCP) 응답에서 뺌` };
    if (c.ref && !c.ref.sourceAllows.includes(c.ref.tool)) return { status: g("not_given"), reason: `원본이 ${c.ref.tool}을(를) 허용 목적지로 두지 않음` };
    if (c.ref) return { status: g("dest_only"), reason: `원본 허용 목적지(${c.ref.sourceAllows.join("·")})만 · AI가 읽기 정책은 API 목적지에만 적용` };
    return { status: g("gives"), reason: c.api === "on" ? "파일 허용" : "파일 허용 · AI가 읽기: 막음은 API 목적지에만 — 이 도구(PES 경유)는 파일 AI 참조를 따름" };
  }

  // pc_folder
  if (!fileAllows) return { status: g("not_received_limited"), reason: "AI 작업 폴더로 받지 않음 · 이미 받은 사본·다른 폴더는 도구가 직접 열 수 있음" };
  if (c.ref && !c.ref.sourceAllows.includes(c.ref.tool)) return { status: g("not_received_limited"), reason: "원본 허용 목적지 밖" };
  return { status: g("receives"), reason: "AI 작업 폴더로 받음" };
}

export const POLICY_CASES: PolicyCase[] = [
  { id: "c1", label: "AI가 읽기: 허용 + 파일 허용", api: "on", file: "allow" },
  { id: "c2", label: "AI가 읽기: 허용 + 파일 금지", api: "on", file: "deny" },
  { id: "c3", label: "AI가 읽기: 막음 + 파일 허용", api: "off", file: "allow" },
  { id: "c4", label: "AI가 읽기: 막음 + 파일 금지", api: "off", file: "deny" },
  { id: "c5", label: "AI가 읽기 정책 확인 불가(누락·손상)", api: "broken", file: "allow" },
  { id: "c6", label: "B 도구의 목적지 미확인 + 파일 허용", api: "on", file: "allow", destUnknown: true },
  { id: "c7", label: "참고 프로젝트 자료(원본 AI가 읽기: 막음 · 원본 파일 허용 · 원본 허용 목적지 Claude Code)", api: "on", file: "allow", ref: { sourceApi: "off", sourceFile: "allow", sourceAllows: ["Claude Code"], tool: "Claude Code" } },
];

export const DESTS: Destination[] = ["api_a", "b_api", "b_other", "pc_folder", "human"];
