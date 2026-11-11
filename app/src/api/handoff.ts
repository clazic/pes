/**
 * 열어 주는 쪽이 넘긴 세션 받기(U1b, R1 필수 1) — `pes open <slug> --app` 이 주소의 조각(fragment)으로 `#pes=<base64url JSON {session, projects}>` 를 넘긴다.
 * 조각은 서버·Referer 로 가지 않고 다른 Origin 은 읽지 못한다. main.tsx 가 라우터를 만들기 전에 takeHandoff 를 한 번 부른다:
 *   1. 조각이 `pes=` 이면(올바르든 깨졌든) history.replaceState 로 주소에서 지운다(경로·쿼리는 그대로, 새 기록 없음). 다른 조각(`#main` 등)은 건드리지 않는다.
 *   2. 올바른 조각이면 같은 탭 sessionStorage 에 둔다(새로고침이 다시 받음). 막혀 있으면(throw) 이번 로드의 메모리(window.__PES_APP__)만 쓴다.
 *   3. 조각에서 못 읽었으면 같은 탭 sessionStorage 에 둔 것을 읽는다. 둘 다 없으면 null — 다른 탭·창은 이어받지 못한다.
 * 올바른 설정을 얻으면 window.__PES_APP__ 로 두고(selectClient 가 읽는 그 설정) 돌려준다.
 * 세션 값은 console·localStorage·쿠키·주소에 두지 않는다.
 */

export interface HandoffConfig {
  api: "http";
  session: string;
  projects: Record<string, string>;
}

const STORE_KEY = "pes-app-handoff";
const FRAGMENT = /^#pes=([A-Za-z0-9_-]*)=*$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 모양 검사: session 은 비지 않은 문자열, projects 는 {문자열: 비지 않은 문자열}. 그 밖의 최상위 키는 버린다. */
function validate(value: unknown): HandoffConfig | null {
  if (!isRecord(value)) return null;
  const { session, projects } = value;
  if (typeof session !== "string" || session === "" || !isRecord(projects)) return null;
  const entries = Object.entries(projects);
  if (!entries.every(([, id]) => typeof id === "string" && id !== "")) return null;
  return { api: "http", session, projects: Object.fromEntries(entries) as Record<string, string> };
}

function parsePayload(payload: string): HandoffConfig | null {
  if (payload === "") return null;
  try {
    const bytes = Uint8Array.from(atob(payload.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    return validate(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch {
    return null;
  }
}

function readStored(win: Window): HandoffConfig | null {
  try {
    const text = win.sessionStorage.getItem(STORE_KEY);
    return text === null ? null : validate(JSON.parse(text));
  } catch {
    return null;
  }
}

function store(win: Window, config: HandoffConfig): void {
  try {
    win.sessionStorage.setItem(STORE_KEY, JSON.stringify({ session: config.session, projects: config.projects }));
  } catch {
    // 저장이 막혀 있다: 이번 로드는 메모리(window.__PES_APP__)만으로 동작한다
  }
}

export function takeHandoff(win: Window): HandoffConfig | null {
  let config: HandoffConfig | null = null;
  const hash = win.location.hash;
  if (hash.startsWith("#pes=")) {
    const match = FRAGMENT.exec(hash);
    config = match ? parsePayload(match[1] as string) : null;
    // 올바르든 깨졌든 조각은 주소창에 남기지 않는다
    win.history.replaceState(win.history.state, "", `${win.location.pathname}${win.location.search}`);
    if (config) store(win, config);
  }
  config ??= readStored(win);
  if (config) (win as unknown as { __PES_APP__?: HandoffConfig }).__PES_APP__ = config;
  return config;
}
