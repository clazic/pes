# 5단계 구현 이슈 초안

- 입력: [stage-5.md](../stage-5.md) 4절(WEB0~WEB15), [stage-1-db.md](../stage-1-db.md)·[stage-1-api.md](../stage-1-api.md)·[stage-1-ui.md](../stage-1-ui.md)·[stage-1-runners.md](../stage-1-runners.md), [DDL 초안](../schemas/stage-1-ddl-draft.sql)
- 상태: **초안 — 사용자 승인 뒤 Linear 등록.** 이 문서는 등록 원고이며 코드·계획서를 바꾸지 않는다.
- 규칙: **이슈 하나 = PR 하나.** 한 이슈 안에서도 기존 구현 재사용과 새 변경을 구분한다. 독립 배포·검증이 가능할 때만 나눈다. 실제 `~/pes-projects`·`~/.pes/` 자료, 실키, 기관 자료는 쓰지 않고 합성 fixture만 쓴다.
- 이슈 수: **16개(WEB0~WEB15)**. `WEB2`·`WEB7`·`WEB9`·`WEB10`은 크므로 구현 중 독립 배포·검증이 가능할 때만 나눈다.
- 경로 가정: **TypeScript 단일 언어(0016)**. WEB0 전에도 `web/src` TS 경로를 쓰고, Python 경로로 되돌리지 않는다. 웹 앱은 `web/`, 마이그레이션은 `web/migrations/`, 웹 테스트는 `web/test/`, E2E는 `web/e2e/`에 둔다.
- 공통 테스트: 로컬 코어는 **결정 뒤 확정할 TS 테스트 명령**(0.15 Python 자산은 PR26 이전 한시); 웹 `npm --prefix web run test -- --run`; E2E `npm --prefix web run test:e2e`; 로컬 D1 `npm --prefix web run db:migrate:local`. `web/package.json`의 스크립트는 WEB1에서 만든다.
- 마이그레이션 번호는 이슈 번호와 맞춘다(예: WEB4 → `0004_agent_tokens.sql`). WEB3는 소유권 이력 마이그레이션 `0003_ownership.sql`을 둔다. 새 표가 없는 WEB7·WEB11·WEB13·WEB14는 번호를 비우고, 기존 표·계약을 재사용한다.
- 공통 지킬 것: 서버가 모든 권한을 재검사한다. UI 숨김은 권한이 아니다. 승인·reopen·판 시작·정책·토큰·삭제는 사람 세션만 하고 에이전트 키·OAuth·WebMCP로 대행할 수 없다. 원본 위치는 프로젝트마다 하나이고 이중 쓰기·양방향 동기화를 하지 않는다. 새 표·열은 `web/migrations/`에 번호를 붙이고 `db_meta.schema_version`·`docs/plan/schemas/stage-1-ddl-draft.sql`·**PR26이 옮긴 TS 설계 검사기**(0016, Python `check_ddl.py`는 PR26 전까지만)를 함께 갱신한다. 미지원은 capabilities에 알리고 가짜 성공을 반환하지 않는다.
- **플랫폼 공통 계약과 기준 구현**: 명령·SQLite·백업·실시간 계약은 후보 공통이다. WEB1~14의 D1/R2/Workflows/10ms/Free 조건은 **Cloudflare 기준 구현**이며, WEB0 결과가 Vercel/VPS면 같은 계약의 해당 DB·파일·실행기·실시간·백업·비용 계기로 치환한다. 유료 안은 비용 승인 뒤 그 예산으로 시험한다.

## WEB0 — 웹 플랫폼·TS 실행 환경 시험

### [5단계] 웹 플랫폼·TS 실행 환경 시험 — 후보 3군·Node/Bun/Deno

- **목표**: **TypeScript 단일 언어**로 만든 최소 코어를 후보 플랫폼·조합에서 돌려 플랫폼과 TS 런타임을 고른다. 언어 선택(Python vs TS)은 0016에서 이미 TS로 확정됐으므로 다시 묻지 않는다.
- **할 일**
  - [ ] `spikes/web0/ts-core/`에 TypeScript 최소 명령 서비스·라우터·DTO·오류 봉투·D1/SQLite 어댑터를 둔다. `spikes/web0/package.json`에 `test`·`typecheck`·`measure`를 둔다(WEB1의 `web/package.json`과 분리). **PR1 전에 실행하며 PR4·13 산출물을 기다리지 않는다.**
  - [ ] **현재 JSON fixture** `docs/plan/fixtures/api-v1/` 38개를 읽기 전용으로 써서 `capabilities`·`context`·`versions`·`claims`·`results`·`wait`·`complete`와 가능한 확장 경로를 시험한다. PR4·13이 나중에 만들 픽스처를 선행으로 두지 않는다.
  - [ ] 후보 X(Cloudflare 중심), Y(VPS 중심), Z(Vercel+외부 무료)를 같은 합성 시나리오로 비교하고, TS 런타임 Node LTS·Bun·Deno를 같은 계약으로 시험한다.
  - [ ] Cloudflare Workflows **instance당 subrequest 50**·step 1,024·CPU 10ms, D1 batch, DO WebSocket hibernation·**20:1 과금 계산**, Vercel 300초·WS 최대 함수 시간, R2/Blob 한도를 측정한다.
  - [ ] Oracle 공식 수치(1,500 OCPU-h·9,000 GB-h/월=상시 2 OCPU·12GB, 7일 CPU p95·네트워크·A1 메모리 20% 미만 회수, 지역 재고)와 Hetzner **월 총액 미확인/WEB0 견적**을 확인한다.
  - [ ] **A의 HWPX를 사용자 PC 없이** 서버측 변환 작업자/브라우저 변환으로 처리하는 경로를 후보별로 확인한다.
  - [ ] Go 주소·모델 목록·billing source/allowance/cost·웹 사용량 계기를 후보로 표시하고, `/inference/openai|anthropic|google`·`/inference/v1/models`를 우선 검증한다.
  - [ ] 결과를 `docs/plan/decisions/0005-web-platform.md`·`0016-core-language.md`에 측정값·확인일·탈출 조건으로 남긴다.
- **선행**: **2단계 PR1 전**(5단계 착수 전). PR4·13을 선행으로 두지 않는다.
- **완료 기준**
  - [ ] `npm --prefix spikes/web0 run test -- --run`
  - [ ] `npm --prefix spikes/web0 run typecheck`
  - [ ] 38개 fixture parse/validate, core 경로 normal/error/replay, D1/SQLite 원자성·0행 CAS·deferred FK·부분 UNIQUE·10진 문자열 왕복이 통과한다.
  - [ ] 후보별 CPU·메모리·subrequest·D1·R2·DO·Vercel·VPS 측정표와 A HWPX 경로 결과가 있다.
  - [ ] Oracle 공식 수치·지역 재고, Hetzner 월 총액 미확인, 유료 안 비용 승인 필요가 기록된다.
  - [ ] 결정 기록과 WEB1~14 인계(플랫폼별 부품 치환)가 있다.
- **지킬 것**: TS 단일 언어를 다시 선택받지 않는다. Python Workers·Python 서버를 후보로 되돌리지 않는다. 유료 계정을 쓰지 않는다. 실제 자료를 올리지 않는다. 계약을 구현에 맞춰 바꾸지 않는다.

## WEB1 — 웹 실행 골격·배포

### [5단계] 웹 실행 골격·Free 배포 — Worker·Assets·D1·R2

