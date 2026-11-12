# PES 테스트

Node 26 이상이 필요하다 (Python 은 필요 없다 — SEL-74 로 0.15 Python 도구와 그 시험은 저장소에서 사라진다).

## 실행

**시험은 임시 HOME 에서 시작한다(SEL-103).** 실제 계정 홈(`os.userInfo().homedir`, `/Users/x`·`/home/x`·`C:\\Users\\x` 모양)에서 시작하면 홈 가드가 아무것도 훑기 전에 `--import` 진입점이 `임시 HOME 으로 실행하라`로 바로 실패시킨다.

macOS / Linux (POSIX):

```sh
npm ci
test_home="$(mktemp -d)"
HOME="$test_home" USERPROFILE="$test_home" npm test && npm run typecheck
```

Windows (PowerShell):

```powershell
npm ci
$env:HOME = $env:USERPROFILE = Join-Path $env:TEMP ("pes-test-" + [guid]::NewGuid())
npm test
npm run typecheck
```

## 격리

테스트는 `HOME`·`USERPROFILE`·`PES_HOME` 을 임시 폴더로 바꾸고, 자식(`node scripts/pes.ts`·`serve.ts`·`setup.ts`)은 `--permission` 허용 목록(실제 홈 없음)과 `ts_child_guard.ts` 가드 아래에서 돌린다. 실제 프로젝트·설정 파일은 읽거나 쓰지 않는다.

## 안전장치의 한계

격리의 1차 수단은 `HOME`·`USERPROFILE`·`PES_HOME` 을 임시 폴더로 바꾸는 것이고, `--permission` 허용 목록·가드·전후 스냅샷은 실수로 실제 `~/.pes`·`~/pes-projects` 에 닿는 회귀를 잡는 2차 안전망이다. 의도적인 우회는 막지 못한다 — 알려진 예: 심볼릭 링크 뒤 `..` 를 붙인 경로(`alias/../.pes`). 제품 코드(`scripts/*.ts`)는 이런 방식을 쓰지 않는다. 테스트에서 이런 API 를 쓰지 말 것.

## TypeScript 테스트 (Node 26)

```sh
npm ci && npm test && npm run typecheck
```

`npm test`는 `node --import ./tests/helpers/require_temp_home.ts --test "tests/**/*.test.ts"`로 돈다(진입점 설명: 아래 「실제 홈에서 시작 거절」). `tests/helpers/isolated_home.ts`가 임시 `HOME`·`USERPROFILE`·`PES_HOME`을 만들고, 시험은 그 env 객체를 경로 함수와 자식 프로세스에만 넘긴다. `process.env`는 바꾸지 않으며 실제 `~/.pes`·`~/pes-projects`를 열거나 stat 하지 않는다. 임시 폴더와 그 안의 DB 파일은 각 시험의 `cleanup()`이 지운다.

## 화면 시험 (PR18)

- `tests/test_web_*.test.ts` — `scripts/serve.ts`·`pes.ts` 를 자식 프로세스로 띄워 HTTP 로 본다(하니스 `tests/helpers/web_env.ts`, SEL-72 의 `TsServeProcess`). 0.15 가 같은 합성 자료로 렌더한 페이지 데이터는 고정 기록(`tests/fixtures/golden/web-v015-*.json`)과 의미로 비교한다. 픽셀 기준선은 없다.
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

## 0.15 동등성 하네스와 옛 Python 시험 자산의 TS 이전 (SEL-70, PR26a — SEL-74 로 Python 쪽은 사라지고 고정 기록만 남는다)

PR26의 첫 조각이다. 제품 코드는 바꾸지 않고, 0.15(Python)의 **현재 동작**을 TS 시험으로 고정하고 같은 입력을 두 대상에 넣어 견주는 도구를 만들었다. **SEL-74(5단계 시험 쪽)부터 Python 대상은 없다** — 기준값 `baseline/*.json` 이 0.15 의 고정 기록이고(`baseline.sha256.json` 이 불변을 지킨다), 하네스는 ts 만 돌려 그것과 견준다. 설계는 [migration-ts-equivalence.md](../docs/plan/migration-ts-equivalence.md) 7·8절.

| 파일 | 하는 일 |
|---|---|
| `tests/helpers/compat_normalize.ts` | 정규화 N1~N13(시각·경로·JSON·순서·ID·HTML·인코딩·콘솔·파일 메타·의도된 차이·콘솔 상대경로·stdlib 오류 페이지·OS 파일 없음 문구) |
| `tests/helpers/compat_env.ts` | 하네스: 대상은 `ts` 하나(`scripts/pes.ts`·`serve.ts`·`setup.ts` — `PES_COMPAT_TARGET=py` 는 거절), 상태 DTO(`project_state`), 의도된 차이 표(D01~D18) |
| `tests/helpers/compat_cases.ts` + `tests/fixtures/compat/cases.json` | E01~E15 사례 표와 실행기. 0.15 기준값은 `tests/fixtures/compat/baseline/E??.json` |
| `tests/helpers/home_guard.ts` | 실제 `~/.pes`·`~/pes-projects` 접근 0 — 아래 「home_guard 가 막는 것」 |
| `tests/test_compat_harness.test.ts` | 정규화기·대상 선택·**미구현 목록이 표와 정확히 같다** |
| `tests/test_compat_cases_{a,b,c}.test.ts` | E01~E15를 ts 에서 고정한 0.15 기준값과 대조 |
| `tests/test_compat_review.test.ts` | 최종 리뷰 1 반영: N6 요약이 제목 escape·공용 모듈 수를 보는지, N2 공백 경로(Windows 철자), 가짜 허브가 떠 있어도 E15 가 같고 접속 0, 상태 DTO 키 전수, `PES_TEST_GUARD` 를 끌 수 없음 |

**대상:** `ts` 하나다(`PES_COMPAT_TARGET=py` 는 거절). 아직 없는 명령은 건너뛰지 않고 `not_yet` 으로 단언한다. **래칫은 사례 단위다(SEL-71, PR26b):** `cases.json` 의 사례마다 `ts.status` 가 `implemented`/`not_yet` 이다. `not_yet` 사례는 `scripts/pes.ts` 가 있어도 **실행하지 않고** `not_yet` 으로 단언하고(`compat_cases.run_case`), `implemented` 사례는 0.15 기준값과 같아야 한다(`compare_ts_record`). 사례 종류마다 ts 파일이 하나씩 있다 — `cli` = `scripts/pes.ts`(PR26b 에서 연결됨), `http`(E08·E09·E13) = `scripts/serve.ts`, `setup`(E14) = `scripts/setup.ts`(SEL-72 에서 `compat_ts_srv.ts` 로 연결됨; `ts_gate` 는 세 종류 모두 파일이 없을 때 `not_yet` 만 알린다). **누가 어느 사례를 켜나**는 `tests/helpers/sel_scope.ts` 에 있다. SEL-71(a: pes.ts 골격 + 쓰기 명령, `status` 포함 — E04 가 쓴다) = `SEL71_DONE`: E01~E04·E10·X01~X05 가 `implemented`. SEL-77(b: 읽기·보고서) = `SEL77_DONE`: E05·E06·E07·E11·E12·X06·X07 은 지금 `not_yet`이고 SEL-77 이 한꺼번에 켠다(`sel77_on()`). E08·E09·E13·E14 는 SEL-72 `SEL72_DONE`(`tests/helpers/sel72_scope.ts`), E15(doctor)는 SEL-77 이후. E07 은 쓰기·읽기가 섞여서 E07 전체는 SEL-77 이 켜고, 쓰기 절반은 계약 사례 X05 로 SEL-71 이 맡는다. 사례 표는 둘이다: `cases.json`(7.4 의 E01~E15)과 `contract.json`(CLI 계약 X01~X07, 기준값 `baseline/X0n.json`).

