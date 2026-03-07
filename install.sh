#!/bin/bash
# Synapsis installer
# curl -fsSL https://raw.githubusercontent.com/rc1021/synapsis/refs/heads/main/install.sh | bash
set -euo pipefail

REPO="https://github.com/rc1021/synapsis.git"
INSTALL_DIR="${SYNAPSIS_DIR:-$HOME/synapsis}"

# ── helpers ──────────────────────────────────────────────
c_reset='\033[0m'; c_green='\033[32m'; c_yellow='\033[33m'; c_red='\033[31m'; c_bold='\033[1m'; c_dim='\033[2m'
info()  { printf "${c_bold}${c_green}▸${c_reset} %s\n" "$*"; }
warn()  { printf "${c_bold}${c_yellow}▸${c_reset} %s\n" "$*"; }
fail()  { printf "${c_bold}${c_red}✗${c_reset} %s\n" "$*"; exit 1; }
ask()   { printf "${c_bold}${c_green}?${c_reset} %s " "$1"; }

# Interactive menu: menu "prompt" option1 option2 ...
# Returns selected option in $REPLY
menu() {
  local prompt="$1"; shift
  local options=("$@")
  local selected=0
  local count=${#options[@]}

  # Hide cursor
  printf '\033[?25l'

  # Print menu
  printf "${c_bold}${c_green}?${c_reset} %s\n" "$prompt"
  for i in "${!options[@]}"; do
    if [ "$i" -eq 0 ]; then
      printf "  ${c_green}❯ %s${c_reset}\n" "${options[$i]}"
    else
      printf "    %s\n" "${options[$i]}"
    fi
  done

  # Move cursor up to first option
  printf "\033[${count}A"

  while true; do
    # Read a single keypress
    local key
    IFS= read -rsn1 key
    if [ "$key" = $'\x1b' ]; then
      read -rsn2 key
      case "$key" in
        '[A') # Up arrow
          if [ "$selected" -gt 0 ]; then
            # Clear current line
            printf "\r    %s" "${options[$selected]}"
            selected=$((selected - 1))
            printf "\033[1A"
            printf "\r  ${c_green}❯ %s${c_reset}" "${options[$selected]}"
          fi
          ;;
        '[B') # Down arrow
          if [ "$selected" -lt $((count - 1)) ]; then
            printf "\r    %s" "${options[$selected]}"
            selected=$((selected + 1))
            printf "\033[1B"
            printf "\r  ${c_green}❯ %s${c_reset}" "${options[$selected]}"
          fi
          ;;
      esac
    elif [ "$key" = "" ]; then
      # Enter pressed — move to end of menu and break
      local remaining=$((count - selected - 1))
      [ "$remaining" -gt 0 ] && printf "\033[${remaining}B"
      printf "\n"
      # Show cursor
      printf '\033[?25h'
      REPLY="${options[$selected]}"
      return
    fi
  done
}

# ── preflight ────────────────────────────────────────────
detect_pm() {
  if command -v brew >/dev/null; then echo "brew"
  elif command -v apt-get >/dev/null; then echo "apt"
  elif command -v dnf >/dev/null; then echo "dnf"
  elif command -v yum >/dev/null; then echo "yum"
  elif command -v pacman >/dev/null; then echo "pacman"
  else echo ""
  fi
}

install_pkg() {
  local name="$1" pm
  pm=$(detect_pm)
  case "$pm" in
    brew)   info "Installing $name via Homebrew..."; brew install "$name" ;;
    apt)    info "Installing $name via apt..."; sudo apt-get update -qq && sudo apt-get install -y "$name" ;;
    dnf)    info "Installing $name via dnf..."; sudo dnf install -y "$name" ;;
    yum)    info "Installing $name via yum..."; sudo yum install -y "$name" ;;
    pacman) info "Installing $name via pacman..."; sudo pacman -S --noconfirm "$name" ;;
    *)      return 1 ;;
  esac
}

require_cmd() {
  local cmd="$1" pkg="${2:-$1}" url="$3"
  if command -v "$cmd" >/dev/null; then return 0; fi

  warn "$cmd not found"
  ask "Install $pkg automatically? [Y/n]:"
  read -r ans
  ans="${ans:-Y}"
  if [ "$ans" = "Y" ] || [ "$ans" = "y" ]; then
    install_pkg "$pkg" && command -v "$cmd" >/dev/null && return 0
    fail "Auto-install failed. Install manually: $url"
  else
    fail "$cmd is required. Install: $url"
  fi
}

require_cmd git git "https://git-scm.com"
require_cmd node node "https://nodejs.org"
require_cmd npm npm "https://nodejs.org"

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 22 ] 2>/dev/null; then
  warn "Node v22+ recommended (you have v$(node -v | tr -d v))"
  ask "Upgrade Node.js? [Y/n]:"
  read -r ans
  ans="${ans:-Y}"
  if [ "$ans" = "Y" ] || [ "$ans" = "y" ]; then
    pm=$(detect_pm)
    case "$pm" in
      brew) brew install node@22 ;;
      *)    warn "Please upgrade manually: https://nodejs.org" ;;
    esac
  fi
fi

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

  echo ""
  # ── AI Provider ──
  menu "Select AI provider:" \
    "claude-api  — Anthropic API (pay-per-token)" \
    "claude-cli  — Claude CLI (personal/dev use)"

  provider=$(echo "$REPLY" | awk '{print $1}')
  sed -i.bak "s/^AI_PROVIDER=.*/AI_PROVIDER=$provider/" .env && rm -f .env.bak
  info "AI provider: $provider"

  echo ""
  if [ "$provider" = "claude-api" ]; then
    ask "Anthropic API key (get from https://console.anthropic.com/):"
    read -r api_key
    if [ -n "$api_key" ]; then
      sed -i.bak "s/^ANTHROPIC_API_KEY=.*/ANTHROPIC_API_KEY=$api_key/" .env && rm -f .env.bak
    else
      warn "Skipped — set ANTHROPIC_API_KEY in app/.env later"
    fi
  else
    info "Make sure the Claude CLI is installed and authenticated on this machine"
  fi

  echo ""
  # ── Bridge ──
  menu "Select messaging bridge:" \
    "discord   — Discord bot" \
    "telegram  — Telegram bot (coming soon)" \
    "whatsapp  — WhatsApp (coming soon)"

  bridge=$(echo "$REPLY" | awk '{print $1}')
  info "Bridge: $bridge"

  echo ""
  case "$bridge" in
    discord)
      ask "Discord bot token (get from https://discord.com/developers/applications):"
      read -r token
      if [ -n "$token" ]; then
        sed -i.bak "s/^DISCORD_TOKEN=.*/DISCORD_TOKEN=$token/" .env && rm -f .env.bak
      else
        warn "Skipped — set DISCORD_TOKEN in app/.env later"
      fi
      ;;
    telegram|whatsapp)
      warn "$bridge bridge is not yet available — Discord will be used as fallback"
      ask "Discord bot token (optional, leave empty to skip):"
      read -r token
      if [ -n "$token" ]; then
        sed -i.bak "s/^DISCORD_TOKEN=.*/DISCORD_TOKEN=$token/" .env && rm -f .env.bak
      fi
      ;;
  esac
else
  info "app/.env already exists — skipping"
fi

# ── start service ────────────────────────────────────────
echo ""
if [ "$(uname)" = "Darwin" ]; then
  info "Installing background service"
  bash ctl.sh install
else
  info "Starting synapsis"
  npm start &
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
echo ""
echo "  Edit config:  \$EDITOR $INSTALL_DIR/app/.env"
echo ""
