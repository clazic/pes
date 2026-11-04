# 5단계 구현 이슈 초안 — 동료 검토

- 대상: [stage-5.md](stage-5.md)(구현 이슈 초안) ↔ [stage-5.md](../stage-5.md)(계획서) 4절, [stage-1-db.md](../stage-1-db.md)·[stage-1-api.md](../stage-1-api.md)·[stage-1-ui.md](../stage-1-ui.md)·[stage-1-runners.md](../stage-1-runners.md), [DDL](../schemas/stage-1-ddl-draft.sql)
- 방법: 계획서 4절의 WEB0~WEB14와 이슈 초안의 15개 제목을 대조하고, 선행·완료 기준·테스트 명령·파일·표 이름을 확인했다. 실제 `~/pes-projects`·`~/.pes`는 읽지 않았고 Linear 이슈도 만들지 않았다.
- 결과: **문제 19, 고침 19.** 15개 이슈 모두 존재하고, 이슈 하나=PR 하나 형식이며, 모든 이슈에 선행·완료 기준·테스트 명령이 있다. 아래는 계획서 대비 누락·불일치와 고친 내용이다.

## 1. 확인 결과

| 확인 | 결과 |
|---|---|
| 계획서 4절 이슈 존재 | **15/15** — WEB0~WEB14 모두 있음 |
| 이슈 하나 = PR 하나 | 15개 `### [5단계]` 제목, 숨은 하위 이슈 없음. WEB2·WEB7·WEB9·WEB10은 계획서가 허용한 분할 후보이며 이 초안은 1개로 유지 |
| 선행 | 15/15에 `**선행**` 있음. 계획서의 PR·WEB 선행과 일치 |
| 완료 기준·테스트 명령 | 15/15에 `**완료 기준**`과 테스트 명령 있음. WEB0만 `web/package.json` 선행 문제를 고침 |
| 파일·표 이름 | `scripts/pes.py`의 `CMDS`, `project_members`, `agent_tokens`, `import_batches`, `legacy_mappings`, `blobs`, `events` 등 실제 이름과 일치. 새 표는 `web/migrations/`로 표시. `local_export_state` 위치 1건을 고침 |
| 실제 자료·Linear | 실제 자료·실키·기관 자료 없음. Linear 이슈 생성 없음 |

## 2. 문제와 고침

