# 0.15 → TypeScript 동등성 대응표 (초안)

- 상태: **초안 — PR26 착수 전 검토용.** 코드·계약이 아니며, 이 문서는 읽기만 했다.
- 작성: 2026-11-05, OpenCode
- 입력: [roadmap.md](roadmap.md) 3.1·3.2, [stage-2.md](stage-2.md) 2.6·4.2·4.3, [issues/stage-2.md](issues/stage-2.md) PR15·16·26, [decisions/0013](decisions/0013-mode-a-go-subscription-and-model-choice.md)·[0014](decisions/0014-mode-b-codex-app-opencode-app.md)·[0016](decisions/0016-core-language.md), [discussion/2026-11-05-codex-review-2.md](discussion/2026-11-05-codex-review-2.md), 0.15 소스 `scripts/pes.py`·`serve.py`·`setup.py`·`install.*`·`bootstrap.*`, `tests/`, `skills/`, `commands/`, `agents/`
- 범위: **PR26이 옮기는 기존 0.15.6 자산**의 기능 목록·TS 대응·동등성 시험·이전 제외 목록. PR1~22에서 이미 TS로 쓰는 새 코어는 대상이 아니다.
- 안전: 실제 `~/pes-projects`·`~/.pes/`를 읽거나 쓰지 않았고, PES 명령(`pes.py`·`serve.py`·`setup.py`·`doctor`)을 실행하지 않았다. 공개 저장소 문서·소스 정적 검토만 했다.

## 0. 다른 문서와의 경계

| 문서 | 맡는 것 | 이 문서와 겹치지 않게 하는 방법 |
|---|---|---|
| [migration-map.md](migration-map.md) | 0.15 `project.json`·`library.json`·폴더 파일 → 1단계 DDL 표·열 | 이 문서는 **필드 대응을 다시 쓰지 않는다.** 데이터 이전은 PR11·`migration-map.md`를 따른다. |
| [skill-neutral-inventory.md](skill-neutral-inventory.md) | `skills/`·`commands/`·`agents/`의 제공자 토큰 64개와 중립 계약 | 이 문서는 **호출되는 Python 명령 위치**만 표에 적고, 중립화 문구는 인벤토리를 가리킨다. |
| [issues/stage-2.md](issues/stage-2.md) | 2단계 PR별 TS 모듈·시험 파일 이름 | 이 문서는 **0.15 기능 → PR·모듈 후보** 매핑과 동등성 시험 설계만 더한다. |
| [decisions/0016](decisions/0016-core-language.md) | TS 단일 언어, PR26, 런타임·러너 미정 | 이 문서는 0016의 이전 범위를 기능 단위로 풀어 쓴다. |
| [decisions/0013](decisions/0013-mode-a-go-subscription-and-model-choice.md)·[0014](decisions/0014-mode-b-codex-app-opencode-app.md) | A 내장 실행기, B 앱 어댑터 | **0.15에는 없던 기능**이므로 동등성 대상이 아니다. 9절에서 "옮기지 않음"으로 구분한다. |

**표기**: `P:` = `scripts/pes.py`, `S:` = `scripts/serve.py`, `SETUP:` = `scripts/setup.py`, `INST:` = `install.sh`/`install.ps1`, `BOOT:` = `bootstrap.sh`/`bootstrap.ps1`. `†`는 이 문서가 제안하는 **모듈·시험 이름 후보**이며, PR에서 확정한다.

## 1. 0.15 구성과 TS 대응 한눈에

| 0.15 구성 | 역할 | TS 대응(PR) | 비고 |
|---|---|---|---|
| `scripts/pes.py` | 프로젝트 상태 CLI 32개, `project.json` 단일 원본 | `scripts/pes.ts`† + `scripts/pes_core/*.ts`(PR13~16, PR26) | 명령 이름은 유지 후보. 신규 5개(`context`·`claim`·`submit`·`wait`·`complete`)는 PR15. |
| `scripts/serve.py` | PES 홈 정적 서버 + `POST …/feedback` | `scripts/serve.ts`† + `api.ts`(PR13·14·18·26) | 포트·URL·Origin 검사 유지. `/feedback`은 새 제출 서비스의 호환 어댑터 후보. TS 서버도 기동 시 역DNS(호스트 이름 조회)를 하지 않는다(SEL-33). |
| `scripts/setup.py` | 설치·업그레이드·API 키 화면·완료 표시 | `scripts/setup.ts`†(PR26) | 외부 도구 설치 명령은 그대로 외부 경계. |
| `scripts/install.sh`·`install.ps1` | 6단계 한 줄 설치 | 같은 셸/PowerShell + TS 호출(PR26) | 설치 스크립트 자체는 TS로 다시 쓰지 않는다. |
| `scripts/bootstrap.sh`·`bootstrap.ps1` | Git·Python·Node 확인/설치 | 같은 셸/PowerShell(PR26) | Python은 0.15 이전 동안에만 필요. Node/Bun 확인으로 바뀐다. |
| `tests/*.py` | 0.15 특성화 시험 5파일 + `conftest.py` | `tests/*.test.ts`(PR26) | 이전 뒤 Python 시험 제거. 새 코어 시험은 PR1~22에 이미 있다. |
| `skills/`·`commands/`·`agents/` | `python3 …/pes.py`·`setup.py` 호출 | 새 TS CLI 호출(PR17·26) | 중립화는 `skill-neutral-inventory.md`. |
| `questions/`·`templates/` | 질문 은행·HTML 템플릿 | 같은 자산 이전·재사용(PR8·9·18) | 템플릿 바이트 동일성이 아니라 데이터·구조 동등성으로 본다. |

규모: CLI **32개**(쓰기 19·읽기 13), `setup.py` **7개**(`keys-serve` 내부 포함), HTTP **7종**, 설치 **6단계**, 0.15 시험 **5파일**.

## 2. `pes.py` 하위 명령 전수 (32개)

### 2.1 쓰기 명령 19개

