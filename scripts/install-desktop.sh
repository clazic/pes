#!/bin/sh
# PES 한 줄 설치 — Claude Desktop(macOS) 전용
#   curl -fsSL https://raw.githubusercontent.com/clazic/pes/main/scripts/install-desktop.sh | bash
# Claude Code CLI 를 따로 설치하지 않고, Claude Desktop 안에 들어 있는 Claude Code 로 플러그인을 등록한다.
# (Claude Desktop 의 Code 탭과 Claude Code 는 같은 설정 폴더 ~/.claude 를 쓴다)
# 환경변수: PES_INSTALL_MIRROR=<폴더> — 네트워크 대신 이 폴더(저장소 사본)의 install.sh 를 쓴다 (시험·CI 용)
REPO="${PES_REPO:-clazic/pes}"
if [ -n "$PES_INSTALL_MIRROR" ]; then
  PES_TARGET=desktop PES_REPO="$REPO" sh "$PES_INSTALL_MIRROR/scripts/install.sh"
else
  curl -fsSL "https://raw.githubusercontent.com/$REPO/main/scripts/install.sh" | PES_TARGET=desktop PES_REPO="$REPO" PES_SKIP_KEYS="$PES_SKIP_KEYS" PES_NO_UPGRADE="$PES_NO_UPGRADE" sh
fi
