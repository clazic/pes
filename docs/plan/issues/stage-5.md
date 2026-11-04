# 5단계 구현 이슈 초안

- 입력: [stage-5.md](../stage-5.md) 4절(WEB0~WEB14), [stage-1-db.md](../stage-1-db.md)·[stage-1-api.md](../stage-1-api.md)·[stage-1-ui.md](../stage-1-ui.md)·[stage-1-runners.md](../stage-1-runners.md), [DDL 초안](../schemas/stage-1-ddl-draft.sql)
- 상태: **초안 — 사용자 승인 뒤 Linear 등록.** 이 문서는 등록 원고이며 코드·계획서를 바꾸지 않는다.
- 규칙: **이슈 하나 = PR 하나.** 한 이슈 안에서도 기존 구현 재사용과 새 변경을 구분한다. 독립 배포·검증이 가능할 때만 나눈다. 실제 `~/pes-projects`·`~/.pes/` 자료, 실키, 기관 자료는 쓰지 않고 합성 fixture만 쓴다.
- 이슈 수: **15개(WEB0~WEB14)**. `WEB2`·`WEB7`·`WEB9`·`WEB10`은 크므로 구현 중 독립 배포·검증이 가능할 때만 나눈다.
- 경로 가정: WEB0 전에는 TypeScript 경로를 초안으로 쓴다. WEB0가 Python Workers를 고르면 `web/src` 대신 `web/python`에 같은 모듈 경계를 두고, 아래 파일명은 그대로 대응시킨다. 웹 앱은 `web/`, 마이그레이션은 `web/migrations/`, 웹 테스트는 `web/test/`, E2E는 `web/e2e/`에 둔다.
- 공통 테스트: 로컬 `python -m pytest -q`; 웹 `npm --prefix web run test -- --run`; E2E `npm --prefix web run test:e2e`; 로컬 D1 `npm --prefix web run db:migrate:local`. `web/package.json`의 스크립트는 WEB1에서 만든다.
- 마이그레이션 번호는 이슈 번호와 맞춘다(예: WEB4 → `0004_agent_tokens.sql`). 새 표가 없는 WEB3·WEB7·WEB11·WEB13·WEB14는 번호를 비우고, 기존 표·계약을 재사용한다.
- 공통 지킬 것: 서버가 모든 권한을 재검사한다. UI 숨김은 권한이 아니다. 승인·reopen·판 시작·정책·토큰·삭제는 사람 세션만 하고 에이전트 키·OAuth·WebMCP로 대행할 수 없다. 원본 위치는 프로젝트마다 하나이고 이중 쓰기·양방향 동기화를 하지 않는다. 새 표·열은 `web/migrations/`에 번호를 붙이고 `db_meta.schema_version`·`docs/plan/schemas/stage-1-ddl-draft.sql`·`check_ddl.py`를 함께 갱신한다. 미지원은 capabilities에 알리고 가짜 성공을 반환하지 않는다.

## WEB0 — 코어 언어 기술 시험

### [5단계] 코어 언어 기술 시험 — Python Workers vs TS 이식

- **목표**: 2단계 Python 코어를 무료 Workers에서 실행할 방법을 정하고, 같은 계약을 어느 구현이 지키는지 증거로 남긴다.
- **할 일**
  - [ ] `web/spike/python-worker/`에 Python Workers + D1 바인딩 최소 앱, `web/spike/ts-worker/`에 TypeScript 명령 서비스 골격, `web/spike/py-server/`에 비교용 로컬 Python 서버를 둔다.
  - [ ] 2단계 PR4·13의 계약 fixture를 `tests/contracts/v1/*.json`으로 고정하고, `result.submit`·`stage.approve`·`Idempotency-Key`·`rev` 0행 실패·int64 10진 문자열·오류 봉투를 두 구현에 같은 입력으로 돌린다.
  - [ ] `web/wrangler.toml`의 `compatibility_date`·`compatibility_flags`를 고정하고, Free 계정에서 Python Workers 포함 여부를 먼저 확인한다.
  - [ ] `web/src/db/d1.ts`(또는 `web/python/db/d1.py`)의 공통 어댑터 경계를 정하고, `db.batch()` 원자성·0행 실패·deferred FK·부분 인덱스·JSON 함수를 확인한다.
  - [ ] p95 CPU·콜드스타트·D1 쿼리 수·subrequest 수를 측정해 `docs/plan/decisions/0006-web-core-language.md`에 문제·선택지·채택·이유·영향·재검토 조건을 적는다.
  - [ ] 2단계 PR4·13 담당자에게 "계약 시험은 언어 중립 골든 파일을 쓴다"를 Linear 댓글로 통지한다.
- **선행**: 2단계 코어 계약(PR 4·13).
- **완료 기준**
  - [ ] `python -m pytest -q`
  - [ ] `npm --prefix web run test -- --run test/contracts`
  - [ ] Free 계정에서 후보 구현의 CPU 10 ms·메모리 128 MB·subrequest 50 측정표가 있다.
  - [ ] 결정 기록과 2단계 통지가 있다. 후보 (c)를 고르면 WEB1의 플랫폼 전제를 재검토한다.
- **지킬 것**: 유료 계정을 쓰지 않는다. 실제 자료를 올리지 않는다. D1/SQLite 합의를 다시 열지 않는다. 계약을 구현에 맞춰 바꾸지 않는다.

