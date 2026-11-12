import * as React from "react";
import { newIdempotencyKey } from "@/api/queries";
import { NotConnectedError, PesApiError } from "@/api/types";

/** 오류 → 사람이 읽을 한국어 문장 (서버 문장이 있으면 그대로, 연결 문제는 다시 시도할 수 있다고 알린다) */
export function describeError(e: unknown): string {
  if (e instanceof PesApiError) return e.body.error.message;
  if (e instanceof NotConnectedError) return e.message;
  if (e instanceof Error && e.name === "TimeoutError") return "서버 응답이 늦어요. 다시 누르면 같은 요청으로 확인해요 — 두 번 처리되지 않습니다.";
  return "처리하지 못했어요. 연결을 확인하고 다시 눌러 주세요.";
}

/**
 * 쓰기 명령 하나(U2b) — 한 번 누름에 멱등 키 하나. 실패한 뒤 같은 요청을 다시 보내면 같은 키(두 번 처리되지 않음),
 * 요청 내용(sig)이 바뀌었거나 성공한 뒤에는 새 키. 보내는 동안 다시 눌러도 한 번만 보낸다(ref 로 동기 차단 — 상태는 늦다).
 */
export function useKeyedCommand() {
  const keyRef = React.useRef<{ sig: string; key: string } | null>(null);
  const busy = React.useRef(false);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  /** 마지막 실패의 원래 오류(U2c) — 거절 사유 details · 시간 초과를 화면이 구분해서 쓴다 */
  const [failure, setFailure] = React.useState<unknown>(null);

  const run = React.useCallback(async <T,>(sig: string, call: (key: string) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error?: unknown }> => {
    if (busy.current) return { ok: false };
    busy.current = true;
    setPending(true);
    setError(null);
    setFailure(null);
    const key = keyRef.current?.sig === sig ? keyRef.current.key : newIdempotencyKey();
    keyRef.current = { sig, key };
    try {
      const value = await call(key);
      keyRef.current = null;
      return { ok: true, value };
    } catch (e) {
      setError(describeError(e));
      setFailure(e);
      return { ok: false, error: e };
    } finally {
      busy.current = false;
      setPending(false);
    }
  }, []);

  return { run, pending, error, failure };
}
