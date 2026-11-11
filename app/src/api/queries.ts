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

export function useAcknowledgeAlert(slug: string, edition: number) {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (alertId: string) => client.acknowledgeAlert(slug, edition, alertId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["round", slug, edition] }),
  });
}