- **목표**: **WEB0에서 고른 플랫폼의 기준 구현**으로 staging/prod, DB, 파일, 마이그레이션, CI, 헬스체크가 도는 최소 골격을 만든다. Cloudflare를 고르면 Free Worker·D1·R2 기준이고, Vercel/VPS를 고르면 같은 계약의 해당 부품으로 치환한다. 유료 안은 비용 승인 뒤 그 예산으로 시험한다.
- **할 일**
  - [ ] `web/package.json`에 `test`·`test:e2e`·`db:migrate:local`·`deploy:staging`·`check:deploy` 스크립트를 둔다.
  - [ ] `web/wrangler.toml`에 `env.staging`·`env.production`, D1 바인딩, R2 바인딩, Assets, `compatibility_date`를 둔다.
  - [ ] `web/src/worker.ts`(진입), `web/src/app.ts`(라우터), `web/src/routes/health.ts`, `web/src/config/capabilities.ts`, `web/src/config/flags.ts`(기능 플래그), `web/src/db/d1.ts`를 만든다.
  - [ ] **A HWPX 변환 실행 경계**: WEB0가 고른 **서버측 작업자/브라우저 변환** 경로의 바인딩·큐·컨테이너 자리를 마련하고, 실제 변환은 6단계 X1에 맡긴다. 사용자 PC 없이 호출 가능한지 확인하고, 불가능하면 WEB0 결정을 사용자에게 올린다.
  - [ ] `web/migrations/`에 **2~4단계 마이그레이션 체인**을 둔다. `0001_init.sql`은 현재 DDL **61표**(`project_references`·`file_policies` 포함)를 넣고, S4-PR23/25의 `edition_carryovers`·`completed_snapshot_id`·workspace 설정·편집 허가 등 4단계 확장 표·열을 별도 번호로 적용하며, 기존 프로젝트의 `db_meta.schema_version`을 포함한다. `docs/plan/schemas/check_ddl.py`(PR26 전 한시 보존 설계 검사기)의 검사 항목을 로컬 SQLite와 D1 smoke에 함께 적용하고, 웹 측 검사는 `web/scripts/check-schema.mjs`로 둔다. 표 수 기준은 현재 DDL 61표이며 5단계 시작 시 다시 확인한다.
  - [ ] `web/src/services/commands.ts`에 2단계 PR4 명령 서비스의 D1 구현 경계를 둔다. rev·멱등·0행 실패·뒤늦은 실패 전체 롤백·큰 정수 문자열·커서·공개 DTO를 같은 의미로 시험하고, D1 batch 원자성·deferred FK·부분 인덱스·JSON 함수 경계를 명시한다.
  - [ ] `.github/workflows/web-ci.yml`(매 PR+main, Windows+macOS)과 `web-deploy.yml`(main→staging, 태그→prod 수동 승인)을 만든다.
  - [ ] `GET /healthz`가 `SELECT 1`·R2 HEAD·`db_meta.schema_version`을 확인하게 한다.
  - [ ] 25초 long poll 구현 선택(DO/짧은 폴+ETag/SSE)을 `docs/plan/decisions/0005-web-platform.md`에 적고, Free 요청·CPU·subrequest 한도를 계측한다. DO를 고르면 요청·벽시계 실행량·저장 예산을 WEB12 계측에 넘긴다.
  - [ ] R2 버킷 활성화에 결제 수단이 필요한지 Free 계정에서 확인해 기록하고, 필요하면 6절 사용자 결정으로 올린다. R2 무료 포함량 초과는 과금될 수 있으므로 $0 보장으로 쓰지 않는다.
- **선행**: PR 1·2·4·13·14·18·U1, WEB0.
- **완료 기준**
  - [ ] `npm --prefix web run test -- --run`
  - [ ] `npm --prefix web run db:migrate:local`
  - [ ] `npm --prefix web run check:deploy`
  - [ ] 결정 뒤 확정할 TS 테스트 명령(코어 계약)
  - [ ] staging에서 실제 D1로 읽기 화면이 뜨고, 이전 버전 롤백 1회·시크릿 스캔·100k 요청/일·10 ms CPU·subrequest 50·정적 자산 20,000개·Cron 5개 smoke가 통과한다.
  - [ ] D1 batch 원자성·0행 실패·deferred FK·부분 인덱스·JSON 함수 smoke가 로컬 SQLite와 D1에서 통과한다.
  - [ ] 2~4단계 마이그레이션 체인(S4-PR23/25 확장 포함)과 기존 프로젝트 `schema_version` 적용이 로컬 SQLite·D1에서 통과한다.
  - [ ] **A HWPX 변환 작업자를 붙일 실행 경계**가 있고 사용자 PC 없이 호출 가능하거나, 불가능이 사용자 결정으로 기록된다.
  - [ ] 기능 플래그 on/off가 capabilities·라우트에 반영되고, 미지원 기능은 가짜 성공 없이 미지원으로 표시된다.
- **지킬 것**: 공개 prod 전환은 WEB14 게이트 뒤에 한다. 유료 기능에 의존하지 않는다. 이중 쓰기·가짜 성공·`SELECT *` 전체 스캔을 넣지 않는다. 비밀은 Worker/GitHub Environment secret에만 둔다.

## WEB2 — 사람 로그인·세션

### [5단계] 사람 로그인·세션 — 매직링크·패스키·step-up

- **목표**: D1 기반 사람 인증과 `__Host-` 세션, 브라우저 step-up, 기기 승인을 붙인다.
- **할 일**
  - [ ] `web/migrations/0002_auth.sql`에 `auth_accounts`·`auth_sessions`·`auth_passkeys`·`email_verifications`·`project_invites`·`device_tokens`·`recovery_codes`·`auth_audit`를 만든다.
  - [ ] Better Auth 버전을 고정하고 D1 어댑터·추가 인증 표·PES `users` 매핑을 실제로 검증한다.
  - [ ] `web/src/services/auth.ts`·`sessions.ts`·`passkeys.ts`·`invites.ts`·`device-flow.ts`를 만든다. PES `users`를 정본으로 두고 `users.auth_subject`에 `provider:subject`를 매핑한다.
  - [ ] `web/src/routes/auth.ts`에 `/login`·`/auth/magic-link`·`/auth/passkey/*`·`/auth/device/*`·`/logout`을 만든다. `web/src/views/auth/*`에 로그인·초대 수락·복구 화면을 두고, `web/src/views/settings/security.ts`에 기기 목록·모든 기기 로그아웃을 둔다.
  - [ ] `web/src/middleware/session.ts`에 `__Host-pes_session`(HttpOnly·Secure·SameSite=Lax·Path=/)와 절대 14일·유휴 7일 회전을 넣는다.
  - [ ] `web/src/middleware/stepup.ts`에 `requireStepUp(action, targetRev)`를 둔다. 승인·reopen·판 시작·정책·토큰·삭제·데이터 내보내기는 5분 내 브라우저 재인증과 snapshot/rev 확인을 요구한다.
  - [ ] `src/cli/pes.ts`에 `cmd_login`과 `CMDS["login"]`을 추가하고, `src/cli/credentials.ts`로 Windows Credential Manager/macOS Keychain에 기기 토큰을 저장한다. `main()`의 인자 처리도 맞춘다.
  - [ ] 세션 검증의 p95 CPU를 측정한다. 10 ms를 넘으면 HMAC 경량 쿠키+D1 1행으로 줄이고, 그래도 넘으면 9절 전환 신호로 기록한다.
  - [ ] `auth_audit`에 로그인·실패·재인증·기기 회수·복구 코드 사용을 남긴다.
- **선행**: WEB1, PR 4.
- **완료 기준**
  - [ ] 결정 뒤 확정할 TS 테스트 명령 (login·stepup)
  - [ ] `npm --prefix web run test -- --run test/auth`
  - [ ] `npm --prefix web run test:e2e -- auth.spec.ts`
  - [ ] 로그인·만료·고정·회전·재인증·복구 코드 1회·CLI 기기 회수 즉시 401·기기 목록·모든 기기 로그아웃이 통과한다. 다른 프로젝트 접근은 거부되고, step-up은 기기 토큰으로 대행할 수 없다.
- **지킬 것**: 승인류는 사람만 한다. 에이전트·MCP·기기 토큰이 step-up을 대신하지 못한다. 이메일 존재 여부를 노출하지 않는다. 실제 메일 주소·실자료를 fixture에 넣지 않는다.

## WEB3 — 멤버·초대·역할

### [5단계] 프로젝트 멤버·초대·역할 — owner/editor/reader

- **목표**: `project_members` 역할 모델과 **프로젝트 생성·최초 등록**, 초대·해제·소유권 이전을 서버 권한으로 완성한다.
- **할 일**
  - [ ] `web/src/routes/projects.ts`·`web/src/views/projects/new.ts`에 **프로젝트 생성 화면**을 두고 `POST /api/v1/projects`(PR13)로 owner·초기 정책·첫 판 bootstrap을 **한 tx**로 만든다.
  - [ ] `web/src/routes/registrations.ts`·`web/src/views/projects/register.ts`에 **최초 등록 화면**을 두고 `POST /api/v1/project-registrations`(PR14)로 B skill이 만든 프로젝트를 등록한다. 프로젝트 토큰이 없는 최초 등록은 **기기 승인 자격**으로 인증하고, 일반 에이전트 토큰은 owner·정책을 우회하지 못한다. 중복 slug·멱등 키·재생 응답을 처리한다.
  - [ ] `web/src/services/members.ts`에 멤버 추가·역할 변경·제거·초대·철회·소유권 이전을 둔다.
  - [ ] `web/src/routes/members.ts`와 `web/src/views/settings/members.ts`를 만든다.
  - [ ] `projects.owner_user_id`와 `project_members`의 owner 행이 항상 일치하도록 소유권 이전을 한 tx로 만든다. `one_project_owner` 부분 UNIQUE를 유지한다.
  - [ ] `web/migrations/0003_ownership.sql`(로컬 SQLite는 2단계 PR1 경로)에 과거 `project_policy_versions.changed_by_user_id`의 작성자·당시 소유자 증거를 보존하는 FK/소유권 이력 변경을 둔다. 옛 정책 작성자를 새 owner로 덮어쓰지 않는다. 1단계 DDL의 FK를 직접 고치지 않고 새 마이그레이션으로 해소한다.
  - [ ] `web/src/auth/permissions.ts`에 owner/editor/reader 권한 매트릭스를 두고, 승인·reopen·판 시작·정책·토큰·삭제·멤버 변경은 owner만 허용한다. 이 매트릭스를 WEB5 `web/src/services/grants.ts`의 MCP/OAuth scope 정책과 공유한다.
  - [ ] 초대는 이메일 1회용 7일, 역할 지정, 철회 가능. 수락 시 `users`·`auth_accounts`·`project_members`를 한 tx로 만든다.
  - [ ] 역할 변경·회원 제거 시 해당 사용자의 세션·OAuth 위임·에이전트 자격·예약 알림을 무효화하거나 재검사한다. 멤버 변경·초대·철회를 `auth_audit`·`events`에 남긴다.
  - [ ] `web/src/services/notifications.ts`의 발송 직전 권한 재검사 훅과 연결한다.
