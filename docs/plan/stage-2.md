# 2단계 새 뼈대(로컬) — 계획서

- 작성: 2026-11-05, OpenCode (`opencode-go/deepseek-v4.1-flash`)
- Linear: SEL-25
- 입력: [00-brief.md](00-brief.md), 확정 [stage-0.md](stage-0.md), 합의 [stage-1-db.md](stage-1-db.md)·[stage-1-api.md](stage-1-api.md)·[stage-1-ui.md](stage-1-ui.md)·[stage-1-runners.md](stage-1-runners.md), [DDL 초안](schemas/stage-1-ddl-draft.sql)
- 상태: **확정 — 사용자 승인 2026-11-05.** 같은 날 사용자 정의 정정(방식 A·B, 새 기능, TypeScript 단일 언어, 플랫폼 후보)과 Codex 검수 3회(`discussion/2026-11-05-codex-review{,-2,-3}.md`) 반영
- 2026-11-05 사용자 결정: **방식 B의 Codex CLI·OpenCode TUI 어댑터를 2단계 PR20b로 앞당긴다.** Claude Code·Claude 앱 보장은 그대로다. **A는 PES가 Go API를 직접 호출하는 내장 실행기**이고, 사람이 직접 켜는 **OpenCode TUI·OpenCode 앱**과 구분한다.
- **0016 언어 결정**: 새 코어와 기존 0.15를 **TypeScript 단일 언어**로 옮긴다. 아래의 `python`·`pytest` 명령은 **0.15 이전 대상 또는 현재 예시**이며, 새 테스트 러너·패키지 관리자는 언어 시험 후 확정한다. **테스트 공통 기반은 PR1에서 정할 TS fixture 헬퍼: `isolated_home`·`cli`·`synthetic_project` 대응**이고, Python `tests/conftest.py`는 PR26 이전 대상이다. PR26이 이전을 맡는다.
- 전제: 2026-11-05 03:31 `main` 기준. SEL-11(`tests/`, `f6e9c37`)·SEL-16(`e015ff4`)·SEL-17(`82c6de5`)은 병합됐고, SEL-12~15·18·19는 hc-team worktree에서 진행 중이며 `AGENTS.md`·`spikes/`는 아직 없다. **0단계 게이트(S0 6절) 충족 전에는 PR1에 착수하지 않는다.**
- 범위: 정적 HTML → 로컬 SQLite + API 서버. 새 작업 공간 디자인(3단계)과 새 소통 기능은 넣지 않는다. 이 문서는 계획만 바꾸며 코드는 고치지 않는다.

## 1. 목표

**v0.15.6의 사용자 결과와 상태 전이를 유지한 채, 상태의 원본을 `project.json`에서 로컬 SQLite로 옮기고 모든 쓰기를 하나의 검증된 명령 서비스로 모은다.** 2단계가 끝나면 다음이 증명되어 있어야 한다.

1. 합성 프로젝트가 DB에서 6단계·라운드·질문/답·승인·reopen·보고서까지 v0.15.6과 같은 의미로 돈다.
2. 기존 프로젝트는 **사본 → staging DB → 검증 → 프로젝트별 활성화**로 옮길 수 있고, 원본과 새 쓰기 전후의 되돌리기 절차가 있다.
3. CLI·스킬·화면·방식 A·B가 같은 명령 서비스와 같은 API를 쓰며, 에이전트가 `project.json`이나 DB를 직접 쓰지 않는다.
4. **A는 PES 내장 실행기로 합성 1개를 6단계까지, Claude Code는 같은 6단계, Claude 앱은 1단계 왕복·재접속, Codex CLI·OpenCode TUI는 각각 합성 1라운드+재개**를 시험한다. 모두 같은 DB·API 의미를 쓴다.
5. 실제 프로젝트 이전은 사용자가 허용한 범위에서만 하고, 공개 저장소·테스트·로그에 실제 자료를 넣지 않는다.

하지 않는 것: 새 화면 설계(3단계), 실제 다중 사용자·로그인(5단계), 운영 D1/R2(5단계), 외부 내보내기(6단계), 자동 재개(3단계 옵션), `project.json` 삭제.

## 2. 주제와 결정

stage-0 7절과 1단계 설계서의 합의 결정은 다시 정하지 않는다. 특히 전송 허용 기본 켜짐+프로젝트별 끄기, **A는 PES가 Go API를 직접 호출하고 모델은 사용자가 고른다(기본 `opencode-go/deepseek-v4.1-flash`, 결정 0013)**, B 보장은 Claude Code·Claude 앱(Codex CLI·OpenCode TUI·Codex 앱·OpenCode 앱은 2단계 PR20b·20c), 공개 CI, DB·객체 위치(`~/.pes/pes.db`·`~/.pes/objects/`), 전환 후 `project.json` 읽기 전용, 활성 판 하나, **2단계는 기존 22개 중 PR20을 20a·20b·20c로 분할하고 PR26(0.15 Python→TypeScript)을 더한 25개(결정 0012·0014·0016, `roadmap.md` 2절)**다. 아래는 2단계에서 새로 정하는 **순서·이전·경계**뿐이다.

### 2.1 작업 순서·의존 그래프·묶음

- **정할 것**: 2단계 PR(20a·20b·20c 분할 포함)을 어떤 순서와 묶음으로 내고, 무엇을 병렬로 돌릴지.
- **선택지**: (A) DB→명령→API→CLI·화면→A/B의 층별 순서, (B) 한 프로젝트를 일찍 끝까지 세로로 자르는 순서, (C) A/B 어댑터를 먼저.
- **판단 기준**: 위험을 일찍 없애는가, PR마다 테스트가 가능한가, 이중 쓰기 없이 갈 수 있는가, 0단계 게이트 뒤에 진행 가능한가, 사용자 피드백을 언제 받는가.
- **추천**: **A(층별) + PR13에서 얇은 세로 절편**. 1단계 계약이 이미 층별로 합의됐고, 가장 큰 위험은 스키마·명령 서비스·이전이며, A/B는 API·화면 뒤에만 설 수 있다.
- **PR13의 경계**: `context→claim→submit→complete`는 **한 run의 최소 경로**다. 질문·답·wait·재개가 있는 **한 라운드의 증명은 PR13+14를 함께** 본다. `complete`는 run 종료일 뿐 라운드 봉인·단계 승인이 아니다(`stage-1-api.md:21-23`).
- **0단계 조건**: PR1~18은 S0 6절 게이트 충족 뒤에만 조건부로 진행한다. PR5의 TTL·heartbeat는 **설정으로만** 두고 확정하지 않으며, **PR19는 SEL-18, PR20a·20b·20c는 SEL-19, PR21·22는 SEL-18·19** 결과 없이 착수하지 않는다(`stage-1-runners.md:110-112`).
- **WEB0 조기 인계**: **2단계 PR1 전에** 현재 언어 중립 JSON fixture와 최소 TS 시험 구현으로 5단계 번호 WEB0을 실행한다. PR4·13·14 완료는 전제가 아니다(순환 없음). 결과는 `docs/plan/decisions/0016-core-language.md`·`0005-web-platform.md`에 기록하고, TS 단일 언어 기준을 WEB1에 넘긴다. WEB0는 5단계 16개에 이미 포함되므로 **새 이슈를 더하지 않는다**(`roadmap.md` 3.1·3.2).
- **의존 그래프**(번호는 순서가 아님, `stage-1-db.md:174`):

```text
1 → 2,3,4
4 → 5,7,10
4+5+9 → 6
4+6 → 8
1+4+7 → 9
1+6+7+8+9+10 (+SEL-17) → 11
3+9+11 → 12
4+5+6+7+9+10 → 13
6+8+10+13 → 14
4+5+6+7+8+9+10 → 15
7+9+15 → 16
10+13+14+15+16 → 17
8+10+13+14+15+16 → 18
5+10+13+14+17+18 (+SEL-18) → 19
5+10+13+14+17+18 (+SEL-19) → 20a
20a → 20b
20b → 20c
18+19+20a+20b+20c → 21
1+4+13+14+15+16+17+18+21 → 26
2+12+18+21+26 (+SEL-18·19) → 22
```

- **병렬 묶음**: B0 `PR1` → B1 `PR2·3·4` → B2 `PR5·7·10` → B3 `PR9` → B4 `PR6` → B5 `PR8·13` → B6 `PR11·14·15` → B7 `PR12·16` → B8 `PR17·18` → B9 `PR19·20a` → B10 `PR20b` → B11 `PR20c` → B12 `PR21` → B13 `PR26` → B14 `PR22`. 같은 묶음 안은 서로 독립이며, 묶음 사이만 선행을 지킨다. 20a가 공통 MCP bridge·계약, 20b가 CLI·TUI, 20c가 데스크톱 앱, PR26이 TS 단일 코드베이스 이전을 맡는다.
- **추가 선행**: 9→6(스냅숏/manifest가 `blobs` FK), 7·8·9→15(질문·항목·snapshot 쓰기), 17→19(중립 workflow·역할), 2→22(D1 smoke). 이 때문에 PR6·15·19·22의 선행과 묶음을 위와 같이 고친다.

