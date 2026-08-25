#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILES_DIR="$ROOT_DIR/profiles"
ENV_FILE="$ROOT_DIR/.env"
BASE_ENV_FILE="${BASE_ENV_FILE:-$ROOT_DIR/.env.production.base}"
PM2_PROCESS_NAME="${PM2_PROCESS_NAME:-epwx-bot}"
PM2_LOG_FILE="${PM2_LOG_FILE:-/home/deployer/.pm2/logs/${PM2_PROCESS_NAME}-out.log}"
STATE_FILE="${STATE_FILE:-$ROOT_DIR/logs/profile-switch-state.env}"
CURSOR_FILE="${CURSOR_FILE:-$ROOT_DIR/logs/profile-switch-cursor.env}"

PROFILE_REAL_USER="legit-market-making-real-user"
PROFILE_DISLOCATED="legit-market-making-dislocated"
PROFILE_SELL_ONLY="legit-market-making-sell-only-recovery"
PROFILE_COMPLIANCE="legit-market-making-biconomy-compliance"
PROFILE_DEX_ANCHORED="legit-market-making-dex-anchored"
AUTO_SWITCH_USE_SELL_ONLY_RECOVERY="${AUTO_SWITCH_USE_SELL_ONLY_RECOVERY:-false}"

ENTER_DISLOCATED_SPREAD="${AUTO_SWITCH_ENTER_DISLOCATED_SPREAD_PERCENT:-18}"
EXIT_DISLOCATED_SPREAD="${AUTO_SWITCH_EXIT_DISLOCATED_SPREAD_PERCENT:-6}"
CONFIRM_CYCLES="${AUTO_SWITCH_CONFIRM_CYCLES:-4}"
SCAN_LINES="${AUTO_SWITCH_SCAN_LINES:-4000}"
RESTART_ON_SWITCH="${RESTART_ON_SWITCH:-true}"

cursor_inode=""
cursor_offset="0"
recent_spreads=""

