---
name: core
description: PES(Project Execution System) 공통 규칙 — 프로젝트 폴더·project.json·pes CLI·단계 생명주기(시작 질문 폼→라운드→AI 점검→답 받기→승인)·웹 대시보드 답 수신. pes 의 단계 스킬(plan·research·analyze·write·verify·publish)을 쓰기 전에 항상 먼저 로드한다.
---

# PES 공통 규칙

한 프로젝트를 **6단계**로 진행한다. 단계마다 같은 라운드를 돈다.

```
기획(plan) → 조사(research) → 분석·종합(analyze) → 집필(write) → 검증(verify) → 산출·공유(publish)

단계 하나:  시작 질문 폼 ─▶ R1 ─▶ AI 점검 ─▶ 사용자 답 ─▶ R2 ─▶ … ─▶ [단계 승인] ─▶ 다음 단계
```

- **모든 질문·피드백·승인은 웹(로컬 대시보드·질문 폼)으로 받는다.** AskUserQuestion은 서버를 띄울 수 없을 때만.
- 결과 본문은 채팅에 늘어놓지 않는다. 대시보드에 두고 채팅에는 3~5줄만.
- 상태는 전부 `project.json`에 있다. 대화가 압축돼도 `pes status`만 보면 이어갈 수 있어야 한다.

## CLI

```bash
PES="python3 -I ${CLAUDE_PLUGIN_ROOT}/scripts/pes.py"   # Windows에서 python3가 없으면 py -3 -I
```
`${CLAUDE_PLUGIN_ROOT}`가 비어 있으면 이 스킬의 Base directory 기준 `../../scripts/pes.py`를 쓴다. 명령 목록은 `$PES` (인자 없이) 실행.

| 명령 | 하는 일 |
|---|---|
| `init <dir> --topic "…" [--import <research-loop 폴더>]` | 새 프로젝트. 기획부터. `--import`는 기존 조사를 참고자료(library)로 |
| `ask-prep <dir> <stage\|resume>` → `ask <dir> <spec>` | 질문 은행 복사 → (Claude가 다듬음) → 폼 HTML `ask-<id>.html` |
| `round-start <dir> <stage>` | 라운드 +1, 현재 단계로 지정, changes 비움 |
| `merge <dir> <stage> <결과.json…>` | 서브에이전트 결과 병합 (출처 url 중복 제거·누적, open_questions→제안, depth+1) |
| `render <dir> [stage]` | 스냅샷 + 대시보드 `index.html` |
| `approve <dir> <stage>` | 승인 → 다음 단계 asking. 기획 승인 시 조사 항목 자동 생성 |
| `list [projects]` · `hub [projects]` | 프로젝트 목록 (채팅용 · 화면 8760) |
| `which <도구>` | 도구 경로 (PATH + 사용자별 설치 위치, Windows 포함) |
| `doctor [dir] [--fix] [--json]` | 진단 (환경·도구·키·포트·프로젝트 상태·잠금·답·보고서·연결). 명령이 이상하게 실패하면 먼저 실행 |
| `lock <dir> [--force]` · `unlock <dir>` | 세션 표시 (PES_OWNER) |
| `digest <dir> <stage> [--round N]` · `show <dir> <stage> [id…] [--fields a,b]` | 점검용 압축 요약 · 필요한 부분만 보기 |
| `note <dir> "메모"` | 인계 메모 (새 세션이 먼저 읽음) |
| `report <dir> <stage>` | 단계 보고서 생성·등록 (reports/<stage>/: report.md·report.html·eli5.html·기타 형식) |
| `reopen <dir> <stage>` | 앞 단계 다시 열기, 뒤 단계에 '다시 확인 필요' |
| `status` / `pending` / `mark <파일…>` | 요약 / 처리 안 한 답 / 처리 완료 표시 |
| `chat <dir> <stage> "텍스트" [kind]` | 채팅으로 받은 지시도 기록 (타임라인이 끊기지 않게) |
| `assemble <dir>` | 집필 원고 → `out/report.md` (각주 번호 정리) |
| `serve` / `stop` / `watch` | 로컬 서버(127.0.0.1:8765~) / 종료 / Monitor 명령 |

