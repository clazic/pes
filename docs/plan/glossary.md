# 용어표와 동작 목록 — PES v0.15.6 · 1~6단계 계획 용어

- 기준: 커밋 `b109177`, `.claude-plugin/plugin.json:3`(`0.15.6`).
- 이 문서의 **1~3절은 0단계 현행 코드** 기준이고, **4절은 1~6단계 계획서**에서 새로 정의된 용어다. 같은 이름이 양쪽에 있으면 4절의 계획 정의를 따른다.
- 1단계에서 정할 이름·경계는 4절에서 **계획 정의로만** 적고, 현행 코드에 구현됐다고 주장하지 않는다([stage-0.md](stage-0.md) 3절, `:38-42`).
- 파일:줄 근거는 기준 커밋의 것이다. 코드 변경은 하지 않았다.

## 1. 용어표

| 용어 | 뜻 | 현행 코드 위치 | 현행 상태 |
|---|---|---|---|
| **프로젝트** | PES 홈 아래의 폴더 하나. `project.json` 하나가 단일 진실 원천이고, `slug`로 찾는다. | `pdir()` `scripts/pes.py:89-93`, `cmd_init` `:186-217`, `load()` `:96-115`. 폴더 설명은 `skills/core/SKILL.md:51-59` | 있음 |
| **판** | 같은 프로젝트에서 보고서를 2판·3판으로 이어 가는 단위(사용자 구상). | **없음.** `project.json` 최상위 키에 판·버전이 없고(`scripts/pes.py:206-209`), 단계 구조에도 없다(`:167-171`). 플러그인 버전(`.claude-plugin/plugin.json:3`)은 판이 아니다. 구상만 `docs/plan/00-brief.md:16`에 있다. 계획 정의는 4.1 | 없음 — 1단계 설계 대상 |
| **단계** | 기획→조사→분석·종합→집필→검증→산출·공유의 6개 고정 구간. `key`와 한글 `label`, `status`를 가진다. | `STAGES` `scripts/pes.py:60-61`, `new_stage()` `:167-171`, `stage_arg()` `:161-165` | 있음 |
| **라운드** | 한 단계 안의 반복 단위. 결과 제출→AI 점검→사용자 답을 한 묶음으로 세고, `round`가 1씩 오른다. | `new_stage()`의 `"round": 0` `scripts/pes.py:168`, `cmd_round_start` `:290-306`, 스냅샷 이름 `:408` | 있음 |
| **항목** | 한 단계 안에서 다루는 일의 단위. `id·title·kind·status·request·summary·details·sources·links` 등을 가진다. 종류는 `rq·chapter·topic·issue·table·insight·section·claim·output`이다. | `blank_item()` `scripts/pes.py:173-179`, `cmd_merge` `:315-367`, 항목 스키마 `skills/core/SKILL.md:75-84` | 있음 |
| **질문** | 사람에게 묻는 단위. ① 단계 시작 질문(질문 은행 `questions/<stage>.json` → `ask/<id>.json`), ② 라운드마다 AI가 쓰는 점검 질문(`stages.<단계>.review.questions`)이 있다. | 시작 질문: `cmd_ask_prep` `scripts/pes.py:243-253`, `cmd_ask` `:264-279`, 렌더 `templates/_questions.html:50-57`. 점검 질문: 스킬이 `review`에 작성(`skills/core/SKILL.md:168-186`), 대시보드 표시 `templates/dashboard.html:436-441` | 있음 — 단, 독립 `Question` 레코드는 없고 질문 명세 JSON과 `review` 객체로 표현된다 |
| **답** | 사람이 보낸 `text`와 `answers`(질문 id→값, `__other` 덧붙임 포함) 묶음. `kind`로 시작 답·점검 답·승인·이어하기·다시 열기를 구분한다. | 수신 `scripts/serve.py:111-152`, 읽기 `load_feedback()` `scripts/pes.py:383-398`, 대기 목록 `pending_files()` `:516-519`, 처리 표시 `cmd_mark` `:556-565`, 채팅 기록 `cmd_chat` `:567-580` | 있음 — 파일(`feedback/*.json`)로 저장되고 `processed`에 처리 여부가 남는다 |
| **작업** | 에이전트가 처리할 일 한 건. | **없음(독립 객체).** 가장 가까운 것은 항목의 `status`(`new·deepen·revise·browser`)와 `request`다(`scripts/pes.py:174-175`). `status`는 "할 일" 수를 세는 데 쓴다(`scripts/pes.py:529`, `templates/dashboard.html:424`) | 없음 — 항목 필드로만 표현 |
| **실행** | 에이전트를 한 번 띄워 일을 시키는 단위(실행 id·시작/중단·모델·사용량). | **없음.** `project.json`에 실행·세션·lease 객체가 없다(`scripts/pes.py:206-209`, `:167-171`). 세션 표시는 `.pes-lock`의 `PES_OWNER`뿐이고(`:131-145`), 서버 프로세스 기록은 `.pes-hub-server`다(`:1125`). 실행 객체 초안은 1단계 입력으로만 있다(`docs/plan/stage-0.md:42`). 계획 정의는 4.2의 `run` | 없음 — 1단계 설계 대상 |
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
| **중단** | 진행 중인 에이전트 작업·라운드를 멈춘다. | **전용 중단 없음.** `stop`은 로컬 서버만 끄고(`scripts/pes.py:1162-1169`), `unlock`은 잠금만 푼다(`:1691-1700`). 항목을 `failed`로 표시하는 것은 `merge`가 입력 `status`를 그대로 반영해 가능하지만(`:360`), 실행 중단을 보장하지 않는다 | 없음 — 실행·라운드 중단 전용 기능은 없고, 항목 `failed` 표시만 가능 |
| **인계** | 다음 세션·다른 에이전트에게 결정·선호·남은 일을 넘긴다. | `cmd_note` `scripts/pes.py:643-657`가 `notes`에 `{time, stage, text}`를 쌓고, `status`가 최근 5개를 보여 준다(`:534-539`). 승인 때 남은 일은 `carry_over`로 넘긴다(`skills/core/SKILL.md:133`). 잠금 인계는 `lock`/`unlock`(`scripts/pes.py:1677-1700`) | **부분** — 자유 텍스트 메모와 `carry_over`뿐. 구조화된 인계·실행 상태 인계는 없다 |

