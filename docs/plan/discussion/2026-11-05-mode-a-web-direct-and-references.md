# 2026-11-05 방식 A 정의 정정, 방식 B 흐름, 이전 프로젝트 참고자료

- 입력: 사용자 요청 2차(2026-11-05), 같은 날 1차 Go 구독·B 앱 변경 기록 위에 이어서 수정
- **최종(8차)**: 2단계 25·3단계 11·4단계 9·5단계 16·6단계 9, 신규 70+기존 31=101, DDL **61표**. 아래 98개·60표 등은 2차 시점 기록이다.
- 범위: `docs/plan`만 수정. 실제 `~/pes-projects`·`~/.pes/`는 읽거나 쓰지 않았다. 커밋·push·Linear 등록은 하지 않았다.

## 1. 방식 A 정의 정정

- **A = 사람이 웹 PES 대시보드에서 프로젝트 생성부터 작업까지 하고, 사람의 컴퓨터 연결 없이 PES 자체가 OpenCode Go API를 직접 호출해 AI와 작업하는 방식**으로 고쳤다. 2단계 로컬 PES도 같은 직접 호출 계약을 쓴다.
- opencode 프로그램(serve·CLI)과 로컬 runner를 A에서 뺐다. 1차 수정의 "opencode serve 경유만, 직접 HTTP 금지" 문구는 폐기했다.
- PES가 Go HTTP API(`https://opencode.ai/inference/go/...`, 모델 목록 `.../v1/models`)를 직접 호출하고, 모델별 OpenAI 호환·Anthropic·Google 형식을 쓴다. PES 고유 user agent와 대화별 안정적인 `x-opencode-session`을 보낸다. **Go 이용 조건·남용 감시 적합성은 확인 필요 위험**으로 남겼다.
- PES가 **에이전트 루프**(맥락 조립 → 모델 호출 → JSON 검증 → 업무 명령 저장 → 질문 → `waiting_human` → 재개)를 직접 소유한다. 모델 도구는 **맥락 읽기·결과 제출·질문**만이고 파일·셸·임의 네트워크 도구는 없다.
- Go 키는 로컬 OS 키체인, 웹 Cloudflare Worker secret에 둔다. 로그·프롬프트·응답에 넣지 않는다.
- 사용량 보호는 **한도 초과 오류 즉시 멈춤 + 호출별 토큰 추정(월 100%·주 50%·5시간 20% 대비) + 확인되면 공식 사용량 API 우선**으로 바꿨다. 문턱은 기본 90%, `resetsAt` 표시, unknown fail-closed, Extra Usage 끄기 안내, 과금 표시 시 중단.
- 모델 선택·폴백 없음은 유지했다. 기본 `opencode-go/deepseek-v4.1-flash`, provider `opencode-go` 고정, run마다 하나, `runs.model` 기록.
- Go 전송 스위치는 A가 모든 호출을 하므로 **호출마다** 검사한다.
- 조사 단계 웹 검색은 Go 모델에 없으므로 (a) 무료 검색 API, (b) 조사 단계만 B, (c) 사람 첨부를 사용자 결정 항목으로 올리고 **(c) 기본 추천**을 적었다.
- 5단계 A는 **Cloudflare Workers + Workflows**로 실행한다. 모델 호출 1회=step 1개, step당 CPU 10 ms·step 1,024·동시 100·subrequest 50·3일 보존·상태 100 MB, fetch 대기 CPU 미포함, Workers 100k/일을 설계에 반영했다. 무거운 렌더링은 step 밖으로 뺀다. WEB0에서 10 ms 검증·저장과 Python Workers를 실측한다.
- 플랫폼 대안 비교(Cloudflare 무료 / Vercel Hobby: 300초·Active CPU 월 4시간·개인·비상업 / Supabase 무료: 150초·CPU 2초·비활성 1주 / Oracle Cloud: 미확인)를 `stage-5.md` 2.4에 넣고 **Cloudflare 유지 추천**을 적었다.
- `stage-5.md`의 2.4·3절 비교표·WEB6·WEB7을 "로컬 runner/opencode supervisor"에서 **웹 A 실행기(Workflows)·A 에이전트 루프·사용량**으로 다시 썼다. 이슈 수는 5단계 15개 그대로다.
- SEL-18의 opencode serve 시험은 **Go 구독 cost=0 확인 근거로만** 남기고 A 설계 근거에서 뺐다.
- 1단계 확정 문서(`stage-1-runners.md`) 상태줄에 **"1단계 확정 문서를 사용자 정의 정정으로 개정(2026-11-05)"** 을 적었다.

