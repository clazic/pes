# Notion·Linear 동작 분석 — PES 기능 아이디어 (2026-11-04)

배경: `docs/plan/00-brief.md` 2절 11번 요구. Notion·Linear 웹앱의 이동·이슈 등록·첨언(댓글)·데이터 모델을 살펴 PES 설계(특히 개발 단계 1 설계, 3 소통 기능)에 쓸 아이디어를 뽑는다. 코드를 베끼려는 것이 아니라 동작과 구조를 참고하려는 것이다.

표시: **[관찰]** = 번들 문자열·네트워크 기록·공식 문서에서 직접 확인함. **[추정]** = 관찰한 것에서 미루어 짐작함(검증 안 됨).

---

## 1. 조사 방법과 한계

### 한 일
| 방법 | 대상 | 결과 |
|---|---|---|
| REA `capture_browser_scenario` (Edge 실행 파일로 임시 프로필 브라우저를 띄움, 8초 대기, 네트워크 이벤트만 기록) | `https://linear.app/`, `https://linear.app/login`, `https://www.notion.so/login` | 요청 목록 확보. Linear 앱 번들은 `static.linear.app/client/assets/*.js`(54개), Notion 앱 번들은 `app.notion.com/_assets/*.js`(313개) |
| 번들 내려받아 정적 문자열 검색(실행하지 않음) | Linear 약 13MB(`startup-root.-0Wb1wiG.js` 6.8MB 등), Notion 약 18MB | 동기화 엔진·트랜잭션·댓글 모델·라우트·단축키 정의 확인 |
| 공식 문서 | linear.app/docs (Linear MCP `search_documentation`), linear.app/developers/webhooks, notion.com/help, developers.notion.com | 기능 동작 확인 |
| Linear MCP 읽기 전용 | `list_teams` 1회 | 사용자의 Linear 작업 공간(팀 `SEL`/seliq) 존재 확인. 아무것도 만들거나 고치지 않음 |

| ego lite(사용자 로그인 프로필 `Profile 1`)를 `ego-browser` CLI로 조작. 전용 작업 공간 하나를 만들어 쓰고 끝에 닫음(`finish({keep:[]})`). 읽기 전용: 메뉴·팔레트 열고 Esc, 글자 선택만. 아무것도 만들거나 고치지 않음 | Linear 작업 공간 내부(이슈 목록·이슈 화면·받은 알림·빠른 만들기 창·명령 메뉴) | 3.7절. 화면에 보인 것은 Linear 기본 안내 이슈뿐이라 개인 내용은 옮기지 않음 |
| 같은 ego lite에서 Notion | `www.notion.so` → 마케팅 페이지로, `app.notion.com` → 로그인 화면으로 넘어감. 인증 쿠키 없음 | **Notion 내부는 못 봄**(아래 한계) |

### 못 한 일 (한계)
- **Notion 로그인 상태 없음 (2차 조사)**: ego lite의 같은 프로필에서 Notion 인증 쿠키가 없어 작업 화면을 열 수 없었다. 로그인은 하지 않았다. 그래서 Notion 부분(2절)은 번들·문서 근거만 있다. 사용자가 `app.notion.com`에 로그인하면 2절의 peek·댓글·제안 모드·판 기록 화면을 다시 확인할 수 있다.
- **REA는 ego lite에 붙지 못함**: ego lite는 외부에서 쓸 수 있는 CDP 포트(`DevToolsActivePort`, 리스닝 포트)를 열지 않아 `list_browser_targets`·`inspect_web_page`를 쓸 수 없었다. 대신 ego-browser의 `page.cdp("Network.enable")`로 네트워크 이벤트를 받아 보았다(3.7절).
- **(1차 조사 기준) 로그인하지 않았다.** 그래서 실제 작업 화면의 동작(Cmd+K 메뉴 열기, peek 열기, 댓글 달기)은 직접 눌러 보지 못했다. 로그인 후에만 나오는 네트워크(`/sync/bootstrap`, `wss://sync.linear.app`, Notion `saveTransactions`·`syncRecordValues` 호출)도 기록에 없다. 이들 이름은 **번들 안의 문자열로만** 확인했다.
- REA `analyze_web_bundle`·`inspect_web_page`는 로컬 CDP 대상(이미 떠 있는 브라우저)이 필요한데, 열려 있는 CDP 포트가 없어 쓰지 않았다. 대신 `capture_browser_scenario`가 기록한 스크립트 URL로 번들을 받아 정적으로 훑었다.
- 번들은 압축(minify)되어 있어 함수 이름이 없다. 모델 필드 이름·문자열 상수·엔드포인트 문자열은 살아 있어 그것을 근거로 삼았다.
- 데스크톱 앱은 설치되어 있지 않아 보지 않았다.
- REA 세션: 시나리오 도구가 띄운 임시 브라우저는 호출마다 스스로 닫혔고(남은 임시 프로필 프로세스 없음 확인), `open_binary` 같은 계속 열려 있는 세션은 열지 않았다.

