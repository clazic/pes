# PES 한 줄 설치 (Windows)
#   irm https://raw.githubusercontent.com/clazic/pes/main/scripts/install.ps1 | iex
#
# 하는 일
#   1. Git(Git Bash) · Node.js 26 이상 확인, 없으면 winget 으로 설치
#   2. 플러그인을 등록할 claude 찾기 — PATH 의 Claude Code, 없으면 Claude Desktop 안의 Claude Code, 둘 다 없으면 CLI 설치
#      (Claude Desktop 전용: install-desktop.ps1 또는 $env:PES_TARGET='desktop')
#   3. PES 플러그인 등록·설치 (claude plugin marketplace add clazic/pes → install pes@pes-local)
#   4. 조사 도구 설치: kosis · vworld · korean-law (ego lite 는 내려받기 페이지를 연다)
#   5. API 키 입력 화면(브라우저) — 키는 이 컴퓨터의 각 도구 설정에만 저장된다
#   6. 진단(doctor) 후 완료 표시
# 다시 실행해도 된다 — 없는 것은 설치, 이미 있는 것은 최신 버전으로 업그레이드 (PES 0.15 위에 그대로 덮는다).
# 환경변수: PES_TARGET=desktop|cli (기본 auto), PES_REPO (기본 clazic/pes), PES_SKIP_KEYS=1 (키 화면 건너뛰기), PES_NO_UPGRADE=1 (업그레이드 안 함)
#   시험·CI 용 이음매: PES_INSTALL_MIRROR=<폴더> (네트워크·git clone 대신 이 폴더가 저장소 — bootstrap 과 %USERPROFILE%\.pes\src 의 원본),
#   PES_INSTALL_PATH_ONLY=1 (PATH 를 부른 쪽이 준 그대로 쓴다), PES_SKIP_TOOLS=1 (4단계 조사 도구 설치·업그레이드를 건너뜀)

$ErrorActionPreference = "Continue"
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Repo = if ($env:PES_REPO) { $env:PES_REPO } else { "clazic/pes" }
$Src = Join-Path $env:USERPROFILE ".pes\src"

function Step($n, $t) { Write-Host "`n[$n/6] $t" -ForegroundColor Cyan }
function Ok($t) { Write-Host "  OK  $t" -ForegroundColor Green }
function Warn($t) { Write-Host "  !!  $t" -ForegroundColor Yellow }
function Fail($t) { Write-Host "  XX  $t" -ForegroundColor Red }
# a stop: exit 1 when run as a file (-File, CI, bootstrap path); the README way (irm | iex) just returns so the window stays open
function Stop-Install { if ($PSCommandPath) { exit 1 } }
function Refresh-Path {
  if ($env:PES_INSTALL_PATH_ONLY -eq "1") { return }
  $m = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $u = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$m;$u;$env:USERPROFILE\.local\bin"
}

Write-Host "PES 설치를 시작합니다 ($Repo)" -ForegroundColor Cyan

# 1. 기본 도구 — 저장소를 받기 전이므로 bootstrap 을 직접 내려받아 실행 (PES_INSTALL_MIRROR 가 있으면 그 폴더의 것)
Step 1 "기본 도구 (Git · Node.js 26 이상)"
$tmp = $null
if ($env:PES_INSTALL_MIRROR) {
  $boot = Join-Path $env:PES_INSTALL_MIRROR "scripts\bootstrap.ps1"
  if (-not (Test-Path $boot)) { Fail "bootstrap.ps1 을 찾지 못함: $boot"; Stop-Install; return }
} else {
  $tmp = Join-Path $env:TEMP "pes-bootstrap-$(Get-Random).ps1"
  $boot = $tmp
  try {
    Invoke-WebRequest "https://raw.githubusercontent.com/$Repo/main/scripts/bootstrap.ps1" -OutFile $tmp -UseBasicParsing
  } catch { Fail "bootstrap.ps1 을 받지 못함: $($_.Exception.Message)"; Stop-Install; return }
}
$nodeCmd = $null
# the PowerShell that runs this script (powershell.exe or pwsh.exe) by its full path — 'powershell' may not be on PATH
$psExe = (Get-Process -Id $PID).Path
& $psExe -NoProfile -ExecutionPolicy Bypass -File $boot | ForEach-Object {
  $line = "$_"
  if ($line -like "NODE *") { $nodeCmd = $line.Substring(5).Trim() } elseif ($line -like "OK *" -or $line -like "INSTALLED *") { Ok $line } elseif ($line -like "FAIL *" -or $line -like "MISSING *") { Fail $line } else { Write-Host "  $line" }
}
if ($tmp) { Remove-Item $tmp -ErrorAction SilentlyContinue }
Refresh-Path
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail "git 이 없습니다 — Git for Windows 설치 후 다시 실행하세요 (https://git-scm.com/download/win)"; Stop-Install; return }
if (-not $nodeCmd -or $nodeCmd -eq "none") { Fail "Node.js 26 이상이 필요합니다 — https://nodejs.org 에서 설치한 뒤 새 PowerShell 창에서 다시 실행하세요"; Stop-Install; return }