### 2.2 기존 프로젝트 옮기기

- **정할 것**: 원본을 제자리에서 바꿀지, 어디까지 사본으로 시험할지, 활성화 단위와 되돌리기 단위, 사용자 허용 범위.
- **선택지**: (A) 폴더를 그 자리에서 이동하고 한 번에 전체 전환, (B) **원본은 두고 사본 → staging DB → 검증 → 프로젝트별 활성화**, (C) 일정 기간 `project.json`과 DB에 이중 쓰기.
- **판단 기준**: 원본 무손상, 프로젝트 하나만 되돌릴 수 있는가, 실제 자료가 공개 저장소·테스트·로그에 새지 않는가, 실행 중 DB를 동기화하지 않는가(`stage-1-db.md:19`).
- **추천**: **B**. C는 `stage-1-db.md:21`의 "이중 쓰기 금지"와 충돌하므로 제외한다. 절차는 다음과 같다.
  1. **사전 점검**: `pes stop`, 다른 세션 잠금 없음, `pes doctor`, PES 버전·홈·TS 런타임/SQLite 버전·디스크 여유 기록. 백업은 PES 홈 밖(예: `~/.pes/backups/<시각>/`)에 만들되 실제 경로가 PES 홈·OneDrive 안이면 거부한다.
  2. **사본**: 프로젝트 폴더를 staging 위치로 복사한다. 원본은 읽기만 한다. **SEL-17 보존 목록을 기준**으로 `project.json`·`library.json`·`feedback/`·`feedback.log`·`snapshots/`·`reports/`·`out/`·`shots/`·`ask/`·`rounds/`·`library/`를 포함하고 `.pes-*`·`index.html` 같은 파생물은 제외한 **sha256 manifest**를 남긴다. `ask/` 폼 명세, `rounds/` 제안·검토, `library/` 참조 이미지, `feedback.log`는 원본 보존·DB 변환·참조 파일 보관·재생성 제외를 각각 구분한다. `library.json`만으로 현행 library를 설명하지 않는다. 고정 공유 HTML과 재생성 가능한 화면 파생물도 구분한다.
  3. **staging 적재**: `import_batches`(state=staging)·`legacy_mappings`로 프로젝트별 적재. 알 수 없는 필드·깨진 JSON·누락 이미지·미처리 답은 버리지 않고 보고서에 남긴다. 기본값 보완을 과거의 명시 결정처럼 꾸미지 않는다(`stage-1-db.md:129`).
  4. **검증**: 개수·본문·ID·연결·파일 hash·미처리 답·보고서 재생성. 기존 화면과 새 화면의 동등성 매트릭스(2.4)도 같은 사본으로 본다.
  5. **파일럿**: **2단계 A는 합성 자료만** 쓴다. 실제 프로젝트 파일럿은 PR22에서 사용자 허용이 있을 때만 하고, A 실행 없이 답·승인·reopen·인쇄·기존 화면을 확인한다. 실제 자료로 A를 돌리는 일은 2단계 범위가 아니다.
  6. **활성화**: 프로젝트 상태를 `active`로 바꾸는 것과 `import_batches.state=activated`는 별개다. 프로젝트별로만 활성화하고 `project.json`은 읽기 전용으로 둔다. 원본 폴더는 삭제하지 않는다.
  7. **되돌리기**: **새 쓰기 전**이면 staging 행을 버리고 원본 JSON에 다시 연결한다. **새 쓰기 후**면 프로젝트 단위로 DB+객체를 복원하고, 복원 시점 뒤 새 쓰기의 **손실 범위**를 사용자에게 알린다. 커서를 무효화하며, 여러 프로젝트가 있는 DB를 통째로 과거로 되감는 절차를 기본으로 삼지 않는다. 활성화 직전 백업으로 되돌리면 파일럿 이후 기록이 사라질 수 있음을 명시한다(`stage-1-db.md:132`).
  8. **허용 범위**: 사용자가 명시한 slug만, 한 번에 하나씩. 전체 일괄 이전·원본 삭제·실제 자료의 테스트 fixture화는 2단계에서 하지 않는다. 이 runbook은 PR12에서 합성으로 검증하고 PR22에서 실제 파일럿에 쓴다. 실제 manifest·경로·이전 보고서는 로컬에만 두고 PR에는 합성·익명 결과만 남긴다.

### 2.3 스킬 직접 편집 제거

- **정할 것**: 모든 스킬을 한 번에 바꿀지, 파일럿 뒤 넓힐지, 무엇을 lint로 막을지.
- **선택지**: (A) 전체 일괄 재작성, (B) **core+plan 파일럿 → 단계·명령·역할 전체 + lint**, (C) 문서만 고치고 직접 쓰기 예제는 남김.
- **판단 기준**: 상태 우회 경로가 0인가, 연구 절차·독립 검토·근거 확인이 유지되는가, 에이전트별 표기가 중립적인가, CI에서 재발을 막는가.
- **추천**: **B**. 이는 새 선택이 아니라 **R D4 합의 승계**다(`stage-1-runners.md:57-60`). `skills/core/SKILL.md:62-84`의 "project.json을 Python으로 읽고 쓴다" 예제를 제거하고 `pes context/submit/ask/...` 명령으로 바꾼다. lint는 **PES 업무 상태를 직접 바꾸는 경로만** 금지하고, 자식의 작업용 제안 파일·합성 테스트·신뢰된 서비스의 SQLite 구현까지 넓은 grep으로 막지 않는다. core+plan으로 합성 1회를 통과한 뒤 나머지 스킬로 넓히고, Claude 전용 표기는 어댑터 노트의 예외 위치에만 둔다. `anthropic-skills:*` 이름 변경만으로 변환 지원을 주장하지 않는다.

### 2.4 기존 화면이 새 뼈대에서 "그대로" 되는 기준

- **정할 것**: 픽셀 동일성인지, 동작·URL·데이터 동등성인지, 새 디자인을 섞을지.
- **선택지**: (A) 픽셀 기준선 비교, (B) **동작·URL·데이터 동등성 + 스모크**, (C) 이번에 새 작업 공간으로 교체.
- **판단 기준**: 사용자가 지금 쓰는 경로가 끊기지 않는가, 딥링크·인쇄·원격 답이 유지되는가, Windows/Mac에서 재현되는가, 3단계 새 디자인과 섞이지 않는가.
- **추천**: **B**. C는 3단계 범위이고, A는 유지비가 크며 픽셀 미비교의 근거는 `stage-1-ui.md:78`의 "스크린샷 기준선 없음"이다. 동등성 매트릭스에 포함할 것: 홈 프로젝트 목록, 대시보드의 전체 보기·단계 탭·AI 점검·타임라인·항목×라운드·승인·보고서, 질문 폼의 `__other`·`show_if`·필수·추천·조건부, `POST /<slug>/feedback`(로컬 서버 기준, 새 API 답 제출은 별도 표기)과 원격 Origin, **소유자 세션·CSRF**, **미제출 답 보존**, approve/reopen, 단계·최종·eli5 보고서, 인쇄 CSS, 버전 갱신, **당시 폼/세트 버전 `ask-*` 딥링크**, **`pes watch` 답 알림**. **TS 서버 렌더 테스트 + Playwright 스모크**를 쓰고 **Windows CI는 브라우저를 설치해 실행하며 없으면 실패**한다(`stage-1-ui.md:77`). 스크린샷 기준선은 만들지 않고, 알려진 차이는 PR18 문서에 남긴다.

### 2.5 `project.json`·DB 병행 기간

