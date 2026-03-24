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
  curl -fsSL "$RESTIC_URL" -o "${TMP_FILE}.bz2"
  bunzip2 "${TMP_FILE}.bz2"
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
source "$CONFIG_FILE"

# Build restic repo URL
_RV_PROTO="https"
[[ "${RV_SERVER}" == http://* ]] && _RV_PROTO="http"
_RV_HOST="${RV_SERVER#https://}"
_RV_HOST="${_RV_HOST#http://}"
RESTIC_REPO="rest:${_RV_PROTO}://x:${RV_TOKEN}@${_RV_HOST}/restic/${RV_NAME}/"

# ── Helper: send JSON to server ───────────────────────────────────────────────
rv_post() {
  local endpoint="$1"
  local data="$2"
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

# ── Convert cron expression to systemd OnCalendar ────────────────────────────
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
      read -r min hour dom month dow <<< "$cron_expr"
      echo "*-*-* ${hour}:${min}:00"
      ;;
  esac
}

# ── Run restic backup ────────────────────────────────────────────────────────
run_backup() {
  local command_id="${1:-}"
  log "Starting backup of paths: $RV_PATHS"

  CONFIG_JSON="$(rv_get config 2>/dev/null || echo '{}')"
  SERVER_PATHS="$(echo "$CONFIG_JSON" | grep -o '"backupPaths":\[[^]]*\]' | sed 's/^"backupPaths"://' | grep -o '"[^"]*"' | tr -d '"' | tr '\n' ' ' || echo "")"
  EXCLUDE_PATTERNS="$(echo "$CONFIG_JSON" | grep -o '"excludePatterns":\[[^]]*\]' | sed 's/^"excludePatterns"://' | grep -o '"[^"]*"' | tr -d '"' || echo "")"

  BACKUP_PATHS_ARG=""
  if [[ -n "${SERVER_PATHS// /}" ]]; then
    BACKUP_PATHS_ARG="$SERVER_PATHS"
  else
    BACKUP_PATHS_ARG="${RV_PATHS//,/ }"
  fi

  EXCLUDE_ARGS=""
  while IFS= read -r pat; do
    [[ -n "$pat" ]] && EXCLUDE_ARGS="$EXCLUDE_ARGS --exclude $pat"
  done <<< "$EXCLUDE_PATTERNS"

  SNAPSHOT_ID=""
  ERROR_MSG=""
  STATUS="failure"

  # Pipe restic stdout through a parser to extract progress and report it
  LAST_PROGRESS_TIME=0
  _EXIT_FILE="$(mktemp)"
  while IFS= read -r line; do
    echo "$line" >> "$LOG_FILE"

    MSG_TYPE="$(echo "$line" | grep -o '"message_type":"[^"]*"' | cut -d'"' -f4 || echo "")"

    if [[ "$MSG_TYPE" == "status" ]]; then
      NOW="$(date +%s)"
      if (( NOW - LAST_PROGRESS_TIME >= 5 )); then
        LAST_PROGRESS_TIME="$NOW"
        PCT="$(echo "$line"     | grep -o '"percent_done":[0-9.e-]*'  | cut -d: -f2 || echo "0")"
        T_FILES="$(echo "$line" | grep -o '"total_files":[0-9]*'      | cut -d: -f2 || echo "0")"
        F_DONE="$(echo "$line"  | grep -o '"files_done":[0-9]*'       | cut -d: -f2 || echo "0")"
        T_BYTES="$(echo "$line" | grep -o '"total_bytes":[0-9]*'      | cut -d: -f2 || echo "0")"
        B_DONE="$(echo "$line"  | grep -o '"bytes_done":[0-9]*'       | cut -d: -f2 || echo "0")"
        C_FILE="$(echo "$line"  | grep -o '"current_files":\["[^"]*"' | sed 's/.*\["//;s/"$//' || echo "")"
        # Escape backslashes and double-quotes in filename for safe JSON embedding
        C_FILE="$(echo "$C_FILE" | sed 's/\\/\\\\/g;s/"/\\"/g')"

        PROGRESS_DATA=$(printf '{"percentDone":%s,"totalFiles":%s,"filesDone":%s,"totalBytes":%s,"bytesDone":%s,"currentFile":"%s"}' \
          "${PCT:-0}" "${T_FILES:-0}" "${F_DONE:-0}" "${T_BYTES:-0}" "${B_DONE:-0}" "${C_FILE}")
        rv_post backup-progress "$PROGRESS_DATA" > /dev/null 2>&1 &
      fi
    fi

    if [[ "$MSG_TYPE" == "summary" ]]; then
      SNAPSHOT_ID="$(echo "$line" | grep -o '"snapshot_id":"[^"]*"' | cut -d'"' -f4 || echo "")"
    fi
  done < <("$RESTIC_BIN" \
    -r "$RESTIC_REPO" \
    --insecure-no-password \
    --no-lock \
    backup \
      --json \
      $EXCLUDE_ARGS \
      $BACKUP_PATHS_ARG \
    2>> "$LOG_FILE"; echo $? > "$_EXIT_FILE")

  RESTIC_EXIT="$(cat "$_EXIT_FILE" 2>/dev/null || echo "1")"
  rm -f "$_EXIT_FILE"

  if [[ "$RESTIC_EXIT" -eq 0 ]]; then
    STATUS="success"
  else
    ERROR_MSG="restic exited with code $RESTIC_EXIT"
  fi

  if [[ "$STATUS" == "success" ]]; then
    log "Backup succeeded. Snapshot: $SNAPSHOT_ID"

    # ── Retention: forget + prune based on server config ──────────────────────
    KEEP_LAST="$(echo    "$CONFIG_JSON" | grep -o '"keepLast":[0-9]*'    | cut -d: -f2 || echo "")"
    KEEP_DAILY="$(echo   "$CONFIG_JSON" | grep -o '"keepDaily":[0-9]*'   | cut -d: -f2 || echo "")"
    KEEP_WEEKLY="$(echo  "$CONFIG_JSON" | grep -o '"keepWeekly":[0-9]*'  | cut -d: -f2 || echo "")"
    KEEP_MONTHLY="$(echo "$CONFIG_JSON" | grep -o '"keepMonthly":[0-9]*' | cut -d: -f2 || echo "")"
    KEEP_YEARLY="$(echo  "$CONFIG_JSON" | grep -o '"keepYearly":[0-9]*'  | cut -d: -f2 || echo "")"

    FORGET_ARGS=""
    [[ -n "$KEEP_LAST"    ]] && FORGET_ARGS="$FORGET_ARGS --keep-last $KEEP_LAST"
    [[ -n "$KEEP_DAILY"   ]] && FORGET_ARGS="$FORGET_ARGS --keep-daily $KEEP_DAILY"
    [[ -n "$KEEP_WEEKLY"  ]] && FORGET_ARGS="$FORGET_ARGS --keep-weekly $KEEP_WEEKLY"
    [[ -n "$KEEP_MONTHLY" ]] && FORGET_ARGS="$FORGET_ARGS --keep-monthly $KEEP_MONTHLY"
    [[ -n "$KEEP_YEARLY"  ]] && FORGET_ARGS="$FORGET_ARGS --keep-yearly $KEEP_YEARLY"

    if [[ -n "$FORGET_ARGS" ]]; then
      log "Running forget/prune:$FORGET_ARGS"
      "$RESTIC_BIN" \
        -r "$RESTIC_REPO" \
        --insecure-no-password \
        forget --prune \
        $FORGET_ARGS \
      >> "$LOG_FILE" 2>&1 || log "Warning: forget/prune failed (non-fatal)"
    fi
  else
    log "Backup failed: $ERROR_MSG"
  fi

  local result_data
  result_data=$(printf '{"status":"%s","errorMessage":"%s","snapshotId":"%s"' "$STATUS" "$ERROR_MSG" "$SNAPSHOT_ID")
  if [[ -n "$command_id" ]]; then
    result_data="${result_data},$(printf '"commandId":%d' "$command_id")"
  fi
  result_data="${result_data}}"
  rv_post backup-result "$result_data"
}

# ── Discover filesystem paths ────────────────────────────────────────────────
run_discover() {
  log "Discovering filesystem paths..."

  local temp_file
  temp_file="$(mktemp)"

  echo -n "[" > "$temp_file"
  local first=true

  while IFS= read -r -d '' dir; do
    local size
    size="$(du -sb "$dir" 2>/dev/null | awk '{print $1}' || echo 0)"

    local count
    count="$(find "$dir" -maxdepth 1 -type f 2>/dev/null | wc -l || echo 0)"

    local escaped
    escaped="${dir//\\/\\\\}"
    escaped="${escaped//\"/\\\"}"

    if [[ "$first" == "true" ]]; then
      first=false
    else
      echo -n "," >> "$temp_file"
    fi

    echo -n "$(printf '{"path":"%s","size_bytes":%d,"file_count":%d}' "$escaped" "$size" "$count")" >> "$temp_file"
  done < <(find / -maxdepth 3 -type d \( -path /proc -o -path /sys -o -path /dev -o -path /run \) -prune -o -type d -print0 2>/dev/null)

  echo -n "]" >> "$temp_file"

  local paths_json
  paths_json="$(cat "$temp_file")"
  rm -f "$temp_file"

  local discover_data
  discover_data=$(printf '{"paths":%s}' "$paths_json")
  rv_post discover "$discover_data"
  log "Discovery complete."
}

# ── Initialize repo ──────────────────────────────────────────────────────────
init_repo() {
  log "Initializing restic repository at $RESTIC_REPO ..."
  "$RESTIC_BIN" \
    -r "$RESTIC_REPO" \
    --insecure-no-password \
    init 2>&1 | tee -a "$LOG_FILE" || true
}

# ── Sync schedule: update systemd timer if server schedule changed ────────────
sync_schedule() {
  local config_json="$1"
  local server_schedule
  server_schedule="$(echo "$config_json" | grep -o '"schedule":"[^"]*"' | cut -d'"' -f4 || echo "")"
  [[ -z "$server_schedule" ]] && return

  local timer_file="/etc/systemd/system/resticvault-agent-backup.timer"
  [[ ! -f "$timer_file" ]] && return

  local new_calendar
  new_calendar="$(cron_to_calendar "$server_schedule")"

  local current_calendar
  current_calendar="$(grep '^OnCalendar=' "$timer_file" 2>/dev/null | cut -d= -f2 || echo "")"

  if [[ "$current_calendar" != "$new_calendar" ]]; then
    log "Schedule changed: '$current_calendar' → '$new_calendar' (cron: $server_schedule)"
    sed -i "s|^OnCalendar=.*|OnCalendar=${new_calendar}|" "$timer_file"
    systemctl daemon-reload 2>/dev/null || true
    systemctl restart resticvault-agent-backup.timer 2>/dev/null || true
    log "Backup timer updated and restarted."
  fi
}

# ── Self-update ──────────────────────────────────────────────────────────────
run_update() {
  local command_id="${1:-}"
  log "Self-update requested. Downloading latest agent-install.sh from ${RV_SERVER} ..."

  local tmp_script
  tmp_script="$(mktemp /tmp/resticvault-update-XXXXXX.sh)"

  if ! curl -fsSL "${RV_SERVER}/agent-install.sh" -o "$tmp_script"; then
    log "Update failed: could not download agent-install.sh"
    rm -f "$tmp_script"
    return 1
  fi

  chmod +x "$tmp_script"
  log "Download complete. Re-running installer with current config ..."

  # Source current config to get all parameters
  source "$CONFIG_FILE"

  # Re-run installer with the same parameters that were used initially.
  # The installer overwrites the daemon script + systemd units, then
  # systemd Restart=on-failure picks up the new version.
  bash "$tmp_script" \
    --server  "${RV_SERVER}" \
    --token   "${RV_TOKEN}" \
    --name    "${RV_NAME}" \
    --paths   "${RV_PATHS}" \
    >> "$LOG_FILE" 2>&1 &

  rm -f "$tmp_script"
  log "Installer launched in background. Agent will restart momentarily."
  # Exit so systemd restarts us with the new binary
  exit 0
}

# ── Main: heartbeat + command poll loop ──────────────────────────────────────
run_daemon() {
  log "Agent starting. Connecting to ${RV_SERVER} as '${RV_NAME}' ..."

  AGENT_VERSION="1.1.5"
  local hb
  hb=$(printf '{"agentVersion":"%s"}' "$AGENT_VERSION")
  rv_post heartbeat "$hb"

  init_repo

  # One-time version check on startup
  local server_version
  server_version="$(curl -fsSL "${RV_SERVER}/api/sources/agent/version" 2>/dev/null \
    | grep -o '"version":"[^"]*"' | cut -d'"' -f4 || echo "")"
  if [[ -n "$server_version" && "$server_version" != "$AGENT_VERSION" ]]; then
    log "Update available: local=$AGENT_VERSION server=$server_version"
  else
    log "Agent version $AGENT_VERSION is up to date."
  fi

  while true; do
    hb=$(printf '{"agentVersion":"%s"}' "$AGENT_VERSION")
    rv_post heartbeat "$hb" > /dev/null 2>&1

    # Fetch config for schedule sync (lightweight, every loop iteration)
    AGENT_CONFIG_JSON="$(rv_get config 2>/dev/null || echo '{}')"
    sync_schedule "$AGENT_CONFIG_JSON"

    RESPONSE="$(rv_get poll 2>/dev/null || echo '{}')"
    CMD_TYPE="$(echo "$RESPONSE" | grep -o '"command":"[^"]*"' | cut -d'"' -f4 || echo "")"
    CMD_ID="$(echo "$RESPONSE" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2 || echo "")"

    if [[ -n "$CMD_TYPE" && "$CMD_TYPE" != "null" ]]; then
      log "Received command: $CMD_TYPE (id=$CMD_ID)"

      if [[ -n "$CMD_ID" ]]; then
        local ack
        ack=$(printf '{"commandId":%d}' "$CMD_ID")
        rv_post ack "$ack" > /dev/null 2>&1
      fi

      case "$CMD_TYPE" in
        backup)   run_backup "$CMD_ID" ;;
        discover) run_discover ;;
        update)   run_update "$CMD_ID" ;;
        uninstall)
          log "Uninstall command received. Stopping agent..."
          systemctl stop resticvault-agent-backup.timer resticvault-agent.service 2>/dev/null || true
          systemctl disable resticvault-agent-backup.timer resticvault-agent.service 2>/dev/null || true
          rm -f /etc/systemd/system/resticvault-agent*
          rm -f /usr/local/bin/resticvault-agent
          rm -rf /etc/resticvault-agent
          systemctl daemon-reload 2>/dev/null || true
          log "Agent uninstalled."
          exit 0
          ;;
      esac
    fi

    sleep 30
  done
}

if [[ "${1:-}" == "backup" ]]; then
  log "Scheduled backup triggered by systemd timer."
  run_backup ""
  exit 0
fi

if [[ "${1:-}" == "discover" ]]; then
  run_discover
  exit 0
fi

run_daemon
AGENT_EOF

chmod +x "$AGENT_SCRIPT"
echo "Agent script written to $AGENT_SCRIPT"

# ── Convert cron schedule to systemd OnCalendar ──────────────────────────────
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
      read -r min hour dom month dow <<< "$cron_expr"
      echo "*-*-* ${hour}:${min}:00"
      ;;
  esac
}

ONCALENDAR="$(cron_to_calendar "$RV_SCHEDULE")"

# ── Write systemd service ────────────────────────────────────────────────────
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

# ── Write systemd timer ──────────────────────────────────────────────────────
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

# ── Enable and start ────────────────────────────────────────────────────────
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