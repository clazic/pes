# PES 한 줄 설치 — Claude Desktop(Windows) 전용
#   irm https://raw.githubusercontent.com/clazic/pes/main/scripts/install-desktop.ps1 | iex
# Claude Code CLI 를 따로 설치하지 않고, Claude Desktop 안에 들어 있는 Claude Code 로 플러그인을 등록한다.
# (Claude Desktop 의 Code 탭과 Claude Code 는 같은 설정 폴더 %USERPROFILE%\.claude 를 쓴다)
# 환경변수: PES_INSTALL_MIRROR=<폴더> — 네트워크 대신 이 폴더(저장소 사본)의 install.ps1 을 쓴다 (시험·CI 용)
$env:PES_TARGET = "desktop"
$repo = if ($env:PES_REPO) { $env:PES_REPO } else { "clazic/pes" }
if ($env:PES_INSTALL_MIRROR) {
  & (Join-Path $env:PES_INSTALL_MIRROR "scripts\install.ps1")
} else {
  Invoke-RestMethod "https://raw.githubusercontent.com/$repo/main/scripts/install.ps1" | Invoke-Expression
}
