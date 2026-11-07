import * as React from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { live, mockSettings, turnBaseline, useMockSettings } from "@/lib/mock-settings";
import { pes, PesApiError, type CommandInputs } from "./mock-client";
import type { ChangeTx, CommandResult, Receipt } from "./types";

/**
 * TanStack Query 위의 읽기·쓰기.
 * - 읽기: 화면마다 하나의 읽기 묶음. 폴링하지 않는다(refetchInterval 없음, 설계 P10).
 * - 갱신: 변경 알림(번호만) → GET changes → 바뀐 읽기 키만 무효화(invalidate). 이전 화면은 그대로 두고 바뀐 부분만 바뀐다.
 * - 쓰기: 닫힌 명령 하나 + 멱등 키. 응답이 늦으면 “접수 확인 중”, 다시 눌러도 같은 키(두 번 처리 안 됨).
 */

export const qk = {
  projects: ["projects"] as const,
  workspace: (slug: string) => ["workspace", slug] as const,
  files: (slug: string) => ["files", slug] as const,
  usage: ["usage"] as const,
  computer: ["computer"] as const,
  notifications: ["notifications"] as const,
};

export function useProjects() {
  return useQuery({ queryKey: qk.projects, queryFn: () => pes.listProjects() });
}
export function useWorkspace(slug: string) {
  // 사이드바는 작업 공간 밖에서도 부른다(빈 slug) — 그때는 읽지 않는다. 같은 키라 작업 공간 화면과 읽기 한 번을 나눠 쓴다.
  return useQuery({ queryKey: qk.workspace(slug), queryFn: () => pes.getWorkspace(slug), enabled: slug !== "" });
}
export function useMaterials(slug: string) {
  return useQuery({ queryKey: qk.files(slug), queryFn: () => pes.getMaterials(slug) });
}
export function useUsage() {
  return useQuery({ queryKey: qk.usage, queryFn: () => pes.getUsage() });
}
export function useComputer() {
  return useQuery({ queryKey: qk.computer, queryFn: () => pes.getComputer() });
}
export function useNotifications() {
  return useQuery({ queryKey: qk.notifications, queryFn: () => pes.listNotifications() });
}

