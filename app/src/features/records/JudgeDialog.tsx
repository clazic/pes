import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog as DialogPrimitive } from "radix-ui";
import { keys, newIdempotencyKey, useClient } from "@/api/queries";
import { PesApiError, type AssumptionRow, type DecisionRow, type JudgeResult } from "@/api/types";
import { Button } from "@/components/ui/button";

/** 사람 판단 동작 — 가정(확인 · 틀림 · 고침)과 결정(채택 · 대체 · 철회) */
export type JudgeSpec =
  | { kind: "assess"; verdict: "confirm" | "reject" | "revise"; row: AssumptionRow }
  | { kind: "adopt" | "supersede" | "revoke"; row: DecisionRow };

const TITLE = { confirm: "가정 확인", reject: "가정 틀림", revise: "가정 고침", adopt: "결정 채택", supersede: "결정 대체", revoke: "결정 철회" } as const;
const WHAT = {
  confirm: "이 가정을 확인으로 기록합니다.",
  reject: "이 가정을 틀림으로 기록합니다. 가정은 지워지지 않고 기록으로 남아요.",
  revise: "가정의 문장을 고쳐 기록합니다. 고치기 전 문장은 원문으로 남아요.",
  adopt: "이 제안을 결정으로 채택합니다.",
  supersede: "새 결정을 만들고 이 결정을 대체됨으로 바꿉니다. 옛 결정은 그대로 남아요.",
  revoke: "이 결정을 철회합니다. 결정은 지워지지 않고 기록으로 남아요.",
} as const;

export const actionOf = (spec: JudgeSpec): keyof typeof TITLE => (spec.kind === "assess" ? spec.verdict : spec.kind);
/** 근거를 꼭 써야 하는가 — 확인 · 채택만 선택 */
const rationaleRequired = (a: keyof typeof TITLE) => a !== "confirm" && a !== "adopt";
const extraLabel = (a: keyof typeof TITLE) => (a === "revise" ? "고친 가정" : a === "supersede" ? "새 결정" : null);

const fieldClass =
  "mt-1 block w-full resize-y rounded-md border border-control bg-background px-2.5 py-2 text-body text-ink shadow-xs outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-invalid:border-bad";

/**
 * 판단 기록 대화 상자(F06) — 성공은 영수증을 받은 뒤에만 말한다. 보내는 동안은 aria-disabled(초점 유지)이고 두 번 눌러도 한 번만 보낸다.
 *  - 서버 거절(PesApiError): role=alert 에 서버 말을 그대로, 입력한 글 · 대화 상자는 그대로(다음 시도는 새 멱등 키).
 *  - 답이 오지 않음(시간 초과 등): 실패가 아니라 “접수 확인 중”. 다시 누르면 같은 멱등 키로 보내 서버가 처음 영수증을 돌려준다.
 *  - 성공: onDone(영수증) → 부모가 닫고 접수 번호를 알린다. 행은 영수증 뒤 다시 읽어 바뀐다(낙관적 갱신 없음).
 */
