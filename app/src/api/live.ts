import * as React from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { keys, useClient } from "./queries";
import { PesApiError } from "./types";

/**
 * 커서 갱신(설계 12.5 · 결정 0017 · U1c) — 폴링으로 읽기를 다시 부르지 않고, 변경분(getChanges)만 묻는다.
 *  - 활성(탭 보임): 약 3초마다 한 번. 응답이 오기 전에는 다음 호출을 보내지 않는다(동시 1개).
 *  - 비활성(탭 숨김): 부르지 않는다. 다시 보이면 곧바로 한 번 받고 활성 박자로.
 *  - 오류 · 시간 초과: 늦춘다(5초 → 10 → 20 → 40, 최대 60초). 성공하면 3초 박자로. 화면 자료는 지우지 않는다.
 *  - 받은 tx 묶음의 touched 읽기 키만 무효화한다(지금 화면에 붙은 읽기만 다시 받고, 나머지는 다음에 볼 때 받는다).
 *  - cursor_expired · cursor_invalid: 보이는 읽기만 다시 받고(전체 새로고침 · 주소 변경 없음) 커서를 null 로 다시 시작.
 * 타이머는 전역 setTimeout 만 쓴다(시험의 가짜 시계와 같은 시계).
 */
export const LIVE = { activeMs: 3000, backoffMs: [5000, 10_000, 20_000, 40_000, 60_000], requestTimeoutMs: 15_000 } as const;

const RESYNC_CODES = new Set(["cursor_expired", "cursor_invalid"]);

/** 읽기 키 글자 → 쿼리 키. 모르는 키는 null(무시) */
export function touchedToQueryKey(touched: string, slug: string, edition: number): QueryKey | null {
  if (touched === "workspace") return keys.workspace(slug, edition);
  if (touched === "projects") return keys.projects;
  const m = /^round:([a-z]+)\/([1-9]\d*|start)$/.exec(touched);
  return m ? keys.round(slug, edition, m[1]!, m[2]!) : null;
}

const timeoutError = () => Object.assign(new Error("변경분 읽기 시간 초과"), { name: "TimeoutError" });

export function useLiveChanges(slug: string | undefined, edition: number) {
  const client = useClient();
  const qc = useQueryClient();

  React.useEffect(() => {
    if (!slug || !edition) return;
    let stopped = false;
    let cursor: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let failures = 0;

    const visible = () => document.visibilityState !== "hidden";
    const schedule = (ms: number) => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (stopped || inFlight || !visible()) return;
      timer = setTimeout(tick, ms);
    };

    const apply = (touched: Iterable<string>) => {
      const seen = new Set<string>();
      for (const t of touched) {
        if (seen.has(t)) continue;
        seen.add(t);
        const key = touchedToQueryKey(t, slug, edition);
        // 지금 화면에 붙은 읽기만 다시 받는다 — 나머지는 낡음 표시만(다음에 볼 때 받음)
        if (key) void qc.invalidateQueries({ queryKey: key, exact: true, refetchType: "active" });
      }
    };

    const resync = () => {
      // 보이는 읽기(workspace · 지금 라운드)만 — 붙어 있는 쿼리만 다시 받는다
      void qc.invalidateQueries({ queryKey: keys.workspace(slug, edition), refetchType: "active" });
      void qc.invalidateQueries({ queryKey: ["round", slug, edition], refetchType: "active" });
    };

    async function tick() {
      timer = undefined;
      if (stopped || inFlight || !visible()) return;
      inFlight = true;
      let guard: ReturnType<typeof setTimeout> | undefined;
      try {
        const res = await Promise.race([
          client.getChanges(slug!, edition, cursor),
          new Promise<never>((_, reject) => {
            guard = setTimeout(() => reject(timeoutError()), LIVE.requestTimeoutMs);
          }),
        ]);
        if (stopped) return;
        cursor = res.cursor;
        failures = 0;
        apply(res.txs.flatMap((tx) => tx.touched));
        inFlight = false;
        schedule(LIVE.activeMs);
      } catch (err) {
        if (stopped) return;
        inFlight = false;
        if (err instanceof PesApiError && RESYNC_CODES.has(err.body.error.code)) {
          cursor = null;
          failures = 0;
          resync();
          schedule(LIVE.activeMs);
          return;
        }
        const wait = LIVE.backoffMs[Math.min(failures, LIVE.backoffMs.length - 1)]!;
        failures += 1;
        schedule(wait);
      } finally {
        if (guard !== undefined) clearTimeout(guard);
      }
    }

    const onVisibility = () => {
      if (visible()) {
        if (!inFlight && failures === 0) schedule(0);
        else if (!inFlight) schedule(LIVE.backoffMs[Math.min(failures - 1, LIVE.backoffMs.length - 1)]!);
      } else if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    // 처음 읽기는 방금 받았다 — 한 박자 뒤 기준 커서(null)부터 묻는다
    schedule(LIVE.activeMs);

    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [client, qc, slug, edition]);
}
