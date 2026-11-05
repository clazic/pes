# 결함 기록

테스트나 실제 사용에서 **재현한** 결함만 적는다. 추정·의심은 적지 않는다. 재현 자료는 합성 fixture로 만들고, 실키·기관 자료·실제 프로젝트 내용은 넣지 않는다(저장소 공개).

진단은 `python3 scripts/pes.py doctor`를 먼저 쓴다. `doctor`는 `~/.pes/config.json`과 `~/.claude/settings.json`도 읽으므로 `PES_HOME`만 바꿔서는 부족하다. 개발 중에는 `HOME`(Windows는 `USERPROFILE`)과 `PES_HOME`을 함께 임시 폴더로 두고 실행한다.

macOS / Linux:

```sh
review_home="$(mktemp -d)"
HOME="$review_home" PES_HOME="$review_home/pes-projects" python3 scripts/pes.py doctor
```

Windows (PowerShell):

```powershell
$reviewHome = Join-Path $env:TEMP ("pes-doctor-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $reviewHome | Out-Null
$env:HOME = $reviewHome
$env:USERPROFILE = $reviewHome
$env:PES_HOME = Join-Path $reviewHome "pes-projects"
python scripts/pes.py doctor
```

## 양식

| 항목 | 내용 |
|---|---|
| 버전 | 플러그인 버전 + 기준 커밋 |
| OS | 예: macOS 15.2, Windows 11 24H2 |
| 명령 | 재현한 명령 또는 조작 |
| 기대 결과 | 규칙·문서상 맞는 동작 |
| 실제 결과 | 관찰한 동작 |
| 합성 재현 자료 | fixture 경로·입력(합성만) |
| 심각도 | 높음(자료 손실·답 유실·승인 오처리) / 보통 / 낮음 |
| 처리 단계 | 지금 고침 / 기록만 / 1·2단계로 넘김 |

## 목록

