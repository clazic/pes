import * as React from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { NotConnectedError, type CommentThreadView, type PesClient } from "./types";

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
  /** 참고 프로젝트(REF1b) — 기록 읽기와 같은 앞부분이라 판의 변경분(workspace)을 받으면 같이 다시 읽힌다. 내용 읽기(detail)는 목록 키 아래라 목록을 다시 읽으면 같이 무효화된다 */
  references: (slug: string, edition: number) => ["records", slug, edition, "references"] as const,
  referenceDetail: (slug: string, edition: number, refId: string) => ["records", slug, edition, "references", "detail", refId] as const,
  /** 붙일 후보 — 열 때마다 새로 읽는다(gcTime 0). scope null = 생성 화면 */
  referenceCandidates: (scope: { slug: string; edition: number } | null) => ["reference-candidates", scope?.slug ?? "", scope?.edition ?? 0] as const,
  /** 내 자료(MAT1c) — 기록 읽기와 같은 앞부분이라 판의 변경분(workspace)을 받으면 같이 다시 읽힌다 */
  materials: (slug: string, edition: number) => ["records", slug, edition, "materials"] as const,
  reflections: (slug: string, edition: number, stage: string, round: string) => ["round", slug, edition, stage, round, "reflections"] as const,
  /** 라운드 읽기와 같은 앞부분(["round", slug, edition]) — 라운드를 다시 읽을 때 같이 다시 읽힌다 */
  comments: (slug: string, edition: number, stage: string, round: string) => ["round", slug, edition, "comments", stage, round] as const,
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

/** useComments 가 돌려주는 모양 — unavailable 이면 reason 이 이유(not_connected = 서버에 읽는 길이 아직 없음 · failed = 읽다가 실패) */
export interface CommentsRead {
  threads: CommentThreadView[];
  unavailable: boolean;
  reason?: "not_connected" | "failed";
}

/**
 * 이 라운드의 질문별 의견 스레드(U2c). 읽는 길이 없거나 읽지 못하면 오류로 두지 않고 { unavailable: true } 로 돌려준다 —
 * 화면이 ‘읽지 못했다’고 알리고(빈 스레드로 단정하지 않음), 오류 상태 쿼리가 다시 읽히며 깜빡이는 일이 없다.
 */
export function useComments(slug: string, edition: number, stage: string, round: string) {
  const client = useClient();
  return useQuery({
    queryKey: keys.comments(slug, edition, stage, round),
    queryFn: async (): Promise<CommentsRead> => {
      try {
        return { threads: await client.getComments(slug, edition, stage, round), unavailable: false };
      } catch (e) {
        // 읽는 길이 아직 없는 것(not_connected)과 일시 오류(failed)를 나눠 화면이 이유를 틀리게 말하지 않게 한다
        return { threads: [], unavailable: true, reason: e instanceof NotConnectedError ? "not_connected" : "failed" };
      }
    },
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

/** 참고 프로젝트 목록(REF1b). 읽기 실패는 오류로 남는다(빈 목록으로 위장하지 않음) */
export function useReferences(slug: string, edition: number) {
  const client = useClient();
  return useQuery({ queryKey: keys.references(slug, edition), queryFn: () => client.getReferences(slug, edition), enabled: !!slug && edition > 0 });
}

/** 참고 프로젝트 내용 하나 — 사람 화면이라 AI 전달이 안 되는 것도 읽힌다 */
export function useReferenceDetail(slug: string, edition: number, refId: string) {
  const client = useClient();
  return useQuery({ queryKey: keys.referenceDetail(slug, edition, refId), queryFn: () => client.getReference(slug, edition, refId) });
}

/** 붙일 수 있는 프로젝트와 스냅숏. 대화 상자를 열 때마다 한 번 읽는다(남은 캐시 없음). 읽는 길이 없으면 NotConnectedError 가 오류로 남는다 */
export function useReferenceCandidates(scope: { slug: string; edition: number } | null) {
  const client = useClient();
  return useQuery({ queryKey: keys.referenceCandidates(scope), queryFn: () => client.getReferenceCandidates(scope), gcTime: 0, staleTime: 0, refetchOnMount: "always" });
}

/** 내 자료 목록(MAT1c) — 사람 화면이라 금지(deny) 파일도 온다. 읽기 실패는 오류로 남는다(빈 목록으로 위장하지 않음) */
export function useMaterials(slug: string, edition: number) {
  const client = useClient();
  return useQuery({ queryKey: keys.materials(slug, edition), queryFn: () => client.getMaterials(slug, edition), enabled: !!slug && edition > 0 });
}