## 2. 방식 B 흐름 명시

- **B = 사람 컴퓨터의 Claude Code 등(skill·plugin, 예 `/pes:start`)으로 프로젝트를 만들어 웹 PES에 등록하고, 그다음부터 사람은 웹 대시보드에서 작업하는 방식**으로 명시했다. 실제 모델은 사람 컴퓨터에서 돌고, MCP/WebMCP/API로 연결된다. AI가 꺼져 있으면 **"AI 미접속 · 대기 중"** 으로 표시하고 켜면 이어서 한다. 2단계 로컬에서는 같은 흐름을 로컬 PES에 등록한다.
- 도구 6가지(Claude Code·Claude 앱·Codex CLI·Codex 앱·OpenCode TUI·OpenCode 앱)는 1차 수정 그대로다.
- WebMCP는 기존 `research/webmcp.md`·`webmcp-tools.md`의 제한된 allowlist(읽기·초안·첨언)를 유지한다고 다시 적었다.
- `00-brief.md`, `stage-2.md` 2.8, `stage-5.md` 1·2.5·3절, `summary-for-approval.md`에 같은 흐름을 넣었다.

## 3. 이전 프로젝트 참고자료(REF1)

- 새 프로젝트를 만들 때 또는 만든 뒤 언제든, 사람이 이전 프로젝트(하나 이상)를 골라 **특정 스냅숏 버전에 고정한 읽기 전용 참고자료**로 붙인다. 복사·이전이 아니고 원본을 수정하지 않는다.
- 붙일 항목은 최종/단계 보고서, 조사 출처, 결정 기록, 질문·답, 첨부 파일이며 기본은 **최종 보고서 + 조사 출처**다.
- 원본에 새 버전이 생기면 "새 버전 있음"을 표시하고 사람이 갱신한다. 원본 삭제·보관 시 참조는 남고 `source_missing`("원본 없음")으로 표시한다. 붙일 때 스냅숏을 고를 수 있다.
- **두 프로젝트 모두 접근 권한이 있는 사람만** 붙인다. 6단계 여러 사람일 때 권한 없는 사람에게는 내용 대신 "권한 없음"을 표시한다.
- 원본 프로젝트가 Go 전송 OFF이면 그 참고자료는 A에서 Go로 보내지 않는다(**엄격한 쪽 우선**). B 목적지에도 원본 허용 범위를 표시한다.
- 맥락 조립 때 참고자료 목록·요약을 넣고 본문은 필요할 때 읽기 도구로 읽는다. 결과물 인용에 참조 프로젝트·버전을 표시한다.
- `/pes:start --import`와 2단계 PR11 legacy importer(이전·옮기기)와 구분한다.
- DDL에 `project_references`를 추가했다. 참조 프로젝트·원본 프로젝트·`source_snapshot_id?`·`source_label`·`latest_snapshot_id?`·`scope_json`·상태·붙인 사람/시각·rev, 원본 스냅숏 FK, 자기 참조 금지. 원본 스냅숏 삭제 시 `SET NULL`로 참조를 남긴다.
- 3단계 새 이슈 **REF1**로 붙임·떼기·갱신 명령/API/조회, 프로젝트 생성 화면 UI, 권한·전송·인용 시험을 맡긴다. 5단계 웹은 같은 API·표를 WEB1·WEB9 이전 범위에 포함하고 별도 WEB 이슈를 만들지 않는다.
- 표 수는 54→55로 갱신하고 `stage-1-db.md`·`stage-1-ui.md`·`stage-2.md`·`issues/stage-2.md`·`stage-4.md`·`stage-5.md`·`roadmap.md`·`summary-for-approval.md`·`README.md`·`ddl-gaps.md`·`spikes/web0-plan.md`를 맞췄다.

## 4. 이슈 수·의존

- 2단계 24개(PR1~19, 20a, 20b, 20c, 21, 22)
- 3단계 10개(U1~U6, **REF1**, W1, R1, T1)
- 5단계 15개(WEB0~WEB14, A는 WEB6·WEB7로 유지)
- 전체 **98개**(SEL-1~31 31 + 2~6단계 신규 67), Linear 260 한도에 **162개 여유**
- 누적: 2단계 뒤 55, 3단계 뒤 65, 4단계 뒤 74, 5단계 뒤 89, 6단계 뒤 98
- REF1은 U1·PR1·4·7·13·14 뒤, T1은 U1~U6·REF1 뒤에 둔다.