| ID | 버전 | OS | 명령 | 기대 결과 | 실제 결과 | 합성 재현 자료 | 심각도 | 처리 단계 | 상태 |
|---|---|---|---|---|---|---|---|---|---|
| SEL-31-① reopen 후 complete | v0.15.6 (0db5a54) | macOS 27.2, Python 3.15.2 (로컬 macOS 확인, Windows는 SEL-15 CI 병합 후 확인 예정) | `python3 -m pytest -q tests/test_state.py::test_reopen_complete_project_clears_complete` (수정 전에는 xfail strict) | 6단계를 모두 승인해 complete 가 true 인 프로젝트를 reopen 하면 complete 가 false 가 되고 `status` 가 "전체 완료"를 보이지 않아야 한다 | reopen 이 단계 상태만 바꾸고 complete 를 그대로 두어 `status` 가 계속 "전체 완료"로 보였다 | `tests/test_state.py` 의 합성 프로젝트 — 6단계 승인 후 `reopen plan` | 높음(승인 오처리) | 고침(SEL-31) | 고침 |
| SEL-31-② 같은 병합 재전송 시 depth 증가 | v0.15.6 (0db5a54) | macOS 27.2, Python 3.15.2 (로컬 macOS 확인, Windows는 SEL-15 CI 병합 후 확인 예정) | `python3 -m pytest -q tests/test_state.py::test_resubmitting_same_merge_does_not_raise_depth` (xfail strict 유지) | 같은 결과를 같은 단계에 다시 merge 해도 항목의 depth 는 1 이어야 한다 | merge 할 때마다 depth 가 1씩 올라 두 번째 merge 후 depth 가 2 가 된다 | `tests/test_state.py` 의 합성 결과 JSON(`same-1`, `same-2`) | 보통(자료 손실 아님) | 기록만 — 2단계 이후 검토 | 기록만(xfail 유지) |
| SEL-31-③ 같은 라운드 render 시 스냅샷 덮어쓰기 | v0.15.6 (0db5a54) | macOS 27.2, Python 3.15.2 (로컬 macOS 확인, Windows는 SEL-15 CI 병합 후 확인 예정) | `python3 -m pytest -q tests/test_state.py::test_render_same_round_does_not_overwrite_snapshot` (수정 전에는 xfail strict) | 같은 라운드에서 render 를 다시 해도 `snapshots/<stage>-R<round>.json` 의 첫 스냅샷은 유지되고, 그 뒤 바뀐 상태는 `snapshots/<stage>-R<round>/<k>.json`(k=2,3,…)에 새 판으로 보존되어야 한다 | render 가 같은 이름의 스냅샷을 그대로 덮어써 그 라운드의 이전 상태가 사라졌다 | `tests/test_state.py` 의 합성 plan R1 항목(초기 요약 → 바뀐 요약) | 높음(자료 손실) | 고침(SEL-31) | 고침 |
| SEL-31-④ 같은 초 동시 답 수신 시 답 유실 | v0.15.6 (0db5a54) | macOS 27.2, Python 3.15.2 (로컬 macOS 확인, Windows는 SEL-15 CI 병합 후 확인 예정) | `python3 -m pytest -q tests/test_serve.py::test_simultaneous_submissions_do_not_lose_answers` (수정 전에는 xfail strict) | 같은 초에 동시에 들어온 답 12건이 각각 다른 파일에 저장되고, 응답·파일 수·답 내용이 모두 보존되어야 한다 | `exists()` 확인과 `write_text()` 사이에 잠금이 없어 같은 초의 요청이 같은 파일 이름을 골랐고, 덮어쓰기로 답이 유실되거나 깨진 JSON 이 남았다 | `tests/test_serve.py` 의 충돌 주입 서버 — `feedback/plan-R1-20260101-000000.json` 경쟁, 합성 답 12건 | 높음(답 유실) | 고침(SEL-31) | 고침 |
| SEL-31-⑤ O_EXCL 이름 예약 후 쓰기 전 빈 답 파일 | v0.15.6 (0db5a54) | macOS 27.2, Python 3.15.2 (로컬 macOS 확인, Windows는 SEL-15 CI 병합 후 확인 예정) | 코드 경로 확인: `scripts/serve.py` do_POST 의 `os.open(O_CREAT|O_EXCL)` 직후부터 답 JSON 쓰기가 끝나기 전 | 이름을 예약한 파일은 내용이 다 쓰인 뒤에만 `pending` 에 보여야 한다 | 예약 직후 잠깐 빈 파일(또는 잘린 JSON)이 있어, 그 사이 `pending`/`mark` 가 먼저 처리하면 답이 유실될 수 있다. 수정 전의 `write_text()` 에도 같은 틈이 있었다 | 없음(코드 경로 분석, 결정적 재현 테스트는 아직 없음) | 보통(창이 매우 좁고 기존 문제) | 기록만 — 2단계 이후 검토 | 기록만 |
| SEL-14-사고 격리 없는 doctor 실행 | v0.15.6 | macOS 27.2 | 0단계 SEL-14 작업자가 격리 없이 `pes.py doctor` 1회 실행 | 개발·시험 중 실제 `~/pes-projects`·`~/.pes`를 읽지 않아야 한다 | 실제 프로젝트 이름·상태를 읽어 OpenCode Go(DeepSeek, 학습 미사용 경로) 대화에 들어감. 쓰기 없음, 커밋 없음 | 없음(실제 자료 사고, 재현하지 않음) | 높음(실제 자료 노출) | 재발 방지(2026-11-05 사용자 결정): AGENTS.md 금지 규칙 추가, 작업 지시에 'PES 명령 실행 금지·격리 필수' 고정 | 조치함 |

한계: SEL-31-④ 의 `feedback.log` 잠금은 한 serve.py 프로세스 안의 요청 스레드 사이에만 적용된다. serve.py 인스턴스가 둘 이상이거나 pes.py 가 같은 로그에 동시에 쓰면 줄이 섞일 수 있다(기록만).
