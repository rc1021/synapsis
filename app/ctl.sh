#!/bin/bash
# synapsis service control
# Usage: ./ctl.sh [install|uninstall|update|start|stop|restart|status|logs|setup]

set -euo pipefail

LABEL="ai.synapsis"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_DIR="${SYNAPSIS_DIR:-$HOME/.synapsis}"
BIN_DIR="$INSTALL_DIR/bin"
TEMPLATE="$SCRIPT_DIR/$LABEL.plist.template"
GENERATED="$SCRIPT_DIR/$LABEL.plist"
DEST_PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
GUI="gui/$(id -u)"

step() { printf "\r\033[K⏳ %s..." "$1"; }
ok() { printf "\r\033[K✅ %s\n" "$1"; }
fail() { printf "\r\033[K❌ %s\n" "$1"; exit 1; }

get_pid() {
  launchctl list "$LABEL" 2>/dev/null | awk -F'"PID" = ' 'NF>1{gsub(/[^0-9]/,"",$2); print $2}'
}

check_running_jobs() {
  if ! launchctl list "$LABEL" &>/dev/null; then return; fi
  local PID
  PID=$(get_pid)
  [ -z "$PID" ] && return
  local children
  children=$( (pgrep -P "$PID" 2>/dev/null || true) | wc -l | tr -d ' ')
  if [ "$children" -gt 0 ]; then
    printf "⚠️  有 %s 個 job 正在執行，確定要繼續？ [y/N] " "$children"
    read -r ans
    [ "$ans" = "y" ] || [ "$ans" = "Y" ] || exit 0
  fi
}

generate_plist() {
  local node_path
  node_path="$(which node)" || fail "node not found in PATH"

  step "generating plist"
  sed \
    -e "s|{{NODE_PATH}}|$node_path|g" \
    -e "s|{{APP_DIR}}|$SCRIPT_DIR|g" \
    -e "s|{{PROJECT_DIR}}|$PROJECT_DIR|g" \
    -e "s|{{PATH}}|$PATH|g" \
    -e "s|{{HOME}}|$HOME|g" \
    "$TEMPLATE" > "$GENERATED"
  ok "plist generated ($GENERATED)"
}

do_install() {
  [ -f "$TEMPLATE" ] || fail "template not found: $TEMPLATE"
  check_running_jobs

  step "stopping old service"
  launchctl bootout "$GUI/$LABEL" 2>/dev/null || true

  generate_plist
  mkdir -p "$SCRIPT_DIR/logs"

  step "copying plist"
  cp "$GENERATED" "$DEST_PLIST"

  step "starting service"
  sleep 1
  launchctl bootstrap "$GUI" "$DEST_PLIST" && ok "installed & started" || fail "bootstrap failed"
}

case "${1:-status}" in
  install)
    do_install
    ;;
  uninstall)
    check_running_jobs
    printf "⚠️  This will remove synapsis completely (service, config, data). Continue? [y/N] "
    read -r ans
    [ "$ans" = "y" ] || [ "$ans" = "Y" ] || exit 0

    step "stopping service"
    launchctl bootout "$GUI/$LABEL" 2>/dev/null || true

    step "removing plist"
    rm -f "$DEST_PLIST" "$GENERATED"

    step "removing install directory ($INSTALL_DIR)"
    rm -rf "$INSTALL_DIR"

    step "removing synapsis from PATH"
    for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile"; do
      [ -f "$rc" ] || continue
      if grep -q "# Synapsis" "$rc" 2>/dev/null; then
        sed -i.bak '/# Synapsis/d;/\.synapsis\/bin/d' "$rc" && rm -f "$rc.bak"
      fi
    done

    ok "uninstalled — restart your shell or run: hash -r"
    ;;
  update)
    # Re-run install.sh which handles update logic (preserves .env, workspaces, logs)
    INSTALL_SCRIPT="$PROJECT_DIR/install.sh"
    if [ -f "$INSTALL_SCRIPT" ]; then
      exec bash "$INSTALL_SCRIPT"
    else
      echo "Downloading latest installer..."
      exec bash -c "$(curl -fsSL https://raw.githubusercontent.com/rc1021/synapsis/refs/heads/main/install.sh)"
    fi
    ;;
  start)
    step "starting service"
    launchctl bootstrap "$GUI" "$DEST_PLIST" 2>/dev/null && ok "started" || fail "already running or failed"
    ;;
  stop)
    check_running_jobs
    step "stopping service"
    launchctl bootout "$GUI/$LABEL" 2>/dev/null && ok "stopped" || fail "not running"
    ;;
  restart)
    check_running_jobs
    step "stopping service"
    launchctl bootout "$GUI/$LABEL" 2>/dev/null || true
    step "starting service"
    sleep 1
    launchctl bootstrap "$GUI" "$DEST_PLIST" && ok "restarted" || fail "bootstrap failed"
    ;;
  status)
    if launchctl list "$LABEL" &>/dev/null; then
      PID=$(get_pid)
      echo "✅ running (pid ${PID:-?})"
    else
      echo "⏹  not running"
    fi
    ;;
  log|logs)
    tail -f "$SCRIPT_DIR/logs/synapsis.log"
    ;;
  setup)
    ENV_FILE="$SCRIPT_DIR/.env"
    if [ ! -f "$ENV_FILE" ]; then
      cp "$SCRIPT_DIR/.env.example" "$ENV_FILE"
      echo "Created .env from template"
    fi
    echo ""
    echo "Current config:"
    echo "─────────────────────────────────────"
    grep -E '^(AI_PROVIDER|ANTHROPIC_API_KEY|DISCORD_TOKEN)=' "$ENV_FILE" | while IFS='=' read -r key val; do
      if [ -z "$val" ] || echo "$val" | grep -q '^sk-ant-\.\.\.' ; then
        printf "  %-20s ⚠️  not set\n" "$key"
      else
        masked="${val:0:8}..."
        printf "  %-20s ✅ %s\n" "$key" "$masked"
      fi
    done
    echo "─────────────────────────────────────"
    echo ""
    printf "Edit which setting? [1] AI_PROVIDER  [2] ANTHROPIC_API_KEY  [3] DISCORD_TOKEN  [q] quit: "
    read -r choice
    case "$choice" in
      1)
        printf "AI provider (claude-api / claude-cli) [current: $(grep '^AI_PROVIDER=' "$ENV_FILE" | cut -d= -f2)]: "
        read -r val
        [ -n "$val" ] && sed -i.bak "s/^AI_PROVIDER=.*/AI_PROVIDER=$val/" "$ENV_FILE" && rm -f "$ENV_FILE.bak" && echo "✅ Updated"
        ;;
      2)
        printf "Anthropic API key: "
        read -r val
        [ -n "$val" ] && sed -i.bak "s/^ANTHROPIC_API_KEY=.*/ANTHROPIC_API_KEY=$val/" "$ENV_FILE" && rm -f "$ENV_FILE.bak" && echo "✅ Updated"
        ;;
      3)
        printf "Discord bot token: "
        read -r val
        [ -n "$val" ] && sed -i.bak "s/^DISCORD_TOKEN=.*/DISCORD_TOKEN=$val/" "$ENV_FILE" && rm -f "$ENV_FILE.bak" && echo "✅ Updated"
        ;;
      q|"") ;;
    esac
    ;;
  *)
    echo "Usage: $0 {install|uninstall|update|start|stop|restart|status|logs|setup}"
    exit 1
    ;;
esac