export function JudgeDialog({ spec, slug, edition, opener, onClose, onDone }: { spec: JudgeSpec; slug: string; edition: number; opener: HTMLElement | null; onClose: () => void; onDone: (r: JudgeResult) => void }) {
  const client = useClient();
  const qc = useQueryClient();
  const action = actionOf(spec);
  const title = TITLE[action];
  const extra = extraLabel(action);
  const needRationale = rationaleRequired(action);
  const [rationale, setRationale] = React.useState("");
  const [statement, setStatement] = React.useState(action === "revise" ? spec.row.statement : "");
  const [invalid, setInvalid] = React.useState<{ rationale?: string; statement?: string }>({});
  const attempt = React.useRef<{ key: string; fingerprint: string } | null>(null);
  const done = React.useRef(false);
  const ids = React.useId();

  const send = useMutation({
    mutationFn: ({ key, rationale: why, statement: said }: { key: string; rationale: string; statement: string }): Promise<JudgeResult> => {
      const id = spec.row.object_id;
      if (spec.kind === "assess") return client.assessAssumption(slug, edition, id, spec.verdict === "revise" ? { verdict: "revise", rationale: why, statement: said } : { verdict: spec.verdict, rationale: why }, key);
      if (spec.kind === "adopt") return client.adoptDecision(slug, edition, id, { rationale: why }, key);
      if (spec.kind === "supersede") return client.supersedeDecision(slug, edition, id, { statement: said, rationale: why }, key);
      return client.revokeDecision(slug, edition, id, { rationale: why }, key);
    },
    onSuccess: async (result) => {
      done.current = true;
      onDone(result);
      // 영수증을 받은 뒤 다시 읽는다
      await Promise.all([qc.invalidateQueries({ queryKey: keys.records(slug, edition) }), qc.invalidateQueries({ queryKey: keys.workspace(slug, edition) })]);
    },
    onError: (e) => {
      // 서버가 거절했으면 같은 키를 다시 쓰지 않는다. 답을 못 받은 것은 키를 그대로 둔다
      if (e instanceof PesApiError) attempt.current = null;
    },
  });

  const sending = send.isPending;
  const rejected = send.isError && send.error instanceof PesApiError ? send.error : null;
  const unknown = send.isError && !rejected;

  const submit = (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (sending) return;
    const why = rationale.trim();
    const said = statement.trim();
    const next: { rationale?: string; statement?: string } = {};
    if (needRationale && !why) next.rationale = "근거를 적어 주세요.";
    if (extra && !said) next.statement = `${extra}을(를) 적어 주세요.`;
    else if (extra && said === spec.row.statement.trim()) next.statement = `기존 문장과 같아요. 바뀐 ${extra}을(를) 적어 주세요.`;
    setInvalid(next);
    if (next.rationale || next.statement) return;
    const fingerprint = JSON.stringify([why, extra ? said : ""]);
    if (!attempt.current || attempt.current.fingerprint !== fingerprint) attempt.current = { key: newIdempotencyKey(), fingerprint };
    send.mutate({ key: attempt.current.key, rationale: why, statement: said });
  };

  const hint = `${ids}-hint`;
  const rationaleErr = `${ids}-rationale-err`;
  const statementErr = `${ids}-statement-err`;
  return (
    <DialogPrimitive.Root open onOpenChange={(open) => (!open && !sending ? onClose() : undefined)}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/30 data-open:animate-in data-open:fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={hint}
          onEscapeKeyDown={(e) => sending && e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => {
            // 성공하면 단추가 사라질 수 있다 — 접수 알림 줄로 초점을 옮기는 일은 부모가 맡는다. 취소는 연 단추로
            if (done.current) return void e.preventDefault();
            if (opener?.isConnected) {
              e.preventDefault();
              opener.focus();
            }
          }}
          className="fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border bg-popover p-4 text-popover-foreground shadow-lg outline-none tab:p-5"
        >
          <form onSubmit={submit} noValidate>
            <DialogPrimitive.Title className="text-title text-ink">{title}</DialogPrimitive.Title>
            <p id={hint} className="mt-1 text-meta text-ink-2">
              {WHAT[action]} 판단자와 근거가 기록에 남습니다.
            </p>
            <blockquote className="mt-3 rounded-md bg-surface-sunk px-3 py-2 text-meta text-ink">{spec.row.statement}</blockquote>

            {extra ? (
              <div className="mt-4">
                <label htmlFor={`${ids}-statement`} className="block text-meta font-medium text-ink">
                  {extra}
                </label>
                <textarea
                  id={`${ids}-statement`}
                  rows={3}
                  value={statement}
                  onChange={(e) => {
                    setStatement(e.target.value);
                    setInvalid((v) => ({ ...v, statement: undefined }));
                  }}
                  aria-invalid={invalid.statement ? "true" : undefined}
                  aria-describedby={invalid.statement ? statementErr : undefined}
                  className={fieldClass}
                />
                {invalid.statement ? (
                  <p id={statementErr} className="mt-1 text-caption font-medium text-bad">
                    {invalid.statement}
                  </p>
                ) : null}
              </div>
            ) : null}

            <div className="mt-4">
              <label htmlFor={`${ids}-rationale`} className="block text-meta font-medium text-ink">
                근거
              </label>
              <p id={`${ids}-rationale-hint`} className="text-caption text-ink-2">
                {needRationale ? "꼭 적어야 해요." : "적지 않아도 돼요."}
              </p>
              <textarea
                id={`${ids}-rationale`}
                rows={3}
                value={rationale}
                onChange={(e) => {
                  setRationale(e.target.value);
                  setInvalid((v) => ({ ...v, rationale: undefined }));
                }}
                aria-invalid={invalid.rationale ? "true" : undefined}
                aria-describedby={invalid.rationale ? `${rationaleErr} ${ids}-rationale-hint` : `${ids}-rationale-hint`}
                className={fieldClass}
              />
              {invalid.rationale ? (
                <p id={rationaleErr} className="mt-1 text-caption font-medium text-bad">
                  {invalid.rationale}
                </p>
              ) : null}
            </div>

            <p role="status" className="mt-3 text-meta text-ink-2">
              {sending ? "접수 확인 중 — 서버가 받았는지 확인하고 있어요." : unknown ? "접수 확인 중 — 답이 오지 않았어요. 실패한 것이 아닐 수 있어요. 다시 누르면 중복 없이 확인해요." : ""}
            </p>
            {rejected ? (
              <p role="alert" className="mt-2 text-meta font-medium text-bad">
                기록하지 못했어요. {rejected.message} 입력한 글은 그대로 있어요.
              </p>
            ) : null}

            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => !sending && onClose()} aria-disabled={sending || undefined}>
                취소
              </Button>
              <Button type="submit" variant="default" aria-disabled={sending || undefined}>
                판단 기록
              </Button>
            </div>
          </form>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
