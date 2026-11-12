# 0021. 구간 첨언의 앵커 판정과 후속 — 위치는 code point, 해결됨 ≠ 반영됨, 적용은 사람만

- 날짜: 2026-11-12
- 담당: 3단계 U4a (SEL-99). 기록: hc-team mid worker
- 상태: **채택** — 해석은 leader가 확인했다(시험 머리말 `tests/test_sel99_*`).
- 관련: [0013](0013-mode-a-go-subscription-and-model-choice.md)(A 허용 목록 이름), stage-1-api.md 6절, stage-3.md 2.5절

## 문제

글의 한 구간에 다는 첨언(앵커), 글이 바뀐 뒤 앵커가 어디 있는지, 첨언 스레드를 닫는 일과 글을 실제로 고치는 일의 관계, 에이전트가 어디까지 하는지를 정해야 했다. DDL(`anchors`·`anchor_resolutions`·`threads`·`followups`)은 이미 있어 새 표는 없다.

## 선택지

- 위치: (가) UTF-16 인덱스 / (나) 유니코드 code point.
- 글이 바뀐 뒤: (가) 서버가 가장 가까운 후보를 고른다 / (나) 한 곳으로 정해질 때만 따라가고 아니면 후보만 보인다.
- 해결과 반영: (가) 해결하면 반영된 것으로 본다 / (나) 둘을 나눈다.
- 에이전트의 적용: (가) 허가된 E도 적용 / (나) 이번에는 사람만.

## 채택

- **위치는 code point**(글 버전 `body_md` 그대로, `text_format_version` 1, 정규화 없음). `end_cp` 는 배타라 `end_cp - start_cp` 가 인용문의 code point 수다. 이모지 하나는 1, ZWJ 가족 이모지는 3, 한글 음절은 1.
- **판정**: 인용문이 없으면 `lost`(삭제 없음); 문맥(prefix/suffix)이 맞는 곳이 한 곳이면 원래 위치일 때 `exact`, 아니면 `moved`; 문맥이 맞는 곳이 없고 인용문이 한 곳뿐이어도 같다; 그 밖(여러 곳)은 `ambiguous` — 위치 없이 후보만 돌려주고 **서버는 고르지 않는다**. 판정은 `anchor_resolutions` 에 줄을 더할 뿐 옛 줄·앵커는 바뀌지 않는다. 다시 붙이기(구간 지정)는 사람 소유자만 하고 `confirmed_by_actor_id` 에 남는다. 읽기(GET)는 현재 버전 기준 판정을 계산해 보여 주되 쓰지 않는다 — 단 현재 버전에 **사람이 확정한 줄이 하나라도 있으면 그중 마지막**을 보인다(앵커를 만든 원래 버전이어도 같다). 그 뒤의 자동 재판정(에이전트도 부를 수 있다)은 줄만 더할 뿐 사람 결정을 가리지 않는다.
- **만들 때**: 인용문은 대상 버전에 있어야 하고(없으면 422 `quote_not_found`), 위치가 틀려도 문맥으로 한 곳이 정해지면 `moved` 로 바로잡고, 여러 곳이면 422 `ambiguous_quote`. 위치 길이가 인용문 길이와 다르면 거절한다(인용문 존재 확인이 먼저).
- **해결됨 ≠ 반영됨.** `thread.resolve` 는 결론 메시지와 `resolved` 상태, 그리고 필요하면 `proposed` 후속 하나만 만든다. 글·반영 내역(`reflection_entries`)은 그대로다. `followup.apply`(edit_text)는 제안 글을 **그 호출의 새 버전**으로 채택하고(현재 버전 이동, 옛 버전 보존, 기반이 달라졌으면 409 `basis_changed` 와 아무 변화 없음), 스레드를 해결하지도 반영 내역을 쓰지도 않는다. 반영 내역은 `reflection.create` 가 이 apply 의 `applied_tx_id` 를 증거로 따로 쓴다(SEL-93 규칙).
- **에이전트(A 내장·B MCP)는 답글(`thread.reply`)·후속 제안(`followup.propose`)·재판정만** 한다(리스를 쥔 동안). 해결·적용·다시 붙이기는 사람만이다(토큰은 403 `human_required`). stage-1-api 의 '허가된 E 의 적용'은 이번에 열지 않는다 — **3단계 U4a 는 사람만, 에이전트 적용은 후속.**
- **답글은 문맥마다 한 명령.** 질문 의견(`question_comment`) 스레드의 답글은 A `thread.reply` 도구·B `pes_thread_reply`(POST `P/threads/{t}/messages`) 모두 `question.comment_add`(영수증 `question.commented`, SEL-90 계약)로, 그 밖의 스레드는 `thread.reply` 로 간다(`thread_reads.thread_reply_route` 한 곳). 어느 쪽이든 닫힌(`resolved`·`archived`) 스레드는 409 `thread_closed` 로 거절한다.
- **제안은 해결된 스레드에도 받는다**(의도). 해결은 대화를 닫는 것이지 할 일을 막는 것이 아니다 — `followup.propose` 는 스레드 상태를 보지 않고, 닫힌 스레드에 새 답글만 막는다.
- **`next_round_task`·`reopen_stage` 의 apply 는 지금 후속 상태(`applied`)·`applied_tx_id` 만 바꾼다.** 다음 라운드 과제를 만들거나 단계를 다시 여는 실제 효과는 후속(U4b 이후)에서 연결한다. 응답의 `result_version_id` 는 이때 `null` 이다(edit_text 만 새 글 버전이 생긴다).
- 새 오류 코드 `thread_closed`·`already_resolved`·`basis_changed`(모두 409)를 오류 표(`api_support.ts`)·capabilities·OpenAPI·픽스처에 등록했다.

## 이유

UTF-16 위치는 이모지·ZWJ 앞뒤에서 DOM 과 서버가 어긋난다. 후보를 서버가 고르면 첨언이 엉뚱한 문장에 붙은 채 조용히 남는다. 해결과 반영을 나누면 "닫았지만 글은 안 고친" 상태가 사실대로 보인다. 에이전트 적용은 글 본문을 바꾸는 일이라 사람의 확정 뒤로 미룬다.

## 영향

`scripts/pes_core/anchors.ts`(순수 판정), `commands/annotations.ts`(명령 6개), `commands/thread_reads.ts`(읽기), `api.ts`(라우트 7개), A 도구 `thread.reply`·`followup.propose`(스레드가 있으면 실제 명령, 없으면 옛 노트), B 도구 `pes_thread_reply`·`pes_followup_propose`. 픽스처 `threads.json` 의 `end_cp` 를 배타 규칙에 맞게 고쳤다(133/216).

## 재검토 조건

에이전트가 후속을 적용해야 할 때(U4b 이후), 앵커 자동 재판정을 쓰기 경로에 넣을 때, `text_format_version` 2 가 필요할 때.
