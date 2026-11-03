# 현행 기준선 — PES v0.15.6

- 기준 커밋: `b109177` (`v0.15.6: 최종 보고서 인쇄·PDF 목차 쪽 추가`).
- 버전 근거: `.claude-plugin/plugin.json:3` 의 `"version": "0.15.6"`.
- 이 문서를 쓰는 시점의 HEAD는 `b109177` 뒤에 문서 커밋 3개가 더 있다. `git diff --stat b109177 HEAD -- scripts templates skills questions agents commands .claude-plugin` 결과가 비어 있어, 아래 파일:줄 근거는 기준 커밋의 코드와 같다.
- 범위 근거: [stage-0.md](stage-0.md) 2절 1번(`:20`), 2절 10번(`:29`), 4절 4번(`:49`), 5절(`:62`). 이 문서는 **현행을 기술만** 한다. 코드·테스트·설정은 바꾸지 않는다.

## 1. 판정 기준

| 판정 | 뜻 |
|---|---|
| **보존** | 사용자가 보는 결과와 상태 전이가 같아야 한다. 저장 방식(파일·DB)과 화면 구현은 같지 않아도 된다. |
| **의도적 변경** | 현행 구현이지만 재설계에서 바뀌어도 되는 것. stage-0.md 2절 1번이 보존 대상에서 뺀 것들이다(`docs/plan/stage-0.md:20`). |
| **결함 후보** | 현행 동작이 의도와 다르거나, 자료·답·승인을 잃을 수 있는 것. 고칠지는 SEL-31·`defects.md`가 정한다. |
| **미확인** | 저장소 코드만으로 확인할 수 없거나, 실제 프로젝트·다른 OS를 보지 않고는 단정할 수 없는 것. 지어내지 않는다. |

## 2. 기능별 기준선