## WEB1 — 웹 실행 골격·배포

### [5단계] 웹 실행 골격·Free 배포 — Worker·Assets·D1·R2

- **목표**: Cloudflare Free에서 staging/prod Worker, D1, R2, 마이그레이션, CI, 헬스체크가 도는 최소 골격을 만든다.
- **할 일**
  - [ ] `web/package.json`에 `test`·`test:e2e`·`db:migrate:local`·`deploy:staging`·`check:deploy` 스크립트를 둔다.
  - [ ] `web/wrangler.toml`에 `env.staging`·`env.production`, D1 바인딩, R2 바인딩, Assets, `compatibility_date`를 둔다.
  - [ ] `web/src/worker.ts`(진입), `web/src/app.ts`(라우터), `web/src/routes/health.ts`, `web/src/config/capabilities.ts`, `web/src/db/d1.ts`를 만든다.
  - [ ] `web/migrations/0001_init.sql`에 `docs/plan/schemas/stage-1-ddl-draft.sql`의 54개 표를 넣고, `docs/plan/schemas/check_ddl.py`의 검사 항목을 로컬 SQLite와 D1 smoke에 함께 적용한다. 웹 측 검사는 `web/scripts/check-schema.mjs`로 둔다.
  - [ ] `web/src/services/commands.ts`에 2단계 PR4 명령 서비스의 D1 구현 경계를 둔다. rev·멱등·0행 실패·뒤늦은 실패 전체 롤백·큰 정수 문자열·커서·공개 DTO를 같은 의미로 시험한다.
  - [ ] `.github/workflows/web-ci.yml`(매 PR+main, Windows+macOS)과 `web-deploy.yml`(main→staging, 태그→prod 수동 승인)을 만든다.
  - [ ] `GET /healthz`가 `SELECT 1`·R2 HEAD·`db_meta.schema_version`을 확인하게 한다.
  - [ ] 25초 long poll 구현 선택(DO/짧은 폴+ETag/SSE)을 `docs/plan/decisions/0005-web-platform.md`에 적고, Free 요청·CPU·subrequest 한도를 계측한다.
  - [ ] R2 버킷 활성화에 결제 수단이 필요한지 Free 계정에서 확인해 기록한다.
- **선행**: PR 1·2·4·13·14·18·U1, WEB0.
- **완료 기준**
  - [ ] `npm --prefix web run test -- --run`
  - [ ] `npm --prefix web run db:migrate:local`
  - [ ] `npm --prefix web run check:deploy`
  - [ ] `python -m pytest -q`
  - [ ] staging에서 실제 D1로 읽기 화면이 뜨고, 이전 버전 롤백 1회·시크릿 스캔·100k 요청/일·10 ms CPU·subrequest 50 smoke가 통과한다.
- **지킬 것**: 공개 prod 전환은 WEB14 게이트 뒤에 한다. 유료 기능에 의존하지 않는다. 이중 쓰기·가짜 성공·`SELECT *` 전체 스캔을 넣지 않는다. 비밀은 Worker/GitHub Environment secret에만 둔다.

## WEB2 — 사람 로그인·세션

### [5단계] 사람 로그인·세션 — 매직링크·패스키·step-up

- **목표**: D1 기반 사람 인증과 `__Host-` 세션, 브라우저 step-up, 기기 승인을 붙인다.
- **할 일**
  - [ ] `web/migrations/0002_auth.sql`에 `auth_accounts`·`auth_sessions`·`auth_passkeys`·`email_verifications`·`project_invites`·`device_tokens`·`recovery_codes`·`auth_audit`를 만든다.
  - [ ] `web/src/services/auth.ts`·`sessions.ts`·`passkeys.ts`·`invites.ts`·`device-flow.ts`를 만든다. PES `users`를 정본으로 두고 `users.auth_subject`에 `provider:subject`를 매핑한다.
  - [ ] `web/src/routes/auth.ts`에 `/login`·`/auth/magic-link`·`/auth/passkey/*`·`/auth/device/*`·`/logout`을 만든다. `web/src/views/auth/*`에 로그인·초대 수락·복구 화면을 둔다.
  - [ ] `web/src/middleware/session.ts`에 `__Host-pes_session`(HttpOnly·Secure·SameSite=Lax·Path=/)와 절대 14일·유휴 7일 회전을 넣는다.
  - [ ] `web/src/middleware/stepup.ts`에 `requireStepUp(action, targetRev)`를 둔다. 승인·reopen·판 시작·정책·토큰·삭제·데이터 내보내기는 5분 내 브라우저 재인증과 snapshot/rev 확인을 요구한다.
  - [ ] `scripts/pes.py`에 `cmd_login`과 `CMDS["login"]`을 추가하고, `scripts/credentials.py`로 Windows Credential Manager/macOS Keychain에 기기 토큰을 저장한다. `main()`의 인자 처리도 맞춘다.
  - [ ] 세션 검증의 p95 CPU를 측정한다. 10 ms를 넘으면 HMAC 경량 쿠키+D1 1행으로 줄이고, 그래도 넘으면 9절 전환 신호로 기록한다.
  - [ ] `auth_audit`에 로그인·실패·재인증·기기 회수·복구 코드 사용을 남긴다.