- **정할 것**: 이중 쓰기를 둘지, 언제 JSON을 끊을지, 옛 버전을 언제까지 둘지.
- **선택지**: (A) 일정 기간 이중 쓰기, (B) 전체 프로젝트 동시 hard cutover, (C) **프로젝트별 전환 + 미전환 프로젝트는 읽기 전용 legacy 경로**.
- **판단 기준**: 원본이 하나인가, 프로젝트별로 되돌릴 수 있는가, 옛 화면·CLI가 갑자기 끊기지 않는가.
- **추천**: **C**. 활성화된 프로젝트는 JSON 읽기 전용이고 새 쓰기는 DB에만 간다. 미전환 프로젝트는 새 코드가 `project.json`을 **읽기만** 해 `status`·`list`·기존 화면을 제공하고, 쓰기는 이전 안내로 막는다.
- **legacy 제거**: 새 기한을 두지 않는다. **미전환 프로젝트 0 확인·대체 경로(읽기·답·승인·reopen·인쇄·딥링크) 검증 뒤** 제거한다. 제거는 조건 충족 뒤 **별도 정리 PR 1개**(로드맵 예비분)로 한다. legacy JSON 읽기 경로 제거와 DB/API 기반 기존 화면 보존은 다른 일이며, 기존 화면을 3단계에 없애는 뜻으로 쓰지 않는다(`stage-1-ui.md:47,109`).
- **배포·버전**: 사용자 플러그인은 이 저장소 폴더에서 설치된다(`pes-local`, directory). **2단계 PR은 플러그인 버전을 올리지 않고, 새 DB 경로는 PR22 전까지 개발 플래그 뒤에 둔다.** 새 버전(예: 0.16.0) 배포는 PR22 통과·사용자 승인 뒤 한 번 한다. 배포 안내에는 이전 전까지 진행 중인 실제 프로젝트의 쓰기가 막힌다는 점(2.5 C)을 먼저 알리고, 그 전에 v0.15.x로 끝낼 수 있게 한다.

### 2.6 TypeScript 런타임·SQLite 하한

- **이미 고정**: 0016에 따라 새 코어는 TypeScript 단일 언어다. 런타임(Node/Bun/Deno)과 최소 버전은 언어 시험 후 정한다. 0.15 Python은 PR26에서 이전·동결한다.
- **정할 것**: DDL의 JSON 함수·SQLite 버전을 어디서 확인할지.
- **선택지**: (A) **PR1에서 실제 SQLite 버전·`json_valid`·`json_type`·DDL 실행 검사**, (B) 서비스 계층에서 JSON 검사로 대체.
- **판단 기준**: DDL이 요구하는 SQLite 기능, Windows/macOS 설치 난이도, CI 비용, 사용자 환경.
- **추천**: **A**. DDL의 JSON 함수 사용(`schemas/stage-1-ddl-draft.sql:70,98,149`)은 SQLite 빌드 기능이므로, PR1에서 실제 SQLite 버전·필수 함수·DDL 실행을 검사하고 Windows/macOS CI에 고정 런타임을 포함한다. 실패 증거가 나오면 그때 별도 변경안으로 다룬다. 런타임 버전만으로 SQLite 기능을 보장했다고 가정하지 않는다.
- **PR1 확정(2026-11-05)**: 런타임은 **Node 26 + `node:test` + `tsc --noEmit`**, DB는 `node:sqlite`, SQLite 최소 **3.38.0**(연결 시 실제 버전·JSON 함수 검사). 근거와 PR1 시험 항목은 [stage-2-db-guarantees.md](stage-2-db-guarantees.md)·[0016](decisions/0016-core-language.md).

### 2.7 PES 홈과 DB·객체 위치, `pes home`

- **이미 고정**: DB `~/.pes/pes.db`, 객체 `~/.pes/objects/`, 둘 다 기기 로컬(`stage-1-db.md:20`). 위치 자체는 다시 정하지 않는다.
- **정할 것**: `pes home`이 무엇을 옮길지, 테스트 격리와 어떻게 맞출지.
- **선택지**: (A) **홈은 프로젝트 폴더만 옮기고 DB·객체는 `~/.pes`에 그대로**, (B) DB에 데이터가 있으면 `pes home`을 거부, (C) 홈을 바꿀 때 export/import 묶음으로 DB·객체를 새로 복사.
- **판단 기준**: 실행 중 DB 비동기화 금지, 백업·이전 가능성, 기존 `PES_HOME` 의미와의 충돌, 사용자가 홈을 바꿀 때의 혼란.
- **추천**: **A**. `pes home <새 폴더>`는 서버를 끄고 **프로젝트 폴더와 목록 화면만** 옮기며, DB·객체는 옮기지 않는다고 명시적으로 출력한다. `PES_HOME`은 프로젝트 위치만 바꾸고 DB·객체 경로를 바꾸지 않는다. 기기 간 이동은 PR3의 export/import 묶음(DB+객체+manifest)으로만 한다.
- **격리**: 테스트·임시 실행은 SEL-11 방식대로 `HOME`·`USERPROFILE`·`PES_HOME`을 임시화해 `~/.pes` 아래 DB·객체·세션·토큰·백업·run workspace를 함께 격리한다. `PES_DB`·`PES_OBJECTS`는 꼭 필요할 때만 쓰고, 이 변수만으로 격리 완료라고 하지 않는다. 백업이 PES 홈·OneDrive 안이면 거부한다.

### 2.8 방식 A·B가 처음 도는 범위

- **정할 것**: 한 라운드만 볼지, 합성 프로젝트 6단계 전체를 볼지, 실제 프로젝트로 볼지.
- **선택지**: (A) 한 라운드, (B) **합성 프로젝트 1개 6단계 전체**, (C) 실제 프로젝트 1개.
- **판단 기준**: 뼈대·API·lease·정책·화면이 모두 증명되는가, 비용·시간이 통제되는가, 실제 자료가 나가지 않는가.
- **추천**: **B**. A는 합성 1개를 6단계, **PES 내장 실행기가 Go API를 직접 호출하고 사용자가 고른 `opencode-go` 모델 하나(기본 DeepSeek)**, worker+reviewer, 자식 최대 5, 대기·재개·중단·Go OFF 호출별 차단 포함. B(Claude Code)는 사람 컴퓨터의 skill로 프로젝트를 만들어 등록하고 웹·로컬 PES 화면에서 작업하며, 같은 6단계를 MCP로 시험한다. Claude 앱은 Desktop 로컬 확장으로 **1단계 왕복 + 재접속**을 시험하고 안 되면 명시적 전달로 같은 의미를 확인한다. **Codex CLI·OpenCode TUI·Codex 앱·OpenCode 앱은 각각 합성 1라운드+재개**를 시험한다. OpenCode TUI·OpenCode 앱은 사람이 직접 켜는 화면이며, A의 내장 실행기와 다르다. 자식 최대 5는 PES 내장 실행기의 하위 run으로 검증한 뒤 지원한다(`stage-1-runners.md:57`). 실제 자료·실키·기관 자료는 쓰지 않는다. 6단계 범위의 근거는 S0 7-2·DB PR19다(`stage-0.md:88`, `stage-1-db.md:196`).

### 2.9 로컬 API 서버 형태

- **정할 것**: UI와 API를 한 프로세스로 둘지, API 데몬을 따로 둘지, CLI가 HTTP를 거칠지.
- **선택지**: (A) **`pes serve` 한 프로세스(UI+API), CLI는 같은 명령 서비스를 in-process 호출**, (B) API 데몬+UI 서버 분리, (C) CLI만 두고 에이전트만 HTTP.
- **판단 기준**: 기존 포트·URL 유지, 이중 쓰기 없음, A/B가 HTTP로 붙을 수 있음, 테스트 단순성.
- **추천**: **A**. `pes serve`가 127.0.0.1:8760(사용 중이면 기존 8760~8764 범위)에서 기존 화면과 `/api/v1`을 함께 제공하고, 로컬 CLI는 같은 명령 서비스를 직접 부른다(`stage-1-api.md:15`의 허용). A 내장 실행기·MCP·웹 화면은 HTTP를 쓴다. loopback·Origin 검사는 현행이고, **소유자 세션·CSRF는 새 구현**이다(`stage-1-api.md:26`). CLI도 actor·owner 자격을 확정하고 같은 권한 검사를 통과한다.

### 2.10 삭제 정책 (새 절)

- **정할 것**: 논리 보관과 영구 삭제를 어떻게 구분하고, 본문·파일·사건·백업을 각각 어디까지 처리할지.
- **선택지**: (A) 즉시 삭제, (B) **기본 논리 보관 + 참조 없는 객체 정리 + 소유자만 프로젝트 영구 삭제**, (C) 전부 보관.
- **판단 기준**: 복구 가능성, 연구 기록의 감사, 다른 프로젝트 무영향, 디스크·백업 비용, 공개 저장소.
- **추천**: **B**.
  - 기본은 **논리 보관**(`archived_at` 등 기존 표시)이고 복구 가능하다. `alive` 같은 새 열이 필요하면 새 마이그레이션(PR4·9)으로 둔다. 영구 삭제는 소유자만, 확인 단계와 사유를 받는다.
  - **참조 없는 객체 정리**와 **프로젝트 영구 삭제**를 구분한다. 전자는 고아 blob·staging 파일만, 후자는 프로젝트 범위의 본문·파일·사건·백업 처리 범위를 명시한다.
  - 삭제해도 다른 프로젝트·전역 설정·감사에 영향을 주지 않는다. 사건 기록은 참조를 남기고, 백업 보존 기본값은 이 정책에서 구현자가 근거를 정한다(최소 3개 같은 새 값을 두지 않는다).
  - 정책 문서는 PR22, 관련 계약·고아 객체·actor 권한은 PR4·9·10에 귀속한다(`stage-1-db.md:28,163`).

