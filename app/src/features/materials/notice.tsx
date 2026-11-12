import { cn } from "@/lib/utils";

/**
 * 정직한 금지 안내(SEL-111 · 설계 5.3 · 240행) — 금지는 PES 의 AI 도구 · MCP · 프롬프트에서 그 파일을 뺀다는 뜻이다.
 * B(내 컴퓨터)에서 파일을 직접 읽는 것은 막지 못하고, 이미 나간 내용은 회수되지 않는다. 막을 수 없는 경로를 ‘보장’이라고 쓰지 않는다.
 */
export const DENY_FACTS = {
  scope: "금지하면 PES 의 AI 도구 · MCP · 프롬프트에서 이 파일을 제외합니다.",
  direct: "B(내 컴퓨터)에서 AI 가 파일을 직접 읽는 것은 PES 가 막지 못합니다.",
  sent: "이미 나간 내용은 회수되지 않습니다.",
  human: "사람 화면에서는 금지한 파일도 계속 보입니다.",
} as const;

/** 표 위 상시 안내 */
export function DenyNotice({ className }: { className?: string }) {
  return (
    <div data-deny-notice="" className={cn("rounded-md border border-line bg-surface-sunk px-3 py-2.5 text-meta text-ink-2", className)}>
      <p className="font-medium text-ink">AI 참조를 금지하면 어떻게 되나요?</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        <li>{DENY_FACTS.scope}</li>
        <li>{DENY_FACTS.direct}</li>
        <li>{DENY_FACTS.sent}</li>
        <li>{DENY_FACTS.human}</li>
      </ul>
    </div>
  );
}
