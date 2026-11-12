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
 * 확인 중인 요청의 멱등 키(U2c) — 칸(scope)별로 컴포넌트 밖에 둔다. 스레드를 접었다 펴서 컴포넌트가 사라져도 같은 요청은 같은 키로 다시 확인한다.
 * sessionStorage 에 두고(새로 고침에도 남는다), 쓸 수 없으면 모듈 메모리에 둔다. 성공(영수증)을 받으면 지운다.
 */
const PENDING_PREFIX = "pes-cmd:";
const pendingMemory = new Map<string, { sig: string; key: string }>();

function loadPending(scope: string): { sig: string; key: string } | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_PREFIX + scope);
    if (raw === null) return pendingMemory.get(scope) ?? null;
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === "object" && typeof (v as { sig?: unknown }).sig === "string" && typeof (v as { key?: unknown }).key === "string") return v as { sig: string; key: string };
    return null;
  } catch {
    return pendingMemory.get(scope) ?? null;
  }
}

function savePending(scope: string, value: { sig: string; key: string } | null) {
  try {
    if (value) window.sessionStorage.setItem(PENDING_PREFIX + scope, JSON.stringify(value));
    else window.sessionStorage.removeItem(PENDING_PREFIX + scope);
    pendingMemory.delete(scope);
  } catch {
    if (value) pendingMemory.set(scope, value);
    else pendingMemory.delete(scope);
  }
}

/**
 * 쓰기 명령 하나(U2b) — 한 번 누름에 멱등 키 하나. 실패한 뒤 같은 요청을 다시 보내면 같은 키(두 번 처리되지 않음),
 * 요청 내용(sig)이 바뀌었거나 성공한 뒤에는 새 키. 보내는 동안 다시 눌러도 한 번만 보낸다(ref 로 동기 차단 — 상태는 늦다).
 */
export function useKeyedCommand(scope?: string) {
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
    const prev = scope ? loadPending(scope) : keyRef.current;
    const key = prev?.sig === sig ? prev.key : newIdempotencyKey();
    if (scope) savePending(scope, { sig, key });
    else keyRef.current = { sig, key };
    try {
      const value = await call(key);
      // 내 시도의 기록일 때만 지운다 — 접었다 편 뒤 새로 보낸 다른 시도(sig · key 가 다름)의 재시도 정보를 늦게 온 옛 응답이 지우지 않게
      if (scope) {
        const now = loadPending(scope);
        if (now && now.sig === sig && now.key === key) savePending(scope, null);
      } else if (keyRef.current?.sig === sig && keyRef.current.key === key) keyRef.current = null;
      return { ok: true, value };
    } catch (e) {
      setError(describeError(e));
      setFailure(e);
      return { ok: false, error: e };
    } finally {
      busy.current = false;
      setPending(false);
    }
  }, [scope]);

  return { run, pending, error, failure };
}
