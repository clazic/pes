# PES 1단계 준비 (Windows): Git(Git Bash) · Python 3 · Node.js 확인 후 없으면 winget 으로 설치
# 사용: powershell -NoProfile -ExecutionPolicy Bypass -File bootstrap.ps1 [-CheckOnly]
# 출력: 한 줄씩  "<OK|INSTALLED|MISSING|FAIL> <이름> <설명>"   마지막 줄 "PYTHON <실행 명령>"
param([switch]$CheckOnly)
$ErrorActionPreference = "Continue"
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

function Refresh-Path {
  $m = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $u = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$m;$u"
}
function Ver($cmd, $arg) {
  try { $o = & $cmd $arg 2>&1 | Select-Object -First 1; if ($LASTEXITCODE -eq 0 -or $o) { return "$o".Trim() } } catch { }
  return $null
}
function Find-Python {
  foreach ($c in @(@("py", "-3"), @("python3"), @("python"))) {
    try {
      $o = if ($c.Count -gt 1) { & $c[0] $c[1] --version 2>&1 } else { & $c[0] --version 2>&1 }
      if ("$o" -match "Python 3\.(\d+)" -and [int]$Matches[1] -ge 9) { return ($c -join " ") }
    } catch { }
  }
  return $null
}
$winget = [bool](Get-Command winget -ErrorAction SilentlyContinue)
$items = @(
  @{ name = "git";    id = "Git.Git";            test = { Ver git --version } ; note = "Git Bash 포함 (답 자동 수신·플러그인 받기에 필요)" },
  @{ name = "python"; id = "Python.Python.3.12"; test = { Find-Python } ; note = "PES CLI" },
  @{ name = "node";   id = "OpenJS.NodeJS.LTS";  test = { Ver node --version } ; note = "korean-law 설치(npm)에 필요" }
)
foreach ($it in $items) {
  $v = & $it.test
  if ($v) { Write-Output "OK $($it.name) $v"; continue }
  if ($CheckOnly) { Write-Output "MISSING $($it.name) $($it.note)"; continue }
  if (-not $winget) { Write-Output "FAIL $($it.name) winget 없음 — 직접 설치 필요 ($($it.note))"; continue }
  Write-Output "INSTALLING $($it.name) (winget $($it.id)) ..."
  winget install --id $it.id -e --silent --accept-package-agreements --accept-source-agreements --scope user 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { winget install --id $it.id -e --silent --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null }
  Refresh-Path
  $v = & $it.test
  if ($v) { Write-Output "INSTALLED $($it.name) $v" } else { Write-Output "FAIL $($it.name) 설치 후에도 찾지 못함 — Claude Desktop 을 다시 시작한 뒤 /pes:setup 을 다시 실행" }
}
$py = Find-Python
if ($py) { Write-Output "PYTHON $py" } else { Write-Output "PYTHON none" }