**`implemented` 의 뜻(`compat_cases.compare_ts_record`):** ts 기록이 py 와 같은 단언을 통과해야 한다 — `steps`(stdout·stderr 종류·exit)·상태 DTO·**산출 파일(`files`)** 전부 0.15 기준값과 같아야 한다. 의도된 차이는 각자 자기 단언을 가진다: D01 항목 id 는 값을 버리되 '있고 서로 다르다', D03 `processed` 는 버리되 '같은 길이의 목록', D06 은 구멍이 아니라 **값**(E03 항목 7 의 depth 는 0.15 의 3 이 아니라 2), D07 은 `snapshots/**` 를 이름으로 비교하지 않고 내용 해시가 하나도 빠지지 않았는지 본다(ts 기록기는 보관한 판을 `snapshots/**` 아래에 모은다). `files` 가 다르면 실패한다는 것은 기준값 사본을 가짜 ts 기록으로 주입한 시험(`test_compat_harness`)이 지킨다. PR26b 에서 ts 기록기를 만들 때 정규화 N4(순서)·N5(ID → `<ID:n>`)를 ts DTO·표 비교에 연결한다 — 지금은 두 쪽이 모두 Python 이라 `compat_normalize` 의 `n4_*`·`n5_ids` 가 단위 시험에서만 쓰인다.