- **선행**: WEB1, PR 4.
- **완료 기준**
  - [ ] `python -m pytest -q tests/test_login.py tests/test_stepup.py`
  - [ ] `npm --prefix web run test -- --run test/auth`
  - [ ] `npm --prefix web run test:e2e -- auth.spec.ts`
  - [ ] 로그인·만료·고정·회전·재인증·복구 코드 1회·CLI 기기 회수 즉시 401이 통과한다. 다른 프로젝트 접근은 거부되고, step-up은 기기 토큰으로 대행할 수 없다.
- **지킬 것**: 승인류는 사람만 한다. 에이전트·MCP·기기 토큰이 step-up을 대신하지 못한다. 이메일 존재 여부를 노출하지 않는다. 실제 메일 주소·실자료를 fixture에 넣지 않는다.

## WEB3 — 멤버·초대·역할

### [5단계] 프로젝트 멤버·초대·역할 — owner/editor/reader

- **목표**: `project_members` 역할 모델과 초대·해제·소유권 이전을 서버 권한으로 완성한다.
- **할 일**
  - [ ] `web/src/services/members.ts`에 멤버 추가·역할 변경·제거·초대·철회·소유권 이전을 둔다.
  - [ ] `web/src/routes/members.ts`와 `web/src/views/settings/members.ts`를 만든다.
  - [ ] `projects.owner_user_id`와 `project_members`의 owner 행이 항상 일치하도록 소유권 이전을 한 tx로 만든다. `one_project_owner` 부분 UNIQUE를 유지한다.
  - [ ] `web/src/auth/permissions.ts`에 owner/editor/reader 권한 매트릭스를 두고, 승인·reopen·판 시작·정책·토큰·삭제·멤버 변경은 owner만 허용한다.
  - [ ] 초대는 이메일 1회용 7일, 역할 지정, 철회 가능. 수락 시 `users`·`auth_accounts`·`project_members`를 한 tx로 만든다.
  - [ ] 역할 변경·회원 제거 시 해당 사용자의 세션·OAuth 위임·에이전트 자격·예약 알림을 무효화하거나 재검사한다.
  - [ ] `web/src/services/notifications.ts`의 발송 직전 권한 재검사 훅과 연결한다.
- **선행**: WEB2, PR 10.
- **완료 기준**
  - [ ] `python -m pytest -q tests/test_members.py`
  - [ ] `npm --prefix web run test -- --run test/members`
  - [ ] `npm --prefix web run test:e2e -- members.spec.ts`
  - [ ] 역할별 허용·거부 표 전 항목, 마지막 owner 제거 거부, owner 이전 원자성, editor 승인 불가, editor 답이 lease에 막히지 않음이 통과한다.
- **지킬 것**: UI 숨김으로 권한을 대신하지 않는다. owner 없는 프로젝트를 만들지 않는다. 에이전트 키로 멤버·역할을 바꾸지 못한다. 회원 제거 뒤 알림·OAuth가 남지 않는다.

## WEB4 — 에이전트 키 운영

### [5단계] 에이전트 키 발급·회수·교체 — 30일·scope·pepper

- **목표**: 프로젝트 범위 에이전트 토큰의 발급·회수·교체·감사를 운영 가능한 형태로 만든다.
- **할 일**
  - [ ] `web/migrations/0004_agent_tokens.sql`에 `agent_tokens`의 `label`·`token_prefix`·`last_used_at`·`last_used_ip`·`created_by_user_id`·`pepper_version`을 nullable로 추가한다.
  - [ ] `web/src/auth/scopes.ts`에 API 6절 동작 전체 scope(`context:read`·`inputs:read`·`changes:read`·`version:read`·`run:claim`·`run:heartbeat`·`run:wait`·`run:complete`·`run:cancel`·`run:release`·`result:submit`·`question:ask`·`input:receipt`·`file:upload`·`file:read`)를 둔다.
  - [ ] `web/src/services/tokens.ts`에 `pes_<prefix>_<base64url>` 생성, `HMAC-SHA256(pepper, token)` 저장, prefix 조회, 상수 시간 비교, 30일 만료, 회수, 24시간 교체, 긴급 회수, pepper 회전을 둔다.
  - [ ] `web/src/routes/tokens.ts`와 `web/src/views/settings/tokens.ts`를 만든다. 원문은 발급 응답에서 한 번만 보여 준다.
  - [ ] `web/src/middleware/rate-limit.ts`에 토큰별 60 req/min과 heartbeat·중단·상태 확인 별도 예산을 둔다.
  - [ ] `web/src/services/leases.ts`와 연결해 회수 뒤 새 claim·submit은 401, 살아 있는 lease는 TTL 만료 뒤 `interrupted`가 되게 한다.
  - [ ] `scripts/pes.py`에 `cmd_token`(발급·목록·회수·교체)과 `CMDS["token"]`을 추가한다.
  - [ ] 발급·회수·첫 사용·교체를 `events`와 `auth_audit`에 남긴다.
- **선행**: WEB2·WEB3, PR 10.
- **완료 기준**
  - [ ] `python -m pytest -q tests/test_tokens.py`
  - [ ] `npm --prefix web run test -- --run test/tokens`
  - [ ] 회수 즉시 401, lease 만료 뒤 `interrupted`, 원문이 DB·로그·에러·URL·프롬프트에 0건, scope별 허용·거부, 교체 중 무중단, 긴급 회수 겹침 없음이 통과한다.
