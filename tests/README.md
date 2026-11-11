# PES 테스트

Python 3.9 이상과 Node 26 이상이 필요하다.

## 실행

macOS / Linux (POSIX):

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt && .venv/bin/python -m pytest -q
```

Windows (PowerShell):

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.venv\Scripts\python.exe -m pytest -q
```

## 격리

테스트는 `HOME`·`PES_HOME` 을 임시 폴더로 바꾸고 감사 훅(audit hook)으로 실제 `~/pes-projects`·`~/.pes` 접근을 막는다. 실제 프로젝트·설정 파일은 읽거나 쓰지 않는다.

## 안전장치의 한계

격리의 1차 수단은 `HOME`·`USERPROFILE`·`PES_HOME` 을 임시 폴더로 바꾸는 것이고, 감사 훅·stat 가드는 실수로 실제 `~/.pes`·`~/pes-projects` 에 닿는 회귀를 잡는 2차 안전망이다. 의도적인 우회는 막지 못한다 — 알려진 예: 심볼릭 링크 뒤 `..` 를 붙인 경로(`alias/../.pes`), `dir_fd` 기준 상대 경로(`os.stat`/`os.open(..., dir_fd=fd)`). 제품 코드(`scripts/*.py`)는 이런 방식을 쓰지 않는다. 테스트에서 이런 API 를 쓰지 말 것.

## TypeScript 테스트 (Node 26)

```sh
npm ci && npm test && npm run typecheck
```

`npm test`는 `node --test "tests/**/*.test.ts"`로 돈다. `tests/helpers/isolated_home.ts`가 임시 `HOME`·`USERPROFILE`·`PES_HOME`을 만들고, 시험은 그 env 객체를 경로 함수와 자식 프로세스에만 넘긴다. `process.env`는 바꾸지 않으며 실제 `~/.pes`·`~/pes-projects`를 열거나 stat 하지 않는다. 임시 폴더와 그 안의 DB 파일은 각 시험의 `cleanup()`이 지운다.

## 화면 시험 (PR18)

- `tests/test_web_*.test.ts` — `scripts/serve.py`·`pes.py` 를 자식 프로세스로 띄워 HTTP 로 본다(하니스 `tests/helpers/web_env.ts`). 같은 합성 자료를 플래그 없음(v0.15)과 `PES_DB_CORE=1` 로 각각 서빙해 페이지가 품은 JSON 을 의미로 비교한다. 픽셀 기준선은 없다. 플래그 없는 동작은 커밋 `36bc6a2` 와 바이트까지 견준다(`fetch-depth: 0` 필요).
- `tests/e2e/workspace_smoke.spec.ts` — Playwright(Chromium) 스모크. `npm test` 에는 섞이지 않는다(`*.spec.ts`). 브라우저가 없으면 건너뛰지 않고 **실패**한다.

```sh
npx playwright install chromium     # 처음 한 번 (Linux CI 는 --with-deps)
npx playwright test
```

로컬에서는 실제 홈을 건드리지 않도록 HOME 을 임시 폴더로 바꾸고, 브라우저 캐시는 `PLAYWRIGHT_BROWSERS_PATH` 로 넘긴다(macOS 예):

```sh
tmp_home="$(mktemp -d)"
HOME="$tmp_home" PLAYWRIGHT_BROWSERS_PATH="$HOME/Library/Caches/ms-playwright" npx playwright test
```

`tests/e2e/helpers/home_guard.ts`(globalSetup)가 실행 전후로 `os.homedir()` 의 `.pes`·`pes-projects` 의 이름·크기·mtime(깊이 3, 내용은 열지 않음)을 견주어 달라졌으면 실패시킨다. 없으면 없는 그대로여야 한다. CI 에서도 같이 돈다.

합성 작업 공간은 `tests/e2e/helpers/seed_workspace.ts`(일반 Node 로 실행)가 임시 HOME·USERPROFILE·PES_HOME 에 만든다. `PES_E2E_V015=1` 로 돌리면 같은 시험을 v0.15 동작에 대고 돌려, 선택자·흐름이 옛 동작과 맞는지(구현 전 자체 점검) 볼 수 있다.

## 0.15 동등성 하네스와 pytest 자산의 TS 이전 (SEL-70, PR26a)

PR26의 첫 조각이다. 제품 코드는 바꾸지 않고, 0.15(Python)의 **현재 동작**을 TS 시험으로 고정하고 같은 입력을 두 대상에 넣어 견주는 도구를 만든다. 설계는 [migration-ts-equivalence.md](../docs/plan/migration-ts-equivalence.md) 7·8절.

