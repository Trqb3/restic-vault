#!/usr/bin/env bash
# ResticVault Agent Daemon
set -euo pipefail

CONFIG_FILE="/etc/resticvault-agent/config"
LOG_FILE="/var/log/resticvault-agent/agent.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

# Load config
# shellcheck source=/etc/resticvault-agent/config
source "$CONFIG_FILE"

# Build restic repo URL with the token embedded as HTTP Basic Auth credentials.
_RV_PROTO="https"
[[ "${RV_SERVER}" == http://* ]] && _RV_PROTO="http"
_RV_HOST="${RV_SERVER#https://}"
_RV_HOST="${_RV_HOST#http://}"
RESTIC_REPO="rest:${_RV_PROTO}://x:${RV_TOKEN}@${_RV_HOST}/restic/${RV_NAME}/"

# ── Helper: send JSON to server ───────────────────────────────────────────────
rv_post() {
  local endpoint="$1"
  local data="${2:-{}}"

  curl -fsSL -X POST \
    -H "Authorization: Bearer ${RV_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "$data" \
    "${RV_SERVER}/api/sources/agent/${endpoint}" 2>/dev/null || true
}

rv_get() {
  local endpoint="$1"
  curl -fsSL \
    -H "Authorization: Bearer ${RV_TOKEN}" \
    "${RV_SERVER}/api/sources/agent/${endpoint}" 2>/dev/null || echo '{}'
}

# ── Build JSON helper (avoids escaping issues) ────────────────────────────────
json_object() {
  local first=true
  while [[ $# -gt 0 ]]; do
    local key="$1"
    local value="$2"
    shift 2

    if [[ "$first" == "true" ]]; then
      first=false
      printf '{'
    else
      printf ','
    fi

    printf '"%s":' "$key"

    # Check if value looks like a number
    if [[ "$value" =~ ^[0-9]+$ ]]; then
      printf '%s' "$value"
    else
      printf '"%s"' "$value"
    fi
  done
  printf '}'
}

# ── Run restic backup ─────────────────────────────────────────────────────────
run_backup() {
  local command_id="${1:-}"
  log "Starting backup of paths: $RV_PATHS"

  # Fetch config from server (paths + exclusions)
  CONFIG_JSON="$(rv_get config 2>/dev/null || echo '{}')"
  SERVER_PATHS="$(echo "$CONFIG_JSON" | grep -o '"backupPaths":\[[^]]*\]' | sed 's/^"backupPaths"://' | grep -o '"[^"]*"' | tr -d '"' | tr '\n' ' ' || echo "")"
  EXCLUDE_PATTERNS="$(echo "$CONFIG_JSON" | grep -o '"excludePatterns":\[[^]]*\]' | sed 's/^"excludePatterns"://' | grep -o '"[^"]*"' | tr -d '"' || echo "")"

  BACKUP_PATHS_ARG=""
  if [[ -n "${SERVER_PATHS// /}" ]]; then
    BACKUP_PATHS_ARG="$SERVER_PATHS"
  else
    BACKUP_PATHS_ARG="${RV_PATHS//,/ }"
  fi

  # Build exclude args
  EXCLUDE_ARGS=""
  while IFS= read -r pat; do
    [[ -n "$pat" ]] && EXCLUDE_ARGS="$EXCLUDE_ARGS --exclude $pat"
  done <<< "$EXCLUDE_PATTERNS"

  SNAPSHOT_ID=""
  ERROR_MSG=""
  STATUS="failure"

  RESTIC_PASSWORD="" \
    "$RESTIC_BIN" \
      -r "$RESTIC_REPO" \
      --no-lock \
      backup \
        --json \
        $EXCLUDE_ARGS \
        $BACKUP_PATHS_ARG \
      >> "$LOG_FILE" 2>&1 && STATUS="success" || ERROR_MSG="restic exited with code $?"

  if [[ "$STATUS" == "success" ]]; then
    SNAPSHOT_ID="$(grep -o '"snapshot_id":"[^"]*"' "$LOG_FILE" | tail -1 | cut -d'"' -f4 || echo "")"
    log "Backup succeeded. Snapshot: $SNAPSHOT_ID"
  else
    log "Backup failed: $ERROR_MSG"
  fi

  # Build result JSON using helper
  local result_data
  if [[ -n "$command_id" ]]; then
    result_data="$(json_object "status" "$STATUS" "errorMessage" "$ERROR_MSG" "snapshotId" "$SNAPSHOT_ID" "commandId" "$command_id")"
  else
    result_data="$(json_object "status" "$STATUS" "errorMessage" "$ERROR_MSG" "snapshotId" "$SNAPSHOT_ID")"
  fi
  rv_post backup-result "$result_data"
}

# ── Discover filesystem paths ─────────────────────────────────────────────────
run_discover() {
  log "Discovering filesystem paths..."
  PATHS_JSON="["
  FIRST=true
  while IFS= read -r -d '' dir; do
    # Get size and ensure it's a clean integer
    SIZE=$(du -sb "$dir" 2>/dev/null | awk '{print $1}' | head -1)
    [[ "$SIZE" =~ ^[0-9]+$ ]] || SIZE=0

    # Get file count and ensure it's a clean integer
    COUNT=$(find "$dir" -maxdepth 1 -type f 2>/dev/null | wc -l)
    [[ "$COUNT" =~ ^[0-9]+$ ]] || COUNT=0

    # Escape special characters in path
    ESCAPED="${dir//\\/\\\\}"
    ESCAPED="${ESCAPED//\"/\\\"}"

    if [[ "$FIRST" == "true" ]]; then
      FIRST=false
    else
      PATHS_JSON="${PATHS_JSON},"
    fi

    PATHS_JSON="${PATHS_JSON}{\"path\":\"${ESCAPED}\",\"size_bytes\":${SIZE},\"file_count\":${COUNT}}"
  done < <(find / -maxdepth 3 -type d \( -path /proc -o -path /sys -o -path /dev -o -path /run \) -prune -o -type d -print0 2>/dev/null)
  PATHS_JSON="${PATHS_JSON}]"

  local discover_data
  discover_data="$(json_object "paths" "$PATHS_JSON")"
  rv_post discover "$discover_data"
  log "Discovery complete."
}

# ── Initialize repo ───────────────────────────────────────────────────────────
init_repo() {
  log "Initializing restic repository at $RESTIC_REPO ..."
  RESTIC_PASSWORD="" \
    "$RESTIC_BIN" \
      -r "$RESTIC_REPO" \
      init 2>&1 | tee -a "$LOG_FILE" || true
}

# ── Main: heartbeat + command poll loop ──────────────────────────────────────
run_daemon() {
  log "Agent starting. Connecting to ${RV_SERVER} as '${RV_NAME}' ..."

  AGENT_VERSION="1.0.0"

  local heartbeat_data
  heartbeat_data="$(json_object "agentVersion" "$AGENT_VERSION" "name" "$RV_NAME")"
  rv_post heartbeat "$heartbeat_data"

  # Try to init repo (idempotent — safe to run on existing repo)
  init_repo

  while true; do
    # Send heartbeat
    heartbeat_data="$(json_object "agentVersion" "$AGENT_VERSION" "name" "$RV_NAME")"
    rv_post heartbeat "$heartbeat_data"

    # Poll for commands
    RESPONSE="$(rv_get poll 2>/dev/null || echo '{}')"
    CMD_TYPE="$(echo "$RESPONSE" | grep -o '"command":"[^"]*"' | cut -d'"' -f4 || echo "")"
    CMD_ID="$(echo "$RESPONSE" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2 || echo "")"

    if [[ -n "$CMD_TYPE" && "$CMD_TYPE" != "null" ]]; then
      log "Received command: $CMD_TYPE (id=$CMD_ID)"

      # Acknowledge
      if [[ -n "$CMD_ID" ]]; then
        local ack_data
        ack_data="$(json_object "commandId" "$CMD_ID" "status" "received")"
        rv_post ack "$ack_data"
      fi

      case "$CMD_TYPE" in
        backup)   run_backup "$CMD_ID" ;;
        discover) run_discover ;;
        uninstall)
          log "Uninstall command received. Stopping agent..."
          systemctl stop resticvault-agent-backup.timer resticvault-agent.service 2>/dev/null || true
          systemctl disable resticvault-agent-backup.timer resticvault-agent.service 2>/dev/null || true
          rm -f /etc/systemd/system/resticvault-agent.service
          rm -f /etc/systemd/system/resticvault-agent-backup.service
          rm -f /etc/systemd/system/resticvault-agent-backup.timer
          rm -f /usr/local/bin/resticvault-agent
          rm -rf /etc/resticvault-agent
          systemctl daemon-reload 2>/dev/null || true
          log "Agent uninstalled."
          exit 0
          ;;
        *)
          log "Unknown command: $CMD_TYPE"
          ;;
      esac
    fi

    sleep 30
  done
}

# ── Backup-only mode (called from systemd timer) ──────────────────────────────
if [[ "${1:-}" == "backup" ]]; then
  log "Scheduled backup triggered by systemd timer."
  run_backup ""
  exit 0
fi

if [[ "${1:-}" == "discover" ]]; then
  run_discover
  exit 0
fi

# Default: run as daemon
run_daemon