- **선행**: WEB2, PR 10.
- **완료 기준**
  - [ ] 결정 뒤 확정할 TS 테스트 명령 (members)
  - [ ] `npm --prefix web run test -- --run test/members`
  - [ ] `npm --prefix web run test:e2e -- members.spec.ts`
  - [ ] 역할별 허용·거부 표 전 항목, 마지막 owner 제거 거부, owner 이전 원자성, editor 승인 불가, editor 답이 lease에 막히지 않음, MCP/OAuth scope 정책 일치, 멤버 변경 감사 기록이 통과한다.
  - [ ] **빈 계정·새 프로젝트 생성과 재등록, owner·초기 정책·첫 판 원자성, 중복 slug·멱등·재생, 기기 승인 없는 최초 등록 거부, 에이전트 토큰의 생성·등록 우회 거부**가 통과한다.
  - [ ] 초기 정책이 있는 합성 프로젝트에서 소유권 이전 전후 FK·권한·과거 정책 작성자/시각 불변이 통과하고, 이전 뒤 새 정책만 새 owner를 쓴다.
- **지킬 것**: UI 숨김으로 권한을 대신하지 않는다. owner 없는 프로젝트를 만들지 않는다. 에이전트 키로 멤버·역할을 바꾸지 못한다. 회원 제거 뒤 알림·OAuth가 남지 않는다. 6단계 M1은 이 소유권 이전·이력 마이그레이션을 다시 구현하지 않고 WEB3를 재사용한다.

## WEB4 — 에이전트 키 운영

### [5단계] 에이전트 키 발급·회수·교체 — 30일·scope·pepper

- **목표**: 프로젝트 범위 에이전트 토큰의 발급·회수·교체·감사를 운영 가능한 형태로 만든다.
- **할 일**
  - [ ] `web/migrations/0004_agent_tokens.sql`에 `agent_tokens`의 `label`·`token_prefix`·`last_used_at`·`last_used_ip`·`created_by_user_id`·`pepper_version`을 nullable로 추가하고, `agent_devices`(project_id·device_id·label·last_seen_at·revoked_at)를 만든다.
  - [ ] `web/src/auth/scopes.ts`에 `stage-5.md` 2.3의 **scope×명령×MCP 도구 표를 단일 명세로 링크**하고, 그 표의 전수 목록을 구현한다. 아래 축약 목록은 대체 목록이 아니다: `context:read`·`inputs:read`·`changes:read`·`version:read`·`run:claim`·`run:heartbeat`·`run:wait`·`run:complete`·`run:cancel`·`run:release`·`run:handoff`·`result:submit`·`question:ask`·`question:revise`·`answer:self`·`thread:write`·`thread:resolve`·`followup:propose`·`followup:apply`·`assumption:propose`·`decision:propose`·`reflection:write`·`objection:raise`·`edit:propose`·`input:receipt`·`file:upload`·`file:read`·`round:write`.
  - [ ] `web/src/services/tokens.ts`에 `pes_<prefix>_<base64url>` 생성, `HMAC-SHA256(pepper, token)` 저장, prefix 조회, 상수 시간 비교, 30일 만료, 회수, 24시간 교체, 긴급 회수, pepper 회전을 둔다.
  - [ ] `web/src/routes/tokens.ts`와 `web/src/views/settings/tokens.ts`를 만든다. 원문은 발급 응답에서 한 번만 보여 준다.
  - [ ] `web/src/middleware/rate-limit.ts`에 토큰별 60 req/min과 heartbeat·중단·상태 확인 별도 예산을 둔다.
  - [ ] `web/src/services/leases.ts`와 연결해 회수 뒤 새 claim·submit은 401, 살아 있는 lease는 TTL 만료 뒤 `interrupted`가 되게 한다.
  - [ ] `src/cli/pes.ts`에 `cmd_token`(발급·목록·회수·교체)과 `CMDS["token"]`을 추가한다.
  - [ ] 발급·회수·첫 사용·교체를 `events`와 `auth_audit`에 남긴다.
- **선행**: WEB2·WEB3, PR 10.
- **완료 기준**
  - [ ] 결정 뒤 확정할 TS 테스트 명령 (tokens)
  - [ ] `npm --prefix web run test -- --run test/tokens`
  - [ ] 회수 즉시 401, lease 만료 뒤 `interrupted`, 원문이 DB·로그·에러·URL·프롬프트에 0건, scope별 허용·거부, 교체 중 무중단, 긴급 회수 겹침 없음, 기기 목록·회수가 통과한다.
  - [ ] `stage-5.md` 2.3 표의 scope×명령×MCP 도구 전수에 대해 허용/거부 계약 시험이 통과하고, 승인·reopen·정책·토큰·삭제·멤버·외부 export scope가 존재하지 않는다.
- **지킬 것**: 발급·회수는 owner 사람만 한다. 기기 단위 토큰을 만들지 않는다. 승인·reopen·정책·토큰·삭제 scope를 만들지 않는다. 토큰을 모델 프롬프트에 넣지 않는다.

## WEB5 — 원격 MCP·OAuth

### [5단계] 원격 MCP·OAuth — Claude Code·Claude 앱·Codex CLI·OpenCode TUI 연결

- **목표**: 공개 HTTPS의 `/mcp`와 OAuth 2.1로 방식 B 여섯 경로(Claude Code, Claude 앱, Codex CLI, OpenCode TUI, Codex 앱, OpenCode 앱)가 같은 PES API에 붙고, 기존 로컬 어댑터도 웹 인증·전송에서 회귀하지 않게 한다. Codex/TUI·Codex 앱/OpenCode 앱은 각각 2단계 PR20b·20c에서 이미 지원하며, 5단계가 처음 지원하는 단계가 아니다.
- **할 일**
  - [ ] `web/migrations/0005_oauth.sql`에 `oauth_clients`·`oauth_grants`·`oauth_access_jti`·`oauth_refresh_tokens`·`oauth_consents`를 만든다.
  - [ ] `web/src/mcp/server.ts`와 `web/src/mcp/tools.ts`에 `stage-5.md` 2.3의 **MCP 도구 전수 표**를 구현한다. 최소 `pes_context`·`pes_claim`·`pes_submit`·`pes_ask`·`pes_wait`·`pes_complete`·heartbeat·release·cancel·입력/결과 영수증·`pes_projects`에 더해 질문 수정·자기 답·첨언/해결·후속·가정/결정/반영·반대·편집 제안·handoff 도구를 포함하고, 축약 목록으로 대체하지 않는다.
  - [ ] `web/src/oauth/provider.ts`에 OAuth 2.1 metadata·PKCE·resource/audience·정확한 redirect URI·state를 둔다. DCR은 rate limit·허용 목록·동의로 제한한다.
  - [ ] `web/src/routes/oauth.ts`, `web/src/views/oauth/consent.ts`, `web/src/views/settings/connected-apps.ts`를 만든다. 동의 화면에 수신자·프로젝트·자료 범위·동작·철회를 표시한다.
  - [ ] `web/src/services/grants.ts`에 scope = 동의 ∩ 현재 `project_members` ∩ 에이전트 제한 검사를 둔다. 동의 뒤 새 프로젝트로 자동 확장하지 않는다.
  - [ ] 액세스 토큰 `jti`를 매 요청 D1에서 검사해 연결 해제 즉시 401이 되게 한다. refresh 회전·재사용 거부를 넣는다.
  - [ ] Cloudflare OAuth Provider의 KV 의존을 확인하고, KV 읽기/쓰기/저장 사용량을 WEB12 계측에 연결한다. KV Free 한도가 미확인인 상태를 "포함량 준수"로 쓰지 않는다.
  - [ ] `pes_submit`은 run 결과 제출이고 사람 답 `submissions`와 분리한다. MCP는 사람 답 제출을 대행하지 않되 자기에게 온 질문 답은 `pes_self_answer`로 허용한다.
  - [ ] `docs/operations/mcp-connect.md`에 Claude 앱 커스텀 커넥터, Claude Code `claude mcp add --transport http`, Codex CLI·OpenCode TUI의 기존 MCP/HTTP bridge 재사용, Desktop/stdio·CLI 지원 수준과 한계를 적는다. 새 어댑터 이슈를 만들거나 Codex/TUI 첫 지원을 6단계로 되돌리지 않는다.