## 3. 1단계로 넘길 미정의 용어

아래는 현행 코드에 객체로 없거나, 이름만 있고 경계가 정해지지 않은 것이다. 이 문서에서 새로 정의하지 않는다.

- **판**: `project.json`에 없음. 2판·3판을 같은 프로젝트에서 이어 가는 규칙은 1단계 설계다(`docs/plan/00-brief.md:16`).
- **작업·실행**: 독립 객체가 없음. 항목·라운드·세션 잠금이 각각 일부 역할만 한다.
- **질문·답의 독립 레코드**: 질문은 명세 JSON과 `review` 객체, 답은 `feedback/*.json` 파일로 흩어져 있다. 1단계의 객체 초안(Project/Stage/Item/Run/Question/Answer/Event)은 아직 설계 입력일 뿐이다(`docs/plan/stage-0.md:42`).
- **중단·인계**: CLI 동작이 서버 종료·잠금 해제·메모로만 존재한다.

## 4. 계획 용어 (1~6단계)

1~3절은 0단계 현행 코드 기준이다. 이 절은 1~6단계 계획서에서 새로 정의된 용어다. 같은 이름이 1~3절과 다르면 이 절의 계획 정의를 따른다. 영문 필드명은 코드·API에서 그대로 쓰고, 아래 "쓰지 않는 말"은 한국어 설명에서 다른 개념과 섞는 경우를 말한다.

### 4.1 판·구조·기록

