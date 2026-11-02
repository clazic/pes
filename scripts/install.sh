#!/bin/sh
# PES 한 줄 설치 (macOS·Linux)
#   curl -fsSL https://raw.githubusercontent.com/clazic/pes/main/scripts/install.sh | bash   (| sh 도 된다)
# 하는 일: 기본 도구(Git·Python·Node.js) → Claude Code CLI → PES 플러그인 → 조사 도구 → API 키 화면 → 진단
# Claude Desktop 전용: install-desktop.sh 또는 PES_TARGET=desktop
# 다시 실행해도 된다 — 없는 것은 설치, 이미 있는 것은 최신으로 업그레이드.
# 환경변수: PES_TARGET=desktop|cli (기본 auto), PES_REPO (기본 clazic/pes), PES_SKIP_KEYS=1, PES_NO_UPGRADE=1
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

step 2 "Claude (플러그인을 등록할 곳)"
# PES_TARGET=desktop: Claude Desktop 안의 Claude Code 사용(별도 CLI 설치 안 함) / cli: Claude Code CLI / 기본 auto
TARGET=$(printf %s "${PES_TARGET:-auto}" | tr 'A-Z' 'a-z')
desktop_claude() {
  for d in "$HOME/Library/Application Support/Claude/claude-code" "$HOME/.config/Claude/claude-code"; do
    [ -d "$d" ] || continue
    ls -t "$d"/*/*/claude.app/Contents/MacOS/claude "$d"/*/*/claude "$d"/*/claude 2>/dev/null | head -1 && return
  done
}
CLAUDE=""
[ "$TARGET" != desktop ] && CLAUDE=$(command -v claude || true)
if [ -z "$CLAUDE" ] && [ "$TARGET" != cli ]; then
  CLAUDE=$(desktop_claude)
  [ -n "$CLAUDE" ] && say "OK Claude Desktop 안의 Claude Code 사용: $CLAUDE"
fi
if [ -z "$CLAUDE" ] && [ "$TARGET" = desktop ]; then
  say "!! Claude Desktop 안의 Claude Code 를 찾지 못함 — Claude Desktop 을 설치하고 Code 탭을 한 번 연 뒤 다시 실행하세요."
  say "!! 지금은 Claude 설정 파일에 PES 마켓플레이스를 등록해 둡니다 (Code 탭을 열면 설치됨)."
  python3 - "$REPO" <<'PYEOF'
import json, sys, shutil
from pathlib import Path
f = Path.home() / ".claude" / "settings.json"; f.parent.mkdir(parents=True, exist_ok=True)
d = {}
if f.exists():
    shutil.copy2(f, str(f) + ".bak-pes"); d = json.loads(f.read_text(encoding="utf-8"))
d.setdefault("extraKnownMarketplaces", {})["pes-local"] = {"source": {"source": "github", "repo": sys.argv[1]}}
d.setdefault("enabledPlugins", {})["pes@pes-local"] = True
f.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
print("  OK 등록:", f)
PYEOF
fi
if [ -z "$CLAUDE" ] && [ "$TARGET" != desktop ]; then
  say "claude 를 찾지 못해 Claude Code CLI 를 공식 설치 스크립트로 설치합니다 (https://claude.ai/install.sh)"
  curl -fsSL https://claude.ai/install.sh | bash || say "XX Claude Code CLI 설치 실패"
  CLAUDE=$(command -v claude || true)
fi
case "$CLAUDE" in *claude-code*) ;; "") ;; *)
  if [ "$PES_NO_UPGRADE" != 1 ]; then
    B=$("$CLAUDE" --version 2>/dev/null); "$CLAUDE" update >/dev/null 2>&1; A=$("$CLAUDE" --version 2>/dev/null)
    [ "$A" != "$B" ] && say "OK claude 업그레이드: $B → $A"
  fi ;;
esac
if [ -n "$CLAUDE" ]; then say "OK claude $("$CLAUDE" --version 2>/dev/null)"
elif [ "$TARGET" != desktop ]; then echo "  XX claude 를 찾지 못함 — 새 터미널에서 다시 실행"; exit 1; fi

step 3 "PES 플러그인"
if [ -n "$CLAUDE" ]; then
  "$CLAUDE" plugin marketplace add "$REPO" >/dev/null 2>&1 || "$CLAUDE" plugin marketplace update pes-local >/dev/null 2>&1
  "$CLAUDE" plugin install pes@pes-local >/dev/null 2>&1 || "$CLAUDE" plugin update pes@pes-local >/dev/null 2>&1
  "$CLAUDE" plugin list 2>/dev/null | grep -q pes && say "OK pes@pes-local 설치됨 (Claude Desktop Code 탭과 Claude Code 가 함께 씀: ~/.claude)" || say "!! 플러그인 확인 실패 — Claude 에서 /reload-plugins 후 /pes:doctor"
else
  say "!! 설정 파일에만 등록함 — Claude Desktop Code 탭을 열고 /reload-plugins"
fi
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