---

## 2. Notion에서 찾은 것

### 2.1 데이터 모델: 모든 것이 "레코드", 바꾸는 것은 "트랜잭션 안의 연산"
- **[관찰]** 앱이 클라이언트 쪽 레코드 표 정의를 들고 있다. 표 이름 빈도: `block`(668회), `space`, `thread`, `discussion`, `comment`, `collection`, `activity` 등. 모든 표에 `id`(UUID), `version`, `last_version`, `space_id`, `parent_id`·`parent_table`, `alive`(지우지 않고 살아 있음 표시)가 공통으로 붙는다.
  - `block` 열: `id, space_id, version, last_version, type, properties(JSON), content(자식 id 배열), discussions(문자열 배열), parent_id, parent_table, created_time, last_edited_time, copied_from, is_template, permissions …`
- **[관찰]** 변경은 `pointer {table, id, spaceId}` + `path`(예: `["properties"]`, `["discussions"]`) + `command`(`set`, `update`, `listAfter` 등) + `args` 로 된 **연산(operation)** 묶음이다. 예: 새 discussion을 만들면 `op.set({pointer:{table:"discussion",…}})` 과 `{pointer:{table:"block",id:…}, command:"listAfter", path:["discussions"], args:{id}}` 두 연산이 한 트랜잭션에 들어간다.
- **[관찰]** 트랜잭션 클래스에 `id, spaceId, userId, committed, isUndoTransaction, undoCheckpoint, privateOperations` 등이 있다. 되돌리기도 별도 트랜잭션으로 기록된다.
- **[관찰]** 엔드포인트 이름(번들 문자열): `saveTransactions`(쓰기), `syncRecordValues`·`syncRecordValuesSpace`(레코드 최신 버전 받기), `loadPageChunkV2`·`loadCachedPageChunk`(페이지 일부 불러오기), 공통 경로 `api:{http:"/api/v3"}`. 로그인 화면에서는 `POST app.notion.com/api/v3/getAppConfig`, `ping`, `getUserAnalyticsSettings` 만 실제로 관찰됨.
- **[관찰]** 실시간: `messageStore:{url:"https://msgstore.www.notion.so"}`, `primus_v8` 경로, `realtimeGateway` 설정. **[추정]** 서버는 "이 레코드가 바뀌었다"는 알림만 보내고, 클라이언트가 `syncRecordValues`로 새 버전을 가져오는 방식.
- **[관찰]** 브라우저 안에 SQLite(wasm)를 쓴다(`sqlite` 1756회, `opfs_snapshots` 게이트). 클라이언트 표 정의에 `CONSTRAINT primary_key PRIMARY KEY (id, meta_user_id)`, `meta_role` 같은 열이 보인다 → 오프라인 캐시도 서버와 같은 레코드 모양.