# 2. Claude (플러그인 등록에 쓸 claude 실행 파일)
#   PES_TARGET=desktop : Claude Desktop 안에 들어 있는 Claude Code 를 쓴다 (별도 CLI 를 설치하지 않음)
#   PES_TARGET=cli     : Claude Code CLI 를 쓴다 (없으면 설치)
#   기본(auto)          : PATH 의 claude → 없으면 Claude Desktop 안의 것 → 둘 다 없으면 CLI 설치
Step 2 "Claude (플러그인을 등록할 곳)"
function Find-DesktopClaude {
  $roots = @("$env:APPDATA\Claude\claude-code", "$env:LOCALAPPDATA\Claude\claude-code", "$env:LOCALAPPDATA\AnthropicClaude", "$env:LOCALAPPDATA\Programs\Claude")
  $c = foreach ($r in $roots) { if (Test-Path $r) { Get-ChildItem $r -Recurse -Filter "claude.exe" -ErrorAction SilentlyContinue } }
  $c = $c | Where-Object { $_.FullName -match "claude-code" } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($c) { return $c.FullName } else { return $null }
}
$Target = if ($env:PES_TARGET) { $env:PES_TARGET.ToLower() } else { "auto" }
$Claude = $null
if ($Target -ne "desktop") { $cmd = Get-Command claude -ErrorAction SilentlyContinue; if ($cmd) { $Claude = $cmd.Source } }
if (-not $Claude -and $Target -ne "cli") {
  $Claude = Find-DesktopClaude
  if ($Claude) { Ok "Claude Desktop 안의 Claude Code 사용: $Claude" }
}
if (-not $Claude -and $Target -eq "desktop") {
  Warn "Claude Desktop 안의 Claude Code 를 찾지 못함 — Claude Desktop 을 설치하고 Code 탭을 한 번 연 뒤 다시 실행하세요."
  Warn "지금은 Claude 설정 파일에 PES 마켓플레이스를 등록해 둡니다 (Code 탭을 열면 설치됨)."
  $sf = Join-Path $env:USERPROFILE ".claude\settings.json"
  New-Item -ItemType Directory -Force -Path (Split-Path $sf) | Out-Null
  $j = if (Test-Path $sf) { Copy-Item $sf "$sf.bak-pes" -Force; Get-Content $sf -Raw -Encoding UTF8 | ConvertFrom-Json } else { [pscustomobject]@{} }
  if (-not $j.extraKnownMarketplaces) { $j | Add-Member -NotePropertyName extraKnownMarketplaces -NotePropertyValue ([pscustomobject]@{}) -Force }
  if (-not $j.enabledPlugins) { $j | Add-Member -NotePropertyName enabledPlugins -NotePropertyValue ([pscustomobject]@{}) -Force }
  $j.extraKnownMarketplaces | Add-Member -NotePropertyName "pes-local" -NotePropertyValue ([pscustomobject]@{ source = [pscustomobject]@{ source = "github"; repo = $Repo } }) -Force
  $j.enabledPlugins | Add-Member -NotePropertyName "pes@pes-local" -NotePropertyValue $true -Force
  [IO.File]::WriteAllText($sf, ($j | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding($false)))
  Ok "등록: $sf (extraKnownMarketplaces.pes-local, enabledPlugins pes@pes-local)"
}
if (-not $Claude -and $Target -ne "desktop") {
  Warn "claude 를 찾지 못해 Claude Code CLI 를 공식 설치 스크립트로 설치합니다 (https://claude.ai/install.ps1)"
  try { Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression } catch { Fail "Claude Code CLI 설치 실패: $($_.Exception.Message)" }
  Refresh-Path
  $cmd = Get-Command claude -ErrorAction SilentlyContinue; if ($cmd) { $Claude = $cmd.Source }
}
if ($Claude -and -not $env:PES_NO_UPGRADE -and $Claude -notmatch "claude-code") {
  $before = & $Claude --version 2>$null; & $Claude update 2>&1 | Out-Null; $after = & $Claude --version 2>$null
  if ($after -ne $before) { Ok "claude 업그레이드: $before → $after" }
}
if ($Claude) { Ok "claude $(& $Claude --version 2>$null)" } elseif ($Target -ne "desktop") { Fail "claude 를 찾지 못함 — 새 PowerShell 창에서 다시 실행하세요"; Stop-Install; return }