| # | 기능 | 판정 | 현행 동작과 근거 |
|---|---|---|---|
| 1 | 6단계·라운드 | **보존** | 단계는 `plan→research→analyze→write→verify→publish` 고정(`scripts/pes.py:60-61`). 단계마다 `round`를 1씩 올리고 `status=active`, `current`를 그 단계로 바꾸며 `changes`를 비운다(`scripts/pes.py:290-306`). 이전 라운드의 변경점은 `history` 한 줄로 남긴다(`scripts/pes.py:293-299`). |
| 2 | 시작 질문 | **보존** | `init`은 기획을 `asking`으로 시작한다(`scripts/pes.py:210`). `ask-prep`이 질문 은행을 `ask/<id>.json`으로 복사하고(`scripts/pes.py:243-253`), `ask`가 `ask-<id>.html`을 만들며, 단계가 `pending`이면 `asking`으로 바꾼다(`scripts/pes.py:264-279`). 절차는 스킬에도 있다(`skills/core/SKILL.md:116`). |
| 3 | 질문별 답과 `__other` 덧붙임 | **보존** | 모든 질문(선택·글쓰기)에 `data-qo` "기타 · 덧붙일 말" 칸을 만든다(`templates/_questions.html:33-48`). 수집 시 `answers[q.id]`와 `answers[q.id + '__other']`를 함께 넣고, 사람이 읽는 문장에는 `(기타·덧붙임: …)`으로 붙인다(`templates/_questions.html:77-94`, 특히 `:87-91`). 질문 폼은 이 answers를 `POST` 본문에 싣고(`templates/ask.html:97-100`, `:115`), 대시보드의 AI 점검 답도 같은 모듈로 모은다(`templates/dashboard.html:710-715`, `:744-753`). |
| 4 | 승인 | **보존** | 대시보드의 "이 단계 승인"은 `kind=approve`로 보낸다(`templates/dashboard.html:286-287`, `:761-770`, `:792-796`). CLI `approve`는 `status=approved`, `approved_at`, `history`를 남기고 `stale=false`로 만든 뒤 다음 단계로 넘긴다(`scripts/pes.py:442-468`). 기획 승인은 조사 항목을 자동 생성하고(`scripts/pes.py:470-494`), 마지막 단계 승인은 `complete=true`로 끝낸다(`scripts/pes.py:455-458`). |
| 5 | 재개 | **보존** | 상태가 `project.json`에 남아 새 세션이 `status`로 이어갈 수 있다(`scripts/pes.py:521-548`). 처리 안 한 답은 `pending`으로 다시 찾는다(`scripts/pes.py:516-519`, `:550-554`). 인계 메모는 `note`로 쌓고 `status`가 최근 5개를 보여 준다(`scripts/pes.py:643-657`, `:534-539`). 별도 세션 복원 코드는 없고, 스킬이 이 상태를 읽어 이어 간다(`skills/core/SKILL.md:158-166`). |
| 6 | reopen과 stale | **보존** | 대시보드의 "이 단계 다시 열기"는 `kind=reopen`으로 보낸다(`templates/dashboard.html:287`, `:772-789`). CLI `reopen`은 그 단계를 `active`로 되돌리고 `approved_at`·`review`를 지우며, 뒤 단계 중 `pending`이 아닌 것에 `stale=true`를 표시한다(`scripts/pes.py:496-514`). 대시보드와 `status`가 `stale`을 "다시 확인 필요"로 보여 준다(`templates/dashboard.html:463`, `scripts/pes.py:532-533`). |
| 7 | 출처 연결 | **보존** | 항목은 `sources`(출처 목록)와 `links`(단계·항목 추적선)를 가진다(`scripts/pes.py:173-178`). `merge`는 출처 URL 중복을 제거해 누적하고(`scripts/pes.py:338-344`), `links`도 중복 없이 합친다(`scripts/pes.py:353-357`). 원문 확인 기준은 `browser·kosis·law·vworld`다(`scripts/pes.py:64`). 단계 보고서는 출처를 번호로 묶고 항목마다 "근거 출처"와 확인/미확인을 찍으며, 없으면 "근거 없음 ⚠"을 남긴다(`scripts/pes.py:709-728`, `:751-759`, `:820-827`). |
| 8 | 단계 보고서 | **보존** | `report`는 `reports/<stage>/report.md`와 `report.html`을 만들고, `eli5.json`이 있으면 `eli5.html`도 만든다(`scripts/pes.py:830-852`). 폴더의 `md·html·docx·hwpx·pdf·pptx`를 `stages.<stage>.reports`에 등록한다(`scripts/pes.py:853-863`). 형식 기본값은 `md, html, eli5`이고 기획 답 `settings.stage_reports`로 바꾼다(`scripts/pes.py:660-663`, `skills/core/SKILL.md:140`). |
| 9 | 최종 보고서 | **보존** | `assemble`이 집필 단계 `section` 항목을 순서대로 모아 각주 번호를 정리하고 `out/report.md`·`out/sources.json`을 쓴다(`scripts/pes.py:870-908`). `web`은 `out/report.md`(+`appendix.md`, `sources.json`, `cover.json`)로 `out/report.html`을 만든다(`scripts/pes.py:913-935`). 산출·공유 단계의 형식별 내보내기는 스킬이 맡는다(`skills/publish/SKILL.md:14-23`). |
| 10 | 서버 포트 | **의도적 변경** | PES 홈마다 포트 하나, `8760-8764` 중 빈 포트를 쓴다(`scripts/pes.py:1081-1083`, `:1195`, `scripts/serve.py:29`). stage-0.md 2절 1번이 보존 대상에서 뺐다(`docs/plan/stage-0.md:20`). |
| 11 | HTML 파일 배치 | **의도적 변경** | 대시보드는 프로젝트 폴더의 `index.html`, 질문 폼은 `ask-<id>.html`, 목록은 홈의 `index.html`이다(`scripts/pes.py:277`, `:412-440`, `:1264-1270`). 서버는 그 파일을 정적 서빙하고, `index.html`이 없으면 최신 `ask-*.html`로 보낸다(`scripts/serve.py:100-109`). 보존 대상 아님(`docs/plan/stage-0.md:20`). |
| 12 | 파일 시각 알림 | **의도적 변경** | `/version`이 `index.html`·`ask-*.html`의 mtime 최댓값을 돌려주고(`scripts/serve.py:93-97`), 열린 화면이 이를 주기적으로 비교해 새로고침/알림을 띄운다(`templates/ask.html:130-141`, `templates/dashboard.html:827`). 보존 대상 아님(`docs/plan/stage-0.md:20`). |
| 13 | 같은 라운드 스냅샷 덮어쓰기 | **결함 후보** | `render`는 `snapshots/<stage>-R<round>.json`을 그대로 덮어쓴다(`scripts/pes.py:400-408`). 같은 라운드에서 다시 렌더하면 이전 스냅샷이 사라진다. stage-0.md 5절이 SEL-31에서 고칠 결함으로 지목한다(`docs/plan/stage-0.md:24`). |
| 14 | 동시 답 수신 | **결함 후보** | `POST /feedback`은 `feedback/<stage>-R<round>-<초>.json` 이름이 있으면 `-2`, `-3`을 붙이지만, 존재 확인과 쓰기 사이에 잠금이 없다(`scripts/serve.py:140-149`). 같은 초에 두 요청이 들어오면 같은 이름을 고를 수 있다. stage-0.md 5절이 SEL-31 범위로 지목한다(`docs/plan/stage-0.md:24`). |
| 15 | reopen 후 `complete` | **결함 후보** | 마지막 단계 승인은 `complete=true`로 끝내지만(`scripts/pes.py:455-458`), `reopen`은 `complete`를 되돌리지 않는다(`scripts/pes.py:496-514`). 그래서 마지막 단계를 다시 열어도 `status`는 "전체 완료"로 보인다(`scripts/pes.py:525`). stage-0.md 5절이 SEL-31 범위로 지목한다(`docs/plan/stage-0.md:24`). |
| 16 | `"pes": 1` 필드 | **결함 후보** | `init`이 `{"pes": 1, ...}`를 쓰지만(`scripts/pes.py:206`), 저장소 코드에서 이 값을 읽는 곳이 없다. 동작 영향은 없고 2단계 스키마 정리 대상이다. stage-0.md 2절 10번이 이 사실을 기록하라고 한다(`docs/plan/stage-0.md:29`). |
| 17 | 스킬의 `project.json` 직접 편집 | **결함 후보** | CLI에 없는 변경은 스킬이 Python으로 `project.json`을 직접 읽고 쓴다(`skills/core/SKILL.md:62-73`). 이 경로는 `save()`의 잠금 검사·`library.json` 분리·임시 파일 교체를 지나지 않는다(`scripts/pes.py:147-159`와 대조). 원칙 0("에이전트는 상태를 직접 쓰지 않는다")과 어긋나며, 2단계에서 없앤다(`docs/plan/stage-0.md:12-14`). |
| 18 | `resume` 답의 상태 복원 | **미확인** | `resume`은 질문 은행(`questions/resume.json:2-3`)과 `POST` kind 목록(`scripts/serve.py:23`), 화면 라벨(`templates/dashboard.html:585`)에만 있다. 전용 상태 전이 코드가 없어, 실제 재개 시 스킬이 답을 어떻게 반영하는지는 저장소 코드만으로 확인할 수 없다. |
| 19 | 질문 답의 `settings` 저장 형태 | **미확인** | 코드는 답을 `feedback/*.json`에 저장할 뿐이고(`scripts/serve.py:146-149`), `settings`에 넣는 것은 스킬 절차다(`skills/core/SKILL.md:117`). 실제 프로젝트에서 `__other`가 어떤 키·형태로 쌓였는지는 실제 프로젝트를 읽지 않고는 확인할 수 없다(이번 작업은 합성 자료만 사용). |
| 20 | docx·hwpx·pdf·pptx 보고서 생성 | **미확인** | `report`는 이미 있는 파일을 등록만 하고(`scripts/pes.py:853-863`), 변환은 외부 스킬에 맡긴다(`skills/core/SKILL.md:146-148`, `skills/publish/SKILL.md:16-21`). 저장소 안에 변환 코드가 없어 실제 생성·성공 여부는 미확인이다. |
| 21 | Windows에서의 동작 | **미확인** | 코드에 Windows 분기가 있다(`scripts/pes.py:1047-1050`, `:1373-1378`). 이번 기준선 확인은 macOS에서만 했고 Windows 실기 확인 기록은 저장소에 없다. |
| 22 | 깨진·큰 `project.json` 읽기 | **미확인** | `load()`는 `json.loads` 예외를 잡지 않고(`scripts/pes.py:96-115`), 깨진 파일·2MB급 파일의 실제 동작을 확인하는 테스트가 없다(저장소에 테스트 없음, `docs/plan/00-brief.md:11`). SEL-12 읽기 시험 범위다(`docs/plan/stage-0.md:23`). |

