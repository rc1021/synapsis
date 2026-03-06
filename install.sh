#!/bin/bash
# Synapsis installer
# curl -fsSL https://synapsis.ai/install.sh | bash
set -euo pipefail

REPO="https://github.com/rc1021/synapsis.git"
INSTALL_DIR="${SYNAPSIS_DIR:-$HOME/synapsis}"

# ── helpers ──────────────────────────────────────────────
c_reset='\033[0m'; c_green='\033[32m'; c_yellow='\033[33m'; c_red='\033[31m'; c_bold='\033[1m'
info()  { printf "${c_bold}${c_green}▸${c_reset} %s\n" "$*"; }
warn()  { printf "${c_bold}${c_yellow}▸${c_reset} %s\n" "$*"; }
fail()  { printf "${c_bold}${c_red}✗${c_reset} %s\n" "$*"; exit 1; }
ask()   { printf "${c_bold}${c_green}?${c_reset} %s " "$1"; }

# ── preflight ────────────────────────────────────────────
command -v git  >/dev/null || fail "git is required.  Install: https://git-scm.com"
command -v node >/dev/null || fail "node is required (v22+). Install: https://nodejs.org"
command -v npm  >/dev/null || fail "npm is required.  Comes with node."

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 22 ] 2>/dev/null || warn "Node v22+ recommended (you have v$(node -v | tr -d v))"

# ── clone / update ───────────────────────────────────────
if [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating existing installation at $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only || warn "Pull failed — continuing with current version"
else
  info "Cloning synapsis to $INSTALL_DIR"
  git clone "$REPO" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR/app"

# ── dependencies ─────────────────────────────────────────
info "Installing dependencies"
npm install --no-fund --no-audit

# ── .env setup ───────────────────────────────────────────
if [ ! -f .env ]; then
  cp .env.example .env
  info "Created app/.env from template"

  ask "Discord bot token (leave empty to set later):"
  read -r token
  if [ -n "$token" ]; then
    sed -i.bak "s/^DISCORD_TOKEN=.*/DISCORD_TOKEN=$token/" .env && rm -f .env.bak
  fi

  ask "AI provider — claude-cli or claude-api [claude-cli]:"
  read -r provider
  provider="${provider:-claude-cli}"
  sed -i.bak "s/^AI_PROVIDER=.*/AI_PROVIDER=$provider/" .env && rm -f .env.bak

  if [ "$provider" = "claude-api" ]; then
    ask "Anthropic API key:"
    read -r api_key
    if [ -n "$api_key" ]; then
      sed -i.bak "s/^# ANTHROPIC_API_KEY=.*/ANTHROPIC_API_KEY=$api_key/" .env && rm -f .env.bak
    fi
  fi
else
  info "app/.env already exists — skipping"
fi

# ── launchd service (macOS only) ─────────────────────────
if [ "$(uname)" = "Darwin" ]; then
  ask "Install as macOS background service? [Y/n]:"
  read -r svc
  svc="${svc:-Y}"
  if [ "$svc" = "Y" ] || [ "$svc" = "y" ]; then
    bash ctl.sh install
  fi
else
  info "Not macOS — skip launchd. Start manually: cd $INSTALL_DIR/app && npm start"
fi

# ── done ─────────────────────────────────────────────────
echo ""
info "Synapsis installed at $INSTALL_DIR"
echo ""
echo "  Quick commands:"
echo "    cd $INSTALL_DIR/app"
echo "    ./ctl.sh status        # check service"
echo "    ./ctl.sh logs          # tail logs"
echo "    ./ctl.sh restart       # restart"
echo "    npm start              # run in foreground"
echo ""
echo "  Edit config:  \$EDITOR $INSTALL_DIR/app/.env"
echo ""
