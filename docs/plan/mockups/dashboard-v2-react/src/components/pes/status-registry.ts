import type { StatusDomain } from "@/api/types";

/**
 * 상태 사전 — 설계 3.4(모양 9가지)·6절(상태 총표)을 코드로 옮긴 것.
 * 같은 상태는 어느 화면에서나 같은 모양·글자·색으로 보인다(설계 P2). 화면은 이 사전 밖의 이름을 만들지 않는다.
 * 화면 글자에는 ‘Go’를 쓰지 않는다(사용자 결정 2026-11-05) — ‘API’로 쓴다.
 */

export type Shape = "circle" | "ring" | "diamond" | "tri" | "square" | "hsquare" | "dotring" | "pause" | "dash";
export type Tone = "ok" | "run" | "you" | "warn" | "bad" | "off" | "unk";

export interface StatusDef {
  label: string;
  shape: Shape;
  tone: Tone;
  /** 상태 견본 화면에 보이는 근거(필드·사건). 영어 코드는 근거 열에만 쓴다. */
  basis?: string;
  /** 사람이 할 일 */
  todo?: string;
  /** 열 이름·스위치 이름이 앞말을 이미 말할 때 쓰는 짧은 글자(“AI가 읽기” 열의 “허용”·“막음”) — 같은 말 반복 없음(14.1) */
  short?: string;
}

/** 모양 9가지의 뜻(설계 3.4) */
export const SHAPES: { shape: Shape; tone: Tone; name: string; meaning: string }[] = [
  { shape: "circle", tone: "ok", name: "채운 원", meaning: "됨 · 켜짐 · 맞춤 · 허용" },
  { shape: "ring", tone: "run", name: "고리", meaning: "진행 중 · 기다리는 중(시스템)" },
  { shape: "diamond", tone: "you", name: "마름모", meaning: "사람 차례 · 나의 할 일" },
  { shape: "tri", tone: "warn", name: "세모", meaning: "주의 · 부분 · 새 버전 · 다시 확인 필요" },
  { shape: "square", tone: "bad", name: "채운 네모", meaning: "막힘 · 실패 · 충돌 · 차단" },
  { shape: "hsquare", tone: "off", name: "빈 네모", meaning: "꺼짐 · 금지 · 보관 · 원본 없음 · 권한 없음" },
  { shape: "dotring", tone: "unk", name: "점선 고리", meaning: "미상 · 확인 안 됨" },
  { shape: "pause", tone: "off", name: "두 줄", meaning: "쉼 · 유예 · 일시 중지" },
  { shape: "dash", tone: "off", name: "가로줄", meaning: "아직 · 건너뜀 · 해당 없음" },
];

const d = (label: string, shape: Shape, tone: Tone, basis?: string, todo?: string): StatusDef => ({ label, shape, tone, basis, todo });

export const DOMAIN_LABEL: Record<StatusDomain, string> = {
  run: "실행",
  ask: "사람→AI 질문",
  timeline: "작업 타임라인",
  computer: "내 컴퓨터",
  sync: "동기화",
  refresh: "갱신",
  transfer: "AI가 읽기 칩",
  meter: "API 사용량 계기",
  resetBasis: "재개 가능 시각",
  extraUsage: "추가 요금(Extra Usage) 꺼짐 확인",
  baseline: "다른 앱 사용량(기준점)",
  costCap: "비용 상한(쓴 만큼 과금)",
  connTest: "AI 연결 시험",
  upload: "올리기",
  extract: "글자 뽑기",
  aiAccess: "AI 참조",
  reference: "참고 프로젝트",
  question: "질문",
  answer: "답",
  submission: "제출",
  stage: "단계",
  reflection: "반영 내역",
  anchor: "첨언 앵커",
  notify: "알림 발송",
  device: "기기 승인",
  turn: "차례 · 나의 할 일",
  check: "준비 검사",
  generic: "공통",
};

