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