### 보존하지 않는 것 — 구현 메모

- 위 10·11·12(포트·HTML 배치·파일 시각 알림)는 **현행 구현**이지 보존할 결과가 아니다(`docs/plan/stage-0.md:20`).
- 저장 방식 자체(`project.json` 단일 파일 + 정적 HTML)도 2단계에서 DB+API로 바뀐다(`docs/plan/00-brief.md:31`, `:47`, `docs/plan/stage-0.md:42`). 다만 그때도 위 1~9의 **결과·상태 전이**는 같아야 한다.
- 카드 디자인 개선은 지금 하지 않는다(`docs/plan/00-brief.md:53`).

## 3. 상태를 쓰는 경로

현행 상태 쓰기는 아래 세 갈래다. 이 절은 "어디가 원본을 바꾸는가"를 세는 것이 목적이고, 경로를 없애거나 합치는 설계는 2단계 일이다(`docs/plan/stage-0.md:12-14`).

### 3.1 CLI — `scripts/pes.py`

프로젝트 상태의 정규 경로다. `project.json` 쓰기는 모두 `save()`를 지나며, `save()`는 잠금을 확인하고(`scripts/pes.py:147-148`), `library`를 `library.json`으로 분리하고(`:150-156`), `project.json.tmp`에 쓴 뒤 교체한다(`:156-159`).

