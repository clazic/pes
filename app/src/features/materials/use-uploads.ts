import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { keys, newIdempotencyKey, useClient } from "@/api/queries";
import { isAfterSend } from "@/api/send-outcome";
import { PesApiError } from "@/api/types";

/**
 * 자료 올리기(MAT1c) — 파일마다 uploadMaterial 한 번, 파일마다 다른 멱등 키.
 *  - 성공은 영수증을 받은 뒤에만 말한다. 영수증 전에는 “접수 확인 중”뿐이고 새 행도 없다(낙관적 갱신 없음). 영수증 뒤 목록을 다시 읽는다.
 *  - 목록 다시 읽기는 짧게 모아서 한 번만 한다(REREAD_MS) — 파일 여러 개를 올릴 때 파일마다 읽지 않는다. 영수증 줄은 읽기를 기다리지 않고 바로 보인다.
 *  - 서버가 끝까지 거절하면(PesApiError, retryable 아님) 그 말을 그대로 알리고 키를 버린다.
 *  - 답이 오지 않음(시간 초과 등)과 서버가 다시 보내도 된다고 한 거절은 실패가 아니라 “접수 확인 중”. 같은 파일을 다시 올리면 같은 멱등 키 → 서버가 처음 영수증을 돌려준다.
 *  - 끝나지 않은 시도의 키 · 이름 · 단계는 화면보다 오래 사는 sessionStorage 에 프로젝트 · 판 · 파일 지문별로 둔다(세션 비밀은 넣지 않는다). 화면을 옮기거나 새로 고친 뒤 돌아오면
 *    “접수 확인 중”으로 다시 보이고, 같은 파일을 다시 고르면 같은 키를 쓴다. 영수증을 받았거나 서버가 끝까지 거절했을 때만 지운다.
 *  - 프로젝트 · 판이 바뀌면 이전 범위의 줄 · 진행 중 요청은 새 범위의 화면에 섞이지 않는다.
 */
export type UploadItem =
  | { id: string; name: string; phase: "sending" }
  | { id: string; name: string; phase: "unknown" }
  | { id: string; name: string; phase: "done"; receiptNo: string; numbered: boolean; replayed: boolean }
  | { id: string; name: string; phase: "rejected"; message: string };

/** 영수증 뒤 목록을 다시 읽기까지 모으는 시간, 밀리초 */
export const REREAD_MS = 250;

const isFinalRejection = (e: unknown): e is PesApiError => e instanceof PesApiError && !e.body.error.retryable;

/** 결과를 모르는 오류 — 시간 초과, 요청을 보낸 뒤 연결이 끊김(isAfterSend), 또는 서버가 다시 보내도 된다고 한 거절. 서버가 이미 받았을 수 있다 */
const isUnknownOutcome = (e: unknown): boolean => (e instanceof Error && e.name === "TimeoutError") || isAfterSend(e) || (e instanceof PesApiError && e.body.error.retryable);

/** 같은 파일(이름 · 크기 · 수정 시각 · 형식 · 새 버전 대상)이면 같은 시도 — 시간 초과 뒤 다시 올릴 때 같은 키를 쓰는 근거 */
const fingerprint = (f: File, objectId?: string) => JSON.stringify([f.name, f.size, f.lastModified, f.type, objectId ?? null]);

/* ───────────── 끝나지 않은 시도의 보관(화면보다 오래 산다) ───────────── */

/** 끝나지 않은 시도 하나: 멱등 키 · 파일 이름 · 단계. 세션 비밀 · 파일 내용은 넣지 않는다 */
interface Attempt {
  key: string;
  name: string;
  phase: "sending" | "unknown";
}
const STORE_PREFIX = "pes-upload:";
/** sessionStorage 를 못 쓰는 환경(접근 오류 · 차단)의 대비 — 저장소가 있으면 쓰지 않는다. 화면을 옮겨도(같은 문서) 남지만 새로 고침은 못 넘긴다 */
const memory = new Map<string, string>();
const storage = (): Storage | null => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};
const scopePrefix = (slug: string, edition: number) => `${STORE_PREFIX}${JSON.stringify([slug, edition]).slice(0, -1)},`;
const attemptKey = (slug: string, edition: number, fp: string) => `${STORE_PREFIX}${JSON.stringify([slug, edition, fp])}`;