export const STATUS: Record<StatusDomain, Record<string, StatusDef>> = {
  run: {
    queued: d("시작 대기", "dash", "off", "queued (B: 내 컴퓨터가 아직 받지 않음)", "기다림"),
    running: d("진행 중", "ring", "run", "running", "진행 보기"),
    waiting_human: d("내 답 기다림", "diamond", "you", "waiting_human · 담당 없음", "답하기 → 계속"),
    blocked_usage: d("실행 멈춤 · 사용량", "square", "bad", "blocked_usage + 사유(사용량 문턱·한도 · 추가 요금 확인 필요 · 사용량 확인 불가 · 비용 상한 · 과금 표시) · 재개 가능 시각", "사용량 화면에서 정리 → 계속"),
    manual_hold: d("실행 멈춤 · 사람이 멈춤", "pause", "off", "blocked_usage + manual_hold", "원할 때 계속"),
    succeeded: d("끝남", "circle", "ok", "succeeded (끝남 ≠ 승인)", "결과 보기 · 승인"),
    failed: d("실패", "square", "bad", "failed (다른 모델로 자동 전환 없음)", "새 실행 또는 넘기기"),
    cancelled: d("취소됨", "hsquare", "off", "cancelled (저장된 결과는 남음)"),
    interrupted: d("중단됨", "tri", "warn", "interrupted (끊김 ≠ 취소)", "새 실행 또는 넘기기"),
    unknown: d("상태 미상", "dotring", "unk", "관측 끊김 · 보존 기간 지남", "확인 · 새 실행(자동 재개 없음)"),
    unconfirmed_call: d("확인 안 된 호출", "square", "bad", "outbound_dispatches.state = unknown", "사용량에서 정리"),
    local_permission: d("내 컴퓨터에서 확인", "diamond", "you", "외부 앱 실행 권한 질문(도우미 보고)", "내 컴퓨터에서 답"),
    handed_off: d("넘겨짐", "hsquare", "off", "handoff로 새 실행 생김(옛 실행 보존)", "새 실행 보기"),
  },
  ask: {
    received: d("접수됨", "circle", "ok", "질문 영수증"),
    pc_received: d("내 컴퓨터 받음", "circle", "ok", "입력 영수증(받음 ≠ 읽음)"),
    no_answer: d("답 없음", "dotring", "unk", "경과 시간", "기다림 · 복사 대안"),
    answered: d("답 옴", "circle", "ok"),
    copied: d("복사함", "ring", "run", "프롬프트 복사(전달 확인 아님)", "결과 가져오기"),
  },
  timeline: {
    planned: d("예정", "ring", "run", "agent_schedules.status"),
    running: d("진행", "ring", "run", "execution.*"),
    done: d("완료", "circle", "ok"),
    failed: d("실패", "square", "bad"),
    cancelled: d("취소", "hsquare", "off"),
  },
  computer: {
    connected: d("연결됨", "circle", "ok", "도우미·AI 도구 최근 확인"),
    ai_absent: d("AI 미접속 · 대기 중", "diamond", "you", "도우미가 AI 도구 연결 없음을 보고함(확인된 부재)", "AI 도구 켜기"),
    ai_unconfirmed: d("AI 접속 미확인", "dotring", "unk", "AI 도구의 마지막 호출이 오래됨 — 긴 추론·정상 대기일 수 있어 미접속으로 단정하지 않음", "마지막 확인 시각 보기"),
    unknown: d("상태 미상", "dotring", "unk", "도우미 확인 끊김(시험값 넘음)", "확인(웹에서 답은 계속 가능)"),
    direct: d("AI 도구 직접 연결", "circle", "ok", "도우미 없이 MCP", "필요하면 도우미 켜기"),
    paused: d("동기화 일시 중지", "pause", "off", "sync_links.status = paused", "다시 시작"),
    revoked: d("연결 해제됨", "hsquare", "off", "revoked", "다시 기기 승인"),
    copy: d("복사로 전달", "ring", "run", "직접 연결 없는 앱", "결과 가져오기"),
    never: d("연결한 적 없음", "dash", "off", "링크 없음", "연결 안내"),
  },
  sync: {
    synced: d("맞춤", "circle", "ok", "sync_items.state = synced"),
    pending: d("대기", "ring", "run", "pending"),
    conflict: d("충돌", "square", "bad", "conflict", "고르기"),
    source_missing: d("원본 없음", "hsquare", "off", "source_missing"),
    skipped: d("건너뜀", "dash", "off", "skipped"),
    deleted_local: d("내 컴퓨터에서 지워짐 — 웹에는 남음", "hsquare", "off", "삭제 비전파"),
  },
  refresh: {
    live: d("실시간", "circle", "ok", "변경 알림 연결 → 알림이 오면 변경분만 받음"),
    slow: d("느린 갱신 · 30초", "ring", "run", "알림 연결이 안 돼 긴 대기로 확인"),
    paused: d("갱신 쉼", "pause", "off", "탭이 숨겨짐 → 돌아오면 한 번 받음"),
    offline: d("끊김 · 다시 연결 중", "dotring", "unk", "네트워크 끊김 · 입력은 보존"),
    resync: d("다시 받는 중", "tri", "warn", "변경 위치(커서) 무효 → 화면 자료만 새로 받음"),
  },
  // AI가 읽기: 허용/막음(4차 사용자 결정 — 옛 말은 설계 13.1 대응표): 등록된 AI 연결(API)이 이 프로젝트 자료를 읽게 할지.
  // API 목적지(방식 A, B 도구가 API로 보내는 경우)에만 적용 — B 도구가 PES를 거쳐 읽는 것은 파일별 AI 참조를 따른다(policy.ts).
  transfer: {
    on: { ...d("AI가 읽기: 허용", "circle", "ok", "현재 정책이 허용 · 이미 나간 자료는 회수되지 않음"), short: "허용" },
    off: { ...d("AI가 읽기: 막음", "hsquare", "off", "소유자가 막음 · 방식 A 불가 → B나 사람 작업", "소유자 결정"), short: "막음" },
    blocked: d("AI가 읽기 차단 중", "square", "bad", "정책을 확인할 수 없음(누락·손상) → 보내지 않음", "관리자 확인"),
    changing: d("AI가 읽기 바꾸는 중", "tri", "warn", "바꾸는 중 · 확정 전에는 새 전송 없음"),
    unconfirmed: d("확인 안 된 전송", "square", "bad", "막는 동안 나가던 전송의 결과를 모름 · 다시 허용해도 자동 재시작 없음"),
  },
  meter: {
    ok: d("여유", "circle", "ok", "추정 사용률 < 문턱 −10%p"),
    warn: d("주의", "tri", "warn", "문턱 10%p 아래부터 · 표시만, 멈추지 않음", "알기만"),
    over: d("문턱 넘음 · 멈춤", "square", "bad", "추정 사용률 ≥ 멈춤 문턱"),
  },
  resetBasis: {
    api: d("API가 알려 줌", "circle", "ok", "한도 오류 응답에 다시 쓸 수 있는 시각이 있음"),
    estimate: d("PES 추정", "ring", "run", "PES가 센 호출 시각으로 계산 · 틀릴 수 있음"),
    unknown: d("재개 시각 미확인", "dotring", "unk", "근거 없음 · 0이나 추정값으로 채우지 않음"),
  },
  extraUsage: {
    confirmed: d("확인됨", "circle", "ok", "유효 기간 안"),
    expiring: d("곧 만료", "tri", "warn", "하루 안에 끝남 · 알림"),
    expired: d("만료", "square", "bad", "방식 A를 시작하지 않음", "콘솔 확인 후 기록"),
    none: d("기록 없음", "square", "bad", "방식 A를 시작하지 않음", "콘솔 확인 후 기록"),
    billing: d("과금 표시 감지", "square", "bad", "응답에 과금 표시 → 즉시 멈춤", "콘솔 확인"),
  },
  baseline: {
    entered: d("콘솔 기준값 입력됨", "circle", "ok", "t0에 콘솔에서 본 계정 전체 사용률 · 그 뒤 PES 증분만 더함"),
    stale: d("기준값 오래됨", "tri", "warn", "유효 기간이 지나 다시 적어야 함", "다시 적기"),
    none: d("기준값 없음", "square", "bad", "비어 있으면 방식 A를 시작하지 않음(0으로 두지 않음)", "적기"),
    not_used: d("t0 이후 다른 앱 안 씀(선언)", "circle", "ok", "t0 이후에 대한 선언 · 과거 사용의 0 증거가 아님"),
  },
  costCap: {
    set: d("비용 상한 있음", "circle", "ok", "쓴 만큼 과금 연결의 월 상한"),
    near: d("상한 가까움", "tri", "warn", "추정 비용이 상한의 90% 이상 · 표시만"),
    reached: d("상한 닿음 · 멈춤", "square", "bad", "추정 비용 ≥ 상한 → 새 호출 중단", "상한 올리기(소유자·재인증) 또는 기다리기"),
    missing: d("비용 상한 없음 — 시작 못 함", "square", "bad", "쓴 만큼 과금인데 상한이 비어 있음", "상한 적기"),
    price_unknown: d("단가 모름 — 시작 못 함", "dotring", "unk", "모델 단가를 모르면 비용을 셀 수 없음(0으로 두지 않음)", "단가 적기"),
  },
  connTest: {
    ok: d("연결됨", "circle", "ok", "PES 서버가 시험한 시각"),
    failed: d("연결 실패", "square", "bad", "주소·키·네트워크 오류", "주소·키 확인"),
    testing: d("시험 중", "ring", "run"),
    never: d("시험 안 함", "dash", "off", "저장 전 시험 권장"),
  },
  upload: {
    reserved: d("예약됨", "dash", "off", "자리를 잡음"),
    uploading: d("올리는 중", "ring", "run", "멈추기 가능"),
    hashing: d("지문 확인 중", "ring", "run", "받은 바이트 확인"),
    ready: d("준비됨", "circle", "ok", "쓸 수 있음"),
    quarantined: d("격리됨", "square", "bad", "형식 검사 실패 · 열지 않음"),
    failed: d("올리지 못함", "square", "bad", "끊김 · 크기 초과 · 형식", "다시 올리기"),
    skipped: d("건너뜀", "dash", "off", "숨김 파일 · 너무 큰 파일(폴더째 올리기)"),
  },
  extract: {
    pending: d("대기", "dash", "off", "file_extractions.status = pending"),
    extracting: d("뽑는 중", "ring", "run", "이 브라우저(또는 내 컴퓨터)"),
    ready: d("준비됨", "circle", "ok", "ready · 미리보기 가능"),
    partial: d("일부만", "tri", "warn", "partial · 빠진 곳 목록", "미리보기"),
    failed: d("실패", "square", "bad", "failed · 손상·암호", "다시 뽑기"),
    unsupported: d("지원 안 함", "hsquare", "off", "unsupported · 옛 형식", "새 형식으로 저장"),
  },
  aiAccess: {
    allow: d("허용", "circle", "ok", "file_policies.ai_access = allow · 기본값"),
    deny: d("금지", "hsquare", "off", "deny · 소유자가 끔 · 이력"),
    changing: d("바꾸는 중", "ring", "run", "확정 전 표시 · 영수증 뒤 새 상태"),
    inherit: d("원본 따름", "circle", "ok", "참고 프로젝트 자료"),
    na: d("해당 없음", "dash", "off", "격리 · 보낼 글자 없음"),
    used_before_off: d("끄기 전에 쓰임", "tri", "warn", "결과물 인용에 붙는 표시"),
    mixed: d("일부 금지", "tri", "warn", "폴더 안 파일마다 다름"),
  },
  reference: {
    attaching: d("붙이는 중", "ring", "run", "reference_attach 접수 전"),
    pinned: d("고정됨", "circle", "ok", "source_snapshot_id"),
    new_version: d("새 버전 있음", "tri", "warn", "latest_snapshot_id ≠ 고정한 버전 · 자동 갱신 없음", "갱신 · 유지"),
    source_archived: d("원본 보관됨", "hsquare", "off", "source_archived"),
    source_missing: d("원본 없음", "hsquare", "off", "source_missing · 이름과 마지막 고정 버전만"),
    no_permission: d("권한 없음", "hsquare", "off", "원본 권한 없음 · 내용·이름 비노출"),
    not_included: d("참조 원본 미포함", "dotring", "unk", "이 프로젝트만 옮기거나 복원함"),
  },
  question: {
    open: d("열림", "ring", "run", "question_versions.state = open"),
    recheck: d("질문 변경 — 답 재확인", "tri", "warn", "새 질문 버전 · 옛 답 자동 승계 없음", "다시 답하기"),
    deferred: d("보류", "pause", "off", "deferred"),
    merged: d("합침", "hsquare", "off", "merged"),
    withdrawn: d("철회", "hsquare", "off", "withdrawn"),
    closed: d("닫힘", "circle", "ok", "closed"),
    draft: d("초안", "dash", "off", "draft(사람이 만드는 중)"),
  },
  answer: {
    none: d("초안 없음", "dash", "off"),
    draft: d("초안 · 이 탭에만 있음", "ring", "run", "sessionStorage(같은 탭)"),
    sent: d("보냄", "circle", "ok", "answer_versions · 접수 번호"),
    skipped: d("건너뜀", "dash", "off"),
    withdrawn: d("철회", "hsquare", "off"),
    revised: d("고쳐 보냄", "circle", "ok", "supersedes_version_id"),
  },
  submission: {
    pending: d("접수 확인 중", "ring", "run", "응답이 늦어 같은 멱등 키로 확인 중"),
    sent: d("보냄", "circle", "ok", "영수증(접수 번호)"),
    conflict: d("버전 충돌", "square", "bad", "당시 폼 버전 검사 실패 · 부분 접수 없음", "바뀐 곳 보고 다시"),
    failed: d("보내지 못함", "square", "bad", "끊김 · 자동 재전송 없음", "다시 보내기"),
  },
  stage: {
    pending: d("아직", "dash", "off", "stages.status = pending"),
    asking: d("시작 질문 중", "diamond", "you", "asking"),
    current_you: d("현재 · 나의 할 일", "diamond", "you", "active + 사람 차례"),
    current_ai: d("현재 · AI가 하는 중", "ring", "run", "active + AI 쪽 차례(실행이 담당을 잡음)"),
    current_blocked: d("현재 · 막힘", "square", "bad", "active + 사용량 멈춤 등"),
    approved: d("승인됨", "circle", "ok", "approved"),
    stale: d("앞 단계 변경 — 다시 확인", "tri", "warn", "앞 단계 다시 열기(stale)", "다시 보기"),
  },
  reflection: {
    applied: d("적용", "circle", "ok", "결과 버전·적용된 후속의 증거"),
    partial: d("부분", "tri", "warn"),
    deferred: d("유예", "pause", "off"),
    rejected: d("거절", "hsquare", "off"),
  },
  anchor: {
    exact: d("exact · 그대로", "circle", "ok", "anchor_resolutions.status"),
    moved: d("moved · 위치 바뀜", "tri", "warn"),
    ambiguous: d("ambiguous · 후보 여럿", "tri", "warn", "자동 선택 안 함", "사람이 다시 붙이기"),
    lost: d("lost · 원문 없음", "hsquare", "off", "인용·스레드 보존", "사람이 다시 붙이기"),
  },
  notify: {
    sent: d("보냄", "circle", "ok", "WEB8 발송 영수증"),
    failed: d("실패", "square", "bad"),
    unknown: d("확인 안 됨", "dotring", "unk", "자동 재전송 멈춤 · 중복 가능성"),
    push_denied: d("푸시 거부·미설치", "hsquare", "off", "메일로 보냄"),
  },
  device: {
    waiting: d("기다림", "diamond", "you", "device flow", "코드 대조"),
    approved: d("승인", "circle", "ok"),
    denied: d("거절", "hsquare", "off"),
    expired: d("만료", "dash", "off", "다시 요청"),
  },
  // 차례(설계 15절, 4차 사용자 결정 2026-11-05): 위 다섯이 “누가 움직일 차례인가”(차례 표시기 · 사이드바 배지 · 목록 줄 · 휴대폰),
  // 아래 여섯이 나의 할 일의 종류(지금 할 일 순위 3.3). 옛 이름은 화면에 쓰지 않는다(설계 13.1 대응표).
  turn: {
    you: d("나의 할 일", "diamond", "you", "지금 이 사람이 할 수 있는 일이 있음(지금 할 일 1~5순위) — 서버가 사람·권한별로 셈", "바로 가기"),
    ai: d("AI가 하는 중", "ring", "run", "6순위 · 실행이 담당을 잡고 진행 + 진행 소식이 시험값 안(A: 실행기 사건 · B: 도우미·AI 도구 보고) — 이때만 움직임", "진행 보기"),
    ai_quiet: d("AI가 하는 중 · 소식 없음", "dotring", "unk", "담당은 유효하지만 마지막 소식이 시험값을 넘음 — 움직이지 않음, 멈췄다고 단정하지 않음(F09 · stage-3 2.6)", "마지막 소식 보기"),
    waiting: d("기다림", "pause", "off", "다른 사람(소유자·API 연결 관리자)이나 시각(재개 가능 시각)을 기다림 — 내 할 일 아님(F08)"),
    done: d("끝남", "circle", "ok", "판 완료 · 누구의 할 일도 없음"),
    blocked: d("막힘", "square", "bad", "1순위"),
    answer: d("답할 질문", "diamond", "you", "2순위"),
    start_q: d("시작 질문", "diamond", "you", "2순위 · 단계 시작(라운드 전)"),
    approve: d("승인 대기", "diamond", "you", "3순위"),
    resume: d("계속", "diamond", "you", "4순위"),
    check: d("확인", "tri", "warn", "5순위"),
  },
  check: {
    pass: d("통과", "circle", "ok"),
    server_pass: d("통과 · 서버 판단", "circle", "ok", "PR8 resume_ready가 현재 대상에 대해 계산"),
    notyet: d("아직", "square", "bad"),
  },
  generic: {
    done: d("완료", "circle", "ok"),
    now: d("지금 하는 칸", "ring", "run"),
    notyet: d("아직", "dash", "off"),
    later: d("나중에", "tri", "warn"),
    adopted: d("채택본", "circle", "ok"),
    available: d("쓸 수 있음", "circle", "ok"),
    usable: d("사용 가능", "circle", "ok"),
    weight_unknown: d("사용량 가중치 미확인", "tri", "warn"),
    not_listed: d("지금 목록에 없음", "hsquare", "off"),
    limited: d("제한 있음", "tri", "warn", "폴더 직접 읽기 가능 · ‘제외 보장’이라 쓰지 않음"),
    checking: d("확인 중", "dotring", "unk"),
    readonly: d("읽기 전용", "hsquare", "off"),
    load_error: d("불러오지 못함", "square", "bad"),
    cannot_send: d("보낼 수 없음", "square", "bad"),
    excluded: d("제외", "hsquare", "off"),
    readable: d("읽을 수 있음", "circle", "ok"),
    not_sent: d("보내지 않음", "hsquare", "off"),
    sends: d("보냄", "circle", "ok"),
    gives: d("내줌", "circle", "ok"),
    not_given: d("안 내줌", "hsquare", "off"),
    receives: d("받음", "circle", "ok"),
    not_received_limited: d("안 받음 · 제한 있음", "tri", "warn"),
    visible: d("볼 수 있음", "circle", "ok"),
    approved: d("승인됨", "circle", "ok"),
    not_approved: d("승인하지 않음", "square", "bad"),
    retry_needed: d("다시 시도 필요", "tri", "warn"),
    attached: d("붙음", "circle", "ok"),
    received: d("접수됨", "circle", "ok"),
    duplicate: d("같은 주소가 있음", "square", "bad"),
    session_over: d("로그인이 끝남", "square", "bad"),
    dest_only: d("원본이 허용한 목적지만", "circle", "ok"),
    new_version: d("새 버전으로 올림", "tri", "warn"),
    same_content: d("내용이 같음 · 새 버전으로 기록", "tri", "warn"),
    unsupported_fmt: d("지원 안 되는 형식", "hsquare", "off"),
    too_large: d("너무 큼 · 건너뜀", "square", "bad"),
    hidden: d("숨김 파일 · 건너뜀", "dash", "off"),
    result_unknown: d("결과 미확인", "dotring", "unk", "보낸 뒤 응답을 못 받음 — 같은 요청 번호로 확인"),
    dest_unknown: d("목적지 미확인 — 안 내줌", "dotring", "unk", "목적지·정책을 모르면 허용으로 계산하지 않음"),
    stepup: d("본인 확인 필요", "diamond", "you", "정책 변경은 요청 한 건마다 재인증(5단계)"),
  },
};

export function lookup(domain: StatusDomain, value: string): StatusDef {
  const def = STATUS[domain]?.[value];
  if (!def) {
    // 모르는 값은 ‘미상’으로 보인다(설계 P4: 모르면 모른다고). 허용·정상으로 해석하지 않는다.
    return { label: `미상(${value})`, shape: "dotring", tone: "unk" };
  }
  return def;
}
