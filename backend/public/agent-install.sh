#!/usr/bin/env bash
# ResticVault Agent Installer
# Usage: curl -fsSL https://<your-host>/agent-install.sh | bash -s -- \
#          --server https://your-resticvault-host \
#          --token  rvs1_<your-token> \
#          --name   my-server \
#          --paths  /home,/etc
#
# The script:
#  1. Installs restic (if missing)
#  2. Writes the agent daemon script to /usr/local/bin/resticvault-agent
#  3. Creates a systemd service + timer for scheduled backups
#  4. Starts the agent immediately

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
RV_SERVER=""
RV_TOKEN=""
RV_NAME=""
RV_PATHS="/home"
RV_SCHEDULE="0 2 * * *"   # daily at 02:00
RV_INSTALL_DIR="/usr/local/bin"
RV_CONFIG_DIR="/etc/resticvault-agent"
RV_LOG_DIR="/var/log/resticvault-agent"
RESTIC_BIN="restic"

# ── Parse arguments ───────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --server)  RV_SERVER="$2"; shift 2 ;;
    --token)   RV_TOKEN="$2";  shift 2 ;;
    --name)    RV_NAME="$2";   shift 2 ;;
    --paths)   RV_PATHS="$2";  shift 2 ;;
    --schedule) RV_SCHEDULE="$2"; shift 2 ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

if [[ -z "$RV_SERVER" || -z "$RV_TOKEN" || -z "$RV_NAME" ]]; then
  echo "Error: --server, --token, and --name are required."
  exit 1
fi

# Strip trailing slash from server URL
RV_SERVER="${RV_SERVER%/}"

echo "=== ResticVault Agent Installer ==="
echo "Server: $RV_SERVER"
echo "Name:   $RV_NAME"
echo "Paths:  $RV_PATHS"

# ── Check root ────────────────────────────────────────────────────────────────
if [[ "$EUID" -ne 0 ]]; then
  echo "Error: This script must be run as root (use sudo)."
  exit 1
fi

# ── Install restic if missing ─────────────────────────────────────────────────
if ! command -v restic &>/dev/null; then
  echo "Installing restic..."
  OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64)  ARCH="amd64" ;;
    aarch64) ARCH="arm64" ;;
    armv7l)  ARCH="arm"   ;;
  esac

  RESTIC_VER="0.17.3"
  RESTIC_URL="https://github.com/restic/restic/releases/download/v${RESTIC_VER}/restic_${RESTIC_VER}_${OS}_${ARCH}.bz2"
  TMP_FILE="$(mktemp)"
  curl -fsSL "$RESTIC_URL" | bunzip2 > "$TMP_FILE"
  chmod +x "$TMP_FILE"
  mv "$TMP_FILE" /usr/local/bin/restic
  RESTIC_BIN="/usr/local/bin/restic"
  echo "Restic installed at $RESTIC_BIN (version $RESTIC_VER)"
else
  RESTIC_BIN="$(command -v restic)"
  echo "Restic already installed: $RESTIC_BIN ($(restic version 2>/dev/null | head -1))"
fi

# ── Create directories ────────────────────────────────────────────────────────
mkdir -p "$RV_CONFIG_DIR" "$RV_LOG_DIR"
chmod 700 "$RV_CONFIG_DIR"

# ── Write configuration ───────────────────────────────────────────────────────
CONFIG_FILE="$RV_CONFIG_DIR/config"
cat > "$CONFIG_FILE" <<EOF
RV_SERVER="${RV_SERVER}"
RV_TOKEN="${RV_TOKEN}"
RV_NAME="${RV_NAME}"
RV_PATHS="${RV_PATHS}"
RESTIC_BIN="${RESTIC_BIN}"
EOF
chmod 600 "$CONFIG_FILE"
echo "Config written to $CONFIG_FILE"

# ── Write agent daemon ────────────────────────────────────────────────────────
AGENT_SCRIPT="$RV_INSTALL_DIR/resticvault-agent"
cat > "$AGENT_SCRIPT" <<'AGENT_EOF'
#!/usr/bin/env bash
# ResticVault Agent Daemon
set -euo pipefail

CONFIG_FILE="/etc/resticvault-agent/config"
LOG_FILE="/var/log/resticvault-agent/agent.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

# Load config
# shellcheck source=/etc/resticvault-agent/config
source "$CONFIG_FILE"

RESTIC_REPO="rest:${RV_SERVER}/restic/${RV_NAME}/"

