#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

PRIMARY_REMOTE="gitee"
SECONDARY_REMOTE="origin"
BRANCH="main"

# Ensure repo
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "[publish] ERROR: not a git repository"
  exit 1
fi

# Ensure primary remote exists
if ! git remote get-url "$PRIMARY_REMOTE" >/dev/null 2>&1; then
  echo "[publish] ERROR: remote '$PRIMARY_REMOTE' not found. Add it first:"
  echo "  git remote add gitee https://gitee.com/jialeyang1106/snake-mp.git"
  exit 1
fi

# Stage changes
git add -A

# Commit only if there are staged changes
if git diff --cached --quiet; then
  echo "[publish] No changes to commit. Pushing anyway…"
else
  MSG="${1:-update $(date +'%F %T')}"
  git commit -m "$MSG"
fi

# Push

git push "$PRIMARY_REMOTE" "$BRANCH"

# Best-effort push to secondary remote (e.g. GitHub)
if git remote get-url "$SECONDARY_REMOTE" >/dev/null 2>&1; then
  echo "[publish] Also pushing to $SECONDARY_REMOTE…"
  git push "$SECONDARY_REMOTE" "$BRANCH" || echo "[publish] WARN: push to $SECONDARY_REMOTE failed (ignored)."
fi

echo "[publish] Done. VPS should auto-update within ~1 minute."
