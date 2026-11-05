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