**OS·PC 마다 남는 차이(E05·E11·E13~E15):** 기준값은 macOS 에서 만든 하나다. Windows 러너(2026-11-11 SEL-70 PR #50)에서 드러난 차이는 두 종류로 나눈다. **(가) 표현 차이**는 비교 전에 정규화해서 지운다(아래 표). **(나) 0.15 가 Windows 에서 데이터 자체를 다르게 저장하거나 OS 별로 다르게 동작하는 것**은 정규화로 지우지 않는다 — `cases.json` 사례의 `os_overrides.win32` 가 그 OS 에서만 기준값의 해당 칸을 바꾼다(`compat_cases.baseline_for`; 없는 칸을 가리키면 던진다). `os_overrides` 는 두 종류다: **W1·W2(데이터 저장 차이)** 는 py 대상에만 적용하고 ts 는 적용하지 않는다(D10 — ts 는 어느 OS 에서나 `/`·LF), **W3(OS 별 설계 항목)** 는 `"applies_to_ts": true` 를 달아 py·ts 모두 적용한다(`ts_baseline`). 그대로 두면 Windows 에서 실행해도 통과하고, 값이 또 달라지면 여전히 실패한다. 외부 도구 상태·포트 점유 행은 비교에서 빼고, Windows `LOCALAPPDATA`·`APPDATA` 는 임시 HOME 으로 돌린다(`os_notes`).

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

**의도된 차이 추가:** `D13`(순서 없는 `approve`·승인된 단계의 `round-start` — 스킬은 승인을 순서대로 하고 승인된 단계는 reopen 뒤에 round-start 하므로 DB 보장을 CLI 호환 때문에 풀지 않는다: ts 는 exit 1 + 스택·영어 code 없는 한국어 한 줄. 사례 X08·X09 에 0.15 기준값(exit 0)과 ts 기대 문구(`KNOWN_DIFFS.D13.ts_steps`)를 둘 다 고정하고, 사례의 그 단계에는 `"d13": true` 를 단다. 거절된 단계는 ts 에서 아무것도 바꾸지 않으므로 끝 상태(DTO·파일)는 0.15 를 **그 단계 없이** 돌린 기록 `baseline.ts_end` 와 견준다 — py 대상이 `PES_COMPAT_UPDATE=1` 때 함께 만든다), `D10`(W1·W2 — ts 는 어느 OS 에서나 `/`·LF; 그래서 ts 는 W1·W2 의 `os_overrides.win32` 를 쓰지 않고(W3 는 `applies_to_ts` 라 씀) macOS/Linux 기준값과 같아야 하며(`ts_baseline`), 폴더에 CR·역슬래시 경로가 없어야 한다(`assert_posix_storage`)), `D11`(0.15 가 traceback 으로 죽는 단계 — ts 는 같은 exit 와 스택 추적 없는 한국어 한 줄; `fixable` 에 적은 단계만 성공해도 됨; PR26a 가 관찰한 3건: merge·ask 의 없는 파일, 깨진 project.json, `current` 없는 큰 프로젝트). 사용법 첫 줄의 실행 형식(`(0.15 의 python 실행 줄)` ↔ `node scripts/pes.ts`)은 `사용: <RUN> <` 로 정규화한다.

**의도된 차이 추가(SEL-77):** `D14`(DB 로 옮기지 않은 옛 0.15 폴더는 TS 에서 **읽기 전용** — TS 는 `project.json` 을 쓰지 않는다(D02). `status`·`digest`·`show`·`pending` 은 0.15 와 같게 읽고, `render`·`report`·`assemble`·`web` 같은 생성 명령은 exit 1 + 한국어 한 줄("이 프로젝트는 아직 새 형식으로 옮기지 않았습니다 — 먼저 이전하세요")로 거절하며 폴더의 바이트·mtime 을 바꾸지 않는다. 0.15 는 그 명령으로 바로 쓰므로 기준값 사례가 없고 `test_pes_ts_win_data` 의 D14 시험이 직접 고정한다). `E15` 는 `D02` 도 단다(TS 는 `project.json` 을 쓰지 않으므로 그 파일 해시는 비교에서 뺀다. 나머지 파일은 그대로 비교). `test_pes_ts_win_data` 의 "옛 데이터 → 새 쓰기" 는 옛 폴더를 **이전한 뒤**의 쓰기를 본다.

**의도된 차이 추가(SEL-74, leader 결정 2026-11-12):** `D15`(`pes.ts` 사용법에 0.15 에는 없는 7줄이 있다 — 에이전트용 DB 전용 5명령 `context`·`claim`·`submit`·`wait`·`complete` 와 `migrate <dir>`·`migrate --all`. 하네스는 그 7줄**만** 정확히 빼고(`compat_cases.strip_d15`, 줄마다 한 번씩) 나머지가 0.15 기준값과 한 글자까지 같은지 본다 — 다른 줄이 하나라도 다르거나 더해지면 실패한다. 사례 X01 과 `test_pes_ts_contract`(인자 없는 사용법·'D15' 시험)가 쓴다), `D16`(TS 서버의 `/whoami` 는 0.15 의 `{root, single}` 에 서버 프로세스의 `pid` 를 더한다 — `pes stop` 이 기록 파일의 pid 를 이 값과 대조한다. 하네스는 `pid` 가 양의 정수임을 단언하고 지운 뒤 나머지를 기준값과 견준다. 사례 E13 과 `test_pes_ts_read_serve` (b)). **의도된 차이 추가(SEL-74, leader 결정 2026-11-12):** `D17`(`pes watch` 는 DB 에도, `project.json` 폴더로도 없는 프로젝트를 거절한다 — exit 1, stdout 비움, 한국어 한 줄 `project.json 없음: <경로>`, 아무것도 만들지 않는다. 0.15 는 폴더가 있는지 보지 않고 `tail -n0 -F <경로>/feedback.log | grep --line-buffered FEEDBACK` 한 줄을 찍고 exit 0 이었다(Monitor 가 영영 오지 않는 파일을 기다린다). 있는 프로젝트(DB 의 것, 옮기지 않은 옛 폴더)의 출력은 0.15 와 그대로다. 0.15 기준값 사례에 없는 입력이라 `test_pes_ts_read_serve` 의 'D17' 시험 하나가 고정한다 — `test_compat_harness` 의 '사례마다 쓰이는가' 검사는 D14 처럼 D17 을 면제한다). **의도된 차이 추가(SEL-74, leader 결정 2026-11-12):** `D18`(홈 `/` 는 요청 때 DB 기준으로 짓는 허브다 — 0.15 는 `pes hub` 가 쓴 홈 index.html 파일을 냈다. DB 가 비어 옛 폴더뿐이어도 허브를 짓는다. 사례 E13 은 옛 폴더(`serve_legacy`, DB 미시드)로 0.15 정적 서빙을 견주되, `hub_paths: ["/"]` 단계는 상태·Content-Type·Cache-Control 이 기준값과 같고 본문이 허브(제목 `PES 프로젝트`·`synthetic` 나열)임을 단언한 뒤에만 기준 본문을 받아들인다).

**SEL-77 1차 리뷰(R1) 시험 — `test_pes_ts_r1_review.test.ts`:** (1) pid 안전: `tests/helpers/ts_inject_kill.ts` 가 자식의 `process.kill` 을 기록기로 바꾼다(실제 신호 0건, 신호 0 은 통과) — `.pes-hub-server`·`.pes-server` 의 pid 가 null·0·-1·1·문자열·실수·너무 큰 수·없음이면 `stop`·`doctor --fix` 가 신호를 시도하지 않아야 하고(안전한 정수 > 1 만), `/whoami` 가 PES 홈 밖 root 를 답하는 가짜 예전 서버(8765~8775 중 첫 빈 포트, `allow_hub_port` 로 그 하나만 허용)는 건드리지 않는다(홈 안 root 는 대조로 SIGTERM 1번). (2) 의도된 차이: project.json 의 `NaN`·`Infinity` 는 한국어 한 줄 "지원하지 않는 값"(exit 1, 폴더 불변), **BOM 으로 시작하는 project.json 은 TS 가 읽는다**(0.15 는 JSONDecodeError — 관용, 같은 파일의 BOM 없는 쪽과 출력이 같음), `current` 가 없거나 단계 이름이 아니면 한 줄 오류(D11). (3) `doctor` exit 계약: 사용자가 쓰는 0.15 경로(`PES_DB_CORE` 없음)에서 텍스트 모드는 `bad` 행이 있으면 1, **`--json` 은 `bad` 여도 0** — TS 도 같다(py 기준값과 같음 + 직접 단언). (4) 깨진 project.json 에서 `serve`(exit 1·한 줄)·`open`(0, 파일 주소)·`list`(0, `[오류]`·`서버 꺼짐`)·`watch`(0)·`hub`(0)·`doctor` 의 exit 를 0.15 와 같게 고정, 폴더 불변. (5) `watch` 의 로그 경로는 `join(d, "feedback.log")` 한 가지 구분자 — 0.15 는 `f'{d}/feedback.log'` 라 Windows 에서 `\` 와 `/` 가 섞이므로 비교 때 py 줄만 win32 에서 `\feedback.log` 로 맞춘다(os_overrides 와 같은 장치).

**SEL-75 행렬(ts):** `test_pes_ts_set_lock` — 0.15 의 `test_cli_set_lock_windows` 와 같은 시나리오 21개를 Node 쪽 주입으로. Windows 흉내(`nt`)는 오류를 다루는 동안만 `process.platform` 이 `win32` 로 읽히게 한다. 해석: ts `set` 도 0.15 의 짧은 쓰기 잠금 `<프로젝트 폴더>/.project.json.lock`(배타 생성, 60초 넘으면 묵은 것, 30초 기다림, 마감 뒤 exit 3 "다른 set", 잠금 없는 PermissionError 는 비 Windows 에서 즉시 exit 2 "권한")을 쓴다.

### 옛 Python 시험 → TS 대응 (SEL-74: Python 시험은 지워졌다)

| 옛 Python 시험 | TS | 비고 |
|---|---|---|
| `conftest.py` | `helpers/home_guard.ts`·`compat_env.ts`(`make_ctx`·`synthetic_project`·`run_pes`)·`ts_child_guard.ts` | 감사 훅 → 3겹 가드 + ts 자식 가드(`test_pes_ts_guard`) |
| `test_project_basic.py` | `test_cli_compat`·`test_state_load`·`test_home_guard` | |
| `test_questions.py` | `test_questions_html` | |
| `test_serve.py` | `test_serve_ts_feedback`·`test_serve_ts_cases`·`test_serve_ts_static` (옛 `test_feedback_http`·`test_feedback_collision` 는 지웠다) | |
| `test_state.py` | `test_state_transitions`·`test_reports_compat`·`test_restore_compat` | xfail(depth, D06)는 '0.15 결함 고정' 단언 |
| `test_lock.py` | `test_lock_compat` (DB lease 로) | TTL 경계는 lease 행 + `ts_age_lease` |

**옮기지 않은 것(Python 내부 계약, CLI 로 볼 수 없음):** `pes.CMDS` 를 monkeypatch 하는 `main` 분기·argv 불변 시험, `pes.pes_home()`/`pes.CONFIG` 속성 직접 확인, 감사 훅 자체의 단위 시험(→ `test_home_guard`·`test_pes_ts_guard` 가 TS 가드를 같은 관점에서 시험), `test_start_failure_terminates_child_and_closes_log` 의 '로그 파일 핸들이 닫힘' 단언. 이들은 Python 과 함께 사라졌다.

### 실제 홈에서 시작 거절 (SEL-103)

`HOME`·`USERPROFILE` 이 계정의 실제 홈이면(`os.userInfo().homedir`·`/Users/x`·`/home/x`·`/root`·`C:\\Users\\x` 모양·그 부모·그 안의 `.pes`·`pes-projects`·`.claude`) 시험 파일 프로세스는 시작하자마자 던진다. 비교는 **문자열뿐**(`tests/helpers/temp_home_check.ts`) — 실제 홈 경로에 lstat·readdir·realpath 를 부르지 않는다. 자리는 둘이다: ① `--import ./tests/helpers/require_temp_home.ts`(`npm test`·CI 시험 단계·d1-smoke), ② `home_guard.ts` 의 첫 import(진입점 없이 `node --test 파일.ts` 로 직접 돌려도 스냅샷 전에 막힌다). 가짜 계정 홈은 `PES_TEST_ACCOUNT_HOME`(`path.delimiter` 로 여럿)으로 주입한다 — 거절할 홈을 **더할 뿐** 거절된 홈을 허용으로 바꾸지 못한다. `test_sel103_real_home_precheck` 가 `tests/helpers/fs_path_recorder.ts`(`--import`)로 그 폴더에 fs 호출이 0 번임을 단언하고(대조: 주입 없이 돌리면 lstat 이 기록됨), `package.json`·`ci.yml` 이 진입점을 거치는지 본다. 한계: 임시 폴더가 실제 홈의 심볼릭 링크인 경우는 철자로 못 본다(뒤 겹이 맡는다).

### home_guard 가 막는 것

"실제 `~/.pes`·`~/pes-projects` 접근 0" 을 자식 종류별로 이렇게 지킨다. 실제 홈은 `os.homedir()`(= `$HOME`을 따라감)와 `os.userInfo().homedir`(계정의 홈) **둘 다**다 — 임시 HOME 으로 `npm test` 를 돌려도 계정의 실제 홈을 본다.

| 자식 | 읽기 | 쓰기·생성·삭제 | 출력에 실경로 |
|---|---|---|---|
| TS(`scripts/pes.ts`) | **막는다 (SEL-71)** — `--permission` 허용 목록에 실제 홈이 없고, `--import` 로 도는 `ts_child_guard.ts` 가 `PESHomeAccessViolation` 을 보고한다 (위 「pes.ts — TS 진입점 시험」). `serve.ts`·`setup.ts` 는 아직 대상이 없다 | 같은 가드 + 전후 스냅샷 | 검사 |

**훅이 보지 못하는 것(그래서 따로 막거나 아직 못 막는다):**

- **HTTP 접속.** 감사 훅은 파일 접근만 본다. `doctor` 등은 포트 8760~8775 의 `/whoami` 로 실제 허브의 루트를 읽을 수 있다. 그래서 **저장소 시험이 띄우는 모든 자식**(`pes.py`·`serve.py`·`setup.py`)이 허브 차단(`tests/helpers/hub_block.ts`)을 받는다: `urlopen` 은 URLError, `socket.connect` 는 ConnectionRefusedError, `connect_ex` 는 111 — 8760~8775 어느 포트에서나. 범위: `compat_env`(`guarded_script_argv`), `cli_read_env`·`cli_write_env`·`web_env`, e2e `workspace`, 자식을 직접 띄우는 시험 파일은 `hub_blocked_argv([...python 인자])` 로 감싼다. Python 시험 쪽은 `tests/conftest.py` 의 `no_real_hub`(자동, 프로세스 안)과 `HUB_BLOCK`(`cli` 픽스처·`test_serve` 의 sitecustomize). 새 자식을 띄우는 도우미는 반드시 이 감싸기를 쓴다. 허브를 일부러 쓰는 시험만 `allow_hub_port: <포트>` 로 **그 포트 하나**만 연다(나머지는 계속 막힘). 막힌 시도는 "서버 없음"으로 보일 뿐 시험을 실패시키지는 않는다(`doctor` 는 원래 그 포트를 두드린다) — 실제 허브가 받는 요청 수가 0 인지는 `test_compat_review`·`test_compat_harness` 의 가짜 허브와 아래 8760 재현으로 확인한다.
- **N2 한계.** 정규화(`n2_paths`)는 공백이 두 개 이상인 폴더 이름(`a b c\\x.json`, Windows 역슬래시)을 첫 단어 뒤에서 끊는다. 기준값·fixture 에 그런 폴더 이름을 넣지 않는다(`test_compat_review` 가 이 한계를 단언한다).
- **`sqlite3.connect`.** 감사 이벤트가 있지만(파이썬 3.10+) `GUARD` 에 넣지 않았다. 0.15 는 sqlite 를 쓰지 않는다.
- **`os.access`·`chmod`·`utime`·`truncate`** 등 일부 호출, **ctypes 로 직접 부르는 `open(2)`** (0.15 코드에 ctypes 는 없다).
- **손자 프로세스.** 예: `doctor` 의 `find_tool` 이 PATH 밖(`/opt/homebrew/bin` 등)의 vworld·kosis 를 띄운다. 자식 안 훅은 손자에게 이어지지 않는다. HOME 은 임시 폴더로 격리되어 있고, 시험은 `narrow_path`·임시 `LOCALAPPDATA` 로 도구를 좁힌다.
- **`PES_TEST_GUARD`.** 사례·옵션의 `env` 가 이 값을 바꾸지 못한다(`child_env` 가 합친 뒤 `"1"` 을 단언; 가드 자기 시험은 `PES_TEST_REAL_HOME` 만 바꾼다).

공통 3겹: ① 자식 시작 전 `HOME`·`USERPROFILE`·`PES_HOME` 이 임시 폴더인지 검사(`assert_isolated_env`), ② 파일 전후 이름·크기·mtime 비교(`use_home_guard`, 깊이 3 — 읽기는 흔적이 없고 깊이 4 이하의 내용 수정은 상위 폴더 mtime 이 안 변하면 놓친다), ③ 출력·산출 파일에 보호 경로 문자열이 없는지(`assert_no_real_path` — 경로 **이름**이 아닌 프로젝트 이름만 새는 경우는 못 본다). 가드 자체는 합성 '가짜 실제 홈'(`PES_TEST_REAL_HOME`)으로 시험한다(`test_home_guard`): 자식이 그 아래를 **읽기만** 해도 실패한다.

경로 판정(`touches_protected`)은 보호 폴더처럼 보이는 경로를 철자만으로 결정한다(파일 시스템을 건드리지 않는다). 보호 폴더처럼 안 보이는 경로만 `realpath` 로 풀어 심볼릭 링크·junction 별칭을 본다. 스냅샷은 두 보호 폴더의 이름·크기·mtime 만 `lstat` 으로 읽고 내용은 열지 않는다.

**④ 시험 프로세스 자신의 fs 호출 (SEL-95·SEL-103, `guard_process_fs`·`use_home_guard`).** 실제 홈(`os.homedir()`·계정 홈)의 `.pes`·`pes-projects`·`.claude` 안쪽 경로를 받는 `node:fs` 호출은 동기·콜백·`promises` 모두 `PESHomeAccessViolation: <함수> <경로>` 로 던지고(또는 reject) 기록하며, 시험이 그 오류를 삼켜도 파일 끝에서 실패한다. 막는 것: stat·read·readdir·open·write·rm·rename·copy·symlink 류 전부 + `realpath`(+`.native`)·`statfs`·`glob`(`cwd` 와 패턴 철자)·`mkdtemp`(접두 경로)·`chown`·`lchown`·`lutimes`·`lchmod`·`watch`·`watchFile`·`openAsBlob`. `use_home_guard(real_home?)` 는 가짜 '실제 홈'(폴더 하나 또는 배열)을 받아 가드를 그 아래에서 시험할 수 있다 — 실제 홈은 어떤 시험도 건드리지 않는다.

- **순서.** 가드 해제와 마지막 스냅샷은 파일이 `use_home_guard()` *뒤에* 등록한 모든 `after` 훅보다 나중에 돈다(파일 로딩이 끝난 마이크로태스크에서 `after` 를 등록한다). 정리 훅의 보호 경로 접근도 잡힌다. 한계: 최상위 `await` 뒤나 시험 도중에 등록한 `after` 는 그보다 늦을 수 있다. 훅이 던지면 러너가 남은 `after` 를 건너뛰므로 프로세스 종료 때 한 번 더 마무리하고 종료 코드를 1 로 둔다(맨 `node 파일.ts` 실행은 루트 `after` 실패를 종료 코드에 반영하지 않는다).
- **이름 판정.** `..cache` 처럼 점 두 개로 *시작하는* 이름은 보통 하위 이름이다. `..` 자신(또는 `../`)만 폴더를 벗어난다. 자식 가드(`helpers/ts_child_guard.ts`)도 같은 규칙이다(`<홈>/.pes/..cache/x` 는 막고 `<홈>/.pes/../other` 는 통과 — `test_sel103_home_guard_gaps` C1).
- **가드 내부 판정.** `touches_protected`·`assert_isolated_env`·스냅샷은 가드가 켜져 있어도 동작한다 — 모듈 로드 때 잡아 둔 래핑 전 원본 `realpathSync.native` 를 쓴다.
- **일부러 막지 않는 것(한계).** ① 파일 디스크립터 호출(`fstatSync(fd)`·`readSync(fd)` …) — fd 는 경로 호출로 열렸고 그 호출이 가드를 지났다. ② 보호 폴더 *밖* 철자의 심볼릭 링크·junction 별칭 — fs 가드는 철자만 보며(호출마다 realpath 하지 않는다), 별칭은 `touches_protected`·자식 가드·② 전후 스냅샷의 몫이다. ③ 보호 폴더의 상위(홈)에서 와일드카드가 안으로 펼쳐지는 `glob`(`globSync("*/x", { cwd: 홈 })`) — `cwd` 와 패턴 철자만 본다. `*` 뿐 아니라 `{.pes,x}/*`·`.p*`·`[.]pes`·`?` 처럼 패턴 문자(`{}`·`[]`·`?`·`*`)가 철자 밖에서 보호 폴더로 펼쳐지는 경우도 같다. ④ 자식 프로세스, `node:sqlite` 의 `new DatabaseSync(경로)`, 네이티브 애드온, `process.binding`. 시험에서 이런 경로로 실제 홈을 열지 않는다.

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

**의도된 차이:** D03(답은 DB 제출 — 하네스가 DB 에서 읽어 `feedback/<이름>` 파일 해시와 `feedback.log` 줄을 0.15 철자로 바꿔 견준다; 응답의 `v` 는 정수인지 확인하고 뺀다; DB 가 붙이는 `id`·`set_id` 는 해시 전에 뺀다), D09(정적 서빙은 그대로라 차이 없음), **D12 신설**(setup: `check` 에 `python` 행이 없고 사용법 첫 줄이 `사용: (0.15 의 python 실행 줄)` 가 아니라 `사용: node scripts/setup.ts <명령>` — `adapt_ts_setup_stdout` 이 두 사실을 먼저 단언한 뒤 0.15 철자로 되돌려 한 번에 견준다).

**시험하지 않는 것(외부 호출·브라우저):** `install kosis|vworld|ego-browser`(curl | sh·앱 내려받기·브라우저 열기), `install missing`/이름 없는 `install`, `upgrade kosis|vworld|ego-browser|all`, `--no-open` 없는 `keys`, 키 화면의 3시간 시간 제한(`SETUP keys timeout`), 기본 포트 8759·허브 포트 8760~8775 에 실제로 묶는 일.

**새 환경 변수 `PES_KEYS_PORT`:** API 키 화면의 포트(기본 8759). 시험이 빈 포트를 주입한다. 유효하지 않으면(정수 1~65535 아님) 종료 코드 2 와 변수 이름이 든 한 줄 메시지.

**구현 선택으로 고정한 것(0.15 와 다르거나 0.15 가 정하지 않은 것):** DB 에 없는 폴더(project.json 만 있음)의 `POST /<slug>/feedback` 은 404 `{"ok":false}`(0.15 는 파일에 썼다 — D02: project.json 은 읽기 전용); `serve.ts` 의 잘못된 포트·인자는 스택 추적 없이 종료 코드 2, 이미 쓰는 포트는 1.

## 전환 시험 (SEL-74, PR26e) — 스킬·설치를 TS 로, Python 제거

**시험이 먼저 써졌다.** 아래 시험은 `scripts/`·`skills/`·`commands/`·`agents/`·CI 가 바뀌기 전에는 실패한다(그게 구현이 맞춰야 할 정답). 병합하면 사용자의 실제 `/pes:*` 가 TS 로 바뀌므로 병합 시점은 사용자에게 다시 확인한다.

| 영역 | 파일 | 고정하는 것 |
|---|---|---|
| A 호출 전환 | `test_sel74_a_skill_calls` | `skills/`·`commands/`·`agents/`·`docs/adapters/` 에 Python 호출·`.py` 이름 0, README·AGENTS·CLAUDE 에 Python 호출 줄 0, 실행 명령은 `node …/scripts/pes.ts`·`setup.ts`, `lint_skills` 규칙 `[Python 호출]`, D14 흐름(거절 → 사용자에게 묻기 → `migrate`) 문서 단언 |
| B DB 전용 5개 | `test_sel74_b_db_commands` | `pes.ts` 의 `context`·`claim`·`submit`·`wait`·`complete`: 0.15 `pes.py`(PES_DB_CORE 경로)와 같은 인자·한 줄 JSON·종료 코드, 플래그 없이 동작 |
| C 0.15 폴더 열기 | `test_sel74_c_d14_refusal`·`test_sel74_c_migrate`·`test_sel74_c_doctor_hub` | 안 옮긴 폴더에 쓰기 → exit 1 + `먼저 이전하세요 — pes migrate …` 한 줄(바이트·mtime 불변), `pes migrate <폴더>`·`--all`(백업 묶음 → 검증 → 활성화, 원본 불변, 실패 시 활성화 없음, 두 번째는 `이미 이전됨` exit 0), doctor `이전 필요` 행(고칠 수 없음) |
| D 설치·업그레이드 | `test_sel74_d_install_static`·`test_sel74_d_ci_install`·`test_sel74_d_install_run` | 설치 스크립트 Python 0·Node 26 확인·시험용 이음매(`PES_INSTALL_MIRROR`·`PES_INSTALL_PATH_ONLY`·`PES_SKIP_TOOLS`), CI 설치·업그레이드 잡(Windows·macOS), 임시 HOME 에서 스크립트를 실제로 돌림(sh 는 macOS/Linux, ps1 은 Windows 에서만 — 다른 OS 는 이유를 밝히고 skip) |
| E Python 제거 | `test_sel74_e_python_removed` | `*.py`·옛 Python 시험·requirements 삭제, 시험이 Python 을 부르지 않음, 하네스는 고정 기준값(`fixtures/compat/baseline/*.json`, `baseline.sha256.json` 으로 불변 확인)만으로 ts 를 비교, CI 에 Python 0 |
| F 실제 홈 보호 | `test_sel74_f_real_home` | 새 시험 전부 임시 HOME·USERPROFILE·PES_HOME + 가드 + 전후 스냅샷(설치 시험은 `~/.claude` 포함) |
| G SEL-77 권장 3건 | `test_sel74_g_server_safety`·`test_sel74_g2_hung_server` | `/whoami` 의 pid 와 기록 pid 대조(다르면 kill 0), 20초 무응답 서버 자식 종료, 시험 자식 env 에서 `PES_HUB_PORTS` 비움 |
| H 버전 불변 | `test_sel74_h_version` | `plugin.json` 0.15.6·`package.json` 0.0.0 그대로 |
| 최종 리뷰 1 반영 | `test_sel74_final1` | 빈(0 바이트)·옛 스키마·PES 가 만들지 않은 `pes.db` 에서도 0.15 폴더 읽기(status·pending·digest·list·hub)가 되고 doctor 가 할 일을 말함(`--fix` 는 0 바이트 파일만 치움, migrate 는 최신으로 올리거나 남의 파일을 한 줄로 거절), 숨김 소유자 프로젝트가 doctor·`--fix`·status·list·hub 에 0, '다른 PES 사용 중' 탐지가 파일을 바꾸지 않음(Windows 방식 포함 — 쓰기·이름 바꾸기 사건 0), Node 26 미만이면 pes.ts·setup.ts·serve.ts 가 한국어 한 줄 exit 1, 끄지 못한 옛 서버는 `stop` 이 `서버 종료` 대신 `서버를 끄지 못했습니다` 와 끄는 방법(exit 0 은 0.15 그대로), DB 없는 홈에 자격 없는 `/api/v1` 은 401 이고 DB 를 만들지 않음 |

공용 도우미 `helpers/sel74_env.ts`(임시 홈 실행·옛 폴더 만들기·바이트/mtime 지문·백업 묶음 찾기·DB 읽기). `ts_run(c, args, extra)` 는 `make_cli_env()` 의 DB 프로젝트에 대해 `pes.ts` 를 돌린다(`c.run` 이 `pes.py` 를 돌리던 자리 — 플래그 없음). `PES_TOKEN` 은 호출마다 `extra` 로만 넣는다.

## SEL-74 5단계 (시험 쪽) — 0.15(Python)를 부르던 시험의 처리표

Python 파일(`scripts/*.py`·`check_ddl.py`·옛 Python 시험·`tests/conftest.py`·`requirements-dev.txt`)이 저장소에서 지워져도 `npm test` 가 도는 것이 목표다 — **이 PR 은 Python 파일 자체를 지우지 않는다**(worker 몫). 지운 뒤 남는 실패는 `test_sel74_e` 의 E1·E2·E3(제품 쪽 `ci.yml`·`lint_skills.ts`·`cli_usage.ts` 주석)·E8·E10(AGENTS.md)뿐이어야 한다. 분류는 셋이다.

- **(i) 동일성만 보던 단언**: 0.15 와 ts 가 같은지만 보던 것 → 0.15 쪽 실행을 지우고 고정 기준값이 같은 것을 고정한다(`fixtures/compat/baseline/*.json`·`contract.json`). 기준값에 없던 입력은 0.15 를 마지막으로 돌려 **새 고정 기록**을 만들었다(`fixtures/golden/`·`fixtures/legacy_reports/` — 각각의 README). 다시 만들 수는 없다(0.15 코드 삭제) — 고쳐야 하면 손으로 고친다.
- **(ii) 0.15 동작 자체를 고정하던 단언**: 같은 단언을 `node scripts/pes.ts`·`serve.ts`·`setup.ts` 로 옮겼다. 0.15 가 `project.json`·`.pes-lock` 파일에 남기던 것은 DB 읽기 모델(`project_state`·`ts_view`)·lease(`ts_age_lease`)로 읽는다.
- **(iii) Python 전용**: ts 에 대응이 없어 지웠다 — 지켜 주던 곳을 아래에 적었다.

### 공용 도우미 (10개 + 정리)

| 도우미 | 처리 |
|---|---|
| `cli_write_env.ts` | (ii) `c.run` 이 `ts_run`(pes.ts)을 돈다. `PES_PY`·플래그 삭제 |
| `cli_read_env.ts` | (ii) `run_py` → `run_cli`(+`run_cli_async`). `baseline_dir`(git 으로 0.15 꺼내기)·`PY`·`OFF`·`flag`·`script(py)` 삭제. 신설: `golden`·`expect_same_as_015`·`legacy_home_with_real_report`·`overlay_real_report` |
| `compat_env.ts` | `py` 대상·`PYTHON`·`guarded_script_argv`·`run_py_code`·`ServeProcess` 삭제, `Target = "ts"`, `pes()`·`pes_as()`·`run_pes`·`run_setup` 이 ts. 신설: `project_state`, `KNOWN_DIFFS` D15·D16 |
| `compat_cases.ts` | py 대상·`write_baseline`·`PES_COMPAT_*` 갱신 모드·`py_lock`·`py_answers` 삭제. 신설: `strip_d15`·E13 `/whoami` pid(D16) |
| `ddl_check_env.ts` | (i) Python 검사기 실행 삭제 → 0.15 가 낸 줄을 `PY_REFERENCE_LINES` 로 고정 |
| `set_env.ts` | (ii) ts; `state()` = DB 읽기 모델, `lock_owner()`·`age_lock()` 신설 |
| `skill_docs.ts` | (ii) `PES_PY` → `PES_USAGE`(`cli_usage.ts`) |
| `state_modes.ts` | (ii) `flag` 삭제 (`off`/`on` 둘 다 ts) |
| `web_env.ts` | (ii) `serve.py` → `TsServeProcess`(serve.ts). `build_old`·`WEB_BASELINE_REF`·`flag` 삭제. 신설: `hub_page_data` |
| `e2e/helpers/workspace.ts`·`seed_workspace.ts` | (ii) `node serve.ts`·`pes.ts`; `PES_E2E_V015` 삭제 |
| `hub_block.ts` | Python 허브 차단 코드 삭제(포트 상수만 남김; ts 자식은 `ts_child_guard.ts`) |
| `compat_inject.ts` | 삭제 (Python `sitecustomize` 조각) |

### 시험 파일

(i)=고정 기준값/기록, (ii)=ts 로 이식, (iii)=지움. 한 파일에 여러 분류가 섞일 수 있다.

| 파일 | 처리 |
|---|---|
| `test_cli_compat` | (ii) 상태는 `project_state`; (iii) 1개 지움(`PES_PY` 가 0.15 파일) |
| `test_cli_read_final1`·`review1`·`validate` | (ii) + (i) 0.15 가 만든 보고서를 `fixtures/legacy_reports/` 에 고정(8폴더); (iii) review1 R6 의 'v0.15 `--fix` 가 임시 파일을 지운다'(→ D14: 옛 폴더는 `--fix` 도 쓰지 않는다) |
| `test_cli_read_final2` | (ii) |
| `test_cli_read_doctor` | (ii); (iii) '플래그 없는 v0.15 `--fix`' 블록 |
| `test_cli_read_hardening` | (ii) + (i) H1·H2 를 `golden/h1-full-reads`·`h2-rich-report` 로; H5 의 '플래그 있음/없음 같은 출력' 비교는 (iii) |
| `test_cli_read_report` | (ii) — 계약 변경 반영: ts 는 출력에 버전·blob id 를 보이지 않고 폴더에도 같은 파일을 둔다(D02) |
| `test_cli_read_v015` | (i) A1 → `golden/rich-legacy-reads`(읽기 12개), 'DB 읽기 = v0.15' → `golden/seeded-plain-reads`; (iii) A2(`PES_DB_CORE` 값)·'legacy 읽기' 별도 시험(A1 로 합침); (ii) 나머지 |
| `test_cli_set_db_flag`·`_hardening`·`_accept`·`_reject`·`_report` | (ii); hardening 에서 (iii) '깨진 project.json 이면 거부'(ts 는 project.json 을 읽지 않음) |
| `test_cli_set_lock_windows` | (iii) 파일 삭제 — 같은 행렬이 `test_pes_ts_set_lock`(기존 시험 + 이번에 7개 추가: 읽기 전용 폴더, 30초 마감, 영영 EPERM, stat·unlink 영영 실패, 60초 규칙, 마감 직전 풀림, 주입 동시 실행) |
| `test_cli_write` | (ii); (iii) 플래그 시험 3개 → `test_pes_ts_guard` 의 'PES_DB_CORE 는 자식에게 안 간다'; `approve` 두 시험은 계약 변경 반영 |
| `test_cli_write_hardening` | (ii); (iii) A1·A2·A3(0.15 나란히·플래그)·C1~C3(node 브리지 고장) |
| `test_cli_write_regress`·`_final1` | (ii) |
| `test_cli_write_stdout_encoding` | (ii) cp1252·C 로케일에도 UTF-8; (iii) v0.15 경로 |
| `test_compat_cases_{a,b,c}` | (ii) ts 에서 기준값과 대조; `_x` 파일은 (i) 삭제 — X01~X11 은 `test_pes_ts_contract` 가 ts 로 돈다 |
| `test_compat_harness`·`_review` | (ii) 대상 선택(`py` 거절 포함)·E15 가짜 허브·DTO 키(0.15 키 목록을 고정 값으로); (iii) `hub_blocked_argv` 시험 |
| `test_ddl_check_equivalence` | (i) |
| `test_home_guard` | (ii) 8개; (iii) Python 감사 훅 시험 4개 → `test_pes_ts_guard`·`test_serve_ts_guard` |
| `test_lock_compat` | (ii) 파일 잠금 → DB lease; TTL 경계는 lease 행 ± 30초 |
| `test_pes_ts_contract` | (i) 사용법·명령 38개 이름을 고정 값으로; D15 시험 신설 |
| `test_skill_docs_usage`·`_set_docs`·`_pilot_run`·`_pilot_state`·`_state_docs` | (ii); `_state_docs` 에서 (iii) '플래그 없는 context 는 거절' |
| `test_state_final1_regress`·`r1_2`·`r1_3` | (ii); r1_2 의 '손으로 고친 project.json 의 null user_links'는 (iii) → `test_legacy_import_final1`·`r1` |
| `test_state_load`·`_transitions`·`_settings_changes`·`test_reports_compat`·`test_restore_compat`·`test_questions_html` | (ii); `project.json` 손편집 준비는 명령(`set`)·가져오기로 대체 |
| `test_pes_ts_win_data`·`_devices`·`_final1_77`·`_final1`·`_read_serve` | (ii)/(i): Python 으로 만들던 0.15 프로젝트는 손으로 쓴 0.15 폴더·`full` 픽스처, 0.15 출력은 `golden/`; `_final1` 시험 1개 (iii); read_serve (b) 는 D16 |
| `test_web_parity`·`_screens`·`_server`·`_review1`·`_r1_3`·`_final1`·`_hardening_*` | (ii) + (i) `golden/web-v015-*`; 지웠던 서버 시험은 **되살렸다**(아래 '서버 갭'); 플래그 시험 H8a·H8b 는 ts 로 번역 |
| `test_feedback_http`·`test_feedback_collision` | (iii) 파일 삭제 → `test_serve_ts_feedback`(Origin·크기·순서·재시작·40개 동시)·`test_serve_ts_cases` E13 |
| `test_web_n1_reports` | 되살림 — 83bc0b3 그대로 (서버 갭 S4) |
| e2e `workspace_*.spec.ts` | 도우미만 ts 로. 아래 '서버 갭' |

### 새로 더한 시험 (3번 — migrate 보강)

`test_sel74_c_migrate_staging`: 검증이 실패한 뒤(M1) staging 프로젝트가 DB 에 남아도 정상 프로젝트로 보이지 않는다 — `list` 에는 `이전하세요` 오류 줄뿐, `status` 는 한 줄 거절, 홈 화면에 정상 줄 없음(M2); 또 실패해도 staging 행은 하나(M3); 원인을 고친 뒤 다시 `migrate` 하면 성공하고 그 슬러그 프로젝트는 하나·active, `list` 에 정상 줄, 세 번째는 `이미 이전됨`(M4); 빈 DB 에서 만들어지는 숨김 소유자 프로젝트 `pes-local-owner` 는 `list`·홈 화면에 나오지 않는다(M5). 최종 리뷰 1 뒤로는 `doctor`·`doctor --fix`·`status` 에도 나오지 않는다 — bridge 의 `active_slugs`·`route` 한 곳에서 거른다(`test_sel74_final1` 필수 2).

### ts 구현 갭 — 이식했지만 지금 실패하는 시험 (worker 가 맞추거나, 포기하면 leader 가 시험을 지우라고 결정)

0.15(또는 PR15~18 의 DB 경로)가 지키던 보장인데 현재 ts 가 다르다. 시험은 그대로 두었다(단언을 약화하지 않았다).

| 갭 | 시험 | 지금 ts |
|---|---|---|
| G1 doctor '데이터베이스' 행 | `test_cli_read_final2` F1b×2·F1c, `test_cli_read_doctor` 'DB 프로젝트…' | 정상 행이 없다; 비정상 종료로 남은 `-wal`/`-journal` 이면 '복구 필요' 행 대신 DB 를 연다(8.13 doctor 규칙) |
| G2 doctor 경로 quoting | `test_cli_read_doctor` '공백·따옴표·괄호' | PES 홈 경로 경고 행이 없다 |
| G3 깨진 DB 파일 | `test_cli_read_doctor` '깨진 DB' | `doctor` 가 `예상하지 못한 오류 … file is not a database` 로 죽는다(JSON·'데이터베이스' bad 행 없음) |
| G5 홈 밖 폴더 | `test_cli_read_hardening` H6 | 절대 경로가 DB 슬러그(폴더 이름)와 같으면 홈 밖 폴더의 `project.json` 이 아니라 DB 프로젝트를 읽는다 |
| G6 staging 프로젝트 읽기 | `test_cli_read_hardening` H1·H1b, `test_cli_read_v015` 'pending…' | `status` 가 '`이전이 끝나지 않은 프로젝트입니다 … project.json 으로 읽습니다`' 를 말하면서 exit 1·출력 없음; `list` 는 주제 없는 오류 줄. (PR16 해석 1: staging·failed·archived 는 옛 `project.json` 을 읽는다) |
| G7 `set changes` 이월 | `test_state_transitions` 'round-start increments…', `test_state_settings_changes` 'round-start 는 이전 라운드 changes…', `test_cli_set_report` 'set changes…' | 다음 `round-start` 가 `changes` 를 비우지도 `history` 로 옮기지도 않는다 |
| G8 `set review` → qa-brief | `test_cli_set_report` 'set review…' | `qa-brief` 가 `rounds/<단계>-R<n>/self-review.json` 을 만들지 않는다 |
| G9 짝 없는 서로게이트 | `test_cli_set_hardening` '\ud800' | `set settings` 가 받아들인다(0.15 는 UTF-8 로 못 써서 거부) |
| G10 두 번째 `approve` | `test_cli_write` '두 번째 approve 로 승인 기록이 쌓이지 않는다' | 받긴 하는데 승인 기록이 하나 더 쌓인다 |
| G13 심볼릭 링크 | `test_web_hardening_http` H6c | serve.ts 가 `reports/`·`out/` 안의 링크를 따라 PES 홈 밖 파일을 내준다 (0.15 도 그랬다 — PR18 이 막으려던 것) |
| G14 시작 질문 폼 set_id | `test_web_r1_3` R1b | 정적 `ask-*.html` 의 데이터에 `set_id` 가 없다(AI 점검 폼은 `render` 뒤 실린다) |
| G15 show_if 정리 | `test_web_r1_3_show_if` R3c | position 없는 옛 세트의 `show_if` 가 대시보드 데이터에서 버려지지 않는다 |
| G16 qa-brief 「기획 답(사용자)」 | `test_state_settings_changes` ×2, `test_skill_pilot_state` | `qa-brief` 가 `set plan settings` 값을 읽지 않는다 |
| G17 `current` 없는 옛 프로젝트 | `test_state_load` 'show reads the old folder…' | 단계를 명시한 `show` 도 한국어 오류로 거절(0.15 는 읽었다) |
| G18 `reopen` | `test_state_transitions` 'reopen marks later stages stale…' | 다시 연 단계의 `review`(set 으로 쓴 값)를 비우지 않는다 |

### 서버 갭 — 되살린 서버 시험과 e2e (SEL-74 시험 쪽 3차, leader 결정 2026-11-12)

전환 뒤 사용자의 대시보드·화면은 `scripts/serve.ts` 가 띄운다. 그래서 PR18 의 로컬 화면 보장은 serve.ts 가 갖춘다 — `serve.ts` 머리말의 '/api/v1/* 통과 길과 DB 로 짓는 화면은 여기 없다(SEL-77 이후)'는 이제 **구현할 일**이다. 2차에서 지웠던 서버 시험을 git `83bc0b3` 에서 되살려 ts 대상(`node scripts/serve.ts` — `web_env.start_server`)으로 옮겼다. 단언은 약화하지 않았다(`step(c, "1", …)` 의 플래그 자리만 뺐다). 지금은 모두 실패하는 것이 정상이고, worker 가 `serve.ts` 를 고쳐 통과시킨다. 아래 'worker 가 볼 목록'에서 갭 번호로 시험을 찾는다.

| 갭 | 보장 | 시험 | 지금 serve.ts |
|---|---|---|---|
| S1 `/api/v1/*` 통과 | `/api/v1` 은 폴더 이름·`..` 철자와 무관하게 정적 서빙보다 먼저 API 다(`format_version: "1.0"` 봉투). 허용 안 된 Origin(null 포함)의 쓰기는 세션 비밀이 있어도 403 `forbidden`, 세션 없으면 401 | `test_web_server` W3d2·W3e2·W3f, `test_web_hardening_http` H1b·H7 | 길이 없다 — 정적 폴더/404 |
| S2 `/version` DB 커서 | `/<slug>/version`·`/version` = 정수 하나: 변경 없으면 같고, 같은 프로젝트의 DB 쓰기(명령·화면 답)로 커지고, 읽기·실패한 POST·다른 프로젝트 쓰기로는 안 변하고(홈 값만 변한다), 파일 mtime 과 무관하고, 쿼리·끝 슬래시·`wait_ms` 잡음에도 바로 답한다 | `test_web_server` W3g, `test_web_hardening_state` H5a·H5b | `index.html`·`ask-*.html` 의 시각(0.15 계약) — DB 쓰기에 안 변한다; 홈 `/version` 은 404 |
| S3 요청 때 DB 로 짓는 화면 | `/<slug>/`·`/<slug>/index.html`·`/`·`/index.html` 은 요청 때마다 DB 에서 짓는다(낡은 정적 파일을 내주지 않고, 답·`merge`·`note` 같은 쓰기 명령 뒤 `render` 없이 즉시 반영, 서로 같은 데이터, HEAD 길이 = GET 길이). `PES_DB_CORE` 같은 옛 환경 변수는 영향이 없다 | `test_web_review1` R1, `test_web_hardening_state` H8a (+ Playwright e2e 11개, 아래) | 폴더의 정적 `index.html` 을 그대로 서빙한다 — 홈 `/` 도 정적 파일 |
| S4 DB 가 서빙하는 보고서·산출 | `/<slug>/reports/<단계>/<이름>`·`/<slug>/out/<이름>` 은 이 프로젝트의 DB 보고서·blob 이다: 만들지 않은 보고서는 404(다른 프로젝트 것을 대신 내주지 않음), 쿼리의 가짜 버전·`..`·blob 해시·저장 키 철자로 다른 프로젝트 내용이 안 나옴, 모양이 틀린 주소는 404(500·디렉터리 목록 아님), 이전·활성화한 프로젝트의 대시보드가 광고하는 등록 보고서 URL 은 모두 200 이고 바이트가 원본·DB ready blob 과 같다 | `test_web_hardening_state` H9, `test_web_n1_reports` N1 | 폴더 파일을 정적으로 서빙한다(폴더 URL 은 301) |
| (G13) 심볼릭 링크 | 위 S4 와 함께 — `test_web_hardening_http` H6c 는 2차부터 있던 갭 G13 이다 | — | 아래 G13 |

**통과해야 하는 것 (번역한 시험):** `H8b` — 옛 `project.json` 프로젝트는 `migrate` 전에는 답을 받지 않고(404, 폴더 불변, D14) 이전한 뒤에는 DB 로 받아 응답 `file` 이 처리 대기 이름이고 알림 줄이 `FEEDBACK plan R2 feedback <이름>` 형식이다. 이 시험은 갭이 아니다(지금 통과) — 구현이 깨뜨리지 않아야 한다. `H8a` 는 0.15 의 '플래그가 정확히 1 이 아니면 DB 를 쓰지 않는다'를 뒤집어 번역했다(ts 에는 플래그가 없다 — 어떤 값이어도 서버는 같다).

**Playwright e2e (13 통과, 11 실패 — 이번 3차에서 돌리지 않았다, 2차 보고 기준):** `workspace_smoke` E1·E5·E6·E10, `workspace_final` F2·F3·F4a·F4b, `workspace_hardening` X1, `workspace_n2` N2, `workspace_r13` R3a. 화면이 요청 때 DB 에서 지어지는 것(S3)에 기대던 것이다. 시험은 그대로 두었고 `serve.ts` 로 돈다 — S3 가 구현되면 같이 풀리는지 worker 가 `npx playwright test` 로 확인한다. CI 의 browser 잡이 이 상태로는 빨갛다.

### worker 가 볼 목록 — 시험 이름 ↔ 갭 번호

`npm test` 에서 남는 실패는 이것뿐이어야 한다(그리고 Python 파일 존재를 단언하는 `test_sel74_e` 의 E1·E2·E3·E8·E10 — Python 파일 제거 PR 이 풀어 준다). 갭 번호는 위 'ts 구현 갭'(G, G4·G11·G12 는 번호가 비어 있다)과 '서버 갭'(S)의 것이다. 시험 이름은 `node --test` 출력의 제목 앞 글자다.

| 시험 파일 | 시험 | 갭 |
|---|---|---|
| `test_cli_read_final2` | F1b ×2·F1c | G1 |
| `test_cli_read_doctor` | 'DB 프로젝트…' | G1 |
| `test_cli_read_doctor` | '공백·따옴표·괄호' | G2 |
| `test_cli_read_doctor` | '깨진 DB' | G3 |
| `test_cli_read_hardening` | H6 | G5 |
| `test_cli_read_hardening` | H1·H1b | G6 |
| `test_cli_read_v015` | 'pending…' | G6 |
| `test_state_transitions` | 'round-start increments…' | G7 |
| `test_state_settings_changes` | 'round-start 는 이전 라운드 changes…' | G7 |
| `test_cli_set_report` | 'set changes…' | G7 |
| `test_cli_set_report` | 'set review…' | G8 |
| `test_cli_set_hardening` | '\ud800' | G9 |
| `test_cli_write` | '두 번째 approve 로 승인 기록이 쌓이지 않는다' | G10 |
| `test_web_hardening_http` | H6c | G13 |
| `test_web_r1_3` | R1b | G14 |
| `test_web_r1_3_show_if` | R3c | G15 |
| `test_state_settings_changes` | ×2 ('기획 답(사용자)') | G16 |
| `test_skill_pilot_state` | (qa-brief) | G16 |
| `test_state_load` | 'show reads the old folder…' | G17 |
| `test_state_transitions` | 'reopen marks later stages stale…' | G18 |
| `test_web_server` | W3d2·W3e2·W3f | S1 |
| `test_web_hardening_http` | H1b·H7 | S1 |
| `test_web_server` | W3g | S2 |
| `test_web_hardening_state` | H5a·H5b | S2 |
| `test_web_review1` | R1 | S3 |
| `test_web_hardening_state` | H8a | S3 |
| `test_web_hardening_state` | H9 | S4 |
| `test_web_n1_reports` | N1 | S4 |
| e2e `workspace_*.spec.ts` (11개) | E1·E5·E6·E10·F2·F3·F4a·F4b·X1·N2·R3a | S3 (확인 필요) |

갭 하나를 풀 때마다 이 표에서 그 줄을 지운다. 어떤 갭을 포기하기로 하면(제품이 그 기능을 원하지 않으면) 그 시험을 지우는 것은 worker 가 아니라 leader 가 결정한다.

### SEL-74 갭 정리 결과 (leader, 합친 뒤)

위 'ts 구현 갭'(G1~G18)과 '서버 갭'(S1~S4)은 SEL-74 안에서 모두 구현으로 메웠다 — 서버 쪽 S1~S4·G13·G14·G15 는 ai/SEL-74(w2), G7·G8·G9·G10·G16·G17·G18 과 Python 제거는 ai/SEL-74-py(w3), G1·G2·G3·G5·G6 은 나누기 전(97d64f0). 합친 커밋에서 해당 시험이 모두 통과한다. `test_ci_ts_ddl_check` 의 옛 'Python 잡' 시험은 Python 잡이 사라져 'Python 설계 검사를 싣는 잡이 없다'로 바꿨다(E8 과 같은 계약).