| 용어 | 뜻 | 처음 정의 | 쓰지 않는 말 |
|---|---|---|---|
| **판(edition)** | 같은 프로젝트에서 보고서를 2판·3판으로 이어 가는 단위. `editions` 한 행이고 활성 판은 하나다. | [stage-1-db.md](stage-1-db.md) 2절 5·3.2 | 플러그인 버전, 객체 버전, 프로젝트 |
| **스냅숏(snapshot)** | 판·단계·라운드의 경계에서 정확한 버전·manifest를 고정한 기록. | [stage-1-db.md](stage-1-db.md) 3.2 | 백업, 객체 버전, 인쇄본 |
| **승인(approval)** | 사람이 단계 결과를 받아들이는 결정. snapshot·actor·assurance·tx를 남긴다. | [stage-1-db.md](stage-1-db.md) 3.2 | run complete, 판 완료, 자동 통과 |
| **stale** | reopen·편집 뒤 뒤 단계가 다시 확인해야 함을 가리키는 표시. 승인 자체를 지우지 않는다. | [stage-1-db.md](stage-1-db.md) 3.2 | 무효, 삭제, 실패 |
| **객체(object)** | 버전·첨언·근거가 가리키는 내용의 정체성. | [stage-1-db.md](stage-1-db.md) 3.3 | 항목(item), 파일, 행 |
| **버전(object_version)** | 객체의 불변 내용 버전. `based_on_version_id`는 같은 객체 안에서만 이어진다. | [stage-1-db.md](stage-1-db.md) 3.3 | 판, rev, 저장본 |
| **결과물(artifact)** | `rq`·`chapter`·`report` 같은 종류를 가진 내용 레코드. | [stage-1-db.md](stage-1-db.md) 3.3 | 항목(item), 산출물 파일, 문서 |
| **출처(source)** | URL·locator·확인 시점·발췌·검증 상태를 가진 근거 레코드. | [stage-1-db.md](stage-1-db.md) 3.3 | 링크, 참고문헌, 파일 |
| **각주(citation)** | 결과물 버전별 각주 번호와 출처 버전의 연결. | [stage-1-db.md](stage-1-db.md) 3.3 | 출처, 링크, 참조 |
| **가정(assumption)** | 제안·확인·거절·수정 상태와 판단자·근거를 가진 전제. | [stage-1-db.md](stage-1-db.md) 3.5 | 결정, 추측, 설정 |
| **결정(decision)** | 프로젝트/판 범위에서 채택·대체·철회된 살아 있는 결정 기록. | [stage-1-db.md](stage-1-db.md) 3.5 | 가정, 설정, 정책 |
| **스레드(thread)** | 첨언·질문 의견·일반 대화를 담는 문맥 단위. | [stage-1-db.md](stage-1-db.md) 3.5 | 댓글, 채팅, 답 |
| **메시지(message)** | 스레드 안의 답글 한 건. | [stage-1-db.md](stage-1-db.md) 3.5 | 답, 이벤트, 알림 |
| **후속(followup)** | 스레드 결론을 글 수정·다음 라운드 할 일·reopen·없음으로 옮긴 제안. | [stage-1-db.md](stage-1-db.md) 3.5 | 일반 할 일, 답, Linear 이슈 |
| **next_round_task** | 후속의 한 종류. 다음 라운드 할 일로 복사되며 첫 라운드 전이면 `round_id=NULL`이다. | [stage-1-db.md](stage-1-db.md) 3.5·[stage-4.md](stage-4.md) 2.2 | Linear 이슈, 메모, 답 |
| **반영 내역(reflection entry)** | 다음 라운드 첫머리에 보이는 입력 반영 기록. applied·partial·rejected·deferred와 근거를 남긴다. | [stage-1-db.md](stage-1-db.md) 3.5·[stage-3.md](stage-3.md) 2.4 | 해결, 적용 완료, 답변 |
| **첨언(annotation)** | 글의 특정 구간에 붙는 스레드. 인용문·앞뒤 문맥·원 버전을 보존한다. | [stage-1-db.md](stage-1-db.md) 3.5·[stage-1-ui.md](stage-1-ui.md) 3절 3 | 댓글, 메모, 태그 |
| **앵커(anchor)** | 첨언을 원문에 붙이는 정확한 인용문·prefix/suffix·code point 묶음. | [stage-1-db.md](stage-1-db.md) 3.5 | 위치, 링크, 문자 오프셋만 |
| **exact** | 앵커가 같은 문맥에서 그대로 찾아진 상태. | [stage-1-db.md](stage-1-db.md) 2절 8·3.5 | 일치, 확인됨, 성공 |
| **moved** | 앵커 문구가 편집 뒤 다른 위치에서 찾아진 상태. | [stage-1-db.md](stage-1-db.md) 2절 8·3.5 | 수정됨, 변경됨, exact |
| **ambiguous** | 후보 위치가 둘 이상이라 자동 선택하지 않는 상태. | [stage-1-db.md](stage-1-db.md) 2절 8·3.5 | 중복, lost, 추정 |
| **lost** | 앵커를 찾지 못한 상태. 인용문·스레드·원 버전은 보존한다. | [stage-1-db.md](stage-1-db.md) 2절 8·3.5 | 삭제, 유실, 실패 |
| **판 이월(edition carryover)** | 앞 판의 결정·가정·결과물·출처를 새 판으로 골라 옮기고 유지/수정/제외를 기록한 것. | [stage-4.md](stage-4.md) 2.2·PR 23 | DB 마이그레이션, 백업 복사, 전체 복제 |
| **completed_snapshot_id** | 판 완료 시 고정한 `scope='edition'` 스냅숏 포인터. | [stage-4.md](stage-4.md) 2.1 | `base_snapshot_id`, 백업, 현재 포인터 |
| **approver** | 6단계에서 승인·reopen에만 권한을 더한 프로젝트 역할. owner를 대체하지 않는다. | [stage-6.md](stage-6.md) 2.3 | owner, editor, 관리자 |