| 명령/함수 | 바꾸는 것 | 근거 |
|---|---|---|
| `init` | 프로젝트 폴더·하위 폴더(`feedback·ask·snapshots·shots·out`)·`feedback.log`·`project.json`(기획 `asking`) | `scripts/pes.py:186-217` |
| `ask-prep` | `ask/<id>.json` 복사(없을 때만) | `scripts/pes.py:243-253` |
| `ask` | `ask-<id>.html` 생성, 단계가 `pending`이면 `asking`으로 | `scripts/pes.py:264-279` |
| `round-start` | `round+1`, `status=active`, `current`, `changes=[]`, 이전 라운드 `history` 한 줄 | `scripts/pes.py:290-306` |
| `merge` | 항목 생성·필드 갱신, 출처·수치·스크린샷·충돌·links 누적, `suggestions`, `depth`·`updated_round`·`status` | `scripts/pes.py:315-367` |
| `render` | `snapshots/<stage>-R<n>.json`(같은 이름 덮어씀), `index.html` | `scripts/pes.py:400-410`, `:412-440` |
| `approve` | `status=approved`, `approved_at`, `history`, `stale=false`, `current`, `complete`, 기획→조사 항목 생성 | `scripts/pes.py:442-494` |
| `reopen` | 그 단계 `active`, `approved_at=null`, `review=null`, `stale=false`, 뒤 단계 `stale=true`, `current` | `scripts/pes.py:496-514` |
| `mark` | `processed`에 답 파일 이름 추가 | `scripts/pes.py:556-565` |
| `chat` | `feedback/<stage>-R<n>-<시각>.json` 생성 + `processed` 추가 | `scripts/pes.py:567-580` |
| `note` | `notes`에 `{time, stage, text}` 추가 | `scripts/pes.py:643-657` |
| `report` | `reports/<stage>/report.md·report.html·eli5.html`, `stages.<s>.reports`, `reports_built` | `scripts/pes.py:830-868` |
| `assemble` | `out/report.md`, `out/sources.json` (프로젝트 상태 파일은 안 바꿈) | `scripts/pes.py:870-908` |
| `web` | `out/report.html` (프로젝트 상태 파일은 안 바꿈) | `scripts/pes.py:913-935` |
| `qa-brief` | `rounds/<stage>-R<n>/qa-brief.md·digest.txt·self-review.json` | `scripts/pes.py:937-987` |
| `qa` | `stages.<s>.qa`, `stages.<s>.review_log` | `scripts/pes.py:989-1012` |
| `lock`/`unlock` | `.pes-lock` | `scripts/pes.py:1677-1700` |
| `serve`/`stop`/`hub` | `index.html`, `.pes-hub`, `.pes-hub-server`, `.pes-hub.out` | `scripts/pes.py:1113-1131`, `:1149-1169`, `:1264-1276` |
| `home` | `~/.pes/config.json`의 `home`, 프로젝트 폴더 이동 | `scripts/pes.py:1294-1361` |
| `remote` | `~/.pes/config.json`의 `trusted_origins` | `scripts/pes.py:1014-1043` |
| `doctor --fix` | 임시·잠금 파일 정리, 대시보드·보고서 재생성 | `scripts/pes.py:1624-1675` |