- **지킬 것**: 발급·회수는 owner 사람만 한다. 기기 단위 토큰을 만들지 않는다. 승인·reopen·정책·토큰·삭제 scope를 만들지 않는다. 토큰을 모델 프롬프트에 넣지 않는다.

## WEB5 — 원격 MCP·OAuth

### [5단계] 원격 MCP·OAuth — Claude 앱·Claude Code 연결

- **목표**: 공개 HTTPS의 `/mcp`와 OAuth 2.1로 방식 B가 같은 PES API에 붙게 한다.
- **할 일**
  - [ ] `web/migrations/0005_oauth.sql`에 `oauth_clients`·`oauth_grants`·`oauth_access_jti`·`oauth_refresh_tokens`·`oauth_consents`를 만든다.
  - [ ] `web/src/mcp/server.ts`와 `web/src/mcp/tools.ts`에 `pes_context`·`pes_claim`·`pes_submit`·`pes_ask`·`pes_wait`·`pes_complete`·heartbeat·release·cancel·입력/결과 영수증·`pes_projects`를 구현한다.
  - [ ] `web/src/oauth/provider.ts`에 OAuth 2.1 metadata·PKCE·resource/audience·정확한 redirect URI·state를 둔다. DCR은 rate limit·허용 목록·동의로 제한한다.
  - [ ] `web/src/routes/oauth.ts`, `web/src/views/oauth/consent.ts`, `web/src/views/settings/connected-apps.ts`를 만든다. 동의 화면에 수신자·프로젝트·자료 범위·동작·철회를 표시한다.
  - [ ] `web/src/services/grants.ts`에 scope = 동의 ∩ 현재 `project_members` ∩ 에이전트 제한 검사를 둔다. 동의 뒤 새 프로젝트로 자동 확장하지 않는다.
  - [ ] 액세스 토큰 `jti`를 매 요청 D1에서 검사해 연결 해제 즉시 401이 되게 한다. refresh 회전·재사용 거부를 넣는다.
  - [ ] `pes_submit`은 run 결과 제출이고 사람 답 `submissions`와 분리한다. MCP는 사람 답 제출을 대행하지 않되 자기에게 온 질문 답은 허용한다.
  - [ ] `docs/operations/mcp-connect.md`에 Claude 앱 커스텀 커넥터와 Claude Code `claude mcp add --transport http` 절차를 적는다.
- **선행**: WEB2·WEB3·WEB4, PR 13·14·20.
- **완료 기준**
  - [ ] `npm --prefix web run test -- --run test/mcp test/oauth`
  - [ ] `npm --prefix web run test:e2e -- mcp.spec.ts`
  - [ ] 합성 프로젝트 1라운드 왕복, 도구 호출 10초 내 응답, Free 10 ms CPU·subrequest 50 측정, 승인·정책·토큰·사람 답 제출 도구 없음, wrong-project·중복 제출 거부, 연결 해제 401이 통과한다.
  - [ ] Claude 앱 커넥터와 Claude Code HTTP MCP를 실제로 연결해 재접속·만료·옛 결과 거부를 확인한다.
- **지킬 것**: OAuth 위임은 사람 세션이 아니다(`actor.kind=external_agent`, `on_behalf_of_user_id`). 승인·reopen·정책·토큰·삭제를 노출하지 않는다. 토큰을 모델에 넣지 않고, 연구 자료는 데이터로만 취급한다.

## WEB6 — runner 등록·연결

### [5단계] 로컬 runner 등록·연결 — 순수 조회와 원자 claim 분리

- **목표**: `pes runner`가 밖으로 연결해 일을 찾고 원자적으로 claim하는 경로를 만든다.
- **할 일**
  - [ ] `web/migrations/0006_runner.sql`에 `runner_devices`(`project_id`·`runner_id`·`label`·`last_seen_at`·`revoked_at`)를 만든다.
  - [ ] `web/src/routes/runner.ts`에 `GET /api/v1/projects/{id}/runs/available`(순수 조회, 최대 25초 대기)과 `POST /claims`(원자 쓰기), heartbeat·wait·complete를 둔다.
  - [ ] `scripts/pes.py`에 `cmd_runner`와 `CMDS["runner"]`를 추가하고, `scripts/runner/__init__.py`·`scripts/runner/daemon.py`에 데몬·신호 처리·백오프·키체인 읽기를 둔다.
  - [ ] `web/src/services/leases.ts`에서 PR5의 claim·lease·fence를 재사용하고, 프로젝트당 실행 담당 하나·두 번째 runner 거부·사람 인계를 시험한다.
  - [ ] `web/src/views/runner/status.ts`에 마지막 확인 시각과 "확인 없음 ≠ 꺼짐 확정"을 표시한다.
  - [ ] 폴링 기본 25~30초, 탭·runner 유휴 시 중지, 지수 백오프를 넣는다. 3초 기본값을 쓰지 않는다.
- **선행**: WEB4, PR 5·19.
- **완료 기준**
  - [ ] `python -m pytest -q tests/test_runner.py tests/test_lease.py`
  - [ ] `npm --prefix web run test -- --run test/runner`
  - [ ] `npm --prefix web run test:e2e -- runner.spec.ts`
  - [ ] 절전·단절·재접속, 인바운드 포트 0, 두 runner 경합 거부, 회수 뒤 claim 중단, 1 runner 하루 요청이 100k/일의 5% 이하가 통과한다.