## 5. 바꾼 파일

- `docs/plan/decisions/0013-mode-a-go-subscription-and-model-choice.md` (전면 개정)
- `docs/plan/decisions/0001-opencode-go-transfer.md`
- `docs/plan/decisions/0002-mode-a-deepseek.md`
- `docs/plan/decisions/0003-mode-b-agents.md`
- `docs/plan/decisions/0009-stage-1-design-approval.md`
- `docs/plan/decisions/0012-mode-b-codex-opencode-tui-stage2.md`
- `docs/plan/decisions/0014-mode-b-codex-app-opencode-app.md`
- `docs/plan/decisions/README.md`
- `docs/plan/schemas/stage-1-ddl-draft.sql`
- `docs/plan/schemas/check_ddl.py`
- `docs/plan/stage-1-runners.md`
- `docs/plan/stage-1-db.md`
- `docs/plan/stage-1-api.md`
- `docs/plan/stage-1-ui.md`
- `docs/plan/stage-2.md`
- `docs/plan/stage-3.md`
- `docs/plan/stage-4.md`
- `docs/plan/stage-5.md`
- `docs/plan/stage-6.md`
- `docs/plan/issues/stage-2.md`
- `docs/plan/issues/stage-3.md`
- `docs/plan/issues/stage-4.md`
- `docs/plan/issues/stage-5.md`
- `docs/plan/issues/stage-6.md`
- `docs/plan/roadmap.md`
- `docs/plan/summary-for-approval.md`
- `docs/plan/00-brief.md`
- `docs/plan/README.md`
- `docs/plan/glossary.md`
- `docs/plan/ddl-gaps.md`
- `docs/plan/spikes/web0-plan.md`

## 6. 검사 결과

- `python3 docs/plan/schemas/check_ddl.py` → **PASS**
  - DDL 실행, **55개 표** 합성 적재, 거부 사례 **51개**, 대표 조회 3개, 0행 CAS·늦은 실패 롤백, `foreign_key_check`·`integrity_check` 통과
  - D1은 미시험(기존과 동일)
- `python3 docs/plan/fixtures/check_fixtures.py` → **검사 통과 38/38**
- `git diff --check` → 오류 없음

## 7. 남은 확인

- Go HTTP API의 실제 요청·응답 형식, 모델별 형식, 한도 오류 형식, 사용량 API 존재 여부는 PR19·SEL-18에서 실측한다.
- PES의 사용이 Go 이용 조건·남용 감시에 맞는지 확인 필요 위험으로 남아 있다.
- Cloudflare Workflows의 step 10 ms 안에서 응답 검증·저장이 되는지는 WEB0에서 실측한다.
- Codex 앱·OpenCode 앱의 설정 공유 여부는 PR20c에서 실제 시험한다.
- REF1 원본 삭제·보관 시 `source_missing` 표시와 권한 비노출은 3단계 REF1에서 시험한다.

## 3차 — 비상업 전제와 플랫폼 후보

- PES는 **비상업 용도**임을 확인했다. Vercel Hobby의 "개인·비상업" 제약은 **충족**이며, Vercel Hobby+Turso를 Cloudflare 무료와 **동등 후보**로 올렸다.
- WEB0 판정 기준을 ① A 한 라운드 ② 코어 재사용 ③ SQLite 계약 ④ 월 여유 ⑤ 카드 등록 ⑥ 상시 양방향 통로 ⑦ 운영 부담 ⑧ 월 비용으로 정리했다.
- 추천은 "무료로 다 되면 Cloudflare, 막히면 작은 VPS, Vercel은 중간 대안"이며 최종은 WEB0 실측 후다. `stage-5.md` 2.1·2.4, `roadmap.md`, `summary-for-approval.md`, `decisions/0005`에 반영했다.

## 4차 — 내 자료 올리기·AI 참조 스위치(MAT1)