`~/.pes/config.json`은 프로젝트 상태가 아니라 PES 홈·원격 출처 설정이다(`scripts/pes.py:73`, `:76-87`). 프로젝트 폴더 밖의 쓰기라 이 목록에서 따로 표시했다.

### 3.2 스킬의 직접 편집 — `skills/core/SKILL.md:62-84`

- `project.json`을 Python으로 직접 읽고 `write_text`로 통째로 다시 쓴다(`skills/core/SKILL.md:62-73`). 항목 스키마도 여기 있다(`:75-84`).
- 이 경로가 맡는 변경: 시작 질문 답을 `settings`에 저장(`:117`), 승인 때 `carry_over`(`:133`), AI 점검 `review` 작성(`:168-186`), `reports/<stage>/eli5.json` 작성(`:143-156`), 서브에이전트 결과 파일 `rounds/<stage>-R<n>/<id>.json`(`:90`).
- `save()`를 지나지 않으므로 잠금 검사·`library.json` 분리·tmp 교체가 없다. 동시에 두 세션이 직접 편집하면 마지막 쓰기가 이긴다.
- 이 경로는 "현행"으로 기록만 하고, 2단계에서 PES가 검증하는 하나의 쓰기 경로로 없앤다(`docs/plan/stage-0.md:14`).

### 3.3 웹 답 수신 — `POST /feedback` (`scripts/serve.py:111-152`)

- 경로는 `/<slug>/feedback`이고, 홈 자체가 프로젝트인 옛 화면은 `Referer`로 프로젝트를 찾는다(`scripts/serve.py:111-118`).
- 출처 검사: `127.0.0.1`·`localhost` 또는 `~/.pes/config.json`의 `trusted_origins`만 허용(`:119-121`, `:30-38`).
- 크기 제한 256KB(`:22`, `:122-124`), `kind`는 `feedback·review·stage_start·approve·resume·reopen`만(`:23`, `:134-135`), `text`와 `answers`가 모두 비면 거부(`:136-137`).
- 저장: `feedback/<stage>-R<round>-<시각>.json`에 `stage·round·time·kind·text·answers·spec·via·origin·who`를 쓴다(`:138-149`). `feedback.log`에 `FEEDBACK <stage> R<round> <kind> <경로>` 한 줄을 덧붙인다(`:150-151`).
- **`project.json`은 건드리지 않는다.** 답을 상태에 반영하는 것은 CLI `mark` 이후 스킬의 몫이다(`skills/core/SKILL.md:117`, `:132-134`).
- `chat` 명령도 같은 형식의 답 파일을 만들지만 `via=chat`이고 `processed`에 바로 넣는다(`scripts/pes.py:567-580`).

### 3.4 그 밖의 쓰기

- 사람이 편집기로 `project.json`·`library.json`을 직접 고치는 경로는 코드로 막을 수 없다. `load()`가 빠진 단계 필드를 채우는 것이 유일한 보정이다(`scripts/pes.py:96-115`).
- `serve.py`는 프로젝트 파일을 읽기만 하고, 유일한 쓰기가 위 `POST /feedback`이다(`scripts/serve.py:14-19`).

## 4. 프로젝트 폴더 보존 파일 목록

`init`이 만드는 폴더는 `feedback·ask·snapshots·shots·out`이고 `feedback.log`를 만든다(`scripts/pes.py:202-205`). `library/`는 `--import` 때만 생긴다(`scripts/pes.py:223-235`). `reports/`·`rounds/`는 각 명령이 처음 쓸 때 만든다(`scripts/pes.py:835`, `:944`).