function newKey() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random()}`;
}

/** unknown = 보낸 뒤 응답 유실(접수됐는지 모름) — 성공도 실패도 단정하지 않음(Codex F07) */
export type CommandPhase = "idle" | "sending" | "confirming" | "done" | "error" | "unknown";

/**
 * 명령 하나를 보내는 훅.
 * - phase=confirming: 1.2초가 지나도 응답이 없으면 “접수 확인 중”(성공이라 하지 않음)
 * - 끊김처럼 다시 보내도 되는 실패는 같은 키를 그대로 쓴다 → 서버는 처음 결과를 재생
 * - 성공 표시는 영수증(접수 번호)을 받은 뒤에만
 */
export function useCommand<K extends keyof CommandInputs>(name: K, opts?: { successText?: (r: Receipt) => string; silent?: boolean }) {
  const keyRef = React.useRef<string>(newKey());
  const [phase, setPhase] = React.useState<CommandPhase>("idle");
  const [receipt, setReceipt] = React.useState<Receipt | null>(null);
  const [error, setError] = React.useState<PesApiError | null>(null);
  const timer = React.useRef<number | undefined>(undefined);
  const lastInput = React.useRef<CommandInputs[K] | null>(null);

  const m = useMutation<CommandResult<unknown>, PesApiError, CommandInputs[K]>({
    mutationFn: (input) => {
      lastInput.current = input;
      return pes.command(name, input, { idempotencyKey: keyRef.current });
    },
    onMutate: () => {
      setPhase("sending");
      setError(null);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setPhase((p) => (p === "sending" ? "confirming" : p)), 1200);
    },
    onSuccess: (res) => {
      window.clearTimeout(timer.current);
      setPhase("done");
      setReceipt(res.receipt);
      if (!opts?.silent) {
        toast.success(opts?.successText?.(res.receipt) ?? `접수됨 · 접수 번호 ${res.receipt.receipt_no}${res.receipt.replayed ? " (같은 요청 — 다시 처리하지 않음)" : ""}`);
      }
      keyRef.current = newKey();
    },
    onError: (err) => {
      window.clearTimeout(timer.current);
      setPhase(err.code === "result_unknown" ? "unknown" : "error");
      setError(err);
      if (!opts?.silent) (err.code === "result_unknown" ? toast.warning : toast.error)(err.message);
      // 다시 보내도 되는 실패(끊김 등)는 같은 키를 남긴다. 그 밖에는 새 키.
      if (!err.retryable) keyRef.current = newKey();
    },
  });

  const reset = React.useCallback(() => {
    keyRef.current = newKey();
    setPhase("idle");
    setReceipt(null);
    setError(null);
    m.reset();
  }, [m]);

  React.useEffect(() => () => window.clearTimeout(timer.current), []);

  /** 같은 요청 번호(같은 키·같은 내용)로 다시 보내 확인 — 서버가 처리했으면 처음 영수증을 재생한다 */
  const recheck = React.useCallback(() => {
    if (lastInput.current) m.mutate(lastInput.current);
  }, [m]);

  return { run: m.mutate, runAsync: m.mutateAsync, phase, receipt, error, reset, recheck, pending: m.isPending };
}

/* ───────── 변경 알림 → 바뀐 것만 다시 가져오기 ───────── */

const TOUCH_TO_KEYS: Record<ChangeTx["touched"][number], (slug: string) => readonly unknown[][]> = {
  workspace: (slug) => (slug === "*" ? [["workspace"]] : [[...qk.workspace(slug)]]),
  files: (slug) => (slug === "*" ? [["files"]] : [[...qk.files(slug)]]),
  usage: () => [[...qk.usage]],
  projects: () => [[...qk.projects]],
  notifications: () => [[...qk.notifications]],
  computer: () => [[...qk.computer]],
};

const resyncListeners = new Set<(v: boolean) => void>();
let resyncing = false;
function setResyncing(v: boolean) {
  resyncing = v;
  resyncListeners.forEach((l) => l(v));
}
export function useResyncing() {
  const [v, setV] = React.useState(resyncing);
  React.useEffect(() => {
    resyncListeners.add(setV);
    return () => {
      resyncListeners.delete(setV);
    };
  }, []);
  return v;
}

async function pullChanges(qc: QueryClient, project: string, cursorRef: React.RefObject<string>) {
  try {
    const page = await pes.getChanges(project, cursorRef.current ?? "0");
    cursorRef.current = page.cursor;
    for (const tx of page.txs) {
      for (const t of tx.touched) {
        for (const key of TOUCH_TO_KEYS[t](tx.project ?? project)) {
          await qc.invalidateQueries({ queryKey: key });
        }
      }
      // 사람이 할 일이 생긴 사건만 조용히 알린다(설계 3.5)
      if (tx.human_action) {
        live.announce(tx.human_action);
        toast.info(tx.human_action);
      }
    }
  } catch (e) {
    if (e instanceof PesApiError && e.code === "cursor_invalid") {
      // 커서 무효: 화면 자료만 다시 받는다. 전체 새로고침·초안 삭제 없음(결정 14, F04)
      setResyncing(true);
      await qc.invalidateQueries();
      cursorRef.current = pes.currentCursor();
      window.setTimeout(() => setResyncing(false), 1500);
    }
  }
}

/** 프로젝트(또는 "*" 전체)의 변경 알림 통로에 붙는다. 탭이 숨겨지면 받지 않고, 돌아오면 한 번 받는다. */
export function useChangeFeed(project: string) {
  const qc = useQueryClient();
  const cursorRef = React.useRef<string>(pes.currentCursor());
  const missed = React.useRef(false);

  React.useEffect(() => {
    const off = pes.subscribe(project, () => {
      if (document.visibilityState === "hidden") {
        missed.current = true;
        return;
      }
      void pullChanges(qc, project, cursorRef);
    });
    const onVis = () => {
      if (document.visibilityState === "visible" && missed.current) {
        missed.current = false;
        void pullChanges(qc, project, cursorRef);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      off();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [project, qc]);
}

/** 갱신 칩 5가지(설계 3.5): 실시간 / 느린 갱신 / 갱신 쉼 / 끊김 / 다시 받는 중 */
export function useRefreshState(): "live" | "slow" | "paused" | "offline" | "resync" {
  const s = useMockSettings();
  const resync = useResyncing();
  const [hidden, setHidden] = React.useState(typeof document !== "undefined" && document.visibilityState === "hidden");
  const [online, setOnline] = React.useState(typeof navigator === "undefined" ? true : navigator.onLine);
  React.useEffect(() => {
    const v = () => setHidden(document.visibilityState === "hidden");
    const on = () => setOnline(true);
    const offl = () => setOnline(false);
    document.addEventListener("visibilitychange", v);
    window.addEventListener("online", on);
    window.addEventListener("offline", offl);
    return () => {
      document.removeEventListener("visibilitychange", v);
      window.removeEventListener("online", on);
      window.removeEventListener("offline", offl);
    };
  }, []);
  if (s.network === "offline" || !online) return "offline";
  if (resync) return "resync";
  if (hidden) return "paused";
  if (s.channel === "slow") return "slow";
  return "live";
}

export function simulateAiQuestion(slug: string) {
  pes.simulateAiQuestion(slug);
}
/** 시안: 차례 바뀜 장면 — AI가 하는 중(소식 있음) → finishMs 뒤 AI 끝남 → 나의 할 일 */
export function playTurnDemo(finishMs?: number) {
  pes.playTurnDemo(finishMs);
}
export function resetMockData() {
  // 한꺼번에 되돌리는 차례 변화는 “전환”으로 읽지 않는다(TurnAnnouncer 기준점)
  turnBaseline.bump();
  pes.reset();
  mockSettings.reset();
}
