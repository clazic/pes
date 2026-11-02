---
description: 새 PES 프로젝트를 만들고 기획 단계 시작 질문 폼을 웹으로 연다 (기존 research-loop 조사는 --import 로 참고자료)
argument-hint: "<주제> [--import <research-loop 폴더>]"
---

0. 먼저 `python3 -I ${CLAUDE_PLUGIN_ROOT}/scripts/setup.py needed`(Windows는 `py -3`) — 종료 코드 1이면 한 줄 알리고 `/pes:setup` 절차를 먼저 끝낸 뒤 돌아온다.

`pes:core`와 `pes:plan` 스킬을 로드해 따른다. 인자: $ARGUMENTS

1. 주제에서 slug(영문 소문자-하이픈)를 정하고 프로젝트 폴더는 PES 홈 아래 `<홈>/<slug>` (`home`으로 확인, 기본 ~/pes-projects). 이미 project.json이 있으면 `ask-prep <dir> resume` 폼으로 이어하기를 묻는다.
2. `init` 직후 `lock <dir>`. `init <dir> --topic "<주제>" [--import <폴더>]` (인자에 --import가 없더라도 `research/<slug>/state.json`처럼 같은 주제의 기존 조사가 보이면 가져올지 기획 시작 질문의 library 질문으로 묻기 위해 일단 --import 한다).
3. 기획 시작 질문 폼: `ask-prep` → 다듬기 → `ask` → `serve` → `open <dir>`(pes CLI) → Monitor(`watch`).
4. 채팅에는 한두 줄만: 폼 주소와 "추천 답이 골라져 있으니 바꿀 것만 바꾸고 보내 주세요."
5. 목록 화면(PES 홈의 index.html)에 자동 반영된다.
