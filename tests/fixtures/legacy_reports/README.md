# 0.15 가 만든 보고서 기록 (SEL-74 5단계 시험 쪽)

`tests/fixtures/legacy/full` 을 `project.json` 만 고친 뒤 **PES 0.15 의 `report <슬러그> plan`**(커밋 `03fc81b`, Python)으로 돌려 얻은
파일 기록이다. Python 이 저장소에서 사라진 뒤에도 "0.15 가 만든 옛 보고서"를 시험 입력으로 쓰기 위해 한 번 만들어 고정했다(macOS 기록, LF).

폴더 하나 = 시험 하나(`<슬러그>`):

| 파일 | 뜻 |
|---|---|
| `input.project.json` | 0.15 `report` 를 돌리기 전의 project.json(= `full` 의 project.json 에 시험의 edit 를 적용한 것). 시험이 같은 edit 를 적용해 이 파일과 JSON 으로 같은지 확인한다 — edit 가 바뀌면 시험이 실패한다. |
| `project.json` | 0.15 `report` 가 다시 저장한 project.json |
| `reports/plan/report.md`, `report.html` | 0.15 가 만든 보고서(`작성 <시각>` 줄은 `2001-01-01 00:00` 으로 고정) |

`validate-full` 은 edit 없이 `full` 그대로 돌린 것(`input.project.json` 없음). 다시 만들 수는 없다(0.15 코드 삭제) — 고쳐야 하면 파일을 손으로 고친다.
