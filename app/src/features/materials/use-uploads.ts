import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { keys, newIdempotencyKey, useClient } from "@/api/queries";
import { PesApiError } from "@/api/types";

/**
 * 자료 올리기(MAT1c) — 파일마다 uploadMaterial 한 번, 파일마다 다른 멱등 키.
 *  - 성공은 영수증을 받은 뒤에만 말한다. 영수증 전에는 “접수 확인 중”뿐이고 새 행도 없다(낙관적 갱신 없음). 영수증 뒤 목록을 다시 읽는다.
 *  - 목록 다시 읽기는 짧게 모아서 한 번만 한다(REREAD_MS) — 파일 여러 개를 올릴 때 파일마다 읽지 않는다. 영수증 줄은 읽기를 기다리지 않고 바로 보인다.
 *  - 서버가 끝까지 거절하면(PesApiError, retryable 아님) 그 말을 그대로 알리고 키를 버린다.
 *  - 답이 오지 않음(시간 초과 등)과 서버가 다시 보내도 된다고 한 거절은 실패가 아니라 “접수 확인 중”. 같은 파일을 다시 올리면 같은 멱등 키 → 서버가 처음 영수증을 돌려준다.
 */
export type UploadItem =
  | { id: string; name: string; phase: "sending" }
  | { id: string; name: string; phase: "unknown" }
  | { id: string; name: string; phase: "done"; receiptNo: string; numbered: boolean; replayed: boolean }
  | { id: string; name: string; phase: "rejected"; message: string };

/** 영수증 뒤 목록을 다시 읽기까지 모으는 시간, 밀리초 */
export const REREAD_MS = 250;

const isFinalRejection = (e: unknown): e is PesApiError => e instanceof PesApiError && !e.body.error.retryable;

/** 결과를 모르는 오류 — 시간 초과, 또는 서버가 다시 보내도 된다고 한 거절. 서버가 이미 받았을 수 있다 */
const isUnknownOutcome = (e: unknown): boolean => (e instanceof Error && e.name === "TimeoutError") || (e instanceof PesApiError && e.body.error.retryable);

/** 같은 파일(이름 · 크기 · 수정 시각 · 형식 · 새 버전 대상)이면 같은 시도 — 시간 초과 뒤 다시 올릴 때 같은 키를 쓰는 근거 */
const fingerprint = (f: File, objectId?: string) => JSON.stringify([f.name, f.size, f.lastModified, f.type, objectId ?? null]);

export function useUploads(slug: string, edition: number) {
  const client = useClient();
  const qc = useQueryClient();
  const [items, setItems] = React.useState<UploadItem[]>([]);
  /** 아직 끝나지 않은 시도의 멱등 키 — 시간 초과면 남기고, 영수증을 받았거나 서버가 끝까지 거절하면 버린다 */
  const attempts = React.useRef(new Map<string, string>());
  const inFlight = React.useRef(new Set<string>());
  const alive = React.useRef(true);
  const reread = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // 화면을 떠나면 모아 둔 다시 읽기를 낡음 표시로 바꾼다 — 다음에 이 화면을 열 때 읽는다
      if (reread.current !== undefined) {
        clearTimeout(reread.current);
        void qc.invalidateQueries({ queryKey: keys.materials(slug, edition), refetchType: "none" });
      }
    };
  }, [qc, slug, edition]);

  const put = (item: UploadItem) => alive.current && setItems((cur) => [...cur.filter((x) => x.id !== item.id), item]);

  const upload = React.useCallback(
    async (file: File, objectId?: string) => {
      const fp = fingerprint(file, objectId);
      if (inFlight.current.has(fp)) return;
      inFlight.current.add(fp);
      const key = attempts.current.get(fp) ?? newIdempotencyKey();
      attempts.current.set(fp, key);
      put({ id: fp, name: file.name, phase: "sending" });
      try {
        const r = await client.uploadMaterial(slug, edition, { file, ...(objectId ? { object_id: objectId } : {}) }, key);
        attempts.current.delete(fp);
        put({ id: fp, name: file.name, phase: "done", receiptNo: r.receipt.receipt_no, numbered: r.receipt.numbered !== false, replayed: r.receipt.replayed });
        // 영수증을 받은 뒤에 다시 읽는다(여러 파일이면 한 번에 모아서)
        if (reread.current !== undefined) clearTimeout(reread.current);
        reread.current = setTimeout(() => {
          reread.current = undefined;
          void qc.invalidateQueries({ queryKey: keys.materials(slug, edition) });
        }, REREAD_MS);
      } catch (e) {
        if (isFinalRejection(e)) {
          attempts.current.delete(fp);
          put({ id: fp, name: file.name, phase: "rejected", message: e.message });
        } else if (isUnknownOutcome(e)) {
          put({ id: fp, name: file.name, phase: "unknown" });
        } else {
          // 요청이 나가기 전에 멈췄다(파일 읽기 · 브라우저 기능 등) — 서버가 받았을 리 없으니 “접수 확인 중”이 아니라 보내지 못함
          attempts.current.delete(fp);
          put({ id: fp, name: file.name, phase: "rejected", message: `파일을 보내지 못했어요. ${e instanceof Error && e.message ? e.message : "브라우저에서 파일을 준비하지 못했어요."} 다시 골라 올려 주세요.` });
        }
      } finally {
        inFlight.current.delete(fp);
      }
    },
    [client, qc, slug, edition],
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