### 4.2 실행·전송·자격

| 용어 | 뜻 | 처음 정의 | 쓰지 않는 말 |
|---|---|---|---|
| **run** | 한 에이전트 실행 한 건. mode·runtime·model·role·status·usage를 가진다. | [stage-1-db.md](stage-1-db.md) 3.6 | 실행(행위), 세션, 작업, job |
| **lease** | 프로젝트의 실행 담당 하나를 나타내는 기간·소유권. 에이전트 결과 채택만 제한하고 사람 답·첨언은 막지 않는다. | [stage-1-db.md](stage-1-db.md) 2절 15·3.6 | 파일 잠금, 세션, 점유 |
| **fence** | 인계마다 증가하는 단조 번호. 옛 fence의 제출을 거부한다. | [stage-1-db.md](stage-1-db.md) 3.6 | rev, lease_id, 토큰 |
| **claim** | run 전이와 lease 획득을 한 tx로 하는 원자 명령. | [stage-1-api.md](stage-1-api.md) 2절 7 | 일 조회, 체크아웃, lock |
| **heartbeat** | 생존·진행 증거. 토큰 만료를 늘리지 않고 업무 rev를 바꾸지 않는다. | [stage-1-runners.md](stage-1-runners.md) 5 C1 | poll, claim, save |
| **wait** | 결과·질문 저장 뒤 `waiting_human`으로 바꾸고 lease를 놓는 명시적 명령. | [stage-1-api.md](stage-1-api.md) 2절 7 | 취소, 종료, long-poll |
| **waiting_human** | 사람 답·승인을 기다리는 run 상태. lease는 없다. | [stage-1-db.md](stage-1-db.md) 3.6·[stage-1-api.md](stage-1-api.md) 2절 7 | 네트워크 대기, 중단, 실패 |
| **입력 영수증(run_input_receipt)** | run이 입력 버전을 seen·applied·ignored로 기록한 것. applied는 결과·후속 증거가 필요하다. | [stage-1-api.md](stage-1-api.md) 2절 9 | 읽음, ack, 답 |
| **idempotency key** | 같은 요청을 재생해 같은 결과를 얻는 클라이언트 키. 같은 키·다른 요청은 거부한다. | [stage-1-api.md](stage-1-api.md) 2절 4 | request id, event id, token |
| **mutation commit** | 검증된 변경 한 단위의 영수증. actor·via·action·request hash·base rev·fence를 가진다. | [stage-1-db.md](stage-1-db.md) 3.6 | event, log, tx id |
| **event** | 같은 tx에 기록되는 번호 붙은 업무 사건. 번호 빈틈은 유실이 아니다. | [stage-1-db.md](stage-1-db.md) 3.6 | debug log, audit log |
| **cursor** | 변경분을 읽는 불투명 위치. db instance·epoch·event_seq를 묶고 무효면 재동기화한다. | [stage-1-api.md](stage-1-api.md) 2절 13 | page, offset, timestamp |
| **Go 정책** | 프로젝트별 OpenCode Go 반출 허용·차단의 불변 버전. 일반 export 동의와 다르다. | [stage-1-db.md](stage-1-db.md) 2절 1·3.1 | 전송 동의, API 키, 일반 내보내기 |
| **outbound dispatch** | Go로 나가는 자료의 prepared·authorized·sent·blocked·failed·unknown 영수증. | [stage-1-db.md](stage-1-db.md) 3.6·[stage-1-api.md](stage-1-api.md) 2절 15 | export job, event, audit log |
| **방식 A** | PES가 소유한 OpenCode+DeepSeek가 PES 안에서 6단계를 수행하고 PES가 실행을 제어한다. | [00-brief.md](00-brief.md) 3절·[stage-1-runners.md](stage-1-runners.md) 3절 | 내부 AI 전체, 사용자 OpenCode 서버 |
| **방식 B** | 외부 에이전트(Claude Code·Claude 앱, 이후 Codex·OpenCode TUI)가 작업하고 PES는 소통·기록을 맡는다. | [00-brief.md](00-brief.md) 3절·[stage-1-runners.md](stage-1-runners.md) 4절 | Claude 전용, 외부 AI 전체, API 구독 |
| **runner** | 사용자 컴퓨터에서 밖으로 연결해 queued run을 claim하고 PES 전용 OpenCode를 띄우는 데몬. | [stage-5.md](stage-5.md) 2.4·[stage-1-runners.md](stage-1-runners.md) A3 | 서버, 에이전트, OpenCode 서버 |
| **supervisor** | runner 안에서 OpenCode 프로세스·프로필·workspace를 관리하는 구성요소. | [stage-1-runners.md](stage-1-runners.md) A3·[stage-5.md](stage-5.md) WEB7 | runner, agent |
| **agent token** | 프로젝트 범위 기계 자격. 해시·scope·30일·회수·교체를 가진다. | [stage-1-db.md](stage-1-db.md) 2절 13·3.1 | API key, 사람 세션, OAuth 토큰 |
| **scope** | 에이전트 토큰·OAuth grant가 허용하는 명령 집합. 역할(role)과 다르다. | [stage-1-db.md](stage-1-db.md) 2절 13·[stage-1-api.md](stage-1-api.md) 2절 12 | role, 권한 그룹, 메뉴 |
| **OAuth grant** | 사람이 원격 MCP 앱에 위임한 자격. 사람 세션이 아니다. | [stage-5.md](stage-5.md) 2.5 | 에이전트 키, 로그인 세션 |
| **step-up** | 한 동작·snapshot/rev에 묶인 짧은 재인증. 세션 연장이나 2FA가 아니다. | [stage-5.md](stage-5.md) 2.2 | 2FA, 재로그인, 세션 연장 |
| **MCP** | 에이전트가 PES HTTP 명령을 부르는 도구 어댑터. 두 번째 API가 아니다. | [stage-1-api.md](stage-1-api.md) 8절 | PES API, WebMCP |
| **WebMCP** | 브라우저 페이지가 브라우저 에이전트에 내놓는 도구 표면. 승인류는 노출하지 않는다. | [stage-1-api.md](stage-1-api.md) 2절 16·[stage-3.md](stage-3.md) 2.8 | MCP, PES API, 자동 승인 |
| **capability** | 지원 동작·한도·미지원을 알리는 기계 판독 목록. 권한이 아니다. | [stage-1-api.md](stage-1-api.md) 3절 | 설정, 권한, 기능 플래그 |
| **blob** | hash·크기·media type·storage key로 저장한 바이트. 파일 경로가 아니다. | [stage-1-db.md](stage-1-db.md) 3.3·4절 | 파일 경로, 첨부, URL |
| **manifest** | 경계 시점의 정확한 버전·hash 목록. 스냅숏·백업과 다르다. | [stage-1-db.md](stage-1-db.md) 3.2·3.3·[stage-1-api.md](stage-1-api.md) 2절 6 | 스냅숏, 백업, 파일 목록 |
| **import batch** | 옛 자료를 staging→validated→activated로 옮기는 이전 작업 상태. | [stage-1-db.md](stage-1-db.md) 3.6·5절 | DB 마이그레이션, 복원, export |
| **legacy mapping** | 옛 ID와 새 ID의 대응표. 외부 ID가 아니다. | [stage-1-db.md](stage-1-db.md) 3.6·5절 | 외부 ID, slug, 참조 |
| **export job** | PES가 원본이고 사람이 고른 버전을 외부로 한 방향 보내는 작업·영수증. Go dispatch와 다르다. | [stage-6.md](stage-6.md) 2.5 | outbound dispatch, Go 전송, 양방향 동기화 |
| **hwpx-uri** | 로컬에서 `report.hwpx` 파생본을 만드는 외부 변환 도구. PES가 재구현하지 않는다. | [stage-6.md](stage-6.md) 2.8 | HWPX 파일, hwpx 스킬, docx |

