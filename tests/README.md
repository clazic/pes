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
| `tests/helpers/compat_normalize.ts` | 정규화 N1~N10(시각·경로·JSON·순서·ID·HTML·인코딩·콘솔·파일 메타·의도된 차이) |
| `tests/helpers/compat_env.ts` | 이중 실행 하네스: 대상 `py`(`python -I -X utf8 -c "<conftest GUARD>; runpy.run_path(scripts/pes.py·serve.py·setup.py)"`, `PES_DB_CORE` 없음) / `ts`(`scripts/pes.ts`·`serve.ts`·`setup.ts`, 아직 없음 → `not_yet`), 상태 DTO, 의도된 차이 표(D01~D09), `serve.py` 하네스 |
| `tests/helpers/compat_cases.ts` + `tests/fixtures/compat/cases.json` | E01~E15 사례 표와 실행기. 0.15 기준값은 `tests/fixtures/compat/baseline/E??.json` |
| `tests/helpers/home_guard.ts` | 실제 `~/.pes`·`~/pes-projects` 접근 0 — 아래 「home_guard 가 막는 것」 |
| `tests/test_compat_harness.test.ts` | 정규화기·대상 선택·**미구현 목록이 표와 정확히 같다** |
| `tests/test_compat_cases_{a,b,c}.test.ts` | E01~E15를 0.15 대상에서 기준값과 대조 |

**대상 바꾸기:** `PES_COMPAT_TARGET=py`(기본) 또는 `ts`. `ts` 에서 아직 없는 명령은 건너뛰지 않고 `not_yet` 으로 단언한다. 사례 종류마다 ts 파일이 하나씩 있다 — `cli`(E01~E07·E10~E12·E15) = `scripts/pes.ts`, `http`(E08·E09·E13) = `scripts/serve.ts`, `setup`(E14) = `scripts/setup.ts`. 셋 모두 같은 문(`compat_env.ts_gate`)으로 막혀 있어서, 파일이 하나라도 생기면 그 종류의 사례 실행이 throw 하고 `test_compat_harness` 가 실패한다(파일 존재와 `TS_IMPLEMENTED` 의 종류별 개수가 맞아야 한다). 그때 `compat_env`·`compat_cases` 에 ts 대상을 연결하고 `cases.json` 의 `ts.status` 와 시험의 `TS_IMPLEMENTED` 를 함께 고친다.

**`implemented` 의 뜻(`compat_cases.compare_ts_record`):** ts 기록이 py 와 같은 단언을 통과해야 한다 — `steps`(stdout·stderr 종류·exit)·상태 DTO·**산출 파일(`files`)** 전부 0.15 기준값과 같아야 한다. 의도된 차이는 각자 자기 단언을 가진다: D01 항목 id 는 값을 버리되 '있고 서로 다르다', D03 `processed` 는 버리되 '같은 길이의 목록', D06 은 구멍이 아니라 **값**(E03 항목 7 의 depth 는 0.15 의 3 이 아니라 2), D07 은 `snapshots/**` 를 이름으로 비교하지 않고 내용 해시가 하나도 빠지지 않았는지 본다(ts 기록기는 보관한 판을 `snapshots/**` 아래에 모은다). `files` 가 다르면 실패한다는 것은 기준값 사본을 가짜 ts 기록으로 주입한 시험(`test_compat_harness`)이 지킨다. PR26b 에서 ts 기록기를 만들 때 정규화 N4(순서)·N5(ID → `<ID:n>`)를 ts DTO·표 비교에 연결한다 — 지금은 두 쪽이 모두 Python 이라 `compat_normalize` 의 `n4_*`·`n5_ids` 가 단위 시험에서만 쓰인다.

**OS·PC 마다 남는 차이(E13~E15):** 기준값은 하나다(OS 별 기준값 파일 없음). 정규화로 지우거나(경로·줄바꿈·인코딩·플러그인 버전 문구), 비교에서 뺀다(외부 도구 상태, 포트 점유에 따른 서버 행), 임시 HOME 으로 돌린다(Windows `LOCALAPPDATA`·`APPDATA`). 무엇을 왜 그렇게 했는지는 `cases.json` 각 사례의 `os_notes` 와 `test_compat_harness` 가 지킨다. Windows 러너에서 처음 돌렸을 때 드러나는 차이는 같은 자리에 더한다.

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

공통 3겹: ① 자식 시작 전 `HOME`·`USERPROFILE`·`PES_HOME` 이 임시 폴더인지 검사(`assert_isolated_env`), ② 파일 전후 이름·크기·mtime 비교(`use_home_guard`, 깊이 3 — 읽기는 흔적이 없고 깊이 4 이하의 내용 수정은 상위 폴더 mtime 이 안 변하면 놓친다), ③ 출력·산출 파일에 보호 경로 문자열이 없는지(`assert_no_real_path` — 경로 **이름**이 아닌 프로젝트 이름만 새는 경우는 못 본다). 가드 자체는 합성 '가짜 실제 홈'(`PES_TEST_REAL_HOME`)으로 시험한다(`test_home_guard`): 자식이 그 아래를 **읽기만** 해도 실패한다.

경로 판정(`touches_protected`)은 보호 폴더처럼 보이는 경로를 철자만으로 결정한다(파일 시스템을 건드리지 않는다). 보호 폴더처럼 안 보이는 경로만 `realpath` 로 풀어 심볼릭 링크·junction 별칭을 본다. 스냅샷은 두 보호 폴더의 이름·크기·mtime 만 `lstat` 으로 읽고 내용은 열지 않는다.
