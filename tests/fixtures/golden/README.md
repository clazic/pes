# 0.15 출력 기록 (golden, SEL-74 5단계 시험 쪽)

PES 0.15(Python, 같은 입력)의 **옛 폴더 읽기 명령 출력**과 보고서 파일을 한 번 돌려 고정한 기록이다. 0.15 코드가 저장소에서 사라진 뒤에도
"TS 가 0.15 와 같은 출력을 낸다"는 단언을 지키려고 만들었다(macOS 기록). 시험이 같은 합성 입력을 TS 에 넣어 이 기록과 견준다.
임시 폴더 경로는 `<ROOT>`, 시각은 `<TS>`·`<STAMP>` 로 바꿔 두었다(`tests/helpers/cli_read_env.ts` 의 `normalize`).

| 파일 | 입력 | 쓰는 시험 |
|---|---|---|
| `h1-full-reads.json` | fixture `full` 폴더 2개(슬러그 synthetic-legacy-full·-two)에 status·pending·digest·show | test_cli_read_hardening H1 |
| `h2-rich-report.json` | 합성 plan·write 항목 → `report plan`·`assemble` 이 만든 report.md(작성 시각 줄 `<시각>`)·out/report.md·out/sources.json | test_cli_read_hardening H2 |
| `rich-legacy-reads.json` | `rich_legacy` + 처리 안 한 답 1개가 든 옛 폴더 `legacy-only` 의 읽기 명령 13개 | test_cli_read_v015 A1·legacy 읽기 |
| `seeded-plain-reads.json` | 0.15 로 `seed()` 한 합성 쓰기 뒤 status·digest·show·list | test_cli_read_v015 'DB 읽기 출력 = v0.15 출력' |

다시 만들 수 없다(0.15 코드 삭제) — 고쳐야 하면 손으로 고친다. 형식: `{ "<명령>": { status, stdout, stderr_last } }`.