- **지킬 것**: 웹은 runner로 접속하지 않는다. runner는 loopback의 전용 opencode에만 접속한다. 자동 failover하지 않는다. claim은 run 전이+lease 획득의 원자 변경이다.

## WEB7 — runner의 OpenCode supervisor

### [5단계] runner의 OpenCode supervisor — 6단계 실행·Go 허가·복구

- **목표**: 로컬 supervisor가 전용 opencode를 띄우고, 매 반출 요청을 서버에 허가받으며, 중단·재시작을 견디게 한다.
- **할 일**
  - [ ] `scripts/runner/opencode.py`에 전용 프로필·프로세스·`~/.pes/runs/<run_id>/workspace`·loopback·Windows Job Object/macOS 프로세스 그룹·로그 회전을 둔다.
  - [ ] `scripts/runner/policy.py`에 prepared→authorized→sent/unknown을 구현하고, `web/src/routes/dispatches.ts`의 `POST /outbound-dispatches/prepared`·`/authorize`·`/sent`와 연결한다.
  - [ ] `web/src/services/policy.ts`가 현재 Go 정책·버전·자료 범위·자식/요약/첨부/재시도를 매 요청 검사하게 한다. `outbound_dispatches`에 상태를 남긴다.
  - [ ] `web/src/services/runs.ts`에 interrupt·cancel·handoff 202, 재시작 뒤 재처리·조회, run/session 계보, 부모만 채택, 자식 대기 전파, reviewer 별도 run을 둔다.
  - [ ] `scripts/runner/usage.py`에 usage 보고를 넣고, DeepSeek 하나·폴백 없음·부모만 채택을 강제한다.
  - [ ] `scripts/runner/update.py`에 서명된 업데이트 검증·서명키 회전·검증 실패 차단을 넣는다.
  - [ ] `web/src/views/runs/execution.ts`에 최소 실행 상태·차단 이유·마지막 확인을 표시한다. 새 디자인은 3단계 U1을 재사용한다.
- **선행**: WEB6, PR 19·21, WEB12 예산 값.
- **완료 기준**
  - [ ] `python -m pytest -q tests/test_runner_supervisor.py tests/test_policy.py`
  - [ ] `npm --prefix web run test -- --run test/dispatch`
  - [ ] `npm --prefix web run test:e2e -- runner-flow.spec.ts`
  - [ ] 합성 queued run으로 PES 6단계 각 단계 1라운드 완주, 강제 종료 뒤 재개·중복 없음, OFF 모든 경로 차단·in-flight unknown, 부모 대기 전파, interrupt 202 재처리, usage 기록이 통과한다.
- **지킬 것**: 폴백 모델·자동 재개·자식 채택을 넣지 않는다. 서버 허가 없이 Go로 보내지 않는다. unknown을 미전송으로 보지 않는다. 이미 나간 자료의 회수를 보장하지 않는다고 표시한다.

## WEB8 — 알림

### [5단계] 알림 — 메일·Web Push·outbox

- **목표**: 사람이 행동해야 하는 사건을 메일과 휴대폰 푸시로 보내되, 연구 내용을 본문에 싣지 않는다.
- **할 일**
  - [ ] `web/migrations/0008_notifications.sql`에 `notification_outbox`·`notification_endpoints`·`notification_preferences`·`notification_deliveries`를 만든다.
  - [ ] `web/src/services/notifications.ts`가 업무 변경과 같은 tx에 outbox를 쓰게 한다. `web/src/workers/notify.ts`가 Queue/Cron에서 읽어 발송한다.
  - [ ] `web/src/services/email.ts`에 Resend(3,000통/월·100통/일), `web/src/services/push.ts`에 VAPID를 둔다.
  - [ ] `web/public/manifest.webmanifest`와 `web/public/sw.js`(또는 `web/src/sw.ts`)에 PWA·푸시 구독·`pushsubscriptionchange`를 넣는다.
  - [ ] `web/src/routes/push.ts`, `web/src/views/settings/notifications.ts`에 채널·조용한 시간·상세 제목 선택을 둔다.
  - [ ] `web/src/services/notify-policy.ts`에 `waiting_human`과 승인 대기를 별도 사건으로, `dedupe_key=endpoint+event_seq+event_type`, 5분 묶음, 22:00~08:00 KST, 발송 직전 권한 재검사를 넣는다.
  - [ ] 기본 본문은 프로젝트명 없이 일반 문구+로그인 링크만. 질문 문구·연구 내용·파일명은 넣지 않는다.
  - [ ] `notification_deliveries`에 provider 영수증·unknown·재시도를 남기고, Queues 24시간 보존 안에 재시도를 끝낸다.
- **선행**: WEB1·WEB2·WEB3, PR 14.
- **완료 기준**
  - [ ] `python -m pytest -q tests/test_notifications.py`
  - [ ] `npm --prefix web run test -- --run test/notifications`
  - [ ] `npm --prefix web run test:e2e -- notifications.spec.ts`
  - [ ] 적격 사건 enqueue·발송 시도, 같은 event 중복 1건, iOS 홈화면 PWA 푸시, 미설치·거부 대안, 실패 UI·unknown, 발송 직전 권한 재검사, 복원·import 뒤 재발송 0이 통과한다.
