# PES — Project Execution System

Claude Code 플러그인. 연구·정책 보고서를 **기획 → 조사 → 분석·종합 → 집필 → 검증 → 산출·공유** 6단계로 진행한다.
단계마다 **라운드**를 돌고, 모든 질문·답·승인은 **로컬 웹 화면**(대시보드·질문 폼)에서 주고받는다.

```
한 단계:  시작 질문(폼) → R1 결과 → AI 점검 질문 → 사용자 답 → R2 → … → 승인 → 단계 보고서
전체:     기획 ─ 조사 ─ 분석·종합 ─ 집필 ─ 검증 ─ 산출·공유
```

- 모든 상태는 파일에 저장된다. 세션이 끊기거나 `/clear` 해도 `/pes:run`으로 이어진다.
- 승인한 단계는 다시 열어 고칠 수 있다. 뒤 단계에는 '다시 확인 필요'가 표시된다.
- 단계를 승인할 때마다 그 단계 보고서(기획보고서·조사보고서…)가 웹·그림 설명(eli5)·마크다운 등으로 만들어진다.

---

## 1. 설치

### 한 줄 설치 (권장)

#### Claude Desktop에서 쓸 때 (Claude Code를 따로 설치하지 않음)

Claude Desktop 안에는 Claude Code가 들어 있고, Code 탭과 Claude Code는 **같은 설정 폴더**(`~/.claude`, Windows `%USERPROFILE%\.claude`)를 쓴다. 아래 명령은 **Claude Desktop 안의 Claude Code로 플러그인을 등록**하고, 별도의 Claude Code CLI는 설치하지 않는다.

먼저 Claude Desktop을 설치하고 **Code 탭을 한 번 열어 둔다** (그때 Desktop 안의 Claude Code가 준비된다).

**Windows** — PowerShell:

```powershell
irm https://raw.githubusercontent.com/clazic/pes/main/scripts/install-desktop.ps1 | iex
```

**macOS** — 터미널:

```bash
curl -fsSL https://raw.githubusercontent.com/clazic/pes/main/scripts/install-desktop.sh | bash
```

- Desktop 안의 Claude Code 위치: macOS `~/Library/Application Support/Claude/claude-code/<버전>/…/claude`, Windows `%APPDATA%\Claude\claude-code\…\claude.exe` 근처를 찾는다 (가장 최근 것).
- 찾지 못하면(Code 탭을 아직 안 열었을 때) CLI를 설치하지 않고, Claude 설정 파일(`settings.json`)에 PES 마켓플레이스와 플러그인만 등록해 둔다 → Code 탭을 열고 `/reload-plugins`.
- 나머지(기본 도구 · 조사 도구 · 업그레이드 · API 키 화면 · 진단)는 아래 일반 한 줄 설치와 같다.
- 끝나면 Claude Desktop을 **완전히 종료**(작업 표시줄·메뉴 막대 아이콘에서도)했다가 다시 열고 Code 탭에서 `/pes:start <주제>`.

#### 일반 (Claude Code CLI · Desktop 자동 선택)

**Windows** — PowerShell(시작 메뉴 → "PowerShell")에 붙여넣기:

```powershell
irm https://raw.githubusercontent.com/clazic/pes/main/scripts/install.ps1 | iex
```

**macOS·Linux** — 터미널에 붙여넣기 (bash·sh 어느 쪽이든 된다):

```bash
curl -fsSL https://raw.githubusercontent.com/clazic/pes/main/scripts/install.sh | bash
```

```bash
curl -fsSL https://raw.githubusercontent.com/clazic/pes/main/scripts/install.sh | sh
```

한 번에 이것까지 한다 (다시 실행해도 된다 — **없는 것은 설치, 이미 있는 것은 최신 버전으로 업그레이드**):

1. Git(Git Bash) · Python 3 · Node.js — 없으면 설치 (Windows `winget`, macOS Homebrew / Command Line Tools)
2. 플러그인을 등록할 Claude 찾기 — PATH의 Claude Code → 없으면 **Claude Desktop 안의 Claude Code** → 둘 다 없으면 Claude Code CLI 설치 (`PES_TARGET=desktop` 이면 CLI를 설치하지 않음, `PES_TARGET=cli` 이면 CLI만)
3. PES 플러그인 등록·설치 (`clazic/pes` → `pes@pes-local`)
4. 조사 도구: kosis · vworld · korean-law (ego lite는 내려받기 페이지를 연다 — 설치와 첫 실행 안내는 직접)
   - 이미 있으면 **최신 버전으로 업그레이드**: kosis·vworld(**CLI와 스킬을 따로 확인** — 둘 중 하나라도 뒤처지면 공식 설치 스크립트로 다시 설치해 맞춘다. kosis는 이전 스킬 폴더를 `~/.pes/backup/`에 백업, vworld는 LEARNINGS.md 보존), korean-law(CLI와 MCP가 같은 npm 패키지), ego lite(앱 자체 업데이트 — **ego-browser 스킬은 앱 안에 들어 있어 함께 갱신**되고, 스킬 연결과 버전이 앱과 맞는지 확인), Claude Code CLI(`claude update`). 업그레이드를 원하지 않으면 `PES_NO_UPGRADE=1`
5. **API 키 입력 화면**이 브라우저에 열림 → 필요한 키만 넣고 **마치기** (키는 이 컴퓨터의 도구 설정에만 저장)
6. 진단(`doctor`) 후 완료 표시

끝나면 **Claude Desktop을 완전히 종료했다가 다시 열고** Code 탭에서 `/pes:start <주제>`.

- 키 화면을 건너뛰면 나중에 Claude에서 `/pes:setup keys`.
- 관리자 권한 창(UAC)이 뜨면 **예**. Windows에서 Git을 처음 설치했으면 PowerShell 창을 새로 열어 한 번 더 실행하면 확실하다.
- 키 화면 건너뛰기 예: `curl -fsSL …/install.sh | PES_SKIP_KEYS=1 bash` (변수는 파이프 오른쪽 `bash` 앞에), Windows는 `$env:PES_SKIP_KEYS=1; irm …/install.ps1 | iex`.


### 필요한 것

| 구분 | 내용 | 필수 |
|---|---|---|
| Claude Code | CLI 또는 데스크톱 앱 | 필수 |
| Python | 3.9 이상 (macOS `python3`, Windows `py -3`) | 필수 |
| tail·grep | 답 자동 수신용. macOS 기본 / Windows는 **Git Bash** | 필수 |
| ego-browser | 브라우저 조사 (ego lite) | 조사에 권장 |
| kosis | 통계청 KOSIS API CLI (`npm install -g @clazic/kosis`) + API 키 | 통계가 필요할 때 |
| korean-law | 법령 CLI (`korean-law-mcp`) + `LAW_OC` | 법령이 필요할 때 |
| vworld | 국가공간정보 CLI + API 키 | 공간정보가 필요할 때 |

설치 상태는 설치 후 `/pes:doctor`로 한 번에 확인한다.

### 한 번에 설치·점검: `/pes:setup` (Windows·macOS)

플러그인을 설치한 뒤 Claude Code(또는 Claude Desktop의 Code 탭)에서 **`/pes:setup`** 한 번. 처음 `/pes:start`·`/pes:run`을 실행할 때도 점검이 안 되어 있으면 자동으로 먼저 실행된다.

