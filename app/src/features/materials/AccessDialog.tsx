import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog as DialogPrimitive } from "radix-ui";
import { keys, newIdempotencyKey, useClient } from "@/api/queries";
import { PesApiError, type AiAccess, type CommandResult, type MaterialAiAccessResult, type MaterialRow } from "@/api/types";
import { Button } from "@/components/ui/button";
import { DENY_FACTS } from "./notice";

/** 스위치 id — 대화 상자가 닫힐 때 초점을 이 스위치로 돌려준다(행이 다시 그려져도 같은 id) */
export const switchId = (objectId: string) => `material-switch-${objectId}`;

export type AccessDone = { row: MaterialRow; next: AiAccess; result: CommandResult<MaterialAiAccessResult> };

const FOCUSABLE = 'a[href], button, input, textarea, select, [tabindex]:not([tabindex="-1"])';

/**
 * 대화 상자가 열려 있는 동안 나머지 화면을 inert 로 둔다 — 초점 · 클릭 · 화면 읽기가 못 닿는다(진짜 모달과 같은 효과).
 * aria-hidden 은 쓰지 않는다: 영수증 전에도 목록의 스위치는 “그대로” 읽혀야 한다(낙관적 갱신 없음)는 것을 화면 읽기가 확인할 수 있게, 값은 보이되 조작은 막는다.
 */
function useInertOutside(ref: React.RefObject<HTMLElement | null>) {
  React.useEffect(() => {
    const own = ref.current;
    if (!own) return;
    const held = [...document.body.children].filter((el) => !el.contains(own) && !el.hasAttribute("inert"));
    for (const el of held) el.setAttribute("inert", "");
    return () => {
      for (const el of held) el.removeAttribute("inert");
    };
  }, [ref]);
}

/** Tab 이 대화 상자 밖으로 나가지 않게 한 바퀴 돈다 */
function trapTab(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key !== "Tab") return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hasAttribute("disabled") && el.tabIndex !== -1);
  if (items.length === 0) return;
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const at = document.activeElement;
  if (e.shiftKey && (at === first || !e.currentTarget.contains(at))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (at === last || !e.currentTarget.contains(at))) {
    e.preventDefault();
    first.focus();
  }
}

/** 서버가 끝까지 거절한 것(다시 보내도 같은 결과) — retryable 이면 서버가 이미 받았을 수 있어 거절로 치지 않는다 */
const isFinalRejection = (e: unknown): e is PesApiError => e instanceof PesApiError && !e.body.error.retryable;

const fieldClass =
  "mt-1 block w-full resize-y rounded-md border border-control bg-background px-2.5 py-2 text-body text-ink shadow-xs outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/**
 * 파일별 AI 참조 바꾸기 확인 대화 상자(설계 240행 · F06) — 끄기는 “AI 참조 끄기”, 다시 켜기는 “AI 참조 다시 허용”. 동사 단추 이름이 대화 상자 이름과 같다.
 *  - 보내는 동안 동사 단추는 aria-disabled(초점 유지)이고 두 번 눌러도 한 번만 보낸다. 영수증 전에는 스위치가 그대로이고 “접수 확인 중”뿐이다(낙관적 갱신 없음).
 *  - 서버가 거절하면(PesApiError) role=alert 에 서버 말을 그대로 두고 대화 상자 · 입력한 이유는 그대로 — 다음 시도는 새 멱등 키.
 *  - 답이 오지 않음(시간 초과 등)은 실패가 아니라 “접수 확인 중”. 다시 누르면 같은 멱등 키로 보내 서버가 처음 영수증을 돌려준다. 이유를 고치면 새 요청.
 *  - 영수증을 받으면 목록을 다시 읽은 뒤 onDone 으로 부모가 닫고 알린다. 초점은 그 행의 스위치로 돌아간다.
 */
