# PES 개발 규칙

이 저장소는 PES(Project Execution System)를 **개발**하는 곳이다. PES로 연구를 **수행**하는 규칙은 `skills/core/SKILL.md`에 따로 있다 — 둘을 섞지 않는다.

## 저장소 지도

| 경로 | 내용 |
|---|---|
| `.claude-plugin/` | 플러그인·마켓플레이스 정의(`plugin.json`의 `version`) |
| `skills/` | 단계별 스킬(`core`, `plan`, `research`, `analyze`, `write`, `verify`, `publish`) |
| `agents/` | 서브에이전트 지침(researcher·writer·verifier·reviewer) |
| `commands/` | `/pes:*` 명령 |
| `scripts/` | `pes.ts`(상태 CLI), `serve.ts`(로컬 서버), `setup.ts`(설치 도우미), 설치 스크립트(`install.*`·`bootstrap.*`) |
| `templates/` | 대시보드·질문 폼·보고서 HTML 템플릿 |
| `questions/` | 단계별 시작 질문 은행 |
| `docs/plan/` | 계획 문서. 읽는 순서: `00-brief.md` → `stage-0.md` → `stage-1-db.md`·`stage-1-api.md`·`stage-1-ui.md`·`stage-1-runners.md` (이후 `stage-N*.md`; `decisions/` 결정 기록, `discussion/` 논의안) |
| `docs/archive/` | 더 이상 쓰지 않는 자료(예: 카드 재설계 시안) |
| `tests/` | `node:test` 회귀 테스트와 합성 fixture |

## 검사

Node 26 이상이 필요하다. PES 도구(`pes.ts`·`serve.ts`·`setup.ts`)는 모두 Node 로 돈다 — Python 은 필요 없다(0.15 Python 도구와 그 시험은 SEL-74 에서 지워졌다. 외부 Python 경계: [docs/plan/migration-ts-equivalence.md](docs/plan/migration-ts-equivalence.md) 9.1절).

TypeScript 코어·시험(Node 26, `node:sqlite`). `npm run check:ddl`은 DDL 초안 설계 검사(`scripts/check_ddl.ts`, `:memory:` SQLite)다:

macOS / Linux:

```sh
npm ci && npm test && npm run typecheck && npm run check:ddl
```

Windows (PowerShell):

```powershell
npm ci
npm test
npm run typecheck
npm run check:ddl
```

테스트 격리 원리와 한계는 [tests/README.md](tests/README.md)를 본다.

## 금지

- 실제 `~/pes-projects`·`~/.pes/`를 읽거나 쓰지 않는다. 테스트·진단은 임시 `HOME`·`PES_HOME`으로 격리한다.
- **`scripts/pes.ts`(특히 `doctor`·`list`·`status`)·`scripts/serve.ts`는 `HOME`(Windows `USERPROFILE`)과 `PES_HOME`을 둘 다 임시 폴더로 바꾼 상태에서만 실행한다.** 격리 없이 한 번이라도 실행하면 실제 프로젝트 이름·상태가 모델 대화로 나간다(2026-11-05 SEL-14 사고, `docs/plan/defects.md`). 격리 방법이 확실하지 않으면 실행하지 말고 코드를 읽는다.
- 실키, 기관 자료, 실제 프로젝트 내용을 fixture·로그·문서·커밋에 넣지 않는다.
- 이 저장소는 **공개**다(2026-11-04 다시 공개로 전환, `docs/plan/00-brief.md` 1절). 커밋·이슈·PR에 올라가는 모든 내용이 공개된다고 가정한다.

## 원칙 0 — 에이전트는 상태를 직접 쓰지 않는다

모든 쓰기는 PES가 검증하는 하나의 경로를 지난다(`docs/plan/stage-0.md` 1절). 스킬·서브에이전트 지침·명령 문서는 상태를 `merge`·`set`·`qa` 같은 pes 명령으로만 바꾼다(2단계 PR17에서 `project.json` 직접 편집을 없앴다 — `docs/plan/stage-2-db-guarantees.md` 8.14). `npm run lint:skills`가 문서의 직접 쓰기를 막는다. **새 코드·문서도 상태 파일·업무 DB·잠금 파일을 직접 쓰지 않는다**.

## 변경 규칙

- 한 변경에 한 목적. 동작 변경과 큰 정리를 한 커밋에 섞지 않는다.
- 설계 결정은 `docs/plan/decisions/`에 남긴다(문제 / 선택지 / 채택 / 이유 / 영향 / 재검토 조건 / 상태). 양식과 색인은 [docs/plan/decisions/README.md](docs/plan/decisions/README.md).
- 문서만 바꾸면 플러그인 버전을 올리지 않는다. 배포할 때만 `README.md` 「배포하는 쪽」 절과 `.claude-plugin/plugin.json` 규칙을 따른다.
- 테스트를 고치거나 건너뛰게 해서 통과시키지 않는다.

## 결함 기록

진단은 `node scripts/pes.ts doctor`를 먼저 쓴다. `doctor`는 `~/.pes/config.json`과 `~/.claude/settings.json`도 읽으므로 `PES_HOME`만 바꿔서는 부족하다. 개발 중에는 `HOME`(Windows는 `USERPROFILE`)과 `PES_HOME`을 함께 임시 폴더로 두고 실행한다.

macOS / Linux:

```sh
review_home="$(mktemp -d)"
HOME="$review_home" PES_HOME="$review_home/pes-projects" node scripts/pes.ts doctor
```

Windows (PowerShell):

```powershell
$reviewHome = Join-Path $env:TEMP ("pes-doctor-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $reviewHome | Out-Null
$env:HOME = $reviewHome
$env:USERPROFILE = $reviewHome
$env:PES_HOME = Join-Path $reviewHome "pes-projects"
node scripts/pes.ts doctor
```

확인된 결함은 [docs/plan/defects.md](docs/plan/defects.md)에 **버전 · OS · 명령 · 기대 결과 · 실제 결과 · 합성 재현 자료 · 심각도 · 처리 단계** 형식으로 적는다. 재현하지 못한 추정은 결함으로 적지 않는다.
