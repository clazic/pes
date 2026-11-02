#!/bin/sh
# PES 한 줄 설치 (macOS·Linux)
#   curl -fsSL https://raw.githubusercontent.com/clazic/pes/main/scripts/install.sh | bash   (| sh 도 된다)
# 하는 일: 기본 도구(Git·Python·Node.js) → Claude Code CLI → PES 플러그인 → 조사 도구 → API 키 화면 → 진단
# 다시 실행해도 된다 — 없는 것은 설치, 이미 있는 것은 최신으로 업그레이드.
# 환경변수: PES_REPO (기본 clazic/pes), PES_SKIP_KEYS=1, PES_NO_UPGRADE=1
REPO="${PES_REPO:-clazic/pes}"
SRC="$HOME/.pes/src"
PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"; export PATH
step() { printf "\n[%s/6] %s\n" "$1" "$2"; }
say() { printf "  %s\n" "$1"; }

echo "PES 설치를 시작합니다 ($REPO)"

step 1 "기본 도구 (Git · Python · Node.js)"
TMP=$(mktemp)
if ! curl -fsSL "https://raw.githubusercontent.com/$REPO/main/scripts/bootstrap.sh" -o "$TMP"; then
  echo "  XX bootstrap.sh 를 받지 못함"; exit 1
fi
PY=""
sh "$TMP" | while IFS= read -r l; do say "$l"; done
PY=$(sh "$TMP" --check | sed -n 's/^PYTHON //p')
rm -f "$TMP"
command -v git >/dev/null 2>&1 || { echo "  XX git 이 없습니다 — Command Line Tools 설치를 끝낸 뒤 다시 실행"; exit 1; }
[ -n "$PY" ] && [ "$PY" != none ] || { echo "  XX Python 3.9+ 없음"; exit 1; }

step 2 "Claude Code CLI"
if ! command -v claude >/dev/null 2>&1; then
  say "claude 명령이 없어 공식 설치 스크립트로 설치합니다 (https://claude.ai/install.sh)"
  curl -fsSL https://claude.ai/install.sh | bash || say "XX Claude Code CLI 설치 실패"
fi
if command -v claude >/dev/null 2>&1 && [ "$PES_NO_UPGRADE" != 1 ]; then
  B=$(claude --version 2>/dev/null); claude update >/dev/null 2>&1; A=$(claude --version 2>/dev/null)
  [ "$A" != "$B" ] && say "OK claude 업그레이드: $B → $A"
fi
command -v claude >/dev/null 2>&1 && say "OK claude $(claude --version 2>/dev/null)" || { echo "  XX claude 명령 없음 — 새 터미널에서 다시 실행"; exit 1; }

step 3 "PES 플러그인"
claude plugin marketplace add "$REPO" >/dev/null 2>&1 || claude plugin marketplace update pes-local >/dev/null 2>&1
claude plugin install pes@pes-local >/dev/null 2>&1 || claude plugin update pes@pes-local >/dev/null 2>&1
claude plugin list 2>/dev/null | grep -q pes && say "OK pes@pes-local 설치됨" || say "!! 플러그인 확인 실패 — Claude 에서 /reload-plugins 후 /pes:doctor"
if [ -d "$SRC/.git" ]; then git -C "$SRC" pull -q; else mkdir -p "$(dirname "$SRC")" && git clone -q "https://github.com/$REPO.git" "$SRC"; fi
[ -f "$SRC/scripts/setup.py" ] || { echo "  XX 설치 도우미를 받지 못함 ($SRC)"; exit 1; }

step 4 "조사 도구 (kosis · vworld · korean-law · ego lite)"
$PY -I "$SRC/scripts/setup.py" install missing | while IFS= read -r l; do say "$l"; done
if [ "$PES_NO_UPGRADE" != 1 ]; then
  say "이미 있던 도구를 최신 버전으로 맞춥니다"
  $PY -I "$SRC/scripts/setup.py" upgrade all | grep -v '^\.\.\.' | while IFS= read -r l; do say "$l"; done
fi

step 5 "API 키"
if [ "$PES_SKIP_KEYS" = 1 ]; then say "건너뜀 — 나중에 Claude 에서 /pes:setup keys"
else $PY -I "$SRC/scripts/setup.py" keys --wait < /dev/tty | while IFS= read -r l; do say "$l"; done; fi

step 6 "진단"
$PY -I "$SRC/scripts/pes.py" doctor --net | while IFS= read -r l; do say "$l"; done
$PY -I "$SRC/scripts/setup.py" mark | while IFS= read -r l; do say "$l"; done

echo ""
echo "완료. Claude Code(또는 Claude Desktop)를 다시 시작하고 /pes:start <주제> 로 시작하세요."