- **지킬 것**: 도착을 보장하지 않는다. SMS를 쓰지 않는다. 연구 내용·프로젝트명을 기본 본문에 넣지 않는다. 과거 사건을 새 알림으로 재발송하지 않는다.

## WEB9 — 로컬→웹 이전

### [5단계] 로컬→웹 이전 — 번들·staging import·cutover

- **목표**: 프로젝트 하나를 동결·번들·검증·활성화하는 한 방향 이전을 만들고, 실패하면 로컬로 돌아가게 한다.
- **할 일**
  - [ ] `web/migrations/0009_import.sql`에 `import_tokens`·`import_chunks`를 추가하고, 기존 `import_batches`·`legacy_mappings`를 재사용한다. 로컬 전용 `local_export_state`(project_id·exported_at·bundle_hash·state)를 둔다.
  - [ ] `web/src/routes/imports.ts`에 `POST /imports`·`POST /imports/{id}/complete`·`POST /imports/{id}/activate`를 만든다. `web/src/services/import.ts`와 `web/src/workflows/import.ts`가 청크·재개·검증을 맡는다.
  - [ ] `scripts/pes.py`의 `export --bundle`·`import`를 확장하고, `cmd_export`·`cmd_import`·`CMDS`에 `web-import`를 추가한다. `scripts/bundle.py`에 manifest·sha256·int64 문자열 검사를 둔다.
  - [ ] `web/src/services/bundle.ts`가 R2 멀티파트 업로드·sha256 검증·`blobs.state='ready'`·`version_files` 연결을 하게 한다.
  - [ ] `web/src/routes/files.ts`와 `web/src/services/files.ts`에 사람용 짧은 서명 URL·프로젝트 검사, Go/에이전트용 정책 프록시를 둔다.
  - [ ] 1시간 1회 `import_tokens`(owner 발급, step-up)로 CLI 업로드 인증. 에이전트 키로는 가져올 수 없게 한다.
  - [ ] `web/src/views/import/wizard.ts`와 `report.ts`에 동결·미리보기·검증 보고서·활성화·롤백을 둔다.
  - [ ] 청크는 D1 바인딩 100·SQL 100KB·행 2MB·호출당 쿼리 50에 맞추고, Workflows 3,000 step/일을 넘으면 CI `wrangler d1 execute`/batch로 대체한다.
- **선행**: WEB1·WEB2·WEB3, PR 3·9·11·12·15·16·17.
- **완료 기준**
  - [ ] `python -m pytest -q tests/test_bundle.py tests/test_import.py`
  - [ ] `npm --prefix web run test -- --run test/import`
  - [ ] `npm --prefix web run test:e2e -- import.spec.ts`
  - [ ] 2MB JSON·깨진 참조·이미지 합성 이전, 중단 후 재개, FK/순환·ID 충돌·중복 영수증, 부분 적재 비표시, 활성화 응답 유실 시 자동 해제 금지, 쓰기 전/후 롤백, 프로젝트 단위 복원, 활성화 뒤 로컬 쓰기 0건이 통과한다.
- **지킬 것**: 양방향 동기화·이중 쓰기를 하지 않는다. 옮기는 프로젝트만 동결한다. 실제 자료는 사용자 승인 1개만, 활성화는 WEB10·WEB11·WEB14 뒤에 한다. 실제 manifest·경로·수신자·백업·로그를 공개 저장소·CI artifact에 넣지 않는다.

## WEB10 — 운영·백업·복구

### [5단계] 운영·백업·복구 — D1 export·R2·복원 훈련

- **목표**: staging/prod 배포, 앞으로만 가는 마이그레이션, 야간 암호화 백업, 복구 훈련을 운영 가능하게 만든다.
- **할 일**
  - [ ] `web/migrations/0010_ops.sql`에 `ops_backup_runs`·`ops_audit_log`·`ops_incidents`를 만든다.
  - [ ] `.github/workflows/backup.yml`과 `ops/backup/export.sh`·`restore.sh`·`verify.sh`를 만든다. `wrangler d1 export --remote` → gzip → age → R2 업로드 순서로 하고, DB 경계+객체 hash manifest를 같은 묶음으로 만든다.
  - [ ] `web/src/services/ops.ts`에 백업 나이·누락 객체·마지막 복원 훈련을, `web/src/routes/ops.ts`·`web/src/views/ops/status.ts`에 상태를 둔다.
  - [ ] `web/wrangler.toml`의 staging/prod를 분리하고, `web/migrations/README.md`에 expand/contract·구버전 앱/신스키마 호환 창을 적는다.
  - [ ] `ops/r2-lifecycle.json`에 `staging/` 30일·`quarantine/` 30일·백업 보존을 둔다. age 키는 백업 버킷과 분리해 오프라인/별도 시크릿에 보관한다.
  - [ ] `web/src/services/health.ts`와 외부 uptime으로 5xx·p95·D1 rows·Queue 적체·runner 마지막 확인·알림 실패·백업 나이를 경보한다.
  - [ ] `docs/operations/runbook.md`에 복원 시 커서·lease·세션·토큰·예산·알림 상태 처리를 적는다.
