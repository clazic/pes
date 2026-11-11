# PES 1단계 준비 (Windows): Git(Git Bash) · Node.js 26 이상 확인 후 없으면 winget 으로 설치
# 사용: powershell -NoProfile -ExecutionPolicy Bypass -File bootstrap.ps1 [-CheckOnly]
# 출력: 한 줄씩  "<OK|INSTALLED|MISSING|FAIL> <이름> <설명>"   마지막 줄 "NODE <실행 명령>" (Node.js 26 이상이 없으면 "NODE none")
# 환경변수: PES_INSTALL_PATH_ONLY=1 — PATH 를 부른 쪽이 준 그대로 쓴다 (레지스트리 PATH 로 다시 읽지 않음; 시험·CI 용)
param([switch]$CheckOnly)
$ErrorActionPreference = "Continue"
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

function Refresh-Path {
  if ($env:PES_INSTALL_PATH_ONLY -eq "1") { return }
  $m = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $u = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$m;$u"
}
function Ver($cmd, $arg) {
  try { $o = & $cmd $arg 2>&1 | Select-Object -First 1; if ($LASTEXITCODE -eq 0 -or $o) { return "$o".Trim() } } catch { }
  return $null
}
# node 의 큰 버전이 26 이상이면 버전 문자열(v26.1.0), 아니면 $null
function Find-Node {
  $v = Ver node --version
  if ($v -and "$v" -match "^v?(\d+)\." -and [int]$Matches[1] -ge 26) { return $v }
  return $null
}
$winget = [bool](Get-Command winget -ErrorAction SilentlyContinue)
$items = @(
  @{ name = "git";  id = "Git.Git";        test = { Ver git --version } ; note = "Git Bash 포함 (답 자동 수신·플러그인 받기에 필요)" },
  @{ name = "node"; id = "OpenJS.NodeJS";  test = { Find-Node } ; note = "Node.js 26 이상 필요 (PES 도구 실행) — https://nodejs.org" }
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
if (Find-Node) { Write-Output "NODE node" } else { Write-Output "NODE none" }
