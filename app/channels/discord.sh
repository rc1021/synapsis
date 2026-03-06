#!/bin/bash
# Send a Discord DM to Charles via Discord API
# Usage: notify.sh "message content"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"

# --- Load .env ---
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found"
  exit 1
fi

# Parse DISCORD_TOKEN
DISCORD_TOKEN=$(grep '^DISCORD_TOKEN=' "$ENV_FILE" | cut -d= -f2-)

# Parse notify user ID: prefer HEARTBEAT_NOTIFY_USER, fallback to first ALLOW_FROM entry
NOTIFY_USER=$(grep '^HEARTBEAT_NOTIFY_USER=' "$ENV_FILE" | cut -d= -f2- || true)
if [ -z "$NOTIFY_USER" ]; then
  NOTIFY_USER=$(grep '^ALLOW_FROM=' "$ENV_FILE" | cut -d= -f2- | cut -d, -f1)
fi

if [ -z "$DISCORD_TOKEN" ] || [ -z "$NOTIFY_USER" ]; then
  echo "ERROR: DISCORD_TOKEN or user ID not found"
  exit 1
fi

MESSAGE="${1:-No message provided}"

# --- Step 1: Open DM channel ---
DM_RESPONSE=$(curl -s -X POST "https://discord.com/api/v10/users/@me/channels" \
  -H "Authorization: Bot ${DISCORD_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"recipient_id\": \"${NOTIFY_USER}\"}")

CHANNEL_ID=$(echo "$DM_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)

if [ -z "$CHANNEL_ID" ]; then
  echo "ERROR: Failed to open DM channel. Response: $DM_RESPONSE"
  exit 1
fi

# --- Step 2: Send message ---
# Truncate to Discord's 2000 char limit
MESSAGE="${MESSAGE:0:1950}"

# Use python3 with env var to safely JSON-encode (avoids shell injection)
PAYLOAD=$(MESSAGE="$MESSAGE" python3 -c "import os,json; print(json.dumps({'content': os.environ['MESSAGE']}))")

SEND_RESPONSE=$(curl -s -X POST "https://discord.com/api/v10/channels/${CHANNEL_ID}/messages" \
  -H "Authorization: Bot ${DISCORD_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

# Verify send
MSG_ID=$(echo "$SEND_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)

if [ -z "$MSG_ID" ]; then
  echo "ERROR: Failed to send message. Response: $SEND_RESPONSE"
  exit 1
fi

echo "OK: DM sent (channel=$CHANNEL_ID, message=$MSG_ID)"