| # | 명령·인자 | 출력 | 만드는 파일·부작용 | 종료 코드 | TS 대응(PR/모듈/CLI) |
|---:|---|---|---|---|---|
| 1 | `init <dir> --topic T [--slug S] [--import D]` | `project.json` 경로, 참고자료 개수(있을 때) | 폴더 `feedback/ask/snapshots/shots/out`, `feedback.log`, `project.json`, `library.json`·`library/shots`(import) | 0; 2 중복 프로젝트; 1 인자·주제 없음; 3 잠금 | PR13 `project.create` + PR15 CLI; `commands.ts`·`paths.ts`·`config.ts`; `pes init` |
| 2 | `ask-prep <dir> <stage 또는 resume>` | 복사된 `ask/<id>.json` 경로 | `ask/<id>.json`(없을 때만) | 0; 1 질문 은행 없음 | PR8+15; `questions.ts`; `pes ask-prep` |
| 3 | `ask <dir> <spec.json>` | `ask-<id>.html` 경로 | `ask-<id>.html`; 단계가 `pending`이면 `asking`으로 저장 | 0; 1 파일·JSON 오류 | PR8+15; `questions.ts`·`content.ts`; `pes ask` |
| 4 | `round-start <dir> <stage>` | `<단계> R<n> 시작` | 이전 라운드 `history` 한 줄, `round+1`, `status=active`, `changes=[]`, `current` | 0; 1 단계 오류 | PR6+15; `editions.ts`; `pes round-start` |
| 5 | `merge <dir> <stage> <json…>` | `<단계>: n건 병합` | 항목 생성·갱신, 출처 중복 제거/누적(write·section은 교체), stats·shots·conflicts·links, `open_questions`→suggestions, `depth+1` | 0; 1 JSON·단계 오류; 3 잠금 | PR7+15; `content.ts`; `pes merge` |
| 6 | `render <dir> [stage]` | `index.html` 경로 | `round>0`이면 `snapshots/<s>-R<n>.json`, 같은 라운드 추가 판은 `snapshots/<s>-R<n>/<k>.json`; `index.html`, 허브 갱신 | 0; 1 단계 오류 | PR9+15; `content.ts`·`files.ts`; `pes render` |
| 7 | `approve <dir> <stage>` | 승인·다음 단계·보고서 안내 여러 줄 | `status=approved`, `approved_at`, `history`, `stale=false`; plan→research 항목 생성; 다음 단계 `asking` 또는 `complete=true`; index 재생성 | 0; 1 단계 오류; 3 잠금 | PR6+14+15; `editions.ts`·`commands.ts`; `pes approve` |
| 8 | `reopen <dir> <stage>` | `<단계> 다시 열림` + stale 표시 목록 | `status=active`, `approved_at=null`, `review=null`, `stale=false`, `history`, `current`, `complete=false`; 뒤 단계 `stale=true` | 0; 1 단계 오류; 3 잠금 | PR6+14+15; `editions.ts`; `pes reopen` |
| 9 | `mark <dir> <file…>` | `처리 완료 표시 n개` | `processed`에 파일명 추가 | 0; 3 잠금 | PR14+15; `questions.ts`; `pes mark` |
| 10 | `chat <dir> <stage> "text" [kind]` | 답 파일 경로 | `feedback/<s>-R<n>-<ts>.json`(`via=chat`), `processed` 추가 | 0; 1 단계 오류; 3 잠금 | PR14+15; `questions.ts`; `pes chat` |
| 11 | `note <dir> "text"` | `인계 메모 n개` | `notes[]`에 `{time, stage, text}` | 0; 3 잠금 | PR15; `content.ts`; `pes note` |
| 12 | `qa-brief <dir> <stage>` | `qa-brief.md` 경로 | `rounds/<s>-R<n>/qa-brief.md`, `digest.txt`, `self-review.json` | 0; 1 단계 오류 | PR7+9+16; `content.ts`; `pes qa-brief` |
| 13 | `qa <dir> <stage> [--file f]` | 판정·QC/QA/high·표본 일치 요약 | `stages.<s>.qa`, `review_log`; 파일 없으면 실패 | 0; 1 결과 파일 없음 | PR7+9+16; `content.ts`; `pes qa` |
| 14 | `remote list·add·remove·clear` | 허용 주소 목록 | `~/.pes/config.json`의 `trusted_origins` | 0; 1 주소 형식 오류 | PR10+15; `config.ts`; `pes remote` |
| 15 | `serve <dir>` | 프로젝트 URL | index·hub 재생성, 포트 8760~8764 서버 기동, `.pes-hub*` 기록 | 0; 1 포트 없음 | PR15+18; `serve.ts`†; `pes serve` |
| 16 | `stop [dir]` | `서버 종료 (root — …)` | pid 파일 삭제, 서버 종료 | 0 | PR15+18; `serve.ts`†; `pes stop` |
| 17 | `home [new] [--from old] [--force]` | 홈·프로젝트 수 또는 이동 결과 | 프로젝트 폴더 이동, `~/.pes/config.json` 갱신, 서버 재기동 | 0; 1 중첩·이름 충돌; 3 다른 세션 사용 | PR15+16; `config.ts`·`paths.ts`; `pes home` |
| 18 | `lock <dir> [--force]` | `잠금: <slug> (세션 …)` | `.pes-lock` | 0; 2 `PES_OWNER` 없음; 3 다른 세션 | PR5+15; `runs.ts`(lease 정합); `pes lock` |
| 19 | `unlock <dir>` | `잠금 해제` | `.pes-lock` 삭제 | 0; 3 다른 세션 | PR5+15; `runs.ts`; `pes unlock` |

### 2.2 읽기·보고서 명령 13개