- **선행**: WEB1.
- **완료 기준**
  - [ ] `npm --prefix web run test -- --run test/ops`
  - [ ] `python -m pytest -q tests/test_ops.py`
  - [ ] `bash ops/backup/export.sh --dry-run`
  - [ ] `bash ops/backup/restore.sh --scratch`
  - [ ] Time Travel 7일+야간 export로 RPO 24h·RTO 4h 훈련, 42개 백업 압축 크기 합+객체 ≤8GB, DB 350MB 분리·500MB 캡, 프로젝트 단위 복원, 키 별도 복구, 마이그레이션 롤백 1회, 런북 재현이 통과한다.
- **지킬 것**: 실제 자료·백업·키를 공개 저장소·CI artifact에 넣지 않는다. 마이그레이션을 되돌리지 않고 새 마이그레이션으로 복구한다. export 중 요청 차단을 안내한다. 백업은 DB만이 아니라 객체 hash 목록을 포함한다.

## WEB11 — 보안 강화·점검

### [5단계] 보안 강화·점검 — Free 범위의 앱·플랫폼 방어

- **목표**: 공개 HTTPS에서 OWASP ASVS L1 수준의 앱 방어를 갖추고, Free에서 쓸 수 있는 플랫폼 방어만 겹친다.
- **할 일**
  - [ ] `web/src/middleware/security.ts`에 HSTS·CSP(nonce)·`frame-ancestors 'none'`·`X-Content-Type-Options`·Referrer-Policy·Origin/Referer 검사·CSRF 이중 제출 토큰을 둔다.
  - [ ] `web/src/services/validation.ts`와 `web/src/views/markdown.ts`에 입력 스키마·Markdown 안전 렌더·위험 URL 차단을 둔다.
  - [ ] `web/src/services/files.ts`에 MIME·크기·`quarantined` 격리·사람용 서명 URL·Go 정책 프록시를 넣는다.
  - [ ] `web/src/middleware/rate-limit.ts`에 로그인·매직링크·토큰·일반 API 예산을 둔다.
  - [ ] `.github/workflows/security.yml`에 의존성 감사·시크릿 스캔을, `ops/security/asvs-checklist.md`에 ASVS L1 판본·범위·결과를 둔다.
  - [ ] `ops/cloudflare/free-security.md`에 Free WAF·rate limiting·Bot Fight Mode 범위를 확인해 적는다. Bot Management는 쓰지 않는다.
  - [ ] `web/test/security/*.test.ts`와 `web/e2e/security.spec.ts`를 만든다.
- **선행**: WEB2·WEB4·WEB5·WEB8·WEB9.
- **완료 기준**
  - [ ] `npm --prefix web run test -- --run test/security`
  - [ ] `npm --prefix web run test:e2e -- security.spec.ts`
  - [ ] `python -m pytest -q`
  - [ ] ASVS L1 체크, 치명·높음 0, CSRF/XSS/클릭재킹/토큰 유출 시험, 공개 버킷 0, Go 프록시 우회 0, 다른 프로젝트 참조·system 위장·공유 기기 캐시 시험, 401/403 폭주 경보가 통과한다.
- **지킬 것**: 유료 Bot Management·WAF를 전제로 하지 않는다. UI 숨김을 권한으로 쓰지 않는다. `assurance=verified`를 플래그만으로 만들지 않는다. 실제 키·자료를 로그·fixture에 넣지 않는다.

## WEB12 — 무료 한도·사용량 계기

### [5단계] 무료 한도·사용량 계기 — 80% 경보·90% 완화

- **목표**: Workers·D1·R2·Queues·Workflows·메일 사용량을 계측하고, 무료 한도 안에서 완화·경보하게 한다.
- **할 일**
  - [ ] `web/migrations/0012_usage.sql`에 `usage_metrics`·`usage_limits`·`usage_reports`를 만든다.
  - [ ] `web/src/services/usage.ts`가 Workers 요청·CPU 초과·D1 rows/저장·R2 작업/저장·Queues ops·Workflows step·Resend 사용량을 수집하게 한다.
  - [ ] `web/src/workers/usage-collector.ts`가 Cron/Queue로 일일 집계하고 `usage_reports`에 남긴다.
  - [ ] `web/src/services/degrade.ts`에 80% 경보, 90%에서 폴링 간격 확대·비필수 알림/백업 연기·새 run 차단을 둔다.
  - [ ] `web/src/services/budget.ts`에 A run·단계·프로젝트 누적 예약/정산, unknown 예약 유지, 2단계 상한 승계를 둔다.
  - [ ] `web/src/routes/ops/usage.ts`와 `web/src/views/ops/usage.ts`에 사용률·unknown·완화 상태를 표시한다.
  - [ ] `.github/workflows/usage-report.yml`과 `docs/operations/usage.md`를 만든다.
- **선행**: WEB1·WEB8, WEB6/7 계약 또는 가짜 runner.
- **완료 기준**
  - [ ] `npm --prefix web run test -- --run test/usage`
  - [ ] `python -m pytest -q tests/test_budget.py`
  - [ ] `npm --prefix web run test:e2e -- usage.spec.ts`
  - [ ] 월 1회 보고서, 100k/일·5M 읽기/일·10만 쓰기/일·5GB·10GB·10k ops/일·3,000 step/일 대비 사용률, 80/90% 동작, unknown을 0으로 표시하지 않음, A 상한 승계, 가짜 runner 순환 회피가 통과한다.
