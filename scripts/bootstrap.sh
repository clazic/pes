#!/bin/sh
# PES 1단계 준비 (macOS·Linux): Git · Node.js 26 이상 확인 후 없으면 설치(Homebrew)
# 사용: sh bootstrap.sh [--check]
# 출력: 한 줄씩 "<OK|INSTALLED|MISSING|FAIL> <이름> <설명>"   마지막 줄 "NODE <실행 명령>" (Node.js 26 이상이 없으면 "NODE none")
# 환경변수: PES_INSTALL_PATH_ONLY=1 — PATH 를 부른 쪽이 준 그대로 쓴다 (Homebrew 같은 알려진 위치를 앞에 붙이지 않음; 시험·CI 용)
CHECK=0; [ "$1" = "--check" ] && CHECK=1
if [ "$PES_INSTALL_PATH_ONLY" != 1 ]; then PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"; export PATH; fi
BREW=$(command -v brew || true)

# node 의 큰 버전이 26 이상이면 "node" 를 돌려준다 (v26.1.0 → 26)
nodeok() { v=$(node --version 2>/dev/null | head -1); m=$(printf %s "$v" | sed -n 's/^v\{0,1\}\([0-9][0-9]*\)\..*/\1/p'); [ -n "$m" ] && [ "$m" -ge 26 ] && { echo node; return; }; }

# git (macOS: Xcode Command Line Tools 에 들어 있음)
if git --version >/dev/null 2>&1; then echo "OK git $(git --version)"
elif [ $CHECK = 1 ]; then echo "MISSING git Xcode Command Line Tools"
elif [ "$(uname -s)" = Darwin ]; then
  xcode-select --install >/dev/null 2>&1
  echo "FAIL git 설치 창이 열렸습니다 — 'Command Line Tools' 설치를 끝낸 뒤 /pes:setup 을 다시 실행"
elif [ -n "$BREW" ]; then brew install git >/dev/null 2>&1 && echo "INSTALLED git $(git --version)" || echo "FAIL git"
else echo "FAIL git 패키지 관리자로 설치 필요"; fi

# node 26+ (PES 도구는 Node 로 돌아간다 — 다른 런타임은 필요 없다)
N=$(nodeok)
if [ -n "$N" ]; then echo "OK node $(node --version 2>/dev/null | head -1)"
elif [ $CHECK = 1 ]; then echo "MISSING node Node.js 26 이상 필요 (PES 도구 실행)"
elif [ -n "$BREW" ]; then
  brew install node >/dev/null 2>&1 || brew upgrade node >/dev/null 2>&1
  N=$(nodeok)
  [ -n "$N" ] && echo "INSTALLED node $(node --version 2>/dev/null | head -1)" || echo "FAIL node 설치 후에도 Node.js 26 이상을 찾지 못함 — 새 터미널에서 다시 실행하거나 https://nodejs.org 에서 설치"
else echo "FAIL node Homebrew 가 없어 자동 설치 불가 — https://nodejs.org 에서 Node.js 26 이상 설치"; fi

N=$(nodeok); echo "NODE ${N:-none}"