| # | 명령·인자 | 출력 | 읽는 것·부작용 | 종료 코드 | TS 대응(PR/모듈/CLI) |
|---:|---|---|---|---|---|
| 20 | `status <dir>` | 주제·현재 단계·6단계 요약·참고자료·메모·미처리 답·대시보드 URL | `project.json`, `library.json`, feedback, server 상태 | 0; 1 읽기 오류 | PR16; `commands.ts`·`content.ts`; `pes status` |
| 21 | `pending <dir>` | 미처리 답 파일 경로(한 줄씩) | `feedback/*.json`, `processed` | 0 | PR16; `questions.ts`; `pes pending` |
| 22 | `digest <dir> <stage> [--round N]` | 항목별 요약 첫 줄·수치·충돌·신뢰도·출처 확인율·남은 질문 | `stages.<s>` | 0; 1 단계 오류 | PR16; `content.ts`; `pes digest` |
| 23 | `show <dir> <stage> [id…] [--fields a,b]` | JSON(전체 요약 또는 선택 항목·필드) | `stages.<s>.items` | 0; 1 단계 오류 | PR16; `content.ts`; `pes show` |
| 24 | `list [root]` | 번호·담당·주제·현재 단계·할 일·갱신·URL | 홈 아래 `*/project.json` | 0; 프로젝트 없으면 안내 | PR16; `paths.ts`·`serve.ts`†; `pes list` |
| 25 | `hub [root]` | 목록 화면 URL | `index.html`(허브), `.pes-hub`, 서버 | 0; 1 포트 없음 | PR16+18; `serve.ts`†; `pes hub` |
| 26 | `open <dir 또는 url>` | 연 주소 | 기본 브라우저 실행 | 0; 1 인자 오류 | PR16; `serve.ts`†; `pes open` |
| 27 | `which <도구>` | 도구 전체 경로 | PATH·홈·OS별 설치 위치 | 0; 1 못 찾음 | PR16; `paths.ts`; `pes which` |
| 28 | `doctor [dir] [--fix] [--net] [--json]` | 환경·도구·키·서버·프로젝트 진단, `--json` 배열 | 읽기 중심. `--fix`는 tmp·잠금·포트·대시보드·보고서 등록 수정 | 0; 1 `bad`가 있을 때 | PR16; `doctor.ts`†; `pes doctor` |
| 29 | `watch <dir>` | `tail -n0 -F <feedback.log>`로 `FEEDBACK` 줄을 따라가는 명령 | 없음(출력만) | 0 | PR16(+입력 long-poll); `watch` 호환 출력; `pes watch` |
| 30 | `assemble <dir>` | `out/report.md` 경로·장/절·각주 수 | `out/report.md`, `out/sources.json`; 각주 범위 밖 경고는 stderr | 0; 1 읽기 오류 | PR9+16; `content.ts`·`files.ts`; `pes assemble` |
| 31 | `report <dir> <stage>` | 보고서 이름·등록 형식 목록·보완 안내 | `reports/<s>/report.md`, `report.html`, `eli5.html`(json 있을 때), docx/hwpx/pdf/pptx 등록, `stages.<s>.reports`, `reports_built`, index | 0; 1 단계 오류 | PR9+16; `content.ts`·`files.ts`; `pes report` |
| 32 | `web <dir> [--assemble]` | `out/report.html` 경로·출처 수·확인 수 | `out/report.html`; `report.md` 없으면 assemble | 0; 1 읽기 오류 | PR9+16; `content.ts`·`files.ts`; `pes web` |

**공통 종료 코드**: 인자 없음·알 수 없는 명령은 사용법 출력 + 1. `die()` 기본 1, 잠금 충돌 3, `init` 중복 2, `lock` 소유자 없음 2, `doctor` bad 1. 인자 없는 단일 명령(`list`·`hub`·`home`·`doctor`·`stop`·`remote`)은 내부에서 `--`를 붙여 처리한다. 새 TS CLI도 같은 값을 유지하는 것을 동등성 계약으로 둔다.

## 3. `serve.py` HTTP 경로 전수

| # | 메서드·경로 | 입력 | 응답 | 보안·부작용 | TS 대응(PR/모듈) |
|---:|---|---|---|---|---|
| 1 | `GET /whoami` | 없음 | `{root, single:true}` | loopback만, CORS는 `127.0.0.1/localhost:87xx`만 | PR15+18 `serve.ts`† |
| 2 | `GET /version`, `GET /<slug>/version` | 없음 | `{v: index.html·ask-*.html 최대 mtime}` | 없음 | PR16+18; DB event seq로 대체 후보 |
| 3 | `GET /ping`, `GET /<slug>/ping` | 없음 | `{ok:true}` | 없음 | PR15+18 |
| 4 | `GET /` | 없음 | 허브 `index.html` | 디렉터리 목록 404, `no-store` | PR18; 서버 렌더/정적 |
| 5 | `GET /<slug>/` | 없음 | 프로젝트 `index.html`; 없으면 최근 `ask-*.html`로 302 | 슬러그 `[A-Za-z0-9][A-Za-z0-9._-]{0,80}`만, 디렉터리 목록 404 | PR18 |
| 6 | `GET <정적 파일>` | 없음 | 파일(UTF-8 charset, `no-store`) | 경로 root 밖 탈출 금지(SimpleHTTPRequestHandler) | PR18 |
| 7 | `POST /<slug>/feedback`(예전 `/feedback`은 Referer로 프로젝트 추정) | `{stage, round, kind, text, answers, spec}` | 200 `{ok:true,file}` | Origin 허용 목록(`127.0.0.1:port`·`localhost:port`·`trusted_origins`), 본문 ≤256KiB, kind 6종, text 또는 answers 필수, O_EXCL 파일, `feedback.log` 한 줄, `Tailscale-User-Login`을 `who`로 | PR14 제출 + PR18 호환 어댑터; `api.ts`·`questions.ts` |

**오류**: 403 Origin, 413 본문 초과, 400 JSON/kind/empty, 404 프로젝트·경로 없음. **서버는 127.0.0.1에만 bind**하고 `ThreadingHTTPServer`를 쓴다. 새 서버도 이 경계를 유지한다.

## 4. setup·install·bootstrap

### 4.1 `setup.py` 7개 명령

