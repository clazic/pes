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
| `tests/helpers/compat_normalize.ts` | 정규화 N1~N12(시각·경로·JSON·순서·ID·HTML·인코딩·콘솔·파일 메타·의도된 차이·콘솔 상대경로·stdlib 오류 페이지) |
| `tests/helpers/compat_env.ts` | 이중 실행 하네스: 대상 `py`(`python -I -X utf8 -c "<conftest GUARD>; runpy.run_path(scripts/pes.py·serve.py·setup.py)"`, `PES_DB_CORE` 없음) / `ts`(`scripts/pes.ts`·`serve.ts`·`setup.ts`, 아직 없음 → `not_yet`), 상태 DTO, 의도된 차이 표(D01~D09), `serve.py` 하네스 |
| `tests/helpers/compat_cases.ts` + `tests/fixtures/compat/cases.json` | E01~E15 사례 표와 실행기. 0.15 기준값은 `tests/fixtures/compat/baseline/E??.json` |
| `tests/helpers/home_guard.ts` | 실제 `~/.pes`·`~/pes-projects` 접근 0 — 아래 「home_guard 가 막는 것」 |
| `tests/test_compat_harness.test.ts` | 정규화기·대상 선택·**미구현 목록이 표와 정확히 같다** |
| `tests/test_compat_cases_{a,b,c}.test.ts` | E01~E15를 0.15 대상에서 기준값과 대조 |
| `tests/test_compat_review.test.ts` | 최종 리뷰 1 반영: N6 요약이 제목 escape·공용 모듈 수를 보는지, N2 공백 경로(Windows 철자), 가짜 허브가 떠 있어도 E15 가 같고 접속 0, 상태 DTO 키 전수, `PES_TEST_GUARD` 를 끌 수 없음 |

**대상 바꾸기:** `PES_COMPAT_TARGET=py`(기본) 또는 `ts`. `ts` 에서 아직 없는 명령은 건너뛰지 않고 `not_yet` 으로 단언한다. 사례 종류마다 ts 파일이 하나씩 있다 — `cli`(E01~E07·E10~E12·E15) = `scripts/pes.ts`, `http`(E08·E09·E13) = `scripts/serve.ts`, `setup`(E14) = `scripts/setup.ts`. 셋 모두 같은 문(`compat_env.ts_gate`)으로 막혀 있어서, 파일이 하나라도 생기면 그 종류의 사례 실행이 throw 하고 `test_compat_harness` 가 실패한다(파일 존재와 `TS_IMPLEMENTED` 의 종류별 개수가 맞아야 한다). 그때 `compat_env`·`compat_cases` 에 ts 대상을 연결하고 `cases.json` 의 `ts.status` 와 시험의 `TS_IMPLEMENTED` 를 함께 고친다.

**`implemented` 의 뜻(`compat_cases.compare_ts_record`):** ts 기록이 py 와 같은 단언을 통과해야 한다 — `steps`(stdout·stderr 종류·exit)·상태 DTO·**산출 파일(`files`)** 전부 0.15 기준값과 같아야 한다. 의도된 차이는 각자 자기 단언을 가진다: D01 항목 id 는 값을 버리되 '있고 서로 다르다', D03 `processed` 는 버리되 '같은 길이의 목록', D06 은 구멍이 아니라 **값**(E03 항목 7 의 depth 는 0.15 의 3 이 아니라 2), D07 은 `snapshots/**` 를 이름으로 비교하지 않고 내용 해시가 하나도 빠지지 않았는지 본다(ts 기록기는 보관한 판을 `snapshots/**` 아래에 모은다). `files` 가 다르면 실패한다는 것은 기준값 사본을 가짜 ts 기록으로 주입한 시험(`test_compat_harness`)이 지킨다. PR26b 에서 ts 기록기를 만들 때 정규화 N4(순서)·N5(ID → `<ID:n>`)를 ts DTO·표 비교에 연결한다 — 지금은 두 쪽이 모두 Python 이라 `compat_normalize` 의 `n4_*`·`n5_ids` 가 단위 시험에서만 쓰인다.

