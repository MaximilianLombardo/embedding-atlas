#!/usr/bin/env bash
#
# Launch the embedding-atlas viewer in development: the Python backend
# (DuckDB + Mosaic, with chat + MCP) and the vite frontend, together.
# vite.config.js proxies /data and /mcp to the backend, so the dev
# frontend talks to a real dataset over HTTP (and the chat MCP socket).
#
# Usage:
#   ./scripts/dev.sh [DATASET]
#
# Config via env (all optional — defaults target the bundled DEMO dataset):
#   DATASET       Path or URL of the dataset to load.
#                 Default: the demo papers atlas (~1.8k rows). Point this at the
#                 real dataset when you have it:  DATASET=/path/to/real.parquet ./scripts/dev.sh
#   TEXT_COL      Text column.                      Default: text
#   X_COL Y_COL   Precomputed projection columns.   Default: umap_x / umap_y
#                 Set both empty to compute a projection instead:  X_COL= Y_COL= ./scripts/dev.sh
#   BACKEND_PORT  Backend port (vite proxy reads it). Default: 5055
#   NO_CHAT=1     Disable the chat + MCP endpoints.
#
# Ctrl-C stops both processes.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
backend_dir="$repo_root/packages/backend"

# --- config (env/arg overridable) ------------------------------------------
DATASET="${1:-${DATASET:-$HOME/Documents/dev/hackathon-2026/data/atlas.parquet}}"
TEXT_COL="${TEXT_COL:-text}"
X_COL="${X_COL-umap_x}"
Y_COL="${Y_COL-umap_y}"
BACKEND_PORT="${BACKEND_PORT:-5055}"
export BACKEND_PORT   # vite.config.js proxy target

proj_flags=()
if [[ -n "$X_COL" && -n "$Y_COL" ]]; then
  proj_flags=(--x "$X_COL" --y "$Y_COL")   # use precomputed coords, skip UMAP
fi

chat_flags=(--chat --mcp)
[[ -n "${NO_CHAT:-}" ]] && chat_flags=()

if [[ ! -e "$DATASET" && "$DATASET" != http* ]]; then
  echo "✗ dataset not found: $DATASET" >&2
  echo "  Pass one explicitly:  ./scripts/dev.sh /path/to/data.parquet" >&2
  exit 1
fi

echo "▶ dataset : $DATASET"
echo "▶ columns : text=$TEXT_COL${proj_flags:+  x=$X_COL y=$Y_COL}"
echo "▶ backend : http://localhost:$BACKEND_PORT  (${chat_flags[*]:-no chat})"
echo "▶ frontend: http://localhost:5173/"

# Load the API key (.env) so chat returns real answers, not the echo fallback.
if [[ -f "$backend_dir/.env" ]]; then
  set -a; . "$backend_dir/.env"; set +a
fi

# Backend in the background; tear it down when this script exits.
(
  cd "$backend_dir"
  exec uv run embedding-atlas "$DATASET" \
    --text "$TEXT_COL" "${proj_flags[@]}" \
    --port "$BACKEND_PORT" "${chat_flags[@]}"
) &
backend_pid=$!
trap 'kill "$backend_pid" 2>/dev/null || true' EXIT INT TERM

# Frontend in the foreground — Ctrl-C here stops both via the trap.
npm run dev -w @embedding-atlas/viewer
