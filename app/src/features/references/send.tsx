import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog as DialogPrimitive } from "radix-ui";
import { keys, newIdempotencyKey } from "@/api/queries";
import type { CommandResult } from "@/api/types";
import { cn } from "@/lib/utils";
import { isFinalRejection, isStaleRejection } from "./logic";

/**
 * 참고 프로젝트 쓰기 한 번(F06) — 대화 상자 셋(붙이기 · 다시 고정 · 떼기)이 같이 쓴다.
 *  - 성공은 영수증을 받은 뒤에만 말한다(onDone). 보내는 동안은 sending(단추 aria-disabled · 두 번 눌러도 한 번).
 *  - 서버가 끝까지 거절(rejected): 서버 말을 그대로 보이고 같은 멱등 키를 다시 쓰지 않는다. 낡은 값(409 conflict · rev_conflict)이면 목록을 다시 읽는다 — 다른 곳에서 바뀐 값을 따른다.
 *  - 답이 오지 않음(시간 초과 등)과 retryable 거절: 실패가 아니라 “접수 확인 중”(unknown). 같은 요청이면 같은 멱등 키로 다시 보내 서버가 처음 영수증을 돌려준다.
 *  - 영수증 뒤 목록(과 내용)을 다시 읽는다. 낙관적 갱신 없음.
 * fingerprint = 요청 내용의 지문. 같으면 같은 키, 다르면 새 키.
 */
export function useReferenceSend<T>({ slug, edition, run, onDone }: { slug: string; edition: number; run: (key: string) => Promise<CommandResult<T>>; onDone: (r: CommandResult<T>) => void }) {
  const qc = useQueryClient();
  const attempt = React.useRef<{ key: string; fingerprint: string } | null>(null);
  /** 성공으로 닫히면 초점은 부모가 접수 줄로 옮긴다 */
  const done = React.useRef(false);
  const reread = React.useCallback(() => qc.invalidateQueries({ queryKey: keys.references(slug, edition) }), [qc, slug, edition]);
  const send = useMutation({
    mutationFn: (key: string) => run(key),
    onSuccess: async (result) => {
      done.current = true;
      onDone(result);
      await reread();
    },
    onError: (e) => {
      if (isFinalRejection(e)) {
        attempt.current = null;
        if (isStaleRejection(e)) void reread();
      }
    },
  });
  const submit = (fingerprint: string) => {
    if (send.isPending) return;
    if (!attempt.current || attempt.current.fingerprint !== fingerprint) attempt.current = { key: newIdempotencyKey(), fingerprint };
    send.mutate(attempt.current.key);
  };
  const rejected = send.isError && isFinalRejection(send.error) ? send.error : null;
  return { submit, sending: send.isPending, rejected, unknown: send.isError && !rejected, done };
}

/** 보내는 중 · 확인 중 알림 — 처음부터 자리에 있어 화면 읽기가 알린다(role=status). 경고(role=alert)와 섞지 않는다 */
export function SendStatus({ sending, unknown }: { sending: boolean; unknown: boolean }) {
  return (
    <p role="status" className="mt-3 text-meta text-ink-2">
      {sending ? "접수 확인 중 — 서버가 받았는지 확인하고 있어요." : unknown ? "접수 확인 중 — 답이 오지 않았어요. 실패한 것이 아닐 수 있어요. 다시 누르면 중복 없이 확인해요." : ""}
    </p>
  );
}

/** 초점이 갈 수 있는 것 — 숨겨지지 않은 단추 · 입력 · 링크 · 초점 가능한 칸 */
const TABBABLE = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/**
 * 대화 상자가 열려 있는 동안 뒤 화면을 `inert` 로 둔다 — 눌러도 초점도 화면 읽기도 닿지 않는다. 닫으면 되돌린다.
 * (Radix 의 모달은 뒤를 aria-hidden 으로 가려 화면 읽기 시험이 뒤 화면을 못 읽는다. 여기서는 모달 대신 비모달 대화 상자 + inert + 직접 초점 가두기를 쓴다.)
 */
function useInertBackground(contentRef: React.RefObject<HTMLElement | null>) {
  React.useEffect(() => {
    let host: HTMLElement | null = contentRef.current;
    while (host && host.parentElement !== document.body) host = host.parentElement;
    const marked = [...document.body.children].filter((el) => el !== host && !el.hasAttribute("inert"));
    for (const el of marked) el.setAttribute("inert", "");
    return () => {
      for (const el of marked) el.removeAttribute("inert");
    };
  }, [contentRef]);
}

/**
 * 대화 상자 틀 — 초점은 안에 갇히고(Tab · Shift+Tab 이 끝에서 돌아 나옴), Esc · 취소는 보내는 중이 아닐 때만 닫으며 초점은 연 단추로 돌아온다(성공하면 부모가 접수 줄로).
 * 바깥을 눌러도 닫히지 않는다(쓰던 선택을 잃지 않게). 뒤 화면은 inert.
 */
export function DialogShell({ title, hint, opener, sending, done, onClose, wide, children }: { title: string; hint: string; opener: HTMLElement | null; sending: boolean; done: React.RefObject<boolean>; onClose: () => void; wide?: boolean; children: React.ReactNode }) {
  const hintId = React.useId();
  const contentRef = React.useRef<HTMLDivElement>(null);
  useInertBackground(contentRef);
  const trap = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const box = contentRef.current;
    if (!box) return;
    const items = [...box.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => !el.closest("[hidden]"));
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) return void e.preventDefault();
    const at = document.activeElement;
    if (e.shiftKey && (at === first || !box.contains(at))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (at === last || !box.contains(at))) {
      e.preventDefault();
      first.focus();
    }
  };
  return (
    <DialogPrimitive.Root open modal={false} onOpenChange={(open) => (!open && !sending ? onClose() : undefined)}>
      <DialogPrimitive.Portal>
        <div aria-hidden="true" data-print="hide" className="fixed inset-0 z-50 bg-black/30" />
        <DialogPrimitive.Content
          ref={contentRef}
          data-print="hide"
          aria-describedby={hintId}
          onKeyDown={trap}
          onEscapeKeyDown={(e) => sending && e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => {
            if (done.current) return void e.preventDefault();
            if (opener?.isConnected) {
              e.preventDefault();
              opener.focus();
            }
          }}
          className={cn("fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border bg-popover p-4 text-popover-foreground shadow-lg outline-none tab:p-5", wide ? "max-w-xl" : "max-w-lg")}
        >
          <DialogPrimitive.Title className="text-title text-ink">{title}</DialogPrimitive.Title>
          <p id={hintId} className="mt-1 text-meta text-ink-2">
            {hint}
          </p>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