| # | 위치 | 문제 | 근거(계획서) | 고침 |
|---|---|---|---|---|
| 1 | WEB0 완료 기준 | `npm --prefix web run test`는 `web/package.json`이 필요한데, 그 파일은 WEB1에서 만든다 | 4절 WEB0·WEB1 | `web/spike/package.json`을 WEB0 할 일에 추가하고, 완료 명령을 `npm --prefix web/spike run test -- --run test/contracts`로 바꿈 |
| 2 | WEB0 완료 기준 | 후보 (c)만 WEB1 재검토를 적고, 후보 (b) TS 이식 시 2~4단계 언어 재정이 빠짐 | 4절 WEB0 "결과가 TS 이식이면 2~4단계 구현 언어를 다시 정하고 WEB1에 입력" | 후보 (b) TS 이식이면 2~4단계 언어 재정·WEB1 입력을 기록하도록 추가 |
| 3 | WEB1 할 일·완료 기준 | 계획서의 "기능 플래그"가 빠짐 | 4절 WEB1 범위 | `web/src/config/flags.ts`와 기능 플래그 on/off·미지원 표시 완료 기준 추가 |
| 4 | WEB1 할 일·완료 기준 | D1 batch 원자성·deferred FK·부분 인덱스·JSON 함수 시험이 빠짐 | 4절 WEB1 완료 조건 | `commands.ts`에 경계를 명시하고, 로컬 SQLite·D1 smoke 완료 기준 추가 |
| 5 | WEB1 완료 기준 | 정적 자산 20,000개·Cron 5개 한도 smoke가 빠짐 | 4절 WEB1 완료 조건 | staging smoke에 정적 자산 20,000개·Cron 5개 추가 |
| 6 | WEB2 할 일·완료 기준 | 계획서의 기기 목록·전체 로그아웃이 빠짐 | 4절 WEB2 범위 | `web/src/views/settings/security.ts` 기기 목록·모든 기기 로그아웃과 완료 기준 추가 |
| 7 | WEB2 할 일 | Better Auth 버전 고정·D1 어댑터·추가 인증 표 검증이 빠짐 | 4절 WEB2 범위 | Better Auth 버전 고정·D1 어댑터·PES `users` 매핑 검증 체크 추가 |
| 8 | WEB3 할 일·완료 기준 | 멤버 변경·초대·철회 감사 기록이 빠짐 | 4절 WEB3 "감사" | `auth_audit`·`events` 기록과 완료 기준 추가 |
| 9 | WEB3 할 일·완료 기준 | MCP/OAuth scope 정책이 빠짐 | 4절 WEB3 "MCP/OAuth scope 정책" | `permissions.ts` 매트릭스를 WEB5 `grants.ts`와 공유하고 완료 기준 추가 |
| 10 | WEB5 할 일·완료 기준 | Desktop/stdio·CLI 지원 수준이 빠짐 | 4절 WEB5 "Desktop/stdio·CLI 지원 수준" | `docs/operations/mcp-connect.md`와 완료 기준에 지원 수준·한계 추가 |
| 11 | WEB6 할 일·완료 기준 | runner 등록 경로·기기 목록이 빠짐 | 4절 WEB6 "등록·기기 목록" | `POST /api/v1/runner/register`·`web/src/views/runner/devices.ts`와 완료 기준 추가 |
| 12 | WEB6 할 일·완료 기준 | runner 로그 회전이 빠짐 | 4절 WEB6 "로그" | `scripts/runner/logging.py` 로그 회전·비밀 제거와 완료 기준 추가 |
| 13 | WEB8 할 일·완료 기준 | 로그인 뒤 정확한 버전 딥링크가 빠짐 | 4절 WEB8 "딥링크" | 기본 본문의 로그인 링크를 정확한 버전 딥링크로 명시하고 완료 기준 추가 |
| 14 | WEB9 할 일·완료 기준 | 서명된 업로드가 빠짐 | 4절 WEB9 "멀티파트·서명" | `bundle.ts`에 서명된 업로드 URL과 완료 기준 추가 |
| 15 | WEB9 할 일 | `local_export_state`를 `web/migrations/0009_import.sql`에 두어 웹 D1 표로 오해하게 함 | 4절 WEB9 "로컬 읽기 전용 표시(새 마이그레이션 담당 WEB9)" | 로컬 SQLite 마이그레이션(2단계 PR1 경로)으로 옮기고, 웹 마이그레이션에는 `import_tokens`·`import_chunks`만 두게 함 |
| 16 | WEB9 할 일·완료 기준 | CLI·스킬의 웹 API 전환이 빠짐 | 4절 WEB9 "CLI·스킬의 웹 API 전환" | `skills/`의 `pes` 호출을 웹 API로 바꾸는 어댑터 경계와 완료 기준 추가 |
| 17 | WEB10 완료 기준 | 구버전 앱/신스키마 호환 창 시험이 빠짐 | 4절 WEB10 완료 조건 | 완료 기준에 호환 창 시험 추가 |
| 18 | WEB11 할 일·완료 기준 | 시크릿 회전이 빠짐 | 4절 WEB11 "시크릿 회전" | `docs/operations/runbook.md` 시크릿 회전 절차·키 버전과 완료 기준 추가 |
| 19 | WEB13 완료 기준 | REA `discover_webmcp_tools` 발견 점검이 빠짐 | 4절 WEB13 완료 조건 "REA 도구 발견 점검" | 완료 기준에 `discover_webmcp_tools` 발견 점검 추가 |

## 3. 고친 내용 요약

- **WEB0**: `web/spike/package.json` 분리, TS 이식 분기 추가.
- **WEB1**: 기능 플래그, D1 batch·deferred FK·부분 인덱스·JSON 함수, 정적 자산 20,000개·Cron 5개.
- **WEB2**: 기기 목록·전체 로그아웃, Better Auth 버전 고정·D1 어댑터.
- **WEB3**: 감사 기록, MCP/OAuth scope 정책 공유.
- **WEB5**: Desktop/stdio·CLI 지원 수준.
- **WEB6**: runner 등록·기기 목록, 로그 회전.
- **WEB8**: 정확한 버전 딥링크.
- **WEB9**: 서명 업로드, `local_export_state`를 로컬 SQLite로, 스킬 웹 API 경계.
- **WEB10**: 구버전 앱/신스키마 호환 창.
- **WEB11**: 시크릿 회전.
- **WEB13**: REA 도구 발견 점검.

## 4. 비차단 메모

- WEB2·WEB7·WEB9·WEB10은 계획서도 "크다"고 표시한 단위다. 이 초안은 1개로 유지했고, 구현 중 독립 배포·검증이 가능할 때만 나누는 계획서 규칙을 그대로 둔다.
- WEB3의 `web/src/services/notifications.ts`와 `web/src/services/grants.ts`는 각각 WEB8·WEB5에서 만드는 파일을 미리 가리키는 의존이다. 순환 구현이 아니라 계약 참조로 읽어야 한다.
- 실제 자료를 쓰는 시험은 계획서대로 WEB9 활성화 직전 사용자 허용 1개로 제한하고, 그 전에는 합성 fixture만 쓴다.