### 4.3 단계·이슈 코드

| 용어 | 뜻 | 처음 정의 | 쓰지 않는 말 |
|---|---|---|---|
| **WEB0** | 5단계 코어 언어 기술 시험. Python Workers·TS 이식·Python 서버 중 하나를 정한다. | [stage-5.md](stage-5.md) 2.1·4절 | W1, WEB1, 코어 |
| **WEB1~WEB14** | 5단계 웹 구현 14개. WEB1 골격, WEB2 로그인, WEB3 멤버, WEB4 키, WEB5 MCP, WEB6 runner, WEB7 supervisor, WEB8 알림, WEB9 이전, WEB10 운영, WEB11 보안, WEB12 한도, WEB13 WebMCP, WEB14 통합. | [stage-5.md](stage-5.md) 4절 | U1~U6, PR 1~22, W1 |
| **U1~U6** | 3단계 소통 기능 6개. U1 작업 공간 틀, U2 질문 작업면, U3 가정·결정·반영, U4 첨언·후속, U5 프롬프트 복사·B 대기, U6 범위 인쇄. | [stage-1-ui.md](stage-1-ui.md) 7절·[stage-3.md](stage-3.md) 2.1~2.7 | WEB1~WEB14, PR 1~22 |
| **U1** | 3단계 작업 공간 틀. 셸·URL·딥링크·갱신·초안·기존 화면 연결. | [stage-1-ui.md](stage-1-ui.md) 7절·[stage-3.md](stage-3.md) 2.2 | WEB1, PR 18 |
| **U2** | 3단계 질문 작업면. 질문/폼 발행·고치기·묶음 답·의견. | [stage-1-ui.md](stage-1-ui.md) 7절·[stage-3.md](stage-3.md) 2.3 | WEB2, PR 8 |
| **U3** | 3단계 가정·결정·반영. 판단·범위·반영 내역. | [stage-1-ui.md](stage-1-ui.md) 7절·[stage-3.md](stage-3.md) 2.4 | WEB3, PR 14 |
| **U4** | 3단계 첨언·후속. 스레드·앵커·`edit_text`·적용 증거. | [stage-1-ui.md](stage-1-ui.md) 7절·[stage-3.md](stage-3.md) 2.5 | WEB4, PR 25 |
| **U5** | 3단계 프롬프트 복사·B 대기. 접수·상태·복사·수신 구분. | [stage-1-ui.md](stage-1-ui.md) 7절·[stage-3.md](stage-3.md) 2.6 | WEB5, MCP |
| **U6** | 3단계 범위 인쇄. 라운드/단계/판·고정 manifest. | [stage-1-ui.md](stage-1-ui.md) 7절·[stage-3.md](stage-3.md) 2.7 | WEB10, PDF |
| **W1** | 3단계 WebMCP 실험. 읽기·답 초안·첨언만. | [stage-3.md](stage-3.md) 2.8 | WEB13, MCP, WebMCP 정식 지원 |
| **R1** | 3단계 자동 재개 옵션. 기본 수동, 프로젝트별 opt-in. | [stage-3.md](stage-3.md) 2.9 | 자동 실행 전체, WEB7, wait |
| **T1** | 3단계 실제 프로젝트 시험. 허용 1개·분리 홈·사본. | [stage-3.md](stage-3.md) 2.10 | 2단계 PR22 파일럿, 전체 이전 |
| **PR 1~22** | 2단계 로컬 뼈대 구현 22개. | [stage-1-db.md](stage-1-db.md) 10절·[stage-2.md](stage-2.md) 4.2 | 5단계 WEB, 4단계 PR 23~25 |
| **6단계 E/M/G/H/X** | E1~E2 내보내기, M1~M3 사람·worker 동시성, G1~G3 다른 에이전트, H1 hc-team 운영 평가, X1~X2 hwpx·통합. | [stage-6.md](stage-6.md) 2.1 | PR 23~25, WEB, SEL |