| 경로 | 쓰는 곳(근거) | 원본/재생성 | 백업 우선순위 |
|---|---|---|---|
| `project.json` | `save()`(`scripts/pes.py:147-159`), `init`(`:206-210`) | **원본**. 단일 진실 원천. 사람 답·항목·승인·이력이 여기에만 있다. 재생성 불가 | 1 |
| `library.json` | `save()`가 `library`를 분리(`:150-156`), `load()`가 읽음(`:111-113`), `--import`가 생성(`:219-240`) | **원본**. 가져온 뒤 손댄 내용은 원천 research-loop 폴더로 되돌릴 수 없다 | 2 |
| `feedback/*.json` | `POST /feedback`(`scripts/serve.py:138-149`), `chat`(`scripts/pes.py:573-575`) | **원본**. 사람이 보낸 답·승인·reopen 요청. 재생성 불가 | 3 |
| `feedback.log` | `init`이 빈 파일 생성(`scripts/pes.py:205`), `POST`가 한 줄 추가(`scripts/serve.py:150-151`) | 파생 로그. `feedback/*.json`에서 다시 만들 수 있으나 시각·순서는 같지 않을 수 있음 | 4 |
| `ask/<id>.json` | `ask-prep`이 질문 은행을 복사(`scripts/pes.py:243-253`) | **원본**. 스킬이 주제에 맞게 다듬은 질문 명세. 질문 은행 원본 + 수정 내역이 없으면 그대로 복원 불가 | 3 |
| `ask-*.html` | `ask`(`scripts/pes.py:264-279`) | 재생성 가능. `ask/<id>.json`과 템플릿에서 다시 만든다 | — |
| `snapshots/<stage>-R<n>.json` | `render`(`scripts/pes.py:400-408`) | **원본**(과거 라운드 상태). 단, 같은 라운드에서 다시 렌더하면 덮어쓴다(결함 후보 13) | 2 |
| `rounds/<stage>-R<n>/<id>.json` | 서브에이전트 결과(`skills/core/SKILL.md:90`, `skills/research/SKILL.md:32`, `:49`) | **원본**. 조사·집필 결과 파일. `merge` 뒤에도 원문 확인용으로 남는다 | 2 |
| `rounds/<stage>-R<n>/qa-brief.md`, `digest.txt`, `self-review.json` | `qa-brief`(`scripts/pes.py:937-987`) | 재생성 가능(현재 상태 기준). 상태가 바뀌면 내용이 달라진다 | — |
| `rounds/<stage>-R<n>/qa.json` | `pes:reviewer`가 쓰고 `qa`가 읽음(`scripts/pes.py:989-1012`) | **원본**. 독립 검토 결과. `project.json`의 `qa`에도 사본이 남는다 | 2 |
| `shots/*` | 에이전트가 저장(`skills/research/SKILL.md:48-49`, `skills/analyze/SKILL.md:24`) | **원본**. 웹 화면·지도 캡처. 다시 찍으면 달라진다 | 3 |
| `library/shots/*` | `--import`가 복사(`scripts/pes.py:223-235`) | **원본의 사본**. 원천 폴더가 있으면 다시 복사 가능 | 3 |
| `reports/<stage>/report.md`, `report.html` | `report`(`scripts/pes.py:830-852`) | 재생성 가능. `project.json`에서 다시 만든다 | — |
| `reports/<stage>/eli5.html` | `report`가 `eli5.json`으로 렌더(`scripts/pes.py:843-850`) | 재생성 가능. 단 `eli5.json`이 있어야 한다 | — |
| `reports/<stage>/eli5.json` | 스킬이 작성(`skills/core/SKILL.md:143-156`) | **원본**. 손으로 쓴 그림 설명. 재생성 불가 | 2 |
| `reports/<stage>/report.docx`, `.hwpx`, `.pdf`, `.pptx` | 외부 스킬이 만들고 `report`가 등록(`scripts/pes.py:853-863`) | **원본**(변환물). 같은 도구·원고로 다시 만들 수는 있으나 동일 보장 없음 | 2 |
| `out/report.md`, `out/sources.json` | `assemble`(`scripts/pes.py:870-908`) | 재생성 가능. `project.json`의 집필 항목에서 다시 만든다 | — |
| `out/report.html` | `web`(`scripts/pes.py:913-935`) | 재생성 가능 | — |
| `out/cover.json` | 스킬이 작성(`skills/publish/SKILL.md:19`) | **원본**. 표지 정보(연구진·기관·발주처)는 손으로 정한 값 | 2 |
| `out/appendix.md` | 스킬이 작성(`skills/publish/SKILL.md:22`) | **원본**. 부록 원고 | 2 |
| `out/report.hwpx`, `.docx`, `.pdf`, `.pptx`, `out/slides.pptx`, `out/report-uri.md` | 외부 스킬(`skills/publish/SKILL.md:16-22`) | **원본**(최종 산출물·변환 사본) | 1 |
| `index.html` | `build_index`(`scripts/pes.py:412-440`) | 재생성 가능. `project.json`에서 다시 만든다 | — |
| `.pes-lock` | `lock`/`write_lock`(`scripts/pes.py:131-145`) | 휘발. 다시 만들 수 있다 | — |
| `project.json.tmp` | `save()`(`scripts/pes.py:156-159`) | 휘발. 저장 중 끊긴 찌꺼기 | — |
| `.pes-port`, `.pes-server` | 옛 프로젝트별 서버 기록(`scripts/pes.py:1133-1147`) | 휘발. `stop_legacy`가 지운다 | — |

