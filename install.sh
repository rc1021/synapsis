#!/bin/bash
# Synapsis installer / updater
# curl -fsSL https://raw.githubusercontent.com/rc1021/synapsis/refs/heads/main/install.sh | bash
set -euo pipefail

REPO_OWNER="rc1021"
REPO_NAME="synapsis"
INSTALL_DIR="${SYNAPSIS_DIR:-$HOME/.synapsis}"
BIN_DIR="$INSTALL_DIR/bin"

# When piped via curl, stdin is not the terminal.
# Open /dev/tty for interactive input.
exec 3</dev/tty 2>/dev/null || exec 3<&0

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
    IFS= read -rsn1 key <&3
    if [ "$key" = $'\x1b' ]; then
      read -rsn2 key <&3
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

ensure_pm() {
  if [ -n "$(detect_pm)" ]; then return 0; fi

  if [ "$(uname)" = "Darwin" ]; then
    warn "No package manager found"
    ask "Install Homebrew? [Y/n]:"
    read -r ans <&3
    ans="${ans:-Y}"
    if [ "$ans" = "Y" ] || [ "$ans" = "y" ]; then
      info "Installing Homebrew (you may need to enter your password)..."
      # Cache sudo credentials before running the installer
      sudo -v </dev/tty 2>/dev/null
      NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
      # Add brew to PATH for this session
      if [ -f /opt/homebrew/bin/brew ]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
      elif [ -f /usr/local/bin/brew ]; then
        eval "$(/usr/local/bin/brew shellenv)"
      fi
      command -v brew >/dev/null && return 0
    fi
    fail "Homebrew is required on macOS. Install: https://brew.sh"
  else
    fail "No package manager found (apt, dnf, yum, pacman). Install one first."
  fi
}

install_pkg() {
  local name="$1" pm
  ensure_pm
  pm=$(detect_pm)
  case "$pm" in
    brew)
      info "Installing $name via Homebrew..."
      brew install "$name"
      # Ensure brew binaries are in PATH for this session
      for p in /opt/homebrew/bin /usr/local/bin; do
        [ -d "$p" ] && echo "$PATH" | tr ':' '\n' | grep -qx "$p" || export PATH="$p:$PATH"
      done
      hash -r 2>/dev/null  # clear command cache
      ;;
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
  read -r ans <&3
  ans="${ans:-Y}"
  if [ "$ans" = "Y" ] || [ "$ans" = "y" ]; then
    install_pkg "$pkg"
    if command -v "$cmd" >/dev/null; then
      info "$cmd installed successfully ($(command -v "$cmd"))"
      return 0
    fi
    fail "Auto-install failed ($cmd not found in PATH=$PATH). Install manually: $url"
  else
    fail "$cmd is required. Install: $url"
  fi
}

require_cmd node node "https://nodejs.org"
require_cmd npm npm "https://nodejs.org"
require_cmd curl curl "https://curl.se"
require_cmd python3 python3 "https://www.python.org"
require_cmd ffmpeg ffmpeg "https://ffmpeg.org"
require_cmd yt-dlp yt-dlp "https://github.com/yt-dlp/yt-dlp"

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 22 ] 2>/dev/null; then
  warn "Node v22+ recommended (you have v$(node -v | tr -d v))"
  ask "Upgrade Node.js? [Y/n]:"
  read -r ans <&3
  ans="${ans:-Y}"
  if [ "$ans" = "Y" ] || [ "$ans" = "y" ]; then
    pm=$(detect_pm)
    case "$pm" in
      brew) brew install node@22 ;;
      *)    warn "Please upgrade manually: https://nodejs.org" ;;
    esac
  fi
fi

# ── download / update ────────────────────────────────────
IS_UPDATE=false
if [ -d "$INSTALL_DIR/app" ]; then
  IS_UPDATE=true
  # Read current version before update
  OLD_VERSION=""
  if [ -f "$INSTALL_DIR/app/package.json" ]; then
    OLD_VERSION=$(node -p "require('$INSTALL_DIR/app/package.json').version" 2>/dev/null || echo "")
  fi