**OS·PC 마다 남는 차이(E05·E11·E13~E15):** 기준값은 macOS 에서 만든 하나다. Windows 러너(2026-11-11 SEL-70 PR #50)에서 드러난 차이는 두 종류로 나눈다. **(가) 표현 차이**는 비교 전에 정규화해서 지운다(아래 표). **(나) 0.15 가 Windows 에서 데이터 자체를 다르게 저장하거나 OS 별로 다르게 동작하는 것**은 정규화로 지우지 않는다 — `cases.json` 사례의 `os_overrides.win32` 가 그 OS 에서만 기준값의 해당 칸을 바꾼다(`compat_cases.baseline_for`; 없는 칸을 가리키면 던진다). 그대로 두면 Windows 에서 실행해도 통과하고, 값이 또 달라지면 여전히 실패한다. 외부 도구 상태·포트 점유 행은 비교에서 빼고, Windows `LOCALAPPDATA`·`APPDATA` 는 임시 HOME 으로 돌린다(`os_notes`).

**(가) 정규화 규칙 — 무엇을·왜·어느 사례**

| 규칙 | 무엇을 | 왜 | 사례 |
|---|---|---|---|
| N7 (기존) | `\r\n` → `\n`, BOM 제거 | Windows 는 텍스트 파일을 CRLF 로 쓴다 — 내용 해시(`n9_text_hash`)·콘솔 비교 전에 LF 로 | E05·E11 의 `reports/plan/report.{html,md}` 해시가 같은 이유 |
| N2 (기존) | 루트 철자(8.3 `RUNNER~1`, 겹역슬래시) → `<ROOT>`, 그 뒤 경로 구분자 `\` → `/` | 루트 아래 경로 표기 | 전 사례 |
| **N11** | **콘솔 글**에 찍힌 상대 파일 경로의 `\` → `/` (확장자로 끝나는 `a\b\c.ext` 만) | `pes report` 가 `reports\plan\report.html` 로 찍는다 — 같은 값이 저장된 것은 데이터라 건드리지 않는다(W1). 글 속 `\n` 은 확장자가 없어 그대로 | E05·E11 의 `report` 단계 stdout |
| **N12** | `http.server` 가 직접 쓰는 404 HTML 쪽 → `<python http.server error page>` (상태 ≥ 400 이고 제목·머리글이 `Error response`) | 쪽 글은 PES 가 아니라 **파이썬 버전**의 것이다 — 3.9~3.12 는 460자, 3.13 이상은 더 짧다(OS 차이가 아니라 러너의 파이썬 차이). 상태·content-type·cache-control 은 그대로 비교 | E13 (기준값 E13 의 4칸을 이 표시로 바꿈) |

**Windows 0.15 차이(PR26 에서 다룰 것)** — 정규화하지 않고 `os_overrides.win32` 로 고정한 것. 로컬(macOS)에서 만들 수 없어 값은 CI 로그의 실제 값에서 옮겼다(출처: SEL-70 PR #50 windows-latest 5·6·7/8 실패 로그). 값이 틀리면 CI 에서 `PES_COMPAT_DUMP=1` 로 실제 기록을 받는다(아래).

- **W1. project.json 에 보고서 경로를 역슬래시로 저장.** `stages.<단계>.reports[].path` 가 Windows 에서 `reports\plan\report.html` 이다(macOS·Linux 는 `reports/plan/report.html`). 재현: Windows 에서 `pes.py report <프로젝트> plan` 뒤 `project.json`. 사례: E05·E11. 영향: 프로젝트 폴더를 macOS ↔ Windows 로 옮기면 경로가 맞지 않아 보고서 링크·존재 검사가 깨질 수 있다(결함 후보 — 실제로 깨지는지는 PR26 에서 확인). TS 판은 OS 와 무관하게 `/` 로 저장하는 것이 기본 방향.
- **W2. 보고서 파일이 CRLF 로 써지고, 그 크기가 `bytes` 로 저장.** `reports[].bytes` 가 Windows 에서 더 크다(E05 html 10333→10439, md 761→797; E11 html 10058→10164, md 497→522; 차이 = 줄 수로 추정, 확인은 CI 진단). 그 때문에 `project.json`·`index.html` 의 해시도 다르다(W1 의 경로와 `bytes` 가 거기 들어 있다). 사례: E05·E11. 영향: 같은 내용의 보고서가 OS 마다 다른 바이트라 내용 해시·크기 비교로 변경을 가려내면 어긋난다. 파일 내용 자체는 N7 로 LF 로 맞춰 비교하므로(`reports/plan/report.*` 해시 동일) 표현 차이만 있다 — 저장된 `bytes` 만 데이터 차이다.
- **W3. `setup check` 가 Windows 에서만 `gitbash` 행(group 기본)을 더한다.** 설계된 OS 별 점검 항목이다(`scripts/setup.py` `gitbash()` — 답 자동 수신 Monitor 가 Git Bash 를 쓴다). 결함이 아니라 OS 별 기준값이다. 사례: E14 (`names`·`groups` 에 한 칸씩).

**CI 진단 모드:** `PES_COMPAT_DUMP=1` 이면 py 대상 사례가 기준값(OS 별 반영 후)과 다를 때 실패하는 대신 `COMPAT_DUMP <id> <platform>` / 실제 기록 JSON 한 줄 / `COMPAT_DUMP_END <id>` 를 출력한다. 값이 맞는지 확인하거나 다른 OS 값을 받을 때만 쓴다 — 기본(변수 없음)은 반드시 비교해 실패한다.

**기준값 다시 만들기(0.15 동작을 일부러 바꾼 경우만):** `PES_COMPAT_UPDATE=1 node --test tests/test_compat_cases_*.test.ts` → `git diff tests/fixtures/compat/baseline` 을 검토한다. 평소 실행은 파일을 쓰지 않는다.

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
| TS(`scripts/*.ts`) | **아직 못 막는다 — PR26b 몫.** Node 자식에는 감사 훅이 없다. ts 대상은 지금 전부 `not_yet` 이라 실행되는 자식이 없다. ts 대상을 연결할 때 읽기 가드(예: `--permission` 의 `--allow-fs-read` 허용 목록)를 함께 넣는다 | 전후 스냅샷으로 감지 | 검사 |

**훅이 보지 못하는 것(그래서 따로 막거나 아직 못 막는다):**

- **HTTP 접속.** 감사 훅은 파일 접근만 본다. `doctor` 등은 포트 8760~8775 의 `/whoami` 로 실제 허브의 루트를 읽을 수 있다. 그래서 **저장소 시험이 띄우는 모든 Python 자식**(`pes.py`·`serve.py`·`setup.py`)이 허브 차단(`tests/helpers/hub_block.ts`)을 받는다: `urlopen` 은 URLError, `socket.connect` 는 ConnectionRefusedError, `connect_ex` 는 111 — 8760~8775 어느 포트에서나. 범위: `compat_env`(`guarded_script_argv`), `cli_read_env`·`cli_write_env`·`web_env`, e2e `workspace`, 자식을 직접 띄우는 시험 파일은 `hub_blocked_argv([...python 인자])` 로 감싼다. pytest 쪽은 `tests/conftest.py` 의 `no_real_hub`(자동, 프로세스 안)과 `HUB_BLOCK`(`cli` 픽스처·`test_serve` 의 sitecustomize). 새 Python 자식을 띄우는 도우미는 반드시 이 감싸기를 쓴다. 허브를 일부러 쓰는 시험만 `allow_hub_port: <포트>` 로 **그 포트 하나**만 연다(나머지는 계속 막힘). 막힌 시도는 "서버 없음"으로 보일 뿐 시험을 실패시키지는 않는다(`doctor` 는 원래 그 포트를 두드린다) — 실제 허브가 받는 요청 수가 0 인지는 `test_compat_review`·`test_compat_harness` 의 가짜 허브와 아래 8760 재현으로 확인한다.
- **N2 한계.** 정규화(`n2_paths`)는 공백이 두 개 이상인 폴더 이름(`a b c\\x.json`, Windows 역슬래시)을 첫 단어 뒤에서 끊는다. 기준값·fixture 에 그런 폴더 이름을 넣지 않는다(`test_compat_review` 가 이 한계를 단언한다).
- **`sqlite3.connect`.** 감사 이벤트가 있지만(파이썬 3.10+) `GUARD` 에 넣지 않았다. 0.15 는 sqlite 를 쓰지 않는다.
- **`os.access`·`chmod`·`utime`·`truncate`** 등 일부 호출, **ctypes 로 직접 부르는 `open(2)`** (0.15 코드에 ctypes 는 없다).
- **손자 프로세스.** 예: `doctor` 의 `find_tool` 이 PATH 밖(`/opt/homebrew/bin` 등)의 vworld·kosis 를 띄운다. 자식 안 훅은 손자에게 이어지지 않는다. HOME 은 임시 폴더로 격리되어 있고, 시험은 `narrow_path`·임시 `LOCALAPPDATA` 로 도구를 좁힌다.
- **`PES_TEST_GUARD`.** 사례·옵션의 `env` 가 이 값을 바꾸지 못한다(`child_env` 가 합친 뒤 `"1"` 을 단언; 가드 자기 시험은 `PES_TEST_REAL_HOME` 만 바꾼다).

공통 3겹: ① 자식 시작 전 `HOME`·`USERPROFILE`·`PES_HOME` 이 임시 폴더인지 검사(`assert_isolated_env`), ② 파일 전후 이름·크기·mtime 비교(`use_home_guard`, 깊이 3 — 읽기는 흔적이 없고 깊이 4 이하의 내용 수정은 상위 폴더 mtime 이 안 변하면 놓친다), ③ 출력·산출 파일에 보호 경로 문자열이 없는지(`assert_no_real_path` — 경로 **이름**이 아닌 프로젝트 이름만 새는 경우는 못 본다). 가드 자체는 합성 '가짜 실제 홈'(`PES_TEST_REAL_HOME`)으로 시험한다(`test_home_guard`): 자식이 그 아래를 **읽기만** 해도 실패한다.

경로 판정(`touches_protected`)은 보호 폴더처럼 보이는 경로를 철자만으로 결정한다(파일 시스템을 건드리지 않는다). 보호 폴더처럼 안 보이는 경로만 `realpath` 로 풀어 심볼릭 링크·junction 별칭을 본다. 스냅샷은 두 보호 폴더의 이름·크기·mtime 만 `lstat` 으로 읽고 내용은 열지 않는다.