# ── Helper: send JSON to server ───────────────────────────────────────────────
rv_post() {
  local endpoint="$1"
  local data="${2:-{}}"
  curl -fsSL -X POST \
    -H "Authorization: Bearer ${RV_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$data" \
    "${RV_SERVER}/api/sources/agent/${endpoint}" 2>/dev/null || true
}

rv_get() {
  local endpoint="$1"
  curl -fsSL \
    -H "Authorization: Bearer ${RV_TOKEN}" \
    "${RV_SERVER}/api/sources/agent/${endpoint}" 2>/dev/null || echo '{}'
}

# ── Run restic backup ─────────────────────────────────────────────────────────
run_backup() {
  local command_id="${1:-}"
  log "Starting backup of paths: $RV_PATHS"

  # Fetch config from server (paths + exclusions)
  CONFIG_JSON="$(rv_get config 2>/dev/null || echo '{}')"
  SERVER_PATHS="$(echo "$CONFIG_JSON" | grep -o '"backupPaths":\[[^]]*\]' | grep -o '"[^"]*"' | tr -d '"' | tr '\n' ' ' || echo "")"
  EXCLUDE_PATTERNS="$(echo "$CONFIG_JSON" | grep -o '"excludePatterns":\[[^]]*\]' | grep -o '"[^"]*"' | tr -d '"' || echo "")"

  # Use server-configured paths if available, else fallback to local config
  BACKUP_PATHS_ARG=""
  if [[ -n "$SERVER_PATHS" ]]; then
    BACKUP_PATHS_ARG="$SERVER_PATHS"
  else
    # Convert comma-separated RV_PATHS to space-separated
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

  RESTIC_PASSWORD="" RESTIC_REPOSITORY="$RESTIC_REPO" \
    "$RESTIC_BIN" \
      -r "$RESTIC_REPO" \
      --header "Authorization: Bearer ${RV_TOKEN}" \
      --no-lock \
      backup \
        --json \
        $EXCLUDE_ARGS \
        $BACKUP_PATHS_ARG \
      >> "$LOG_FILE" 2>&1 && STATUS="success" || ERROR_MSG="restic exited with code $?"

  if [[ "$STATUS" == "success" ]]; then
    # Extract snapshot ID from log (last JSON summary line)
    SNAPSHOT_ID="$(grep -o '"snapshot_id":"[^"]*"' "$LOG_FILE" | tail -1 | cut -d'"' -f4 || echo "")"
    log "Backup succeeded. Snapshot: $SNAPSHOT_ID"
  else
    log "Backup failed: $ERROR_MSG"
  fi

  local result_data
  result_data="$(printf '{"status":"%s","errorMessage":"%s","snapshotId":"%s"' \
    "$STATUS" "$ERROR_MSG" "$SNAPSHOT_ID")"
  if [[ -n "$command_id" ]]; then
    result_data="${result_data},\"commandId\":${command_id}"
  fi
  result_data="${result_data}}"
  rv_post backup-result "$result_data"
}

# ── Discover filesystem paths ─────────────────────────────────────────────────
run_discover() {
  log "Discovering filesystem paths..."
  PATHS_JSON="["
  FIRST=true
  while IFS= read -r -d '' dir; do
    SIZE="$(du -sb "$dir" 2>/dev/null | awk '{print $1}' || echo 0)"
    COUNT="$(find "$dir" -maxdepth 1 -type f 2>/dev/null | wc -l || echo 0)"
    ESCAPED="${dir//\"/\\\"}"
    if [[ "$FIRST" == "true" ]]; then FIRST=false; else PATHS_JSON="${PATHS_JSON},"; fi
    PATHS_JSON="${PATHS_JSON}{\"path\":\"${ESCAPED}\",\"size_bytes\":${SIZE},\"file_count\":${COUNT}}"
  done < <(find / -maxdepth 3 -type d \( -path /proc -o -path /sys -o -path /dev -o -path /run \) -prune -o -type d -print0 2>/dev/null)
  PATHS_JSON="${PATHS_JSON}]"
  rv_post discover "{\"paths\":${PATHS_JSON}}"
  log "Discovery complete."
}

# ── Initialize repo ───────────────────────────────────────────────────────────
init_repo() {
  log "Initializing restic repository at $RESTIC_REPO ..."
  RESTIC_PASSWORD="" \
    "$RESTIC_BIN" \
      -r "$RESTIC_REPO" \
      --header "Authorization: Bearer ${RV_TOKEN}" \
      init 2>&1 | tee -a "$LOG_FILE" || true
}

# ── Main: heartbeat + command poll loop ──────────────────────────────────────
run_daemon() {
  log "Agent starting. Connecting to ${RV_SERVER} as '${RV_NAME}' ..."

  AGENT_VERSION="1.0.0"
  rv_post heartbeat "{\"agentVersion\":\"${AGENT_VERSION}\"}"

  # Try to init repo (idempotent — safe to run on existing repo)
  init_repo

  while true; do
    # Send heartbeat
    rv_post heartbeat "{\"agentVersion\":\"${AGENT_VERSION}\"}" > /dev/null

    # Poll for commands (30-second long poll)
    RESPONSE="$(rv_get poll 2>/dev/null || echo '{}')"
    CMD_TYPE="$(echo "$RESPONSE" | grep -o '"command":"[^"]*"' | cut -d'"' -f4 || echo "")"
    CMD_ID="$(echo "$RESPONSE" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2 || echo "")"

    if [[ -n "$CMD_TYPE" && "$CMD_TYPE" != "null" ]]; then
      log "Received command: $CMD_TYPE (id=$CMD_ID)"

      # Acknowledge
      if [[ -n "$CMD_ID" ]]; then
        rv_post ack "{\"commandId\":${CMD_ID}}" > /dev/null
      fi

      case "$CMD_TYPE" in
        backup)   run_backup "$CMD_ID" ;;
        discover) run_discover ;;
        uninstall)
          log "Uninstall command received. Stopping agent..."
          systemctl stop resticvault-agent.timer resticvault-agent.service 2>/dev/null || true
          systemctl disable resticvault-agent.timer resticvault-agent.service 2>/dev/null || true
          rm -f /etc/systemd/system/resticvault-agent.{service,timer}
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
AGENT_EOF

chmod +x "$AGENT_SCRIPT"
echo "Agent script written to $AGENT_SCRIPT"

# ── Convert cron schedule to systemd OnCalendar ──────────────────────────────
# Simple conversion for common patterns
cron_to_calendar() {
  local cron_expr="$1"
  case "$cron_expr" in
    "0 * * * *")    echo "hourly" ;;
    "0 0 * * *")    echo "daily" ;;
    "0 2 * * *")    echo "*-*-* 02:00:00" ;;
    "0 3 * * *")    echo "*-*-* 03:00:00" ;;
    "0 0 * * 0")    echo "weekly" ;;
    "0 0 1 * *")    echo "monthly" ;;
    *)
      # Parse: min hour dom month dow
      read -r min hour dom month dow <<< "$cron_expr"
      local time_part="${hour}:${min}:00"
      echo "*-*-* ${time_part}"
      ;;
  esac
}

