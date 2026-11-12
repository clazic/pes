/**
 * 열어 주는 쪽이 넘긴 1회용 코드를 세션으로 바꾸기(SEL-85, U1b 후속 A) — `pes open <slug> --app` 은 주소의 조각(fragment)에 세션이 아니라
 * 1회용 코드 `#code=<코드>` 를 싣는다. 조각은 서버·Referer 로 가지 않고 다른 Origin 은 읽지 못한다. main.tsx 가 라우터를 만들기 전에 exchangeHandoff 를 한 번 기다린다:
 *   1. 조각이 `code=` 이면(올바르든 깨졌든) **요청을 보내기 전에** history.replaceState 로 주소에서 지운다(경로·쿼리는 그대로, 새 기록 없음).
 *      옛 `pes=` 조각(세션이 든 SEL-82 꼴)은 받지 않고 지우기만 한다. 다른 조각(`#main` 등)은 건드리지 않는다.
 *   2. 코드 모양이 맞으면 같은 출처 `POST /api/v1/app-session {code}` 를 딱 한 번 보낸다(세션 헤더 없음 · credentials omit · 재시도 없음).
 *      200 이고 data 가 {session, projects} 모양이면 같은 탭 sessionStorage 에 두고 window.__PES_APP__ 로 둔다. 그 밖(거절·네트워크 오류·모양 틀림)은 null.
 *   3. 같은 세션이 이미 같은 탭에 있으면 projects 를 합친다(같은 slug 는 새 값) — 같은 탭에서 프로젝트를 바꿔 열어도 앞의 것을 찾는다. 세션이 다르면 새것으로 덮어쓴다.
 *   4. 조각이 없거나 교환이 실패하면 같은 탭 sessionStorage 에 둔 것을 쓴다(새로고침). 둘 다 없으면 null — 다른 탭·창은 이어받지 못한다.
 * 세션·코드 값은 console·localStorage·쿠키·주소에 두지 않는다.
 */

export interface HandoffConfig {
  api: "http";
  session: string;
  projects: Record<string, string>;
}

const STORE_KEY = "pes-app-handoff";
const EXCHANGE_PATH = "/api/v1/app-session";
/** 서버가 만드는 코드는 43자 base64url 이다. 모양이 틀린 것은 서버에 보내지 않는다(주소창에서는 그래도 지운다). */
const CODE = /^[A-Za-z0-9_-]{20,128}$/;

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

/** 코드 하나를 서버에 내고 세션을 받는다. 한 번만 보내고, 어떤 실패든 null. */
async function exchange(win: Window, code: string, fetchImpl?: typeof fetch): Promise<HandoffConfig | null> {
  try {
    const send = fetchImpl ?? win.fetch.bind(win);
    const response = await send(EXCHANGE_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    if (response.status !== 200) return null;
    const body: unknown = await response.json();
    return validate(isRecord(body) ? body.data : null);
  } catch {
    return null;
  }
}

export async function exchangeHandoff(win: Window, fetchImpl?: typeof fetch): Promise<HandoffConfig | null> {
  let fresh: HandoffConfig | null = null;
  const hash = win.location.hash;
  if (hash.startsWith("#code=") || hash.startsWith("#pes=")) {
    // 올바르든 깨졌든 쓰였든 조각은 주소창에 남기지 않는다 — 요청보다 먼저
    win.history.replaceState(win.history.state, "", `${win.location.pathname}${win.location.search}`);
    const code = hash.startsWith("#code=") ? hash.slice("#code=".length) : "";
    if (CODE.test(code)) fresh = await exchange(win, code, fetchImpl);
  }
  const stored = readStored(win);
  let config = stored;
  if (fresh) {
    config = stored && stored.session === fresh.session ? { ...fresh, projects: { ...stored.projects, ...fresh.projects } } : fresh;
    store(win, config);
  }
  if (config) (win as unknown as { __PES_APP__?: HandoffConfig }).__PES_APP__ = config;
  return config;
}