- **선행**: WEB2·WEB3·WEB4, PR 13·14·20a·20b·20c.
- **완료 기준**
  - [ ] `npm --prefix web run test -- --run test/mcp test/oauth`
  - [ ] `npm --prefix web run test:e2e -- mcp.spec.ts`
  - [ ] 합성 프로젝트 1라운드 왕복, 도구 호출 10초 내 응답, Free 10 ms CPU·subrequest 50 측정, 승인·정책·토큰·사람 답 제출 도구 없음, wrong-project·중복 제출 거부, 연결 해제 401이 통과한다.
  - [ ] `stage-5.md` 2.3 표의 MCP 도구 전수와 scope가 일치하고, `pes_self_answer`를 포함한 자기 질문 답 경로가 허용되며 승인류는 계속 거부된다.
  - [ ] Claude 앱 커넥터, Claude Code HTTP MCP, Codex CLI·OpenCode TUI의 기존 bridge를 실제로 연결해 재접속·만료·회수·인계·옛 결과 거부를 확인하고, Desktop/stdio·CLI 지원 수준을 문서와 대조한다. 네 경로가 같은 actor·권한·오류 의미를 쓰는지 교차 시험한다.
- **지킬 것**: OAuth 위임은 사람 세션이 아니다(`actor.kind=external_agent`, `on_behalf_of_user_id`). 승인·reopen·정책·토큰·삭제를 노출하지 않는다. 토큰을 모델에 넣지 않고, 연구 자료는 데이터로만 취급한다.

## WEB6 — 웹 A 실행기(Workflows) 골격

### [5단계] 웹 A 실행기 — Workflows step·상태·claim

- **목표**: A를 로컬 runner 없이 Cloudflare Workflows에서 실행할 골격을 만든다. 모델 호출 1회를 step 1개로 두고, step 사이 상태를 D1에 남겨 이어 간다.
- **할 일**
  - [ ] `wrangler.toml`에 Workflows 바인딩, `web/src/workflows/a-run.ts`에 실행 정의·step 분할·재시도·멱등 키를 둔다.
  - [ ] **모델 호출 1회=step 1개**, step 안에서는 응답 검증·결과 저장만. **subrequest 50은 instance 전체 총량**이며 step 추가로 초기화되지 않는다. instance 예산에 닿기 전에 상태를 저장하고, 새 instance로 이어 갈 때 **새 claim/fence**와 이전 Go 사용량·unknown·외부 호출 멱등·attempt 상관키를 이어 받는다.
  - [ ] `web/src/services/leases.ts`에서 PR5의 claim·lease·fence를 재사용해 Workflow가 원자적으로 run을 가져가게 한다.
  - [ ] `waiting_human`에서는 인스턴스를 붙잡지 않고, 답이 오면 새 인스턴스로 재개한다.
  - [ ] 3일 보존 만료·step 실패·동시 인스턴스 100을 "상태 미상/재시도"로 표시하고 자동 재개하지 않는다.
  - [ ] 무거운 HTML·인쇄 렌더링을 step 밖(브라우저 또는 별도)으로 보낸다.
  - [ ] Go 키는 Worker secret에서만 읽고 로그·응답에 넣지 않는다.
- **선행**: WEB1, PR 5·19.
- **완료 기준**
  - [ ] `npm --prefix web run test -- --run test/workflow`
  - [ ] `npm --prefix web run test:e2e -- a-workflow.spec.ts`
  - [ ] 합성 run을 Workflow에서 시작·재개·완료, **step CPU 10 ms·step 1,024·instance당 subrequest 50** 안에서 6단계 각 단계 1라운드.
  - [ ] step 추가와 instance 교체를 구분하고, **instance 교체가 Go 사용량·unknown·외부 호출 멱등·attempt 상관키를 초기화하지 않는지** 시험한다.
  - [ ] step 실패 재시도가 중복 결과를 만들지 않음, 3일 만료를 "상태 미상"으로 표시, 인바운드·로컬 runner 0.
- **지킬 것**: 웹은 로컬 runner로 접속하지 않는다. step 안에서 무거운 렌더링을 하지 않는다. 3일 만료를 자동 재개로 숨기지 않는다.

## WEB7 — A 에이전트 루프·도구·사용량

### [5단계] A 에이전트 루프 — Go 직접 호출·PES 도구·사용량

- **목표**: Workflows 위에서 PES가 Go API를 직접 호출하고, 맥락→호출→JSON 검증→업무 명령 저장→질문→재개를 돌린다. 모델 도구는 PES 명령만 둔다.
- **할 일**
  - [ ] `web/src/services/go-client.ts`에 **Go 주소 후보**(`/inference/openai|anthropic|google`, 모델 목록 `/inference/v1/models`; `/inference/go/...`·`/go/v1/models`는 후보), 원시 model ID↔내부 ID 매핑, 모델별 OpenAI/Anthropic/Google 형식, PES user agent, 시간 초과를 둔다. provider=`opencode-go`·폴백 금지는 유지한다.
  - [ ] **호출 시도·멱등(F07)**: 호출 **전에** 영속 attempt·상관키를 남기고 `prepared → sent → response → adopted`와 `unknown`을 구분한다. DDL의 `outbound_dispatches.id`=attempt, `request_key`=상관키, `state=response|adopted|unknown`을 쓴다. **응답 유실은 `unknown`이며 자동 재호출하지 않는다.** `x-opencode-session`은 라우팅·캐시용일 뿐 멱등 보장이 아니다. **모델 호출 재시도와 로컬 저장 재시도를 분리**하고, 가짜 Go 서버로 호출 횟수·재시도·unknown 처리를 시험한다. 외부 멱등/조회 API가 확인되기 전에는 unknown을 사람이 정산한다.
  - [ ] `web/src/workflows/a-loop.ts`에 맥락 조립·JSON 스키마 검증·기존 명령 서비스 저장·`ask`/`waiting_human`·답 오면 재개를 둔다.
  - [ ] `web/src/services/a-tools.ts`에 **맥락 읽기·결과 제출·질문과 U3/U4 제안(`assumption.propose`·`decision.propose`·`reflection.write`·`thread.reply`·`followup.propose`)만** 노출. 파일·셸·임의 네트워크 도구 없음. `decision.propose`는 B scope `decision:propose`/`pes_decision`과 같은 명령이며, 결정 채택·승인은 사람만 한다. 자료 속 지시를 따르지 않는다.
  - [ ] `web/src/services/go-usage.ts`에 **계정/워크스페이스 사용률 기준점**, 호출별 토큰 집계·월/주/5시간 한도 대비 추정·90% 문턱·한도 오류·billing source/allowance/cost 구분·unknown fail-closed를 둔다. **Extra Usage OFF 확인 증거·유효 기간**을 남기고 확인 불가면 차단한다. 다음 호출 최대 출력·병렬 호출 예약·재시도/인계/재시작 누적을 같은 계기에 넣는다. 사용량 API가 확인되면 우선하고, 없으면 수동 확인 경로를 둔다.
  - [ ] **사용량 차단 상태(F13)**: `runs.status=blocked_usage`와 `go_block_reason`·`go_blocked_at`·`go_block_reset_at`(DDL 묶음이 정한 이름)을 사용하고, **`waiting_human`(질문·입력 대기)과 같은 상태로 쓰지 않는다**. 사유 없는 차단과 `waiting_human`+Go 사유를 거부하고, reset 시각 미확인은 0/추정값이 아니라 "미확인"으로 표시한다. 응답 도착만으로 자동 진행하지 않고 C4/R1 준비·정책·새 claim 검사를 거쳐 사람이 재개한다.
  - [ ] `web/src/services/policy.ts`에서 **호출마다** 현재 Go 정책·버전·자료 범위를 검사한다.
  - [ ] 모델 선택: 프로젝트 정책·run 시작 시 `opencode-go/*` active 목록에서 하나, `runs.model` 기록, 폴백 없음. 부모만 채택·자식 대기 전파·reviewer 별도 run.
  - [ ] `web/src/views/runs/execution.ts`에 최소 실행 상태·차단 이유·`resetsAt`·마지막 확인을 표시한다.
