---
name: research
description: PES 조사 단계 — 기획에서 넘어온 조사 항목을 서브에이전트(pes:researcher)로 병렬 조사하고 ego-browser·WebSearch·KOSIS·korean-law(법령)·vworld(공간정보)를 규칙대로 쓴다. 라운드마다 AI 점검(충돌·근거 부족·빈칸)을 붙이고 승인받는다. pes:core 를 먼저 로드한다.
---

# 조사 (research)

## 시작 질문 전에 환경 확인 (조용히)

`$PES doctor`의 「도구」 결과로 판단한다 (도구 경로는 `$PES which <도구>` — PATH에 없어도 사용자별 설치 위치까지 찾는다).
1. ego-browser: 없으면 ego-browser 스킬의 설치 안내.
2. KOSIS: 없으면 `npm install -g @clazic/kosis` (인증서 오류가 나면 `--cafile "$NODE_EXTRA_CA_CERTS"` 추가). 키 없으면 https://kosis.kr/openapi/ 안내.
3. 법령: korean-law와 `LAW_OC` → 없으면 아래 「법령」 설치 (한 줄 알린 후)
4. vworld: 키까지 있으면 `vworld_install` 질문 삭제. **없으면 설치하지 말고 시작 질문의 `vworld_install`로 묻는다**
5. 결과를 질문 desc에 반영 ("설치 필요", "API 키 필요").

`ask-prep <dir> research` → 다듬기(기획에서 정해진 범위를 inherited로) → 받은 답(도구·통계·법령 범위·병렬·모델)은 `pending`이 알려 준 답 파일(`feedback/*.json`)의 answers를 읽어 `set <dir> research settings <파일>`로 저장한다.

## 사용자 제공 링크·자료

- 출처: 시작 질문 `user_links`(settings) 또는 대시보드 '추가 요청'의 `조사 링크: 주소 | 항목 | 메모` 줄.
- 줄마다 파싱해 항목의 `user_links`에 `{"url": 주소 또는 파일 경로, "memo": …, "added": 날짜, "status": "todo"}`로 넣는다(제안 파일 `{"id": N, "user_links": [...]}`을 `merge` — 같은 url은 한 번만 들어간다). 항목 번호가 없으면 내용(제목·메모·주소 도메인)에 맞는 항목에 배정하고, 맞는 항목이 없으면 새 항목(new)으로 만든다. 배정 결과를 변경점에 한 줄(`show <dir> research --fields changes`로 읽은 줄에 더해 `set <dir> research changes <파일>`).
- 링크가 붙은 항목은 그 라운드의 할 일이 된다: 같은 제안에 `request` "사용자 제공 링크 확인: 주소 | 메모"를 적고 done이면 `status` deepen으로 담는다.
- 서브에이전트 지시문 [사용자 제공 링크]에 넣는다 — **반드시 열어 읽고**(웹은 ego-browser, 로컬 파일은 파일·PDF를 읽는 도구), sources에 `note: "사용자 제공"`과 실제 method로 남긴다. 열 수 없으면(로그인·삭제·권한) open_questions에 "사용자 제공 링크 열지 못함: 주소 — 이유".
- 병합 후 user_links의 status를 done/failed로 바꾼다: 결과의 sources(note "사용자 제공")와 open_questions로 열었는지 보고 `{"id": N, "user_links": [{"url": 주소, "status": "done"}]}`(열지 못했으면 `"failed"`)을 `merge`한다(url이 같으면 status만 바뀐다, depth는 그대로). failed는 AI 점검 질문(weak)으로 물어 다른 주소나 파일을 받는다.
- http(s)가 아니고 존재하지 않는 경로면 처리하지 않고 점검 질문으로 확인한다.

## 라운드

