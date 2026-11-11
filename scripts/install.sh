#!/bin/sh
# PES 한 줄 설치 (macOS·Linux)
#   curl -fsSL https://raw.githubusercontent.com/clazic/pes/main/scripts/install.sh | bash   (| sh 도 된다)
# 하는 일: 기본 도구(Git·Node.js 26+) → Claude Code CLI → PES 플러그인 → 조사 도구 → API 키 화면 → 진단
# Claude Desktop 전용: install-desktop.sh 또는 PES_TARGET=desktop
# 다시 실행해도 된다 — 없는 것은 설치, 이미 있는 것은 최신으로 업그레이드 (PES 0.15 위에 그대로 덮는다).
# 환경변수: PES_TARGET=desktop|cli (기본 auto), PES_REPO (기본 clazic/pes), PES_SKIP_KEYS=1, PES_NO_UPGRADE=1
#   시험·CI 용 이음매: PES_INSTALL_MIRROR=<폴더> (네트워크·git clone 대신 이 폴더가 저장소 — bootstrap 과 ~/.pes/src 의 원본),
#   PES_INSTALL_PATH_ONLY=1 (PATH 를 부른 쪽이 준 그대로 쓴다), PES_SKIP_TOOLS=1 (4단계 조사 도구 설치·업그레이드를 건너뜀)
REPO="${PES_REPO:-clazic/pes}"
SRC="$HOME/.pes/src"
if [ "$PES_INSTALL_PATH_ONLY" != 1 ]; then PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"; export PATH; fi
step() { printf "\n[%s/6] %s\n" "$1" "$2"; }
say() { printf "  %s\n" "$1"; }

echo "PES 설치를 시작합니다 ($REPO)"

step 1 "기본 도구 (Git · Node.js 26 이상)"
if [ -n "$PES_INSTALL_MIRROR" ]; then
  BOOT="$PES_INSTALL_MIRROR/scripts/bootstrap.sh"; TMP=""
  [ -f "$BOOT" ] || { echo "  XX bootstrap.sh 를 찾지 못함 ($BOOT)"; exit 1; }
else
  TMP=$(mktemp); BOOT="$TMP"
  if ! curl -fsSL "https://raw.githubusercontent.com/$REPO/main/scripts/bootstrap.sh" -o "$TMP"; then
    echo "  XX bootstrap.sh 를 받지 못함"; exit 1
  fi
fi
NODE=""
sh "$BOOT" | while IFS= read -r l; do say "$l"; done
NODE=$(sh "$BOOT" --check | sed -n 's/^NODE //p')
[ -n "$TMP" ] && rm -f "$TMP"
command -v git >/dev/null 2>&1 || { echo "  XX git 이 없습니다 — Command Line Tools 설치를 끝낸 뒤 다시 실행"; exit 1; }
[ -n "$NODE" ] && [ "$NODE" != none ] || { echo "  XX Node.js 26 이상이 필요합니다 — https://nodejs.org 에서 설치(또는 brew install node)한 뒤 새 터미널에서 다시 실행"; exit 1; }

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
  # 설정 파일의 다른 값은 그대로 두고 두 항목만 더한다 (고치기 전 파일은 settings.json.bak-pes 로 보관)
  node -e '
const fs = require("fs"), path = require("path"), os = require("os");
const f = path.join(os.homedir(), ".claude", "settings.json");
fs.mkdirSync(path.dirname(f), { recursive: true });
let d = {};
if (fs.existsSync(f)) { fs.copyFileSync(f, f + ".bak-pes"); d = JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, "")); }
d.extraKnownMarketplaces = d.extraKnownMarketplaces || {};
d.extraKnownMarketplaces["pes-local"] = { source: { source: "github", repo: process.argv[1] } };
d.enabledPlugins = d.enabledPlugins || {};
d.enabledPlugins["pes@pes-local"] = true;
fs.writeFileSync(f, JSON.stringify(d, null, 2), "utf8");
console.log("  OK 등록: " + f);
' "$REPO"
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
# 설치 도우미는 같은 저장소를 ~/.pes/src 에 받아 둔 것 (이미 있으면 최신으로 — 0.15 설치 위에도 그대로 덮는다)
if [ -n "$PES_INSTALL_MIRROR" ]; then mkdir -p "$SRC" && cp -R "$PES_INSTALL_MIRROR/." "$SRC/"
elif [ -d "$SRC/.git" ]; then git -C "$SRC" pull -q; else mkdir -p "$(dirname "$SRC")" && git clone -q "https://github.com/$REPO.git" "$SRC"; fi
[ -f "$SRC/scripts/setup.ts" ] || { echo "  XX 설치 도우미를 받지 못함 ($SRC)"; exit 1; }

step 4 "조사 도구 (kosis · vworld · korean-law · ego lite)"
if [ "$PES_SKIP_TOOLS" = 1 ]; then say "건너뜀 (PES_SKIP_TOOLS=1)"
else
  node "$SRC/scripts/setup.ts" install missing | while IFS= read -r l; do say "$l"; done
  if [ "$PES_NO_UPGRADE" != 1 ]; then
    say "이미 있던 도구를 최신 버전으로 맞춥니다"
    node "$SRC/scripts/setup.ts" upgrade all | grep -v '^\.\.\.' | while IFS= read -r l; do say "$l"; done
  fi
fi

step 5 "API 키"
if [ "$PES_SKIP_KEYS" = 1 ]; then say "건너뜀 — 나중에 Claude 에서 /pes:setup keys"
else node "$SRC/scripts/setup.ts" keys --wait < /dev/tty | while IFS= read -r l; do say "$l"; done; fi

step 6 "진단"
node "$SRC/scripts/pes.ts" doctor --net | while IFS= read -r l; do say "$l"; done
node "$SRC/scripts/setup.ts" mark | while IFS= read -r l; do say "$l"; done

echo ""
echo "완료. Claude Code(또는 Claude Desktop)를 다시 시작하고 /pes:start <주제> 로 시작하세요."
