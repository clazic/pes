# 용어표와 동작 목록 — PES v0.15.6

- 기준: 커밋 `b109177`, `.claude-plugin/plugin.json:3`(`0.15.6`).
- 이 문서는 **현행 코드에 있는 것만** 적는다. 없는 것은 "없음"으로 둔다. 1단계에서 정할 이름·경계는 여기서 정하지 않는다([stage-0.md](stage-0.md) 3절, `:38-42`).
- 파일:줄 근거는 기준 커밋의 것이다. 코드 변경은 하지 않았다.

## 1. 용어표

| 용어 | 뜻 | 현행 코드 위치 | 현행 상태 |
|---|---|---|---|
| **프로젝트** | PES 홈 아래의 폴더 하나. `project.json` 하나가 단일 진실 원천이고, `slug`로 찾는다. | `pdir()` `scripts/pes.py:89-93`, `cmd_init` `:186-217`, `load()` `:96-115`. 폴더 설명은 `skills/core/SKILL.md:51-59` | 있음 |
| **판** | 같은 프로젝트에서 보고서를 2판·3판으로 이어 가는 단위(사용자 구상). | **없음.** `project.json` 최상위 키에 판·버전이 없고(`scripts/pes.py:206-209`), 단계 구조에도 없다(`:167-171`). 플러그인 버전(`.claude-plugin/plugin.json:3`)은 판이 아니다. 구상만 `docs/plan/00-brief.md:16`에 있다 | 없음 — 1단계 설계 대상 |
| **단계** | 기획→조사→분석·종합→집필→검증→산출·공유의 6개 고정 구간. `key`와 한글 `label`, `status`를 가진다. | `STAGES` `scripts/pes.py:60-61`, `new_stage()` `:167-171`, `stage_arg()` `:161-165` | 있음 |
| **라운드** | 한 단계 안의 반복 단위. 결과 제출→AI 점검→사용자 답을 한 묶음으로 세고, `round`가 1씩 오른다. | `new_stage()`의 `"round": 0` `scripts/pes.py:168`, `cmd_round_start` `:290-306`, 스냅샷 이름 `:408` | 있음 |
| **항목** | 한 단계 안에서 다루는 일의 단위. `id·title·kind·status·request·summary·details·sources·links` 등을 가진다. 종류는 `rq·chapter·topic·issue·table·insight·section·claim·output`이다. | `blank_item()` `scripts/pes.py:173-179`, `cmd_merge` `:315-367`, 항목 스키마 `skills/core/SKILL.md:75-84` | 있음 |
| **질문** | 사람에게 묻는 단위. ① 단계 시작 질문(질문 은행 `questions/<stage>.json` → `ask/<id>.json`), ② 라운드마다 AI가 쓰는 점검 질문(`stages.<단계>.review.questions`)이 있다. | 시작 질문: `cmd_ask_prep` `scripts/pes.py:243-253`, `cmd_ask` `:264-279`, 렌더 `templates/_questions.html:50-57`. 점검 질문: 스킬이 `review`에 작성(`skills/core/SKILL.md:168-186`), 대시보드 표시 `templates/dashboard.html:436-441` | 있음 — 단, 독립 `Question` 레코드는 없고 질문 명세 JSON과 `review` 객체로 표현된다 |
| **답** | 사람이 보낸 `text`와 `answers`(질문 id→값, `__other` 덧붙임 포함) 묶음. `kind`로 시작 답·점검 답·승인·이어하기·다시 열기를 구분한다. | 수신 `scripts/serve.py:111-152`, 읽기 `load_feedback()` `scripts/pes.py:383-398`, 대기 목록 `pending_files()` `:516-519`, 처리 표시 `cmd_mark` `:556-565`, 채팅 기록 `cmd_chat` `:567-580` | 있음 — 파일(`feedback/*.json`)로 저장되고 `processed`에 처리 여부가 남는다 |
| **작업** | 에이전트가 처리할 일 한 건. | **없음(독립 객체).** 가장 가까운 것은 항목의 `status`(`new·deepen·revise·browser`)와 `request`다(`scripts/pes.py:174-175`). `status`는 "할 일" 수를 세는 데 쓴다(`scripts/pes.py:529`, `templates/dashboard.html:424`) | 없음 — 항목 필드로만 표현 |
| **실행** | 에이전트를 한 번 띄워 일을 시키는 단위(실행 id·시작/중단·모델·사용량). | **없음.** `project.json`에 실행·세션·lease 객체가 없다(`scripts/pes.py:206-209`, `:167-171`). 세션 표시는 `.pes-lock`의 `PES_OWNER`뿐이고(`:131-145`), 서버 프로세스 기록은 `.pes-hub-server`다(`:1125`). 실행 객체 초안은 1단계 입력으로만 있다(`docs/plan/stage-0.md:42`) | 없음 — 1단계 설계 대상 |
| **산출물** | 사용자에게 남는 결과 파일. 단계 보고서(`reports/`), 최종 보고서(`out/`), 그림(`shots/`) 등. | `cmd_report` `scripts/pes.py:830-868`, `cmd_assemble` `:870-908`, `cmd_web` `:913-935`, `kind=output` 항목의 `path`(`skills/publish/SKILL.md:23`), 대시보드 산출물 칸(`templates/dashboard.html:571-573`, `:670`) | 부분 — 파일, `stages.<단계>.reports` 등록 목록, `kind=output` 항목으로 흩어져 있고 별도 산출물 원장은 없다 |
| **승인** | 사람이 단계 결과를 받아들여 다음 단계로 넘기는 결정. 단계 `status=approved`, `approved_at`이 남는다. | `cmd_approve` `scripts/pes.py:442-468`, 대시보드 승인 모달 `templates/dashboard.html:761-770`, `:792-796`, 답 종류 `approve`(`scripts/serve.py:23`) | 있음 |

