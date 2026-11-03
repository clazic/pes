# WebMCP를 PES에 적용할지 검토 (2026-11-04, Claude)

## 1. WebMCP란 (확인한 사실)

- 웹 페이지가 **AI 에이전트가 부를 수 있는 도구**를 직접 내놓는 브라우저 API. 화면을 긁고 클릭하는 대신, 페이지가 "이 도구를 이 입력으로 부르면 이 일을 한다"를 선언한다.
- 명령형 API: `document.modelContext.registerTool({ name, description, inputSchema(JSON Schema), execute, annotations })`. 등록 해제는 `AbortSignal`. 에이전트 쪽은 `getTools()`, `executeTool()`, `toolchange` 이벤트.
- 주석(annotations): `readOnlyHint`, `untrustedContentHint`(결과에 신뢰할 수 없는 내용이 섞임 → 프롬프트 주입 주의), `consequentialHint`(중대한 동작 → 브라우저·에이전트가 사용자 확인을 강제할 수 있음), `debugging`.
- 선언형 API(보고된 내용, 사양 미완성): HTML 폼에 `toolname`, `tooldescription`, `toolparamdescription` 속성을 달면 브라우저가 폼을 도구로 만든다. `toolautosubmit`은 클릭 없이 제출.
- 보안: 도구는 **사용자의 로그인된 탭 권한으로** 실행된다. 기본은 같은 출처만, 다른 출처는 `exposedTo`/`fromOrigins`와 Permissions Policy `allow="tools"`가 필요.
- 상태: Chrome **origin trial**(Chrome 149~156 보고), 이름이 `navigator.modelContext` → `document.modelContext`로 바뀌는 중(2026-07). W3C Community Group 초안이지 표준이 아니다. Edge는 플래그, Firefox·Safari는 미정.
- 실제로 부르는 에이전트: 2026-08 기준 보고로는 **주요 에이전트(Claude, ChatGPT, Gemini 등)가 아직 실사용하지 않는다**. Gemini in Chrome이 첫 사용처로 예상됨. (제3자 글 기준, 미확인)

출처: [Chrome WebMCP imperative API (2026-05-18 게시, 2026-10-16 갱신)](https://developer.chrome.com/docs/ai/webmcp/imperative-api?hl=en), [WebMCP in 2026: The API Moved (제3자, 2026-08)](https://mcpplaygroundonline.com/blog/what-is-webmcp), [What Is WebMCP (제3자)](https://www.mcpbundles.com/guides/what-is-webmcp).

## 2. PES에서의 쓰임새

PES의 기본 통로는 **PES API(HTTP)** 다. 방식 A(PES 안의 OpenCode)와 방식 B(터미널의 Claude·Codex)의 에이전트는 브라우저 밖에 있으므로 WebMCP를 쓸 수 없다. WebMCP는 **세 번째 통로 — 브라우저 안에서 사용자 곁에 있는 에이전트**를 위한 것이다.

| 쓰임 | 예 | 노출 도구(예) | 위험도 |
|---|---|---|---|
| 대시보드 도우미 | 브라우저 에이전트가 "열린 질문 요약해 줘", "3번 첨언 대화 정리해 줘" | `pes.list_open_questions`, `pes.get_round_summary`, `pes.get_thread` | 읽기(`readOnlyHint`) |
| 답 초안 | 사용자가 말로 한 답을 폼에 채움 | `pes.draft_answer`(제출 아님, 초안 저장) | 낮음 |
| 첨언·질문 추가 | 선택한 문장에 첨언, 내 질문 추가 | `pes.add_comment`, `pes.add_question` | 중간 |
| 승인·reopen·판 시작 | — | **노출하지 않음** (사람이 직접 누름) | 높음 |
| 브라우저 자동화 시험 | ego-browser·REA로 대시보드 E2E 검사 | 위 도구 전체 | — (개발용) |

## 3. 판단

- **방향은 맞다.** "사람과 에이전트가 같은 화면·같은 도구를 쓴다"는 PES의 소통 목표와 잘 맞고, Linear 분석에서 나온 "선택한 글에 첨언 / AI에게 묻기 / 할 일로 만들기"를 브라우저 에이전트에게도 열어 줄 수 있다.
- **지금 중심에 두면 안 된다.** origin trial이고, 이름도 바뀌는 중이고, 실제로 부르는 주요 에이전트가 아직 없다. Windows 사용자의 일반 Chrome·Edge에서 기본으로 되지 않는다.
- **비용은 작게 만들 수 있다.** WebMCP 도구는 PES API를 부르는 얇은 감싸개로만 만든다(별도 로직 없음). 기능 감지(`'modelContext' in document`) 후 있을 때만 등록하고, 한 파일에 모아 이름이 바뀌어도 한 곳만 고친다.

## 4. 제안

1. **1단계(설계)**: API 설계 때 동작마다 "WebMCP로 노출 가능/불가"와 위험도 표시를 넣는다. 승인·reopen·판 시작·삭제는 노출 불가로 정한다. 조사 출처·외부 글이 섞이는 결과는 `untrustedContentHint`.
2. **3단계(소통 기능, 로컬)**: 읽기 도구 몇 개와 초안·첨언 도구만 실험으로 붙인다. 질문 폼은 선언형 속성(`toolname` 등)을 시험해 본다. `toolautosubmit`은 쓰지 않는다.
3. **5단계(웹)**: 그때 표준·브라우저 상황을 다시 확인하고 정식 지원 여부를 결정한다. 로그인된 탭 권한으로 실행되므로, 에이전트 접속 키와는 별개로 "브라우저 에이전트가 한 일"을 사건 기록에 따로 표시한다(누가: 사람 / 내부 AI / 외부 에이전트 / 브라우저 에이전트).
4. **검사**: REA의 `discover_webmcp_tools`로 대시보드가 내놓는 도구 목록을 자동 점검한다.

## 5. 확인 못 한 것

- ego lite(ego-browser)와 Claude in Chrome이 WebMCP 도구를 부를 수 있는지.
- 현재 Chrome 정식판에서 origin trial 없이 쓰는 방법(플래그 이름 등)의 최신 상태.
