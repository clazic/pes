import * as React from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PesClient } from "./types";

/** 읽기·쓰기는 이 클라이언트 하나를 지난다(U1a 는 가짜, U1b 는 HTTP). 루트 레이아웃이 공급한다. */
export const ClientContext = React.createContext<PesClient | null>(null);

export function useClient(): PesClient {
  const c = React.useContext(ClientContext);
  if (!c) throw new Error("ClientContext 공급자가 없다 — 루트 레이아웃 안에서 쓴다");
  return c;
}

export const keys = {
  projects: ["projects"] as const,
  workspace: (slug: string, edition: number) => ["workspace", slug, edition] as const,
  round: (slug: string, edition: number, stage: string, round: string) => ["round", slug, edition, stage, round] as const,
  /** 가정 · 결정 · 반영(U3b). 반영은 라운드 읽기 키 아래라 'round:*' 변경에 같이 다시 받는다 */
  records: (slug: string, edition: number) => ["records", slug, edition] as const,
  assumptions: (slug: string, edition: number) => ["records", slug, edition, "assumptions"] as const,
  decisions: (slug: string, edition: number) => ["records", slug, edition, "decisions"] as const,
  reflections: (slug: string, edition: number, stage: string, round: string) => ["round", slug, edition, stage, round, "reflections"] as const,
};

export function useProjects() {
  const client = useClient();
  return useQuery({ queryKey: keys.projects, queryFn: () => client.listProjects() });
}

export function useWorkspace(slug: string | undefined, edition: number) {
  const client = useClient();
  return useQuery({
    queryKey: keys.workspace(slug ?? "", edition),
    queryFn: () => client.getWorkspace(slug ?? "", edition),
    enabled: !!slug,
  });
}

/** 라운드를 옮기는 동안은 앞 화면을 그대로 둔다(빈 화면 번쩍임 없음). 새 자료가 오면 바꾼다 */
export function useRound(slug: string, edition: number, stage: string, round: string) {
  const client = useClient();
  return useQuery({
    queryKey: keys.round(slug, edition, stage, round),
    queryFn: () => client.getRound(slug, edition, stage, round),
    placeholderData: keepPreviousData,
  });
}

/** 새 멱등 키 — 한 번 누름에 하나. 다시 시도(같은 누름)는 같은 키를 쓴다 */
export const newIdempotencyKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export function useAcknowledgeAlert(slug: string, edition: number) {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ alertId, key }: { alertId: string; key: string }) => client.acknowledgeAlert(slug, edition, alertId, key),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["round", slug, edition] }),
  });
}

export function useAssumptions(slug: string, edition: number) {
  const client = useClient();
  return useQuery({ queryKey: keys.assumptions(slug, edition), queryFn: () => client.getAssumptions(slug, edition), enabled: !!slug && edition > 0 });
}

export function useDecisions(slug: string, edition: number) {
  const client = useClient();
  return useQuery({ queryKey: keys.decisions(slug, edition), queryFn: () => client.getDecisions(slug, edition), enabled: !!slug && edition > 0 });
}

/** round: 숫자 문자열 또는 "start". 결과 null = 서버가 반영 자료를 주지 않음 */
export function useReflections(slug: string, edition: number, stage: string, round: string) {
  const client = useClient();
  return useQuery({ queryKey: keys.reflections(slug, edition, stage, round), queryFn: () => client.getReflections(slug, edition, stage, round), enabled: !!slug && edition > 0 && !!stage && !!round });
}
