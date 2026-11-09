#!/usr/bin/env bash
# One dispatcher pass with the defaults, against the branch checked out in the current directory.
#   .sandcastle/dispatch.sh [--dry-run] [--max N] [--whole-issues]
# Extra arguments go to dispatch.mts. Checks the tools, logins and .sandcastle/.env first (which ones
# follows TRACKER.kind and AGENT.provider in config.mts: glab or gh, claude or pi), then the image: from a
# terminal a missing or mismatched image is built; without one (the timer) the pass stops and says
# how to build it, so a background pass never starts a long build.
set -euo pipefail
# Same run-state folder as the timer and the board service, so hand-started passes show on the board.
export SANDCASTLE_STATE_DIR="${SANDCASTLE_STATE_DIR:-$HOME/.local/state/sandcastle}"

fail() { echo "dispatch.sh: $*" >&2; exit 1; }

root="$(git rev-parse --show-toplevel 2>/dev/null)" || fail "not inside a git repository."
cd "$root"
[ -f .sandcastle/dispatch.mts ] || fail "no .sandcastle/dispatch.mts in $root."

base="$(git branch --show-current)"
[ -n "$base" ] || fail "detached HEAD. Check out the integration branch first."
git ls-remote --exit-code --heads origin "$base" >/dev/null || fail "branch $base isn't on origin. Push it, or check out the integration branch."

# Read from the project's own config so the checks match what the runs use. A config without these
# fields is the GitLab + Claude Code one.
cfg_value() { sed -nE "s/^[[:space:]]*$1:[[:space:]]*\"([^\"]+)\".*/\\1/p" .sandcastle/config.mts | head -n 1; }
kind="$(cfg_value kind)"; kind="${kind:-gitlab}"
agent="$(cfg_value provider)"; agent="${agent:-claude}"
image="$(sed -nE 's/^[[:space:]]*image:[[:space:]]*"([^"]+)".*/\1/p' .sandcastle/main.mts | head -n 1)"
[ -n "$image" ] || fail "couldn't read CONFIG.image from .sandcastle/main.mts."
case "$kind" in gitlab) tracker_cli=glab ;; github) tracker_cli=gh ;; *) fail "unknown TRACKER.kind \"$kind\" in .sandcastle/config.mts." ;; esac
case "$agent" in claude | pi) ;; *) fail "unknown AGENT.provider \"$agent\" in .sandcastle/config.mts." ;; esac

for tool in node npm npx git "$tracker_cli" "$agent" docker curl; do
  command -v "$tool" >/dev/null || fail "$tool isn't on the PATH."
done

if [ "$kind" = gitlab ]; then
  host="$(cfg_value gitlabHost)"
  [ -n "$host" ] || fail "couldn't read TRACKER.gitlabHost from .sandcastle/config.mts."
  glab auth status --hostname "$host" >/dev/null 2>&1 || fail "glab isn't logged in to $host. Run: glab auth login --hostname $host"
else
  host="$(cfg_value host)"; host="${host:-github.com}"
  gh auth status --hostname "$host" >/dev/null 2>&1 || fail "gh isn't logged in to $host. Run: gh auth login --hostname $host"
fi
# The ticket analysis runs this agent on the host with its own login (with pi, so do the container runs).
if [ "$agent" = claude ]; then
  claude auth status 2>/dev/null | grep -q '"loggedIn": *true' || fail "claude isn't logged in. Run: claude auth login"
else
  pi auth check --provider openai >/dev/null 2>&1 || fail "pi has no working OpenAI login. Run pi, then /login, and pick Sign in with ChatGPT."
fi
docker info >/dev/null 2>&1 || fail "Docker isn't running, or this user can't reach it."

# Claude Code in the container logs in with .sandcastle/.env, not the host's login. Check the credential
# with an empty Messages request: a bad one gets 401, a good one 400. No tokens are used, and the value is
# never printed or put on a command line. Pi needs nothing here: each run gets a fresh token from the
# host's pi login, checked above.
env_file=.sandcastle/.env
[ -f "$env_file" ] || fail "no $env_file. Run: cp .sandcastle/.env.example $env_file, then fill it in."
if [ "$agent" = claude ]; then
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
fi

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

# The pass imports @ai-hero/sandcastle from the project's node_modules. Install when it's missing or
# older than the lockfile; quick enough to run under the timer too.
if [ ! -d node_modules/@ai-hero/sandcastle ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "node dependencies missing or out of date; installing."
  if [ -f package-lock.json ]; then npm ci; else npm install; fi
fi

exec node .sandcastle/dispatch.mts --base "$base" "$@"