- **선행**: WEB6, PR 19·21, WEB12 Go 사용량 문턱.
- **완료 기준**
  - [ ] `npm --prefix web run test -- --run test/a-loop test/go-client test/go-usage`
  - [ ] `npm --prefix web run test:e2e -- a-flow.spec.ts`
  - [ ] 6단계 각 단계 1라운드, **step 10 ms 안에서 응답 검증·저장** p95, 안 되면 step 분할.
  - [ ] 프롬프트 주입 무시, JSON 위반 거부, 키·모델 로그 0건, OFF 호출별 차단, 추정 90%·한도 오류·billing source/allowance/cost 표시에서 멈춤, 부모 대기 전파.
  - [ ] Go 주소 후보·원시 model ID↔내부 ID·`cost=0`과 billing source/allowance 구분, Extra Usage OFF 확인 불가 시 차단, 계정/워크스페이스 기준점·다음 호출 최대 출력·병렬 예약·unknown 영속이 시험된다.
  - [ ] **가짜 Go 서버로 호출 횟수·응답 유실 unknown·자동 재호출 금지·모델 호출/로컬 저장 재시도 분리**가 시험된다.
  - [ ] **사유 없는 `blocked_usage` 거부, `waiting_human`+Go 사유 거부, 정상 차단·reset 미확인 표시, 응답 도착만으로 자동 진행 금지, 재개 시 C4/R1 준비·정책·새 claim 검사**가 통과한다.
- **지킬 것**: 폴백 모델·자동 B 전환·자식 채택을 넣지 않는다. 파일·셸 도구를 넣지 않는다. unknown을 미전송으로 보지 않는다. 이미 나간 자료의 회수를 보장하지 않는다고 표시한다.

## WEB8 — 알림

### [5단계] 알림 — 메일·Web Push·outbox

- **목표**: 사람이 행동해야 하는 사건을 메일과 휴대폰 푸시로 보내되, 연구 내용을 본문에 싣지 않는다.
- **할 일**
  - [ ] `web/migrations/0008_notifications.sql`에 `notification_outbox`·`notification_endpoints`·`notification_preferences`·`notification_deliveries`를 만든다.
  - [ ] `web/src/services/notifications.ts`가 업무 변경과 같은 tx에 outbox를 쓰게 한다. `web/src/workers/notify.ts`가 Queue/Cron에서 읽어 발송한다.
  - [ ] `web/src/services/email.ts`에 Resend(3,000통/월·100통/일), `web/src/services/push.ts`에 VAPID를 둔다.
  - [ ] `web/public/manifest.webmanifest`와 `web/public/sw.js`(또는 `web/src/sw.ts`)에 PWA·푸시 구독·`pushsubscriptionchange`를 넣는다.
  - [ ] `web/src/routes/push.ts`, `web/src/views/settings/notifications.ts`에 채널·조용한 시간·상세 제목 선택을 둔다.
  - [ ] `web/src/services/notify-policy.ts`에 `waiting_human`과 승인 대기를 별도 사건으로, **내부 outbox 중복 방지** `dedupe_key=endpoint+event_seq+event_type`, 5분 묶음, 22:00~08:00 KST, 발송 직전 권한 재검사를 넣는다. 내부 접수 중복 0과 외부 provider 도달/중복은 별도로 시험한다.
  - [ ] 기본 본문은 프로젝트명 없이 일반 문구+로그인 링크만. 로그인 뒤 정확한 버전 딥링크로 이동한다. 질문 문구·연구 내용·파일명은 넣지 않는다.
  - [ ] `notification_deliveries`에 provider 영수증·unknown·재시도를 남기고, Queues 24시간 보존 안에 재시도를 끝낸다. provider 멱등 키·확인 가능한 영수증·unknown 재조회/재전송 조건을 정하고, 확인할 수 없으면 자동 재전송을 멈추거나 외부 중복 가능성을 명시한다. 24시간 경과를 무조건 unknown으로 바꾸지 않는다.
- **선행**: WEB1·WEB2·WEB3, PR 14.
- **완료 기준**
  - [ ] 결정 뒤 확정할 TS 테스트 명령 (notifications)
  - [ ] `npm --prefix web run test -- --run test/notifications`
  - [ ] `npm --prefix web run test:e2e -- notifications.spec.ts`
  - [ ] 적격 사건 enqueue·발송 시도, 내부 outbox 중복 0, provider 영수증·unknown 재조회/재전송 조건, 로그인 뒤 정확한 버전 딥링크, iOS 홈화면 PWA 푸시, 미설치·거부 대안, 실패 UI·unknown, 발송 직전 권한 재검사, 복원·import 뒤 재발송 0이 통과한다.
- **지킬 것**: 도착·외부 정확히 1회를 보장하지 않는다. 내부 접수 중복 0과 외부 도달/중복을 같은 것으로 표시하지 않는다. SMS를 쓰지 않는다. 연구 내용·프로젝트명을 기본 본문에 넣지 않는다. 과거 사건을 새 알림으로 재발송하지 않는다.

## WEB9 — 로컬→웹 이전

### [5단계] 로컬→웹 이전 — 번들·staging import·cutover

- **목표**: 프로젝트 하나를 동결·번들·검증·활성화하는 한 방향 이전을 만들고, 실패하면 로컬로 돌아가게 한다.
- **할 일**
  - [ ] `web/migrations/0009_import.sql`에 `import_tokens`·`import_chunks`를 추가하고, 기존 `import_batches`·`legacy_mappings`를 재사용한다. 로컬 전용 `local_export_state`(project_id·exported_at·bundle_hash·state)는 로컬 SQLite 마이그레이션(2단계 PR1 경로)에 둔다.
  - [ ] S4-PR23/25의 `edition_carryovers`·`completed_snapshot_id`·workspace 설정·편집 허가를 가진 합성 프로젝트의 이전·검증·복원·다른 프로젝트 무영향 사례를 만든다. **`file_policies.id`와 이를 참조하는 `version_files.file_policy_id`·`file_ai_access_versions.file_policy_id`·`file_extractions.source_file_policy_id`/`text_file_policy_id` 이력, `project_references`의 A-only 이전·`source_missing` tombstone**도 포함한다.
  - [ ] `web/src/routes/imports.ts`에 `POST /imports`·`POST /imports/{id}/complete`·`POST /imports/{id}/activate`를 만든다. `web/src/services/import.ts`와 `web/src/workflows/import.ts`가 청크·재개·검증을 맡는다.
  - [ ] `src/cli/pes.ts`의 `export --bundle`·`import`를 확장하고, `cmd_export`·`cmd_import`·`CMDS`에 `web-import`를 추가한다. `src/cli/bundle.ts`에 manifest·sha256·int64 문자열 검사를 두고, **2^53 초과 정수**(예: `9007199254740993`)와 인접 rev/fence가 export→import→복원에서 구분되는지 검사한다. `skills/`의 `pes` 호출을 웹 API로 바꾸는 어댑터 경계를 둔다(2단계 PR15·16의 전송만 교체).
  - [ ] `web/src/services/bundle.ts`가 R2 멀티파트 업로드·서명된 업로드 URL·sha256 검증·`blobs.state='ready'`·`version_files` 연결을 하게 한다.
  - [ ] `web/src/routes/files.ts`와 `web/src/services/files.ts`에 사람용 짧은 서명 URL·프로젝트 검사, Go/에이전트용 정책 프록시를 둔다.
  - [ ] 1시간 1회 `import_tokens`(owner 발급, step-up)로 CLI 업로드 인증. 에이전트 키로는 가져올 수 없게 한다.
  - [ ] `web/src/views/import/wizard.ts`와 `report.ts`에 동결·미리보기·검증 보고서·활성화·롤백을 둔다.
  - [ ] 청크는 D1 바인딩 100·SQL 100KB·행 2MB·호출당 쿼리 50에 맞춘다. Workflows 3,000 step/일을 넘는 **실제 import**는 승인된 로컬·비공개 실행 주체로 옮기고, 공개 CI는 합성 검증만 한다. GitHub Actions를 쓰려면 실행 계정·runner·목적·보존/삭제·원문 로그/캐시/artifact 금지·권한을 별도 변경안으로 먼저 승인받은 뒤에만 쓴다.