## 프로젝트 폴더

위치: PES 홈(기본 `~/pes-projects`, 아래 「PES 홈」)의 `<slug>/` (slug는 영문 소문자-하이픈).
```
project.json      단일 진실 원천 (stages.<단계>.items/review/settings/…, library, processed)
index.html        대시보드 — 첫 화면 「전체 보기」(지금 할 일·단계별 라운드 흐름·산출물), 단계 탭(AI 점검·타임라인·항목×라운드·항목·승인) ← 사용자가 보는 곳
ask-<id>.html     질문 폼 / ask/<id>.json 질문 명세
feedback/<stage>-R<n>-<시각>.json   받은 답 (kind·text·answers)     feedback.log  수신 로그
snapshots/<stage>-R<n>.json          라운드 스냅샷                  shots/ out/ library/
```

## project.json 편집

CLI가 없는 변경(항목 추가·수정, settings, review, changes, summary)은 Python으로 읽고 써서 구조를 지킨다:
```bash
python3 -I - "$DIR" <<'EOF'
import json, sys; from pathlib import Path
f = Path(sys.argv[1]) / "project.json"; p = json.loads(f.read_text())
st = p["stages"]["plan"]
# … 수정 …
f.write_text(json.dumps(p, ensure_ascii=False, indent=1))
EOF
```
항목 스키마 (모든 단계 공통):
```json
{"id": 1, "title": "", "kind": "rq|chapter|topic|issue|table|insight|section|claim|output",
 "question": "", "status": "new|deepen|revise|browser|done|removed|failed", "request": "",
 "depth": 0, "updated_round": 0, "summary": "", "details": "마크다운",
 "sources": [{"title": "", "url": "", "method": "search|fetch|browser|kosis|law|vworld", "date": "", "note": ""}],
 "stats": [], "shots": [], "confidence": "high|medium|low", "conflicts": [], "verify": null,
 "links": {"plan": [3], "research": [2, 5]}, "verdict": "", "order": 1, "path": ""}
```
- `links`는 **근거 연결(추적선)**: 원고 → 쟁점 → 조사 항목 → 출처. 대시보드에서 양방향으로 보인다. 다음 단계 항목을 만들 때 반드시 채운다.
- method가 browser·kosis·law·vworld인 출처만 "원문 확인"으로 친다.

## 토큰 절약 (항상)

- **project.json·library.json·결과 파일을 통째로 읽거나 출력하지 않는다.** 보기는 `status`·`digest`·`show <단계> [id] --fields a,b`, 고치기는 짧은 Python으로 필요한 필드만.
- AI 점검은 `digest <dir> <단계> --round <n>` 출력으로 한다(요약 첫 줄·수치·충돌·신뢰도·출처 확인율). 본문이 꼭 필요한 항목만 `show`.
- 서브에이전트는 결과를 `<dir>/rounds/<단계>-R<n>/<id>.json`에 쓰고 한 줄만 돌려준다.
- 단계 승인 후: 대화에서 나온 결정·선호 중 파일에 없는 것을 `note <dir> "…"`로 남기고, 사용자에게 "대화를 비워도(/clear) `/pes:run <slug>`로 이어집니다"를 한 줄로 알린다. 새 세션은 `status`의 인계 메모부터 읽는다.
- 확인용 스크린샷·브라우저 점검은 화면을 바꿨을 때만.

## PES 홈 (프로젝트 위치)

- 모든 프로젝트는 **PES 홈** 아래 `<홈>/<slug>/`에 만든다. 기본 `~/pes-projects` (Windows: `C:\Users\<이름>\pes-projects`). 작업 폴더와 상관없다.
- 확인: `$PES home`. 우선순위: 환경변수 `PES_HOME` > `~/.pes/config.json`의 home > 기본값.
- 바꾸기: `$PES home <새 폴더>` — 서버를 끄고 **모든 프로젝트와 목록 화면을 새 폴더로 옮긴 뒤** 설정을 저장하고 켜져 있던 서버를 다시 켠다. 같은 이름이 새 폴더에 있거나 다른 세션이 쓰는 프로젝트가 있으면 아무것도 옮기지 않고 멈춘다. 옮긴 뒤 Monitor는 새 경로로 다시 건다.
- `<dir>` 자리에 프로젝트 이름(slug)만 써도 홈 아래에서 찾는다 (`$PES status private-rental-promotion-zones`).

