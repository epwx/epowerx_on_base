#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILES_DIR="$ROOT_DIR/profiles/azbit"
ENV_FILE="${AZBIT_ENV_FILE:-$ROOT_DIR/.env.azbit}"
STATE_FILE="${AZBIT_PROFILE_STATE_FILE:-$ROOT_DIR/logs/azbit-profile-switch-state.env}"
CURSOR_FILE="${AZBIT_PROFILE_CURSOR_FILE:-$ROOT_DIR/logs/azbit-profile-switch-cursor.env}"
START_SCRIPT="${AZBIT_START_SCRIPT:-$ROOT_DIR/scripts/start-azbit.sh}"
TICKER_URL="${AZBIT_TICKER_URL:-https://data.azbit.com/api/tickers}"
PAIR="${AZBIT_PROFILE_PAIR:-EPWX_USDT}"

PROFILE_NORMAL="azbit-conservative"
PROFILE_DISLOCATED="azbit-dislocated"
PROFILE_SELL_ONLY="azbit-sell-only-recovery"
PROFILE_EXTREME_SHADOW="azbit-extreme-shadow-liquidity"

ENTER_DISLOCATED="${AZBIT_ENTER_DISLOCATED_SPREAD_PERCENT:-12}"
EXIT_DISLOCATED="${AZBIT_EXIT_DISLOCATED_SPREAD_PERCENT:-6}"
ENTER_SELL_ONLY="${AZBIT_ENTER_SELL_ONLY_SPREAD_PERCENT:-150}"
EXIT_SELL_ONLY="${AZBIT_EXIT_SELL_ONLY_SPREAD_PERCENT:-80}"
CONFIRM_CYCLES="${AZBIT_PROFILE_CONFIRM_CYCLES:-3}"

usage() {
	cat <<'EOF'
Usage:
	scripts/switch-azbit-profile.sh --auto [--dry-run|--apply]
	scripts/switch-azbit-profile.sh <profile-name> [--dry-run|--apply]

Profiles:
	azbit-conservative
	azbit-dislocated
	azbit-sell-only-recovery
	azbit-extreme-shadow-liquidity (manual only)

Safety:
	Dry-run is the default. --apply is required to modify .env.azbit and restart
	epwx-azbit-bot through scripts/start-azbit.sh. All shipped profiles retain
	AZBIT_READ_ONLY=true.

Auto mode defaults:
	Enter dislocated at 12%, return to normal at 6%.
	Enter sell-only recovery at 150%, leave it for dislocated at 80%.
	Require 3 consecutive samples before changing the effective profile.
EOF
}

log_info() { echo "[INFO] $*"; }
log_warn() { echo "[WARN] $*"; }
log_error() { echo "[ERROR] $*" >&2; }

ensure_file_exists() {
	if [[ ! -f "$1" ]]; then
		log_error "Required file not found: $1"
		exit 1
	fi
}

profile_file() {
	echo "$PROFILES_DIR/$1.env"
}

is_supported_profile() {
	[[ "$1" == "$PROFILE_NORMAL" || "$1" == "$PROFILE_DISLOCATED" || "$1" == "$PROFILE_SELL_ONLY" || "$1" == "$PROFILE_EXTREME_SHADOW" ]]
}

get_env_value() {
	local file="$1"
	local key="$2"
	awk -F= -v k="$key" '
		/^[[:space:]]*#/ {next}
		/^[[:space:]]*$/ {next}
		$1==k {print substr($0, index($0, "=")+1); exit}
	' "$file"
}

