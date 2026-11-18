#!/bin/zsh
set -euo pipefail

readonly production_repo="${NOOP_DEPLOY_PRODUCTION_REPO:-/Users/dudu008/.noop/app}"
readonly hub_data="${NOOP_DEPLOY_HUB_DATA:-/Users/dudu008/.noop/data}"
readonly target="${NOOP_DEPLOY_TARGET:-54a456aa19456a2395c3502b49c844f01d4ba82f}"
readonly target_tree="${NOOP_DEPLOY_TARGET_TREE:-e2afa5023943dee2ec860bf8b697800d259b0b24}"
readonly rollback="${NOOP_DEPLOY_ROLLBACK:-c231331a8d07357c08544088d4e19f8fb1198b86}"
readonly branch="${NOOP_DEPLOY_BRANCH:-codex/shield-primary-policy}"
readonly remote="${NOOP_DEPLOY_REMOTE:-fork}"
readonly host_name="${NOOP_DEPLOY_HOST_NAME:-dudu008deMacBook-Pro}"
readonly peer_name="${NOOP_DEPLOY_PEER_NAME:-darcy}"
readonly launchagent_label="${NOOP_DEPLOY_LAUNCHAGENT_LABEL:-dev.noop.daemon}"
readonly bun_cache="${NOOP_DEPLOY_BUN_CACHE:-/Volumes/DevDrive/Developer/Caches/bun/T-D0082}"
readonly poll_attempts="${NOOP_DEPLOY_POLL_ATTEMPTS:-60}"
readonly poll_seconds="${NOOP_DEPLOY_POLL_SECONDS:-3}"
readonly git_bin="${NOOP_DEPLOY_GIT_BIN:-git}"
readonly bun_bin="${NOOP_DEPLOY_BUN_BIN:-bun}"
readonly node_bin="${NOOP_DEPLOY_NODE_BIN:-node}"
readonly launchctl_bin="${NOOP_DEPLOY_LAUNCHCTL_BIN:-launchctl}"
readonly caffeinate_bin="${NOOP_DEPLOY_CAFFEINATE_BIN:-/usr/bin/caffeinate}"
readonly sleep_bin="${NOOP_DEPLOY_SLEEP_BIN:-sleep}"

switched=0
validated=0

heartbeat_rev() {
  "${node_bin}" -e 'const fs=require("fs"); try { console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).rev ?? ""); } catch {}' "$1"
}

launchagent_pid() {
  "${launchctl_bin}" print "gui/${UID}/${launchagent_label}" 2>/dev/null | awk '/^[[:space:]]*pid = / {print $3; exit}'
}

valid_pid() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

rollback_on_error() {
  local exit_code=$?
  if (( switched == 1 && validated == 0 )); then
    print -u2 -- "validation failed; restoring ${rollback}"
    "${git_bin}" -C "${production_repo}" reset --hard "${rollback}" || true
    BUN_INSTALL_CACHE_DIR="${bun_cache}" "${bun_bin}" --cwd "${production_repo}" install --frozen-lockfile || true
  fi
  exit "${exit_code}"
}
trap rollback_on_error ERR

[[ "$("${git_bin}" -C "${production_repo}" rev-parse HEAD)" == "${rollback}" ]]
[[ -z "$("${git_bin}" -C "${production_repo}" status --porcelain)" ]]

old_pid="$(launchagent_pid)"
valid_pid "${old_pid}"

remote_target="$("${git_bin}" -C "${production_repo}" ls-remote --exit-code "${remote}" "refs/heads/${branch}" | awk '{print $1}')"
[[ "${remote_target}" == "${target}" ]]

"${git_bin}" -C "${production_repo}" fetch --prune "${remote}" "${branch}"
[[ "$("${git_bin}" -C "${production_repo}" rev-parse "refs/remotes/${remote}/${branch}")" == "${target}" ]]
[[ "$("${git_bin}" -C "${production_repo}" rev-parse "${target}^{tree}")" == "${target_tree}" ]]
"${git_bin}" -C "${production_repo}" merge-base --is-ancestor "${rollback}" "${target}"

"${git_bin}" -C "${production_repo}" merge --ff-only "${target}"
switched=1
[[ "$("${git_bin}" -C "${production_repo}" rev-parse HEAD)" == "${target}" ]]
[[ -z "$("${git_bin}" -C "${production_repo}" status --porcelain)" ]]

mkdir -p "${bun_cache}"
BUN_INSTALL_CACHE_DIR="${bun_cache}" "${bun_bin}" --cwd "${production_repo}" install --frozen-lockfile
"${caffeinate_bin}" -is "${bun_bin}" --cwd "${production_repo}" test
"${bun_bin}" --cwd "${production_repo}" x tsc --noEmit
"${bun_bin}" --cwd "${production_repo}" test test/computer-use-recovery.test.ts
[[ -z "$("${git_bin}" -C "${production_repo}" status --porcelain)" ]]
validated=1
trap - ERR

"${bun_bin}" "${production_repo}/src/cli.ts" restart --force

for (( attempt = 1; attempt <= poll_attempts; attempt++ )); do
  "${sleep_bin}" "${poll_seconds}"
  mac_rev="$(heartbeat_rev "${hub_data}/fleet/hosts/${host_name}.json")"
  new_pid="$(launchagent_pid)"
  if [[ "${mac_rev}" == "${target}" ]] && valid_pid "${new_pid}" && [[ "${new_pid}" != "${old_pid}" ]]; then
    break
  fi
done

[[ "$("${git_bin}" -C "${production_repo}" rev-parse HEAD)" == "${target}" ]]
[[ "$(heartbeat_rev "${hub_data}/fleet/hosts/${host_name}.json")" == "${target}" ]]
[[ "$(heartbeat_rev "${hub_data}/fleet/hosts/${peer_name}.json")" == "${target}" ]]

new_pid="$(launchagent_pid)"
valid_pid "${new_pid}"
[[ "${new_pid}" != "${old_pid}" ]]

print -- "T-D0082_DEPLOYED ${target} mac_pid=${new_pid}"