| 명령 | 출력·동작 | 파일 | 종료 코드 | TS 대응 |
|---|---|---|---|---|
| `check [--json]` | 도구·스킬·키 상태(`ok/missing/user/optional/key`), 그룹 | 없음 | 0 | PR26 `setup.ts`†, 같은 상태 이름 |
| `install <이름… 또는 missing>` | `OK/USER/SKIP/FAIL <이름>` 줄 | 설치되는 외부 도구 | 0(항목별 상태 문자열) | 같은 명령, 외부 설치 스크립트 호출 유지 |
| `upgrade <이름… 또는 all>` | `UPGRADED/OK/FAIL/SKIP <이름> <버전>` | 외부 도구·스킬 갱신 | 0 | 같음 |
| `keys [--no-open] [--wait]` | `127.0.0.1:8759/?t=<token>` 주소, `WATCH …` 또는 완료 대기 | `~/.pes/setup-keys.json`, `setup-keys.out`, `setup.log`, `~/.claude/settings.json`, 백업 | 0; 포트 사용 중 1 | PR26 `setup.ts`†, 포트·token·Origin 검사 유지 |
| `keys-serve <token>` | 내부 키 입력 서버, `SETUP keys …` 기록 | `setup.log` | 0(`os._exit`) | 같은 내부 명령 후보 |
| `mark` | `설치 완료 표시: <path>` | `~/.pes/setup.json` | 0 | 같음 |
| `needed` | `OK` 또는 이유 | 위 표시 읽기 | 0; 표시 없음·버전 불일치 1 | 같음 |

### 4.2 설치·부트스트랩 6단계

| 단계 | `install.sh` | `install.ps1` | 만드는 것 | TS 전환 |
|---|---|---|---|---|
| 1 | `bootstrap.sh`로 Git·Python 3.9+·Node 확인/설치 | `bootstrap.ps1`로 Git·Python 3.12·Node LTS 확인/winget | 시스템 도구 | Python 요구를 TS 런타임 요구로 교체(PR26). 이전 중에는 임시로 병존. |
| 2 | Claude Code/Desktop 탐색, 없으면 공식 설치 | 같음 | `~/.claude/settings.json`(Desktop만) | 그대로 |
| 3 | `claude plugin marketplace add/install` | 같음 | `~/.pes/src` clone/pull, 플러그인 | 그대로 |
| 4 | `setup.py install missing`·`upgrade all` | 같음 | 외부 도구 | `setup.ts` 호출로 교체 |
| 5 | `setup.py keys --wait` | 같음 | 키 화면·설정 | `setup.ts keys`로 교체 |
| 6 | `pes.py doctor --net`·`setup.py mark` | 같음 | 진단·완료 표시 | `pes doctor`·`setup.ts mark`로 교체 |

`bootstrap` 출력은 한 줄씩 `<OK/INSTALLED/MISSING/FAIL> <이름> <설명>`이고 마지막이 `PYTHON <명령>`이다. PR26은 이 출력 계약을 유지하되 Python 확인을 TS 런타임 확인으로 바꾼다.

## 5. skills/commands/agents의 Python 호출 위치

| 위치 | 현재 호출 | TS 뒤 |
|---|---|---|
| `skills/core/SKILL.md:23,25` | `python3 -I ${CLAUDE_PLUGIN_ROOT}/scripts/pes.py` | `pes`/`$PES_ROOT/scripts/pes.ts` 실행 명령(런타임 확정 뒤) |
| `skills/core/SKILL.md:37` | `setup.py check·install·keys·mark·needed` | `setup.ts` 같은 하위 명령 |
| `skills/core/SKILL.md:66-72` | `python3 -I - …`로 `project.json` 직접 읽기·쓰기 | **옮기지 않음.** `pes context/submit/merge/note` 등 검증 명령(PR17) |
| `skills/core/SKILL.md:103` | Windows `py -3` | 런타임 실행 명령 |
| `skills/core/SKILL.md:109` | `PES_OWNER=<ID> python3 … pes.py` | owner 세션·lease 주입(어댑터), CLI 직접 환경변수 제거 |
| `skills/core/SKILL.md:160,161` | `$PES serve/open/watch` | 같은 CLI 이름, watch는 long-poll/이벤트 출력 후보 |
| `skills/research/SKILL.md:10,71,83` | `$PES doctor`·`$PES which` | 같은 CLI 이름 |
| `commands/setup.md:14,17-25` | `PY -I PLUG/scripts/setup.py`·`pes.py doctor` | `setup.ts`·`pes doctor` |
| `commands/run.md:6` | `setup.py needed` | `setup.ts needed` |
| `commands/start.md:6` | `setup.py needed` | `setup.ts needed` |
| `agents/reviewer.md:10,17` | `pes.py show`·`pes.py which` | `pes show`·`pes which` |
| `agents/verifier.md:9`, `agents/researcher.md:9` | `pes.py which` | `pes which` |

중립 계약·금지 토큰·lint 규칙은 [skill-neutral-inventory.md](skill-neutral-inventory.md) 3절을 그대로 쓴다. 이 문서는 **명령 호출 위치**만 확인했다.

## 6. PR별 TS 대응 요약

| PR | TS 모듈 후보 | 옮기는 0.15 기능 | 시험 |
|---|---|---|---|
| PR5 | `runs.ts` | lock/unlock의 lease 의미, heartbeat | `test_runs_leases.test.ts` |
| PR6 | `editions.ts` | round-start, approve, reopen, snapshot | `test_editions_stages.test.ts` |
| PR7 | `content.ts` | merge, item/version/source, digest·show | `test_content_sources.test.ts` |
| PR8 | `questions.ts` | ask-prep, ask, 질문 세트·폼 | `test_questions_answers.test.ts` |
| PR9 | `files.ts` | render, report 파일 등록, assemble 재료 | `test_blobs.test.ts` |
| PR10 | `config.ts`·`policy.ts` | remote·전송 정책·도구 경로 | `test_actors_policy.test.ts` |
| PR13·14 | `api.ts` | `context/claim/submit/wait/complete`, 질문·답·changes | `test_api_context.test.ts`·`test_api_questions.test.ts` |
| PR15 | `commands.ts`·`config.ts` | 쓰기 CLI 19개, lock/unlock, home | `test_cli_write.test.ts` |
| PR16 | `commands.ts`·`content.ts`·`doctor.ts`† | 읽기 CLI 13개, report/assemble/web, doctor | `test_cli_read.test.ts` |
| PR18 | `serve.ts`† | 허브·대시보드·ask·인쇄·딥링크, `POST /feedback` | `test_web_parity.test.ts` |
| PR26 | `setup.ts`†, `pes.ts`† | 0.15 이전·동등성·설치·Python 제거 | `test_*` 이전 시험 |