- **선행**: WEB1·WEB2·WEB3, PR 3·9·11·12·15·16·17.
- **완료 기준**
  - [ ] 결정 뒤 확정할 TS 테스트 명령 (bundle·import)
  - [ ] `npm --prefix web run test -- --run test/import`
  - [ ] `npm --prefix web run test:e2e -- import.spec.ts`
  - [ ] 2MB JSON·깨진 참조·이미지 합성 이전, 서명 업로드, 중단 후 재개, FK/순환·ID 충돌·중복 영수증, 부분 적재 비표시, 활성화 응답 유실 시 자동 해제 금지, 쓰기 전/후 롤백, 프로젝트 단위 복원, 활성화 뒤 로컬 쓰기 0건, 스킬 웹 API 경계가 통과한다.
  - [ ] **2^53 초과 정수**(`9007199254740993` 등)와 인접 rev/fence/event_seq가 export→import→복원 뒤에도 구분되고, 손실이 발견된 백업은 유효 복원본으로 채택하지 않는다.
  - [ ] S4-PR23/25 확장 데이터(이월·완료·설정·편집 허가)를 가진 합성 프로젝트의 이전·복원이 다른 프로젝트에 영향을 주지 않는다.
  - [ ] **A만 이전/복원할 때 참조 원본 B를 자동 export하지 않고, FK 자동 SET NULL에 기대지 않고 검증 명령의 같은 tx에서 snapshot 포인터를 명시적으로 비우고 `source_missing`·key/label 보존**하며, `file_policies.id`·`file_ai_access_versions.file_policy_id`·같은 hash 재첨부·**원본/추출 텍스트 blob 각자 정책·원본 deny 함께 검사(엄격한 쪽)** 이력이 보존된다.
  - [ ] 이 이슈의 완료는 **합성 이전·복원**이다. 실제 업로드·활성화는 WEB10·WEB11·WEB14 뒤 사용자 허용을 받은 별도 실행이며, WEB9 완료 조건에 실제 cutover를 넣지 않는다.
- **지킬 것**: 양방향 동기화·이중 쓰기를 하지 않는다. 옮기는 프로젝트만 동결한다. 실제 자료는 사용자 승인 1개만, 활성화는 WEB10·WEB11·WEB14 뒤에 한다. 실제 manifest·경로·수신자·백업·로그를 공개 저장소·CI artifact에 넣지 않는다. 공개 CI는 합성 검증만 하고, 실제 import를 CI로 우회하지 않는다.

## WEB10 — 운영·백업·복구

### [5단계] 운영·백업·복구 — D1 export·R2·복원 훈련

- **목표**: staging/prod 배포, 앞으로만 가는 마이그레이션, 야간 암호화 백업, 복구 훈련을 운영 가능하게 만든다.
- **할 일**
  - [ ] `web/migrations/0010_ops.sql`에 `ops_backup_runs`·`ops_audit_log`·`ops_incidents`를 만든다.
  - [ ] `ops/backup/export.sh`·`restore.sh`·`verify.sh`를 만든다. **실제 운영 백업은 승인된 로컬·비공개 실행 주체**가 하고, `.github/workflows/backup.yml`은 합성 dry-run/CI 검증만 한다. Actions로 실제 자료를 처리하려면 실행 계정·runner·목적·보존/삭제·원문 로그/캐시/artifact 금지·권한을 별도 변경안으로 먼저 승인받는다.
  - [ ] 백업 경로는 int64 정밀도 손실을 먼저 검증한다. **숫자로 변환되기 전에 보존하는 export 경로/도구 버전(또는 검증된 대체 경로)**을 채택한 뒤 gzip→age→R2 업로드 순서로 하고, 손실이 발견된 백업은 유효 복원본으로 채택하지 않는다. DB 경계+객체 hash manifest를 같은 묶음으로 만들고, hash 목록과 별도로 **참조 객체 바이트의 보존 위치·복사본·GC 수명주기**를 정한다.
  - [ ] `web/src/services/ops.ts`에 백업 나이·누락 객체·마지막 복원 훈련을, `web/src/routes/ops.ts`·`web/src/views/ops/status.ts`에 상태를 둔다.
  - [ ] `web/wrangler.toml`의 staging/prod를 분리하고, `web/migrations/README.md`에 expand/contract·구버전 앱/신스키마 호환 창을 적는다.
  - [ ] `ops/r2-lifecycle.json`에 `staging/` 30일·`quarantine/` 30일·백업 보존을 둔다. age 키는 백업 버킷과 분리해 오프라인/별도 시크릿에 보관한다.
  - [ ] `web/src/services/health.ts`와 외부 uptime으로 5xx·p95·D1 rows·Queue 적체·Workflow 실패/재시도·B 에이전트 마지막 확인·알림 실패·백업 나이를 경보한다.
  - [ ] `docs/operations/runbook.md`에 복원 시 커서·lease·세션·토큰·예산·알림 상태 처리를 적는다.
- **선행**: WEB1.
- **완료 기준**
  - [ ] `npm --prefix web run test -- --run test/ops`
  - [ ] 결정 뒤 확정할 TS 테스트 명령 (ops)
  - [ ] `bash ops/backup/export.sh --dry-run`
  - [ ] `bash ops/backup/restore.sh --scratch`
  - [ ] Time Travel 7일+야간 export로 RPO 24h·RTO 4h 훈련, 42개 백업 압축 크기 합+객체 ≤8GB, 프로젝트 단위 복원, 키 별도 복구, 마이그레이션 롤백 1회, 구버전 앱/신스키마 호환 창, 런북 재현이 통과한다.
  - [ ] **2^53 초과 정수**와 인접 rev/fence/event_seq가 export→import→복원 뒤 구분되고, 손실된 백업은 유효 복원본으로 채택하지 않는다. 방식 선택 전에는 "정밀도 검사 예정"과 "무손실 복구 검증 완료"를 구분해 표시한다.
  - [ ] 객체 1개 누락·삭제·손상과 키 분리 복구를 포함해 복원 시험이 통과하고, 보존/주기 축소가 RPO 24h·승인된 복구 조건을 깨지 않는다. 깨면 운영 변경·사용자 확인 대상으로 올린다.
  - [ ] S4-PR23/25 확장 데이터(이월·완료·설정·편집 허가)를 가진 합성 프로젝트의 복원이 다른 프로젝트에 영향을 주지 않는다.
  - [ ] **`file_policies.id`·`file_ai_access_versions.file_policy_id`·`project_references.source_missing`**이 백업·복원되고, A-only 참조가 원본 없이도 tombstone으로 남는다. tombstone은 **FK 자동 SET NULL에 기대지 않고 검증 명령의 같은 tx에서 snapshot 포인터를 명시적으로 비우고 key/label을 보존**한다.
  - [ ] DB 350MB는 **안전 정지/유료 전환 검토 신호**, 500MB는 하드 캡으로 둔다. 프로젝트별 D1 분리 자체는 후속 검토이며 이 이슈의 완료 조건이 아니다.
- **지킬 것**: 실제 자료·백업·키를 공개 저장소·CI artifact에 넣지 않는다. 공개 CI는 합성 dry-run만 하고 실제 백업을 CI로 우회하지 않는다. 마이그레이션을 되돌리지 않고 새 마이그레이션으로 복구한다. export 중 요청 차단을 안내한다. 백업은 DB만이 아니라 객체 hash 목록과 참조 바이트 보존 계약을 포함한다. hash 목록만으로 객체 복원을 보장하지 않는다.

## WEB11 — 보안 강화·점검

### [5단계] 보안 강화·점검 — Free 범위의 앱·플랫폼 방어

- **목표**: 공개 HTTPS에서 OWASP ASVS L1 수준의 앱 방어를 갖추고, Free에서 쓸 수 있는 플랫폼 방어만 겹친다.
- **할 일**
  - [ ] `web/src/middleware/security.ts`에 HSTS·CSP(nonce)·`frame-ancestors 'none'`·`X-Content-Type-Options`·Referrer-Policy·Origin/Referer 검사·CSRF 이중 제출 토큰을 둔다.
  - [ ] `web/src/services/validation.ts`와 `web/src/views/markdown.ts`에 입력 스키마·Markdown 안전 렌더·위험 URL 차단을 둔다.
  - [ ] `web/src/services/files.ts`에 MIME·크기·`quarantined` 격리·사람용 서명 URL·Go 정책 프록시를 넣는다.
  - [ ] `web/src/middleware/rate-limit.ts`에 로그인·매직링크·토큰·일반 API 예산을 둔다.
  - [ ] `.github/workflows/security.yml`에 의존성 감사·시크릿 스캔을, `ops/security/asvs-checklist.md`에 ASVS L1 판본·범위·결과를 둔다. `docs/operations/runbook.md`에 시크릿 회전 절차·키 버전을 적는다.
  - [ ] `ops/cloudflare/free-security.md`에 Free WAF·rate limiting·Bot Fight Mode 범위를 확인해 적는다. Bot Management는 쓰지 않는다.
  - [ ] `web/test/security/*.test.ts`와 `web/e2e/security.spec.ts`를 만든다.