- 할 일 항목(new·deepen·revise·browser)만 조사. status=deepen + links.library가 있는 항목은 **기존 내용을 이어받아** 기획의 question에 맞게 보완하고, 원문 미확인 출처와 conflicts를 다시 확인한다.
- parallel=auto: 할 일 항목이 2개 이상이면 항목당 `pes:researcher` 서브에이전트 1개, 한 번에 최대 5개, **한 메시지에 함께** 보낸다. sequential이면 메인이 직접. max면 + 승인 전 `pes:verifier`.
- 서브에이전트는 결과를 제안 파일 `<dir>/rounds/research-R<n>/<id>.json`에 쓰고 한 줄만 돌려준다 → `merge <dir> research <dir>/rounds/research-R<n>/*.json` → **`digest <dir> research --round <n>`으로** 항목 사이 충돌을 찾아 conflicts에 기록(해당 항목의 `conflicts`를 제안 파일에 담아 `merge`) → 변경점(`set <dir> research changes`) → AI 점검(`set <dir> research review`) → render. 결과 파일 본문을 통째로 읽지 않는다(필요한 항목만 `show`).
- **조사 모델** (settings.model): 설정 값 `sonnet`은 가벼운 모델, `opus`는 강한 모델을 고르는 이름이다(환경별 실제 모델은 어댑터 노트). `mixed`(기본) = 기존 조사를 이어받는 항목(status=deepen이고 links.library 있음)과 단순 수집·원문 확인은 가벼운 모델(`"model": "sonnet"`), 새 조사·법령 해석·판단이 많은 항목(울산 진단·정책 대안 등)과 revise는 강한 모델(`"model": "opus"`). 설정이 `opus`·`sonnet`이면 전부 그것. 서브에이전트를 띄울 때 모델로 정하고, 결과 제안 파일에 `"model"` 필드로 남긴다(`merge`가 보존; 변경점에 모델별 항목 수 한 줄).
- 실패한 항목은 그 항목만 재시도하거나 status=failed로 두고 알린다.

### 서브에이전트 지시문 (대화 맥락을 모른다 — 빠짐없이)

```
[전체 주제] <topic> / 목적: <purpose> / 독자: <audience>
[담당 항목] 조사 #<id> <title>
[조사 질문] <question>   [연결된 목차] <chapter 제목들>
[이번 요청] <new: 조사 질문 | deepen: 무엇을 더 | revise: 수정 지시 | browser: 원문 확인>
[이미 아는 것] <summary (재사용 항목이면 기존 summary·details 요지)>
[이미 확인한 출처] <url 목록> — 다시 확인하지 말 것 (원문 미확인 출처는 확인 대상이면 명시)
[사용자 제공 링크] <user_links 중 todo — 주소 | 메모> (반드시 열어 읽을 것, 출처 note "사용자 제공")
[범위 밖] 다른 항목: <title 목록>
[도구 규칙] <아래 표에서 settings.tools 열> + settings.stats·law_range·press_range
[저장] 스크린샷·지도는 <dir>/shots/<id>-*.png
[결과 파일] <dir>/rounds/research-R<n>/<id>.json  (pes:researcher 형식 JSON을 여기에 쓰고, 메시지는 한 줄만)
```

## 도구 규칙

| 단계 | mixed | browser | websearch |
|---|---|---|---|
| 출처 탐색 (국내) | ego-browser로 네이버(우선)·구글 | ego-browser | WebSearch |
| 출처 탐색 (해외) | WebSearch | ego-browser | WebSearch |
| 본문 읽기 / DB·검색폼 / 로그인 사이트 | ego-browser | ego-browser | WebFetch |
| 사실 확인 | ego-browser (원문 대조, 필요 시 스크린샷) | ego-browser | WebFetch |
| 통계 | settings.stats에 따름 | 〃 | 〃 |
| 법령·조례·행정규칙·판례·해석례 | korean-law (항상) | 〃 | 〃 |
| 위치·좌표·용도지역·지적·공시지가·지도 | vworld (항상) | 〃 | 〃 |

- WebSearch는 국내 자료가 약하다. 국내 자료는 브라우저로.
- **HWP·HWPX 파일**: ego-browser에서 링크를 클릭하면 브라우저 안에서 바로 열려 읽을 수 있다. 고시문·보도자료 첨부·지침·의견서·연구보고서가 한글 파일이어도 '내려받기 불가'로 건너뛰지 말고 열어 읽는다. 출처 method는 browser, note에 "hwp 열람". 서브에이전트 지시문 [도구 규칙]에도 이 줄을 넣는다.
- **KOSIS**: kosis 스킬 로드 → `references/rules.yaml`·`LEARNINGS.md` 먼저 → `s`→`m`→`d`. 계산은 kosis(`--change`, `--ratio`, `--sort`)에 맡기고, 스크립트로 가공했으면 conflicts에 "AI 가공"을 남긴다. 새로 알게 된 것은 `kosis rules add`.
- 폴백: ego-browser 없음 → WebSearch+WebFetch, warnings에 "국내 자료 제한적". KOSIS 키 없음 → https://kosis.kr/openapi/ 안내.

