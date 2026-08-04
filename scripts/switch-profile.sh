#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILES_DIR="$ROOT_DIR/profiles"
ENV_FILE="$ROOT_DIR/.env"
PM2_PROCESS_NAME="${PM2_PROCESS_NAME:-epwx-bot}"
PM2_LOG_FILE="${PM2_LOG_FILE:-/home/deployer/.pm2/logs/${PM2_PROCESS_NAME}-out.log}"
STATE_FILE="${STATE_FILE:-$ROOT_DIR/logs/profile-switch-state.env}"

PROFILE_REAL_USER="legit-market-making-real-user"
PROFILE_DISLOCATED="legit-market-making-dislocated"

ENTER_DISLOCATED_SPREAD="${AUTO_SWITCH_ENTER_DISLOCATED_SPREAD_PERCENT:-15}"
EXIT_DISLOCATED_SPREAD="${AUTO_SWITCH_EXIT_DISLOCATED_SPREAD_PERCENT:-3}"
CONFIRM_CYCLES="${AUTO_SWITCH_CONFIRM_CYCLES:-6}"
SCAN_LINES="${AUTO_SWITCH_SCAN_LINES:-4000}"
RESTART_ON_SWITCH="${RESTART_ON_SWITCH:-true}"

usage() {
	cat <<'EOF'
Usage:
	scripts/switch-profile.sh <profile-name>
	scripts/switch-profile.sh --auto
	scripts/switch-profile.sh --auto --dry-run

Profiles:
	legit-market-making-real-user
	legit-market-making-dislocated

Auto mode:
	- Switches to dislocated profile when last N spreads are all >= ENTER threshold.
	- Switches to real-user profile when last N spreads are all <= EXIT threshold.
	- Uses hysteresis (different enter/exit thresholds) to avoid flapping.

Optional env vars:
	PM2_PROCESS_NAME (default: epwx-bot)
	PM2_LOG_FILE (default: /home/deployer/.pm2/logs/<process>-out.log)
	AUTO_SWITCH_ENTER_DISLOCATED_SPREAD_PERCENT (default: 15)
	AUTO_SWITCH_EXIT_DISLOCATED_SPREAD_PERCENT (default: 3)
	AUTO_SWITCH_CONFIRM_CYCLES (default: 6)
	AUTO_SWITCH_SCAN_LINES (default: 4000)
	RESTART_ON_SWITCH (default: true)
EOF
}

log_info() { echo "[INFO] $*"; }
log_warn() { echo "[WARN] $*"; }
log_error() { echo "[ERROR] $*"; }

ensure_file_exists() {
	local file="$1"
	if [[ ! -f "$file" ]]; then
		log_error "Required file not found: $file"
		exit 1
	fi
}

profile_file() {
	local profile_name="$1"
	echo "$PROFILES_DIR/${profile_name}.env"
}

current_profile_from_env() {
	local real_user_file
	local dislocated_file
	real_user_file="$(profile_file "$PROFILE_REAL_USER")"
	dislocated_file="$(profile_file "$PROFILE_DISLOCATED")"

	if cmp -s "$ENV_FILE" "$real_user_file"; then
		echo "$PROFILE_REAL_USER"
		return
	fi

	if cmp -s "$ENV_FILE" "$dislocated_file"; then
		echo "$PROFILE_DISLOCATED"
		return
	fi

	echo "unknown"
}

restart_pm2_if_enabled() {
	if [[ "$RESTART_ON_SWITCH" != "true" ]]; then
		log_info "RESTART_ON_SWITCH=false, skipping PM2 restart."
		return
	fi

	if ! command -v pm2 >/dev/null 2>&1; then
		log_warn "pm2 not found in PATH, profile copied but process not restarted."
		return
	fi

	log_info "Restarting PM2 process: $PM2_PROCESS_NAME"
	pm2 restart "$PM2_PROCESS_NAME" --update-env
}

switch_profile() {
	local target_profile="$1"
	local reason="$2"
	local target_file
	target_file="$(profile_file "$target_profile")"
	ensure_file_exists "$target_file"

	cp "$target_file" "$ENV_FILE"
	mkdir -p "$(dirname "$STATE_FILE")"
	{
		echo "last_switch_ts=$(date +%s)"
		echo "profile=$target_profile"
		echo "reason=$reason"
	} > "$STATE_FILE"

	log_info "Switched .env to profile: $target_profile"
	log_info "Reason: $reason"
	restart_pm2_if_enabled
}