## Windows

- Python: `python3`가 없으면 `py -3`. 서버는 백그라운드로 분리되어 뜨고 `stop`은 pid로 끈다(pkill 불필요).
- 브라우저 열기는 `open`/`start` 대신 `$PES open`.
- Monitor 명령(`tail -F … | grep --line-buffered`)은 Git Bash에서 그대로 쓴다.

## 여러 프로젝트

- **세션 표시(PES_OWNER)**: 세션 처음에 이 세션 ID를 정해(모르면 `uuidgen`으로 한 번 만들고 대화 동안 같은 값) 모든 pes 호출에 `PES_OWNER=<ID>`를 붙인다. 예: `pes(){ PES_OWNER=<ID> python3 -I <플러그인>/scripts/pes.py "$@"; }`
- 프로젝트를 열면 `lock <dir>`. 쓰기 명령은 다른 세션이 2시간 안에 기록한 프로젝트면 거부된다(종료 코드 3) — 억지로 풀지 말고 사용자에게 알린다. 그 세션을 닫았다고 하면 `lock <dir> --force`.
- 한 세션에서는 한 프로젝트만 진행한다. 다른 프로젝트는 다른 Claude Code 세션(터미널 탭)에서 `/pes:run <폴더>`.
- `list` = 채팅용 목록, `hub` = 목록 화면(127.0.0.1:8760, 프로젝트 서버 켜기 버튼 포함). 프로젝트 대시보드를 다시 만들 때마다 목록 화면도 갱신된다.

## 단계 생명주기 (모든 단계 스킬이 따른다)

1. **시작 질문** (status=asking): `ask-prep` → 명세 다듬기(이미 정해진 것은 지우고 `inherited`로, `_when`이 안 맞는 질문 삭제, 추천을 주제에 맞게) → `ask` → `serve` → 브라우저로 연다 → Monitor. 채팅엔 한 줄: "질문 폼을 열었습니다. 추천 답이 골라져 있으니 바꿀 것만 바꾸고 보내 주세요."
2. **답(kind=stage_start)** → answers를 `stages.<단계>.settings`에 저장 (기획 답은 `p.settings`에도) → `mark`.
3. **라운드**: `round-start` → 단계 스킬대로 작업 → 결과 병합(`merge` 또는 직접) → `changes`에 3~5줄(각 줄 `짧은 라벨: 내용` 형식 — 대시보드 팝업에서 라벨·내용 두 칸으로 보인다) → **AI 점검 작성** → `render` → 사용자에게 3~5줄 + "대시보드에 R{n} 결과와 점검 질문 {k}개를 올렸습니다."
4. **답(kind=review/feedback)** → 아래 「답 해석」대로 항목 status/request 갱신 → `mark` → 계획 3~5줄을 채팅에 밝히고 바로 다음 라운드. 할 일 항목(new·deepen·revise·browser)만 작업, done은 건드리지 않는다.
5. **승인(kind=approve)** → 단계 스킬의 「승인 전 마무리」 → `approve` → **단계 보고서**(아래) → 다음 단계의 1로. 사용자가 채팅으로 "승인"이라고 해도 같다(`chat … approve`로 기록).
6. **다시 열기(kind=reopen)**: 대시보드의 승인된 단계 탭에서 '이 단계 다시 열기' + 고칠 내용이 온다 → `reopen <dir> <단계>` → `mark` → 고칠 내용을 그 단계 항목의 request/status로 반영 → `round-start` → 라운드(3) → 다시 승인되면 단계 보고서를 새로 만들고, 뒤 단계는 '다시 확인 필요' 항목부터 처리한다.
7. 앞 단계를 바꿔야 하면 `reopen` 후 그 단계 라운드를 돌리고, 영향 받는 뒤 단계 항목에 `revise`를 건다.

