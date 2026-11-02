# PES 한 줄 설치 (Windows)
#   irm https://raw.githubusercontent.com/clazic/pes/main/scripts/install.ps1 | iex
#
# 하는 일
#   1. Git(Git Bash) · Python 3 · Node.js 확인, 없으면 winget 으로 설치
#   2. Claude Code CLI 확인, 없으면 공식 설치 스크립트로 설치 (플러그인 등록에 필요)
#   3. PES 플러그인 등록·설치 (claude plugin marketplace add clazic/pes → install pes@pes-local)
#   4. 조사 도구 설치: kosis · vworld · korean-law (ego lite 는 내려받기 페이지를 연다)
#   5. API 키 입력 화면(브라우저) — 키는 이 컴퓨터의 각 도구 설정에만 저장된다
#   6. 진단(doctor) 후 완료 표시
# 다시 실행해도 된다 — 없는 것은 설치, 이미 있는 것은 최신 버전으로 업그레이드.
# 환경변수: PES_REPO (기본 clazic/pes), PES_SKIP_KEYS=1 (키 화면 건너뛰기), PES_NO_UPGRADE=1 (업그레이드 안 함)

$ErrorActionPreference = "Continue"
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Repo = if ($env:PES_REPO) { $env:PES_REPO } else { "clazic/pes" }
$Src = Join-Path $env:USERPROFILE ".pes\src"

function Step($n, $t) { Write-Host "`n[$n/6] $t" -ForegroundColor Cyan }
function Ok($t) { Write-Host "  OK  $t" -ForegroundColor Green }
function Warn($t) { Write-Host "  !!  $t" -ForegroundColor Yellow }
function Fail($t) { Write-Host "  XX  $t" -ForegroundColor Red }
function Refresh-Path {
  $m = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $u = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$m;$u;$env:USERPROFILE\.local\bin"
}

Write-Host "PES 설치를 시작합니다 ($Repo)" -ForegroundColor Cyan

# 1. 기본 도구 — 저장소를 받기 전이므로 bootstrap 을 직접 내려받아 실행
Step 1 "기본 도구 (Git · Python · Node.js)"
$tmp = Join-Path $env:TEMP "pes-bootstrap-$(Get-Random).ps1"
try {
  Invoke-WebRequest "https://raw.githubusercontent.com/$Repo/main/scripts/bootstrap.ps1" -OutFile $tmp -UseBasicParsing
} catch { Fail "bootstrap.ps1 을 받지 못함: $($_.Exception.Message)"; return }
$py = $null
& powershell -NoProfile -ExecutionPolicy Bypass -File $tmp | ForEach-Object {
  $line = "$_"
  if ($line -like "PYTHON *") { $py = $line.Substring(7).Trim() }
  elseif ($line -like "OK *" -or $line -like "INSTALLED *") { Ok $line }
  elseif ($line -like "FAIL *" -or $line -like "MISSING *") { Fail $line }
  else { Write-Host "  $line" }
}
Remove-Item $tmp -ErrorAction SilentlyContinue
Refresh-Path
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail "git 이 없습니다 — Git for Windows 설치 후 다시 실행하세요 (https://git-scm.com/download/win)"; return }
if (-not $py -or $py -eq "none") { Fail "Python 3.9+ 를 찾지 못했습니다 — 새 PowerShell 창에서 다시 실행하세요"; return }
$pyArgs = $py -split " "

# 2. Claude Code CLI
Step 2 "Claude Code CLI"
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Warn "claude 명령이 없어 공식 설치 스크립트로 설치합니다 (https://claude.ai/install.ps1)"
  try { Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression } catch { Fail "Claude Code CLI 설치 실패: $($_.Exception.Message)" }
  Refresh-Path
}
elseif (-not $env:PES_NO_UPGRADE) {
  $before = & claude --version 2>$null
  & claude update 2>&1 | Out-Null
  $after = & claude --version 2>$null
  if ($after -ne $before) { Ok "claude 업그레이드: $before → $after" }
}
if (Get-Command claude -ErrorAction SilentlyContinue) { Ok "claude $(& claude --version 2>$null)" }
else { Fail "claude 명령을 찾지 못함 — 새 PowerShell 창에서 다시 실행하거나, Claude Desktop Code 탭의 + → Add plugins 로 $Repo 를 추가하세요"; return }

# 3. PES 플러그인
Step 3 "PES 플러그인"
& claude plugin marketplace add $Repo 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { & claude plugin marketplace update pes-local 2>&1 | Out-Null }
& claude plugin install pes@pes-local 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { & claude plugin update pes@pes-local 2>&1 | Out-Null }
$plist = & claude plugin list 2>&1 | Out-String
if ($plist -match "pes") { Ok "pes@pes-local 설치됨" } else { Warn "플러그인 목록에서 pes 를 확인하지 못함 — Claude Desktop 에서 /reload-plugins 후 /pes:doctor" }

# 설치 도우미 스크립트 (같은 저장소를 ~/.pes/src 에 받아 둔다)
if (Test-Path (Join-Path $Src ".git")) { & git -C $Src pull -q 2>&1 | Out-Null }
else { New-Item -ItemType Directory -Force -Path (Split-Path $Src) | Out-Null; & git clone -q "https://github.com/$Repo.git" $Src 2>&1 | Out-Null }
$Setup = Join-Path $Src "scripts\setup.py"
$Pes = Join-Path $Src "scripts\pes.py"
if (-not (Test-Path $Setup)) { Fail "설치 도우미를 받지 못함 ($Src)"; return }
function PY { & $pyArgs[0] @($pyArgs[1..9] | Where-Object { $_ }) -I @args }

# 4. 조사 도구
Step 4 "조사 도구 (kosis · vworld · korean-law · ego lite)"
PY $Setup install missing | ForEach-Object {
  $l = "$_"
  if ($l -like "OK *") { Ok $l } elseif ($l -like "USER *") { Warn $l } elseif ($l -like "FAIL *") { Fail $l } elseif ($l -like "SKIP *") { Write-Host "  $l" }
}
Refresh-Path
if ($env:PES_NO_UPGRADE -ne "1") {
  Write-Host "  이미 있던 도구를 최신 버전으로 맞춥니다"
  PY $Setup upgrade all | ForEach-Object {
    $l = "$_"
    if ($l -like "UPGRADED *") { Ok $l } elseif ($l -like "OK *") { Write-Host "  $l" } elseif ($l -like "FAIL *") { Warn $l }
  }
}

# 5. API 키
Step 5 "API 키"
if ($env:PES_SKIP_KEYS -eq "1") { Warn "건너뜀 (PES_SKIP_KEYS=1) — 나중에 Claude 에서 /pes:setup keys" }
else { PY $Setup keys --wait | ForEach-Object { Write-Host "  $_" } }

# 6. 진단
Step 6 "진단"
PY $Pes doctor --net | ForEach-Object { Write-Host "  $_" }
PY $Setup mark | ForEach-Object { Ok $_ }

Write-Host "`n완료. Claude Desktop 을 완전히 종료했다가 다시 열고, Code 탭에서 /pes:start <주제> 로 시작하세요." -ForegroundColor Cyan
Write-Host "ego lite 를 이번에 설치했다면 앱에서 첫 실행 안내(온보딩)를 마쳐야 브라우저 조사를 쓸 수 있습니다."
