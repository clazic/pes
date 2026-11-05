# 0016. PES 코어는 TypeScript 단일 언어로 간다

- 날짜: 2026-11-05
- 담당: 2단계 PR1·PR26, 5단계 WEB0
- 상태: **TypeScript 단일 언어 확정. Node 26 + `node:test` + `tsc --noEmit` 확정(2026-11-05, PR1).** 언어 선택은 다시 묻지 않는다.

## 문제

2단계 PR1 착수 전이 언어를 바꾸기 가장 싼 시점이다. 지금 PES는 Python 0.15 계열(`scripts/pes.py`·`serve.py`, pytest, 설치 스크립트, skills/commands의 `python3 scripts/pes.py ...` 호출)이다. 앞으로 로컬 CLI·스킬 도구·로컬 서버·웹 서버·대시보드 화면·브라우저 쪽 글자 뽑기·A 실행기·연결 도우미까지 **같은 언어**로 두는 것이 사용자 방향이다.

## 선택지

1. Python을 유지하고 웹만 TS로 둔다.
2. **TypeScript 단일 언어로 새 코어와 기존 0.15 기능을 모두 옮긴다.**
3. Go 또는 Rust로 새 코어를 만든다.
4. 언어를 지금 정하지 않고 2단계를 Python으로 시작한다.

## 판단 기준

① 실행 위치별 지원(로컬 CLI·Claude Code plugin·Cloudflare Workers·Vercel·VPS·브라우저) ② 브라우저/로컬 글자 뽑기 라이브러리(pdf.js·SheetJS·mammoth·hwpx XML·hwp.js 등, 성숙도 확인 필요) ③ 웹 대시보드와 같은 언어인가 ④ 기존 Python 자산 이식 비용 ⑤ 에이전트가 다루기 쉬운가 ⑥ SQLite/D1/libSQL 드라이버 ⑦ 단일 실행 파일·설치 편의(Windows/Mac).

## 채택

**2번. TypeScript 단일 언어.**

- 로컬 CLI·스킬 도구·로컬 서버·웹 서버·대시보드 화면·브라우저 쪽 글자 뽑기·A 실행기·연결 도우미를 **모두 TypeScript**로 둔다. 브라우저까지 도는 주류 언어 중 하나로 이 조건을 만족한다.
- **새 코어·기능·시험은 처음부터 TS 모듈/TS 시험 계약으로 배정한다.** `python`·`pytest`는 PR26의 0.15 이전·동등성 시험에만 쓰고, `docs/plan/schemas/check_ddl.py`는 **PR26 전까지 한시 실행**한다. **PR26이 설계 검사 계약을 TS 검사기·실행 명령·기존 합성 사례 동등성으로 옮기고, 이후 필수 검사는 그 TS 산출물을 쓴다.** 테스트 실행 명령은 런타임·러너 결정 뒤 확정할 TS 명령으로 표시한다.
- 런타임은 **Node 또는 Bun**(로컬), 플랫폼에 맞는 Workers/Vercel/Deno/VPS(Node) 중에서 **짧은 언어 시험 후** 정한다. 테스트 러너도 그때 정한다.
- **기존 Python 0.15도 새 언어로 옮긴다.** 0.15 Python은 옮기는 동안 **동결(치명 결함 수정만)** 한다. 2단계 동등성 매트릭스(같은 입력→같은 출력: 질문 화면·보고서·`project.json` 처리·CLI 출력)를 기준으로 옮기고, pytest도 새 테스트로 옮긴 뒤 같은 합성 픽스처로 양쪽 차이 0을 확인한 다음 Python을 제거한다.
- 설치·부트스트랩(`install.sh`/`install.ps1`, `pes:setup`)을 새 런타임 기준으로 바꾼다. Windows/Mac을 모두 시험한다.
- `skills/`·`commands/`·`agents/`의 `python3 scripts/pes.py ...` 호출을 새 CLI 명령으로 바꾼다. 2단계 PR17(스킬 중립화)과 PR26이 함께 맡는다.
- legacy importer(PR11)는 언어와 무관하게 **옛 데이터 형식**(`project.json`·폴더 구조)을 읽는다. Python 코드를 실행하지 않는다.
- 외부 도구(kosis·vworld·korean-law 등)가 자기 런타임으로 Python을 요구하면 그 요구는 **외부 도구 경계**로 남긴다. PES 코드 안에 다른 언어를 두지 않는다.