### 2.2 첨언(댓글): discussion(스레드) + comment(글) 두 단계, 위치는 "글 속 표시"로
- **[관찰]** `discussion` 표 열: `id, type, version, parent_id, parent_table, nav_parent_id, context(JSON), resolved, comments(배열), reactions, property_id, anchored_runs(JSON), space_id`.
- **[관찰]** `comment` 표 열: `id, version, parent_id, parent_table, reply_to_id, reply_to_table, resolved, deleted_at, text(JSON), created_by_table, created_by_id, alive, reactions, agent_activity_data(JSON) …` — **작성자가 사람(`notion_user`)인지 봇·AI인지 `created_by_table`로 구분**하고, AI 활동 자리(`agent_activity_data`)가 따로 있다.
- **[관찰]** 글의 일부에 댓글을 달면 그 글 조각(rich text)에 `[Discussion, discussionId]` 표시가 붙고, discussion의 `context`에는 **그때의 인용 글**(`[[textContent, [[Discussion,id]]]]`)이 저장된다. 블록에는 `discussions` 목록으로 연결된다.
- **[관찰·문서]** 제안 모드(Suggested edits, https://www.notion.com/help/suggested-edits): "Can comment" 권한 이상이 `••• > Suggest edits`로 들어가 글을 더하거나 지우면 제안으로 남고, 여백에 표시되며, 제안마다 댓글 스레드, 주인이 체크(수락)·X(거절). 번들에 `suggestionDiscussionStore`가 트랜잭션에 붙는다 → **제안 = 특수한 discussion**.
- **[문서]** 공개 API(https://developers.notion.com/reference/create-a-comment): 페이지·블록·기존 `discussion_id`에 댓글 가능. 그러나 "selected range of text 에 새 discussion을 만드는 것은 지원하지 않음". 즉 외부 통합은 글 조각 단위 첨언을 새로 만들 수 없다.

### 2.3 이동: peek, 블록·댓글 딥링크
- **[관찰]** 페이지를 여는 방식이 셋: `full_page`, `side_peek`(오른쪽 패널), `center_peek`(가운데 팝업). `peekTargetStore`, `isSidePeekOpen()`.
- **[관찰]** URL 만드는 함수가 쿼리 키 `v`(보기), `p`(peek 할 페이지), `pm`(peek 모드), `d`(discussion), `c`(comment), `dm`, `s`, `n` 을 붙이고, 특정 블록으로 스크롤할 때는 `#<blockId>`. → 한 URL로 "이 페이지를 옆 패널로 열고 이 댓글로 가라"가 된다.
- **[관찰]** 검색은 `quickFind` 동작(문자열 `quickFind`, `openLinkMenuOrOpenSearch`). 단축키 정의는 번들 문자열에서 찾지 못함(로그인 후 로드되는 청크로 추정).

### 2.4 판·기록
- **[문서]** 페이지 기록(https://www.notion.com/help/duplicate-delete-and-restore-content): 편집 중 10분마다, 마지막 편집 2분 뒤 한 판을 기록. "모든 변경을 담지는 않는다". 판으로 되돌리기(Restore)는 되돌릴 수 있다. 보관 기간은 요금제별(7·30·90일·무제한).
- **[추정]** 세부 연산 로그(트랜잭션)와 사람이 보는 "판"(스냅숏)을 따로 둔다. PES의 "라운드 결과"와 비슷하다.

---

## 3. Linear에서 찾은 것

### 3.1 동기화 엔진: 전체 받기 + 차이 받기 + 로컬 트랜잭션 줄
- **[관찰]** `VITE_SOCKET_SERVER_URL:"wss://sync.linear.app"`, 그래프QL `POST https://client-api.linear.app/graphql`(로그인 화면에서도 실제 관찰).
- **[관찰]** 처음엔 `/sync/bootstrap?type=full&onlyModels=…&syncGroups=…&clientDatabaseId=…&modelsHash=…`로 필요한 모델만 통째로 받고, 그 뒤 `/sync/delta`로 `fromSyncId → toSyncId` 사이의 패킷만 받는다. 모든 변경에 단조 증가 번호 `lastSyncId`(281회)가 붙는다. 패킷 `action`은 `G`, `S` 등 한 글자 코드.
- **[관찰]** `syncGroups`: 사용자가 볼 수 있는 묶음(팀 등) 단위로 내려받을 범위를 정함. 모델마다 그룹 키 정의: `Issue:["teamId"]`, `IssueHistory:["issue.teamId","issueId"]`, `ProjectDraft:["creatorId"]` 등.
- **[관찰]** 모델 불러오기 전략(`instant`, `partial`): `IssueHistory`, `Comment`, `AgentActivity`는 처음부터 다 받지 않고 필요할 때 받는다.
- **[관찰]** 로컬 트랜잭션 줄(`TransactionQueue`, `onTransactionQueued`, `createdTransactions`), 직렬화 가능한 트랜잭션(`ArchiveTransaction.fromSerializedData(modelClass, modelId, batchIndex)`), `rollback()`이 원래 값으로 되돌림(`originalModels … updateFromData`). → **낙관적 업데이트**: 화면은 먼저 바뀌고, 서버가 거부하면 되돌림. 브라우저 `IndexedDB`에 저장(21회).
- **[관찰]** 모델 필드마다 저장 정책: `persistence:"none" | "createOnly" | "updateOnly"`, `isVirtual`. 예: 댓글의 `inlineAnchorFrom/To`는 `createOnly`(만들 때 한 번만 보냄).

### 3.2 명령 메뉴(Cmd+K)와 단축키 = 하나의 "동작(action) 목록"
- **[관찰]** 모든 동작이 같은 모양의 객체: `{id, name, keywords, keyboardShortcut, group, applicable(ctx), execute(ctx) 또는 link(ctx), disabledReason, detail, hideInCommandMenu, availabilityDuringBootstrap}`.
  - `FAST_CREATE_ISSUE`: 단축키 `c`, 초안이 남아 있으면 `detail: "Resume editing"`.
  - `GOTO_INBOX`: 단축키 `key:["g","i"]`(두 글자 연속).
  - `Close Command Menu`: `{key:"k", mod:true}` → Cmd+K로 메뉴 여닫기.
  - `Open link from last toast`: Cmd+Alt+O — 방금 만든 것으로 바로 가기.
  - `Create issue from screenshot…`, `Create issue from request…`.
- **[관찰]** 같은 동작 목록이 명령 메뉴·오른쪽 클릭 메뉴(`isContextualMenu`)·단축키를 모두 만든다. 동작은 `targetedModelsOfType(...)`로 "지금 고른 것(여러 개 가능)"에 적용된다.
- **[관찰]** 필터 메뉴에서도 한 글자 단축키(`team: t`, `lead: l`).
- **[관찰]** 목록 화면에서 peek 켜고 끄기(`togglePeek`, `peekEnabled`, `showPeekFooter`) — 목록을 떠나지 않고 미리 보기. 선택도 낙관적(`toggleSelectionOptimistically`).
- **[문서]** 단축키 예: 분류함 `G T`, 다른 팀 열기 `O T`, 리뷰 `G R`, 에이전트 채팅 `⌘J`, 인라인 댓글 `⌘⌥M`, 댓글 보내기 `⌘Enter`.

### 3.3 URL 구조 (라우트 273개 중 일부)
- **[관찰]** `/:orgKey/issue/:issueId/:slug?`, `/:orgKey/issues/:issueIds`(여러 건 한 번에), `/:orgKey/project/:projectId/:tabName?`, `/:orgKey/project/:projectId/update/:projectUpdateId`, `/:orgKey/document/:documentId`, `/:orgKey/inbox/:inboxTab?`, `/:orgKey/drafts/:draftId?`, `/:orgKey/team/:teamKey/triage`, `/:orgKey/team/:teamKey/cycle/:cycleIdentifier`, `/:orgKey/view/:customViewId`, `/:orgKey/agent-session/:agentSessionId`, `/:orgKey/agent/:conversationId?`.
- **[관찰]** 댓글 딥링크: `<부모 URL>#comment-<commentId>`, 글을 올리면 토스트에 "View comment" 링크.
- 읽기 쉬운 식별자(예 `SEL-123`) + 꾸밈 slug.

### 3.4 이슈 등록·분류
- **[관찰]** 빠른 만들기 `c`는 어디서든 열리고, 지금 보고 있는 필터 조건을 기본값으로 채움(`overridesFromFilters`), 마지막 팀 기억(`rememberSelectedTeam`). 닫아도 **초안이 남음**(`hasLocalDraft`), 사이드바 Drafts.
- **[관찰]** 댓글에서 이슈 만들기: Comment 모델에 `createdIssues`, 문서에도 "create a new issue or sub-issue from the comment".
- **[관찰]** 이슈 템플릿(조직 + 팀), 반복 이슈(`recurringIssueTemplate`).
- **[관찰]** 관계: 상위/하위 이슈(`parent`, `subIssueSortOrder`), `related`, `blocks`/`blockedBy`, 중복.
- **[문서]** 분류함(Triage, https://linear.app/docs/triage): 다른 팀·통합에서 들어온 건은 분류함 상태로 시작. `1` 수락(댓글 남기고 기본 상태로), `2` 거절(취소 + 사유 댓글), `3`/`MM` 중복 처리(첨부를 원본으로 옮김), `H` 미루기(정한 때 또는 **새 활동이 생기면** 다시 나타남). 분류 규칙·담당 순번·AI 분류(Triage Intelligence)는 상위 요금제.

### 3.5 댓글·스레드
- **[관찰]** Comment 모델 필드(번들 `c0.prototype`): `bodyData, bodyMarkdown, parent, root, threadComments, quotedText, inlineAnchorFrom, inlineAnchorTo, resolvedAt, resolvingComment, resolvingUser, resolve, unresolve, threadSummary, reactionData, editedAt, subscribers, createdIssues, documentContent, draftReplies, agentSessions, spawnedAgentSessions, onBehalfOfUserId, sourceMetadata …`.
  - **인용문(`quotedText`) + 위치(`inlineAnchorFrom/To`) 둘 다** 저장. 글이 바뀌어 위치가 어긋나도 인용문은 남는다.
  - **해결을 특정 답글로**(`resolvingComment`): "이 답이 결론" 표시. 문서: "resolve a thread from a particular reply to expose that reply specifically", 해결된 스레드 AI 요약(`threadSummary`).
  - `onBehalfOfUserId`: 에이전트가 사람 대신 쓴 글 표시. `agentSessions`: 댓글에서 `@Linear`로 에이전트 작업을 시작.
  - 보내지 않은 댓글은 초안으로 남음(문서).
- **[관찰]** 이력: `IssueHistory` 모델(이슈별 변경 기록), 별도 로드.

### 3.6 통합 API
- **[문서]** 웹훅(https://linear.app/developers/webhooks): 이슈·댓글·문서·프로젝트 등. 페이로드 `action(create|update|remove), type, actor, data, url, updatedFrom(바뀌기 전 값), webhookTimestamp`. `Linear-Signature` = 본문 HMAC-SHA256, 타임스탬프 1분 이내 확인. 실패 시 1분·1시간·6시간 뒤 3회 재시도.
- **[문서]** 에이전트 귀속: 코딩 에이전트가 사람 대신 단 글에 `agent: claude|codex|opencode…`, `model` 표시(Reviews 문서의 `linear:extension onBehalfOf`). PES의 방식 A(OpenCode)·B(Claude Code·Codex) 구분과 딱 맞는 개념.

### 3.7 로그인한 화면에서 직접 본 것 (ego lite, 2026-11-04) [관찰]
- **명령 메뉴(Cmd+K)**: 입력 칸 "Type a command or search…" 오른쪽에 **"Ask Linear · Tab"** — 같은 입력 칸에서 Tab을 누르면 명령 찾기에서 AI 에이전트에게 묻기로 바뀐다. 결과는 분류별 묶음(Issues / Projects / Documents / Views)이고 줄마다 단축키가 붙는다(`Create new issue… C`, `Create issue in fullscreen… V`, `Create new project… N then P`, `Add Filter… F`, `Find in view… ⌘F`).
- **문맥에 따라 바뀌는 메뉴**: 목록에서 이슈 한 줄에 초점을 둔 채 Cmd+K를 누르면 그 이슈용 동작으로 바뀐다: `Assign to… A`, `Assign to me I`, `Change status… S`, `Set priority… P`, `Add to project… ⇧P`, `Add labels… L`, `Set due date… ⇧D`, `Copy issue ID ⌘.`, `Copy issue URL ⌘⇧,`, `Copy title as link ⌘C`, `Copy issue as Markdown`, `Copy everything as Markdown ⌘⌥C`, **`Copy as prompt ⌘⌥P`**(AI에게 넘길 형태로 복사), `Subscribe to issue ⇧S`, `Mark issue as…`. → 번들에서 본 "동작 목록 하나 + `applicable(ctx)`" 구조가 실제로 그렇게 동작함을 확인.
- **peek**: 목록에서 `J`로 줄을 옮기고 `Space`를 누르면 오른쪽에 떠 있는 미리 보기 카드(번호·제목·상태·본문)가 열린다. **URL은 바뀌지 않는다**(목록 URL 그대로). `Esc`로 닫힘. `Enter`를 누르면 전체 이슈 화면으로 가고 URL이 `/issue/SEL-n/<slug>`로 바뀐다.
- **이슈 화면**: 위에 빵부스러기(팀 › Issues › 번호·제목), 오른쪽 위에 **"3 / 4" 와 ↑↓** — 목록 순서대로 이전·다음 이슈로 넘김(목록으로 돌아가지 않고 차례로 검토). 오른쪽 속성 패널(상태·우선순위·담당·라벨·프로젝트), 본문 아래 "Add sub-issues", "Activity" 와 "Subscribe".
- **글자를 고르면 뜨는 도구 막대**: 서식 단추들 뒤에 **`Create issue from selection`**, **`Ask Linear`**, **`Comment`** 세 개가 나란히 있다. 즉 "고른 글 → 할 일 만들기 / AI에게 묻기 / 첨언 달기"가 한 자리에 있다. (누르지 않고 닫음)
- **빠른 만들기(`C`)**: 가운데 작은 창. 위에 "팀 › New issue", 제목·설명 칸, 아래에 속성 칩(Backlog·Priority·Assignee·Project·Labels·…), 첨부, **"Create more" 토글**(만든 뒤 창을 닫지 않고 바로 다음 것 입력), 펼치기(전체 화면) 단추. 아무것도 입력하지 않고 Esc로 닫음.
- **받은 알림(Inbox)**: 조작 단추 "Show unreads only", "Add filter", "Display options", "Notification actions"(한꺼번에 읽음·지우기 등).
- **네트워크**: 목록에서 이슈를 열 때 그래프QL 쿼리는 `SyncCheck` 하나뿐이고, 내용은 `POST https://client-api.linear.app/sync/batch`(필요한 모델 묶음 받기)로 온다. 화면 이동은 `Page.navigatedWithinDocument`(새로 고침 없는 앱 안 이동). 웹소켓 프레임이 오가지만 JSON이 아니어서 모양은 확인하지 못함. → 3.1의 "처음엔 전체, 무거운 모델(댓글·이력)은 필요할 때 batch로" 구조와 맞는다.

---

## 4. PES에 넣을 기능 아이디어

| # | 아이디어 | 참고한 동작 | PES 어디에 | 개발 단계 | 방식 A/B 영향 |
|---|---|---|---|---|---|
| 1 | **동작 목록 하나로 명령 메뉴·단축키·오른쪽 클릭 메뉴를 모두 만든다** (`{id, 이름, 키워드, 단축키, 적용 조건, 실행}`) | Linear action 객체, Cmd+K | 웹 대시보드 전체 | 1 설계(목록 정의), 3 구현 | 같음. 단 "AI에게 다시 시키기" 같은 동작은 A는 PES가 바로 실행, B는 "할 일"로 쌓아 외부 에이전트가 가져감 |
| 2 | **두 글자 이동 단축키**: `G P` 기획, `G R` 조사 … `G D` 결정 기록, `G I` 받은 알림 | Linear `GOTO_INBOX ["g","i"]`, `G T` | 대시보드 | 3 | 같음 |
| 3 | **옆 패널 미리 보기(peek)**: 질문·첨언·출처를 목록에서 떠나지 않고 오른쪽에 연다. URL에 `?peek=<id>` 남김 | Notion `side_peek`·`p`/`pm`, Linear `togglePeek` | 라운드 화면, 결정 기록, 첨언 목록 | 3 | 같음 |
| 4 | **모든 것에 딥링크**: `/p/<프로젝트>/e/<판>/s/<단계>/r/<라운드>#q-<질문>`, `#c-<첨언>`, 블록은 `#b-<문단id>` | Linear `/issue/:id/:slug`, `#comment-id`; Notion `#blockId`, `d=`/`c=` | URL 설계, 알림 링크, 인쇄물 각주 | 1 | 같음. 에이전트 API 응답에도 같은 URL을 넣어 B의 터미널 에이전트가 사람에게 링크를 보여 줄 수 있게 |
| 5 | **읽기 쉬운 짧은 번호**: `Q-12`(질문), `C-7`(첨언), `D-3`(결정), `A-5`(가정) | Linear `TEAM-123` 식별자 | 모든 항목 | 1 | 같음. 에이전트·사람이 대화에서 번호로 부름 |
| 6 | **첨언은 "스레드 + 글" 두 단계, 위치는 인용문 + 위치 둘 다** 저장. 원문이 바뀌면 인용문으로 다시 찾고, 못 찾으면 "위치 잃음" 표시 | Notion `discussion.context`·`anchored_runs`, Linear `quotedText`+`inlineAnchorFrom/To` | 첨언(brief 6번) | 1 DB, 3 화면 | 같음 |
| 7 | **"이 답이 결론" 해결**: 첨언 스레드를 특정 답글로 해결하고, 해결 시 결과 종류(글 수정 / 다음 라운드 할 일 / 앞 단계 다시 열기 / 그냥 닫기)를 고른다. 해결 요약은 AI가 씀 | Linear `resolvingComment`, `threadSummary` | 첨언·대화 | 3 | A: PES 내부 AI가 요약·후속 처리. B: "해결됨" 이벤트를 API로 받은 외부 에이전트가 처리 |
| 8 | **첨언·답글에서 바로 "할 일 만들기"**, 만든 할 일은 원래 첨언과 서로 연결 | Linear `createdIssues`, "create issue from comment" | 첨언 → 다음 라운드 할 일 | 3 | 같음 |
| 9 | **제안 모드**: 사람이 AI 원고를 직접 고치면 덮어쓰지 않고 "제안"으로 남기고, AI·사람이 수락/거절 | Notion Suggested edits, `suggestionDiscussionStore` | 집필·검증 단계 원고 | 3 (간단판) / 4 | A: 수락 시 PES가 바로 반영. B: 수락된 제안 목록을 API로 내려줌 |
| 10 | **AI 질문 폼을 "분류함"처럼**: 질문마다 `1` 그대로 받기, `2` 빼기, `3` 다른 질문과 합치기, `E` 고쳐 쓰기, `H` 나중에(다음 라운드로 미룸). 미룬 질문은 관련 활동이 생기면 다시 올라옴 | Linear Triage 1/2/3/H, 미루기 해제 조건 | 라운드 질문 목록(brief 4·5번) | 3 | 같음 |
| 11 | **빠른 만들기(`N` 또는 `C`) 어디서든**: 지금 화면(단계·라운드)을 기본값으로 채운 "사람이 AI에게 묻는 질문 / 첨언 / 결정" 만들기, 닫아도 초안 유지 | Linear `FAST_CREATE_ISSUE`, `overridesFromFilters`, Drafts | 대시보드 전체 | 3 | 같음 |
| 12 | **받은 알림(inbox)**: 내 답을 기다리는 질문, 나를 부른 첨언, 승인 대기. 미루기·읽음 | Linear inbox(`/inbox/:inboxTab?`), Notion inbox 알림 | brief 8-7 알림 | 3 로컬판, 5 웹 알림 | B는 외부 에이전트가 올린 작업물이 도착할 때도 알림 |
| 13 | **작성자 종류 구분**: 사람 / PES 내부 AI(모델명) / 외부 에이전트(Claude Code·Codex 등) / 대신 씀 | Notion `created_by_table`·`agent_activity_data`, Linear `onBehalfOfUserId`, `onBehalfOf{agent, model}` | 모든 기록 | 1 DB | **핵심**: A와 B를 같은 모델로 묶는 열. `actor_kind`, `agent`, `model` |
| 14 | **판 비교·되돌리기**: 라운드마다 스냅숏, 두 라운드·두 판 사이 차이 보기, 되돌리기도 새 기록으로 | Notion 페이지 기록(10분/2분 스냅숏, Restore 가역), `isUndoTransaction` | 판(edition), 라운드 | 2 (기록), 4 (화면) | 같음 |
| 15 | **방금 한 일로 바로 가기 토스트**: 답 보내기·첨언 달기 후 "보기" 링크 | Linear toast `View comment`, Cmd+Alt+O | 대시보드 | 3 | 같음 |
| 16 | **여러 개 골라 한꺼번에**: 질문 여러 개 중요도 바꾸기, 첨언 여러 개 한 번에 "다음 라운드로" | Linear `targetedModelsOfType`, `/issues/:issueIds` | 질문·첨언 목록 | 3 | 같음 |
| 17 | **(선택) Linear로 내보내기**: 해결된 첨언 중 "PES 개발 할 일"(도구 버그·기능 요청)만 Linear 이슈로. 연구 내용 자체는 보내지 않음 | Linear GraphQL API, 웹훅 | PES 개발(hc-team 연계) | 6 | B와 잘 맞음(hc-team이 Linear 이슈 처리). 연구 작업 흐름에는 넣지 않는 것을 권함 |
| 18 | **(선택) Notion으로 보고서 내보내기**: 최종 보고서를 Notion 페이지로 한 번 밀어 넣기(읽기 전용 사본) | Notion API 페이지·블록 생성 | 산출·공유 단계 | 6 | 같음. 단 Notion API는 글 조각 첨언을 새로 만들 수 없어 첨언 왕복은 불가 → PES가 원본이어야 함 |

| 19 | **글을 고르면 뜨는 도구 막대에 "첨언 / AI에게 묻기 / 할 일로" 세 단추** — brief 6번 첨언의 입구를 하나로 | Linear 선택 막대 `Comment`·`Ask Linear`·`Create issue from selection` (3.7) | 모든 원고·보고서 화면 | 3 | A: "AI에게 묻기"는 PES 내부 AI가 바로 답. B: 질문을 쌓아 두고 외부 에이전트가 다음 차례에 답 |
| 20 | **명령 메뉴 안에서 Tab으로 "AI에게 묻기" 전환** | Linear "Ask Linear · Tab" (3.7) | 대시보드 명령 메뉴 | 3 (A는 4) | A에서 바로 쓸 수 있음. B는 질문 등록으로 대신 |
| 21 | **"프롬프트로 복사"**: 질문·첨언·라운드 결과를 외부 AI에 붙여 넣기 좋은 Markdown으로 복사 | Linear `Copy as prompt ⌘⌥P`, `Copy everything as Markdown` (3.7) | 모든 항목의 동작 목록 | 3 | **방식 B에 특히 유용**(터미널의 Claude Code·Codex에 붙여 넣기). API가 생기기 전 단계 2에서도 바로 쓸모 |
| 22 | **검토 화면에서 "3 / 12 ↑↓" 차례 넘김**: 질문·첨언을 목록으로 돌아가지 않고 하나씩 처리 | Linear 이슈 화면 위 순번·화살표 (3.7) | 라운드 답하기, 첨언 처리 | 3 | 같음 |
| 23 | **"계속 만들기" 토글**: 사람이 AI에게 묻는 질문을 여러 개 연달아 입력 | Linear "Create more" (3.7) | 질문 목록(brief 4번) | 3 | 같음 |

통합 판단: PES의 핵심 기록(질문·답·첨언·결정)은 **PES DB가 원본**이어야 한다. Linear·Notion으로는 "한쪽으로 내보내기"만 하고 왕복 동기화는 하지 않는 편이 안전하다. 이유: (1) Notion API는 글 조각 첨언을 새로 만들 수 없음, (2) 정책 연구 내용이 외부 서비스에 퍼지는 것을 사용자가 원하는지 불분명, (3) 왕복 동기화는 충돌 처리 부담이 큼. 실제로 쓸 만한 곳은 PES 개발 자체의 할 일 관리(17번)이다.

---

## 5. DB·API 설계에 주는 시사점

1. **레코드 공통 열을 정한다** (Notion 모든 표 공통 열 참고): `id`(UUID 또는 ULID), `project_id`, `parent_kind`+`parent_id`(어느 것에 딸렸나 — 하나의 첨언 표가 질문·원고·결정 어디에나 붙게), `version`, `created_at`, `created_by_kind`(human/agent_internal/agent_external), `created_by_id`, `agent`, `model`, `alive`(지우지 않고 숨김). brief 9번 "덮어쓰지 않고 쌓기"와 맞음.
2. **변경 기록은 연산 로그 한 표 + 단조 증가 번호**: `change_log(seq INTEGER PRIMARY KEY AUTOINCREMENT, entity, entity_id, op(create|update|archive|restore), path, before, after, actor…, transaction_id, created_at)`. Linear `lastSyncId`·`updatedFrom`, Notion `pointer+path+command`를 합친 꼴. 이 `seq`가 그대로 화면 새로 고침 커서가 된다(`GET /changes?since=<seq>`) — 지금의 `/version` 폴링을 자연스럽게 대체. D1(SQLite)에서도 같음. **[추정]** PES 규모(사람 1~몇 명)에서는 웹소켓 없이 since-폴링이나 SSE로 충분.
3. **"현재 값" 표와 "기록" 표를 둘 다 둔다**: 화면은 현재 값 표를 읽고, 기록은 change_log에서. Notion도 레코드(현재) + 페이지 기록(스냅숏)을 나눔. 라운드·판 스냅숏은 R2(또는 로컬 파일)에 JSON으로.
4. **첨언 표 설계**: `thread(id, target_kind, target_id, target_version, quote_text, anchor_start, anchor_end, anchor_status(ok|moved|lost), status(open|resolved), resolved_by_message_id, outcome(edit|next_round_task|reopen_stage|none), summary)` + `message(id, thread_id, reply_to_id, body_md, author…, created_at, edited_at)`. 인용문을 기준(brief 9번 "첨언 위치는 인용문으로"), 위치는 보조. Linear처럼 앵커는 "만들 때만" 저장하고 이후 재계산.
5. **할 일·관계 표**: `task(id, origin_kind, origin_id …)` + `relation(from, to, kind: created_from|blocks|duplicates|related)`. 첨언→할 일, 할 일→다음 라운드, 결정→근거 첨언을 같은 관계 표로.
6. **트랜잭션 단위 API**: 에이전트 API는 "한 번에 여러 연산"을 받는다(`POST /api/v1/transactions {client_tx_id, ops:[{op, entity, id, path, value}]}`), `client_tx_id`로 중복 전송 방지(멱등). 실패 시 전체 거절 → 화면은 낙관적으로 먼저 바꾸고 거절되면 되돌림(Linear `rollback`). 방식 A(PES 내부 에이전트)와 방식 B(외부 에이전트)가 같은 엔드포인트를 쓰면 brief 3절 목표를 만족.
7. **필드별 쓰기 규칙**: Linear `persistence: createOnly/updateOnly/none`처럼, 예를 들어 첨언의 `quote_text`는 만들 때만, `status`는 바꾸기 가능, `summary`는 서버(AI)만. API 스키마에 명시.
8. **동작 목록을 데이터로**: 1번 아이디어의 동작 정의(`id, name, keywords, shortcut, applicable`)를 JSON으로 두면 웹 화면·CLI(`pes.py`)·에이전트 스킬이 같은 이름의 동작을 공유할 수 있다(예: `stage.reopen`, `question.defer`). **[추정]** API 엔드포인트 이름과 맞추면 에이전트 문서도 자동으로 만들 수 있음.
9. **외부로 알리기(웹훅) 모양**은 Linear를 따른다: `{action, type, data, updatedFrom, actor, url, timestamp}` + HMAC 서명 + 재시도. 개발 단계 5(알림)·6(넓히기)에서 Slack·Linear 연결의 기반.
10. **ID**: 내부는 UUID/ULID, 화면·대화용은 프로젝트별 짧은 번호(`Q-12`). 둘 다 저장(`seq_no` 열). Linear는 UUID + `TEAM-123`, Notion은 UUID(대시 없음)를 URL에 씀.

---

### 근거 원본 위치 (로컬, 세션 임시 폴더)
- REA 네트워크 기록: `~/.claude/projects/-Users-clazic-projects-pes/b17b62a9-…/tool-results/mcp-rea-capture_browser_scenario-1793734702533.txt`(Linear 로그인), `…-1793734844685.txt`(Notion 로그인), `…-1793734679452.txt`(linear.app 홈)
- 내려받은 번들: 세션 scratchpad `linear-js/`, `notion-js/` (임시, 저장소에 넣지 않음)
- 번들 파일명은 배포마다 바뀐다(예: `startup-root.-0Wb1wiG.js`). 위 문자열은 2026-11-04 기준.