usage() {
	cat <<'EOF'
Usage:
	scripts/switch-profile.sh <profile-name>
	scripts/switch-profile.sh --auto
	scripts/switch-profile.sh --auto --dry-run

Profiles:
	legit-market-making-real-user
	legit-market-making-dislocated
	legit-market-making-sell-only-recovery
	legit-market-making-biconomy-compliance
	legit-market-making-dex-anchored

Auto mode:
	- Switches to dislocated profile when last N spreads are all >= ENTER threshold.
	- Switches to real-user profile when last N spreads are all <= EXIT threshold.
	- Uses hysteresis (different enter/exit thresholds) to avoid flapping.

Optional env vars:
	BASE_ENV_FILE (default: .env.production.base)
	PM2_PROCESS_NAME (default: epwx-bot)
	PM2_LOG_FILE (default: /home/deployer/.pm2/logs/<process>-out.log)
	AUTO_SWITCH_ENTER_DISLOCATED_SPREAD_PERCENT (default: 18)
	AUTO_SWITCH_EXIT_DISLOCATED_SPREAD_PERCENT (default: 6)
	AUTO_SWITCH_CONFIRM_CYCLES (default: 4)
	AUTO_SWITCH_USE_SELL_ONLY_RECOVERY (default: false)
	AUTO_SWITCH_SCAN_LINES (default: 4000)
	RESTART_ON_SWITCH (default: true)
	CURSOR_FILE (default: logs/profile-switch-cursor.env)
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

get_env_value() {
	local file="$1"
	local key="$2"
	awk -F= -v k="$key" '
		/^[[:space:]]*#/ {next}
		/^[[:space:]]*$/ {next}
		$1==k {print substr($0, index($0, "=")+1); found=1}
		END {if (!found) print ""}
	' "$file"
}

profile_matches_env() {
	local profile_path="$1"
	local key
	local expected
	local actual

	while IFS='=' read -r key expected; do
		[[ -z "${key// }" ]] && continue
		[[ "$key" =~ ^[[:space:]]*# ]] && continue
		actual="$(get_env_value "$ENV_FILE" "$key")"
		if [[ "$actual" != "$expected" ]]; then
			return 1
		fi
	done < "$profile_path"

	return 0
}

current_profile_from_env() {
	local real_user_file
	local dislocated_file
	local sell_only_file
	local compliance_file
	local dex_anchored_file
	real_user_file="$(profile_file "$PROFILE_REAL_USER")"
	dislocated_file="$(profile_file "$PROFILE_DISLOCATED")"
	sell_only_file="$(profile_file "$PROFILE_SELL_ONLY")"
	compliance_file="$(profile_file "$PROFILE_COMPLIANCE")"
	dex_anchored_file="$(profile_file "$PROFILE_DEX_ANCHORED")"

	if profile_matches_env "$real_user_file"; then
		echo "$PROFILE_REAL_USER"
		return
	fi

	if profile_matches_env "$dislocated_file"; then
		echo "$PROFILE_DISLOCATED"
		return
	fi

	if profile_matches_env "$sell_only_file"; then
		echo "$PROFILE_SELL_ONLY"
		return
	fi

	if profile_matches_env "$compliance_file"; then
		echo "$PROFILE_COMPLIANCE"
		return
	fi

	if profile_matches_env "$dex_anchored_file"; then
		echo "$PROFILE_DEX_ANCHORED"
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

load_cursor_state() {
	if [[ -f "$CURSOR_FILE" ]]; then
		# shellcheck disable=SC1090
		source "$CURSOR_FILE"
	fi

	cursor_inode="${cursor_inode:-}"
	cursor_offset="${cursor_offset:-0}"
	recent_spreads="${recent_spreads:-}"
}

save_cursor_state() {
	mkdir -p "$(dirname "$CURSOR_FILE")"
	{
		echo "cursor_inode=${cursor_inode}"
		echo "cursor_offset=${cursor_offset}"
		echo "recent_spreads=${recent_spreads}"
	} > "$CURSOR_FILE"
}

extract_spreads_from_text() {
	grep -E "\[EXEC BOOK\].*spread=" \
		| grep -oE 'spread=[0-9]+(\.[0-9]+)?%' \
		| sed -E 's/spread=([0-9]+(\.[0-9]+)?)%/\1/'
}

merge_recent_spreads() {
	local new_spreads="$1"
	local existing_lines
	local merged_lines

	existing_lines="$(echo "$recent_spreads" | tr ' ' '\n' | sed '/^$/d' || true)"
	merged_lines="$(printf "%s\n%s\n" "$existing_lines" "$new_spreads" | sed '/^$/d' | tail -n "$CONFIRM_CYCLES")"
	recent_spreads="$(echo "$merged_lines" | tr '\n' ' ' | sed 's/[[:space:]]\+$//')"
}

collect_new_log_chunk() {
	ensure_file_exists "$PM2_LOG_FILE"

	local current_inode
	local current_size
	current_inode="$(stat -c %i "$PM2_LOG_FILE")"
	current_size="$(stat -c %s "$PM2_LOG_FILE")"

	if [[ "$cursor_inode" == "$current_inode" ]] && [[ "$current_size" -ge "$cursor_offset" ]] && [[ "$cursor_offset" -gt 0 ]]; then
		dd if="$PM2_LOG_FILE" bs=1 skip="$cursor_offset" status=none || true
	else
		tail -n "$SCAN_LINES" "$PM2_LOG_FILE"
	fi

	cursor_inode="$current_inode"
	cursor_offset="$current_size"
}

merge_env_files() {
	local base_file="$1"
	local override_file="$2"
	local out_file="$3"

	awk -F= '
		function remember(k, v) {
			if (!(k in seen)) {
				order[++count] = k
				seen[k] = 1
			}
			values[k] = v
		}
		FNR==1 && NR!=1 { phase=2 }
		{
			if ($0 ~ /^[[:space:]]*#/ || $0 ~ /^[[:space:]]*$/) next
			if ($0 !~ /^[A-Za-z_][A-Za-z0-9_]*=/) next
			key = $1
			val = substr($0, index($0, "=")+1)
			remember(key, val)
		}
		END {
			for (i=1; i<=count; i++) {
				k = order[i]
				print k "=" values[k]
			}
		}
	' "$base_file" "$override_file" > "$out_file"
}

validate_compliance_profile_ready() {
	local target_profile="$1"
	if [[ "$target_profile" != "$PROFILE_COMPLIANCE" ]]; then
		return 0
	fi

	if ! command -v npx >/dev/null 2>&1; then
		log_error "npx is required to validate the Biconomy compliance profile."
		return 1
	fi

	log_info "Validating live market against Biconomy liquidity requirements before enabling compliance profile..."
	(
		cd "$ROOT_DIR"
		npx ts-node src/scripts/check-biconomy-compliance.ts
	) || {
		log_error "Compliance profile switch blocked: live market does not satisfy Biconomy liquidity requirements."
		return 1
	}

	return 0
}

switch_profile() {
	local target_profile="$1"
	local reason="$2"
	local target_file
	target_file="$(profile_file "$target_profile")"
	ensure_file_exists "$target_file"

	if ! validate_compliance_profile_ready "$target_profile"; then
		return 1
	fi

	if [[ -f "$BASE_ENV_FILE" ]]; then
		merge_env_files "$BASE_ENV_FILE" "$target_file" "$ENV_FILE"
		log_info "Merged base env ($BASE_ENV_FILE) with profile overrides ($target_file)."
	else
		cp "$target_file" "$ENV_FILE"
		log_warn "Base env file not found ($BASE_ENV_FILE); copied profile directly to .env."
	fi

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
	local new_chunk
	local new_spreads

	new_chunk="$(collect_new_log_chunk)"
	new_spreads="$(echo "$new_chunk" | extract_spreads_from_text || true)"
	merge_recent_spreads "$new_spreads"
	echo "$recent_spreads" | tr ' ' '\n' | sed '/^$/d'
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
	local stressed_target_profile

	stressed_target_profile="$PROFILE_DISLOCATED"
	if [[ "$AUTO_SWITCH_USE_SELL_ONLY_RECOVERY" == "true" ]]; then
		stressed_target_profile="$PROFILE_SELL_ONLY"
	fi

	current_profile="$(current_profile_from_env)"
	spreads="$(extract_recent_spreads || true)"
	save_cursor_state

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
				log_info "[DRY-RUN] Would switch to $stressed_target_profile"
			else
				switch_profile "$stressed_target_profile" "auto-switch: spread persisted above enter threshold"
			fi
		else
			log_info "No switch: real-user profile retained."
		fi
		return
	fi

	if [[ "$current_profile" == "$PROFILE_DISLOCATED" ]]; then
		if [[ "$AUTO_SWITCH_USE_SELL_ONLY_RECOVERY" == "true" ]] && should_enter_dislocated "$spreads"; then
			if [[ "$dry_run" == "true" ]]; then
				log_info "[DRY-RUN] Would switch to $PROFILE_SELL_ONLY"
			else
				switch_profile "$PROFILE_SELL_ONLY" "auto-switch: moving from dislocated to sell-only recovery under persistent stress"
			fi
			return
		fi

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

	if [[ "$current_profile" == "$PROFILE_SELL_ONLY" ]]; then
		if should_exit_dislocated "$spreads"; then
			if [[ "$dry_run" == "true" ]]; then
				log_info "[DRY-RUN] Would switch to $PROFILE_REAL_USER"
			else
				switch_profile "$PROFILE_REAL_USER" "auto-switch: spread normalized below exit threshold"
			fi
		else
			log_info "No switch: sell-only recovery profile retained."
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
	ensure_file_exists "$(profile_file "$PROFILE_SELL_ONLY")"
	ensure_file_exists "$(profile_file "$PROFILE_DEX_ANCHORED")"

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
	if [[ "$target_profile" != "$PROFILE_REAL_USER" && "$target_profile" != "$PROFILE_DISLOCATED" && "$target_profile" != "$PROFILE_SELL_ONLY" && "$target_profile" != "$PROFILE_COMPLIANCE" && "$target_profile" != "$PROFILE_DEX_ANCHORED" ]]; then
		log_error "Unsupported profile: $target_profile"
		usage
		exit 1
	fi

	if ! switch_profile "$target_profile" "manual switch"; then
		exit 1
	fi
}

main "$@"