export function AccessDialog({ row, slug, edition, onClose, onDone }: { row: MaterialRow; slug: string; edition: number; onClose: () => void; onDone: (d: AccessDone) => void }) {
  const client = useClient();
  const qc = useQueryClient();
  const next: AiAccess = row.ai_access === "allow" ? "deny" : "allow";
  const verb = next === "deny" ? "AI 참조 끄기" : "AI 참조 다시 허용";
  const [reason, setReason] = React.useState("");
  const [received, setReceived] = React.useState<string | null>(null);
  const attempt = React.useRef<{ key: string; fingerprint: string } | null>(null);
  const ids = React.useId();
  const box = React.useRef<HTMLDivElement>(null);
  useInertOutside(box);

  const send = useMutation({
    mutationFn: ({ key, why }: { key: string; why: string }) => client.setMaterialAiAccess(slug, edition, row.file_policy_id, { ai_access: next, ...(why ? { reason: why } : {}) }, key),
    onSuccess: async (result) => {
      attempt.current = null;
      setReceived(result.receipt.numbered === false ? "접수됨" : `접수 ${result.receipt.receipt_no}`);
      // 영수증을 받은 뒤 다시 읽는다 — 스위치는 읽은 값을 따른다
      await qc.invalidateQueries({ queryKey: keys.materials(slug, edition) });
      onDone({ row, next, result });
    },
    onError: (e) => {
      if (isFinalRejection(e)) attempt.current = null;
    },
  });

  const sending = send.isPending;
  const rejected = send.isError && isFinalRejection(send.error) ? send.error : null;
  const unknown = send.isError && !rejected;

  const submit = (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (sending || send.isSuccess) return;
    const why = reason.trim();
    if (!attempt.current || attempt.current.fingerprint !== why) attempt.current = { key: newIdempotencyKey(), fingerprint: why };
    send.mutate({ key: attempt.current.key, why });
  };

  const busy = sending || send.isSuccess;
  const hint = `${ids}-hint`;
  const status = received
    ? `${received} — 목록을 다시 읽고 있어요.`
    : sending
      ? "접수 확인 중 — 서버가 받았는지 확인하고 있어요."
      : unknown
        ? "접수 확인 중 — 답이 오지 않았어요. 실패한 것이 아닐 수 있어요. 다시 누르면 중복 없이 확인해요. 이유를 고치고 누르면 새 요청으로 보내요."
        : "";
  return (
    <DialogPrimitive.Root open modal={false} onOpenChange={(open) => (!open && !busy ? onClose() : undefined)}>
      <DialogPrimitive.Portal>
        <div aria-hidden="true" data-print="hide" className="fixed inset-0 z-50 bg-black/30" />
        <DialogPrimitive.Content
          ref={box}
          data-print="hide"
          onKeyDown={trapTab}
          aria-describedby={hint}
          onEscapeKeyDown={(e) => busy && e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => {
            // 연 스위치로 돌아간다 — 성공 뒤에는 행이 다시 그려졌어도 같은 id 의 스위치로
            e.preventDefault();
            document.getElementById(switchId(row.object_id))?.focus();
          }}
          className="fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border bg-popover p-4 text-popover-foreground shadow-lg outline-none tab:p-5"
        >
          <form onSubmit={submit} noValidate>
            <DialogPrimitive.Title className="text-title text-ink">{verb}</DialogPrimitive.Title>
            <p id={hint} className="mt-1 text-meta text-ink-2">
              {next === "deny" ? "이 파일을 AI 가 참조하지 못하게 합니다." : "이 파일을 AI 가 다시 참조할 수 있게 합니다."} 바꾼 기록은 지워지지 않고 남습니다.
            </p>
            <p className="mt-3 rounded-md bg-surface-sunk px-3 py-2 text-meta text-ink">
              <span className="font-medium">{row.title}</span>
              <span className="block text-caption text-ink-2">{row.original_name}</span>
            </p>

            {next === "deny" ? (
              <div className="mt-3 grid gap-3 text-meta text-ink-2">
                <section aria-label="바뀌는 것">
                  <h3 className="text-meta font-semibold text-ink">바뀌는 것</h3>
                  <ul className="mt-0.5 list-disc pl-5">
                    <li>{DENY_FACTS.scope}</li>
                  </ul>
                </section>
                <section aria-label="바뀌지 않는 것">
                  <h3 className="text-meta font-semibold text-ink">바뀌지 않는 것</h3>
                  <ul className="mt-0.5 list-disc space-y-0.5 pl-5">
                    <li>{DENY_FACTS.direct}</li>
                    <li>
                      <strong className="font-semibold text-ink">{DENY_FACTS.sent}</strong>
                    </li>
                    <li>{DENY_FACTS.human}</li>
                  </ul>
                </section>
              </div>
            ) : (
              <div className="mt-3 text-meta text-ink-2">
                <h3 className="text-meta font-semibold text-ink">바뀌는 것</h3>
                <ul className="mt-0.5 list-disc pl-5">
                  <li>PES 의 AI 도구 · MCP · 프롬프트에서 이 파일을 다시 쓸 수 있습니다.</li>
                </ul>
              </div>
            )}

            <div className="mt-4">
              <label htmlFor={`${ids}-reason`} className="block text-meta font-medium text-ink">
                이유
              </label>
              <p id={`${ids}-reason-hint`} className="text-caption text-ink-2">
                적지 않아도 돼요.
              </p>
              <textarea id={`${ids}-reason`} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} aria-describedby={`${ids}-reason-hint`} className={fieldClass} />
            </div>

            <p role="status" className="mt-3 text-meta text-ink-2">
              {status}
            </p>
            {rejected ? (
              <p role="alert" className="mt-2 text-meta font-medium text-bad">
                바꾸지 못했어요. {rejected.message} 입력한 이유는 그대로 있어요.
              </p>
            ) : null}

            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => !busy && onClose()} aria-disabled={busy || undefined}>
                취소
              </Button>
              <Button type="submit" variant={next === "deny" ? "destructive" : "default"} aria-disabled={busy || undefined}>
                {verb}
              </Button>
            </div>
          </form>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