- **선행**: WEB2·WEB4·WEB5·WEB7·WEB8·WEB9·WEB10·WEB12(구현된 경로).
- **완료 기준**
  - [ ] `npm --prefix web run test -- --run test/security`
  - [ ] `npm --prefix web run test:e2e -- security.spec.ts`
  - [ ] 결정 뒤 확정할 TS 테스트 명령 (security)
  - [ ] ASVS L1 체크, 치명·높음 0, CSRF/XSS/클릭재킹/토큰 유출 시험, 공개 버킷 0, Go 프록시 우회 0, 다른 프로젝트 참조·system 위장·공유 기기 캐시 시험, 401/403 폭주 경보, 시크릿 회전 1회가 통과한다.
  - [ ] WEB7 A 실행기·WEB10 백업/복구·WEB12 한도 계측의 구현된 경로를 통합 입력으로 점검하고, 구현 전 경로를 보안 통과로 기록하지 않는다.
  - [ ] **WEB15의 새 경로는 WEB11 기존 경로 검사와 별도로 WEB15 완료 뒤 후속 보안 검사(별도 게이트)를 받는다. WEB11은 WEB15 완료를 선행하지 않고, WEB15는 WEB11 완료를 기다리지 않는다.**
- **지킬 것**: 유료 Bot Management·WAF를 전제로 하지 않는다. UI 숨김을 권한으로 쓰지 않는다. `assurance=verified`를 플래그만으로 만들지 않는다. 실제 키·자료를 로그·fixture에 넣지 않는다.

## WEB12 — 무료 한도·사용량 계기

### [5단계] 무료 한도·사용량 계기 — 80% 경보·90% 완화

- **목표**: Workers·D1·R2·Queues·Workflows·KV·DO·메일 사용량을 계측하고, 무료 한도 안에서 완화·경보하게 한다. **Workers/D1의 Free 하드 캡과 R2의 무료 포함량+초과 과금은 다르게** 다룬다.
- **할 일**
  - [ ] `web/migrations/0012_usage.sql`에 `usage_metrics`·`usage_limits`·`usage_reports`를 만든다.
  - [ ] `web/src/services/usage.ts`가 Workers 요청·CPU 초과·D1 rows/저장·R2 작업/저장(무료 포함량과 초과 과금 구분)·Queues ops·Workflows step·KV 읽기/쓰기/저장·DO 요청/실행량/저장(채택 시)·Resend 사용량을 수집하게 한다.
  - [ ] `web/src/workers/usage-collector.ts`가 Cron/Queue로 일일 집계하고 `usage_reports`에 남긴다.
  - [ ] KV Free 한도(읽기/쓰기/저장)를 공식 문서와 계정에서 확인해 `usage_limits`에 넣고, 초과 위험 시 완화/차단한다. DO 채택 시 요청·벽시계 실행량·저장 한도도 같은 표에 넣는다.
  - [ ] `web/src/services/degrade.ts`에 80% 경보, 90%에서 폴링 간격 확대·비필수 알림/백업 연기·새 run 차단을 둔다. **R2 업로드/백업/서명 URL 다운로드별 사용량 예약·제한**과 초과 위험 시 차단·운영 중지 절차를 넣는다. KV/DO를 채택하면 같은 완화 대상에 포함한다.
  - [ ] `web/src/services/budget.ts`에 **A 계정/워크스페이스 사용률 기준점·호출별 토큰 추정·월/주/5시간 한도 대비 사용률·90% 문턱·한도 오류·billing source/allowance/cost 구분·unknown fail-closed**, **Extra Usage OFF 확인 증거·유효 기간·확인 불가 차단**, 다음 호출 최대 출력·병렬 예약을 둔다. 금액 상한·누적 예약/정산을 새로 만들지 않는다.
  - [ ] `web/src/routes/ops/usage.ts`와 `web/src/views/ops/usage.ts`에 사용률·unknown·완화 상태를 표시한다.
  - [ ] `.github/workflows/usage-report.yml`과 `docs/operations/usage.md`를 만든다.
- **선행**: WEB1·WEB8, WEB6/7 계약 또는 가짜 Workflow.
- **완료 기준**
  - [ ] `npm --prefix web run test -- --run test/usage`
  - [ ] 결정 뒤 확정할 TS 테스트 명령 (budget)
  - [ ] `npm --prefix web run test:e2e -- usage.spec.ts`
  - [ ] 월 1회 보고서, 100k/일·5M 읽기/일·10만 쓰기/일·5GB·10GB·10k ops/일·3,000 step/일 대비 사용률, 80/90% 동작, unknown을 0으로 표시하지 않음, **A 계정/워크스페이스 기준점·토큰 추정·billing source/allowance/cost·한도 오류 승계**, Extra Usage OFF 확인 불가 차단, 다음 호출 최대 출력·병렬 예약, 가짜 Workflow 순환 회피가 통과한다.
  - [ ] R2는 무료 포함량 초과 시 과금될 수 있음을 표시하고, 업로드/백업/다운로드별 예약·제한·초과 위험 시 차단/운영 중지가 시험된다. "요금제 전환 승인 전까지 $0"를 보장하지 않으며, 실제 비용 노출 전 사용자 결정을 받는다.
  - [ ] KV를 쓰는 OAuth provider와 DO를 쓰는 long poll을 채택한 경우 KV 읽기/쓰기/저장·DO 요청/실행량/저장 예산과 경보가 포함되고, 채택 전에는 포함량 준수로 표시하지 않는다.
- **지킬 것**: 유료 기능에 의존하지 않는다. Workers/D1의 Free 하드 캡과 R2의 무료 포함량+초과 과금을 같은 것으로 표시하지 않는다. "새 run 차단"을 한도 준수의 증명으로 표시하지 않는다. unknown 비용을 무료로 표시하지 않는다. 사용자 결정 없이 유료로 전환하지 않는다.

## WEB13 — WebMCP 재검토

### [5단계] WebMCP 재검토 — 날짜 있는 결정

- **목표**: 2026-11 기준 표준·브라우저·에이전트 지원을 다시 확인해 5단계 지원 여부를 결정한다.
- **할 일**
  - [ ] `docs/plan/research/webmcp-2026-11.md`에 1차 출처·확인 날짜·미확인을 구분해 적는다.
  - [ ] S3-W1(WebMCP 실험) 결과를 입력으로 읽고, 구현 성공을 5단계 지원 근거로 쓰지 않는다.
  - [ ] `web/src/webmcp/detect.ts`에 `document.modelContext` 기능 감지, `web/src/webmcp/tools.ts`에 읽기·답 초안·첨언 도구만(도입 시) 둔다.
  - [ ] `web/src/config/capabilities.ts`에 `webmcp: "unsupported"|"experimental"`을 둔다.
  - [ ] `web/test/webmcp/*.test.ts`와 `web/e2e/webmcp.spec.ts`(도입 시)를 만든다.
  - [ ] `docs/plan/decisions/`의 결정 색인에서 비어 있는 번호를 확인해 WebMCP 결정 파일을 만들고(기존 `0007`은 결함 처리라 재사용하지 않는다), 채택·보류·실험 결정과 재검토 조건을 적는다.
- **선행**: WEB2·WEB11.
- **완료 기준**
  - [ ] `npm --prefix web run test -- --run test/webmcp`
  - [ ] `npm --prefix web run test:e2e -- webmcp.spec.ts` (도입한 경우)
  - [ ] 날짜 있는 결정 기록, S3-W1 입력, capabilities 표시, 승인류 미노출, browser_agent 감사, 서버 거부, REA `discover_webmcp_tools` 발견 점검이 확인된다.
- **지킬 것**: 승인·reopen·판 시작·정책·토큰·삭제를 노출하지 않는다. `toolautosubmit`을 쓰지 않는다. 브라우저 도구가 사람의 승인 증거가 되게 하지 않는다. 근거 없이 지원을 주장하지 않는다.

## WEB15 — 웹↔PC 양방향 동기화·현황·도우미

### [5단계] 웹↔PC 양방향 — 연결 도우미·동기화·진행/스케줄

