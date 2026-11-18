import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
const script = resolve(import.meta.dir, "../scripts/mac-production-switch.sh");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function run(command: string[], cwd?: string) {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")}\n${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function executable(path: string, contents: string) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "noop-mac-switch-"));
  roots.push(root);
  const repo = join(root, "production");
  const remote = join(root, "remote.git");
  const hub = join(root, "hub");
  const bin = join(root, "bin");
  const cache = join(root, "cache");
  const state = join(root, "state");
  mkdirSync(repo);
  mkdirSync(bin);
  mkdirSync(state);
  mkdirSync(join(hub, "fleet/hosts"), { recursive: true });

  run(["git", "init", "-q"], repo);
  run(["git", "config", "user.email", "fixture@example.invalid"], repo);
  run(["git", "config", "user.name", "Fixture"], repo);
  writeFileSync(join(repo, "version.txt"), "rollback\n");
  run(["git", "add", "version.txt"], repo);
  run(["git", "commit", "-qm", "rollback"], repo);
  const rollback = run(["git", "rev-parse", "HEAD"], repo);
  writeFileSync(join(repo, "version.txt"), "target\n");
  run(["git", "commit", "-qam", "target"], repo);
  const target = run(["git", "rev-parse", "HEAD"], repo);
  const targetTree = run(["git", "rev-parse", `${target}^{tree}`], repo);
  run(["git", "init", "--bare", "-q", remote]);
  run(["git", "remote", "add", "fork", remote], repo);
  run(["git", "push", "-q", "fork", `${target}:refs/heads/deploy-test`], repo);
  run(["git", "reset", "--hard", rollback], repo);

  writeFileSync(join(state, "pid"), "101\n");
  writeFileSync(join(hub, "fleet/hosts/mac.json"), JSON.stringify({ rev: rollback }));
  writeFileSync(join(hub, "fleet/hosts/peer.json"), JSON.stringify({ rev: target }));
  writeFileSync(join(state, "bun.log"), "");

  executable(join(bin, "launchctl"), `#!/bin/zsh
[[ "$1" == "print" && -f "$FAKE_STATE/pid" ]] || exit 1
print -- "{"
print -- "    state = running"
print -- "    pid = $(cat "$FAKE_STATE/pid")"
print -- "}"
`);
  executable(join(bin, "bun"), `#!/bin/zsh
print -r -- "$*" >> "$FAKE_STATE/bun.log"
if [[ "$*" == *"restart --force"* ]]; then
  [[ "\${FAKE_KEEP_PID:-0}" == "1" ]] || print -- "202" > "$FAKE_STATE/pid"
  [[ "\${FAKE_KEEP_HEARTBEAT:-0}" == "1" ]] || print -r -- "{\\"rev\\":\\"$NOOP_DEPLOY_TARGET\\"}" > "$NOOP_DEPLOY_HUB_DATA/fleet/hosts/mac.json"
  exit 0
fi
if [[ "\${FAKE_FAIL_TESTS:-0}" == "1" && "$*" == *" test"* ]]; then
  exit 42
fi
exit 0
`);
  executable(join(bin, "caffeinate"), `#!/bin/zsh
while [[ "$1" == -* ]]; do shift; done
exec "$@"
`);
  executable(join(bin, "sleep"), "#!/bin/zsh\nexit 0\n");

  const env = {
    ...process.env,
    FAKE_STATE: state,
    NOOP_DEPLOY_PRODUCTION_REPO: repo,
    NOOP_DEPLOY_HUB_DATA: hub,
    NOOP_DEPLOY_TARGET: target,
    NOOP_DEPLOY_TARGET_TREE: targetTree,
    NOOP_DEPLOY_ROLLBACK: rollback,
    NOOP_DEPLOY_BRANCH: "deploy-test",
    NOOP_DEPLOY_REMOTE: "fork",
    NOOP_DEPLOY_HOST_NAME: "mac",
    NOOP_DEPLOY_PEER_NAME: "peer",
    NOOP_DEPLOY_BUN_CACHE: cache,
    NOOP_DEPLOY_POLL_ATTEMPTS: "2",
    NOOP_DEPLOY_POLL_SECONDS: "0",
    NOOP_DEPLOY_BUN_BIN: join(bin, "bun"),
    NOOP_DEPLOY_LAUNCHCTL_BIN: join(bin, "launchctl"),
    NOOP_DEPLOY_CAFFEINATE_BIN: join(bin, "caffeinate"),
    NOOP_DEPLOY_SLEEP_BIN: join(bin, "sleep"),
  };

  return {
    root, repo, hub, state, rollback, target, targetTree, env,
    head: () => run(["git", "rev-parse", "HEAD"], repo),
    execute: (overrides: Record<string, string> = {}) => Bun.spawnSync(["zsh", script], {
      env: { ...env, ...overrides }, stdout: "pipe", stderr: "pipe",
    }),
  };
}

