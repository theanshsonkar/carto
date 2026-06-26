#!/usr/bin/env bash
#
# bench/swe-bench/run.sh — operator entry point for the harness.
#
# Forwards every flag to harness.js. Kept as a separate shell script
# because Spec 21 mentions run.sh by name, and because some operator
# muscle memory expects `./run.sh` rather than a long node command.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "${SCRIPT_DIR}/harness.js" "$@"
