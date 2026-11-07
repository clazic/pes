import type { FileRow, MaterialsView, UploadCandidate } from "@/api/types";

const files: FileRow[] = [
  { id: "f1", name: "2024 지역별 돌봄 인력 현황(가상).xlsx", folder: null, format: "xlsx", version: "v2", size: "1.4MB", by: "김연구", at: "11-03", extract: { domain: "extract", value: "ready" }, extract_note: "시트 4 · 표 6", access: "allow", used: "인용 5", pc: { domain: "sync", value: "synced" }, action: "보기" },
  { id: "f2", name: "선행연구 요약(가상).pdf", folder: null, format: "pdf", version: "v1", size: "8.2MB", by: "박검토", at: "11-03", extract: { domain: "extract", value: "partial" }, extract_note: "24쪽 중 3쪽 글자 없음", access: "allow", used: "인용 2", pc: { domain: "sync", value: "synced" }, action: "보기" },
  { id: "f3", name: "기관 면담 메모(가상).hwp", folder: null, format: "hwp", version: "v1", size: "0.6MB", by: "김연구", at: "11-04", extract: { domain: "extract", value: "unsupported" }, extract_note: "옛 한글 형식 — hwpx로 저장해 다시 올려 주세요", access: "allow", access_note: "보낼 글자 없음", used: "—", pc: { domain: "sync", value: "pending", label: "올림 대기" }, action: "안내" },
  { id: "f4", name: "내부 검토 의견(가상).docx", folder: null, format: "docx", version: "v3", size: "0.3MB", by: "김연구", at: "11-04", extract: { domain: "extract", value: "ready" }, extract_note: "쪽 6 · 표 1", access: "deny", access_note: "11-05 10:20 김연구", used: "인용 1", used_note: "끄기 전", pc: { domain: "sync", value: "skipped", label: "안 받음" }, action: "이력" },
  { id: "f5", name: "회의록 11월(가상).hwpx", folder: null, format: "hwpx", version: "v1", size: "0.2MB", by: "박검토", at: "11-05", extract: { domain: "extract", value: "failed" }, extract_note: "파일이 손상됐거나 암호가 걸려 있음", access: "allow", access_note: "보낼 글자 없음", used: "—", pc: { domain: "sync", value: "synced" }, action: "다시 뽑기" },
  { id: "f6", name: "발표 자료 초안(가상).pptx", folder: null, format: "pptx", version: "v1", size: "3.1MB", by: "김연구", at: "14:20", extract: { domain: "extract", value: "extracting" }, extract_note: "이 브라우저 · 12장 중 7장", access: "allow", used: "—", pc: { domain: "sync", value: "synced" }, action: "—" },
  { id: "f7", name: "현장 사진 설명(가상).pdf", folder: null, format: "pdf", version: "—", size: "18.4MB", by: "박검토", at: "14:25", extract: { domain: "upload", value: "uploading", label: "올리는 중 63%" }, extract_note: "예약 → 올리기 → 지문 확인", access: "allow", used: "—", pc: null, action: "멈추기", upload_percent: 63 },
  { id: "f8", name: "출처 미상 문서(가상).docm", folder: null, format: "docm", version: "—", size: "0.4MB", by: "박검토", at: "11-05", extract: { domain: "upload", value: "quarantined" }, extract_note: "형식 검사에서 걸림(매크로 문서) — 열지 않음", access: "na", access_note: "격리 중엔 누구에게도 안 감", used: "—", pc: null, action: "확인" },
  // 폴더째 올린 묶음(사용자 결정 2026-11-05) — 폴더 안 상대 경로만, 내 컴퓨터의 실제 경로는 없음
  { id: "g1", name: "면담 기록 A군(가상).hwpx", folder: "현장 조사 2026(가상)/면담", format: "hwpx", version: "v1", size: "0.4MB", by: "김연구", at: "15:02", extract: { domain: "extract", value: "ready" }, extract_note: "쪽 9", access: "allow", used: "—", pc: { domain: "sync", value: "synced" }, action: "보기" },
  { id: "g2", name: "면담 기록 B군(가상).hwpx", folder: "현장 조사 2026(가상)/면담", format: "hwpx", version: "v2", size: "0.5MB", by: "김연구", at: "15:02", extract: { domain: "extract", value: "ready" }, extract_note: "쪽 11 · 같은 이름이라 새 버전(v1은 남음)", access: "allow", used: "—", pc: { domain: "sync", value: "synced" }, action: "보기" },
  { id: "g3", name: "참여자 연락처(가상).xlsx", folder: "현장 조사 2026(가상)/면담", format: "xlsx", version: "v1", size: "0.1MB", by: "김연구", at: "15:02", extract: { domain: "extract", value: "ready" }, extract_note: "시트 1", access: "deny", access_note: "올릴 때부터 금지", used: "—", pc: { domain: "sync", value: "skipped", label: "안 받음" }, action: "이력" },
  { id: "g4", name: "설문 원자료(가상).csv", folder: "현장 조사 2026(가상)/설문", format: "csv", version: "v1", size: "0.9MB", by: "김연구", at: "15:03", extract: { domain: "extract", value: "ready" }, extract_note: "행 3,410", access: "allow", used: "—", pc: { domain: "sync", value: "synced" }, action: "보기" },
  { id: "g5", name: "설문지 최종(가상).pdf", folder: "현장 조사 2026(가상)/설문", format: "pdf", version: "v1", size: "1.2MB", by: "김연구", at: "15:03", extract: { domain: "extract", value: "ready" }, extract_note: "쪽 8", access: "allow", used: "—", pc: { domain: "sync", value: "synced" }, action: "보기" },
];