extract_recent_spreads() {
	ensure_file_exists "$PM2_LOG_FILE"
	tail -n "$SCAN_LINES" "$PM2_LOG_FILE" \
		| grep -E "\[EXEC BOOK\].*spread=" \
		| grep -oE 'spread=[0-9]+(\.[0-9]+)?%' \
		| sed -E 's/spread=([0-9]+(\.[0-9]+)?)%/\1/' \
		| tail -n "$CONFIRM_CYCLES"
}

should_enter_dislocated() {
	local spreads="$1"
	local count
	local above_count
	count=$(echo "$spreads" | sed '/^$/d' | wc -l | tr -d ' ')
	if [[ "$count" -lt "$CONFIRM_CYCLES" ]]; then
		return 1
	fi

	above_count=$(echo "$spreads" | awk -v t="$ENTER_DISLOCATED_SPREAD" '$1 >= t {c++} END {print c+0}')
	[[ "$above_count" -eq "$CONFIRM_CYCLES" ]]
}

should_exit_dislocated() {
	local spreads="$1"
	local count
	local below_count
	count=$(echo "$spreads" | sed '/^$/d' | wc -l | tr -d ' ')
	if [[ "$count" -lt "$CONFIRM_CYCLES" ]]; then
		return 1
	fi

	below_count=$(echo "$spreads" | awk -v t="$EXIT_DISLOCATED_SPREAD" '$1 <= t {c++} END {print c+0}')
	[[ "$below_count" -eq "$CONFIRM_CYCLES" ]]
}

auto_switch() {
	local dry_run="$1"
	local current_profile
	local spreads

	current_profile="$(current_profile_from_env)"
	spreads="$(extract_recent_spreads || true)"

	if [[ -z "${spreads// }" ]]; then
		log_warn "No executable spread samples found in log window. No switch performed."
		return
	fi

	log_info "Current profile: $current_profile"
	log_info "Recent spreads (%): $(echo "$spreads" | tr '\n' ' ' | sed 's/ $//')"
	log_info "Hysteresis thresholds: enter_dislocated>=${ENTER_DISLOCATED_SPREAD} exit_dislocated<=${EXIT_DISLOCATED_SPREAD}, confirm_cycles=${CONFIRM_CYCLES}"

	if [[ "$current_profile" == "$PROFILE_REAL_USER" ]]; then
		if should_enter_dislocated "$spreads"; then
			if [[ "$dry_run" == "true" ]]; then
				log_info "[DRY-RUN] Would switch to $PROFILE_DISLOCATED"
			else
				switch_profile "$PROFILE_DISLOCATED" "auto-switch: spread persisted above enter threshold"
			fi
		else
			log_info "No switch: real-user profile retained."
		fi
		return
	fi

	if [[ "$current_profile" == "$PROFILE_DISLOCATED" ]]; then
		if should_exit_dislocated "$spreads"; then
			if [[ "$dry_run" == "true" ]]; then
				log_info "[DRY-RUN] Would switch to $PROFILE_REAL_USER"
			else
				switch_profile "$PROFILE_REAL_USER" "auto-switch: spread normalized below exit threshold"
			fi
		else
			log_info "No switch: dislocated profile retained."
		fi
		return
	fi

	log_warn "Current .env does not exactly match known legit profiles; no auto-switch performed."
}

main() {
	if [[ $# -eq 0 ]]; then
		usage
		exit 1
	fi

	ensure_file_exists "$ENV_FILE"
	ensure_file_exists "$(profile_file "$PROFILE_REAL_USER")"
	ensure_file_exists "$(profile_file "$PROFILE_DISLOCATED")"

	if [[ "$1" == "--auto" ]]; then
		local dry_run="false"
		if [[ "${2:-}" == "--dry-run" ]]; then
			dry_run="true"
		fi
		auto_switch "$dry_run"
		exit 0
	fi

	if [[ "$1" == "-h" || "$1" == "--help" ]]; then
		usage
		exit 0
	fi

	local target_profile="$1"
	if [[ "$target_profile" != "$PROFILE_REAL_USER" && "$target_profile" != "$PROFILE_DISLOCATED" ]]; then
		log_error "Unsupported profile: $target_profile"
		usage
		exit 1
	fi

	switch_profile "$target_profile" "manual switch"
}

main "$@"