fi

# Fetch latest release tag from GitHub API
info "Checking latest release..."
LATEST_TAG=$(curl -fsSL "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME/releases/latest" | node -p "JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).tag_name" 2>/dev/null || echo "")

if [ -z "$LATEST_TAG" ]; then
  # Fallback: download main branch tarball
  warn "No release found — downloading main branch"
  TARBALL_URL="https://github.com/$REPO_OWNER/$REPO_NAME/archive/refs/heads/main.tar.gz"
  STRIP_PREFIX="$REPO_NAME-main"
else
  TARBALL_URL="https://github.com/$REPO_OWNER/$REPO_NAME/archive/refs/tags/$LATEST_TAG.tar.gz"
  STRIP_PREFIX="$REPO_NAME-${LATEST_TAG#v}"
  info "Latest release: $LATEST_TAG"
fi

# Skip download if already on latest version
if [ "$IS_UPDATE" = true ] && [ -n "$LATEST_TAG" ] && [ -n "$OLD_VERSION" ]; then
  LATEST_VERSION="${LATEST_TAG#v}"
  if [ "$OLD_VERSION" = "$LATEST_VERSION" ]; then
    info "Already on latest version ($OLD_VERSION)"
    exit 0
  fi
  info "Updating $OLD_VERSION -> $LATEST_VERSION"
fi

# Download tarball to temp dir
TMPDIR_DL=$(mktemp -d)
trap 'rm -rf "$TMPDIR_DL"' EXIT

info "Downloading..."
curl -fsSL "$TARBALL_URL" -o "$TMPDIR_DL/synapsis.tar.gz"

info "Extracting..."
tar xzf "$TMPDIR_DL/synapsis.tar.gz" -C "$TMPDIR_DL"

# Prepare install directory
mkdir -p "$INSTALL_DIR"

# Copy new files — exclude user data directories so they are never touched
if [ "$IS_UPDATE" = true ]; then
  info "Updating code (preserving user data)..."
  rsync -a --delete \
    --exclude '.env' \
    --exclude 'workspaces/' \
    --exclude 'logs/' \
    --exclude 'scheduler/markers/' \
    --exclude 'scheduler/job-queue/' \
    --exclude 'scheduler/logs/' \
    --exclude 'node_modules/' \
    "$TMPDIR_DL/$STRIP_PREFIX/app/" "$INSTALL_DIR/app/"
else
  cp -R "$TMPDIR_DL/$STRIP_PREFIX/app" "$INSTALL_DIR/app"
fi
cp -f "$TMPDIR_DL/$STRIP_PREFIX/install.sh" "$INSTALL_DIR/install.sh" 2>/dev/null || true

cd "$INSTALL_DIR/app"

# ── dependencies ─────────────────────────────────────────
info "Installing Node.js dependencies"
npm install --no-fund --no-audit

info "Installing embedding tool dependencies"
if npm install --no-fund --no-audit --prefix tools/embedding 2>&1; then
  info "Embedding deps installed"
else
  warn "Embedding deps install failed — run 'npm install' in app/tools/embedding manually"
fi

info "Installing Python dependencies (youtube-transcript-api, openai-whisper)"
if python3 -m pip install --break-system-packages --user youtube-transcript-api openai-whisper 2>&1; then
  info "Python dependencies installed"
else
  warn "Python deps install failed — run 'python3 -m pip install --break-system-packages --user youtube-transcript-api openai-whisper' manually"
fi

