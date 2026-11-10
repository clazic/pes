import { vi } from "vitest";
import { pes } from "@/api/mock-client";

/**
 * 시험 도구(UI7-4b 최종 리뷰 회귀) — pes.command 호출을 감시해(그대로 통과시킴) 제안 id 별 멱등 키를 기록한다.
 * 화면 코드·목 서버는 고치지 않는다. 시험이 끝나면 mockRestore 한다.
 */
export type Sent = { name: string; slug?: string; proposalId?: string; key: string };

export function spyDecisionCommands() {
  const sent: Sent[] = [];
  const original = pes.command.bind(pes) as (name: string, input: unknown, opts: { idempotencyKey: string }) => Promise<unknown>;
  const spy = vi.spyOn(pes, "command").mockImplementation(((name: string, input: unknown, opts: { idempotencyKey: string }) => {
    const i = (input ?? {}) as { slug?: string; proposal_id?: string };
    sent.push({ name, slug: i.slug, proposalId: i.proposal_id, key: opts?.idempotencyKey });
    return original(name, input, opts);
  }) as unknown as typeof pes.command);
  return {
    sent,
    /** decision.record 로 보낸 것만, 제안 id 별 키 목록(보낸 순서) */
    keysOf: (proposalId: string) => sent.filter((s) => s.name === "decision.record" && s.proposalId === proposalId).map((s) => s.key),
    restore: () => spy.mockRestore(),
  };
}