export const MATERIALS: MaterialsView = {
  scene_time: "14:31",
  now: {
    rank: 5,
    kind: "check",
    title: "선행연구 요약(가상).pdf — 3쪽은 AI가 읽지 못합니다",
    facts: ["스캔 쪽 3·7·19"],
    detail: "글자가 없는 그림(스캔) 쪽이 있습니다. 미리보기에서 빠진 곳을 확인하고, 필요하면 글자가 있는 PDF로 다시 올려 주세요.",
    action: { label: "미리보기 확인", href: "#preview" },
    then: [
      { label: "면담 메모 hwp → hwpx로", href: "#f3" },
      { label: "회의록 글자 뽑기 실패", href: "#f5" },
    ],
  },
  kpi: [
    { k: "자료", v: "13", s: "폴더 1 · 올리는 중 1 · 격리 1" },
    { k: "AI 참조 허용", v: "10", s: "기본값은 허용" },
    { k: "AI 참조 금지", v: "2", s: "소유자가 끔 · 이력 있음" },
    { k: "글자 뽑기 확인 필요", v: "3", s: "일부만 1 · 실패 1 · 지원 안 함 1" },
    { k: "웹 저장 공간", v: "1.2GB", s: "이 프로젝트 상한 2GB(예시값) 중 60%", meter: 60 },
  ],
  files,
  failed_upload: "2023 돌봄 실태조사 원자료(가상).xlsx 42MB — 파일당 25MB 초과. 나누거나 필요한 시트만 올려 주세요.",
  from_refs: [
    { file: "기관 실태 조사표(가상).xlsx", ref: "장기요양 기관 실태 분석(가상) · 1판 완료본", origin_access: { domain: "aiAccess", value: "allow" }, effect: "A 안 보냄(원본 AI가 읽기: 막음) · B(PES 경유) 원본 허용 목적지만", status: { domain: "reference", value: "pinned" } },
    { file: "면담 녹취 요약(가상).docx", ref: "장기요양 기관 실태 분석(가상) · 1판 완료본", origin_access: { domain: "aiAccess", value: "deny" }, effect: "어디에도 안 보냄", status: { domain: "reference", value: "pinned" } },
    { file: "설문 원자료(가상).csv", ref: "장기요양 기관 실태 분석(가상) · 1판 완료본", origin_access: null, effect: "—", status: { domain: "reference", value: "source_missing" }, status_note: "원본에서 지워짐 · 이름과 고정 기록만 남음" },
    { file: "(내용 비공개)", ref: "다른 프로젝트", origin_access: null, effect: "—", status: { domain: "reference", value: "no_permission" }, status_note: "원본 권한이 없어 이름도 보이지 않음" },
  ],
  history: [
    { no: 1, state: { domain: "aiAccess", value: "allow" }, who: "김연구 · 11-04 09:12", why: "올릴 때 기본값" },
    { no: 2, state: { domain: "aiAccess", value: "deny" }, who: "김연구 · 11-05 10:20", why: "기관 내부 의견 — 외부 AI로 보내지 않기로" },
  ],
};