## 단계 보고서 (승인할 때마다)

단계를 승인하면 그 단계의 결과를 독립 보고서로 남긴다: 기획보고서·조사보고서·분석·종합보고서·원고 검토본·검증보고서·산출 보고서.
형식은 `p.settings.stage_reports` (기획 시작 질문, 기본 `html, eli5, md`).

1. `stages.<단계>.summary`를 5~8줄로 채운다 (이 단계에서 정한 것·찾은 것·남은 문제). 보고서 첫 장이 된다.
2. `report <dir> <단계>` → `reports/<단계>/report.md`(원본)·`report.html`(웹 보고서: 목차·표·출처 확인됨/미확인).
3. **eli5** (형식에 있으면): `eli5:eli5` 스킬 원칙대로 — 큰 그림, 적은 글, 비유 하나로 일관. 이 단계의 결과를 처음 보는 사람이 1분에 이해하게. `reports/<단계>/eli5.json`을 쓰고 `report`를 다시 실행 → `eli5.html`.
   ```json
   {"title": "큰 제목", "lead": "한 줄",
    "scenes": [{"step": "그림 1 · 무엇을", "big": "장면 제목", "svg": "<svg viewBox=…>…</svg>", "say": "한 문장 (**강조**)"},
               {"step": "그림 2", "big": "…", "emoji": "🏗️ ➜ 🏘️", "alt": "그림 설명", "say": "…"}],
    "cards_title": "한눈에", "cards": [{"emoji": "📍", "big": "숫자·핵심어", "small": "짧은 설명"}],
    "takeaway": "끝 한 줄 (**강조**)", "words": [{"w": "어려운 말", "plain": "쉬운 말"}]}
   ```
   - 장면 3~6개. svg는 직접 그린 단순 도형(viewBox 지정, 글자 큼, 색 4개 이내), 아니면 emoji 줄. 문장은 장면당 한두 문장.
   - 숫자는 보고서에 있는 값만 쓴다(출처 있는 값). 비유가 사실을 왜곡하지 않게.
4. **hwpx·docx·pdf** (형식에 있으면): `report.md`를 입력으로 해당 스킬(`anthropic-skills:hwpx-uri`·`docx`·`pdf`)을 써서 같은 폴더에 `report.<형식>`으로 만든 뒤 `report`를 다시 실행(등록).
5. 대시보드 그 단계 탭 맨 위에 '📑 보고서' 칸이 생긴다. 채팅엔 보고서 경로 한 줄. 사용자가 공유를 원하면 artifacts로 게시해 링크를 준다.
6. 단계를 다시 열어 고친 뒤 재승인하면 보고서도 다시 만든다(덮어씀, 라운드 표시가 갱신됨).

## 답 받기 (자동)

- 서버: `$PES serve <dir>` (이미 떠 있으면 주소만). 브라우저는 `$PES open <dir|주소>` (macOS·Windows 공통, 사용자 기본 브라우저).
- Monitor (timeout_ms 1800000, 만료되면 다시 건다): `$PES watch <dir>`가 출력하는 명령 —
  `tail -n0 -F <dir>/feedback.log | grep --line-buffered FEEDBACK`
  줄 형식: `FEEDBACK <stage> R<n> <kind> <json 경로>` (kind: stage_start | review | feedback | approve | resume | reopen)
- 알림이 오면 그 json을 읽어 처리하고 `mark`. 세션을 다시 시작했으면 `pending`부터 처리한다.
- 사용자가 채팅으로 지시하면 `chat`으로 기록한 뒤 같은 방식으로 처리.

## AI 점검 (라운드마다, render 직전)

결과를 스스로 점검해 **다음 라운드 전에 사용자가 정해야 할 것**을 `stages.<단계>.review`에 질문으로 쓴다. 대시보드 맨 위 'AI 점검' 칸에 폼으로 뜨고, 항목 피드백과 함께 한 번에 온다(kind=review).