ONCALENDAR="$(cron_to_calendar "$RV_SCHEDULE")"

# ── Write systemd service ─────────────────────────────────────────────────────
SERVICE_FILE="/etc/systemd/system/resticvault-agent.service"
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=ResticVault Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${AGENT_SCRIPT}
Restart=on-failure
RestartSec=30
StandardOutput=journal
StandardError=journal
SyslogIdentifier=resticvault-agent

[Install]
WantedBy=multi-user.target
EOF

# ── Write systemd timer (for scheduled backups) ───────────────────────────────
TIMER_FILE="/etc/systemd/system/resticvault-agent-backup.timer"
BACKUP_SERVICE_FILE="/etc/systemd/system/resticvault-agent-backup.service"

cat > "$BACKUP_SERVICE_FILE" <<EOF
[Unit]
Description=ResticVault Agent Scheduled Backup
After=network-online.target

[Service]
Type=oneshot
ExecStart=${AGENT_SCRIPT} backup
StandardOutput=journal
StandardError=journal
SyslogIdentifier=resticvault-backup
EOF

cat > "$TIMER_FILE" <<EOF
[Unit]
Description=ResticVault Agent Scheduled Backup Timer

[Timer]
OnCalendar=${ONCALENDAR}
Persistent=true
RandomizedDelaySec=60

[Install]
WantedBy=timers.target
EOF

# ── Enable and start ──────────────────────────────────────────────────────────
systemctl daemon-reload
systemctl enable resticvault-agent.service
systemctl enable resticvault-agent-backup.timer
systemctl restart resticvault-agent.service
systemctl start resticvault-agent-backup.timer

echo ""
echo "=== Installation complete! ==="
echo "Agent service:  resticvault-agent.service"
echo "Backup timer:   resticvault-agent-backup.timer (${ONCALENDAR})"
echo ""
echo "Check status:   systemctl status resticvault-agent"
echo "View logs:      journalctl -u resticvault-agent -f"
echo ""
echo "The agent will connect to ${RV_SERVER} and begin heartbeating."