- 3단계 새 이슈 **MAT1**을 추가했다. hwp/hwpx/pdf/xlsx/xls/pptx/ppt/docx/doc/txt/md/csv 업로드, 원본 보존·버전/hash, 형식별 글자·표 추출, 사람 미리보기.
- txt/md/csv는 그대로, docx/pptx/xlsx/hwpx는 XML, pdf는 텍스트층. 스캔 PDF OCR은 나중 선택. **hwp/doc/ppt/xls는 시험 후 결정**이고 안 되면 hwpx/docx로 저장해 다시 올리라고 안내한다.
- 파일마다 `ai_access` **allow/deny, 기본 allow**(2026-11-05 사용자 결정). 소유자만 변경·불변 이력, 프로젝트별 기본값 없음. 올리는 화면과 목록에서 바로 변경.
- **deny 파일은 A Go 맥락과 B MCP/WebMCP/API 도구 응답에 내보내지 않는다.** 사람은 화면에서 보고 직접 인용할 수 있다. 금지 전에 만든 결과물에 표시하고, 이미 나간 내용은 회수 불가로 표시한다.
- Go OFF·참조 원본 파일 OFF는 **엄격한 쪽 우선**. `project_references`로 붙은 파일도 원본 스위치를 따른다.
- DDL: `version_files`에 `ai_access`·`ai_access_rev`, `file_ai_access_versions`, `file_extractions` 추가. 표 수 60.
- 추출은 **브라우저/로컬 기본**, 크기·개수 상한, R2/Blob 무료 한도 자기 제한. hwpx 입력은 6단계 hwpx 출력과 별개다.
- 5단계는 같은 API·표를 WEB1·WEB9 이전 범위에 포함하며 별도 WEB 이슈를 만들지 않는다.

## 5차 — B 양방향·연결 도우미

- B를 **양방향**으로 고쳤다. PC→웹 자료 업로드·진행/스케줄 보고, 웹→PC 자료 내려받기·MCP 읽기. 연결은 PC 발신 아웃바운드, 데이터는 양방향. "한 방향" 표현을 없앴다.
- `pes link`/`pes sync` **연결 도우미**(선택 상주)를 둔다. AI 도구가 꺼져 있어도 동기화·현황·알림을 유지하고, A 실행기는 아니다.
- 동기화는 버전·hash, **조용한 덮어쓰기 금지**, 충돌 표시·사람 선택, 삭제는 표시만, 프로젝트별 폴더, 큰 파일·개수 상한, R2/Blob 한도 재사용. AI deny 파일은 사람은 받지만 MCP 도구는 AI에 안 준다.
- 대시보드: "내 컴퓨터" 카드·작업 타임라인(완료/진행/예정)·동기화 상태. 연결 끊김은 "상태 미상".
- DDL: `sync_links`, `sync_items`, `agent_schedules` 추가. 진행 이벤트는 기존 `events`의 `execution.progress.*`로 확장.
- 2단계 PR20a 공통 bridge에 진행·스케줄 형식·`pes link`/`sync` 로컬 계약을 포함하고, 5단계 **WEB15**가 웹 전달·대시보드·동기화를 맡는다.

### 5차 보강 — 통로 역할

- **웹소켓 = PC 연결 도우미 ↔ 웹 PES의 상시 양방향 통로(기본).** 새 작업·자료·답을 즉시 밀고, 진행·스케줄·동기화 상태를 올린다. 끊기면 자동 재접속·마지막 커서부터(유실 0, 중복 멱등). 큰 파일은 HTTP.
- Cloudflare: Free DO(SQLite 기반, 일 100k 요청, 저장 5GB·객체 1GB), **WebSocket Hibernation**으로 유휴 연결 비용 없음. 바깥으로 거는 WS는 hibernation을 막고(2차), 메모리 상태는 `serializeAttachment`/저장소에 둔다. 메시지 수 집계는 미확인→WEB0/WEB1 실측, WEB12 계상.
- Vercel: WebSocket 공개 베타, Hobby 300초 후 연결 종료·약 5분 재접속.
- 대체: SSE(웹→PC)+HTTP(PC→웹), 그다음 짧은 폴+ETag. 같은 이벤트 형식·커서.
- **MCP** = AI 도구 6가지가 PES 기능을 쓰는 표준 약속. **WebMCP** = 브라우저 탭 안 AI가 열린 페이지 기능을 제한 allowlist로 쓰는 보조 경로. PC↔웹 통로가 아니다. `stage-5.md` 2.5.1과 `summary-for-approval.md`에 3통로 표를 넣었다.

