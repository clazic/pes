import { Link } from "react-router";
import type { WorkspaceView } from "@/api/types";
import { RoundDot } from "@/components/pes/stage-mark";
import { StatusMark, TONE_TEXT } from "@/components/pes/status";
import { lookup } from "@/components/pes/status-registry";
import { roundLabel, STAGE_LABEL } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { roundHref } from "./paths";

const rowClass = "flex items-center gap-2 rounded-md px-2 no-underline";

/**
 * 단계·라운드 탐색(설계 4.5 · 4.7) — 단계마다 모양 + 상태 사전 이름(승인됨 · 현재 · 나의 할 일 · 시작 전), 라운드는 단계 시작 · R1 · R2.
 * 단계 시작은 round_id = NULL 이라 “단계 시작”이라 쓰고 가짜 R0 을 만들지 않는다.
 * 보는 라운드는 aria-current="page", 현재 진행 라운드는 늘 “현재 진행”(지난 라운드를 볼 때도 함께 보인다).
 */
export function StageNav({ ws, viewing }: { ws: WorkspaceView; viewing: { stage: string; round_id: number | null } }) {
  return (
    <div className="px-3 pt-5 pb-10">
      <div className="flex items-baseline justify-between px-2">
        <h2 className="text-meta font-semibold text-ink">단계와 라운드</h2>
        <span className="text-caption text-muted-foreground">{ws.edition}판</span>
      </div>
      <ol className="mt-3 space-y-3">
        {ws.stages.map((s) => {
          const latest = s.rounds.at(-1);
          const def = lookup("stage", s.view);
          const head = (
            <>
              <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
                <StatusMark shape={def.shape} className={cn("size-2.5", TONE_TEXT[def.tone])} />
              </span>
              <span className="font-semibold">{STAGE_LABEL[s.key]}</span>
              <span className={cn("ml-auto text-caption", def.tone === "you" ? "font-semibold text-primary-ink" : "text-muted-foreground")}>{def.label}</span>
            </>
          );
          return (
            <li key={s.key}>
              {latest ? (
                <Link to={roundHref(ws.slug, ws.edition, s.key, latest.round_id)} className={cn(rowClass, "min-h-8 text-meta text-ink hover:bg-accent")}>
                  {head}
                </Link>
              ) : (
                <div className={cn(rowClass, "min-h-8 text-meta text-muted-foreground")}>{head}</div>
              )}
              {s.rounds.length ? (
                <ol className="mt-0.5 ml-4 space-y-0.5 border-l pl-2">
                  {s.rounds.map((r) => {
                    const isViewing = viewing.stage === s.key && viewing.round_id === r.round_id;
                    const isCurrent = r.state === "current";
                    return (
                      <li key={r.round_id ?? "start"}>
                        <Link
                          to={roundHref(ws.slug, ws.edition, s.key, r.round_id)}
                          aria-current={isViewing ? "page" : undefined}
                          className={cn(
                            rowClass,
                            "min-h-7 text-meta text-ink-2 hover:bg-accent hover:text-ink",
                            isViewing && "bg-primary-soft font-semibold text-primary-ink hover:bg-primary-soft hover:text-primary-ink",
                          )}
                        >
                          <RoundDot current={isCurrent} />
                          <span>{roundLabel(r.round_id)}</span>
                          {isCurrent ? (
                            <span className="ml-auto rounded-sm border border-primary-line px-1.5 text-caption font-medium text-primary-ink">현재 진행</span>
                          ) : isViewing ? (
                            <span className="ml-auto text-caption text-muted-foreground">보는 중</span>
                          ) : null}
                        </Link>
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <p className="mt-0.5 ml-4 border-l pl-4 text-caption text-muted-foreground">아직 라운드가 없어요. 앞 단계가 승인되면 열립니다.</p>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