- **목표**: 내 컴퓨터의 연결 도우미가 웹 PES와 양방향으로 자료·진행·스케줄을 주고받고, 대시보드에서 "내 컴퓨터" 상태와 작업 타임라인을 본다.
- **할 일**
  - [ ] `pes link`/`pes sync` 도우미(선택 상주). PC 발신 WebSocket(Cloudflare DO) + HTTP 파일 업로드/다운로드, 자동 재접속·커서, 큰 파일은 HTTP. A 실행기가 아님.
  - [ ] **도우미 사람/기기 링크 자격과 AI 도구 MCP/API 자격을 분리**하고, WebSocket 메시지를 **닫힌 PES 명령으로만 매핑**한다. 매 메시지·재접속마다 현재 권한·scope·프로젝트·정책을 검사하고 expected rev·멱등 키·사건/영수증을 **같은 tx**에 남긴다. 권한 회수·교차 기기/프로젝트 메시지·가짜 완료를 거부한다.
  - [ ] `sync_links`(**`credential_kind(human_device/helper_device)`·`helper_actor_id`**)·`sync_items`(**`tx_id`**)·`agent_schedules`(**`tx_id`**)와 기존 `events`의 `execution.progress.*`를 사용한다. 충돌은 `sync_items.state=conflict`와 `conflict_json`, 삭제는 표시만.
  - [ ] `web/src/routes/sync.ts`·`web/src/workflows/sync.ts`·`web/src/views/computer.ts`에 연결 상태·마지막 확인·타임라인(완료/진행/예정)·동기화 상태를 둔다.
  - [ ] WebSocket Hibernation(무료), `serializeAttachment`/저장소 상태, Vercel 현재 문서 기준 최대 함수 시간 뒤 재접속, SSE(웹→PC)+HTTP(PC→웹), 짧은 폴+ETag 대체 경로를 같은 이벤트 형식·커서로 구현한다. **DO incoming 20:1은 과금 계산용**이며 메트릭은 실제 메시지 수임을 기록한다.
  - [ ] 자료 동기화는 버전·hash, 조용한 덮어쓰기 금지, 삭제 비전파, 프로젝트별 폴더 지정, 크기·개수 상한, R2/Blob 무료 한도 자기 제한.
  - [ ] **사람용 보관 영역과 AI 도구 workspace/도우미 자격을 분리**하고, AI 참조 `deny` 파일은 사람은 받을 수 있지만 MCP 도구 응답·A 맥락·AI workspace에는 넣지 않는다. **파일·셸·업로드 권한까지 통제 범위**에 넣고, 통제 불가 도구/경로는 “A·B 모두 제외 보장”으로 표시하지 않고 연결 시 제한을 명시한다.
  - [ ] 2단계 PR20a 공통 bridge에 진행·스케줄 이벤트 형식을 포함하고, 5단계는 웹 전달·대시보드·동기화를 맡는다. **PC 도우미↔웹은 WebSocket/HTTP, AI 도구↔PES는 MCP/API, 브라우저 탭 안 보조만 WebMCP**로 역할을 통일하고, WebMCP가 PC 연결 요구를 충족한다고 쓰지 않는다.
  - [ ] `tests/stage5/web_sync.test.ts`·`web/e2e/computer.spec.ts`·`web/test/sync/*.test.ts`.
- **선행**: WEB1·2·4·5·9, PR20a·21.
- **완료 기준**
  - [ ] PC↔웹 합성 자료 올리기/내려받기, 재접속 커서 유실 0·중복 멱등, 양쪽 변경 충돌·사람 선택, 삭제 비전파.
  - [ ] **메시지→닫힌 명령 매핑·매 메시지 권한 검사·expected rev·멱등·사건/영수증 같은 tx**, 권한 회수·교차 기기/프로젝트 메시지·가짜 완료 거부가 통과한다.
  - [ ] 큰 파일은 WebSocket이 아니라 HTTP, WebSocket Hibernation·Vercel 현재 문서 기준 최대 함수 시간 뒤 재접속·SSE/폴 대체 시험. **DO 20:1은 과금 계산용**임을 확인한다.
  - [ ] deny 파일이 MCP/A/AI workspace에 0건, 사람 화면 열람 가능. **여섯 도구의 로컬 직접 읽기·동기화 캐시·파일 OFF 뒤 재접속**을 시험하고, 통제 불가 도구/경로는 “A·B 모두 제외 보장”으로 표시하지 않는다.
  - [ ] 진행·스케줄·동기화 상태가 대시보드에 표시되고, 연결 끊김은 "상태 미상"으로 표시.
  - [ ] **WebMCP는 브라우저 탭 안 보조만**이며 PC 연결 요구를 충족하지 않는다. **WEB15 완료 뒤 WEB11 후속 보안 검사(별도 게이트)를 받고, WEB15는 WEB11 완료를 기다리지 않는다.**
- **지킬 것**: 연결 도우미를 A 실행기로 만들지 않는다. 웹이 PC로 직접 접속하지 않는다. 큰 파일을 WebSocket으로 보내지 않는다. 실제 경로·자료를 공개 로그에 넣지 않는다.

## WEB14 — 전환 통합 검증·문서

### [5단계] 전환 통합 검증·문서 — Free A/B 종단

- **목표**: Free 플랜에서 A/B, 이전·롤백, 알림, 한도, Windows/Mac, 문서를 한 번에 검증한다.
- **할 일**
  - [ ] `web/e2e/full.spec.ts`에 로그인→질문→답→승인→reopen→인쇄→이전→롤백에 더해 S3-U1~U6·REF1·MAT1과 S4-U7~U12(판 이월·비교·갈림길·반대·직접 편집·기본 화면)의 웹 동등성 흐름을 둔다.
  - [ ] `tests/stage5/web_transition.test.ts`와 `tests/fixtures/web/`에 합성 프로젝트·깨진 참조·2MB JSON·이미지 fixture를 둔다.
  - [ ] `docs/operations/runbook.md`·`user-guide.md`·`rollback.md`·`free-limits.md`를 완성한다.
  - [ ] `ops/drills/`에 복원·**Workflow 실패·3일 만료**·B 에이전트 오프라인·토큰 회수·Go OFF·알림 실패 훈련 스크립트를 둔다.
  - [ ] `.github/workflows/web-ci.yml`에 Windows+macOS, Playwright, **결정 뒤 확정할 TS 테스트 명령**을 매 PR+main으로 돌린다. **공개 CI는 합성 fixture만** 쓰고 실제 자료·백업·원문 로그를 넣지 않는다.
  - [ ] `web/playwright.config.ts`에 Windows Playwright 필수·스크린샷 기준선 없음·수동 IME/인쇄 체크리스트를 둔다.
  - [ ] `docs/plan/decisions/0005-web-platform.md`에 Free 포함량 측정값·R2 초과 과금 위험·탈출 조건을 최종 기록한다. R2는 $0 보장이 아니므로 실제 비용 노출 전 사용자 결정을 남긴다.
  - [ ] 승인 경계를 "실제 자료 업로드 전 / 운영 전환 전 / 무료 한도 초과로 유료 전환 전"으로 나누고, 완료 뒤 소급 승인으로 쓰지 않는다.
- **선행**: WEB0~WEB13·WEB15.
- **완료 기준**
  - [ ] 결정 뒤 확정할 TS 테스트 명령 (전환 종단)
  - [ ] `npm --prefix web run test -- --run`
  - [ ] `npm --prefix web run test:e2e`
  - [ ] 5절 게이트 전부를 **개발 완료(합성 종단)**와 **실제 전환 승인**으로 나눠 통과한다. Free 플랜만 사용하고, A/B(Claude Code·Claude 앱·Codex CLI·OpenCode TUI·Codex 앱·OpenCode 앱) 인계·경합·지연·OFF·Go 사용량·유실/중복과 WEB15 양방향을 확인한다.
  - [ ] S3-U1~U6·REF1·MAT1과 S4-U7~U12의 웹 동등성, 25~30초 갱신·탭 숨김·지수 백오프, 폼 버전·반영 증거·앵커·전달 manifest·인쇄 manifest를 확인한다. 제외 항목은 이유와 검증 시점을 적고 조용히 생략하지 않는다.
  - [ ] Codex CLI·OpenCode TUI의 웹 재접속·회수·인계·Go 경계 회귀를 확인한다. 실제 업로드·활성화는 별도 사용자 허용 뒤 실행하고, 이 이슈의 완료를 실제 cutover 완료로 표시하지 않는다.
  - [ ] Windows/Mac·수동 IME/인쇄, 실제 산출물 비공개, 공개 CI 합성 전용이 통과한다.
- **지킬 것**: 유료 기능에 의존하지 않는다. R2 무료 포함량 초과 과금을 $0로 보장하지 않는다. 실제 자료·경로·수신자·백업·로그를 공개 저장소·CI artifact에 넣지 않는다. 승인 경계를 소급 적용하지 않는다. 로컬 모드 프로젝트를 깨지 않는다.

## 등록 메모

- 이슈 수: **16개(WEB0~WEB15)**. `WEB2`·`WEB7`·`WEB9`·`WEB10`은 크므로, 구현 중 **독립 배포·검증이 가능할 때만** 나눈다.
- 모든 이슈는 이 문서의 **공통 규칙·경로 가정·테스트 명령**을 각 Linear 본문 첫머리에 함께 복사하고, 체크리스트와 완료 기준을 그대로 옮긴다. PR 본문에는 완료 기준의 테스트 명령을 붙인다.
- 실제 자료를 쓰는 시험은 WEB9 활성화 직전 사용자 허용 1개로 제한하고, 그 전까지는 합성 fixture만 쓴다. 공개 CI(GitHub Actions 포함)는 합성 검증만 하며, 실제 import·백업은 승인된 로컬·비공개 실행 주체로 옮긴다.