## 3. 방식 A·B 차이

| 항목 | A (PES 내장 실행기 + Go 구독) | B (Claude Code·Claude 앱·Codex CLI·OpenCode TUI·Codex 앱·OpenCode 앱) |
|---|---|---|
| 첫 실행 | 합성 1개 6단계, worker+reviewer, 사용자가 고른 모델 하나(기본 DeepSeek) | Code는 같은 6단계, 앱은 1단계 왕복·재접속, Codex·TUI·Codex 앱·OpenCode 앱은 각각 1라운드+재개 |
| 연결 | PES가 Go HTTP API를 직접 호출 | Code는 stdio MCP→PES HTTP, 앱은 Desktop 확장/명시적 전달, Codex·TUI·Codex 앱·OpenCode 앱은 MCP/HTTP 또는 전달 |
| lease·heartbeat | 어댑터가 진행을 관측해 heartbeat | 도구 호출·진행에 묶음, 앱에 지속 heartbeat 요구 안 함 |
| 질문 | PES 질문이 원본. 모델 질문은 PES `ask`로 만든다 | PES 질문이 원본, 외부 앱 질문은 실행 입력 |
| Go 전송 | 실제 반출마다 정책 검사, OFF면 차단 | 일반 Claude 전송은 대상 아님, Go 목적지 전송만 공통 검사 |
| 스킬 | 중립 스킬 + a-builtin(A) 어댑터 노트 | 중립 스킬 + claude-code/claude-app/codex/opencode-tui/codex-app/opencode-app 어댑터 노트 |
| 비용 | PES가 호출별 토큰을 집계해 90% 문턱·한도 오류에서 멈춤 | PES는 작업량·채택·기한만, 외부 구독 비용은 집행 불가 |
| 실패·되돌리기 | 옛 세션 채택 차단, PES 고정본으로 새 세션 | 복사≠제출, 오프라인 제안→사람이 새 claim으로 채택 |
| 화면 | 실행 상태·대기·중단·권한 질문 표시 | 등록된 run·영수증·채택 상태만 표시, 생존 과장 금지 |

같은 DB 상태면 같은 화면 문구·버튼·권한이어야 하며, 이는 PR21 교차 계약의 완료 조건이다(`stage-1-ui.md:73`).

## 4. 이 단계 구현 이슈 목록

이슈 하나 = PR 하나. **기존 설계의 PR 번호(당시 22개)를 기준으로 하되, PR20을 20a·20b·20c로 나누고 PR26(언어 이전)을 더해 현재 25개다.** `stage-1-db.md:176-199`의 번호를 그대로 쓰고, 표·테스트별 이슈는 만들지 않는다(`stage-1-db.md:33`). Linear에는 `[2단계 PR n]` 제목으로 20a·20b·20c를 포함해 만들고, SEL-18·19는 기존 이슈를 선행으로 연결한다. **2단계 이슈 수와 누적은 `roadmap.md` 2절 참고.** 모든 PR은 자기 테스트를 포함하며 21번까지 미루지 않는다.

### 4.1 0단계 의존 (2026-11-05 03:31 현재)

| 0단계 산출물 | 상태 | 영향 PR | 없을 때 |
|---|---|---|---|
| SEL-11 테스트 하네스·fixture | **완료**(`f6e9c37`) | 전체 | PR1 착수 전에 필요. 없으면 각 PR 테스트가 격리되지 않음 |
| SEL-12 상태 전이·복원 시험 | 진행 중(hc-team) | 3·12 | 이전·복원 완료 조건을 증명할 수 없음 |
| SEL-13 답 수신·잠금·질문 화면 | 진행 중(hc-team) | 8·14·18 | 답·잠금·폼 호환을 증명할 수 없음 |
| SEL-14 개발 규칙·격리·결정 기록 | 진행 중, `AGENTS.md` 없음 | 전체 | 새 세션이 테스트·격리 규칙을 재현할 수 없음 |
| SEL-15 CI(매 PR, Windows/Mac) | 진행 중(hc-team) | 전체 | PR18·22의 Windows 브라우저 게이트 불가 |
| SEL-16 공개 저장소 점검 | **완료**(`e015ff4`) | 전체 | 민감 자료·경로 점검 기준 없음 |
| SEL-17 기준선·스키마·용어표 | **완료**(`82c6de5`) | 11·12 | 옛 필드 매핑과 "보존" 판정 기준 없음 |
| SEL-18 A 시험 | 진행 중(hc-team) | 5·19·21·22 | TTL·heartbeat·Go 사용량 추정·모델 선택·정책 차단을 확정하지 못함 |
| SEL-19 B 시험 | 진행 중(hc-team) | 5·20·21·22 | Claude 앱 연결·재접속·관측 한계를 확정하지 못함 |
| SEL-31 자료 손실·답 유실·승인 오처리 수정 | 확인 필요 | 1·12·15 | 옛 결함이 이전·비교 시험을 오염시킴 |

**0단계 게이트(S0 6절) 충족 전 PR1 착수 금지.** PR1~18은 게이트 뒤 조건부 진행, PR19는 SEL-18, PR20a·20b·20c는 SEL-19, PR21·22는 SEL-18·19 결과 뒤 진행.

### 4.2 PR 목록