profile_matches_env() {
	local profile_path="$1"
	local key expected actual

	while IFS='=' read -r key expected; do
		[[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
		actual="$(get_env_value "$ENV_FILE" "$key")"
		[[ "$actual" == "$expected" ]] || return 1
	done < "$profile_path"
}

current_profile_from_env() {
	local profile
	for profile in "$PROFILE_NORMAL" "$PROFILE_DISLOCATED" "$PROFILE_SELL_ONLY" "$PROFILE_EXTREME_SHADOW"; do
		if profile_matches_env "$(profile_file "$profile")"; then
			echo "$profile"
			return
		fi
	done
	echo "unknown"
}

merge_env_files() {
	local base_file="$1"
	local override_file="$2"
	local out_file="$3"

	awk -F= '
		function remember(key, value) {
			if (!(key in seen)) {
				order[++count] = key
				seen[key] = 1
			}
			values[key] = value
		}
		{
			if ($0 !~ /^[A-Za-z_][A-Za-z0-9_]*=/) next
			key = $1
			value = substr($0, index($0, "=")+1)
			remember(key, value)
		}
		END {
			for (i=1; i<=count; i++) {
				key = order[i]
				print key "=" values[key]
			}
		}
	' "$base_file" "$override_file" > "$out_file"
}

sample_public_spread() {
	if [[ -n "${AZBIT_SPREAD_OVERRIDE_PERCENT:-}" ]]; then
		printf 'override override %s\n' "$AZBIT_SPREAD_OVERRIDE_PERCENT"
		return
	fi

	local payload
	payload="$(curl --fail --silent --show-error --get \
		--data-urlencode "currencyPairCode=$PAIR" \
		--connect-timeout 10 --max-time 20 "$TICKER_URL")"

	printf '%s' "$payload" | node -e '
		let body = "";
		process.stdin.on("data", chunk => body += chunk);
		process.stdin.on("end", () => {
			const parsed = JSON.parse(body);
			const rows = Array.isArray(parsed) ? parsed : [parsed];
			const pair = process.argv[1].toUpperCase();
			const ticker = rows.find(row => String(row.currencyPairCode || "").toUpperCase() === pair);
			const bid = Number(ticker && ticker.bidPrice);
			const ask = Number(ticker && ticker.askPrice);
			if (!(bid > 0) || !(ask > bid)) {
				throw new Error(`invalid ${pair} ticker bid/ask`);
			}
			const spread = ((ask - bid) / bid) * 100;
			process.stdout.write(`${bid} ${ask} ${spread}`);
		});
	' "$PAIR"
}

select_target_profile() {
	local current="$1"
	local spread="$2"

	awk -v current="$current" -v spread="$spread" \
		-v normal="$PROFILE_NORMAL" -v dislocated="$PROFILE_DISLOCATED" -v sell="$PROFILE_SELL_ONLY" \
		-v enter_dislocated="$ENTER_DISLOCATED" -v exit_dislocated="$EXIT_DISLOCATED" \
		-v enter_sell="$ENTER_SELL_ONLY" -v exit_sell="$EXIT_SELL_ONLY" '
		BEGIN {
			if (current == normal) {
				if (spread >= enter_sell) print sell;
				else if (spread >= enter_dislocated) print dislocated;
				else print normal;
			} else if (current == dislocated) {
				if (spread >= enter_sell) print sell;
				else if (spread <= exit_dislocated) print normal;
				else print dislocated;
			} else if (current == sell) {
				if (spread <= exit_dislocated) print normal;
				else if (spread <= exit_sell) print dislocated;
				else print sell;
			} else {
				if (spread >= enter_sell) print sell;
				else if (spread >= enter_dislocated) print dislocated;
				else if (spread <= exit_dislocated) print normal;
				else print "unknown";
			}
		}
	'
}

write_cursor() {
	local candidate="$1"
	local count="$2"
	local spread="$3"
	local temp_file
	mkdir -p "$(dirname "$CURSOR_FILE")"
	temp_file="$(mktemp "${CURSOR_FILE}.XXXXXX")"
	chmod 600 "$temp_file"
	{
		echo "candidate_profile=$candidate"
		echo "candidate_count=$count"
		echo "last_sample_ts=$(date +%s)"
		echo "last_spread_percent=$spread"
	} > "$temp_file"
	mv "$temp_file" "$CURSOR_FILE"
}

write_state() {
	local profile="$1"
	local mode="$2"
	local spread="$3"
	local temp_file
	mkdir -p "$(dirname "$STATE_FILE")"
	temp_file="$(mktemp "${STATE_FILE}.XXXXXX")"
	chmod 600 "$temp_file"
	{
		echo "last_decision_ts=$(date +%s)"
		echo "profile=$profile"
		echo "mode=$mode"
		echo "spread_percent=$spread"
	} > "$temp_file"
	mv "$temp_file" "$STATE_FILE"
}

apply_profile() {
	local target="$1"
	local reason="$2"
	local profile_path temp_file
	profile_path="$(profile_file "$target")"
	ensure_file_exists "$profile_path"
	temp_file="$(mktemp "${ENV_FILE}.XXXXXX")"
	chmod 600 "$temp_file"
	merge_env_files "$ENV_FILE" "$profile_path" "$temp_file"
	mv "$temp_file" "$ENV_FILE"
	log_info "Applied $target to .env.azbit ($reason)."
	ensure_file_exists "$START_SCRIPT"
	bash "$START_SCRIPT"
}

auto_switch() {
	local mode="$1"
	local env_profile simulated_profile current_profile
	local bid ask spread target previous_candidate previous_count candidate_count

	read -r bid ask spread <<< "$(sample_public_spread)"
	env_profile="$(current_profile_from_env)"
	simulated_profile="$(get_env_value "$STATE_FILE" profile 2>/dev/null || true)"
	current_profile="$env_profile"
	if [[ "$mode" == "dry-run" ]] && is_supported_profile "$simulated_profile"; then
		current_profile="$simulated_profile"
	fi

	target="$(select_target_profile "$current_profile" "$spread")"
	previous_candidate="$(get_env_value "$CURSOR_FILE" candidate_profile 2>/dev/null || true)"
	previous_count="$(get_env_value "$CURSOR_FILE" candidate_count 2>/dev/null || true)"
	[[ "$previous_count" =~ ^[0-9]+$ ]] || previous_count=0

	if [[ "$target" == "unknown" || "$target" == "$current_profile" ]]; then
		candidate_count=0
		write_cursor "$target" "$candidate_count" "$spread"
		log_info "Azbit $PAIR bid=$bid ask=$ask spread=${spread}% profile=$current_profile; no transition."
		return
	fi

	if [[ "$target" == "$previous_candidate" ]]; then
		candidate_count=$((previous_count + 1))
	else
		candidate_count=1
	fi
	write_cursor "$target" "$candidate_count" "$spread"
	log_info "Azbit $PAIR bid=$bid ask=$ask spread=${spread}% profile=$current_profile candidate=$target confirmation=${candidate_count}/${CONFIRM_CYCLES}."

	if [[ "$candidate_count" -lt "$CONFIRM_CYCLES" ]]; then
		return
	fi

	if [[ "$mode" == "apply" ]]; then
		apply_profile "$target" "confirmed public spread transition"
	else
		log_info "[DRY-RUN] Would apply $target and restart epwx-azbit-bot through scripts/start-azbit.sh."
	fi
	write_state "$target" "$mode" "$spread"
	write_cursor "$target" 0 "$spread"
}

manual_switch() {
	local target="$1"
	local mode="$2"
	if [[ "$mode" == "apply" ]]; then
		apply_profile "$target" "manual selection"
		write_state "$target" "$mode" "manual"
	else
		log_info "[DRY-RUN] Would apply $target and restart epwx-azbit-bot through scripts/start-azbit.sh."
	fi
}

main() {
	local action="${1:-}"
	local option="${2:-}"
	local mode="dry-run"

	if [[ "$action" == "-h" || "$action" == "--help" || -z "$action" ]]; then
		usage
		[[ -n "$action" ]] && exit 0 || exit 1
	fi
	if [[ "$option" == "--apply" ]]; then
		mode="apply"
	elif [[ -n "$option" && "$option" != "--dry-run" ]]; then
		log_error "Unsupported option: $option"
		usage
		exit 1
	fi

	ensure_file_exists "$ENV_FILE"
	ensure_file_exists "$(profile_file "$PROFILE_NORMAL")"
	ensure_file_exists "$(profile_file "$PROFILE_DISLOCATED")"
	ensure_file_exists "$(profile_file "$PROFILE_SELL_ONLY")"

	if [[ "$action" == "--auto" ]]; then
		auto_switch "$mode"
		return
	fi
	if ! is_supported_profile "$action"; then
		log_error "Unsupported profile: $action"
		usage
		exit 1
	fi
	manual_switch "$action" "$mode"
}

main "$@"