| 파일 | 하는 일 |
|---|---|
| `tests/helpers/compat_normalize.ts` | 정규화 N1~N13(시각·경로·JSON·순서·ID·HTML·인코딩·콘솔·파일 메타·의도된 차이·콘솔 상대경로·stdlib 오류 페이지·OS 파일 없음 문구) |
| `tests/helpers/compat_env.ts` | 이중 실행 하네스: 대상 `py`(`python -I -X utf8 -c "<conftest GUARD>; runpy.run_path(scripts/pes.py·serve.py·setup.py)"`, `PES_DB_CORE` 없음) / `ts`(`scripts/pes.ts`·`serve.ts`·`setup.ts`, 아직 없음 → `not_yet`), 상태 DTO, 의도된 차이 표(D01~D09), `serve.py` 하네스 |
| `tests/helpers/compat_cases.ts` + `tests/fixtures/compat/cases.json` | E01~E15 사례 표와 실행기. 0.15 기준값은 `tests/fixtures/compat/baseline/E??.json` |
| `tests/helpers/home_guard.ts` | 실제 `~/.pes`·`~/pes-projects` 접근 0 — 아래 「home_guard 가 막는 것」 |
| `tests/test_compat_harness.test.ts` | 정규화기·대상 선택·**미구현 목록이 표와 정확히 같다** |
| `tests/test_compat_cases_{a,b,c}.test.ts` | E01~E15를 0.15 대상에서 기준값과 대조 |
| `tests/test_compat_review.test.ts` | 최종 리뷰 1 반영: N6 요약이 제목 escape·공용 모듈 수를 보는지, N2 공백 경로(Windows 철자), 가짜 허브가 떠 있어도 E15 가 같고 접속 0, 상태 DTO 키 전수, `PES_TEST_GUARD` 를 끌 수 없음 |

**대상 바꾸기:** `PES_COMPAT_TARGET=py`(기본) 또는 `ts`. `ts` 에서 아직 없는 명령은 건너뛰지 않고 `not_yet` 으로 단언한다. **래칫은 사례 단위다(SEL-71, PR26b):** `cases.json` 의 사례마다 `ts.status` 가 `implemented`/`not_yet` 이다. `not_yet` 사례는 `scripts/pes.ts` 가 있어도 **실행하지 않고** `not_yet` 으로 단언하고(`compat_cases.run_case`), `implemented` 사례는 0.15 기준값과 같아야 한다(`compare_ts_record`). 사례 종류마다 ts 파일이 하나씩 있다 — `cli` = `scripts/pes.ts`(PR26b 에서 연결됨), `http`(E08·E09·E13) = `scripts/serve.ts`, `setup`(E14) = `scripts/setup.ts`(SEL-72 에서 `compat_ts_srv.ts` 로 연결됨; `ts_gate` 는 세 종류 모두 파일이 없을 때 `not_yet` 만 알린다). **누가 어느 사례를 켜나**는 `tests/helpers/sel_scope.ts` 에 있다. SEL-71(a: pes.ts 골격 + 쓰기 명령, `status` 포함 — E04 가 쓴다) = `SEL71_DONE`: E01~E04·E10·X01~X05 가 `implemented`. SEL-77(b: 읽기·보고서) = `SEL77_DONE`: E05·E06·E07·E11·E12·X06·X07 은 지금 `not_yet`이고 SEL-77 이 한꺼번에 켠다(`sel77_on()`). E08·E09·E13·E14 는 SEL-72 `SEL72_DONE`(`tests/helpers/sel72_scope.ts`), E15(doctor)는 SEL-77 이후. E07 은 쓰기·읽기가 섞여서 E07 전체는 SEL-77 이 켜고, 쓰기 절반은 계약 사례 X05 로 SEL-71 이 맡는다. 사례 표는 둘이다: `cases.json`(7.4 의 E01~E15)과 `contract.json`(CLI 계약 X01~X07, 기준값 `baseline/X0n.json`).

**`implemented` 의 뜻(`compat_cases.compare_ts_record`):** ts 기록이 py 와 같은 단언을 통과해야 한다 — `steps`(stdout·stderr 종류·exit)·상태 DTO·**산출 파일(`files`)** 전부 0.15 기준값과 같아야 한다. 의도된 차이는 각자 자기 단언을 가진다: D01 항목 id 는 값을 버리되 '있고 서로 다르다', D03 `processed` 는 버리되 '같은 길이의 목록', D06 은 구멍이 아니라 **값**(E03 항목 7 의 depth 는 0.15 의 3 이 아니라 2), D07 은 `snapshots/**` 를 이름으로 비교하지 않고 내용 해시가 하나도 빠지지 않았는지 본다(ts 기록기는 보관한 판을 `snapshots/**` 아래에 모은다). `files` 가 다르면 실패한다는 것은 기준값 사본을 가짜 ts 기록으로 주입한 시험(`test_compat_harness`)이 지킨다. PR26b 에서 ts 기록기를 만들 때 정규화 N4(순서)·N5(ID → `<ID:n>`)를 ts DTO·표 비교에 연결한다 — 지금은 두 쪽이 모두 Python 이라 `compat_normalize` 의 `n4_*`·`n5_ids` 가 단위 시험에서만 쓰인다.

