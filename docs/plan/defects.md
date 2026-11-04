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
