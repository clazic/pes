#!/bin/sh
# PES 1단계 준비 (macOS·Linux): Git · Python 3 · Node.js 확인 후 없으면 설치(Homebrew)
# 사용: sh bootstrap.sh [--check]
# 출력: 한 줄씩 "<OK|INSTALLED|MISSING|FAIL> <이름> <설명>"   마지막 줄 "PYTHON <실행 명령>"
CHECK=0; [ "$1" = "--check" ] && CHECK=1
PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"; export PATH
BREW=$(command -v brew || true)

ver() { "$@" 2>/dev/null | head -1; }
pyok() { for c in python3 python; do v=$($c -c 'import sys;print("%d.%d"%sys.version_info[:2]) if sys.version_info>=(3,9) else None' 2>/dev/null); [ -n "$v" ] && [ "$v" != "None" ] && { echo "$c"; return; }; done; }

# git (macOS: Xcode Command Line Tools 에 들어 있음)
if git --version >/dev/null 2>&1; then echo "OK git $(git --version)"
elif [ $CHECK = 1 ]; then echo "MISSING git Xcode Command Line Tools"
elif [ "$(uname -s)" = Darwin ]; then
  xcode-select --install >/dev/null 2>&1
  echo "FAIL git 설치 창이 열렸습니다 — 'Command Line Tools' 설치를 끝낸 뒤 /pes:setup 을 다시 실행"
elif [ -n "$BREW" ]; then brew install git >/dev/null 2>&1 && echo "INSTALLED git $(git --version)" || echo "FAIL git"
else echo "FAIL git 패키지 관리자로 설치 필요"; fi

# python 3.9+
P=$(pyok)
if [ -n "$P" ]; then echo "OK python $($P --version 2>&1)"
elif [ $CHECK = 1 ]; then echo "MISSING python Python 3.9 이상"
elif [ -n "$BREW" ]; then brew install python >/dev/null 2>&1; P=$(pyok); [ -n "$P" ] && echo "INSTALLED python $($P --version 2>&1)" || echo "FAIL python"
else echo "FAIL python Homebrew 가 없어 자동 설치 불가 — https://www.python.org/downloads/ 에서 설치"; fi

# node (npm)
if v=$(ver node --version) && [ -n "$v" ]; then echo "OK node $v"
elif [ $CHECK = 1 ]; then echo "MISSING node korean-law 설치(npm)에 필요"
elif [ -n "$BREW" ]; then brew install node >/dev/null 2>&1 && echo "INSTALLED node $(node --version)" || echo "FAIL node"
else echo "FAIL node Homebrew 가 없어 자동 설치 불가 — https://nodejs.org 에서 LTS 설치"; fi

P=$(pyok); echo "PYTHON ${P:-none}"