| gap.kind | 찾는 것 |
|---|---|
| `conflict` 충돌 | 출처·항목 사이 수치·사실 차이 (⚠) |
| `weak` 근거 부족 | 원문 미확인, 출처 1개, AI 가공 수치 |
| `blank` 빈칸 | 목적·기획 대비 빠진 것, 연결(links)이 끊긴 것, 표의 누락 |
| `stale` 오래된 자료 | 기준일이 오래된 통계·법령 |
| `decide` 결정 필요 | 해석·서술 방향이 갈림, 시계열 단절 |
| `scope` 범위 이탈 | 주제와 관계가 약한 내용 |

```json
"review": {"round": 2, "summary": "한 줄", "questions": [
  {"id": "g-1", "label": "질문", "type": "single|multi|text", "required": false, "other": true,
   "gap": {"kind": "conflict", "item": 2, "detail": "실제 수치·출처 수를 적은 근거 한 줄"},
   "options": [{"value": "a", "label": "…", "desc": "…", "recommended": true}]}]}
```
- 3~8개, 중요한 것부터. 선택지 2~4개, 추천 1개(미리 선택됨 → 동의하면 보내기만). 마지막은 보통 "다음 라운드에서 더 할 것"(multi) 또는 "이 단계를 승인할까요?"(충분하면).
- detail과 선택지에 사실이 아닌 것을 쓰지 않는다. `review.round`는 현재 라운드와 같아야 표시된다.
- 조건부 질문은 `show_if: {"id": "<질문 id>", "in": ["값"]}`.

## 답 해석

| 받은 것 | 처리 |
|---|---|
| "N번 심화: …" | status=deepen, request=지시 |
| "N번 삭제" / "N번 복구" | removed / done |
| "N번 수정: …" | status=revise, request=지시 |
| "N번 원문 확인" | status=browser |
| "조사 링크: 주소 \| 항목 \| 메모" | 조사 단계 「사용자 제공 링크」 절차 (그 항목 user_links에 추가, 할 일로) |
| "OO 추가" | 새 항목 id=max+1, status=new |
| "제안 K 진행" | suggestions[K-1]을 새 항목으로 |
| review answers | 질문마다: 원문 확인→browser, 범위에서 빼기→removed, 기준 선택→해당 항목 revise(conflicts 정리 지시), 추가 조사→new 항목 |
| kind=approve | 승인 절차 (5) |
| kind=reopen | 다시 열기 절차 (6) |
| 모호할 때만 | 다음 라운드 점검 질문으로 되묻는다 (채팅으로 묻지 않는다) |

## 공통 작업 규칙

- **ego-browser**: 쓰기 전 ego-browser 스킬 로드 → `ego-browser skill` 출력대로. 작업 하나에 TaskSpace 하나, 끝나면 `finish({keep:[]})`. 보안문자(CAPTCHA)는 풀지 않고 사용자에게 넘긴다. 브라우저 알림 프롬프트에 1분 이상 기다리지 않는다. 쿠키·캐시·스토리지는 지우지 않는다. 비밀번호는 받지 않는다.
- 서브에이전트가 끝나면 남은 Space를 확인해(`listTaskSpaces()`) 노는 Space를 닫는다.
- API 키는 사용자가 줄 때만 등록하고 채팅에 원문을 다시 쓰지 않는다.
- 회사·기관 망에서 Node 도구(korean-law·kosis 설치 등)가 `SELF_SIGNED_CERT_IN_CHAIN`을 내면, 루트 인증서 파일 경로를 Claude Code 설정 env의 `NODE_EXTRA_CA_CERTS`에 넣는다 (macOS: `security find-certificate -a -p /Library/Keychains/System.keychain /System/Library/Keychains/SystemRootCertificates.keychain > ~/.config/macos-ca.pem`; Windows: 기관에서 받은 루트 인증서 .pem). `$PES doctor --net`으로 확인.
- 단계별 방법은 `pes:plan`, `pes:research`, `pes:analyze`, `pes:write`, `pes:verify`, `pes:publish` 스킬.
