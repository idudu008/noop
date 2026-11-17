export type ComputerUseTrace = {
  calls?: string[];
  getAppRequests: string[];
  deniedTarget?: string;
  stopped?: {
    permission: "application-control";
    target?: string;
    message: string;
  };
};

export type ComputerUseRecovery =
  | { action: "requeue"; target: string; note: string; attempt: number }
  | { action: "fail"; reason: string };

export const COMPUTER_USE_TRACE = "\n[computer-use-trace]";
const STOPPED = "This application session has been explicitly stopped by the user for this turn.";
const NOT_APPROVED = /Computer Use was not approved to use ([^"'\n]+)/;

const textOf = (value: unknown): string => {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return ""; }
};

const argsOf = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  if (typeof value === "string") try { return JSON.parse(value); } catch {}
  return {};
};

const getAppTarget = (args: unknown): string | undefined => {
  const code = String(argsOf(args).code ?? "");
  const match = code.match(/\bcua\.getApp\(\s*(["'`])([\s\S]*?)\1\s*\)/);
  return match?.[2]?.replace(/\\([\\"'`])/g, "$1");
};

/** Tracks only Computer Use MCP calls. Text elsewhere in the prompt, logs or assistant reply cannot create a stop. */
export class ComputerUseObserver {
  private calls = new Map<string, { server: string; tool: string; args: unknown }>();
  private observedCalls = new Set<string>();
  private trace: ComputerUseTrace = { calls: [], getAppRequests: [] };

  observe(line: string) {
    let event: any;
    try { event = JSON.parse(line); } catch { return; }

    const payload = event.payload;
    if (payload?.type === "function_call" && payload.call_id) {
      this.calls.set(payload.call_id, { server: String(payload.namespace ?? ""), tool: String(payload.name ?? ""), args: payload.arguments });
      return;
    }
    if (payload?.type === "mcp_tool_call_end") {
      const invocation = payload.invocation ?? {};
      this.observeCall(String(invocation.server ?? ""), String(invocation.tool ?? ""), invocation.arguments, payload.result, payload.call_id);
      return;
    }
    if (payload?.type === "function_call_output") {
      const call = this.calls.get(payload.call_id);
      if (call) this.observeCall(call.server, call.tool, call.args, payload.output, payload.call_id);
      return;
    }

    const item = event.item;
    if (!item || item.type !== "mcp_tool_call") return;
    this.observeCall(String(item.server ?? item.namespace ?? ""), String(item.tool ?? item.name ?? ""),
      item.arguments ?? item.args, item.result ?? item.output ?? item.error, item.id);
  }

  result(): ComputerUseTrace | undefined {
    return this.trace.getAppRequests.length || this.trace.stopped ? structuredClone(this.trace) : undefined;
  }

  private observeCall(server: string, tool: string, args: unknown, result: unknown, callId?: string) {
    if (!/cua_repl/i.test(server) || tool !== "js") return;
    if (callId && this.observedCalls.has(callId)) return;
    if (callId) this.observedCalls.add(callId);
    const target = getAppTarget(args);
    this.trace.calls!.push(target ? `getApp:${target}` : "other");
    if (target) this.trace.getAppRequests.push(target);
    const text = textOf(result);
    const denied = text.match(NOT_APPROVED)?.[1]?.trim();
    if (denied && target) this.trace.deniedTarget = target;
    if (!text.includes(STOPPED)) return;
    this.trace.stopped = {
      permission: "application-control",
      target: this.trace.deniedTarget ?? target,
      message: STOPPED,
    };
  }
}

export function appendComputerUseTrace(out: string, trace?: ComputerUseTrace): string {
  if (!trace) return out;
  return `${out}${COMPUTER_USE_TRACE}${Buffer.from(JSON.stringify(trace)).toString("base64url")}`;
}

export function parseComputerUseTrace(out: string): ComputerUseTrace | undefined {
  const encoded = out.slice(out.lastIndexOf(COMPUTER_USE_TRACE) + COMPUTER_USE_TRACE.length).match(/^[A-Za-z0-9_-]+/)?.[0];
  if (!out.includes(COMPUTER_USE_TRACE) || !encoded) return undefined;
  try { return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); } catch { return undefined; }
}

const taskSpec = (body: string) => body.split("\n## Run ")[0];
const ownerFollowUps = (body: string) => [...body.matchAll(/## Owner follow-up[^\n]*\n((?:>[^\n]*\n?)+)/g)]
  .map((match) => match[1].replace(/^> ?/gm, "")).join("\n");
const targetLabel = (target: string) => target.split(/[\\/]/).pop()!.replace(/\.app$/i, "");

function hasContinuousAuthorization(meta: Record<string, any>, body: string, target: string): boolean {
  const configured = meta.computer_use_authorization === "same-kind-application-control";
  const configuredTarget = meta.computer_use_authorization_target;
  const configuredSource = String(meta.computer_use_authorization_source ?? "");
  if (configured && /^(owner|decision:D-)/.test(configuredSource) && (!configuredTarget || configuredTarget === target)) return true;

  const ownerText = `${ownerFollowUps(body)}\n${meta.origin === "owner" ? taskSpec(body) : ""}`;
  const sameKind = /(同类.{0,32}(?:默认允许|持续授权|无需逐次)|(?:默认允许|持续授权|无需逐次).{0,32}同类)/s.test(ownerText)
    || /(?:后续|之后).{0,24}(?:GUI|Computer Use|应用控制|目标控制).{0,48}(?:默认允许|无需逐次|持续授权)/is.test(ownerText)
    || /same[- ]kind.{0,40}(?:pre-?approved|allowed|authorization)|(?:pre-?approved|allowed|authorization).{0,40}same[- ]kind/is.test(ownerText);
  if (!sameKind) return false;
  const label = targetLabel(target);
  return taskSpec(body).includes(target) || taskSpec(body).toLowerCase().includes(label.toLowerCase());
}

/** Pure policy: one same-target recovery turn, only with explicit owner-scoped continuing authorization. */
export function computerUseRecovery(meta: Record<string, any>, body: string, trace: ComputerUseTrace): ComputerUseRecovery {
  const stopped = trace.stopped;
  if (!stopped || stopped.permission !== "application-control") return { action: "fail", reason: "no supported Computer Use stop signal" };
  if (!stopped.target) return { action: "fail", reason: "the stopped Computer Use call was not bound to an exact application target" };
  const previousTarget = meta.computer_use_recovery_target;
  if (previousTarget && previousTarget !== stopped.target) return { action: "fail", reason: "the stopped request changed application targets" };
  const attempts = Number(meta.computer_use_recovery_attempts ?? 0);
  if (attempts >= 1) return { action: "fail", reason: "the one-turn Computer Use recovery limit was reached" };
  if (!hasContinuousAuthorization(meta, body, stopped.target)) return { action: "fail", reason: "no applicable same-kind continuing owner authorization was recorded" };
  const target = stopped.target;
  return {
    action: "requeue", target, attempt: attempts + 1,
    note: `Computer Use marked the previous assistant turn stopped. The owner already authorized this same-kind application-control request. In this fresh turn, make exactly one first Computer Use request: cua.getApp(${JSON.stringify(target)}). Do not call cua.getState, Finder, another target, or a second getApp before it. Continue only if that exact call returns the application handle. If it is denied, stopped again, or asks for a materially different permission, fail closed; do not return waiting and do not infer authorization from chat, TCC, inventory, process state or screenshots.`,
  };
}

export function validateComputerUseRecovery(meta: Record<string, any>, trace?: ComputerUseTrace): string | undefined {
  const target = meta.computer_use_recovery_target;
  if (!target) return undefined;
  if (!trace) return "the recovery turn made no observable Computer Use target request";
  if (trace.calls?.[0] !== `getApp:${target}`) return "the recovery turn did not start with the exact application target request";
  if (trace.getAppRequests.length !== 1) return `the recovery turn made ${trace.getAppRequests.length} target requests instead of exactly one`;
  if (trace.getAppRequests[0] !== target) return "the recovery turn requested a different application target";
  return undefined;
}