# 3. PES 플러그인
Step 3 "PES 플러그인"
if ($Claude) {
  & $Claude plugin marketplace add $Repo 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { & $Claude plugin marketplace update pes-local 2>&1 | Out-Null }
  & $Claude plugin install pes@pes-local 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { & $Claude plugin update pes@pes-local 2>&1 | Out-Null }
  $plist = & $Claude plugin list 2>&1 | Out-String
  if ($plist -match "pes") { Ok "pes@pes-local 설치됨 (Claude Desktop Code 탭과 Claude Code 가 함께 씀: $env:USERPROFILE\.claude)" } else { Warn "플러그인 목록에서 pes 를 확인하지 못함 — Claude Desktop 에서 /reload-plugins 후 /pes:doctor" }
} else { Warn "설정 파일에만 등록함 — Claude Desktop Code 탭을 열고 /reload-plugins, 안 보이면 + → Add plugins 에서 $Repo" }

# 설치 도우미는 같은 저장소를 ~/.pes/src 에 받아 둔 것 (이미 있으면 최신으로 — 0.15 설치 위에도 그대로 덮는다)
if ($env:PES_INSTALL_MIRROR) {
  New-Item -ItemType Directory -Force -Path $Src | Out-Null
  Copy-Item -Path (Join-Path $env:PES_INSTALL_MIRROR "*") -Destination $Src -Recurse -Force
} elseif (Test-Path (Join-Path $Src ".git")) { & git -C $Src pull -q 2>&1 | Out-Null } else { New-Item -ItemType Directory -Force -Path (Split-Path $Src) | Out-Null; & git clone -q "https://github.com/$Repo.git" $Src 2>&1 | Out-Null }
if (-not (Test-Path (Join-Path $Src "scripts\setup.ts"))) { Fail "설치 도우미를 받지 못함 ($Src)"; Stop-Install; return }
function NodeRun { & node @args }

# 4. 조사 도구
Step 4 "조사 도구 (kosis · vworld · korean-law · ego lite)"
if ($env:PES_SKIP_TOOLS -eq "1") { Warn "건너뜀 (PES_SKIP_TOOLS=1)" } else {
  NodeRun (Join-Path $Src "scripts\setup.ts") install missing | ForEach-Object {
    $l = "$_"
    if ($l -like "OK *") { Ok $l } elseif ($l -like "USER *") { Warn $l } elseif ($l -like "FAIL *") { Fail $l } elseif ($l -like "SKIP *") { Write-Host "  $l" }
  }
  Refresh-Path
  if ($env:PES_NO_UPGRADE -ne "1") {
    Write-Host "  이미 있던 도구를 최신 버전으로 맞춥니다"
    NodeRun (Join-Path $Src "scripts\setup.ts") upgrade all | ForEach-Object {
      $l = "$_"
      if ($l -like "UPGRADED *") { Ok $l } elseif ($l -like "OK *") { Write-Host "  $l" } elseif ($l -like "FAIL *") { Warn $l }
    }
  }
}

# 5. API 키
Step 5 "API 키"
if ($env:PES_SKIP_KEYS -eq "1") { Warn "건너뜀 (PES_SKIP_KEYS=1) — 나중에 Claude 에서 /pes:setup keys" } else { NodeRun (Join-Path $Src "scripts\setup.ts") keys --wait | ForEach-Object { Write-Host "  $_" } }

# 6. 진단
Step 6 "진단"
NodeRun (Join-Path $Src "scripts\pes.ts") doctor --net | ForEach-Object { Write-Host "  $_" }
NodeRun (Join-Path $Src "scripts\setup.ts") mark | ForEach-Object { Ok $_ }

Write-Host "`n완료. Claude Desktop 을 완전히 종료했다가(작업 표시줄 아이콘에서도) 다시 열고, Code 탭에서 /pes:start <주제> 로 시작하세요." -ForegroundColor Cyan
Write-Host "ego lite 를 이번에 설치했다면 앱에서 첫 실행 안내(온보딩)를 마쳐야 브라우저 조사를 쓸 수 있습니다."