**OS·PC 마다 남는 차이(E05·E11·E13~E15):** 기준값은 macOS 에서 만든 하나다. Windows 러너(2026-11-11 SEL-70 PR #50)에서 드러난 차이는 두 종류로 나눈다. **(가) 표현 차이**는 비교 전에 정규화해서 지운다(아래 표). **(나) 0.15 가 Windows 에서 데이터 자체를 다르게 저장하거나 OS 별로 다르게 동작하는 것**은 정규화로 지우지 않는다 — `cases.json` 사례의 `os_overrides.win32` 가 그 OS 에서만 기준값의 해당 칸을 바꾼다(`compat_cases.baseline_for`; 없는 칸을 가리키면 던진다). 그대로 두면 Windows 에서 실행해도 통과하고, 값이 또 달라지면 여전히 실패한다. 외부 도구 상태·포트 점유 행은 비교에서 빼고, Windows `LOCALAPPDATA`·`APPDATA` 는 임시 HOME 으로 돌린다(`os_notes`).

**(가) 정규화 규칙 — 무엇을·왜·어느 사례**

| 규칙 | 무엇을 | 왜 | 사례 |
|---|---|---|---|
| N7 (기존) | `\r\n` → `\n`, BOM 제거 | Windows 는 텍스트 파일을 CRLF 로 쓴다 — 내용 해시(`n9_text_hash`)·콘솔 비교 전에 LF 로 | E05·E11 의 `reports/plan/report.{html,md}` 해시가 같은 이유 |
| N2 (기존) | 루트 철자(8.3 `RUNNER~1`, 겹역슬래시) → `<ROOT>`, 그 뒤 경로 구분자 `\` → `/` | 루트 아래 경로 표기 | 전 사례 |
| **N11** | **콘솔 글**에 찍힌 상대 파일 경로의 `\` → `/` (확장자로 끝나는 `a\b\c.ext` 만) | `pes report` 가 `reports\plan\report.html` 로 찍는다 — 같은 값이 저장된 것은 데이터라 건드리지 않는다(W1). 글 속 `\n` 은 확장자가 없어 그대로 | E05·E11 의 `report` 단계 stdout |
| **N12** | `http.server` 가 직접 쓰는 404 HTML 쪽 → `<python http.server error page>` (상태 ≥ 400 이고 제목·머리글이 `Error response`) | 쪽 글은 PES 가 아니라 **파이썬 버전**의 것이다 — 3.9~3.12 는 460자, 3.13 이상은 더 짧다(OS 차이가 아니라 러너의 파이썬 차이). 상태·content-type·cache-control 은 그대로 비교 | E13 (기준값 E13 의 4칸을 이 표시로 바꿈) |
| **N13** | 파이썬 **traceback 의 마지막 줄**에서 `FileNotFoundError: [WinError 2] The system cannot find the file specified:` / `[WinError 3] The system cannot find the path specified:` → `FileNotFoundError: [Errno 2] No such file or directory:` (이 두 문구만) | OS 가 같은 "파일/경로 없음"을 다르게 적는다 — 뜻이 같은 것만 접는다. 다른 오류(권한·이미 있음 등)와 다른 예외 종류는 그대로 비교 | X02 (`ask-prep` 가 없는 프로젝트에서 0.15 traceback — D11) |

**Windows 0.15 차이(PR26 에서 다룰 것)** — 정규화하지 않고 `os_overrides.win32` 로 고정한 것. 로컬(macOS)에서 만들 수 없어 값은 CI 로그의 실제 값에서 옮겼다(출처: SEL-70 PR #50 windows-latest 5·6·7/8 실패 로그). 값이 틀리면 CI 에서 `PES_COMPAT_DUMP=1` 로 실제 기록을 받는다(아래).

- **W1. project.json 에 보고서 경로를 역슬래시로 저장.** `stages.<단계>.reports[].path` 가 Windows 에서 `reports\plan\report.html` 이다(macOS·Linux 는 `reports/plan/report.html`). 재현: Windows 에서 `pes.py report <프로젝트> plan` 뒤 `project.json`. 사례: E05·E11. 영향: 프로젝트 폴더를 macOS ↔ Windows 로 옮기면 경로가 맞지 않아 보고서 링크·존재 검사가 깨질 수 있다(결함 후보 — 실제로 깨지는지는 PR26 에서 확인). TS 판은 OS 와 무관하게 `/` 로 저장하는 것이 기본 방향.
- **W2. 보고서 파일이 CRLF 로 써지고, 그 크기가 `bytes` 로 저장.** `reports[].bytes` 가 Windows 에서 더 크다(E05 html 10333→10439, md 761→797; E11 html 10058→10164, md 497→522; 차이 = 줄 수로 추정, 확인은 CI 진단). 그 때문에 `project.json`·`index.html` 의 해시도 다르다(W1 의 경로와 `bytes` 가 거기 들어 있다). 사례: E05·E11. 영향: 같은 내용의 보고서가 OS 마다 다른 바이트라 내용 해시·크기 비교로 변경을 가려내면 어긋난다. 파일 내용 자체는 N7 로 LF 로 맞춰 비교하므로(`reports/plan/report.*` 해시 동일) 표현 차이만 있다 — 저장된 `bytes` 만 데이터 차이다.
- **W3. `setup check` 가 Windows 에서만 `gitbash` 행(group 기본)을 더한다.** 설계된 OS 별 점검 항목이다(`scripts/setup.py` `gitbash()` — 답 자동 수신 Monitor 가 Git Bash 를 쓴다). 결함이 아니라 OS 별 기준값이다. 사례: E14 (`names`·`groups` 에 한 칸씩).

**CI 진단 모드:** `PES_COMPAT_DUMP=1` 이면 py 대상 사례가 기준값(OS 별 반영 후)과 다를 때 실패하는 대신 `COMPAT_DUMP <id> <platform>` / 실제 기록 JSON 한 줄 / `COMPAT_DUMP_END <id>` 를 출력한다. 값이 맞는지 확인하거나 다른 OS 값을 받을 때만 쓴다 — 기본(변수 없음)은 반드시 비교해 실패한다.

**기준값 다시 만들기(0.15 동작을 일부러 바꾼 경우만):** `PES_COMPAT_UPDATE=1 node --test tests/test_compat_cases_*.test.ts` → `git diff tests/fixtures/compat/baseline` 을 검토한다. 평소 실행은 파일을 쓰지 않는다.

## pes.ts — TS 진입점 시험 (SEL-71, PR26b)

`scripts/pes.ts`(CLI 32개 + set)가 0.15 와 같은지, 그리고 그 자식 프로세스가 실제 홈을 건드리지 않는지 본다. **시험이 먼저 써졌다** — `scripts/pes.ts` 가 생기기 전에는 아래 시험 중 `test_pes_ts_contract`·`test_pes_ts_win_data`·`test_pes_ts_set_lock` 의 pes.ts 시험과 `test_compat_harness` 의 "target selection" 이 실패한다(그게 구현이 맞춰야 할 정답).

| 파일 | 하는 일 |
|---|---|
| `tests/helpers/compat_ts.ts` | TS 대상: 실행 방법·가드 플래그·자식 실행(`run_ts_cli`), DB 쪽 상태(`ts_seed_legacy`·`ts_view`·`ts_age_lease`·`ts_seed_feedback`·`ts_rename_slug`) |
| `tests/helpers/ts_child_guard.ts` | 자식 안에서 `--import` 로 도는 시험 전용 가드(읽기 가드 + 허브 차단) |
| `tests/helpers/ts_inject_fs.ts` | SEL-75 오류 주입(잠금 파일 EPERM·EEXIST, 가짜 시계) |
| `tests/helpers/ts_guard_probe.ts`·`ts_inject_probe.ts` | 위 둘의 자기 시험용 가짜 자식(pes.ts 없이 돈다) |
| `tests/fixtures/compat/contract.json` + `baseline/X0n.json` | CLI 계약 사례 X01~X11: 이름·인자 수·없는 프로젝트·나쁜 단계/파일/JSON·홈 명령 (쓰기 X01~X05, 읽기 X06·X07, 1차 리뷰 X08~X11: 순서 없는 approve·승인된 단계 round-start(D13), chat 빈 답, merge 잘못된 sources) |
| `tests/test_pes_ts_contract.test.ts` | SEL-71/77 담당 목록, 실행 방법, (a) 사례 14개를 ts 에서 |
| `tests/test_pes_ts_review1_core.test.ts` | 1차 리뷰(코어): CLI 전용 선택 항목이 API·A 실행기로 새지 않음(`note_stage` 폴백·`any_order`·`plan_asking`·`allow_blank`), 읽기 모델이 `set` 필드 7개만 받음, 읽기 모델이 클라이언트가 고른 이름(`implicit-approval.json`·`pes-cli:re-approve`)을 믿지 않음 |
| `tests/test_pes_ts_review1_cli.test.ts` | 1차 리뷰(CLI): 같은 이름 다른 폴더 두 `set` 동시(갱신 유실 0·객체 1개), `init` 폴더 생성 실패 뒤 DB 에 프로젝트 없음·다시 init, `EPERM` 도 `[Errno 13] Permission denied` 한 줄 (`helpers/ts_inject_read.ts` 가 읽기 오류 주입) |
| `tests/test_pes_ts_guard.test.ts` | 가드·주입 장치 자기 시험 (지금도 통과) |
| `tests/test_pes_ts_devices.test.ts` | D02·D03·D04 비교 장치와 D10·D11 규칙 자기 시험 (지금도 통과) |
| `tests/test_pes_ts_win_data.test.ts` | W1·W2: 옛 역슬래시·CRLF 데이터 읽기, `/`·LF 쓰기 |
| `tests/test_pes_ts_set_lock.test.ts` | SEL-75 Windows `set` 잠금 행렬을 ts 에 |

**실행 방법(고정):** `node scripts/pes.ts <명령> <인자…>` — Node 26 이 타입을 지운다. tsx·ts-node·빌드·로더 없음(`test_pes_ts_contract` 가 package.json 과 shebang 을 본다). 시험에서는 앞에 가드 플래그가 붙는다: `node --permission --allow-fs-read=<저장소> --allow-fs-read=<임시 루트> --allow-fs-write=<임시 루트> --allow-net --disable-warning=ExperimentalWarning --import tests/helpers/ts_child_guard.ts scripts/pes.ts …`. 사용자가 치는 맨 `node scripts/pes.ts` 도 같은 시험이 돌려 사용법·exit·**깨끗한 stderr** 를 본다.

**TS 자식 가드 (PR26a README "PR26b 몫"):** 두 겹이다. ① `--permission` 허용 목록에 실제 홈이 없다 → 읽기·쓰기 모두 Node 가 `ERR_ACCESS_DENIED`. 자식 프로세스는 기본으로 못 띄운다(`allow_child_process` 로 사례가 요청). 네트워크는 열어 두고(`--allow-net`; 막으면 허브 접속 시도가 `ERR_ACCESS_DENIED` 에 가려진다) 허브 포트만 ② 로더가 막는다. ② `ts_child_guard.ts` — `node:fs`·`fs/promises` 의 경로 받는 함수 전부와 `new DatabaseSync(경로)` 가 실제 `.pes`·`pes-projects` 를 가리키면 stderr 에 `PESHomeAccessViolation` 한 줄을 쓰고 던진다(제품 코드가 오류를 삼켜도 하네스가 실패한다 — 파이썬 감사 훅과 같다). 심볼릭 링크 별칭은 `realpath`·`readlink` 로 따라간다. 허브 차단: `net.Socket#connect`·`fetch` 가 8760~8775 에서 ECONNREFUSED(`allow_hub_port` 한 포트만 열림, 시도는 `PES_TEST_HUB_LOG` 로 센다). 합성 '가짜 실제 홈'으로 실제 차단을 시험한다(`test_pes_ts_guard`). 한계: `--permission` 은 허용 폴더 안의 심볼릭 링크가 가리키는 바깥을 막지 못한다(로더가 보고), 네이티브 애드온·`process.binding` 은 못 본다, 손자 프로세스는 `--allow-child-process` 를 켠 사례에서만 생기고 가드를 잇지 못한다.

**D02·D03·D04 비교 장치:** 전부 `compat_ts.ts` + `compat_cases.ts` 에 있고, DB 쪽은 제품의 읽기 모델(`build_project_view`, DB 방식 CLI 가 화면을 만드는 그 코드)로 읽는다.

- **D02 (project.json → DB):** ts 의 상태 DTO 는 DB 에서(슬러그 = 폴더 이름, 0.15 `pdir` 규칙) — DB 에 없으면 폴더의 옛 project.json 에서 — 만든다. DB 는 빈 `executive_summary`·`conclusion`·`qa`·`review_log` 를 늘 채우고 0.15 는 첫 쓰기 때 키를 만들므로 `d02_canon` 이 빈 값을 양쪽에서 뺀다(값이 있으면 둔다). `project.json`·`library.json` 파일 자체는 비교하지 않는다(ts 는 옛 형식을 쓰지 않음). 옛 폴더를 ts 에서 쓰려면 사례가 `ts_import` 단계를 둔다 — PR11·PR12 이전 도구(import → 검증 → 활성화)로 DB 에 올린다(옛 project.json 에 `slug` 가 없으면 폴더를 건드리지 않고 사본으로).
- **D03 (feedback 파일 → submissions):** 답은 파일 이름·시각이 아니라 `{단계, 라운드, 종류, 글}` 모음으로 견준다(`record.answers`; 0.15 는 `feedback/*.json`, ts 는 DB 의 답). `chat` 이 찍는 답 식별자 줄과 `pending` 이 찍는 이름은 공통 부분만(`d03_stdout`). 옛 답 파일을 폴더에 떨어뜨리는 단계는 ts 에서 웹 제출(`cli_bridge` 의 `web_feedback` — `serve.py` 가 부르는 그 호출)로 바뀐다.
- **D04 (.pes-lock → lease):** 각 단계 뒤에 '지금 누가 쥐었나'(`lock.owner`)를 기록해 그대로 견준다 — 0.15 는 `.pes-lock` 의 owner(2시간 안 것만), ts 는 살아 있는 lease 와 그 `external_session_ref`(= `PES_OWNER`). 만료는 하네스가 시계를 돌린다(`age_lock` ↔ `ts_age_lease`).

**의도된 차이 추가:** `D13`(순서 없는 `approve`·승인된 단계의 `round-start` — 스킬은 승인을 순서대로 하고 승인된 단계는 reopen 뒤에 round-start 하므로 DB 보장을 CLI 호환 때문에 풀지 않는다: ts 는 exit 1 + 스택·영어 code 없는 한국어 한 줄. 사례 X08·X09 에 0.15 기준값(exit 0)과 ts 기대 문구(`KNOWN_DIFFS.D13.ts_steps`)를 둘 다 고정하고, 사례의 그 단계에는 `"d13": true` 를 단다. 거절된 단계는 ts 에서 아무것도 바꾸지 않으므로 끝 상태(DTO·파일)는 0.15 를 **그 단계 없이** 돌린 기록 `baseline.ts_end` 와 견준다 — py 대상이 `PES_COMPAT_UPDATE=1` 때 함께 만든다), `D10`(W1·W2 — ts 는 어느 OS 에서나 `/`·LF; 그래서 ts 는 `os_overrides.win32` 를 쓰지 않고 macOS/Linux 기준값과 같아야 하며(`ts_baseline`), 폴더에 CR·역슬래시 경로가 없어야 한다(`assert_posix_storage`)), `D11`(0.15 가 traceback 으로 죽는 단계 — ts 는 같은 exit 와 스택 추적 없는 한국어 한 줄; `fixable` 에 적은 단계만 성공해도 됨; PR26a 가 관찰한 3건: merge·ask 의 없는 파일, 깨진 project.json, `current` 없는 큰 프로젝트). 사용법 첫 줄의 실행 형식(`python3 -I pes.py` ↔ `node scripts/pes.ts`)은 `사용: <RUN> <` 로 정규화한다.

**SEL-75 행렬(ts):** `test_pes_ts_set_lock` — 0.15 의 `test_cli_set_lock_windows` 와 같은 시나리오 21개를 Node 쪽 주입으로. Windows 흉내(`nt`)는 오류를 다루는 동안만 `process.platform` 이 `win32` 로 읽히게 한다. 해석: ts `set` 도 0.15 의 짧은 쓰기 잠금 `<프로젝트 폴더>/.project.json.lock`(배타 생성, 60초 넘으면 묵은 것, 30초 기다림, 마감 뒤 exit 3 "다른 set", 잠금 없는 PermissionError 는 비 Windows 에서 즉시 exit 2 "권한")을 쓴다.

### pytest → TS 대응 (Python 시험은 PR26 끝에서 지운다 — 지금은 그대로 둔다)

| pytest | TS | 비고 |
|---|---|---|
| `conftest.py` | `helpers/home_guard.ts`·`compat_env.ts`(`make_ctx`·`synthetic_project`·`run_pes`) | 감사 훅 → 3겹 가드 |
| `test_project_basic.py` | `test_cli_compat`·`test_state_load`·`test_home_guard` | |
| `test_questions.py` | `test_questions_html` | |
| `test_serve.py` | `test_feedback_http`·`test_feedback_collision` (+ `helpers/compat_inject.ts`) | |
| `test_state.py` | `test_state_transitions`·`test_reports_compat`·`test_restore_compat` | xfail(depth, D06)는 '0.15 결함 고정' 단언 |
| `test_lock.py` | `test_lock_compat` | 프로세스 안 `lock_info` 경계는 짧은 `-c` 조각(새 `.py` 파일 없음) |

**옮기지 않은 것(Python 내부 계약, CLI 로 볼 수 없음):** `pes.CMDS` 를 monkeypatch 하는 `main` 분기·argv 불변 시험, `pes.pes_home()`/`pes.CONFIG` 속성 직접 확인, 감사 훅 자체의 단위 시험(→ `test_home_guard` 가 TS 가드를 같은 관점에서 시험), `test_start_failure_terminates_child_and_closes_log` 의 '로그 파일 핸들이 닫힘' 단언(TS 하네스는 로그를 파일이 아니라 메모리 문자열로 모아 닫을 핸들이 없다 — 자식이 모두 끝났다는 단언은 `test_feedback_http` 에 옮겼다). 이들은 PR26 에서 Python 과 함께 사라진다.

### home_guard 가 막는 것

"실제 `~/.pes`·`~/pes-projects` 접근 0" 을 자식 종류별로 이렇게 지킨다. 실제 홈은 `os.homedir()`(= `$HOME`을 따라감)와 `os.userInfo().homedir`(계정의 홈) **둘 다**다 — 임시 HOME 으로 `npm test` 를 돌려도 계정의 실제 홈을 본다.

| 자식 | 읽기 | 쓰기·생성·삭제 | 출력에 실경로 |
|---|---|---|---|
| Python(0.15) — `run_pes("py")`·`ServeProcess`·`run_setup("py")`·`run_py_code` | **막는다** — 자식 안에서 `tests/conftest.py` 의 `GUARD`(감사 훅 + `os.stat`/`Path.stat` 가드)를 그대로 실행한다. 새 `.py` 파일 없이 `-c "<GUARD>; runpy.run_path(…)"` 로 띄우고 `PES_TEST_GUARD=1`·`PES_TEST_REAL_HOME`(= `os.userInfo().homedir`)을 준다. 위반은 자식 stderr 의 `PESHomeAccessViolation` 이고 하네스가 `assert.fail` 한다 | 막는다(같은 훅) + 전후 스냅샷 | 검사 |
| TS(`scripts/pes.ts`) | **막는다 (SEL-71)** — `--permission` 허용 목록에 실제 홈이 없고, `--import` 로 도는 `ts_child_guard.ts` 가 `PESHomeAccessViolation` 을 보고한다 (위 「pes.ts — TS 진입점 시험」). `serve.ts`·`setup.ts` 는 아직 대상이 없다 | 같은 가드 + 전후 스냅샷 | 검사 |

**훅이 보지 못하는 것(그래서 따로 막거나 아직 못 막는다):**

- **HTTP 접속.** 감사 훅은 파일 접근만 본다. `doctor` 등은 포트 8760~8775 의 `/whoami` 로 실제 허브의 루트를 읽을 수 있다. 그래서 **저장소 시험이 띄우는 모든 Python 자식**(`pes.py`·`serve.py`·`setup.py`)이 허브 차단(`tests/helpers/hub_block.ts`)을 받는다: `urlopen` 은 URLError, `socket.connect` 는 ConnectionRefusedError, `connect_ex` 는 111 — 8760~8775 어느 포트에서나. 범위: `compat_env`(`guarded_script_argv`), `cli_read_env`·`cli_write_env`·`web_env`, e2e `workspace`, 자식을 직접 띄우는 시험 파일은 `hub_blocked_argv([...python 인자])` 로 감싼다. pytest 쪽은 `tests/conftest.py` 의 `no_real_hub`(자동, 프로세스 안)과 `HUB_BLOCK`(`cli` 픽스처·`test_serve` 의 sitecustomize). 새 Python 자식을 띄우는 도우미는 반드시 이 감싸기를 쓴다. 허브를 일부러 쓰는 시험만 `allow_hub_port: <포트>` 로 **그 포트 하나**만 연다(나머지는 계속 막힘). 막힌 시도는 "서버 없음"으로 보일 뿐 시험을 실패시키지는 않는다(`doctor` 는 원래 그 포트를 두드린다) — 실제 허브가 받는 요청 수가 0 인지는 `test_compat_review`·`test_compat_harness` 의 가짜 허브와 아래 8760 재현으로 확인한다.
- **N2 한계.** 정규화(`n2_paths`)는 공백이 두 개 이상인 폴더 이름(`a b c\\x.json`, Windows 역슬래시)을 첫 단어 뒤에서 끊는다. 기준값·fixture 에 그런 폴더 이름을 넣지 않는다(`test_compat_review` 가 이 한계를 단언한다).
- **`sqlite3.connect`.** 감사 이벤트가 있지만(파이썬 3.10+) `GUARD` 에 넣지 않았다. 0.15 는 sqlite 를 쓰지 않는다.
- **`os.access`·`chmod`·`utime`·`truncate`** 등 일부 호출, **ctypes 로 직접 부르는 `open(2)`** (0.15 코드에 ctypes 는 없다).
- **손자 프로세스.** 예: `doctor` 의 `find_tool` 이 PATH 밖(`/opt/homebrew/bin` 등)의 vworld·kosis 를 띄운다. 자식 안 훅은 손자에게 이어지지 않는다. HOME 은 임시 폴더로 격리되어 있고, 시험은 `narrow_path`·임시 `LOCALAPPDATA` 로 도구를 좁힌다.
- **`PES_TEST_GUARD`.** 사례·옵션의 `env` 가 이 값을 바꾸지 못한다(`child_env` 가 합친 뒤 `"1"` 을 단언; 가드 자기 시험은 `PES_TEST_REAL_HOME` 만 바꾼다).

공통 3겹: ① 자식 시작 전 `HOME`·`USERPROFILE`·`PES_HOME` 이 임시 폴더인지 검사(`assert_isolated_env`), ② 파일 전후 이름·크기·mtime 비교(`use_home_guard`, 깊이 3 — 읽기는 흔적이 없고 깊이 4 이하의 내용 수정은 상위 폴더 mtime 이 안 변하면 놓친다), ③ 출력·산출 파일에 보호 경로 문자열이 없는지(`assert_no_real_path` — 경로 **이름**이 아닌 프로젝트 이름만 새는 경우는 못 본다). 가드 자체는 합성 '가짜 실제 홈'(`PES_TEST_REAL_HOME`)으로 시험한다(`test_home_guard`): 자식이 그 아래를 **읽기만** 해도 실패한다.

경로 판정(`touches_protected`)은 보호 폴더처럼 보이는 경로를 철자만으로 결정한다(파일 시스템을 건드리지 않는다). 보호 폴더처럼 안 보이는 경로만 `realpath` 로 풀어 심볼릭 링크·junction 별칭을 본다. 스냅샷은 두 보호 폴더의 이름·크기·mtime 만 `lstat` 으로 읽고 내용은 열지 않는다.

## serve.ts·setup.ts 시험 (SEL-72, PR26c)

PR26c 는 `scripts/serve.ts`(= `serve.py <PES 홈> [포트]` 직접 실행과 같은 계약)와 `scripts/setup.ts`(= `setup.py` 7개 명령)를 독립 진입점으로 옮긴다. `scripts/pes.ts` 는 SEL-71·77 몫이라 건드리지 않는다 — `pes serve`·`stop`·`hub`·`open`·`watch`·`doctor` 가 `serve.ts` 를 부르는 연결과 `/api/v1/*` 통과 길(serve.py 의 DB API)은 SEL-77 이후다.

**완료 목록 `SEL72_DONE`(`helpers/sel72_scope.ts`)** — E08·E09·E13(http → `serve.ts`)·E14(setup → `setup.ts`). E15(`doctor --json`)는 `pes.ts` 명령이라 `not_yet` 로 남는다(`test_serve_ts_cases` 가 단언). `cases.json` 의 `ts.status`·`test_compat_harness` 의 `TS_IMPLEMENTED` 가 이 목록과 같다.

| 파일 | 내용 |
|---|---|
| `helpers/compat_ts_srv.ts` | ts 대상: 실행 방법·가드 플래그(`ts_srv_argv`)·`run_ts_setup`·`spawn_ts_setup`·`TsServeProcess`(주입 포트·허브/역DNS 기록)·합성 프로젝트의 DB 이전(`srv_seed_project`)·DB 에서 읽는 답(`srv_answer_docs`)·D12/D03 어댑터 |
| `helpers/ts_child_guard.ts` | 자식 안에서 `--import` 로 도는 읽기 가드 + 허브 차단(SEL-71 과 같은 파일) |
| `helpers/ts_no_reverse_dns.ts` | `serve.ts` 전용 `--import`: `dns.reverse`·`lookupService`·IP 가 아닌 이름 조회가 있으면 `PES_TEST_DNS_LOG` 에 한 줄(SEL-33) |
| `helpers/serve_ts_env.ts` | 서버 시험 공용 준비물(합성 PES 홈 + DB 프로젝트 + 서버)과 원시 소켓 도우미 |
| `test_serve_ts_cases` | E08·E09·E13·E14 를 ts 대상에서 0.15 기준값과 대조 |
| `test_serve_ts_static` | 실행법·사용법·포트 오류·배너·loopback 전용·역DNS 없음·허브 접속 0·정적 파일 규칙·traversal·CORS·허용 안 하는 메서드 |
| `test_serve_ts_feedback` | `POST /<slug>/feedback`: 저장 기록, 검사 순서, Origin·신뢰 목록(요청마다 읽음), 크기(413), round·깊이 한도, Referer 별칭, DB 에 없는 폴더 404, 동시 40개, 재시작 |
| `test_serve_ts_guard` | 가드 플래그 적용(단위) + 가짜 '실제 홈' 아래를 읽으려는 서버가 `PESHomeAccessViolation` 으로 잡힘 |
| `test_setup_ts_contract` | `check [--json]`·`needed`·`mark`·사용법·`install`/`upgrade` 의 외부 호출 없는 분기·LAW_OC 행 |
| `test_setup_ts_keys` | API 키 화면(`keys-serve`·`keys`): **합성 키·임시 HOME 만**, 포트는 `PES_KEYS_PORT` 로 주입 |

**실행 방법(고정):** `node scripts/serve.ts <PES 홈> [포트]`, `node scripts/setup.ts <명령> …` — Node 26 이 타입을 지운다(tsx·ts-node·빌드 없음). 시험에서는 `node --permission --allow-fs-read=<저장소> --allow-fs-read=<임시 루트> --allow-fs-write=<임시 루트> --allow-net --import tests/helpers/ts_child_guard.ts …` 가 앞에 붙는다. **자식 프로세스는 기본 금지**(`--allow-child-process` 없음): `serve.ts` 는 답을 같은 프로세스 안에서 DB 에 쓴다(`cli_bridge` 를 요청마다 띄우지 않는다). `setup.ts` 는 실행하지 못하는 외부 도구를 '없음'으로 본다(setup.py 의 `run()` 이 모든 예외를 -1 로 삼킨 것과 같다). `keys` 만 키 화면 자식을 띄워야 해서 그 시험에서만 `allow_child_process` 를 켠다.

**허용 목록 밖은 보이지 않는다:** `/opt/homebrew`·`/usr/local`·실제 홈이 허용 목록에 없으므로 개발 PC 에 설치된 kosis·vworld·korean-law·ego-browser 가 자식에게 보이지 않는다. 그래서 `setup.ts check` 의 행은 어느 PC 에서나 같고(`test_setup_ts_contract` 가 행 전체를 단언), 키 등록(`reg_*`)은 외부 도구를 부르지 못한다. 0.15(py) 쪽 E14 는 PATH 만 좁히므로 안정 행만 견주는 기존 방식을 그대로 둔다.

**의도된 차이:** D03(답은 DB 제출 — 하네스가 DB 에서 읽어 `feedback/<이름>` 파일 해시와 `feedback.log` 줄을 0.15 철자로 바꿔 견준다; 응답의 `v` 는 정수인지 확인하고 뺀다; DB 가 붙이는 `id`·`set_id` 는 해시 전에 뺀다), D09(정적 서빙은 그대로라 차이 없음), **D12 신설**(setup: `check` 에 `python` 행이 없고 사용법 첫 줄이 `사용: python3 -I setup.py <명령>` 가 아니라 `사용: node scripts/setup.ts <명령>` — `adapt_ts_setup_stdout` 이 두 사실을 먼저 단언한 뒤 0.15 철자로 되돌려 한 번에 견준다).

**시험하지 않는 것(외부 호출·브라우저):** `install kosis|vworld|ego-browser`(curl | sh·앱 내려받기·브라우저 열기), `install missing`/이름 없는 `install`, `upgrade kosis|vworld|ego-browser|all`, `--no-open` 없는 `keys`, 키 화면의 3시간 시간 제한(`SETUP keys timeout`), 기본 포트 8759·허브 포트 8760~8775 에 실제로 묶는 일.

**새 환경 변수 `PES_KEYS_PORT`:** API 키 화면의 포트(기본 8759). 시험이 빈 포트를 주입한다. 유효하지 않으면(정수 1~65535 아님) 종료 코드 2 와 변수 이름이 든 한 줄 메시지.

**구현 선택으로 고정한 것(0.15 와 다르거나 0.15 가 정하지 않은 것):** DB 에 없는 폴더(project.json 만 있음)의 `POST /<slug>/feedback` 은 404 `{"ok":false}`(0.15 는 파일에 썼다 — D02: project.json 은 읽기 전용); `serve.ts` 의 잘못된 포트·인자는 스택 추적 없이 종료 코드 2, 이미 쓰는 포트는 1.