function storeWrite(k: string, a: Attempt) {
  const v = JSON.stringify(a);
  const st = storage();
  try {
    if (st) {
      st.setItem(k, v);
      return;
    }
  } catch {
    /* 가득 참 · 차단 — 메모리 사본으로 */
  }
  memory.set(k, v);
}
function storeRemove(k: string) {
  memory.delete(k);
  try {
    storage()?.removeItem(k);
  } catch {
    /* 저장소를 못 쓰는 환경 */
  }
}
const parseAttempt = (v: string | null | undefined): Attempt | null => {
  if (!v) return null;
  try {
    const a: unknown = JSON.parse(v);
    if (typeof a !== "object" || a === null) return null;
    const r = a as Record<string, unknown>;
    return typeof r.key === "string" && r.key !== "" && typeof r.name === "string" ? { key: r.key, name: r.name, phase: r.phase === "sending" ? "sending" : "unknown" } : null;
  } catch {
    return null;
  }
};
function storeRead(k: string): Attempt | null {
  try {
    const v = storage()?.getItem(k);
    if (v) return parseAttempt(v);
  } catch {
    /* 아래 메모리 사본으로 */
  }
  return parseAttempt(memory.get(k));
}
/** 이 프로젝트 · 판에 남은 끝나지 않은 시도 — [파일 지문, 시도] */
function storeScan(slug: string, edition: number): Array<[string, Attempt]> {
  const prefix = scopePrefix(slug, edition);
  const names = new Set<string>();
  try {
    const st = storage();
    for (let i = 0; st && i < st.length; i++) {
      const name = st.key(i);
      if (name !== null) names.add(name);
    }
  } catch {
    /* 메모리 사본만 */
  }
  for (const name of memory.keys()) names.add(name);
  const out: Array<[string, Attempt]> = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const a = storeRead(name);
    if (!a) continue;
    try {
      const parts: unknown = JSON.parse(name.slice(STORE_PREFIX.length));
      if (Array.isArray(parts) && typeof parts[2] === "string") out.push([parts[2], a]);
    } catch {
      /* 읽을 수 없는 이름은 건너뛴다 */
    }
  }
  return out;
}
/** 돌아왔을 때 보이는 줄 — 보내던 중이었는지 확인 중이었는지와 상관없이 결과를 모르므로 “접수 확인 중” */
const restored = (slug: string, edition: number): UploadItem[] => storeScan(slug, edition).map(([id, a]) => ({ id, name: a.name, phase: "unknown" as const }));

export function useUploads(slug: string, edition: number) {
  const client = useClient();
  const qc = useQueryClient();
  const scope = JSON.stringify([slug, edition]);
  const [items, setItems] = React.useState<UploadItem[]>(() => restored(slug, edition));
  /** 지금 이 화면이 보여 주는 범위(프로젝트 · 판). 화면을 떠나면 null — 늦게 끝난 요청이 다른 범위 · 닫힌 화면을 건드리지 않는다 */
  const current = React.useRef<string | null>(scope);
  const inFlight = React.useRef(new Set<string>());
  const reread = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  React.useEffect(() => {
    current.current = scope;
    // 범위가 바뀌었으면 이전 범위의 줄을 치우고 새 범위에 남은 시도를 다시 보인다
    setItems((cur) => {
      const next = restored(slug, edition);
      const keep = cur.filter((x) => x.phase === "sending" && inFlight.current.has(attemptKey(slug, edition, x.id)));
      return [...next.filter((x) => !keep.some((k) => k.id === x.id)), ...keep];
    });
    return () => {
      current.current = null;
      // 화면을 떠나면 모아 둔 다시 읽기를 낡음 표시로 바꾼다 — 다음에 이 화면을 열 때 읽는다
      if (reread.current !== undefined) {
        clearTimeout(reread.current);
        void qc.invalidateQueries({ queryKey: keys.materials(slug, edition), refetchType: "none" });
      }
    };
  }, [qc, slug, edition, scope]);

  const upload = React.useCallback(
    async (file: File, objectId?: string) => {
      const fp = fingerprint(file, objectId);
      const stored = attemptKey(slug, edition, fp);
      // 이 요청을 시작한 범위 — 끝났을 때 화면이 같은 범위일 때만 줄을 바꾼다
      const put = (item: UploadItem) => current.current === scope && setItems((cur) => [...cur.filter((x) => x.id !== item.id), item]);
      if (inFlight.current.has(stored)) return;
      inFlight.current.add(stored);
      const key = storeRead(stored)?.key ?? newIdempotencyKey();
      storeWrite(stored, { key, name: file.name, phase: "sending" });
      put({ id: fp, name: file.name, phase: "sending" });
      try {
        const r = await client.uploadMaterial(slug, edition, { file, ...(objectId ? { object_id: objectId } : {}) }, key);
        storeRemove(stored);
        put({ id: fp, name: file.name, phase: "done", receiptNo: r.receipt.receipt_no, numbered: r.receipt.numbered !== false, replayed: r.receipt.replayed });
        // 영수증을 받은 뒤에 다시 읽는다(여러 파일이면 한 번에 모아서)
        if (reread.current !== undefined) clearTimeout(reread.current);
        reread.current = setTimeout(() => {
          reread.current = undefined;
          void qc.invalidateQueries({ queryKey: keys.materials(slug, edition) });
        }, REREAD_MS);
      } catch (e) {
        if (isFinalRejection(e)) {
          storeRemove(stored);
          put({ id: fp, name: file.name, phase: "rejected", message: e.message });
        } else if (isUnknownOutcome(e)) {
          storeWrite(stored, { key, name: file.name, phase: "unknown" });
          put({ id: fp, name: file.name, phase: "unknown" });
        } else {
          // 요청이 나가기 전에 멈췄다(파일 읽기 · 브라우저 기능 등) — 서버가 받았을 리 없으니 “접수 확인 중”이 아니라 보내지 못함
          storeRemove(stored);
          put({ id: fp, name: file.name, phase: "rejected", message: `파일을 보내지 못했어요. ${e instanceof Error && e.message ? e.message : "브라우저에서 파일을 준비하지 못했어요."} 다시 골라 올려 주세요.` });
        }
      } finally {
        inFlight.current.delete(stored);
      }
    },
    [client, qc, slug, edition, scope],
  );

  const start = React.useCallback(
    (files: File[], objectId?: string) => {
      // 새 묶음을 시작하면 지난 성공·거절 줄은 치운다(확인 중인 줄은 남긴다)
      setItems((cur) => cur.filter((x) => x.phase === "sending" || x.phase === "unknown"));
      for (const f of files) void upload(f, objectId);
    },
    [upload],
  );

  return { items, start };
}
