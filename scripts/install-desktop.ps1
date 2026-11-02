# PES 한 줄 설치 — Claude Desktop(Windows) 전용
#   irm https://raw.githubusercontent.com/clazic/pes/main/scripts/install-desktop.ps1 | iex
# Claude Code CLI 를 따로 설치하지 않고, Claude Desktop 안에 들어 있는 Claude Code 로 플러그인을 등록한다.
# (Claude Desktop 의 Code 탭과 Claude Code 는 같은 설정 폴더 %USERPROFILE%\.claude 를 쓴다)
$env:PES_TARGET = "desktop"
$repo = if ($env:PES_REPO) { $env:PES_REPO } else { "clazic/pes" }
Invoke-RestMethod "https://raw.githubusercontent.com/$repo/main/scripts/install.ps1" | Invoke-Expression