새 코어 시험은 이미 PR1~22에 있으므로 PR26은 **0.15 특성화 시험만** 옮긴다.

## 7. 동등성 시험 설계

### 7.1 기본 방식

1. **같은 합성 fixture**를 두 사본으로 만든다. 한쪽은 0.15 Python, 다른 쪽은 TS 0.16이며, TS 쪽은 같은 fixture를 PR11 legacy importer로 staging DB에 적재한 뒤 같은 명령을 실행한다.
2. 같은 명령·같은 입력을 순서대로 실행하고 **stdout·stderr·종료 코드**를 수집한다.
3. **산출 파일**을 수집한다: `ask-*.html`, `reports/**`, `out/**`, `snapshots/**`, `feedback/**`, `project.json`/DB.
4. 정규화기(normalizer)를 통과시킨 뒤 비교한다. 바이트 비교는 **정규화 뒤에도 같아야 하는 산출물에만** 한다.
5. 상태 저장 방식이 바뀌는 명령은 파일 대신 **시험 전용 상태 DTO**로 비교한다.

**상태 DTO 후보**(시험 전용, 제품 계약 아님): `{topic, slug, created, current, complete, stages:{status, round, settings, items[id,title,kind,status,summary,details,sources,stats,links,updated_round], review, suggestions, warnings, changes, summary, approved_at, stale, reports}, processed, notes, library}`. 0.15는 `project.json`에서, TS는 이전 결과 DB에서 같은 DTO를 만든다. `migration-map.md`의 필드 대응을 재사용하고 새 필드 규칙을 만들지 않는다.

### 7.2 정규화 규칙