## 이유

- 브라우저·웹 서버·로컬 서버·CLI를 한 언어로 두면 계약·DTO·검증·글자 뽑기 코드를 공유하고, Python/TS 이중 구현(기존 WEB0의 큰 위험)을 없앤다.
- Workers·Vercel·Deno·VPS(Node)에서 같은 코드가 도는 경로가 생긴다.
- 기존 Python 자산은 이전 비용이 있지만, 2단계 PR1 전에 결정하면 새 스키마·API·화면을 두 번 만들지 않는다.

## 기각

- **Python 유지**: 기존 자산·문서 처리 라이브러리는 강점이나, 브라우저 쪽 글자 뽑기·웹 UI와 같은 언어가 아니고 Workers 지원이 Pyodide 기반(제약·콜드스타트·패키지 한계, 미확인)이다.
- **Go**: 단일 바이너리·성능은 좋지만 브라우저·대시보드·문서 생태계가 약하고, 화면·브라우저 추출을 같은 언어로 못 묶는다.
- **Rust**: 성능·WASM은 강점이나 브라우저/문서 생태계·개발 속도·기여 장벽이 이 규모에 맞지 않는다.

## 영향

- `stage-2.md`의 테스트·CLI 표기를 TS 기준으로 바꾼다. 테스트 러너·패키지 관리자는 언어 시험 후 확정한다.
- 2단계에 **PR26(0.15 Python → TypeScript 이전·단일 코드베이스)** 을 둔다. 0.16.0은 새 언어 단일 코드베이스를 목표로 한다. 단계 나눔이 더 안전하다고 판명되면 이유와 함께 다시 제안한다.
- 5단계 WEB0는 언어 중립 JSON 픽스처를 TS로 통과시키고, Cloudflare/Vercel/VPS에서 같은 코드가 도는지 확인한다. "Python Workers 되나" 질문은 없어진다.
- `decisions/0016`이 0013의 모델·A 실행 구조와 충돌하지 않는다. A는 여전히 Go API를 직접 호출한다.

## WEB0 런타임·테스트 러너 시험 (2026-11-05)

`spikes/web0/`에서 같은 TypeScript 코어(A 한 라운드: 모델 호출 3·결과 제출 2·질문/답 1·wait/resume/complete·신규 53행)를 로컬에서 실행했다. 계정·배포·유료 호출은 하지 않았다.

| 런타임 | 버전 | 같은 코어 실행 | 벽시계(중앙값) | 프로세스 CPU | RSS | 비고 |
|---|---|---:|---:|---:|---:|---|
| Node | 26.13.0 | 통과 | 625.59 ms | 24.68 ms | 63.32 MB | `node:sqlite` 내장, `node:test` 91개 통과 |
| Bun | 1.4.4 | 통과 | 660.36 ms | 30.00 ms | 28.53 MB | npm devDependency 바이너리, 1회 실행 |
| Deno | 2.9.6 | 통과 | 682.36 ms | 80.00 ms | 50.88 MB | npm devDependency 바이너리, 1회 실행 |