## 6차 — 플랫폼 후보 3군

- ① 서버리스 무료: Cloudflare / Vercel Hobby+Turso. ② 작은 VPS: Oracle Always Free(공식: **1,500 OCPU-h·9,000 GB-h/월=상시 2 OCPU·12GB**, 7일 CPU p95·네트워크·A1 메모리 각 20% 미만 회수 기준, 지역 재고·카드 확인 필요) → Hetzner CX22 월 €4~5는 **WEB0 견적(미확인)**. ③ 기타 PaaS: Render·Railway·Fly.io·Koyeb·Deno Deploy·Supabase(잠듦·시간 제한으로 A 상시 실행 부적합).
- 운영 부담은 컨테이너 1개+자동 업데이트+Cloudflare Tunnel(무료)+기존 백업으로 줄인다.
- WEB0는 **최종 후보 3개(Cloudflare / Vercel+Turso / 작은 VPS)** 를 같은 합성 시나리오로 실측하고 8개 기준으로 고른다. 추천은 "무료로 다 되면 Cloudflare, TS 실행성·실시간 통로가 막히면 작은 VPS, Vercel은 중간 대안". 월 비용은 기존 유료 전환 승인과 합친다.
- `stage-6.md`에 별도 VPS runner 항목은 없었고, 로드맵·요약의 VPS/호스팅 항목을 이 비교로 흡수했다.

## 7차 — 언어 재검토와 무료 티어 조합

- 2단계 PR1 전이 언어를 바꾸기 가장 싼 시점임을 명시하고, TypeScript/Python/Go/Rust를 7개 기준으로 비교했다. TS는 Workers·Vercel·Deno·VPS·브라우저에서 같은 코드가 도는 장점, Python은 기존 자산·문서 라이브러리, Go/Rust는 단일 바이너리·성능이나 브라우저/문서 생태계가 약하다.
- 추천 초안은 **TypeScript 단일 언어**(0016). 기존 Python 0.15 이전은 8차에서 확정했다.
- 무료 티어 조합 X(Cloudflare 중심+계산 보조), Y(VPS 중심+Cloudflare 앞단), Z(Vercel+외부 무료)를 비교했다. **자료 원본은 한 곳**, 다른 곳은 계산·캐시·백업만. 추천 초안은 **X**.

## 8차 — 기존 Python 0.15도 TypeScript로

- 0016을 **TypeScript 단일 언어 — 사용자 방향 확정, 런타임·세부는 짧은 시험 후**로 갱신했다. 로컬 CLI·스킬·서버·웹·브라우저 글자 뽑기·A·연결 도우미를 모두 TS로 둔다. Python/Go/Rust는 기각 이유를 한 줄씩 적었다.
- 0.15 Python(`pes.py`·`serve.py`·설치 스크립트·pytest·skills/commands의 `python3 scripts/pes.py ...`)을 **동결(치명 수정만)** 하고 TS로 옮긴다. 같은 입력→같은 출력(질문 화면·보고서·`project.json` 처리·CLI 출력), 테스트 이전·차이 0, 설치 Windows/Mac, Python 제거, 0.16.0 단일 코드베이스.
- 2단계 **PR26**을 추가했다(2단계 25개). legacy importer는 옛 데이터 형식만 읽고 Python 코드를 실행하지 않는다. 외부 도구(kosis·vworld·korean-law)의 Python 요구는 외부 도구 경계로 남긴다.
- 8차 보강: "같은 언어" 조건은 사실상 TypeScript만 만족하므로 0016을 TS 단일 언어로 확정 방향으로 썼다. stage-2 이후 문서의 `python`·`pytest` 명령은 0.15 이전 대상/예시로 표시하고, 새 테스트 러너는 언어 시험 후 확정한다.

## 최종 수·검사

- 2단계 25개(PR1~19, 20a, 20b, 20c, 21, 22, 26)
- 3단계 11개(U1~U6, REF1, MAT1, W1, R1, T1)
- 5단계 16개(WEB0~WEB15)
- 전체 101개, Linear 여유 159개. 누적 56/67/76/92/101.
- DDL **61개 표**, `check_ddl.py` **PASS**(**거부 64, 2026-11-05 재검수 기준**; 59는 이전 61표 검사 시점), `check_fixtures.py` **38/38**.

완료: docs/plan/discussion/2026-11-05-mode-a-web-direct-and-references.md