홈(PES 홈) 수준의 `index.html`·`.pes-hub`·`.pes-hub-server`·`.pes-hub.out`은 프로젝트 폴더 밖이고 모두 재생성 가능하다(`scripts/pes.py:1125`, `:1264-1270`).

**최소 백업 세트**: `project.json`, `library.json`, `feedback/`, `ask/`, `snapshots/`, `rounds/`, `shots/`, `reports/`의 손 저작물(`eli5.json`, 변환물), `out/`의 손 저작물·최종 산출물(`cover.json`, `appendix.md`, `report.hwpx` 등). 나머지(`index.html`, `ask-*.html`, `report.md/html`, `out/report.md/html`, 잠금·tmp)는 상태에서 다시 만들 수 있다.

## 5. 미확인 목록

아래는 저장소 코드·합성 자료만으로 단정하지 않은 것이다. 실제 `~/pes-projects`와 `~/.pes/`는 읽지 않았다.

| # | 미확인 항목 | 이유 | 확인 방법(다음 단계) |
|---|---|---|---|
| U1 | `resume` 답이 재개 시 상태를 어떻게 복원하는가 | 전용 코드 없음. 질문 은행·kind·라벨만 있음(`questions/resume.json:2-3`, `scripts/serve.py:23`) | 실제 세션 재개 시나리오를 합성 프로젝트로 재현(SEL-12/18/19) |
| U2 | 시작 질문 답과 `__other`가 `settings`에 쌓이는 실제 키·형태 | 저장은 스킬이 함(`skills/core/SKILL.md:117`), 코드 경로 없음 | 합성 프로젝트에서 스킬 절차를 그대로 실행해 `project.json` 확인 |
| U3 | docx·hwpx·pdf·pptx 단계 보고서가 실제로 생성되는가 | 변환은 외부 스킬 의존, 저장소에 코드 없음(`skills/core/SKILL.md:146-148`) | 도구 설치 환경에서 합성 보고서 1건 변환 |
| U4 | Windows에서 잠금·파일명·포트·경로가 같은가 | 이번 확인은 macOS만. 코드에 Windows 분기만 있음(`scripts/pes.py:1047-1050`, `:1373-1378`) | Windows 실기에서 같은 합성 시나리오 |
| U5 | 깨진·2MB급 `project.json`에서 `load()`가 내는 실제 오류·종료 코드 | 예외 처리 없음(`scripts/pes.py:96-115`), 테스트 없음 | SEL-12 읽기 시험에서 재현 |

## 6. 확인 방법 (합성 자료)

- 모든 확인은 저장소 밖 `mktemp -d`에서 `PES_HOME=<임시>/home`으로 실행했다. 실제 `~/pes-projects`·`~/.pes/`는 읽거나 쓰지 않았다.
- 합성 프로젝트 생성: `PES_HOME=<임시>/home python3 scripts/pes.py init <임시>/home/synthetic-proj --topic "합성 주제"`.
- 상태 전이 확인: `round-start plan` → 합성 결과 JSON `merge plan` → `render plan` → `approve plan` → `report plan` → `note`. `project.json`·`snapshots/plan-R1.json`·`reports/plan/*`가 생기는 것을 확인했다.
- `library.json` 분리 확인: 합성 `state.json`·`shots/`를 가진 폴더를 만들어 `init --import`로 가져왔다. `project.json`에는 `library` 키가 없고 `library.json`에 항목·출처·스크린샷 경로가 들어가는 것을 확인했다.
- 확인용 임시 폴더는 작업 끝에 지웠다. 이 문서의 파일:줄 번호는 기준 커밋 `b109177`의 것이다.