- 세 런타임 모두 `node:sqlite`가 동작했고 같은 신규 53행을 썼다. 값은 로컬 스파이크이며 플랫폼 판정이 아니다.
- 계약 시험: 38/38 fixture parse/validate, 7개 필수 경로 normal/error/replay 실행, SQLite·로컬 D1 계약 16 pass + 1 info, 미지원 SQL 0.
- 테스트 러너는 **`node:test`**를 채택했다. Node 26이 TypeScript를 타입 제거로 바로 실행하므로 별도 트랜스파일러·러너 없이 `node --test`가 돌고, 91개 테스트가 통과했다. `tsc --noEmit`은 `typescript`로 돌린다.
- Bun/Deno는 **실행 가능성만 확인**했고, 각자의 테스트 러너로 전체 계약을 다시 돌리지는 않았다. Workers·Vercel·VPS 모두 Node/TS 경로가 있으므로, 런타임을 둘로 늘릴 근거가 이번 시험에서는 나오지 않았다.
- 로컬 D1은 deferred FK 누락을 `internal error; reference=…`로 반환했고, 원시 INTEGER를 JS `number`로 읽으면 2^53+1이 손실됐다. `CAST(... AS TEXT)`로 읽어야 한다. `node:sqlite`는 같은 값을 원시로 읽으면 `ERR_OUT_OF_RANGE`를 던졌고, `lastInsertRowid`가 2^53을 넘는 쓰기는 `setReadBigInts(true)`로 흡수했다.
- A HWPX 최소 변환기는 순수 TS + fflate로 Node와 로컬 workerd에서 **같은 3,061 B·같은 sha256**을 만들었고, esbuild 브라우저 번들도 통과했다. 한글에서 실제 열기·서식 충실도는 사용자 확인이 필요하다.

### PR1 확정 (2026-11-05)

**Node 26 계열 + `node:test` + `tsc --noEmit`.** WEB0의 잠정 추천을 2단계 PR1이 이대로 확정했다. 이유: `node:sqlite`가 내장이라 로컬·VPS에서 DB 드라이버가 필요 없고, Workers/Vercel/VPS가 모두 Node/TS 실행 경로를 가지며, 테스트 러너가 추가 의존성 없이 TypeScript를 실행한다. Bun은 로컬 보조 런타임 후보로만 두고, Deno는 이번 시험에서 채택 근거가 약하다.

| 항목 | 확정 | 근거 |
|---|---|---|
| 런타임 | Node **>=26** (`engines`) | WEB0 로컬 시험(Node 26.13.0), `node:sqlite` 내장 |
| 테스트 러너 | `node:test`, `node --test "tests/**/*.test.ts"` | 추가 러너 의존성 없음, 따옴표로 Node 자체 glob 사용(Windows 셸 글롭 비의존) |
| 타입 검사 | `tsc --noEmit`(typescript 7.0.2, @types/node 26.6.6) | WEB0와 같은 버전 |
| SQLite | **>=3.38.0**, 연결 시 실제 `sqlite_version()`·JSON 함수 검사 | [stage-2-db-guarantees.md](../stage-2-db-guarantees.md) 5절 |
| CI | 이 PR CI에서 `windows-latest`·`macos-latest` 실행(Node 26, `npm ci` → typecheck → test) | `.github/workflows/ci.yml` |
| 이름 | 함수는 `snake_case`(`pes_dir`·`db_path`·`connect`·`migrate`·`new_id`), 클래스는 `PascalCase`(`SystemClock`·`FakeClock`) | Agent notes 이름 유지 |

- 재검토 조건: Node가 타입 제거·`node:sqlite`를 깨거나, Workers/Vercel의 Node 호환 계층이 계약을 못 지킬 때, Bun/Deno가 로컬 CLI·테스트에서 Node보다 확실히 나을 때.

## 재검토 조건

- 언어 시험에서 TS가 로컬 CLI·브라우저 추출·서버 중 한 곳에서도 감당하지 못할 때.
- 기존 Python 0.15 이전 비용이 2단계 일정을 크게 넘고, 단계 분리가 더 안전하다고 확인될 때.
- 외부 도구가 PES 코어와 같은 런타임을 요구해 경계가 무너질 때.
