#!/usr/bin/env bash
# Mirror the running site directory into the GitHub repository.
#
# The site the platform serves is /home/team/shared/site; the repository is
# vishalkhanapure411-art/OmniHost.ai. This script is the only supported way to move
# code between them, so the two cannot silently drift: the repo copy is always a
# byte-for-byte mirror of everything under the site directory except build output,
# installed dependencies, local runtime state, and the PRD (which lives only in the
# repo, in Documentation/).
#
#   ./scripts/sync-to-repo.sh [branch]      # default branch: phase-0a-foundation
#
# Environment:
#   OMNIHOST_REPO_DIR   where to keep the clone (default: $HOME/work/OmniHost.ai)
#   GH_TOKEN            if set, the script also opens/updates a pull request
set -euo pipefail

SITE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_URL="https://github.com/vishalkhanapure411-art/OmniHost.ai.git"
REPO_DIR="${OMNIHOST_REPO_DIR:-$HOME/work/OmniHost.ai}"
BRANCH="${1:-phase-0a-foundation}"
BASE_BRANCH="${OMNIHOST_BASE_BRANCH:-main}"

echo "site   -> $SITE_DIR"
echo "repo   -> $REPO_DIR (branch $BRANCH, base $BASE_BRANCH)"

if [ ! -d "$REPO_DIR/.git" ]; then
  git clone "$REPO_URL" "$REPO_DIR"
fi

cd "$REPO_DIR"
git fetch origin --prune
git checkout -B "$BRANCH" "origin/$BASE_BRANCH"

# Mirror. --delete removes files the site no longer has, which is what makes the repo
# a mirror rather than an ever-growing union. Excluded paths are protected from
# deletion as well as from copying, so Documentation/ (repo-only) survives.
rsync -a --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.run' \
  --exclude '.tanstack' \
  --exclude '.output' \
  --exclude '.vercel' \
  --exclude '.cache' \
  --exclude 'dist' \
  --exclude 'src/routeTree.gen.ts' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude 'Documentation' \
  --exclude 'README.md' \
  "$SITE_DIR"/ "$REPO_DIR"/

git add -A
if git diff --cached --quiet; then
  echo "repo already mirrors the site; nothing to commit"
else
  git commit -m "${OMNIHOST_COMMIT_MESSAGE:-Sync OmniHost.ai app source from the team site}"
fi
git push -u origin "$BRANCH"

if [ -n "${GH_TOKEN:-}" ]; then
  gh pr create --repo vishalkhanapure411-art/OmniHost.ai \
    --base "$BASE_BRANCH" --head "$BRANCH" \
    --title "${OMNIHOST_PR_TITLE:-OmniHost.ai Phase 0a — platform foundation}" \
    --body "${OMNIHOST_PR_BODY:-Phase 0a: schema and migrations, server-side RBAC, audit log, app shell, AppAdmin chain slice.}" \
    || echo "PR already open for $BRANCH"
fi
echo "synced $SITE_DIR -> $REPO_DIR ($BRANCH)"
