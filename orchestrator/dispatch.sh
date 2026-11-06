#!/usr/bin/env bash
# One dispatcher pass with the defaults, against the branch checked out in the current directory.
#   .sandcastle/dispatch.sh [--dry-run] [--max N] [--whole-issues]
# Extra arguments go to dispatch.mts. Checks the tools, logins and .sandcastle/.env first, then the image: from a
# terminal a missing or mismatched image is built; without one (the timer) the pass stops and says
# how to build it, so a background pass never starts a long build.
set -euo pipefail

fail() { echo "dispatch.sh: $*" >&2; exit 1; }

root="$(git rev-parse --show-toplevel 2>/dev/null)" || fail "not inside a git repository."
cd "$root"
[ -f .sandcastle/dispatch.mts ] || fail "no .sandcastle/dispatch.mts in $root."

base="$(git branch --show-current)"
[ -n "$base" ] || fail "detached HEAD. Check out the integration branch first."
git ls-remote --exit-code --heads origin "$base" >/dev/null || fail "branch $base isn't on origin. Push it, or check out the integration branch."

for tool in node npx git glab claude docker curl; do
  command -v "$tool" >/dev/null || fail "$tool isn't on the PATH."
done

# Read from the project's own config so the checks match what the runs use.
host="$(sed -nE 's/^[[:space:]]*gitlabHost:[[:space:]]*"([^"]+)".*/\1/p' .sandcastle/config.mts | head -n 1)"
image="$(sed -nE 's/^[[:space:]]*image:[[:space:]]*"([^"]+)".*/\1/p' .sandcastle/main.mts | head -n 1)"
[ -n "$host" ] || fail "couldn't read TRACKER.gitlabHost from .sandcastle/config.mts."
[ -n "$image" ] || fail "couldn't read CONFIG.image from .sandcastle/main.mts."

glab auth status --hostname "$host" >/dev/null 2>&1 || fail "glab isn't logged in to $host. Run: glab auth login --hostname $host"
claude auth status 2>/dev/null | grep -q '"loggedIn": *true' || fail "claude isn't logged in. Run: claude auth login"
docker info >/dev/null 2>&1 || fail "Docker isn't running, or this user can't reach it."

# The agent in the container logs in with .sandcastle/.env, not the host's claude login. Check the
# credential with an empty Messages request: a bad one gets 401, a good one 400. No tokens are used,
# and the value is never printed or put on a command line.
env_file=.sandcastle/.env
[ -f "$env_file" ] || fail "no $env_file. Run: cp .sandcastle/.env.example $env_file, then fill it in."
env_value() { sed -nE "s/^[[:space:]]*(export[[:space:]]+)?$1=[\"']?([^\"'#[:space:]]*).*/\2/p" "$env_file" | tail -n 1; }
if token="$(env_value CLAUDE_CODE_OAUTH_TOKEN)" && [ -n "$token" ]; then
  key_name=CLAUDE_CODE_OAUTH_TOKEN
  auth_header="Authorization: Bearer $token"
elif token="$(env_value ANTHROPIC_API_KEY)" && [ -n "$token" ]; then
  key_name=ANTHROPIC_API_KEY
  auth_header="x-api-key: $token"
else
  fail "CLAUDE_CODE_OAUTH_TOKEN in $env_file is empty. Run: claude setup-token, and paste the token there."
fi
status="$(printf '%s\n' "$auth_header" | curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -H @- \
  -H 'anthropic-version: 2023-06-01' -H 'anthropic-beta: oauth-2025-04-20' -H 'content-type: application/json' \
  -d '{}' https://api.anthropic.com/v1/messages)" || fail "couldn't reach api.anthropic.com to check $key_name."
unset token auth_header
case "$status" in
  401 | 403) fail "$key_name in $env_file was rejected. For a new token run: claude setup-token" ;;
  400 | 200) ;;
  *) fail "checking $key_name got HTTP $status from api.anthropic.com. Try again shortly." ;;
esac

# Sandcastle runs the container as this user, and refuses an image built for another UID.
problem=""
if ! user="$(docker image inspect "$image" --format '{{.Config.User}}' 2>/dev/null)"; then
  problem="image $image doesn't exist"
elif [ -n "$user" ] && [ "${user%%:*}" != "$(id -u)" ]; then
  problem="image $image was built for UID ${user%%:*}, not $(id -u)"
fi
if [ -n "$problem" ]; then
  build="npx sandcastle docker build-image --image-name $image"
  [ -t 0 ] || fail "$problem. Build it from a terminal in $root: $build"
  echo "$problem; building it (takes a few minutes)."
  $build
fi

exec node .sandcastle/dispatch.mts --base "$base" "$@"