- **지킬 것**: 유료 기능에 의존하지 않는다. "새 run 차단"을 한도 준수의 증명으로 표시하지 않는다. unknown 비용을 무료로 표시하지 않는다. 사용자 결정 없이 유료로 전환하지 않는다.

## WEB13 — WebMCP 재검토

### [5단계] WebMCP 재검토 — 날짜 있는 결정

- **목표**: 2026-11 기준 표준·브라우저·에이전트 지원을 다시 확인해 5단계 지원 여부를 결정한다.
- **할 일**
  - [ ] `docs/plan/research/webmcp-2026-11.md`에 1차 출처·확인 날짜·미확인을 구분해 적는다.
  - [ ] 3단계 W1(WebMCP 실험) 결과를 입력으로 읽고, 구현 성공을 5단계 지원 근거로 쓰지 않는다.
  - [ ] `web/src/webmcp/detect.ts`에 `document.modelContext` 기능 감지, `web/src/webmcp/tools.ts`에 읽기·답 초안·첨언 도구만(도입 시) 둔다.
  - [ ] `web/src/config/capabilities.ts`에 `webmcp: "unsupported"|"experimental"`을 둔다.
  - [ ] `web/test/webmcp/*.test.ts`와 `web/e2e/webmcp.spec.ts`(도입 시)를 만든다.
  - [ ] `docs/plan/decisions/0007-webmcp.md`에 채택·보류·실험 결정과 재검토 조건을 적는다.
- **선행**: WEB2·WEB11.
- **완료 기준**
  - [ ] `npm --prefix web run test -- --run test/webmcp`
  - [ ] `npm --prefix web run test:e2e -- webmcp.spec.ts` (도입한 경우)
  - [ ] 날짜 있는 결정 기록, 3단계 W1 입력, capabilities 표시, 승인류 미노출, browser_agent 감사, 서버 거부가 확인된다.
- **지킬 것**: 승인·reopen·판 시작·정책·토큰·삭제를 노출하지 않는다. `toolautosubmit`을 쓰지 않는다. 브라우저 도구가 사람의 승인 증거가 되게 하지 않는다. 근거 없이 지원을 주장하지 않는다.

## WEB14 — 전환 통합 검증·문서

### [5단계] 전환 통합 검증·문서 — Free A/B 종단

- **목표**: Free 플랜에서 A/B, 이전·롤백, 알림, 한도, Windows/Mac, 문서를 한 번에 검증한다.
- **할 일**
  - [ ] `web/e2e/full.spec.ts`에 로그인→질문→답→승인→reopen→인쇄→이전→롤백 흐름을 둔다.
  - [ ] `tests/test_web_transition.py`와 `tests/fixtures/web/`에 합성 프로젝트·깨진 참조·2MB JSON·이미지 fixture를 둔다.
  - [ ] `docs/operations/runbook.md`·`user-guide.md`·`rollback.md`·`free-limits.md`를 완성한다.
  - [ ] `ops/drills/`에 복원·runner 오프라인·토큰 회수·Go OFF·알림 실패 훈련 스크립트를 둔다.
  - [ ] `.github/workflows/web-ci.yml`에 Windows+macOS, Playwright, `pytest`를 매 PR+main으로 돌린다.
  - [ ] `web/playwright.config.ts`에 Windows Playwright 필수·스크린샷 기준선 없음·수동 IME/인쇄 체크리스트를 둔다.
  - [ ] `docs/plan/decisions/0005-web-platform.md`에 Free 한도 측정값·비용 $0·탈출 조건을 최종 기록한다.
  - [ ] 승인 경계를 "실제 자료 업로드 전 / 운영 전환 전 / 무료 한도 초과로 유료 전환 전"으로 나누고, 완료 뒤 소급 승인으로 쓰지 않는다.
- **선행**: WEB0~WEB13.
- **완료 기준**
  - [ ] `python -m pytest -q`
  - [ ] `npm --prefix web run test -- --run`
  - [ ] `npm --prefix web run test:e2e`
  - [ ] 5절 게이트 전부, Free 플랜만 사용, A/B 인계·경합·지연·OFF·예산·유실/중복, U2~U6 웹 동등성, Windows/Mac·수동 IME/인쇄, 실제 산출물 비공개가 통과한다.
- **지킬 것**: 유료 기능에 의존하지 않는다. 실제 자료·경로·수신자·백업·로그를 공개 저장소·CI artifact에 넣지 않는다. 승인 경계를 소급 적용하지 않는다. 로컬 모드 프로젝트를 깨지 않는다.

## 등록 메모

- 이슈 수: **15개(WEB0~WEB14)**. `WEB2`·`WEB7`·`WEB9`·`WEB10`은 크므로, 구현 중 **독립 배포·검증이 가능할 때만** 나눈다.
- 모든 이슈는 이 문서의 **공통 규칙·경로 가정·테스트 명령**을 각 Linear 본문 첫머리에 함께 복사하고, 체크리스트와 완료 기준을 그대로 옮긴다. PR 본문에는 완료 기준의 테스트 명령을 붙인다.
- 실제 자료를 쓰는 시험은 WEB9 활성화 직전 사용자 허용 1개로 제한하고, 그 전까지는 합성 fixture만 쓴다.