/**
 * 폴더째 올리기 예시(합성). 실제 폴더를 고르면 브라우저가 파일 이름·크기·상대 경로만 읽어 같은 표를 만든다.
 * 이 시안은 아무것도 서버로 보내지 않는다.
 */
export const FOLDER_EXAMPLE: { root: string; items: UploadCandidate[] } = {
  root: "현장 조사 2026(가상)",
  items: [
    { path: "현장 조사 2026(가상)/면담/면담 기록 A군(가상).hwpx", size: 420_000, verdict: "ok", access: "allow" },
    { path: "현장 조사 2026(가상)/면담/면담 기록 B군(가상).hwpx", size: 510_000, verdict: "same_name", note: "같은 이름이 이미 있음(v1) → 새 버전 v2로 올림 · v1은 남음", access: "allow" },
    { path: "현장 조사 2026(가상)/면담/참여자 연락처(가상).xlsx", size: 98_000, verdict: "ok", note: "개인정보가 있을 수 있음 — 올릴 때부터 금지 권장", access: "deny" },
    { path: "현장 조사 2026(가상)/면담/녹음 원본(가상).m4a", size: 61_000_000, verdict: "too_large", note: "파일당 25MB 초과 — 건너뜀(예시 상한)", access: "allow" },
    { path: "현장 조사 2026(가상)/설문/설문 원자료(가상).csv", size: 910_000, verdict: "ok", access: "allow" },
    { path: "현장 조사 2026(가상)/설문/설문지 최종(가상).pdf", size: 1_200_000, verdict: "ok", access: "allow" },
    { path: "현장 조사 2026(가상)/설문/설문지 최종 사본(가상).pdf", size: 1_200_000, verdict: "same_content", note: "‘설문지 최종’과 내용이 같음 → 새 버전으로 기록, 바이트는 다시 보내지 않음", access: "allow" },
    { path: "현장 조사 2026(가상)/설문/분석 노트(가상).numbers", size: 300_000, verdict: "unsupported", note: "지원 안 되는 형식 — 원본만 보관, 글자 뽑기 없음", access: "allow" },
    { path: "현장 조사 2026(가상)/.DS_Store", size: 6_000, verdict: "hidden", note: "숨김 파일 — 빼기(바꿀 수 있음)", access: "allow" },
    { path: "현장 조사 2026(가상)/면담/~$면담 기록 A군(가상).hwpx", size: 1_000, verdict: "hidden", note: "편집 중 임시 파일 — 빼기", access: "allow" },
  ],
};

/** 폴더째 올리기 상한 — 값은 예시이며 사용자 결정이 필요하다(사용자 결정 2026-11-05 요구, MAT1). */
export const UPLOAD_LIMITS = {
  perFileMB: 25,
  perBatchCount: 500,
  perBatchTotalGB: 2,
  supported: ["hwpx", "hwp", "pdf", "docx", "xlsx", "pptx", "csv", "txt", "md", "doc", "xls", "ppt"],
};