| # | 제목 | 범위 | 선행 | 완료 조건 | 검수 |
|---|---|---|---|---|---|
| 1 | 스키마 001 + SQLite 연결 | DDL **61표(현재 001 기준)**, FK, `db_meta`, 마이그레이션, 임시 홈 주입, 짧은 트랜잭션, 3.5절은 표만 | — | 임시 홈에서 DDL·대표 삽입·거부·rev 충돌 롤백 통과, 실제 `~/.pes` 미접촉, SQL 보장과 서비스 보장(상태 전이·6단계·fence·불변 버전) 구분, bootstrap 한 tx, SQLite 버전·JSON 함수 검사 | C2-1 |
| 2 | D1 호환 smoke | 같은 마이그레이션, batch 원자성, deferred FK, 부분 인덱스, JSON 함수, 0행 실패, 동일 원자 명령의 성공/충돌/뒤늦은 실패 전체 롤백, 실행 제한 | 1 | 로컬 D1에서 대표 성공·실패 통과, SQLite와 차이 문서화, 운영 D1 미접촉. **Node LTS·wrangler 고정은 D1 개발 도구 한정**이고 로컬 런타임은 0016 시험 뒤 정한다. CI는 마이그레이션·DB 어댑터 변경 PR과 main에서 필수 | C2-2 |
| 3 | 새 형식 백업·export/import | DB+객체+manifest+sha256, `db_meta` 커서 무효화, 한 프로젝트 복원 격리, 파일은 불투명 복사(ready·고아 규칙은 PR9·12) | 1 | **PR3는 export/import 골격 자체 시험**을 갖는다. 한 프로젝트 복원이 다른 프로젝트·전역 설정을 바꾸지 않음, 손상·누락 보고, 복원 뒤 epoch. **전체 복원 검증만 PR4·9·10 뒤 PR12와 통합** | C2-3 |
| 4 | 변경 명령 서비스 | rev·control_rev·멱등·`mutation_commits`·`events` 같은 tx, 0행 실패, actor/via 확정, 권한, **인증·권한·현재 정책·목적지 검사→영수증 재생→rev/lease** 순서, PR10 정책 검사기 주입 | 1 | 같은 키 같은 요청 재생·다른 요청 거부, 0행/늦은 실패 전부 롤백, 모든 변경에 사건·영수증, 영수증 장기 보존, system/채택 actor 정합성, **OFF 전 완료 요청을 OFF 후 같은 키로 재요청해도 금지된 결과·전송 경로 재생 0**, **언어 중립 JSON 계약 픽스처** | C2-4 |
| 5 | run·lease·fence | claim=run 전이+lease 원자, heartbeat, wait 시 `waiting_human`+해제, 만료·인계·fence, 입력 영수증 | 4 | 가상 시계로 만료·옛 fence 거부·질문 대기 중 해제/재획득, TTL은 설정(기본 비확정), SEL-18·19 뒤 확정. seen/ignored와 증거 있는 applied, 인계 뒤 중복 반영 방지, 만료 lease 부활 금지, 대기·무진행·중단 유예 값의 확정 담당 | C2-5 |
| 6 | 판·단계·라운드 명령 | 봉인·승인·reopen·stale·완료 해제, **단계 미완료 작업 이월(현행 `carry_over`, `scripts/pes.py:852-854`; 원 요청·대상·출처·버전 보존, 다음 R1 조회)과 조사 주제 파생을 분리**, 4단계 판 이월과 다름, 1판 흐름 보존, snapshot/manifest | 4,5,9 | 합성 6단계 흐름, reopen 뒤 stale·승인 유지, **reopen 뒤 실행 기반 무효화**, complete≠approve, snapshot/manifest, 1판 흐름과 4단계 판 기능 구분. **여러 단계의 남은 QA 지적·미완료 요청이 승인·이전 뒤에도 남고 다음 R1에 보이는 시험** | C2-6 |
| 7 | 항목·버전·출처·연결 | objects/versions, artifacts, sources/versions, citations, relations, QA·verify·library, URL로 안 합침 | 4 | 버전 불변·현재 포인터, 각주 순서, 같은 URL 다른 자료, 옛 연결 유지, library 이전. 출처 확인 시점·짧은 발췌·위치·방법/판정, 못 읽은 자료 발췌 금지, library DB 내용과 참조 파일(PR9/11) 담당 | C2-7 |
| 8 | 질문·답 | question_sets/members, questions/versions, submissions, answers/versions, `__other`는 질문 스레드 메시지로 보존, 자유 의견, `allow_comment_as_answer` | 4,6 | 폼/질문 버전 고정, 옛 답 보존·새 버전 재확인, 덧붙임만 응답 인정, 중복 제출 방지. 조건부 필수·명시적 미루기·기본값/추천 자동 답 금지·묶음 전체 원자성, `__other` 최소 thread와 U2 새 의견 기능 구분, 재개 준비 검사의 **주 담당**: 현재 질문/폼 버전·조건부 필수·의견 응답 허용·명시적 미루기·실행 상태·Go 정책·기한/한도·새 claim(실행 form 응답은 예외). PR5·PR14는 보조 | C2-8 |
| 9 | 결과물·객체 저장 | blobs/version_files, staging→hash→ready, 고아·격리, 접근 검사, 보고서 정확한 버전 참조 | 1,4,7 | 경로·서명 URL을 ID로 안 씀, 손상 hash 거부, 다른 프로젝트 접근 차단, component 버전 고정. 채택·저장·공유·인쇄 버전 보존, 같은 바이트 중복 저장 방지, 역할 제안 출처·workspace ready 경계, Go 파일 읽기 프록시(PR10/19) | C2-9 |
| 10 | 행위자·토큰·전송 정책 | actors, agent_tokens, project_policy_versions, outbound_dispatches, Go ON/OFF 경합, **PR4 재생 전에 호출되는 정책·목적지 검사기** | 1,4 | 토큰 해시·범위·만료·회수, 사람만 정책 변경, OFF 뒤 prepared 차단·authorized 미송신만 차단, 감사. 기본 ON 표시·정책 손상 시 차단·합성도 우회 금지·재허용 후 자동 재시작 금지, 30일 토큰·매 요청 검사, OFF in-flight 취소/unknown·sent 이력·옛 lease 채택 차단, 소유자 세션·CSRF 귀속. **OFF 전 완료 요청의 재생 차단을 PR4·13과 같은 시험으로 확인** | C2-10 |
| 11 | legacy importer | `project.json`·library·feedback·snapshots·reports·out/shots·ask/rounds → staging, `import_batches`/`legacy_mappings`, **`carry_over`/`next_round_task` 원 요청·대상·출처·버전 보존**, 미지 필드 보고 | 1,6,7,8,9,10 + SEL-17 | 깨진/2MB fixture, 재실행 멱등, 기본값을 과거 결정처럼 안 만듦, 원본 hash 불변. 옛 승인 `legacy_unknown`·사용자 NULL·`legacy_unverified`, 그때 본 질문/폼·덧붙임/자유 의견·미처리 입력 매핑, **분석·집필 등 여러 단계의 미완료 요청이 이전 뒤에도 남음**, 새 정책 기본값을 과거 동의로 기록하지 않음. 실제 manifest·경로·이전 보고서는 로컬에만, PR에는 합성·익명 결과만 | C2-11 |
| 12 | 이전 검증·되돌리기 | 합성 fixture 검증(개수·본문·ID·연결·hash·미처리 답·보고서), 쓰기 전/후 복구 | 3,9,11 | 사본→staging→검증→활성화, 원본 무변경, 쓰기 전 원본 재연결·후 프로젝트 단위 복구, 다른 프로젝트 무영향, 복원 손실 범위·커서 초기화. **실제 파일럿은 PR22로 분리**, 합성 실패를 실제 파일럿 실패로 보지 않음. 실제 manifest·경로·이전 보고서는 로컬에만, PR에는 합성·익명 결과만 | C2-12 |
| 13 | API: 맥락·claim·submit·complete | context digest+manifest, claim 원자, submit 작은 묶음, wait 분리, complete≠승인, 오류·멱등, **project.create bootstrap**, **2단계 지원 HTTP 경로 대응표(4.2.1)** | 4,5,6,7,9,10 | OpenAPI/예제, rev 충돌 부분 저장 없음, long-poll이 tx를 잡지 않음, 토큰 범위, 403 policy. 10진 문자열·닫힌 명령/미지원 필드 거부·**재생 전 정책·목적지 검사**·run 제한 자격·context 일관 읽기, **한 run 최소 경로**임을 명시, 언어 중립 JSON 계약 픽스처. **A/B HTTP 왕복: run 시작→claim→wait→답→재개, 파일 ready·Go OFF 읽기 차단, 미래 명령 capabilities 미지원. project.create: owner·초기 정책·첫 판 한 tx, 중복 slug·멱등·재생, 에이전트 owner/정책 우회 0** | C2-13 |
| 14 | API: 질문·답·변경분·오류 | 질문 게시/수정, submissions, changes cursor, approve/reopen 사람 전용, 오류 봉투, **B 최초 project.register(기기 승인)**, **2단계 지원 HTTP 경로 대응표(4.2.1)의 나머지** | 6,8,10,13 | 사람 세션과 에이전트 토큰 구분, 승인·reopen 에이전트 불가, cursor epoch 재동기화, 가짜 성공 없음. capabilities·inputs/long-poll·input-receipts·heartbeat/release·interrupt/cancel/**handoffs(단수 `/handoff` 아님)**·202 조회의 PR13/14 귀속, **canonical `POST P/claims`(R1의 `POST P/runs/{r}/claims` 아님)**, 요청 제한·poll 간격·429, 커서·DTO·tx 갱신, 서버 답 초안 없음, **한 라운드 증명은 PR13+14**, 언어 중립 JSON 계약 픽스처. **2단계 경로 누락 0, U5는 기존 run_start 재사용. project.register: project token 없는 최초 등록, 기기 승인·중복·재생, 에이전트 owner/정책 우회 0** | C2-14 |
| 15 | CLI 쓰기 전환 | approve/reopen/mark/note/lock, serve/stop/home, 모든 쓰기 서비스 경유, `context/claim/submit/wait/complete` CLI | 4,5,6,7,8,9,10 | 기존 명령 의미 보존(합성), 직접 JSON 쓰기 0, 잠금 인계, `pes home`이 DB·객체를 안 옮김. **CMDS 32개 전수 배정(4.3)**, 질문·항목·snapshot 쓰기는 PR7·8·9 선행, 승인·권한 우회 동작 미승계 | C2-15 |
| 16 | CLI 읽기·보고서·doctor | status/digest/show/list/pending/report/assemble/web/doctor, 미전환 프로젝트 읽기 전용 legacy, 보고서는 PR9 경계 | 7,9,15 | 정확한 버전·각주로 보고서 재생성, doctor 기본 진단/`--fix` 분리, 임시 홈만, 실제 홈 미접촉. `report/assemble/web`는 쓰기 포함, 경로 quoting·소유 프로세스 진단, `pes watch` 대체(입력 long-poll 또는 같은 출력 형식, PR20 연계), legacy 보존/제거 조건 | C2-16 |
| 17 | 스킬 직접 편집 제거 | core+plan 파일럿→전체, 중립 워크플로·역할 명세·어댑터 노트, lint | 10,13,14,15,16 | `project.json`·sqlite 직접 쓰기 0(grep/lint), 연구 절차·독립 검토 유지, core+plan 합성 1회, Claude 전용 표기는 예외 위치. **문자열 0건이 아니라 업무 경로별 검증 명령 사용 확인**, 자식 제안 파일 허용·reviewer 독립 판단 유지, PR19 선행 계약 | C2-17 |
| 18 | 로컬 화면 DB/API 전환 | 기존 hub/dashboard/ask/report/print/deep link를 같은 URL로, 읽기+답·승인·reopen+Go 스위치, 미전환 프로젝트는 legacy 읽기 전용, 새 디자인 없음 | 8,10,13,14,15,16 | 동등성 매트릭스 통과, `__other`·show_if·필수·추천·원격 답·버전 갱신·인쇄, Playwright Windows CI 필수, 이중 쓰기 0. 입력 중 갱신·충돌·타임아웃·커서 무효에도 초안 보존, 당시 set/버전 ask 링크, 안전한 Markdown/외부 인용, 소유자 세션·CSRF, 서버 영수증 뒤 성공, 최소 run/대기/중단·권한 입력·Go in-flight/unknown 표시, 수동 IME·NVDA·인쇄 담당 | C2-18 |
| 19 | A 내장 실행기 | Go HTTP API 직접 호출, **PR19에서 주소·모델 목록·원시/내부 model ID·구독 적용 조건 검증**, 에이전트 루프(맥락→호출→JSON 검증→업무 명령 저장→질문→재개), **PES 명령 allowlist(`decision.propose` 포함)**, **run 시작 때 고른 `opencode-go/<model-id>` 하나·폴백 없음**, 6단계·4역할, 이벤트 | 5,10,13,14,17,18 + SEL-18 | 합성 1개 6단계, wait/resume/interrupt, Go OFF **호출별** 차단, **사용량 기준점·추정 문턱(기본 90%)·다음 호출 예약·한도 오류 멈춤·billing_source/allowance·cost=0만으로 판단 금지·unknown fail-closed**, 실제 자료 미사용. **Extra Usage OFF 확인/만료/확인 불가 차단**, 최초 claim 단일화·첫 Go 호출 전 정책/사용량/claim, 키 미노출, **호출 전 attempt/상관키·응답 유실 unknown·자동 재호출 금지·모델 호출/저장 재시도 분리**, JSON 스키마 위반 거부, 프롬프트 주입 무시, 재시작 뒤 같은 run 이어 감·중복 제출 0, **`blocked_usage`+`go_block_reason`·`go_block_reset_at`·lease 해제·사람 재개**, 부모만 채택·자식 waiting_human 전파·reviewer 별도 run. **A/B 합성 U3에서 `decision.propose`/`pes_decision` 제안, 사람만 채택** | C2-19 |
| 20a | 방식 B 어댑터 — Claude Code·Claude 앱 | Claude Code stdio MCP→로컬 HTTP, CLI 대안, `/pes:run`, Claude 앱 Desktop 확장 실제 시험, 명시적 전달/가져오기, **B 최초 project.register(기기 승인)**, **공통 MCP bridge·adapter 계약에 진행 이벤트·스케줄 표준 형식 포함**, `pes link`/`sync`의 로컬 계약 | 5,10,13,14,17,18 + SEL-19 | Code로 합성 6단계, 앱 1단계 왕복·재접속, 복사≠제출, 중복 가져오기 방지, 실제 제출 actor 구분. **빈 계정/새 프로젝트에서 B 최초 등록→run→결과**, **진행·스케줄 이벤트(시작·단계·완료·실패·대기, 예정 작업) 표준 형식과 중복 방지**. 전달/대화 중 lease 없음·원 요청/기반 manifest 대조·hash≠인증·오프라인 제안 채택, 직접 인증 앱과 사람이 붙여 넣은 결과 구분, 재접속 context→새 입력→수신 확인→claim, 다른/오래된/중복 묶음·첨부 누락 거부, 지원 환경표, `pes watch` 대체 | C2-20a |
| 20b | 방식 B 어댑터 — Codex CLI·OpenCode TUI | 20a의 MCP bridge·계약을 써서 Codex CLI·OpenCode TUI를 붙인다. D4 어댑터 노트에 `codex`·`opencode-tui`를 추가하고, **A의 내장 실행기와 OpenCode TUI(사람이 직접 켬)를 구분**한다. 토큰은 OS 키체인, `runtime=codex_cli/opencode_tui`, 모델·사용량 미상은 `unknown`, 승인·정책·토큰·삭제·export 도구 없음, Go 목적지 경로 시험 | 20a, 5,10,13,14,17,18 + SEL-19 | **Codex CLI와 OpenCode TUI 각각** 합성 1라운드+재개, actor/runtime 정확, 중복 제출·같은 키 다른 요청 거부, A 내장 실행기 비간섭, Go 경로 차단/한계 표기, 노트만 보고 연결 재현 | C2-20b |
| 20c | 방식 B 어댑터 — Codex 앱·OpenCode 앱 | 20a 계약·20b 노트를 재사용해 **Codex 앱·OpenCode 앱**을 붙인다. `runtime=codex_app/opencode_app`, D4 노트 `codex-app`·`opencode-app`. 설정 공유는 **미확인**이며 직접 연결이 안 되면 명시적 전달(복사·붙여넣기)을 보장 경로로 둔다. **직접 인증 앱의 제출 actor는 `external_agent`, 사람이 붙여 넣은 수동 전달만 `human`**이며 도구·모델 주장은 미검증 출처. OpenCode 앱은 A의 내장 실행기·Go 호출 경로를 건드리지 않음 | 20b, 5,10,13,14,17,18 + SEL-19 | **Codex 앱·OpenCode 앱 각각** 합성 1라운드+재개, 직접 연결/전달 경로, 중복 제출·같은 키 다른 요청·버전 오류, A 내장 실행기·OpenCode TUI 비간섭, **직접 인증 앱 `external_agent`·수동 전달 `human` 구분** | C2-20c |
| 21 | A·B 교차 계약 | 같은 결과 의미·양방향 인계·지연 응답·프로세스 종료·OFF·Go 사용량·중복/충돌 | 18,19,20a,20b,20c + SEL-18·19 | 같은 DB 상태에서 같은 문구·권한, 유실·중복 0, A→B·B→A 인계, 옛 fence 거부, 자동 테스트. seen/applied 중복 방지·사람 시작 인계·권한 응답 지연 거부·Go 사용량 문턱 인계·unknown 예약 미해제, SQLite/D1 동일 성공·충돌·부분 실패, Go 실측은 PR19/20a·20b·20c·반복 계약은 가짜 런타임 | C2-21 |
| 22 | 전환 통합 검증·문서 | Windows/Mac 설치·제거·복구, **TS 단일 코드베이스 설치**, 백업/복원, 이전 runbook, 사용 안내, 실제 파일럿(사용자 허용), **프로젝트별 실제 자료 사용 허용 기록(항목·자료 범위·목적지·기간·철회, 로컬 보관)** | 2,12,18,21,26 + SEL-18·19 | CI **매 PR 및 main** Windows/Mac, 복원 훈련, 실제 프로젝트 1개 파일럿(허용 시) 원본 보존, 문서만 보고 재현, 공개 저장소 민감 자료 0. PR2 통과·모든 필수 게이트 선행, 앱 설치/연결/명시적 전달·Codex/OpenCode TUI·Codex 앱/OpenCode 앱 노트·unknown 상태·CLI/홈/정책·복원 손실 범위 문서화, 실제 산출물은 로컬·공개는 합성. **PR22 미실시 시 T1이 최초 기록을 만들고, 기록이 있으면 새 목적지만 추가; 로컬 이전·B 전달·A Go 전달을 구분하고 기간 만료/철회 뒤 사용 차단; 허용 없으면 합성/미실시** | C2-22 |
| 26 | TypeScript 단일화·0.15 이전 | **새 코드·시험은 PR1~22에서 이미 TS**로 작성하고, PR26은 Python 0.15(`pes.py`·`serve.py`·설치 스크립트·pytest·skills/commands 호출)를 동결해 TS로 옮기는 **기존 자산 이전·동등성·설치·제거**만 맡는다. 동등성 매트릭스(질문 화면·보고서·`project.json` 처리·CLI 출력), 같은 합성 픽스처 차이 0, 설치 Windows/Mac, Python 제거, 0.16.0 단일 코드베이스 | 1,4,13,14,15,16,17,18,21 | 0.15 Python 동결·치명 수정만, 같은 입력→같은 출력, 테스트 이전·차이 0, `python3 scripts/pes.py` 호출 0, 설치·업그레이드 Windows/Mac, legacy importer는 데이터만 읽음, 외부 도구 Python 요구는 경계로 표시. **PR26에서 새 Python 코드·테스트를 만들지 않음** | C2-26 |

### 4.2.1 2단계 지원 HTTP 경로 대응 (닫힌 목록)

| 경로 | 행위자 | HTTP 노출 | 코어 명령 | 완료 시험 |
|---|---|---|---|---|
| `GET /api/v1/capabilities` | H/E/W | PR13 | PR13 | PR14 완성 시험 |
| `POST /api/v1/projects` | H(owner) | PR13 | PR13 | `project.create` bootstrap: owner·초기 정책·첫 판 한 tx, 중복 slug·멱등 |
| `POST /api/v1/project-registrations` | H(기기 승인) | PR14 | PR14 | B 최초 등록, project token 없음, owner·정책 우회 불가 |
| `POST P/runs` | H | PR13 | PR6 | run_start 등록, U5가 재사용 |
| `POST P/claims` | E | PR13 | PR5 | claim=run 전이+lease, 옛 fence 거부 |
| `GET P/context`, `GET P/objects/{o}/versions/{v}` | E/H | PR13 | PR13·7 | 정확한 버전·10진 문자열·일관 읽기 |
| `POST P/runs/{r}/results` | E | PR13 | PR5 | 묶음 제출·멱등 replay·rev 충돌 |
| `POST P/runs/{r}/wait` | E | PR13 | PR5 | `waiting_human`+lease 해제 |
| `POST P/runs/{r}/complete` | E | PR13 | PR5 | run 종료≠승인 |
| `POST P/runs/{r}/heartbeat`·`/release`·`/interrupt`·`/cancel`·`/handoffs` | E/H | PR14 | PR5 | 인계·중단·취소·반납, 단수 `/handoff` 없음 |
| `GET P/operations/{id}`·`GET P/requests/{key}` | E/H | PR14 | PR4 | 202 영속 접수·operation 조회, 재시작 뒤 조회 |
| `GET P/runs/{r}/inputs?cursor=&wait_ms=`, `POST P/runs/{r}/input-receipts` | E | PR14 | PR5 | long-poll·영수증, tx를 잡지 않음 |
| `POST P/submissions` | H | PR14 | PR8 | 묶음 답·의견, 당시 폼/질문 버전. 3단계 U2a(SEL-90): 선택 필드 `mode`(`bundle`·`single`)와 응답 `form_complete`·`missing_required` |
| `GET P/changes` | E/H | PR14 | PR4 | 커서 epoch·tx 묶음 |
| `GET P/workspace` | E/H | 3단계 U1b(SEL-82) | U1b 읽기 모델 | 앱 작업 공간 읽기(현재 단계·라운드·차례·권한별 가능 동작·기록 개수). 읽기 전용·새 표 없음, `context:read` |
| `POST P/uploads`→`PUT P/uploads/{u}`→`POST P/uploads/{u}/complete`, `GET P/files/{b}/content` | E/H | PR13 | PR9 | 예약·업로드 완료·ready·hash·Go OFF 정책 검사 읽기 |
| `POST P/stages/{s}/rounds`·`POST P/rounds/{r}/seal` | H/E | PR14 | PR6 | 라운드 시작·봉인, 승인과 분리 |
| `POST P/stages/{s}/approve`·`/reopen` | H | PR14 | PR6 | 사람만, 에이전트 거부 |
| `POST P/policies/opencode-go/revisions` | H | PR14 | PR10 | 사람만, 정책 이력·재생 전 검사 |
| `POST P/questions`·`/revisions` | E/H | PR14 | PR8 | 질문 게시·수정, 답과 분리 |
| `POST P/questions/{q}/withdraw`·`/defer`·`/merge` | H/허가된 E | 3단계 U2a(SEL-90) | `question.withdraw`·`question.defer`·`question.merge` | 질문의 새 버전(state `withdrawn`·`deferred`·`merged`), 옛 버전·옛 답 보존, 폼의 최신 세트에서 같은 tx 로 빠짐, 전이표 밖은 409, 지우지 않음 |
| `GET P/stages/{s}/rounds/{rd}`·`GET P/stages/{s}/rounds/{rd}/threads` | H/E(`context:read`) | 3단계 U2d(SEL-98) | (읽기, 명령 없음) | 라운드 하나의 폼 세트·질문 현재 버전·현재 답, 질문별 의견 목록. 새 표 없음 |
| `POST P/question-sets/{set}/order` | H/허가된 E | 3단계 U2d(SEL-98) | `question.reorder` | 새 폼 세트 하나(순서만 다름)를 한 tx 로 발행, 새 질문·질문 버전·답 없음, 낡은 세트 409 `stale_set`, 순열 아니면 422 |
| `POST P/threads`(질문 의견 `question_comment`)·`POST P/threads/{t}/messages` | H/허가된 E | 3단계 U2a(SEL-90) | `question.comment_add` | 질문 의견은 답이 아니다(답·제출 0). 앵커 문맥 `annotation` 은 U4a 까지 501 |
| `POST P/assumptions`·`GET P/assumptions` | H/E(제안), H(판단) | 3단계 U3a(SEL-93) | `assumption.propose`·`assumption.assess` | 제안(state `proposed`, `needs_review`)은 소유자·토큰, `confirmed`·`rejected`·`revised` 판단은 소유자 세션만(토큰 403 `human_required`). 판단은 새 버전, 원문 보존. 읽기는 객체마다 현재 버전 한 줄 |
| `POST P/decisions`·`GET P/decisions` | H/E(제안), H(채택·대체·폐기) | 3단계 U3a(SEL-93) | `decision.propose`·`decision.adopt`·`decision.supersede`·`decision.revoke` | 제안은 채택이 아니다. 채택·대체·폐기는 사람만, 전이표 `proposed→adopted→superseded\|revoked`, 대체는 새 결정+옛 결정의 새 버전, 대체 대상이 adopted 가 아니면 409 `supersedes_conflict` |
| `POST P/reflections`·`GET P/reflections?round_id=` | H/E | 3단계 U3a(SEL-93) | `reflection.create` | applied·partial 은 의미 증거(`evidence_tx_id`가 결과 버전을 만든 tx, 후속은 applied)가 있어야 한다: 없으면 422 `evidence_required`, 안 맞으면 422 `validation_failed`. 빈 `entries` 는 "0건 제출"이고 "미제출"과 다르다 |
| `POST P/references`·`GET P/references`·`GET P/references/{ref}`·`POST P/references/{ref}/refresh`·`POST P/references/{ref}/detach` | H(붙임·갱신·떼기), H/E(읽기) | 3단계 REF1a(SEL-113) | `reference.attach`·`reference.refresh`·`reference.detach`·`reference.source_gone`(원본 소유자, HTTP 경로 없음) | 원본 프로젝트의 스냅숏 하나에 고정한 읽기 전용 참조(새 표 없음, `project_references`). 두 프로젝트 모두 구성원이어야 붙인다. 읽기는 권한·Go(엄격한 쪽 우선)·원본 없음을 한 함수로 판정하고 AI 호출자에게는 막힌 본문을 `null` 로 준다. 자세한 값은 `stage-1-api.md` 6절 |
| 해결·export | 미래 | — | — | **capabilities 미지원**, 가짜 성공 없음 |

- **2단계 필수 경로는 위 표가 닫힌 목록**이다. run 시작·wait·정확한 버전 읽기·라운드/정책 읽기와 **파일 HTTP(예약·업로드 완료·정책 검사 읽기)는 PR13**이 맡고, 파일 저장 코어는 PR9다. release·202 operation 조회도 PR14에 포함한다.
- **project.create/register**: A의 웹/로컬 생성은 `project.create`가 owner·초기 정책·첫 판을 한 tx로 만들고, 중복 slug·멱등 키·재생을 검사한다. B의 최초 등록은 project token이 없으므로 **사람의 기기 승인/제한 등록 자격**을 쓰며, 일반 에이전트 토큰에 owner 생성·정책 변경 권한을 주지 않는다. **PR14는 `project-registrations` API를 만들고, PR20a는 빈 계정/새 프로젝트에서 그 API를 쓰는 B 최초 등록 종단 시험을 맡는다.** 빈 계정/새 프로젝트에서 A·B 모두 시험한다.
- **capabilities**: PR13이 `GET /api/v1/capabilities` 라우트를 열고, PR14가 완성 시험(미지원 명령·가짜 성공 없음 포함)을 맡는다.
- **나열 순서 ≠ 실행 순서**: 표의 PR22가 PR26보다 먼저 보여도 실제 실행은 **PR26 → PR22**다.
- `/handoff`가 아니라 **`/handoffs`**, R1의 `POST P/runs/{r}/claims`가 아니라 **`POST P/claims`**를 쓴다. U5는 기존 `POST P/runs`를 재사용한다.
- 파일 ready·Go OFF 읽기 차단을 포함한 A/B HTTP 왕복을 PR19·20a·20b·20c 완료 조건과 PR21 교차 계약에서 확인한다.

### 4.3 CLI 명령 32개 배정 (`scripts/pes.py:1768-1772`)

| PR | 명령 | 선행·경계 |
|---|---|---|
| 15 쓰기 | `init`, `ask-prep`, `ask`, `round-start`, `merge`, `render`, `approve`, `reopen`, `mark`, `chat`, `note`, `qa-brief`, `qa`, `remote`, `serve`, `stop`, `home`, `lock`, `unlock` | `ask-prep/ask`는 PR8, `round-start/merge/render/qa`는 PR7·8·9, `approve/reopen`은 PR6, `serve/stop/home/lock`은 PR15 |
| 16 읽기·보고서·doctor | `status`, `pending`, `digest`, `show`, `list`, `hub`, `open`, `which`, `doctor`, `watch`, `assemble`, `report`, `web` | `report/assemble/web`는 PR9, `watch`는 PR16/20, `doctor`는 기본 진단/`--fix` 분리 |

합계 19+13=32. PR17은 CLI 명령이 아니라 스킬·lint다.

## 5. 완료 기준

| 게이트 | 통과 조건 | 이슈 |
|---|---|---|
| 0단계 | S0 6절 게이트 충족, `AGENTS.md`·SEL-18·19 증거 확인. 충족 전 PR1 미착수 | — |
| 스키마·명령 | 임시 홈에서 DDL·마이그레이션·대표 조회·거부·rev 충돌 롤백 통과. 모든 변경이 한 tx에 변경·영수증·사건을 남김 | 1·4 |
| D1 호환 | 로컬 D1에서 같은 마이그레이션과 대표 성공/실패 통과, 차이 문서화, 도구 버전 고정 | 2 |
| 이전 | 합성 fixture 이전·검증·활성화·되돌리기 통과. 실제 파일럿은 PR22에서 사용자 허용 시 원본 보존 | 3·11·12·22 |
| API | `context→claim→submit→wait→complete`가 합성 한 라운드를 통과. 승인·reopen은 사람만, 0행·충돌·부분 실패가 성공으로 보이지 않음 | 13·14 |
| 코어 언어 | PR1 전 WEB0(5단계 번호) 실행(현재 JSON fixture·최소 TS 구현, PR4·13·14는 전제 아님), `0016-core-language.md`·`0005-web-platform.md` 기록, TS 단일 언어 기준을 WEB1에 입력. WEB0는 5단계 16개에 포함되어 새 이슈 없음 | WEB0 |
| CLI·스킬 | 기존 명령 의미 보존, CMDS 32개 배정, `project.json`·DB 직접 쓰기 0, core+plan 합성 통과 | 15·16·17 |
| 기존 화면 | 동등성 매트릭스와 Playwright 스모크가 Windows/Mac에서 통과. 새 디자인·이중 쓰기 없음, `pes watch` 답 알림 유지 | 18 |
| 방식 A | 합성 1개 6단계, 대기·재개·중단·Go OFF 차단, **토큰 추정 문턱·한도 오류·과금 표시·unknown fail-closed**, 실제 자료 미사용 | 19 |
| 방식 B | Claude Code 같은 6단계, Claude 앱 1단계 왕복·재접속, Codex CLI·OpenCode TUI·Codex 앱·OpenCode 앱 각각 1라운드+재개, 복사≠제출, 중복 방지 | 20a·20b·20c |
| 교차 | A↔B 인계·지연 응답·프로세스 종료·OFF·중복/충돌에서 유실·중복 0 | 21 |
| 삭제 정책 | 논리 보관/고아 정리/프로젝트 영구 삭제 구분, 소유자·확인·백업 범위 문서화 | 22 |
| 배포·버전 | 2단계 PR은 플러그인 버전을 올리지 않고 새 DB 경로는 개발 플래그 뒤. PR26 통과 뒤 0.16.0을 PR22에서 한 번 배포하고 새 언어 단일 코드베이스로 넘긴다 | 22·26 |
| 통합·문서 | Windows/Mac 설치·복구·백업/복원, 이전 runbook, 사용 안내, 공개 저장소 민감 자료 0 | 22 |
| 승인 | 사용자가 "3단계로 넘어가도 된다"고 승인 | — |

## 6. 사용자 결정이 필요한 것 (비용·되돌리기 어려운 일만)

| # | 결정 | 선택지 | 추천과 이유 | 비용·되돌리기 |
|---|---|---|---|---|
| 1 | 실제 프로젝트 이전 범위 | 허용 slug·사본 시험/활성화 범위·복원 시점 뒤 손실 수용 | **허용 slug 1개씩, 원본 보존, PR22 실제 접근 직전 확인**. PR22가 프로젝트별 '실제 자료 사용 허용 기록'(로드맵 정의)을 처음 만든다 | 새 쓰기 뒤 옛 JSON 복귀는 무손실 보장 없음 |
| 2 | Go 사용량 멈춤 문턱(기본 90%)과 기본 모델 확인 | 문턱 50~100% / 기본 모델 / Go 모델 목록 | **추천값(90%, `opencode-go/deepseek-v4.1-flash`) 그대로면 다시 묻지 않는다.** 바꿀 때만 SEL-18 측정 뒤 확인한다. Extra Usage는 끄도록 안내하고, B 외부 비용은 PES가 집행할 수 없음을 표시한다 | Go 구독 사용량. PR19 전에 확인 |

## 7. 다음 단계로 넘기는 것

- **3단계 U1~U6**: 작업 공간 틀·질문 작업면·가정/결정/반영·첨언/후속·프롬프트 복사·범위 인쇄. **U 사이 선행**은 U2←U1, U3←U1(통합 U2·U4), U4←U1·U2, U5←U1·U2·U4, U6←U1~U4(`stage-1-ui.md:86-91`). 각 U가 새 명령·서비스·조회·화면·시험을 함께 맡는다.
- **3단계 선택 실험**: WebMCP는 **3단계 선택 실험 1 PR**(읽기·초안·첨언/답글만, 승인류 금지). 자동 재개는 **3단계 옵션**으로 넘긴다.
- **4단계**: 판 유지/수정/제외 화면, 판·라운드 비교, 갈림길 맛보기, AI 반대 의견, 직접 편집·제안 모드.
- **5단계**: 로그인·역할·권한, 원격 MCP, **운영 D1/R2**, 알림, **웹 A 실행기(Workflows)**.
- **6단계**: Linear 등 외부 내보내기, 여러 사람·여러 worker, hc-team, 그 밖의 에이전트(Gemini 등 후보). Codex CLI·OpenCode TUI·Codex 앱·OpenCode 앱은 2단계 PR20b·20c에서 끝낸다.
- **2단계 잔여**: `project.json` 삭제 정책, legacy 읽기 경로 제거, 전체 프로젝트 이전. D1 운영은 5단계, 자동 재개는 3단계 옵션, WebMCP는 3단계 선택 실험 1 PR로 목적지가 이미 있다. **Go 사용량 보호(멈춤 문턱)는 PR19/21의 필수 계약**이므로 잔여로 넘기지 않는다. **OneDrive 동기화는 이미 금지**이므로 미결로 남기지 않는다.
- **3단계 입력**: 동등성 매트릭스, 읽기 모델·변경 커서, 이전 보고서(`import_batches`·`legacy_mappings`), SEL-18·19 측정값, `docs/plan/decisions/`의 TTL·Go 사용량 결정. UI:114의 작업 공간 읽기 묶음·딥링크·권한별 가능 동작은 3단계 U1이 맡고 PR13·14가 기반이다.

## 근거

- 22 PR·규모·이전·완료: `docs/plan/stage-1-db.md:172-201`, `:126-134`, `:158-170`
- API 계약·PR 귀속·사람 전용: `docs/plan/stage-1-api.md:13-45`, `:60-84`, `:97-103`
- 화면 동등성·U1~U6·시험: `docs/plan/stage-1-ui.md:32-52`, `:75-78`, `:86-91`, `:102-105`; 픽셀 미비교 `:78`
- A/B 실행·PR 배분·SEL-18·19 확인: `docs/plan/stage-1-runners.md:19-51`, `:86-108`, `:110-112`
- DDL 제약·JSON 함수: `docs/plan/schemas/stage-1-ddl-draft.sql:1-11`, `:70`, `:98`, `:149`
- 0단계 7절·1단계 입력: `docs/plan/stage-0.md:69-92`, `:85-99`; 큰 단계: `docs/plan/00-brief.md:41-51`
- 현행 홈·Python 3.9·홈 이동·포트: `scripts/pes.py:73-86`(`CONFIG`·`pes_home`), `:1361-1430`(`cmd_home`), `:1469-1470`(Python 3.9 검사), `:1150`(`LEGACY_PORTS`), `:1262`(`HUB_PORTS`)
- 답 알림·CMDS: `scripts/pes.py:1256-1258`(`cmd_watch`), `:1768-1772`(`CMDS` 정의)
- 현행 정적 서버·답 수신: `scripts/serve.py:1-10`(모듈 설명), `:116-181`(`do_POST`), `:124-126`(Origin 검사), `:146-180`(답 레코드·원자 파일 쓰기·로그)
- 스킬 직접 편집 예제: `skills/core/SKILL.md:62-84`
- 테스트 격리: `tests/README.md`
- 저장소 상태: 2026-11-05 03:31 `main` 기준 SEL-11(`tests/`)·SEL-16·SEL-17 병합, SEL-12~15·18·19 hc-team worktree 진행 중, `AGENTS.md`·`spikes/` 없음
