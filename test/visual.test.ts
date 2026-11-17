import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

function noop(home: string, args: string[]) {
  return Bun.spawnSync([process.execPath, "src/cli.ts", "visual", ...args], {
    cwd: root,
    env: { ...process.env, NOOP_HOME: home, HUB_NO_MEDIC: "1" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
}

test("visual verification is observable and fail closed", () => {
  const home = mkdtempSync(join(tmpdir(), "noop-visual-"));
  expect(noop(home, ["start", "candidate", "--target", "Teacher Doc Studio"]).exitCode).toBe(0);
  const pending = noop(home, ["verify", "candidate"]);
  expect(pending.exitCode).toBe(42);
  expect(pending.stdout.toString()).toContain("Fresh Computer Use approval is required");

  expect(noop(home, ["run", "candidate", "--", "/bin/sleep", "30"]).exitCode).toBe(0);
  expect(noop(home, ["observe", "candidate", "authorization", "ok", "target handle returned"]).exitCode).toBe(0);
  expect(noop(home, ["observe", "candidate", "window", "ok", "main window visible"]).exitCode).toBe(0);
  expect(noop(home, ["observe", "candidate", "capture", "ok", "screenshot returned"]).exitCode).toBe(0);
  expect(noop(home, ["observe", "candidate", "action", "ok", "created synthetic task"]).exitCode).toBe(0);

  const ready = noop(home, ["verify", "candidate"]);
  expect(ready.exitCode).toBe(0);
  const report = JSON.parse(ready.stdout.toString());
  expect(report.ready).toBe(true);
  expect(report.processes[0].alive).toBe(true);
  expect(report.lastSuccess.action).toBe("created synthetic task");

  expect(noop(home, ["stop", "candidate"]).exitCode).toBe(0);
  const final = JSON.parse(readFileSync(join(home, "visual", "candidate", "final.json"), "utf8"));
  expect(final.target.authorization).toBe("approved");
  expect(final.window.status).toBe("visible");
});

test("visual run surfaces an early process exit and recovery", () => {
  const home = mkdtempSync(join(tmpdir(), "noop-visual-exit-"));
  expect(noop(home, ["start", "failed", "--target", "Broken App"]).exitCode).toBe(0);
  expect(noop(home, ["run", "failed", "--", "/bin/sh", "-c", "echo launch-failed >&2; exit 7"]).exitCode).toBe(0);
  const status = JSON.parse(noop(home, ["status", "failed"]).stdout.toString());
  expect(status.processes[0].alive).toBe(false);
  expect(status.processes[0].logTail).toContain("launch-failed");
  expect(status.blocker).toContain("Fresh Computer Use approval");
  expect(status.lastFailure.recovery).toContain("rerun noop visual run failed");
  expect(noop(home, ["stop", "failed"]).exitCode).toBe(0);
});
