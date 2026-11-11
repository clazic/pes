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
| `tests/helpers/compat_env.ts` | 이중 실행 하네스: 대상 `py`(`python -I -X utf8 scripts/pes.py`·`serve.py`·`setup.py`, `PES_DB_CORE` 없음) / `ts`(`scripts/pes.ts`, 아직 없음 → `not_yet`), 상태 DTO, 의도된 차이 표(D01~D09), `serve.py` 하네스 |
| `tests/helpers/compat_cases.ts` + `tests/fixtures/compat/cases.json` | E01~E15 사례 표와 실행기. 0.15 기준값은 `tests/fixtures/compat/baseline/E??.json` |
| `tests/helpers/home_guard.ts` | 실제 `~/.pes`·`~/pes-projects` 접근 0 — Python 감사 훅에 대응하는 TS 쪽 장치(임시 HOME·USERPROFILE·PES_HOME 강제, 전후 이름·크기·mtime 비교, 출력에 실경로 금지) |
| `tests/test_compat_harness.test.ts` | 정규화기·대상 선택·**미구현 목록이 표와 정확히 같다** |
| `tests/test_compat_cases_{a,b,c}.test.ts` | E01~E15를 0.15 대상에서 기준값과 대조 |

**대상 바꾸기:** `PES_COMPAT_TARGET=py`(기본) 또는 `ts`. `ts` 에서 아직 없는 명령은 건너뛰지 않고 `not_yet` 으로 단언한다. `scripts/pes.ts` 가 생기면 `test_compat_harness` 가 실패하므로, `compat_env.run_pes` 를 연결하고 `cases.json` 의 `ts.status` 와 시험의 `TS_IMPLEMENTED` 를 함께 고친다.

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

**옮기지 않은 것(Python 내부 계약, CLI 로 볼 수 없음):** `pes.CMDS` 를 monkeypatch 하는 `main` 분기·argv 불변 시험, `pes.pes_home()`/`pes.CONFIG` 속성 직접 확인, 감사 훅 자체의 단위 시험(→ `test_home_guard` 가 TS 가드를 같은 관점에서 시험). 이들은 PR26 에서 Python 과 함께 사라진다.
