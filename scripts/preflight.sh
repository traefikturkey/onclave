#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
readonly PACKAGE_JSON="$REPO_ROOT/package.json"
readonly WORKSPACE_FILE="$REPO_ROOT/pnpm-workspace.yaml"
readonly RECOMMENDED_NODE_MAJOR=24

failures=0
warnings=0
expected_pnpm_version=""
expected_pnpm_major=""

usage() {
    cat <<EOF
Usage: bash ./scripts/preflight.sh

Runs bootstrap environment checks without requiring Node.js.
EOF
}

status_line() {
    local status="$1"
    local name="$2"
    local details="$3"
    printf '%s %s: %s\n' "$status" "$name" "$details"
}

hint_line() {
    local hint="$1"
    printf '    hint: %s\n' "$hint"
}

command_exists() {
    command -v "$1" >/dev/null 2>&1
}

command_path() {
    command -v "$1" 2>/dev/null || true
}

command_version() {
    local command_name="$1"
    "$command_name" --version 2>&1 | head -n 1 | tr -d '\r'
}

load_pnpm_policy() {
    local package_manager_spec
    package_manager_spec="$({ grep -Eo '"packageManager"[[:space:]]*:[[:space:]]*"pnpm@[^"]+"' "$PACKAGE_JSON" || true; } | head -n 1)"
    if [[ -z "$package_manager_spec" ]]; then
        expected_pnpm_version=""
        expected_pnpm_major=""
        return
    fi

    expected_pnpm_version="$(printf '%s\n' "$package_manager_spec" | sed -E 's/.*"pnpm@([^"]+)".*/\1/')"
    expected_pnpm_major="${expected_pnpm_version%%.*}"
}

check_node() {
    if ! command_exists node; then
        status_line "FAIL" "node" "not found on PATH"
        hint_line "Install Node.js ${RECOMMENDED_NODE_MAJOR}.x before running repo commands."
        failures=$((failures + 1))
        return
    fi

    local version major
    version="$(command_version node | sed -E 's/^v//')"
    major="${version%%.*}"

    if [[ "$major" == "$RECOMMENDED_NODE_MAJOR" ]]; then
        status_line "PASS" "node" "found $version (matches the current validated major ${RECOMMENDED_NODE_MAJOR}.x)"
        return
    fi

    status_line "WARN" "node" "found $version (the repo is currently validated most directly on ${RECOMMENDED_NODE_MAJOR}.x)"
    warnings=$((warnings + 1))
}

check_pnpm() {
    if ! command_exists pnpm; then
        status_line "FAIL" "pnpm" "not found on PATH"
        hint_line "Install pnpm ${expected_pnpm_major:-10}.x and rerun this preflight."
        failures=$((failures + 1))
        return
    fi

    local path version major
    path="$(command_path pnpm)"
    version="$(command_version pnpm)"
    major="${version%%.*}"

    if [[ -n "$expected_pnpm_major" && "$major" != "$expected_pnpm_major" ]]; then
        status_line "FAIL" "pnpm" "found at $path ($version; expected pnpm ${expected_pnpm_major}.x from packageManager ${expected_pnpm_version})"
        hint_line "Use pnpm ${expected_pnpm_major}.x for this workspace."
        failures=$((failures + 1))
        return
    fi

    if [[ -n "$expected_pnpm_version" && "$version" != "$expected_pnpm_version" ]]; then
        status_line "WARN" "pnpm" "found at $path ($version; root packageManager pins ${expected_pnpm_version})"
        hint_line "Prefer pnpm ${expected_pnpm_version} or another ${expected_pnpm_major}.x release for consistent installs."
        warnings=$((warnings + 1))
        return
    fi

    status_line "PASS" "pnpm" "found at $path ($version)"
}

check_required_command() {
    local command_name="$1"
    local required_label="$2"
    local missing_hint="$3"

    if ! command_exists "$command_name"; then
        status_line "$required_label" "$command_name" "not found on PATH"
        hint_line "$missing_hint"
        if [[ "$required_label" == "FAIL" ]]; then
            failures=$((failures + 1))
        else
            warnings=$((warnings + 1))
        fi
        return
    fi

    status_line "PASS" "$command_name" "found at $(command_path "$command_name") ($(command_version "$command_name"))"
}

check_repo_files() {
    if [[ -d "$REPO_ROOT/node_modules" ]]; then
        status_line "PASS" "dependencies" "node_modules directory is present"
    else
        status_line "WARN" "dependencies" "dependencies do not appear to be installed yet"
        hint_line "Run just setup or pnpm install after bootstrap preflight succeeds."
        warnings=$((warnings + 1))
    fi

    if [[ -f "$WORKSPACE_FILE" ]]; then
        status_line "PASS" "workspace" "found pnpm-workspace.yaml"
    else
        status_line "FAIL" "workspace" "missing pnpm-workspace.yaml"
        hint_line "Restore the workspace manifest before adding or installing packages."
        failures=$((failures + 1))
    fi
}

print_next_steps() {
    echo
    echo "Next steps:"
    if (( failures > 0 )); then
        if ! command_exists node; then
            echo "- Install Node.js ${RECOMMENDED_NODE_MAJOR}.x first."
        fi
        if ! command_exists pnpm; then
            echo "- Install pnpm ${expected_pnpm_major:-10}.x so workspace commands can run."
        fi
        if ! command_exists just; then
            echo "- Install just so you can use the repo command surface from justfile."
        fi
    fi
    if [[ ! -d "$REPO_ROOT/node_modules" ]]; then
        echo "- Run just setup or pnpm install once the required tools are available."
    fi
    echo "- After bootstrap passes, run just preflight-repo or pnpm run preflight:repo for the Node-based repo check."
    echo "- Run just check before handing off code changes."
    echo "- Run just pi-local when you need to load the Onclave extension in Pi."
}

main() {
    if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
        usage
        exit 0
    fi

    load_pnpm_policy

    echo "Onclave bootstrap preflight"
    echo
    echo "Repo root: $REPO_ROOT"
    echo

    check_node
    check_pnpm
    check_required_command just "FAIL" "Install just so you can use the repo command surface from justfile."
    check_required_command git "FAIL" "Install git so repository workflows and project label detection work."
    check_required_command pi "WARN" "Install Pi to run local extension loading and Onclave smoke checks."
    check_repo_files
    print_next_steps

    if (( failures > 0 )); then
        exit 1
    fi
}

main "$@"
