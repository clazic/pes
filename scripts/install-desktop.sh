#!/bin/sh
# PES 한 줄 설치 — Claude Desktop(macOS) 전용
#   curl -fsSL https://raw.githubusercontent.com/clazic/pes/main/scripts/install-desktop.sh | bash
# Claude Code CLI 를 따로 설치하지 않고, Claude Desktop 안에 들어 있는 Claude Code 로 플러그인을 등록한다.
# (Claude Desktop 의 Code 탭과 Claude Code 는 같은 설정 폴더 ~/.claude 를 쓴다)
REPO="${PES_REPO:-clazic/pes}"
curl -fsSL "https://raw.githubusercontent.com/$REPO/main/scripts/install.sh" | PES_TARGET=desktop PES_REPO="$REPO" PES_SKIP_KEYS="$PES_SKIP_KEYS" PES_NO_UPGRADE="$PES_NO_UPGRADE" sh