| ID | 대상 | 규칙 |
|---|---|---|
| N1 | 시각 | `YYYY-MM-DD HH:MM`, `YYYYMMDD-HHMMSS`, `built`, `approved_at`, `reports_built`, `created`, `recorded` → `<TIME>`/`<DATE>` |
| N2 | 경로 | 저장소 루트 → `<PES>`, 프로젝트 루트 → `<PROJECT>`, 홈 → `<HOME>`, 임시 폴더 → `<TMP>`, `\` → `/` |
| N3 | JSON | 파싱 후 키 정렬, `ensure_ascii=False` 동등, 정수·10진 문자열 구분, `null` 유지. 파일 바이트는 비교하지 않는다 |
| N4 | 순서 | 업무 순서가 있는 목록은 `(stage ordinal, round, item id, source 순서)`로 고정. 순서가 계약이 아니면 multiset 비교 |
| N5 | ID | 새 UUID·tx·event·lease는 첫 등장 순서대로 `<ID:n>`으로 치환하고 참조 일관성만 본다 |
| N6 | HTML | DOM 텍스트·지정 선택자·`<script id="data">` JSON을 비교. 속성 순서·공백·`built` 값은 무시 |
| N7 | 인코딩 | UTF-8, BOM 없음, LF 기준. Windows 산출물도 LF로 정규화 |
| N8 | 콘솔 | ANSI 제거, 경로·시각 치환, 줄 순서 유지, 종료 코드는 **정확히** 비교 |
| N9 | 파일 메타 | mtime·권한·소유자 무시, 내용 hash만 비교 |
| N10 | 알려진 차이 | 7.5의 의도된 차이는 비교 전에 제거하거나 `expected-diff`로 표시 |

### 7.3 출력별 비교 방법

| 출력 | 같은 것으로 보는 것 | 비교하지 않는 것 |
|---|---|---|
| 질문 화면 `ask-*.html` | 제목 escape, `data.spec`, 질문 순서, `_` 키 제거, `</script>` escape, 공용 모듈 1회 삽입 | `built`, 파일 mtime, 속성 순서 |
| 단계 보고서 `report.md` | 제목·단계·라운드·항목 순서·출처 번호·요약·수치 표·충돌·검토 기록 | 작성 시각, 절대 경로 |
| 단계 보고서 `report.html` | `data` JSON, 제목·본문 텍스트, 표 구조 | `built`, 스타일·공백 |
| `out/report.md`·`sources.json` | 장 순서, 각주 번호 재매핑, 출처 중복 규칙, `verified` | 작성 시각 |
| `out/report.html` | 본문·출처·표지 데이터, 표지 없음 안내 | `built` |
| `project.json` 처리(legacy 읽기·이전 입력) | `load()`가 채우는 기본값, `_`/미지 키 보존, library 분리 | 파일 바이트, 키 순서 |
| CLI stdout/stderr | 정규화 문구·줄 순서·exit | 색·절대 경로 |
| HTTP 응답 | status, `Content-Type`, `Cache-Control`, JSON `ok`·오류 코드 | `Date`, `Server`, `file`의 시각 부분 |
| 부작용 파일 | 파일 집합, 내용 hash, `feedback.log` 줄 형식 | mtime·임시 파일 |

### 7.4 시험 사례

| # | 입력 | 비교 | 통과 기준 |
|---|---|---|---|
| E01 | `init` 합성 주제, 한글·공백 경로 | 상태 DTO, stdout, exit 0; 중복 init은 exit 2 | 차이 0(정규화) |
| E02 | `ask` 질문 은행 `questions/plan.json` + 악성 `</script>` 라벨 | `data.spec`, 제목 escape, 모듈 1회 | 차이 0 |
| E03 | `round-start` 2회 + `merge` 2회(출처 중복·stats·links) | 상태 DTO, `depth`, suggestions | 차이 0, 0.15의 depth 결함은 의도된 차이 |
| E04 | `approve plan`·`reopen` | research 항목 생성·재사용, stale·complete, stdout | 차이 0 |
| E05 | `report plan`(rq/topic, 출처 중복) | report.md 정규화 텍스트, 등록 형식 | 차이 0 |
| E06 | `assemble` + `web` | `out/report.md`, `sources.json`, `report.html` | 각주·출처·표지 동등 |
| E07 | `status`·`digest`·`show --fields`·`pending`·`mark`·`note` | stdout 정규화, 상태 DTO | 차이 0 |
| E08 | `POST …/feedback` 정상·Origin 거부·kind 오류·빈 본문·413·404 | status, JSON, `feedback.log` | 차이 0 |
| E09 | 같은 초 동시 feedback 12개 | 파일 수·내용(또는 제출 영수증), 답 유실 0 | 유실 0(0.15 결함 재현 금지) |
| E10 | `lock`/`unlock` 다른 세션·만료·`--force` | exit 2/3/0, 상태 DTO의 owner/lease | 의미 동등 |
| E11 | 프로젝트 폴더 사본 이동 뒤 `status/render/report/assemble/web` | 상태 DTO·산출물 | 차이 0 |
| E12 | 깨진 `project.json`(status exit 1) / 2MB 프로젝트 | stderr 유형, exit, 원본 불변 | 의도된 오류 동등 |
| E13 | `serve`/`hub`/`open`/`stop` | URL·포트·`whoami`·`version`·`ping` | 경로·응답 동등 |
| E14 | `setup check --json`·`needed` | 상태 이름·exit 1/0 | 차이 0(외부 도구 버전 제외) |
| E15 | `doctor --json` 합성 홈 | 섹션·level·exit | 스키마 동등, Python 전용 항목은 의도된 차이 |

### 7.5 의도된 차이(동등성 예외)

| 차이 | 이유 | 시험 처리 |
|---|---|---|
| 새 ID(UUID·tx·event·lease) vs 0.15 정수 item id | 새 코어가 DB·버전·사건을 쓴다 | N5로 치환, 참조만 비교 |
| `project.json` 단일 원본 → SQLite 원본 | 1단계 DB 승계 | 상태 DTO 비교. `project.json`은 legacy 읽기 전용 |
| `feedback/*.json` 파일 → `submissions`/`answers` | 단일 명령 서비스 | `/feedback` 호환 응답·영수증 의미 비교 |
| `.pes-lock`·`PES_OWNER` → `project_leases`/토큰 | 실행 담당 하나·lease | CLI exit·owner 의미만 비교 |
| `watch` tail 명령 → long-poll/이벤트 | 웹·API 전환 | 출력 형식 호환 또는 새 대기 방식으로 명시 |
| merge `depth` 재제출 증가, 같은 라운드 snapshot 덮어쓰기 | 0.15 결함 후보(테스트 xfail) | 새 코어는 고친 동작을 정답으로 두고 차이를 기록 |
| `doctor`의 Python/템플릿 검사 | 런타임 변경 | TS 런타임 검사로 바꾸고 섹션·exit 유지 |
| `hub`/`serve` 정적 HTML 생성 | DB/API 서버 | URL·포트·응답 계약 동등, 내부 구현은 다름 |

## 8. 기존 `tests/*.py` → TS 시험

| 0.15 시험 | 고정하는 것 | TS 시험 후보 | PR |
|---|---|---|---|
| `conftest.py` | 임시 HOME·PES_HOME, 실제 홈 감사 훅, CLI subprocess, 합성 프로젝트 | `tests/helpers/isolated_home.ts`†·`home_guard.ts`†·`cli.ts`†·`synthetic_project.ts`† | PR26 |
| `test_project_basic.py` | 격리, 감사 훅, init/중복, `load()` 기본값, 깨진/큰 JSON, main 인자·exit | `test_cli_compat.test.ts`†, `test_home_guard.test.ts`†, `test_state_load.test.ts`† | PR26 |
| `test_questions.py` | 질문 데이터·escape·공용 모듈·파일명 정리·질문 은행 | `test_questions_html.test.ts`†, `test_question_bank.test.ts`† | PR26 |
| `test_serve.py` | feedback 저장·로그·Origin·413/400/404, pending/mark/restart, version/ping/whoami, 동시 제출 | `test_feedback_http.test.ts`†, `test_feedback_collision.test.ts`† | PR26 |
| `test_state.py` | 라운드·merge·approve/reopen·snapshot·보고서·assemble/web·복원·깨진/큰 JSON | `test_state_transitions.test.ts`†, `test_reports_compat.test.ts`†, `test_restore_compat.test.ts`† | PR26 |
| `test_lock.py` | owner 필수·다른 세션 exit 3·since 갱신·만료·force·TTL 경계 | `test_lock_compat.test.ts`† | PR26 |
| (새 코어 시험) | DB·명령 서비스·API·runner·어댑터 | PR1~22의 기존 `tests/test_*.test.ts` | PR1~22 |

PR26은 위 0.15 시험을 **같은 fixture로** 옮기고 차이 0을 확인한 뒤 Python 시험을 제거한다. 새 Python 시험은 만들지 않는다.

## 9. 옮기지 않음 / 새 코어로 대체

| 0.15 요소 | 처리 | 이유·대체 |
|---|---|---|
| `project.json`·`library.json` 직접 읽기·쓰기(스킬 예제 포함) | **옮기지 않음** | 단일 명령 서비스·DB. `migration-map.md`는 이전 입력만 정의 |
| `project.json`을 상태 원본으로 두는 `load`/`save` | **대체** | SQLite가 원본(1단계 DB). legacy는 읽기 전용 |
| `.pes-lock`·`PES_OWNER` 환경변수 잠금 | **대체** | `project_leases`·토큰(PR5·10). CLI는 이전 기간 호환만 |
| `feedback/*.json` 파일 수신 | **대체** | `submissions`·`answers`(PR14). 예전 화면용 `/feedback` 어댑터만 유지 |
| `stages.reports`·`reports_built` JSON 등록 | **대체** | `files.ts`·artifact 버전(PR9·16) |
| `hub`/`dashboard` 정적 HTML을 `project.json`에서 생성 | **대체** | 서버 렌더·DB 읽기 모델(PR18). URL·포트는 유지 |
| legacy `project.json` 읽기 경로 | **한시 유지** | 미전환 프로젝트 읽기 전용. 제거는 별도 정리 PR(로드맵 예비분) |
| `research-loop` `state.json` import (`--import`) | **PR11로 이관** | 언어와 무관한 데이터 이전. Python 코드 실행 없음 |
| `watch`의 `tail -F` 명령 | **대체 후보** | 입력 long-poll/이벤트(PR16). 호환 출력은 이전 기간만 |
| `doctor`의 Python 버전·모듈 점검 | **대체** | TS 런타임·SQLite·템플릿 검사. 섹션·`--json`·exit 유지 |
| `setup.py`의 Python 도구 설치 분기 | **TS로 이전** | 외부 도구 설치 스크립트는 외부 경계로 유지 |
| `serve.py`의 SimpleHTTPRequestHandler | **대체** | TS HTTP 서버. loopback·Origin·`no-store`·디렉터리 404 유지 |
| 0.15 `opencode serve`·로컬 runner A 실행 구조 | **옮기지 않음** | 결정 0013으로 A는 PES 내장 실행기. 0.15 제품 기능이 아니라 시험·계획 단계의 구조 |
| Claude 전용 스킬 토큰·Monitor·`anthropic-skills:*` | **중립화** | `skill-neutral-inventory.md`(PR17) |
| Python pytest 하네스 | **TS 러너로 이전** | PR26. 제품 기능 아님 |

### 9.1 외부 Python 경계

PES 코어는 TypeScript 하나다(결정 0016). 이 저장소에서 Python 이 필요한 것은 **PES 0.15 도구(`pes.py`·`serve.py`·`setup.py`)와 0.15 pytest** 뿐이다. 외부 도구는 각자 자기 요구를 정하고, 그 요구는 PES 코어의 일이 아니므로 **경계 밖**으로 두고 PES 가 대신 옮기거나 고치지 않는다.

| 외부 도구 | Python 과의 관계 | 경계 |
|---|---|---|
| kosis (통계청 KOSIS CLI·스킬) | npm 패키지(`@clazic/kosis`)로 설치된다. 이 저장소에는 kosis 가 Python 을 요구한다는 근거가 없다. | **경계** 밖 — 무엇을 요구하든 kosis 쪽 일이고 PES 코어는 관여하지 않는다. |
| vworld (국가공간정보 CLI·스킬) | OS 별 네이티브 바이너리(`scripts/setup.py`의 `vworld-macos` 등)로 다룬다. 이 저장소에는 vworld 가 Python 을 요구한다는 근거가 없다. | **경계** 밖 — 무엇을 요구하든 vworld 쪽 일이고 PES 코어는 관여하지 않는다. |
| 그 밖의 외부 도구 (`setup.py`가 설치하는 korean-law·ego lite 등) | 도구마다 다르다. 이 저장소는 그 도구들의 Python 요구 여부를 확인하지 않았다. 설치 분기만 `setup.ts`로 옮기고 도구 안은 건드리지 않는다(위 표 `setup.py` 줄). | **경계** 밖 — 도구별 요구. |

경계의 뜻:

- PES TS 코어는 외부 도구가 무엇을 요구하든 Python 을 **실행하지 않는다**. 호출하지 않고, 불러오지 않고, 필요로 하지 않는다. 코어 코드에 `child_process` 로 `pes.py`·`serve.py` 같은 Python 을 띄우는 경로는 없다.
- legacy importer 는 옛(0.15) 데이터 **형식만 읽는다** — `project.json`·`library.json`·폴더 파일을 읽을 뿐 Python 을 실행하지 않는다. 시험 `tests/test_legacy_import_no_python.test.ts`가 이를 고정한다.
- 0.15 진입점(`pes.py`·`serve.py`·`setup.py`)이 남아 있는 동안은 제품을 쓰려면 Python 이 필요하다(README 표). 그 진입점은 PR26 이 끝나면 없어진다.

## 10. 위험·모르는 점

| 위험·모름 | 영향 | 줄이는 방법 | 확인 시점 |
|---|---|---|---|
| 저장 방식 변경(JSON→DB)으로 바이트 동등성 불가 | "차이 0"을 잘못 해석 | 상태 DTO·정규화 규칙을 먼저 고정 | PR26 착수 전 |
| 시각·시간대·로캘 | 보고서·파일명·로그 차이 | `Clock` 주입, 로컬 시간대 고정, N1 | E01~E12 |
| JSON 키 순서·숫자·유니코드 | `project.json`·API 응답 차이 | N3, 10진 문자열 계약 | E01·E03 |
| HTML 템플릿 엔진·공백·속성 순서 | ask/report HTML 차이 | N6, `data` JSON·선택자 비교 | E02·E05·E06 |
| SQLite 조회 순서 | 항목·출처·이력 순서 차이 | 명시 `ORDER BY`, N4 | E03~E06 |
| 새 UUID·tx·event | 텍스트·링크 차이 | N5, 참조 무결성만 | 전체 |
| Windows 경로·인코딩·줄바꿈 | Windows CI 실패 | N2·N7, Windows 전용 사례 | E01·E10 |
| 0.15의 xfail 결함(depth, snapshot 덮어쓰기) | "동등"과 "수정" 충돌 | 7.5에 의도된 차이로 명시, 새 동작을 정답으로 | E03 |
| TS에서 Python 감사 훅과 같은 홈 격리 재현이 어려움 | 실제 홈 접근 사고 | 테스트 러너 샌드박스·경로 allowlist·임시 HOME 강제 | PR26 |
| `/feedback` 호환 어댑터의 응답 shape | 기존 화면 깨짐 | `{ok, file}` 또는 `{ok, receipt}` 계약을 PR18에서 확정 | E08 |
| `watch` tail 출력과 long-poll의 의미 차이 | 스킬·Monitor 호환 | 이전 기간 호환 출력 유지 또는 어댑터 | E13 |
| `lock`의 TTL·`since`와 lease/fence 의미 차이 | 다른 세션 차단 오탐/미탐 | exit 코드·owner 의미 시험, TTL 값 분리 | E10 |
| `doctor` 항목·`--json` 스키마 | 운영 진단·CI 파싱 | 섹션·level·exit 고정, Python 전용 항목만 차이 | E15 |
| `setup` 외부 도구 버전·설치 방식 변동 | E14 실패 | 외부 버전은 비교 제외, 상태 이름만 | E14 |
| 런타임·테스트 러너 미정(0016) | 명령·import 경로 미확정 | WEB0/언어 시험 뒤 확정, 그전에는 `후보`로 표시 | PR26 전 |
| 0.15 Python을 오래 병존 | 이중 구현·불일치 | PR26에서 제거, 이전 중 동결 | PR26 |
| legacy 읽기 경로 제거 시점 | 미전환 프로젝트 단절 | 미전환 0·대체 경로 검증 뒤 별도 PR | 2단계 잔여 |
| 실제 자료가 fixture로 유입 | 공개 저장소 노출 | 합성 fixture만, 실제 홈 미접근 | 전체 |

## 11. PR26 착수 순서(제안)

| 순서 | 할 일 | 산출물 |
|---:|---|---|
| 1 | 상태 DTO·정규화기·이중 실행 하네스를 먼저 만든다 | `tests/helpers/*`†, `tests/compat/*`† |
| 2 | 0.15 시험 5파일을 그대로 TS로 옮겨 **현재 동작**을 고정한다 | `test_*_compat.test.ts`† |
| 3 | CLI 32개를 이름·인자·exit 계약 그대로 TS로 옮긴다(내부는 DB/서비스) | `pes.ts`†, `commands.ts` |
| 4 | `serve.ts`·`setup.ts`를 옮기고 `/feedback`·키 화면 호환을 확인한다 | `serve.ts`†, `setup.ts`† |
| 5 | 생성 산출물(ask HTML·보고서·out)을 정규화 비교해 차이 0을 확인한다 | E02·E05·E06 |
| 6 | `skills/`·`commands/`·`agents/` 호출을 새 CLI로 바꾼다(PR17 연결) | 인벤토리 64개 |
| 7 | 설치 스크립트를 새 런타임 기준으로 바꾸고 Windows/Mac 시험 | `install.*` |
| 8 | Python 테스트·코드 제거, 0.16.0 단일 코드베이스 확인 | PR26 완료 |

**열린 결정**: 런타임(Node/Bun)·테스트 러너·패키지 관리자, `/feedback` 호환 응답 shape, `watch` 대체 방식, `doctor --json` 스키마 동결, legacy 읽기 경로 제거 시점. 이 문서는 후보만 적고 확정하지 않는다.

## 12. PR26b-1(SEL-71) 진행 기록 — `scripts/pes.ts` 골격과 쓰기 명령

- 진입: `node scripts/pes.ts <명령>`(Node 26 타입 제거). 이 쪽 설계·고정 규칙은 [stage-2-db-guarantees.md](stage-2-db-guarantees.md) 8.21, 시험은 `tests/README.md`의 "pes.ts — TS 진입점 시험".
- 옮긴 것: 2.1절 쓰기 명령 중 init·ask-prep·ask·round-start·merge·render·approve·reopen·mark·chat·note·qa-brief·qa·remote·stop·home·lock·unlock·set(허용 필드 화이트리스트), 그리고 E04 가 쓰는 `status`. `serve`·`hub`·`open`·읽기·보고서 명령은 SEL-77 과 뒤 PR 몫이다(이름만 알고 한국어 한 줄로 거절).
- 1차 리뷰(SEL-71, r1)로 정한 의도된 차이: **D13** — 순서 밖 `approve`(앞 단계 미승인)와 승인된 단계의 `round-start` 는 0.15 와 달리 거절한다(exit 1, stdout 비움, 한국어 한 줄; 계약 사례 X08·X09 가 0.15 기준값과 ts 기대값을 함께 고정). **D11 확장** — `merge` 의 잘못된 `sources` 는 0.15 의 스택 추적(exit 1) 대신 한국어 한 줄·exit 1·무쓰기(X11). `chat` 의 빈 글은 0.15 처럼 exit 0 으로 기록한다(X10, D03). 읽기 모델은 `set` 7개 필드만 반영하고, 암묵 라운드·조용한 재승인은 클라이언트 문자열이 아니라 서버 영수증의 표지로 알아본다(`pes.py` DB 경로의 `status`·대시보드 출력도 이 읽기 모델을 쓰므로 함께 바뀐다 — 8.21).
- 이번에 시험이 짚어 준 0.15 와 DB 사이의 틈과 닫은 방식은 8.21 에 있다(any_order·implicit-approval·set 저장·읽기 모델 보강). 닫지 못한 것은 이 문서 10절의 "저장 방식 변경으로 바이트 동등성 불가" 항목의 구체 사례다:
  - E03: `index.html`(마지막 render 의 `data`)과 `snapshots/**` 는 그때의 `depth` 를 그대로 담는다. 0.15 는 같은 병합을 다시 보내면 depth 를 올리지만(3) D06 은 고친 값(2)을 정답으로 둔다 — 그러면 같은 상태에서 만든 화면·스냅샷의 해시가 0.15 기준값과 같을 수 없다(D06 이 상태 DTO 에만 걸려 있다).
  - E10: 손으로 쓴 최소 `project.json`(slug·created·settings·complete 없음)을 가져온 DB 의 상태 DTO 는 그 키들을 늘 채운다 — DB 에는 "원본에 없던 키"의 기록이 없다(slug 는 하네스가 사본에 직접 넣는다).
  - X04: `home` 이 폴더만 옮기고 DB 프로젝트는 그대로라, 옮긴 뒤에도 같은 이름의 DB 프로젝트가 읽힌다(0.15 기준값은 옛 폴더에 project.json 이 없어 DTO 가 null).

