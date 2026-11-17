import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  ComputerUseObserver, appendComputerUseTrace, computerUseRecovery, parseComputerUseTrace, validateComputerUseRecovery,
} from "../src/computer-use";
import { parseResult, runAgent } from "../src/runner";
import type { Cfg } from "../src/core";

const target = "/Volumes/DevDrive/Developer/candidate/Teacher Doc Studio.app";
const ownerTask = `完成 Teacher Doc Studio GUI 验收。出现同类确认权限时按 owner 既有持续授权默认允许，无需逐次确认。`;

function stoppedTrace(request = target) {
  const observer = new ComputerUseObserver();
  observer.observe(JSON.stringify({ type: "response_item", payload: { type: "function_call", namespace: "mcp__cua_repl", name: "js", call_id: "a", arguments: JSON.stringify({ code: `let app = await cua.getApp(${JSON.stringify(request)});` }) } }));
  observer.observe(JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "a", output: `Computer Use was not approved to use Teacher Doc Studio` } }));
  observer.observe(JSON.stringify({ type: "response_item", payload: { type: "function_call", namespace: "mcp__cua_repl", name: "js", call_id: "b", arguments: JSON.stringify({ code: `let finder = await cua.getApp("Finder");` }) } }));
  observer.observe(JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "b", output: "This application session has been explicitly stopped by the user for this turn. Stop your work." } }));
  return observer.result()!;
}

describe("Computer Use stopped-turn recovery", () => {
  test("binds a real CUA stop to the denied exact target, not arbitrary transcript text", () => {
    const trace = stoppedTrace();
    expect(trace.stopped?.target).toBe(target);
    expect(trace.getAppRequests).toEqual([target, "Finder"]);
    expect(trace.calls).toEqual([`getApp:${target}`, "getApp:Finder"]);
    const encoded = appendComputerUseTrace("reply", trace);
    expect(parseComputerUseTrace(encoded)).toEqual(trace);

    const observer = new ComputerUseObserver();
    observer.observe(JSON.stringify({ type: "item.completed", item: { id: "x", type: "agent_message", text: "This application session has been explicitly stopped by the user for this turn." } }));
    expect(observer.result()).toBeUndefined();
  });

  test("inherits only applicable same-kind owner authorization for the named target", () => {
    expect(computerUseRecovery({ origin: "owner" }, ownerTask, stoppedTrace())).toMatchObject({ action: "requeue", target, attempt: 1 });
    expect(computerUseRecovery({ origin: "owner" }, ownerTask.replace("Teacher Doc Studio", "Other App"), stoppedTrace())).toMatchObject({ action: "fail" });
    expect(computerUseRecovery({ origin: "owner" }, "允许屏幕录制权限。Teacher Doc Studio", stoppedTrace())).toMatchObject({ action: "fail" });
  });

  test("owner follow-up can grant continuing same-kind authorization without broad system permission inheritance", () => {
    const body = `Teacher Doc Studio\n\n## Owner follow-up 2026-11-17\n> 允许授权。后续 GUI 测试出现确认权限时默认允许，无需逐次确认。\n`;
    expect(computerUseRecovery({}, body, stoppedTrace()).action).toBe("requeue");
    const different = { ...stoppedTrace(), stopped: { permission: "application-control" as const, target: "/Applications/Other.app", message: "stopped" } };
    expect(computerUseRecovery({}, body, different).action).toBe("fail");
  });

  test("requeues at most once and remains idempotent on the recovery metadata", () => {
    const first = computerUseRecovery({ origin: "owner" }, ownerTask, stoppedTrace());
    expect(first.action).toBe("requeue");
    const second = computerUseRecovery({ origin: "owner", computer_use_recovery_attempts: "1", computer_use_recovery_target: target }, ownerTask, stoppedTrace());
    expect(second).toEqual({ action: "fail", reason: "the one-turn Computer Use recovery limit was reached" });
  });

  test("the recovery turn must make exactly one fresh request for the exact target", () => {
    const meta = { computer_use_recovery_target: target };
    expect(validateComputerUseRecovery(meta)).toContain("no observable");
    expect(validateComputerUseRecovery(meta, { calls: [`getApp:${target}`], getAppRequests: [target] })).toBeUndefined();
    expect(validateComputerUseRecovery(meta, { calls: [`getApp:${target}`, `getApp:${target}`], getAppRequests: [target, target] })).toContain("2 target requests");
    expect(validateComputerUseRecovery(meta, { calls: ["other", `getApp:${target}`], getAppRequests: [target] })).toContain("did not start");
    expect(validateComputerUseRecovery(meta, { calls: ["getApp:/Applications/Other.app"], getAppRequests: ["/Applications/Other.app"] })).toContain("did not start");
  });

  test("different permission and unbound stop signals fail closed", () => {
    expect(computerUseRecovery({ origin: "owner" }, ownerTask, { getAppRequests: [], stopped: { permission: "application-control", message: "stopped" } })).toMatchObject({ action: "fail" });
    const observer = new ComputerUseObserver();
    observer.observe(JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", server: "other", tool: "js", arguments: { code: `cua.getApp(${JSON.stringify(target)})` }, result: "This application session has been explicitly stopped by the user for this turn." } }));
    expect(observer.result()).toBeUndefined();
  });

  test("accepts Codex JSONL MCP items and ignores duplicate internal completion events", () => {
    const observer = new ComputerUseObserver();
    const item = { id: "mcp-1", type: "mcp_tool_call", server: "cua_repl", tool: "js", arguments: { code: `let app = await cua.getApp(${JSON.stringify(target)});` }, result: "This application session has been explicitly stopped by the user for this turn." };
    observer.observe(JSON.stringify({ type: "item.completed", item }));
    observer.observe(JSON.stringify({ type: "item.completed", item }));
    expect(observer.result()).toMatchObject({ calls: [`getApp:${target}`], getAppRequests: [target], stopped: { target } });
  });

  test("runAgent extracts the final reply and Computer Use trace from Codex JSONL", async () => {
    const dir = mkdtempSync(`${tmpdir()}/noop-cua-json-`);
    const events = [
      { type: "item.completed", item: { id: "mcp-1", type: "mcp_tool_call", server: "cua_repl", tool: "js", arguments: { code: `let app = await cua.getApp(${JSON.stringify(target)});` }, result: "This application session has been explicitly stopped by the user for this turn." } },
      { type: "item.completed", item: { id: "msg-1", type: "agent_message", text: '```json\n{"status":"waiting","summary":"model tried to wait"}\n```' } },
    ];
    const script = `process.stdout.write(${JSON.stringify(events.map((event) => JSON.stringify(event)).join("\n") + "\n")})`;
    const cfg = { clis: { fake: { command: [process.execPath, "-e", script, "--json"] } } } as unknown as Cfg;
    try {
      const out = await runAgent("fake", "prompt", dir, cfg, `${dir}/run.log`);
      expect(parseResult(out)).toMatchObject({ status: "waiting" });
      expect(parseComputerUseTrace(out)).toMatchObject({ getAppRequests: [target], stopped: { target } });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