test("switches only to the exact target and waits for a new LaunchAgent PID plus both heartbeats", () => {
  const f = fixture();
  const result = f.execute();
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain(`T-D0082_DEPLOYED ${f.target} mac_pid=202`);
  expect(f.head()).toBe(f.target);
  expect(JSON.parse(readFileSync(join(f.hub, "fleet/hosts/mac.json"), "utf8")).rev).toBe(f.target);
  expect(readFileSync(join(f.state, "bun.log"), "utf8")).toContain("restart --force");
}, 30_000);

test("rejects a remote target mismatch before changing the checkout", () => {
  const f = fixture();
  const result = f.execute({ NOOP_DEPLOY_TARGET: "0".repeat(40) });
  expect(result.exitCode).not.toBe(0);
  expect(f.head()).toBe(f.rollback);
  expect(readFileSync(join(f.state, "bun.log"), "utf8")).toBe("");
}, 30_000);

test("rejects a target tree mismatch before changing the checkout", () => {
  const f = fixture();
  const result = f.execute({ NOOP_DEPLOY_TARGET_TREE: "0".repeat(40) });
  expect(result.exitCode).not.toBe(0);
  expect(f.head()).toBe(f.rollback);
  expect(readFileSync(join(f.state, "bun.log"), "utf8")).toBe("");
}, 30_000);

test("restores the rollback commit when validation fails after the fast-forward", () => {
  const f = fixture();
  const result = f.execute({ FAKE_FAIL_TESTS: "1" });
  expect(result.exitCode).toBe(42);
  expect(result.stderr.toString()).toContain(`validation failed; restoring ${f.rollback}`);
  expect(f.head()).toBe(f.rollback);
  expect(readFileSync(join(f.repo, "version.txt"), "utf8")).toBe("rollback\n");
}, 30_000);

test("requires a running LaunchAgent with a safe numeric PID before mutation", () => {
  const f = fixture();
  unlinkSync(join(f.state, "pid"));
  const result = f.execute();
  expect(result.exitCode).not.toBe(0);
  expect(f.head()).toBe(f.rollback);
  expect(readFileSync(join(f.state, "bun.log"), "utf8")).toBe("");
}, 30_000);

test("does not report success when restart keeps the same LaunchAgent PID", () => {
  const f = fixture();
  const result = f.execute({ FAKE_KEEP_PID: "1" });
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout.toString()).not.toContain("T-D0082_DEPLOYED");
  expect(f.head()).toBe(f.target);
}, 30_000);

test("does not report success until both host heartbeat revisions match", () => {
  const f = fixture();
  writeFileSync(join(f.hub, "fleet/hosts/peer.json"), JSON.stringify({ rev: f.rollback }));
  const result = f.execute();
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout.toString()).not.toContain("T-D0082_DEPLOYED");
  expect(f.head()).toBe(f.target);
}, 30_000);
