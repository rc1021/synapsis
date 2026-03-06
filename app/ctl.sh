#!/bin/bash
# synapsis service control
# Usage: ./ctl.sh [install|uninstall|start|stop|restart|status|logs]

set -euo pipefail

LABEL="ai.synapsis"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
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
    step "stopping service"
    launchctl bootout "$GUI/$LABEL" 2>/dev/null || true
    step "removing plist"
    rm -f "$DEST_PLIST" "$GENERATED"
    ok "uninstalled"
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
  *)
    echo "Usage: $0 {install|uninstall|start|stop|restart|status|logs}"
    exit 1
    ;;
esac