### 법령 (korean-law)
```bash
L="$($PES which korean-law)"   # LAW_OC·NODE_EXTRA_CA_CERTS는 실행 환경의 환경변수에서 온다
$L "민간임대주택에 관한 특별법 제22조"      # 조문
$L search_law --query "<법령명>"            # lawId·MST
$L get_law_text --mst <MST> --jo "부칙"     # 부칙
$L help <도구>                              # search_all, search_decisions, legal_research, legal_analysis, ordinance_radar, get_annexes
```
- 법령 항목이 있는 라운드는 승인 전 `legal_analysis --mode verify_citations`로 인용 조문을 검증해 verify에 남긴다. 출처 method=`law`.
- MCP(`mcp__korean-law__*`)가 있으면 써도 된다.
- 없으면 설치: `npm install --ignore-scripts --omit=optional -g korean-law-mcp` (인증서 오류가 나면 `--cafile "$NODE_EXTRA_CA_CERTS"`). `LAW_OC`는 사용자가 줄 때만 실행 환경 설정의 환경변수로 등록하고(환경별 위치는 어댑터 노트) 원문을 채팅에 다시 쓰지 않는다. 키 발급: https://open.law.go.kr

### 공간정보 (vworld)
```bash
V="$($PES which vworld)"
$V geocode "울산광역시 남구 야음동"
$V data layers --search 개발제한 ; $V data <레이어ID> --geom-filter "POINT(x y)"
$V data LP_PA_CBND_BUBUN --geom-filter "POINT(x y)"   # 필지 → pnu
$V ned --list ; $V ned <오퍼레이션> --pnu <PNU>
$V staticmap "<x,y>" --zoom 14 --size 800,600 -o <dir>/shots/<id>-1.png
```
- 쓰기 전 vworld 스킬의 LEARNINGS.md. 출처 method=`vworld`.
- 설치(사용자가 '설치'를 골랐을 때만): vworld 스킬의 설치 안내를 따른다 (macOS·Linux는 install.sh를 받아 내용 확인 후 실행, Windows는 스킬의 Windows 안내). 키가 없으면 안내: vworld.kr 로그인 → 오픈API → 인증키 신청(무도메인, 활용 API 전체) → 키를 알려 주면 `vworld config add-key <KEY>` → `test-keys`, INVALID_KEY는 `remove-key`.

## AI 점검 초점

- `conflict`: 항목 사이 수치 차이(지구 수·면적·호수 등) → 기준 선택 질문
- `weak`: 원문 확인 비율이 낮은 항목, 검색 요약 기준 수치, AI 가공 통계
- `blank`: 기획 question에 답하지 못한 항목, 연결된 chapter에 필요한데 없는 자료
- `stale`: 오래된 통계·법령
- `decide`: 시계열 단절, 공식 집계 부재 시 자체 집계 방식
- 마지막: "다음 라운드에서 더 할 것"(제안에서 추천 2~3개) 또는 충분하면 "조사를 승인하고 분석으로 넘어갈까요?"

## 승인 전 마무리

0. 마지막 라운드의 **독립 검토(QC/QA)**가 `qa`로 기록돼 있고, high 지적이 처리됐는지(고쳤거나 이유를 남겼는지) 확인한다 (pes:core 「독립 검토」).

1. parallel=max면 pes:verifier로 핵심 주장 검증. 법령 인용 verify_citations.
2. 남은 conflicts·원문 미확인 비율을 단계 요약에 정직하게 적는다 (`set <dir> research summary <파일>`).
3. `approve <dir> research` → pes:analyze 시작 질문.

## 단계 보고서

승인 직후 `pes:core` 「단계 보고서」대로 `report <dir> research` + eli5 + 선택한 형식.