## 2. 동작 목록

| 동작 | 뜻 | 현행 코드 위치 | 현행 상태 |
|---|---|---|---|
| **맥락 읽기** | 새 세션·에이전트가 프로젝트 상태와 지금 할 일을 파악한다. | `cmd_status` `scripts/pes.py:521-548`, `cmd_digest` `:587-619`, `cmd_show` `:621-641`, `cmd_note`로 쌓은 메모를 `status`가 보여 줌 `:534-539`. 목록 화면용 요약은 `brief()` `:1205-1232` | 있음 — 읽기 전용 |
| **일 받기** | 다음에 처리할 일을 확인하고 가져간다(클레임). | 처리 안 한 답: `pending_files()` `scripts/pes.py:516-519`, `cmd_pending` `:550-554`. 지금 할 일: `brief()`의 `who`·`todo` `:1205-1232`, `cmd_status` `:521-548` | **부분** — 읽기만 있고, 일을 배정·점유하는 클레임/lease가 없다. `lock`은 프로젝트 단위 세션 표시일 뿐이다(`scripts/pes.py:1677-1689`) |
| **결과 제출** | 에이전트가 만든 결과를 프로젝트 상태에 넣는다. | `cmd_merge` `scripts/pes.py:315-367`(JSON 파일 병합), 독립 검토 결과 `cmd_qa` `:989-1012`. 그 밖의 변경은 스킬이 `project.json`을 직접 편집한다(`skills/core/SKILL.md:62-73`) | 있음 — 제출 형식이 하나가 아니다(merge JSON / 직접 편집) |
| **질문 올리기** | 사람에게 새 질문을 보여 준다. | 시작 질문: `ask-prep` → `ask`(`scripts/pes.py:243-279`). 라운드 점검 질문: 전용 CLI 없이 스킬이 `stages.<단계>.review`를 직접 쓴다(`skills/core/SKILL.md:168-186`), 대시보드가 `RV()`로 표시(`templates/dashboard.html:436-441`) | **부분** — 시작 질문은 CLI, 점검 질문은 직접 편집. 질문을 더하고·빼고·고치는 API는 없다 |
| **답 읽기** | 사람이 보낸 답 파일을 읽어 `text`·`answers`를 해석한다. | `load_feedback()` `scripts/pes.py:383-398`, `cmd_status`의 대기 답 표시 `:541-548`, `cmd_pending` `:550-554` | 있음 |
| **처리 확인** | 읽은 답을 처리 완료로 표시해 같은 답을 두 번 처리하지 않는다. | `cmd_mark` `scripts/pes.py:556-565`가 `processed`에 파일 이름을 넣고, `pending_files()` `:516-519`가 빼고 센다. `chat`은 만들 때 바로 `processed`에 넣는다(`:576-577`) | 있음 — 파일 이름 기준. 별도 처리 이력·결과 코드는 없다 |
| **중단** | 진행 중인 에이전트 작업·라운드를 멈춘다. | **없음.** `stop`은 로컬 서버만 끄고(`scripts/pes.py:1162-1169`), `unlock`은 잠금만 푼다(`:1691-1700`). 라운드·항목을 `failed`로 바꾸는 CLI는 없다(`failed`는 항목 `status` 값으로만 허용되고, `blank_item` 기본값은 `new`다 — `:174-175`) | 없음 — 서버 종료만 가능 |
| **인계** | 다음 세션·다른 에이전트에게 결정·선호·남은 일을 넘긴다. | `cmd_note` `scripts/pes.py:643-657`가 `notes`에 `{time, stage, text}`를 쌓고, `status`가 최근 5개를 보여 준다(`:534-539`). 승인 때 남은 일은 `carry_over`로 넘긴다(`skills/core/SKILL.md:133`). 잠금 인계는 `lock`/`unlock`(`scripts/pes.py:1677-1700`) | **부분** — 자유 텍스트 메모와 `carry_over`뿐. 구조화된 인계·실행 상태 인계는 없다 |

## 3. 1단계로 넘길 미정의 용어

아래는 현행 코드에 객체로 없거나, 이름만 있고 경계가 정해지지 않은 것이다. 이 문서에서 새로 정의하지 않는다.

- **판**: `project.json`에 없음. 2판·3판을 같은 프로젝트에서 이어 가는 규칙은 1단계 설계다(`docs/plan/00-brief.md:16`).
- **작업·실행**: 독립 객체가 없음. 항목·라운드·세션 잠금이 각각 일부 역할만 한다.
- **질문·답의 독립 레코드**: 질문은 명세 JSON과 `review` 객체, 답은 `feedback/*.json` 파일로 흩어져 있다. 1단계의 객체 초안(Project/Stage/Item/Run/Question/Answer/Event)은 아직 설계 입력일 뿐이다(`docs/plan/stage-0.md:42`).
- **중단·인계**: CLI 동작이 서버 종료·잠금 해제·메모로만 존재한다.
