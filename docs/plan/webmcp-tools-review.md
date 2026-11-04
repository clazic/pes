# WebMCP 도구 목록 동료 검토

- 대상: [webmcp-tools.md](webmcp-tools.md)
- 기준: [stage-1-api.md](stage-1-api.md) 2절 16번(WebMCP)·6절(동작 표)·7절, [research/webmcp.md](research/webmcp.md)
- 검토일: 2026-11-05
- 상태: 동료 검토 반영. `webmcp-tools.md`만 고쳤고, API 설계서·연구 문서·코드는 고치지 않았다.

## 1. 확인 요약

| 점검 | 결과 |
|---|---|
| 금지 동작(승인·reopen·판 시작·정책·토큰·삭제·제출·해결·claim·submit·complete·export)이 도구로 들어갔는가 | **없음**. 6개 도구는 읽기 3, 답 초안 1, 첨언/답글 2다. 다만 4절이 `POST P/questions`를 서버 거부 대상으로 잘못 분류해 고쳤다. |
| 답 초안이 브라우저 폼에만 머무는가 | **맞음**. `pes.draft_answer`는 서버 API가 없고 `PUT P/answer-drafts`도 쓰지 않는다. 제출·재개 신호가 아니라고 명시돼 있다. |
| `browser_agent` 기록이 맞는가 | **행위자 기록은 맞음**. `actors.kind=browser_agent`, `on_behalf_of_user_id`는 위임 표시일 뿐 사람의 직접 작성·승인 증거가 아니라고 적혀 있다. 다만 자격 이름을 `browser_agent`로 쓴 곳이 있어 `browser_actor`로 고쳤다. |
| 중간 위험 표시가 맞는가 | **맞음**. `pes.add_comment`·`pes.add_reply`는 `쓰기(중간)`, `readOnlyHint:false`, `consequentialHint:true`다. |
| `untrustedContentHint`가 맞는가 | **맞음**. 질문·첨언 본문을 돌려주는 `list_open_questions`·`get_thread`는 true, 수·ID만 돌려주는 `get_round_summary`는 false다. |
| 부르는 API 경로가 6절과 맞는가 | **읽기 3개가 6절에 없는 경로를 쓴다**. 계약 확정 전 등록 보류 조건을 넣어 고쳤다. |

## 2. 문제 목록

| # | 위치 | 문제 | 근거 | 처리 |
|---|---|---|---|---|
| 1 | `webmcp-tools.md` 2.1 | `pes.list_open_questions`가 `GET P/questions?state=open…`을 부르지만 6절에는 질문 **게시** `POST P/questions`만 있고 목록 읽기 경로가 없다. | stage-1-api 6절의 질문 행. | 2절 표 아래에 "`GET P/questions`는 6절에 없으므로 PR13·14에서 읽기 경로가 확정되기 전에는 1~3번을 등록하지 않는다"는 계약 선행 조건을 추가했다. |
| 2 | `webmcp-tools.md` 2.3 | `pes.get_thread`가 `GET P/threads/{thread_id}`를 부르지만 6절에는 `POST P/threads`, `P/threads/{t}/messages`만 있고 스레드 읽기 경로가 없다. | stage-1-api 6절의 첨언·답글 행. | 같은 계약 선행 조건에 `GET P/threads/{thread_id}`를 포함했다. |
| 3 | `webmcp-tools.md` 2.2·7절 | `pes.get_round_summary`가 `GET P/questions`·`GET P/threads`를 읽어 세는데 두 경로 모두 6절에 없고, 7절은 "없으면 기존 읽기로 조합한다"고만 해 실제 대체 경로가 불명확하다. | stage-1-api 6절에는 `GET P/context`만 있고 질문·스레드 목록 읽기가 없다. | 1~3번 등록 보류와 "W1은 4~6번만 노출, 새 서버 API를 만들지 않는다"로 7절과 2절을 고쳤다. |
| 4 | `webmcp-tools.md` 4절 | `POST P/questions`를 "서버가 거부해야 하는 금지 동작" 표에 넣었다. 그런데 API 16번과 6절은 W에게 **사람→AI 질문 게시를 제한적으로 허용**한다. | stage-1-api 2절 16번, 6절 "게시만 가능(중간 위험)". | 금지 표에서 빼고, "API 16번은 제한 허용하지만 3단계 W1은 도구를 등록하지 않으며 서버 권한은 PR13·14 계약을 따른다"는 별도 문장으로 고쳤다. |
| 5 | `webmcp-tools.md` 1·4·5·6절 | 자격을 `browser_agent`로 부른 곳이 있다. API는 자격을 `browser_actor`, 행위자 종류를 `actors.kind=browser_agent`로 구분한다. | stage-1-api 2절 16번. | 자격은 `browser_actor`, 기록은 `actors.kind=browser_agent`로 용어를 분리했다. 초안 오류 코드도 `forbidden_for_browser_actor`로 맞췄다. |
| 6 | `webmcp-tools.md` 2·6절 | 읽기 3개의 경로가 미확정인데도 "노출 도구 6개", "6개 도구 annotations", "6개가 모두 등록 해제"라고 단정한다. | 6절에 없는 경로를 쓰는 도구를 동시에 노출·시험한다고 볼 수 없다. | 제목을 "노출 후보(6개, 계약 확정 전 읽기 3개 보류)"로 바꾸고, 시험 항목을 "계약 확정 전 4~6번만, 확정 뒤 6개"로 고쳤다. 등록 해제도 "등록된 도구"로 바꿨다. |

## 3. 고치지 않은 것

- [stage-1-api.md](stage-1-api.md), [research/webmcp.md](research/webmcp.md), 3단계 계획서·이슈, 코드는 고치지 않았다.
- Linear에는 아무 이슈도 만들지 않았다.
- 실제 `~/pes-projects`·`~/.pes/`는 읽지 않았다.
- 읽기 경로를 6절에 추가하는 일은 2단계 PR13·14의 API 계약 변경이므로 이 검토에서 대신 결정하지 않았다. W1은 그 전까지 4~6번만 노출하는 것으로 남겼다.