1. **기본 도구**: Git(Windows는 Git Bash 포함) · Python 3 · Node.js — 없으면 설치 (Windows `winget`, macOS Homebrew / Command Line Tools)
2. **조사 도구**: kosis(CLI+스킬) · vworld(CLI+스킬) · korean-law(CLI, Claude CLI가 있으면 MCP도) — 없으면 공식 설치 스크립트·npm으로 설치, **있으면 최신으로 업그레이드** (kosis·vworld는 자체 `update`, korean-law는 npm 최신판, ego lite는 `ego-browser upgrade`)
3. **ego lite**: 앱 설치와 첫 실행 안내(온보딩)는 직접 해야 한다 — 내려받기 페이지를 열어 준다 (macOS는 설치 스크립트로 설치까지)
4. **API 키**: 브라우저에 키 입력 화면(http://127.0.0.1:8759)이 열린다. 발급 방법이 함께 있고, 넣은 키는 확인 후 각 도구 설정에 바로 등록된다 — **키는 Claude 대화로 전달되지 않는다.** 필요 없는 기능은 비워 두면 된다
5. **`/pes:doctor`**로 API 접속까지 확인하고 완료 표시

- 키만 다시 넣기: `/pes:setup keys`
- Windows에서 Git을 새로 설치했으면 Claude Desktop을 다시 시작한 뒤 `/pes:setup`을 한 번 더 (답 자동 수신에 Git Bash가 필요).
- 법령 API(LAW_OC)는 틀린 값에도 응답해서 값 자체는 확인할 수 없다 — 발급받은 이메일 ID 앞부분을 정확히 넣는다.

### 플러그인 설치

**GitHub 저장소에서** (공개 저장소 — 로그인 불필요):

```bash
claude plugin marketplace add <GitHub계정>/pes
claude plugin install pes@pes-local
```

**로컬 폴더에서** (개발용):

```bash
claude plugin marketplace add <pes 폴더 경로>      # 예: ~/work/pes, C:\work\pes
claude plugin install pes@pes-local
```

설치 후 Claude Code 안에서 `/reload-plugins` (또는 재시작) → **`/pes:setup`**.

### 업데이트

```bash
claude plugin marketplace update pes-local && claude plugin update pes@pes-local
```

그다음 `/reload-plugins`. 로컬 폴더 설치라면 `/reload-plugins`만으로 반영된다.
지금 버전은 `.claude-plugin/plugin.json`의 version, 바뀐 내용은 아래 「변경 이력」.

### 배포하는 쪽 (개발 Mac)

```bash
cd ~/work/pes
# 코드 수정 → README 「변경 이력」과 plugin.json version 갱신
git add -A && git commit -m "0.x.y: 바뀐 내용"
git tag v0.x.y && git push && git push --tags
```

### API 키·환경변수

Claude가 실행하는 명령에서도 보이도록 **Claude Code 설정**에 넣는다 (`~/.claude/settings.json`, Windows는 `C:\Users\<이름>\.claude\settings.json`):

```json
{
  "env": {
    "LAW_OC": "<법령 API 인증값>",
    "NODE_EXTRA_CA_CERTS": "<회사·기관 망에서 인증서 오류가 날 때만: 루트 인증서 파일 경로>"
  }
}
```

- KOSIS 키: `kosis config set-key <키>` (발급 https://kosis.kr/openapi/)
- vworld 키: vworld 스킬 안내대로 등록
- 셸 설정 파일(`.zshrc` 등)에만 넣으면 Claude 명령에서 안 보일 수 있다. `/pes:doctor`가 알려 준다.

### Windows · Claude Desktop 설치 (단계별)

Windows용 Claude Desktop에서는 **Code 탭(로컬 세션)**에서 설치하고 쓴다. Cowork 모드는 가상 머신에서 돌고 플러그인 형식·저장 위치가 달라, 내 컴퓨터의 대시보드 서버·CLI 도구를 쓰는 PES와 맞지 않는다.

#### 0. 준비 (처음 한 번)

1. **Claude Desktop 최신 버전**으로 업데이트.
2. **Git for Windows 설치** — 저장소(`clazic/pes`)에서 플러그인을 받는 데 필요하고, 답 자동 수신(Monitor)에 필요한 Git Bash도 함께 설치된다. (한 줄 설치를 쓰면 자동으로 설치된다)
   - https://git-scm.com/download/win 에서 받아 기본값으로 설치, 또는 PowerShell에서 `winget install --id Git.Git -e`
3. **Claude Desktop을 완전히 종료**(작업 표시줄 아이콘에서도 종료)했다가 다시 연다 — 새로 설치한 git이 인식되도록.

#### 1. Code 탭 열기

Claude Desktop 위쪽 **Code** 탭 → 로컬 세션 시작. 작업 폴더는 아무 곳이나 된다 (예: `C:\Users\<이름>\work`). 프로젝트는 폴더와 상관없이 `C:\Users\<이름>\pes-projects`에 모인다.

#### 2. 플러그인 설치

**방법 A — 화면에서**
1. 입력창 옆 **+** → **Add plugins**
2. 마켓플레이스 추가에 **`clazic/pes`** 입력
3. 목록에 나온 **pes** 설치

**방법 B — 명령으로** (Claude Code CLI가 있을 때)

```
claude plugin marketplace add clazic/pes
claude plugin install pes@pes-local
```

설치 후 입력창에 `/reload-plugins` (또는 앱 재시작). `/pes`를 쳤을 때 `/pes:setup`·`/pes:start` 등이 보이면 설치된 것이다.

> 방법 A 화면에서 직접 만든 마켓플레이스를 추가할 수 있는지는 아직 확인하지 못했다. 막히면 Code 탭에서 Claude에게 "claude plugin marketplace add clazic/pes 실행해줘"라고 하거나 방법 B를 쓴다.

#### 3. `/pes:setup` 실행

| 순서 | 일어나는 일 | 직접 할 일 |
|---|---|---|
| 1 | Git·Python·Node.js 확인, 없으면 winget으로 설치 | 관리자 권한 창(UAC)이 뜨면 **예** |
| 2 | Git을 이번에 새로 설치했다면 멈춤 | Claude Desktop **재시작** 후 `/pes:setup` 한 번 더 |
| 3 | kosis·vworld·korean-law 설치 | 없음 |
| 4 | ego lite 내려받기 페이지가 열림 | 설치 → 앱 실행 → **첫 실행 안내(온보딩)** 끝내기 → Claude에게 "다 했어". SmartScreen이 막으면 **추가 정보 → 실행** |
| 5 | 브라우저에 **API 키 입력 화면** | KOSIS·VWorld·법령(LAW_OC) 키를 발급 안내대로 받아 붙여넣고 **등록·확인** → **마치기**. 필요 없는 키는 비워 둔다 |
| 6 | `/pes:doctor` 점검 후 완료 표시 | 결과 확인 |

마지막에 **Claude Desktop을 한 번 재시작**하면 키·PATH 변경이 모든 세션에 적용된다.

#### 4. 사용 시작

```
/pes:start 울산 청년 주거실태
```

브라우저에 기획 질문 폼이 열린다. 대시보드 `http://127.0.0.1:8760/<프로젝트>/`, 프로젝트 목록 `http://127.0.0.1:8760/` (`/pes:list`).

#### Windows에서 막힐 때

| 증상 | 해결 |
|---|---|
| 플러그인 추가 중 저장소를 못 찾음 | git이 PATH에 없음 — Git for Windows 설치 후 Claude Desktop 재시작, 또는 한 줄 설치 |
| `/pes:` 명령이 안 보임 | `/reload-plugins` 또는 앱 재시작 |
| 법령 조회가 안 됨 | Claude Desktop 설정의 **Environment variables**에 `LAW_OC` 추가 후 재시작 (설정 파일 env를 무시하는 경우가 있음) |
| kosis 등을 "찾지 못함" | Windows PATH가 아직 반영되지 않음 — Claude Desktop 재시작 |
| 그 밖 | `/pes:doctor` 결과를 Claude에게 보여 준다 |

#### Windows 동작 메모

- 데스크톱 앱과 CLI는 같은 설정 폴더(`%USERPROFILE%\.claude`)를 읽는다.
- 데스크톱 앱은 PowerShell 프로필을 읽지 않으므로 PATH는 **Windows 환경 변수**에 있어야 한다 (`/pes:setup`이 설치하는 도구는 사용자 PATH에 등록된다).
- API 키 등 환경변수는 `settings.json`의 env도 읽지만, 앱 설정의 **Environment variables**가 가장 확실하다.
- Claude의 셸은 Git Bash(답 자동 수신에 `tail -F`·`grep` 필요). Python은 `py -3`. 서버는 백그라운드로 분리되어 뜨고 `stop`은 pid로 끈다. 브라우저 열기는 PES가 직접 처리한다.
- 인증서 오류가 나면 `/pes:doctor`의 안내를 따른다 (기관 루트 인증서 → `NODE_EXTRA_CA_CERTS`).

---

## 2. 빠른 시작

```
/pes:start 울산 청년 주거실태
```

1. 브라우저에 **기획 시작 질문** 폼이 열린다. 추천 답이 골라져 있으니 바꿀 것만 바꾸고 **보내기**.
2. Claude가 기획 R1(연구 질문·목차·조사 항목)을 대시보드에 올리고 **AI 점검 질문**을 붙인다.
3. 대시보드에서 점검 질문에 답하거나 항목별로 심화·삭제·수정을 체크하고 **Claude에게 보내기** → R2 …
4. 충분하면 **이 단계 승인** → 기획보고서가 만들어지고 조사 단계 시작 질문이 열린다.
5. 같은 방식으로 6단계까지.

기존 research-loop 조사가 있으면 참고자료로 가져온다:

```
/pes:start 공공지원 민간임대주택 공급촉진지구 --import research/private-rental-promotion-zones
```

---

## 3. 명령

| 명령 | 하는 일 |
|---|---|
| `/pes:start <주제> [--import <폴더>]` | 새 프로젝트 + 기획 시작 질문 폼 |
| `/pes:run [프로젝트]` | 받은 답을 처리하고 현재 단계를 이어서 진행. 프로젝트가 여럿이면 고르게 한다 |
| `/pes:status [프로젝트]` | 상태 요약 + 대시보드 열기 |
| `/pes:list` | 모든 프로젝트 목록 화면 (http://127.0.0.1:8760/) |
| `/pes:plan` · `research` · `analyze` · `write` · `verify` · `publish` | 그 단계를 직접 진행 / 다시 열기 |
| `/pes:report <단계>` | 단계 보고서 다시 만들기 |
| `/pes:home [새 폴더]` | 프로젝트 위치(PES 홈) 보기 / 바꾸기 (전부 이동) |
| `/pes:setup [keys]` | 설치·점검: 기본 도구·조사 도구 설치, API 키 화면, doctor |
| `/pes:doctor [프로젝트] [fix]` | 진단 (환경·도구·키·API 연결·포트·프로젝트 상태). `fix`는 안전한 것만 고침 |

`[프로젝트]` 자리에는 경로 대신 프로젝트 이름(slug)만 써도 된다.

---

## 4. 화면

### 대시보드 (http://127.0.0.1:8760/<프로젝트>/)

서버는 **포트 하나(8760)**만 쓴다. 목록은 `/`, 프로젝트마다 `/<프로젝트 폴더 이름>/` — 프로젝트가 늘어도 포트가 늘지 않는다. 8760을 다른 프로그램이 쓰고 있으면 8761~8764 중 빈 곳을 쓴다.

- **전체 보기** (첫 화면)
  - 지금 할 일 (내 차례 / Claude 작업 중) + 바로가기
  - 프로젝트 전체 숫자 (단계별 내역 포함)
  - **단계별 진행** 표: 단계 × (시작 질문 · 라운드 R1·R2… · 승인 · 단계 보고서). 칸에 마우스를 올리면 변경점·받은 답이 정리되어 보인다
  - **산출물** 표: 단계 보고서 6종 + 최종 결과물 + 참고자료
- **단계 탭** (기획 ~ 산출·공유)
  - 그 단계 기준 숫자, 단계 보고서, AI 점검 질문(폼), 타임라인, 항목 × 라운드 표, 항목 카드(연결·출처·통계)
  - 아래 막대: 보내기 · 복사 · **이 단계 승인** · (승인된 단계) **이 단계 다시 열기**
  - 추가 요청: 새 항목, **꼭 조사할 링크·파일**, 기타 지시
- 맨 위 "← 프로젝트 목록"으로 목록 화면에 간다.

### 질문 폼

단계 시작 질문은 `ask-<단계>-start.html`. 추천 답이 미리 골라져 있다. 조사 시작 질문에서 정하는 것:
도구 · 깊이(비용 표시) · 병렬 · **조사 모델(혼합/Opus/Sonnet)** · 자료 범위 · **꼭 조사할 링크·자료** · 통계·법령·기사 범위.

### 프로젝트 목록 (http://127.0.0.1:8760/)

프로젝트별 단계 진행 막대 · 현재 단계 · 지금 할 일 · 단계 보고서 수 · [대시보드 열기]. '내 차례'가 맨 위. 같은 서버라 따로 켤 것이 없다.

---

## 5. 단계 보고서

단계를 승인할 때마다 `reports/<단계>/`에 만든다. 형식은 기획 시작 질문에서 고른다 (기본: 웹 · eli5 · 마크다운).

| 단계 | 보고서 |
|---|---|
| 기획 | 기획보고서 |
| 조사 | 조사보고서 |
| 분석·종합 | 분석·종합보고서 |
| 집필 | 원고 검토본 |
| 검증 | 검증보고서 |
| 산출·공유 | 산출 보고서 (+ `out/` 최종 결과물: HWPX·Word·PDF·웹·발표자료) |

- **웹 보고서** `report.html`: 목차 · 표 · 출처(확인됨/미확인) · 인쇄/PDF
- **그림 설명** `eli5.html`: 큰 그림, 적은 글 — 처음 보는 사람이 1분에 이해하도록
- **마크다운** `report.md`: 원본 (HWPX·Word·PDF 변환의 입력)

---

## 6. 사용자 제공 링크

조사할 때 꼭 봐야 할 자료가 있으면:

- 조사 시작 질문 "꼭 조사할 링크·자료", 또는 대시보드 조사 탭 "추가 요청"의 링크 칸에 한 줄씩:
  ```
  주소 | 항목 번호(선택) | 메모(선택)
  https://www.molit.go.kr/... | 7 | 2026년 고시 원문
  C:\자료\내부자료.pdf | 11 | 내부 자료
  ```
- Claude가 직접 열어 읽고 출처에 **사용자 제공**으로 표시한다. 항목 번호를 비우면 맞는 항목에 배정한다. 열지 못한 링크는 점검 질문으로 다시 묻는다.

---

## 7. 여러 프로젝트

- 프로젝트는 **PES 홈** 아래에 모인다. 기본 `~/pes-projects` (Windows `C:\Users\<이름>\pes-projects`). 실행한 폴더와 상관없다.
- 위치 바꾸기: `/pes:home D:\work\pes` → 서버를 끄고 **모든 프로젝트를 옮긴 뒤** 다시 켠다. 이름이 겹치거나 다른 세션이 쓰는 중이면 아무것도 옮기지 않는다.
- 우선순위: 환경변수 `PES_HOME` > `~/.pes/config.json` > 기본값.
- **한 Claude Code 세션 = 한 프로젝트**를 권한다. 터미널 탭마다 `/pes:run <프로젝트>`.
- 같은 프로젝트를 두 세션이 동시에 고치지 못하게 **잠금**이 걸린다 (2시간 기록이 없으면 자동 해제).

---

## 8. OneDrive로 옮기기 (여러 컴퓨터에서 같은 프로젝트 쓰기)

PES 홈(`pes-projects`)을 OneDrive 안으로 옮기면 집·사무실 컴퓨터(Windows·Mac 섞여 있어도)에서 같은 프로젝트를 이어서 쓸 수 있다.

### 8-0. 먼저 알아 둘 것 — 무엇이 동기화되고 무엇이 컴퓨터마다 따로인가

| 구분 | 위치 | OneDrive로 동기화? |
|---|---|---|
| 프로젝트 (상태·답·보고서·스크린샷) | PES 홈 = `…\OneDrive\pes-projects\<프로젝트>` | **된다** — 이것을 옮기는 것이 목적 |
| **PES 홈 설정** `config.json` | Windows `C:\Users\<이름>\.pes\config.json` / Mac `/Users/<이름>/.pes/config.json` | **안 된다 — 컴퓨터마다 따로** |
| 설치 기록·백업 (`setup.json`, `setup.log`, `backup\`) | 같은 `.pes` 폴더 | 안 된다 (컴퓨터마다) |
| API 키, 설치된 도구, Claude Code 설정 | 각 도구·`.claude` 폴더 | 안 된다 (컴퓨터마다 `/pes:setup`) |

그래서 **첫 컴퓨터는 "옮기기"**, **다른 컴퓨터는 "위치만 지정"** 한다. 명령은 둘 다 `/pes:home`이다.

### 8-1. `config.json` 이해하기 (두 OS 공통 개념)

PES는 프로젝트 위치를 이 순서로 정한다.

```
1. PES_HOME 환경변수        ← 있으면 가장 우선 (보통 쓰지 않음)
2. .pes/config.json 의 "home" ← /pes:home 이 쓰고 고치는 곳
3. 기본값 <홈 폴더>/pes-projects
```

`config.json` 내용은 한 줄짜리다.

```json
{
 "home": "<PES 홈 경로>"
}
```

- **`/pes:home <새 폴더>`가 만들고 고친다.** 직접 편집할 필요는 없다.
- **OneDrive 안에 넣지 않는다.** 이 파일은 "이 컴퓨터에서 OneDrive가 어디 있는지"를 적는 것이라, 컴퓨터마다 값이 달라야 한다 (Windows는 `C:\Users\…`, Mac은 `/Users/…/Library/CloudStorage/…`).
- 지금 값 확인: `/pes:home` → `PES 홈: … (설정 파일 …config.json)`.
- 파일을 지우면 기본값(`<홈 폴더>/pes-projects`)으로 돌아간다 — 프로젝트는 옮겨지지 않으므로, 프로젝트가 OneDrive에 있으면 `/pes:list`에서 안 보이게 된다. 되돌릴 때는 지우지 말고 8-8의 `/pes:home`을 쓴다.
- `PES_HOME` 환경변수가 설정돼 있으면 `config.json`보다 우선한다 — `/pes:doctor`가 둘이 다르면 알려 준다. 특별한 이유가 없으면 환경변수는 쓰지 않는다.

---

### 8-2. Windows

#### ① OneDrive 경로 확인

| 계정 | 보통의 경로 |
|---|---|
| 개인 | `C:\Users\<이름>\OneDrive` |
| 회사·기관 | `C:\Users\<이름>\OneDrive - <회사명>` |

- 파일 탐색기 왼쪽 'OneDrive - 개인' 또는 'OneDrive - <회사명>' → 주소 표시줄 클릭하면 전체 경로가 보인다.
- PowerShell: `echo $env:OneDrive` (개인), `echo $env:OneDriveCommercial` (회사).
- 옮길 위치는 그 아래 `pes-projects`. 예: `C:\Users\hong\OneDrive - 울산연구원\pes-projects`
- Windows 경로 길이 제한(260자) 때문에 더 깊은 폴더에 넣지 않는다.

#### ② 준비

1. `/pes:status`로 처리 안 한 답이 0개인지 확인.
2. 같은 프로젝트를 쓰는 다른 Code 탭·터미널을 닫는다.
3. 작업 표시줄의 OneDrive(구름) 아이콘이 로그인·동기화 중인지 확인.
4. (권장) `/pes:doctor` → 문제 0.

#### ③ 옮기기 (첫 컴퓨터)

Claude Desktop Code 탭에서 — 경로에 공백이 있으면 **따옴표**로 감싼다:

```
/pes:home "C:\Users\<이름>\OneDrive - <회사명>\pes-projects"
```

PES가 서버를 끄고 → 모든 프로젝트를 옮기고 → `C:\Users\<이름>\.pes\config.json`에 새 위치를 저장하고 → 서버를 다시 켠다.

`config.json`은 이렇게 된다 (JSON이라 `\`가 `\\`로 저장되는 것이 정상):

```json
{
 "home": "C:\\Users\\hong\\OneDrive - 울산연구원\\pes-projects"
}
```

- 직접 고쳐야 할 때(드묾): 메모장으로 열어 `"home"` 값만 바꾼다. 경로의 `\`는 **`\\` 두 개**로 쓰거나 **`/`**로 써도 된다 (`"C:/Users/hong/OneDrive - 울산연구원/pes-projects"`). 고친 뒤 `/pes:home`으로 확인. 단, 직접 고치면 프로젝트는 옮겨지지 않는다 — 옮기기는 항상 `/pes:home <새 폴더>`로.
- 파일 위치를 탐색기로 열기: 주소 표시줄에 `%USERPROFILE%\.pes` 입력.

#### ④ OneDrive 설정

1. 탐색기에서 `pes-projects` 폴더 오른쪽 클릭 → **항상 이 장치에 유지**.
   - '파일 주문형' 상태(구름 아이콘)로 두면 파일을 열 때마다 내려받아 대시보드가 느려지고 답 수신이 늦어질 수 있다.
2. 동기화 완료 = 초록 체크(✓). 파란 화살표면 기다린다.
3. `.pes` 폴더(`C:\Users\<이름>\.pes`)는 OneDrive 밖에 그대로 둔다.

#### ⑤ 두 번째 Windows 컴퓨터

1. 그 컴퓨터에 PES 설치·점검 (한 줄 설치 또는 `/pes:setup`).
2. OneDrive에서 `pes-projects`가 내려와 있는지 확인 → **항상 이 장치에 유지**.
3. **위치만 지정** (그 컴퓨터의 OneDrive 경로로):
   ```
   /pes:home "C:\Users\<이름>\OneDrive - <회사명>\pes-projects"
   ```
   → 그 컴퓨터의 `C:\Users\<이름>\.pes\config.json`이 OneDrive 경로를 가리키게 된다. 그 컴퓨터의 기존 `pes-projects`가 비어 있으면 "프로젝트 0개 이동"으로 설정만 바뀐다.
4. `/pes:list`로 확인 → `/pes:run <프로젝트>`.

---

### 8-3. macOS

#### ① OneDrive 경로 확인

| 계정 | 보통의 경로 |
|---|---|
| 개인 | `~/Library/CloudStorage/OneDrive-개인` (영문 환경 `OneDrive-Personal`) |
| 회사·기관 | `~/Library/CloudStorage/OneDrive-<회사명>` |

- Finder 사이드바의 OneDrive → 폴더를 선택하고 ⌘I(정보 가져오기) → '위치'.
- 터미널: `ls ~/Library/CloudStorage/`
- 옮길 위치는 그 아래 `pes-projects`. 예: `~/Library/CloudStorage/OneDrive-울산연구원/pes-projects`
- 예전 방식으로 설치한 OneDrive는 `~/OneDrive`일 수 있다 — 위 `ls`로 확인.

#### ② 준비

Windows와 같다: 처리 안 한 답 0개(`/pes:status`), 다른 세션 닫기, 메뉴 막대의 OneDrive 아이콘 확인, `/pes:doctor`.

#### ③ 옮기기 (첫 컴퓨터)

Claude Code(터미널 또는 Claude Desktop Code 탭)에서 — 공백이 있으면 따옴표:

```
/pes:home "~/Library/CloudStorage/OneDrive-<회사명>/pes-projects"
```

`/Users/<이름>/.pes/config.json`은 이렇게 된다 (`~`는 실제 경로로 풀려 저장된다):

```json
{
 "home": "/Users/hong/Library/CloudStorage/OneDrive-울산연구원/pes-projects"
}
```

- 직접 볼 때: 터미널 `cat ~/.pes/config.json`, Finder는 ⌘⇧G → `~/.pes` (점으로 시작하는 숨김 폴더). 고치는 경우는 Windows와 같다(드묾, 옮기기는 항상 `/pes:home`).

#### ④ OneDrive 설정

1. Finder에서 `pes-projects` 폴더 오른쪽 클릭 → **항상 이 Mac에 보관** (Always Keep on This Device).
2. 동기화 완료 표시를 확인한 뒤 다른 컴퓨터로 넘어간다.
3. `~/.pes` 폴더는 OneDrive 밖에 그대로 둔다.
4. macOS가 처음에 'Library/CloudStorage' 접근 권한을 물으면 허용한다 (터미널·Claude가 OneDrive 폴더를 읽어야 한다).

#### ⑤ 두 번째 Mac

Windows ⑤와 같다 — 설치·점검 → **항상 이 Mac에 보관** → 그 Mac의 OneDrive 경로로 `/pes:home "…/pes-projects"` → `/pes:list`.

---

### 8-4. Windows와 Mac을 섞어 쓸 때

- 프로젝트 폴더는 같고, **`config.json`만 컴퓨터마다 다르다.**
  - Windows: `"home": "C:\\Users\\hong\\OneDrive - 울산연구원\\pes-projects"`
  - Mac: `"home": "/Users/hong/Library/CloudStorage/OneDrive-울산연구원/pes-projects"`
- 각 컴퓨터에서 한 번씩 `/pes:home "<그 컴퓨터의 OneDrive>/pes-projects"`를 실행하면 된다.
- 프로젝트 안의 파일은 OS와 상관없이 같은 형식이라 그대로 이어진다. 답 기록(`feedback.log`)에 두 OS의 경로가 섞여 남는 것은 정상(기록용).

### 8-5. 컴퓨터를 바꿔 가며 쓸 때 (중요)

**한 번에 한 컴퓨터에서만** 작업한다. 같은 프로젝트를 두 곳에서 동시에 고치면 OneDrive가 충돌 사본을 만든다.

A → B로 넘어갈 때:
1. A: 라운드가 끝나고 답이 모두 처리됐는지 확인 (`/pes:status`).
2. A: Claude 세션을 닫는다 (Code 탭·터미널).
3. A: OneDrive 동기화 완료 확인.
4. B: 동기화 완료 확인 → `/pes:run <프로젝트>`.
   - **"다른 세션이 이 프로젝트를 쓰고 있습니다"**: A의 잠금이 동기화되어 온 것(2시간 기록이 없으면 자동 해제). A를 확실히 닫았으면 Claude에게 **"A는 닫았어, 가져와"** → `--force`로 넘겨받는다.
   - 대시보드 주소는 보통 두 컴퓨터 모두 `http://127.0.0.1:8760/<프로젝트>/` (8760이 막혀 있으면 8761~) — `/pes:status`가 그 컴퓨터의 주소를 알려 준다.

### 8-6. 충돌 사본이 생겼을 때

OneDrive는 두 곳에서 동시에 바뀐 파일을 `project-<컴퓨터이름>.json`, `project (1).json` 같은 사본으로 남긴다. `/pes:doctor`가 **[문제] 클라우드 동기화 충돌 사본**으로 알려 준다.

1. 두 컴퓨터 모두 Claude 세션을 닫는다.
2. 어느 쪽이 최신인지 정한다 — 파일 수정 시각, 또는 Claude에게 "충돌 사본 비교해 줘".
3. 최신본을 `project.json`으로 두고, 나머지 사본은 프로젝트 폴더 밖(바탕화면 등)으로 옮겨 보관한다. 지우는 것은 확인이 끝난 뒤에.
4. `/pes:doctor fix` → 대시보드·목록 다시 만들기.

### 8-7. 되돌리기 (OneDrive에서 빼기)

- Windows: `/pes:home "C:\Users\<이름>\pes-projects"`
- Mac: `/pes:home ~/pes-projects`

모든 프로젝트가 로컬 폴더로 옮겨지고 그 컴퓨터의 `config.json`이 바뀐다. **다른 컴퓨터는 각자** `/pes:home`으로 위치를 바꾼다 (그 컴퓨터의 `config.json`은 여전히 OneDrive를 가리키므로).

### 8-8. 알아 둘 것

- 서버 기록 파일(`.pes-port`, `.pes-server`)은 컴퓨터마다 달라 다른 컴퓨터에서는 '꺼진 서버의 기록'으로 보인다 — `/pes:doctor fix`로 정리, 동작에는 영향 없음.
- 기관 보안 정책상 OneDrive에 넣으면 안 되는 자료가 프로젝트에 들어가는지 먼저 확인한다.
- iCloud·Dropbox·Google Drive도 같은 방법이다 (`/pes:doctor`가 클라우드 폴더로 인식).

## 9. 토큰(비용) 절약

- 화면·보고서 생성과 상태 저장은 CLI가 한다 (토큰 0).
- 조사·집필·검증 서브에이전트는 결과를 `rounds/<단계>-R<n>/<id>.json` **파일로** 쓰고 한 줄만 돌려준다.
- AI 점검은 압축 요약(`digest`)으로 한다. 큰 파일은 통째로 읽지 않는다 (`show`로 필요한 부분만).
- 단계를 승인하면 대화에서 나온 결정을 **인계 메모**로 남기므로, `/clear` 후 `/pes:run`으로 이어도 된다.
- 조사 모델 **혼합**(기본): 이어받는 항목·단순 수집은 Sonnet, 새 조사·법령·판단은 Opus.
- 조사 깊이(빠른·표준·심층)가 비용에 가장 크게 영향을 준다.

---

## 10. 프로젝트 폴더 구조

```
<PES 홈>/
  index.html                 프로젝트 목록 화면
  <slug>/
    project.json             상태의 기준 (단계·라운드·항목·설정·인계 메모)
    library.json             참고자료 (가져온 기존 조사)
    index.html               대시보드
    ask-<단계>-start.html     시작 질문 폼   ask/  폼 명세
    feedback/*.json          웹에서 보낸 답     feedback.log  답 도착 기록
    snapshots/<단계>-R<n>.json 라운드 기록
    rounds/<단계>-R<n>/*.json  서브에이전트 결과
    reports/<단계>/           단계 보고서 (report.md · report.html · eli5.html …)
    out/                     최종 결과물
    shots/                   스크린샷·지도
```

## 11. 플러그인 구조

```
.claude-plugin/   plugin.json, marketplace.json (pes-local)
commands/         /pes:* 명령
skills/core       공통 규칙 (생명주기·CLI·답 받기·AI 점검·토큰·여러 프로젝트)
skills/<단계>      plan · research · analyze · write · verify · publish
agents/           researcher · writer · verifier · reviewer(QC/QA) (결과를 파일로)
scripts/pes.py    상태 CLI          scripts/serve.py  로컬 서버 (127.0.0.1 전용)
templates/        dashboard · ask · _questions · hub · stage-report · eli5 · final-report
questions/        단계별 시작 질문 은행
```

CLI 직접 사용: `python3 -I scripts/pes.py` (도움말), 예: `pes.py status <slug>`, `pes.py digest <slug> research`.

---

## 12. 문제 해결

| 증상 | 해결 |
|---|---|
| 무엇이 문제인지 모르겠다 | `/pes:doctor` (API 접속까지 확인), `/pes:doctor fix` |
| 대시보드가 안 열린다 | `/pes:status <프로젝트>` — 서버를 켜고 연다 |
| 보낸 답이 반영되지 않는다 | `/pes:run <프로젝트>` — 처리 안 한 답부터 처리 |
| "다른 세션이 이 프로젝트를 쓰고 있습니다" | 그 세션을 닫고, Claude에게 "가져와"라고 하면 `--force`로 넘겨받는다 |
| 법령 조회 인증서 오류 (`SELF_SIGNED_CERT_IN_CHAIN`) | 설정의 `NODE_EXTRA_CA_CERTS`에 기관 루트 인증서 파일 |
| 마크다운 한글이 깨진다 | 0.2.0 이후 서버가 UTF-8로 보낸다. 서버 재시작: `/pes:status` |
| 포트가 모두 사용 중 (8760~8764) | 다른 프로그램이나 다른 PES 홈의 서버가 쓰는 중 — `/pes:doctor`로 확인 후 끄기 |

---

## 변경 이력

### 0.15.3 — 2026-11-02
- 웹 보고서: 개조식 목록 들여쓰기가 항목에 따라 어긋나던 문제(여백 규칙 충돌) 수정, 목차에 세부 제목(1.1.1) 들여쓰기.

### 0.15.2 — 2026-11-02
- 최종 웹 보고서가 울산연구원 작성가이드 표기를 그대로 그린다: `○` 주요 항목 · `–` 세부 · `•` 참고 · `※` 비고, `**[표 2-1] 제목**` 캡션, `*자료: …*` 줄 (기존 □ ○ - 와 `<표 n>`·`자료:` 도 계속 지원).

### 0.15.1 — 2026-11-02
- **새 결과 알림**: 열어 둔 대시보드·목록·질문 폼이 10초마다 서버에 새 결과가 있는지 묻고(`/<프로젝트>/version`), 바뀌었으면 바로 새로고침한다. 폼에 입력하던 중이면 새로고침하지 않고 '새 결과가 올라왔습니다 · 새로 보기' 알림만 띄운다. 다른 컴퓨터(Tailscale 등)에서 열어 둔 화면에도 똑같이 동작한다.

### 0.15.0 — 2026-11-02
- **다른 기기에서 보고 답하기**: Tailscale `serve`로 PES 서버(8760)를 내 tailnet에 열면 다른 기기·공유받은 사람도 `https://<기기>.<tailnet>.ts.net/`으로 대시보드·보고서를 본다(`tailscale serve --bg 8760`, 끄기 `tailscale serve --https=443 off`). 다른 사람 컴퓨터는 Tailscale 관리 화면 Machines → 기기 ⋯ → Share 로 초대 링크(1회용)를 보낸다.
- 그 주소에서 **답 보내기·승인**까지 하려면 `pes remote add https://<기기>.<tailnet>.ts.net` (해제 `remote remove`, 목록 `remote list`). 등록하지 않은 주소에서 온 보내기는 계속 거부된다. 원격으로 온 답은 `via: remote`, 보낸 주소(`origin`), Tailscale 사용자(`who`, 있으면)를 기록한다.
- 주의: 허용한 주소로 접속할 수 있는 사람은 승인·다시 열기도 보낼 수 있다.

### 0.14.4 — 2026-11-02
- 할 일·독립 검토 지적이 남은 채 사용자가 승인하면 지우지 않고 `carry_over`로 다음 단계에 넘긴다 — 단계 보고서 「4-1. 남은 일」에 실리고 다음 단계 첫 라운드에서 먼저 처리.

### 0.14.3 — 2026-11-02
- 조사·검증·독립 검토 에이전트 규칙: **HWP·HWPX 파일은 ego-browser에서 클릭하면 브라우저 안에서 열린다** — 한글 첨부(고시문·보도자료·지침·보고서)를 건너뛰지 말고 열어 읽는다(method=browser, note "hwp 열람").

### 0.14.2 — 2026-11-02
- 라운드 이력: 다음 라운드를 시작할 때 끝난 라운드의 변경점 라벨·독립 검토 판정을 단계 이력(`history`)에 한 줄로 남긴다(상세는 `snapshots/<단계>-R<n>.json`). 단계 보고서 「라운드 경과」에 그대로 실린다.

### 0.14.1 — 2026-11-02
- 모든 질문(시작 질문·점검 질문, 선택형·글쓰기형 모두)에 **'기타 · 덧붙일 말'** 칸. 답 파일에는 `<질문 id>__other`, 글에는 `(기타·덧붙임: …)`.
- 대시보드가 질문 부품을 따로 복사해 갖고 있어 질문 폼의 변경(요청사항 칸 등)이 대시보드 점검 질문에 반영되지 않던 문제 — 이제 공용 부품(`_questions.html`) 하나를 함께 쓴다.

### 0.14.0 — 2026-11-02
- **독립 검토(QC/QA)를 모든 단계·모든 라운드에**: 메인의 자체 점검(AI 점검) 뒤에 검토 전문 에이전트 `pes:reviewer`가 따로 본다.
  - QC(규칙대로 만들었나): 주장마다 출처, 원문 확인, 수치·단위·기준일, 충돌·추정 표시, 법령 조·항·호와 시행일.
  - QA(목적에 맞나): 기획 질문에 답했나, 논리 비약, 누락, 사용자 결정과 어긋남.
  - 표본 대조: 결론에 영향이 큰 주장 3~5개는 출처 원문을 직접 열어 확인.
  - 자체 점검이 놓친 것을 따로 적는다. 메인의 결론은 검토원에게 넘기지 않는다(자체 점검 초안은 마지막에 읽음).
  - 명령: `qa-brief <dir> <stage>`(지시문) → `pes:reviewer` → `qa <dir> <stage>`(기록). 대시보드 단계 탭에 '독립 검토' 칸(판정·지적·근거·표본 대조).
  - high 지적은 점검 질문(`[QA]`)이나 다음 라운드 할 일로. 판정 fail이면 승인을 권하지 않음.
- **근거 기록**: 단계 보고서에 항목마다 「근거 출처」 번호(원문 확인 n/m), 출처 없는 항목은 '근거 없음 ⚠'. 「검토 기록」 장(라운드별 자체 점검 → 독립 검토 지적·근거·조치 권고·표본 대조). 단계 요약은 줄마다 `(근거: 조사 #n)`.

### 0.13.0 — 2026-11-02
- **보고서 인쇄**: 단계 보고서·그림 설명(eli5)·최종 웹 보고서를 A4로 인쇄(또는 인쇄 창에서 PDF로 저장).
  - 쪽 번호(아래 가운데 `n / 전체`), 표는 행 단위로 나뉘고 머리글 반복, 제목이 쪽 끝에 홀로 남지 않음, 그림·인용은 쪼개지 않음, 링크는 주소까지 인쇄.
  - 단계 보고서 첫머리에 '단계 · 보고서 · 라운드 · 승인일 · 출력일' 한 줄.
  - 그림 설명에도 '인쇄·PDF' 버튼.
  - 대시보드: 단계 보고서 칸과 산출물 표에 **인쇄** 버튼 — 보고서를 열고 바로 인쇄 창을 띄운다(주소 끝 `?print=1`).

### 0.12.0 — 2026-11-02
- **최종 웹 보고서 템플릿** (`templates/final-report.html`, 명령 `web <dir>`): `out/report.md` → `out/report.html`. 표지(제목·부제·발간일·연구진·기관·발주처·기준일 — `out/cover.json`), 고정 목차(읽는 위치 표시), 요약 상자, `<표 n>` 캡션·`자료:` 줄·숫자 오른쪽 정렬 표, 개조식(□ ○ -), 각주(본문↔각주 왕복 링크, 확인됨/미확인 표시), 부록 출처 목록, 인쇄용 A4(표지 한 쪽, 장마다 새 쪽, 링크 주소 표기).
- `assemble`이 `out/sources.json`(각주 번호별 출처·확인 여부)도 만든다.
- 산출-공유 단계의 web 형식은 이제 Claude가 HTML을 새로 쓰지 않고 이 템플릿을 채운다 — 디자인이 다른 화면과 같고 토큰이 덜 든다.

### 0.11.2 — 2026-11-02
- 질문 폼 '이미 정해진 것' 상자가 비어 보이던 버그: 명세의 `inherited`가 `"주제: …"` 문자열이면 라벨·값이 빠지던 것을 고침 — `{label, value}` 객체와 `"라벨: 값"` 문자열 둘 다 받음.

### 0.11.1 — 2026-11-02
- 글자 크기 전체 축소: 본문 15→14px, 제목 30→24px 등 14px 이상 글자를 약 10% 줄임 (12~13px 보조 글자는 그대로). 그림 설명(eli5)의 큰 제목도 같은 비율로.

### 0.11.0 — 2026-11-02
- **모든 화면 디자인 통일** (Codex 시안 + Claude 간격 시안): 프로젝트 목록 · 대시보드(7개 탭) · 질문 폼 · 단계 보고서 · 그림 설명(eli5)에 같은 상단 표시줄('PES 프로젝트 실행 시스템'), 같은 색·글꼴(Malgun Gothic)·간격 체계(4·8·12·16·24·32·48px).
- 세로 간격: 큰 구역 사이 32(목록 요약→목록 48), 제목→설명 4, 설명→내용 16. 대기 중인 단계·아직 없는 보고서 행은 한 줄로 압축.
- 단계 보고서: 목차·본문 패널, 정렬된 표, 제목 계층. 그림 설명: 그림 카드·여백 정리, 외부 글꼴 의존 제거.
- 질문 폼: 6단계 진행 표시 유지, 선택지·질문 간격 정리.

### 0.10.3 — 2026-11-02
- 질문 폼(시작 질문·점검 질문): 선택형 질문마다 **요청사항** 칸 — 고른 답에 조건이나 부탁을 덧붙일 수 있음. 답 파일에는 `<질문 id>__other`, 글에는 `(요청사항: …)`로 들어감.

### 0.10.2 — 2026-11-02
- 상단 표시줄 부제 '정책 연구 작업실' → '프로젝트 실행 시스템'.

### 0.10.1 — 2026-11-02
- 프로젝트 목록: 폴더 이름 · 시작 · 갱신을 각각 한 줄로.

### 0.10.0 — 2026-11-02
- **화면 디자인 개편** (Codex와 토론해 합의한 시안 적용): 상단 작업 표시줄, 주제가 먼저 읽히는 제목 영역, 밝은 회청색 배경·남색 글자. 색은 파랑=선택·현재 작업, 초록=승인, 주황=재확인으로만 쓰고 상태 글자를 함께 표시. 어두운 모드 지원.
- 글자: 본문 15px, 보조 13px 이상, Windows용 Malgun Gothic·Segoe UI. KPI 숫자 크게, 고정 폭 숫자.
- KPI 카드: 같은 크기 그리드, 카드마다 집계 범위(프로젝트 전체 / ○○ 단계 기준). 출처는 `원문 확인 8/12건`, 0건이면 `확인 대상 없음`.
- 프로젝트 목록: 열 제목이 있는 표, 6단계마다 단계 이름 + 상태 글자(승인·질문 중·진행·대기·재확인), '내 차례' 우선 정렬.
- 대시보드 7개 탭 같은 크기·같은 이름(전체보기·기획·조사·분석-종합·집필·검증·산출-공유), 장식 기호(✓ ⚠ ● ◆ ✕) 대신 글자. 질문 폼도 같은 단계 이름·글꼴.

### 0.9.0 — 2026-11-02
- **서버를 포트 하나로**: 프로젝트마다 8765~8775를 따로 열던 것을 없애고, PES 홈 서버 하나(8760)가 목록(`/`)과 모든 프로젝트(`/<프로젝트>/`)를 서빙. 답 보내기는 `/<프로젝트>/feedback`, 각 프로젝트의 `feedback.log`는 그대로.
- 예전 방식 서버(8765~ 프로젝트 서버, 목록 전용 8760)는 `serve`·`hub`가 알아서 끄고 새 서버로 바꿈. `/pes:doctor`가 남은 것을 [주의]로 알리고 `fix`로 끔.
- 목록 화면의 [서버 켜고 열기] 버튼 제거 — 항상 [대시보드 열기]. 폴더 목록(디렉터리 리스팅)은 보여 주지 않음.
- `stop`은 홈 서버 전체를 끈다 (인자 없이도 됨).
- 0.8 이전에 만든 질문 폼·대시보드의 '보내기'도 그대로 받는다 (보낸 페이지 주소로 프로젝트를 찾음). 다음 `render` 때 새 주소 방식으로 바뀜.

### 0.8.0 — 2026-11-02
- **Claude Desktop 전용 한 줄 설치**: `install-desktop.ps1` · `install-desktop.sh` — Claude Desktop 안에 들어 있는 Claude Code로 플러그인을 등록하고 별도 CLI를 설치하지 않음. 못 찾으면 설정 파일에 마켓플레이스·플러그인만 등록.
- 일반 한 줄 설치도 PATH에 claude가 없으면 Desktop 안의 Claude Code를 먼저 찾음 (`PES_TARGET=auto|desktop|cli`).

### 0.7.3 — 2026-11-02
- README 「OneDrive로 옮기기」를 Windows·macOS로 나누어 다시 씀: 경로 확인, 옮기기, OneDrive 설정, 두 번째 컴퓨터, 섞어 쓰기, 그리고 OS별 `.pes/config.json` 위치·내용·직접 고칠 때 주의(Windows `\\`·`/`), 동기화하지 않는 이유.

### 0.7.2 — 2026-11-02
- kosis·vworld 업그레이드 수정: 자체 `update`가 스킬 갱신 질문을 비대화형으로 받지 못해 **CLI만 바뀌고 스킬은 옛 버전으로 남던 문제** — CLI와 스킬 버전(kosis `VERSION`, vworld 스킬 안 `app/` 바이너리)을 따로 확인하고, 뒤처지면 공식 설치 스크립트로 다시 설치. 업그레이드 후 두 버전을 다시 확인해 보고.
- 설치 점검·`/pes:doctor`에 `CLI 버전 · 스킬 버전` 표시, 다르면 [주의].

### 0.7.1 — 2026-11-02
- ego-browser 스킬 점검: 스킬은 ego lite 앱 안에 있고 `~/.claude/skills/ego-browser`가 앱을 가리키는 링크다. 설치 점검·`/pes:doctor`·업그레이드 결과에 스킬 연결 여부와 버전(앱 안내 버전과 일치하는지)을 표시. 스킬이 없으면 `ego-browser skill` 출력으로 대신 진행.

### 0.7.0 — 2026-11-02
- 설치할 때 이미 있는 도구를 **최신 버전으로 업그레이드**: kosis·vworld(CLI+스킬), korean-law(CLI·MCP), ego lite, Claude Code CLI. `setup.py upgrade`, `/pes:setup`·한 줄 설치에 포함, `PES_NO_UPGRADE=1`로 끌 수 있음. 업그레이드 후 실제 버전을 다시 확인해 결과를 보고.

### 0.6.1 — 2026-11-02
- 저장소 공개(커밋 작성자 이메일은 GitHub noreply로 변경). macOS·Linux 한 줄 설치에 `| bash` 형식 추가, 설치 안내에서 비공개 저장소 로그인 단계 제거.

### 0.6.0 — 2026-11-02
- **한 줄 설치**: Windows `irm …/install.ps1 | iex`, macOS `curl …/install.sh | sh` — 기본 도구 · Claude Code CLI · 플러그인 · 조사 도구 · API 키 화면 · 진단까지.
- `setup.py keys --wait`: 키 화면에서 '마치기'를 누를 때까지 기다림.

### 0.5.2 — 2026-11-02
- README: OneDrive로 PES 홈 옮기기 상세 안내(경로 확인 · 첫 컴퓨터 옮기기 · 두 번째 컴퓨터 지정 · 컴퓨터 바꿔 쓰기 · 충돌 사본 · 되돌리기).
- `/pes:doctor`: 클라우드 동기화 폴더 인식, 충돌 사본(`project-<PC>.json`, `project (1).json`) 감지.

### 0.5.1 — 2026-11-02
- README: Windows용 Claude Desktop 단계별 설치 안내(준비 · Code 탭 · 플러그인 설치 · /pes:setup · 막힐 때).

### 0.5.0 — 2026-11-02
- `/pes:setup`: Git·Python·Node.js(bootstrap, Windows winget / macOS), kosis·vworld·korean-law(CLI·스킬·MCP) 자동 설치, ego lite 설치 안내, API 키 입력 화면(키는 대화로 오지 않음, 등록 전 확인), doctor 로 마무리, 완료 표시.
- `/pes:start`·`/pes:run`이 설치 점검 여부를 먼저 확인.
- 도구 찾기에 Windows npm·LOCALAPPDATA·스킬 안 바이너리 위치 추가.

### 0.4.1 — 2026-11-02
- README: Windows용 Claude Desktop(Code 탭) 사용 안내 — Git Bash 필수, PATH·환경변수 설정 위치, Cowork 모드 비권장.
- 배포 준비: 스킬 문서에서 이 Mac 전용 경로(`~/.local/bin`, 인증서 파일)를 없애고 `which`(도구 경로 찾기, Windows 포함)와 Claude Code 설정 env를 쓰도록 변경.
- `.gitignore`, GitHub 설치·업데이트·배포 방법을 README에 추가.

### 0.4.0 — 2026-11-02
- 조사할 때 **사용자 제공 링크·파일**을 받는다 (조사 시작 질문, 대시보드 추가 요청). 출처에 '사용자 제공' 표시, 열지 못하면 다시 묻는다.
- README 정리 (설치·사용법·Windows·문제 해결).

### 0.3.0 — 2026-11-02
- 토큰 절약: 서브에이전트 결과를 파일로, `digest`(점검용 압축 요약)·`show`(부분 보기)·`note`(인계 메모), 참고자료를 `library.json`으로 분리, 대시보드 데이터 축소.
- 조사 모델 선택(혼합/Opus/Sonnet), 조사 깊이에 비용 표시.
- `/pes:doctor`: API 실제 연결 확인(`--net`), `LAW_OC`·인증서 경로 점검.

### 0.2.0 — 2026-11-02
- PES 홈(`~/pes-projects`) 도입, `/pes:home`으로 위치 변경 시 전체 이동.
- 프로젝트 목록 화면(`/pes:list`), `/pes:run` 프로젝트 선택, 세션 잠금.
- `/pes:doctor` 진단. Windows 대응(서버 실행·종료, 브라우저 열기, 경로).
- 대시보드: 전체 보기(지금 할 일·단계별 진행 표·산출물 표), 범위가 표시된 숫자, 승인된 단계 다시 열기, 정리된 팝업, 이모지 정리, 같은 크기의 단계 카드.
- 단계 보고서(웹·eli5·마크다운 등), 서버 UTF-8 응답.

### 0.1.0 — 2026-11-02
- 6단계 라운드 진행, 웹 질문 폼·대시보드·답 자동 수신, 기존 research-loop 조사 가져오기.