# ── .env setup (first install only) ─────────────────────
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
    read -r api_key <&3
    if [ -n "$api_key" ]; then
      sed -i.bak "s/^ANTHROPIC_API_KEY=.*/ANTHROPIC_API_KEY=$api_key/" .env && rm -f .env.bak
    else
      warn "Skipped — set ANTHROPIC_API_KEY in app/.env later"
    fi
  else
    if ! command -v claude >/dev/null; then
      info "Installing Claude CLI..."
      npm install -g @anthropic-ai/claude-code
      hash -r 2>/dev/null
      if command -v claude >/dev/null; then
        info "Claude CLI installed ($(command -v claude))"
      else
        warn "Claude CLI install failed — run 'npm install -g @anthropic-ai/claude-code' manually"
      fi
    else
      info "Claude CLI found ($(command -v claude))"
    fi
    if command -v claude >/dev/null; then
      ask "Authenticate Claude CLI now? [Y/n]:"
      read -r ans <&3
      ans="${ans:-Y}"
      if [ "$ans" = "Y" ] || [ "$ans" = "y" ]; then
        claude </dev/tty || warn "Authentication skipped — run 'claude' manually to log in"
      fi
    fi
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
      read -r token <&3
      if [ -n "$token" ]; then
        sed -i.bak "s/^DISCORD_TOKEN=.*/DISCORD_TOKEN=$token/" .env && rm -f .env.bak
      else
        warn "Skipped — set DISCORD_TOKEN in app/.env later"
      fi
      ;;
    telegram|whatsapp)
      warn "$bridge bridge is not yet available — Discord will be used as fallback"
      ask "Discord bot token (optional, leave empty to skip):"
      read -r token <&3
      if [ -n "$token" ]; then
        sed -i.bak "s/^DISCORD_TOKEN=.*/DISCORD_TOKEN=$token/" .env && rm -f .env.bak
      fi
      ;;
  esac
else
  info "app/.env already exists — preserved"
fi

# ── start service ────────────────────────────────────────
echo ""
if [ "$(uname)" = "Darwin" ]; then
  if [ "$IS_UPDATE" = true ]; then
    info "Restarting service"
    bash ctl.sh restart 2>/dev/null || bash ctl.sh install
  else
    info "Installing background service"
    bash ctl.sh install
  fi
else
  info "Starting synapsis"
  npm start &
fi

# ── install CLI bin ───────────────────────────────────────
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/synapsis" <<SCRIPT
#!/bin/bash
exec "$INSTALL_DIR/app/ctl.sh" "\$@"
SCRIPT
chmod +x "$BIN_DIR/synapsis"

# ── add to PATH ──────────────────────────────────────────
add_to_path() {
  local rc="$1"
  if [ -f "$rc" ] && grep -q "$BIN_DIR" "$rc" 2>/dev/null; then
    return 0  # already added
  fi
  [ -f "$rc" ] || return 1
  echo "" >> "$rc"
  echo "# Synapsis" >> "$rc"
  echo "export PATH=\"$BIN_DIR:\$PATH\"" >> "$rc"
  info "Added $BIN_DIR to PATH in $(basename "$rc")"
}

if ! echo "$PATH" | tr ':' '\n' | grep -qx "$BIN_DIR"; then
  # On fresh macOS, ~/.zshrc may not exist yet — create it
  if [ "$(uname)" = "Darwin" ] && [ ! -f "$HOME/.zshrc" ]; then
    touch "$HOME/.zshrc"
  fi

  added=false
  for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile"; do
    if add_to_path "$rc"; then added=true; fi
  done
  if [ "$added" = true ]; then
    export PATH="$BIN_DIR:$PATH"
  else
    warn "Add this to your shell profile manually:"
    echo "  export PATH=\"$BIN_DIR:\$PATH\""
  fi
fi

# ── done ─────────────────────────────────────────────────
NEW_VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "unknown")
echo ""
if [ "$IS_UPDATE" = true ]; then
  info "Synapsis updated to v$NEW_VERSION"
else
  info "Synapsis v$NEW_VERSION installed at $INSTALL_DIR"
fi
echo ""
echo "  Commands:"
echo "    synapsis status     # check service"
echo "    synapsis logs       # tail logs"
echo "    synapsis restart    # restart"
echo "    synapsis stop       # stop"
echo "    synapsis update     # check for updates"
echo "    synapsis version    # show current version"
echo "    synapsis setup      # configure"
echo "    synapsis uninstall  # remove completely"
echo ""
echo "  Edit config:  \$EDITOR $INSTALL_DIR/app/.env"
echo ""
