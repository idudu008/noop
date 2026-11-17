// `hub visual …` — headless GUI sessions for agents: run apps without a monitor, screenshot, record, send input.
// Backends: sway (headless Wayland, GPU) → Xvfb (X11, always available) on Linux; native screencapture on macOS.
// State is per session name under ~/.noop/visual/<name>/ so parallel reviews never share a display.
import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR } from "./core";

const BASE = join(HOME_DIR, "visual");
type EvidenceStatus = "pending" | "available" | "blocked";
type ProcessRecord = { pid: number; command: string[]; log: string; startedAt: string };
type Sess = {
  name: string;
  backend: "sway" | "xvfb" | "macos";
  env: Record<string, string>;
  pids: number[];
  rec?: number;
  size: string;
  target?: { name: string; authorization: "pending" | "approved" | "denied"; detail: string; requestedAt: string };
  currentStep?: string;
  processObservation?: { status: "pending" | "running" | "missing"; detail: string; observedAt?: string };
  window?: { status: "pending" | "visible" | "missing"; detail: string; observedAt?: string };
  capabilities?: { screenshot: EvidenceStatus; recording: EvidenceStatus; input: EvidenceStatus };
  processes?: ProcessRecord[];
  lastSuccess?: { action: string; at: string };
  blocker?: string;
  recovery?: string;
};

const dir = (name: string) => join(BASE, name);
const now = () => new Date().toISOString();
const load = (name: string): Sess => {
  const session = JSON.parse(readFileSync(join(dir(name), "session.json"), "utf8")) as Sess;
  session.processes ??= [];
  session.capabilities ??= { screenshot: "pending", recording: "pending", input: "pending" };
  session.processObservation ??= { status: "pending", detail: "target process has not been observed outside the launcher" };
  session.window ??= { status: "pending", detail: "window visibility has not been observed" };
  return session;
};
const save = (session: Sess) => {
  mkdirSync(dir(session.name), { recursive: true });
  writeFileSync(join(dir(session.name), "session.json"), JSON.stringify(session, null, 2));
};
const spawnBg = (cmd: string[], env: Record<string, string>, log: string) => {
  const process = Bun.spawn(cmd, { env: { ...globalThis.process.env, ...env }, stdout: Bun.file(log), stderr: Bun.file(log), stdin: "ignore", detached: true });
  process.unref();
  return process.pid;
};
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const tail = (path: string, limit = 1200) => {
  if (!existsSync(path)) return "";
  const text = readFileSync(path, "utf8");
  return text.slice(-limit).trim();
};
const block = (session: Sess, reason: string, recovery: string) => {
  session.blocker = reason;
  session.recovery = recovery;
  save(session);
};
const success = (session: Sess, action: string) => {
  session.lastSuccess = { action, at: now() };
  session.blocker = undefined;
  session.recovery = undefined;
  save(session);
};

export function backendFor(): Sess["backend"] {
  if (process.platform === "darwin") return "macos";
  return Bun.which("sway") && Bun.which("wf-recorder") ? "sway" : "xvfb";
}

async function start(name: string, size = "1600x1000", target?: string) {
  if (existsSync(join(dir(name), "session.json"))) await stop(name);
  mkdirSync(dir(name), { recursive: true });
  const backend = backendFor();
  const session: Sess = {
    name, backend, env: {}, pids: [], size, processes: [],
    currentStep: "session-started",
    processObservation: { status: "pending", detail: "target process has not been observed outside the launcher" },
    window: { status: "pending", detail: "window visibility has not been observed" },
    capabilities: { screenshot: "pending", recording: "pending", input: "pending" },
    ...(target ? { target: {
      name: target, authorization: "pending", requestedAt: now(),
      detail: `Fresh Computer Use approval is required for ${target}`,
    } } : {}),
  };
  if (backend === "sway") {
    const runtime = join(dir(name), "rt"); mkdirSync(runtime, { recursive: true, mode: 0o700 });
    const config = join(dir(name), "sway.conf");
    writeFileSync(config, `output HEADLESS-1 resolution ${size}\ndefault_border none\nfocus_follows_mouse no\n`);
    const env = { WLR_BACKENDS: "headless", WLR_LIBINPUT_NO_DEVICES: "1", XDG_RUNTIME_DIR: runtime, WAYLAND_DISPLAY: `wayland-hub-${name}` };
    session.pids.push(spawnBg(["sway", "-c", config], { ...env, WAYLAND_DISPLAY: "" }, join(dir(name), "sway.log")));
    await Bun.sleep(1500);
    const socket = (await $`ls ${runtime}`.quiet().nothrow()).stdout.toString().split("\n").find((file) => file.startsWith("wayland-") && !file.endsWith(".lock"));
    session.env = { XDG_RUNTIME_DIR: runtime, WAYLAND_DISPLAY: socket ?? "wayland-1", XDG_SESSION_TYPE: "wayland" };
  } else if (backend === "xvfb") {
    const display = `:${90 + Math.floor(Math.random() * 400)}`;
    session.pids.push(spawnBg(["Xvfb", display, "-screen", "0", `${size}x24`, "-nolisten", "tcp"], {}, join(dir(name), "xvfb.log")));
    await Bun.sleep(800);
    session.env = { DISPLAY: display, WAYLAND_DISPLAY: "", XDG_SESSION_TYPE: "x11" };
  }
  save(session);
  console.log(JSON.stringify(report(session), null, 2));
}

async function run(name: string, cmd: string[]) {
  if (!cmd.length) throw new Error("visual run requires a command after --");
  const session = load(name);
  const log = join(dir(name), `app-${Date.now()}.log`);
  const child = Bun.spawn(cmd, { env: { ...process.env, ...session.env }, stdout: Bun.file(log), stderr: Bun.file(log), stdin: "ignore", detached: true });
  child.unref();
  const pid = child.pid;
  session.pids.push(pid);
  session.processes!.push({ pid, command: cmd, log, startedAt: now() });
  session.currentStep = session.target ? "awaiting-target-authorization" : "application-running";
  save(session);
  await Bun.sleep(300);
  if (alive(pid)) success(session, `launched ${cmd.join(" ")}`);
  else {
    const exitCode = await child.exited;
    if (exitCode === 0) {
      session.processObservation = { status: "pending", detail: `launcher process ${pid} exited 0; target process handoff is not yet observed`, observedAt: now() };
      save(session);
    } else block(session, `process ${pid} exited ${exitCode} during launch: ${tail(log) || "no log output"}`, `Inspect ${log}, fix the launch command, then rerun noop visual run ${name} -- <cmd>`);
  }
  console.log(JSON.stringify(report(load(name)), null, 2));
}

async function shot(name: string, out: string) {
  const session = load(name);
  const env = { ...process.env, ...session.env };
  try {
    if (session.backend === "sway") await $`grim ${out}`.env(env);
    else if (session.backend === "xvfb") await $`ffmpeg -loglevel error -y -f x11grab -video_size ${session.size} -i ${session.env.DISPLAY} -frames:v 1 ${out}`.env(env);
    else await $`screencapture -x ${out}`;
    session.capabilities!.screenshot = "available";
    success(session, `captured screenshot ${out}`);
    console.log(out);
  } catch (error) {
    session.capabilities!.screenshot = "blocked";
    block(session, `screenshot failed: ${String(error)}`, `Grant screen capture permission, then rerun noop visual shot ${name}`);
    throw error;
  }
}

async function recStart(name: string, out: string) {
  const session = load(name);
  const cmd = session.backend === "sway" ? ["wf-recorder", "-f", out]
    : session.backend === "xvfb" ? ["ffmpeg", "-loglevel", "error", "-y", "-f", "x11grab", "-framerate", "30", "-video_size", session.size, "-i", session.env.DISPLAY,
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out]
    : ["screencapture", "-v", "-x", out];
  const process = Bun.spawn(cmd, { env: { ...globalThis.process.env, ...session.env }, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
  process.unref();
  session.rec = process.pid;
  session.capabilities!.recording = "available";
  writeFileSync(join(dir(name), "rec.out"), out);
  success(session, `started recording ${out}`);
  console.log(JSON.stringify({ recording: out, pid: process.pid }));
}

async function recStop(name: string) {
  const session = load(name);
  if (session.rec) { try { process.kill(session.rec, "SIGINT"); } catch {} await Bun.sleep(1500); }
  session.rec = undefined; save(session);
  const out = readFileSync(join(dir(name), "rec.out"), "utf8");
  const size = existsSync(out) ? Bun.file(out).size : 0;
  if (size > 20e6 && Bun.which("ffmpeg")) {
    const small = out.replace(/\.mp4$/, ".small.mp4");
    await $`ffmpeg -loglevel error -y -i ${out} -vf scale=1280:-2 -c:v libx264 -crf 32 -preset veryfast ${small}`.nothrow();
    success(session, `stopped recording ${small}`);
    console.log(small); return;
  }
  success(session, `stopped recording ${out}`);
  console.log(out);
}

async function input(name: string, args: string[]) {
  const session = load(name);
  const env = { ...process.env, ...session.env };
  const [kind, ...rest] = args;
  try {
    if (session.backend === "sway") {
      if (kind === "type") await $`wtype ${rest.join(" ")}`.env(env);
      else if (kind === "key") await $`wtype -k ${rest[0]}`.env(env);
      else if (kind === "click") await $`swaymsg seat - cursor set ${rest[0]} ${rest[1]}; swaymsg seat - cursor press button1; swaymsg seat - cursor release button1`.env(env).nothrow();
    } else if (session.backend === "xvfb") {
      if (!Bun.which("xdotool")) throw new Error("xdotool not installed (pacman -S xdotool)");
      if (kind === "type") await $`xdotool type --delay 30 ${rest.join(" ")}`.env(env);
      else if (kind === "key") await $`xdotool key ${rest[0]}`.env(env);
      else if (kind === "click") await $`xdotool mousemove ${rest[0]} ${rest[1]} click 1`.env(env);
    } else {
      if (kind === "type") await $`osascript -e ${`tell application "System Events" to keystroke "${rest.join(" ")}"`}`;
      else throw new Error(`macOS visual input does not support ${kind}`);
    }
    session.capabilities!.input = "available";
    success(session, `sent ${kind} input`);
  } catch (error) {
    session.capabilities!.input = "blocked";
    block(session, `input failed: ${String(error)}`, `Grant input control permission, then retry noop visual input ${name} ${args.join(" ")}`);
    throw error;
  }
}

function observe(name: string, kind: string, state: string, detail: string) {
  const session = load(name);
  const observedAt = now();
  if (kind === "authorization") {
    if (!session.target) throw new Error(`session ${name} has no --target`);
    if (!new Set(["ok", "pending", "blocked"]).has(state)) throw new Error("authorization state must be ok, pending, or blocked");
    session.target.authorization = state === "ok" ? "approved" : state === "blocked" ? "denied" : "pending";
    session.target.detail = detail || (state === "ok" ? "Computer Use returned the target application handle" : "waiting for fresh Computer Use approval");
    if (state === "ok") success(session, session.target.detail);
    else block(session, session.target.detail, `Accept the fresh Computer Use request, then run noop visual observe ${name} authorization ok <result>`);
  } else if (kind === "process") {
    if (!new Set(["ok", "pending", "blocked"]).has(state)) throw new Error("process state must be ok, pending, or blocked");
    session.processObservation = { status: state === "ok" ? "running" : state === "blocked" ? "missing" : "pending", detail: detail || "target process observation updated", observedAt };
    if (state === "ok") success(session, session.processObservation.detail);
    else block(session, session.processObservation.detail, `Restart or locate the target process, then run noop visual observe ${name} process ok <result>`);
  } else if (kind === "window") {
    if (!new Set(["ok", "pending", "blocked"]).has(state)) throw new Error("window state must be ok, pending, or blocked");
    session.window = { status: state === "ok" ? "visible" : state === "blocked" ? "missing" : "pending", detail: detail || "window observation updated", observedAt };
    if (state === "ok") success(session, session.window.detail);
    else block(session, session.window.detail, `Restore the target window, then run noop visual observe ${name} window ok <result>`);
  } else if (kind === "capture") {
    if (!new Set(["ok", "pending", "blocked"]).has(state)) throw new Error("capture state must be ok, pending, or blocked");
    const status = state === "ok" ? "available" : state === "blocked" ? "blocked" : "pending";
    session.capabilities!.screenshot = status;
    if (state === "ok") success(session, detail || "Computer Use returned a visible screenshot");
    else block(session, detail || "screen capture is unavailable", `Grant screen capture permission, then run noop visual shot ${name}`);
  } else if (kind === "step") {
    session.currentStep = detail || state;
    save(session);
  } else if (kind === "action") {
    if (state === "ok") success(session, detail || "Computer Use action succeeded");
    else block(session, detail || "Computer Use action failed", `Recover the target application, then repeat the failed action and record it with noop visual observe ${name} action ok <result>`);
  } else throw new Error("observe kind must be authorization, process, window, capture, step, or action");
  console.log(JSON.stringify(report(load(name)), null, 2));
}

function report(session: Sess) {
  const processes = session.processes!.map((process) => ({ ...process, alive: alive(process.pid), logTail: tail(process.log) }));
  const checks = {
    targetConfigured: !!session.target,
    authorizationApproved: session.target?.authorization === "approved",
    processAlive: processes.some((process) => process.alive) || session.processObservation?.status === "running",
    windowVisible: session.window?.status === "visible",
    captureAvailable: session.capabilities?.screenshot === "available" || session.capabilities?.recording === "available",
    successfulActionObserved: !!session.lastSuccess,
  };
  const ready = Object.values(checks).every(Boolean);
  let blocker: string | undefined;
  let recovery: string | undefined;
  if (!checks.targetConfigured) [blocker, recovery] = ["target application is not configured", `Restart with noop visual start ${session.name} ${session.size} --target <application>`];
  else if (!checks.authorizationApproved) [blocker, recovery] = [session.target!.detail, `Accept the fresh Computer Use request, then run noop visual observe ${session.name} authorization ok <result>`];
  else if (!checks.processAlive) [blocker, recovery] = [session.blocker ?? session.processObservation?.detail ?? "no tracked application process is alive", session.recovery ?? `Observe the target process, then run noop visual observe ${session.name} process ok <result>`];
  else if (!checks.windowVisible) [blocker, recovery] = [session.window!.detail, `Observe the target window, then run noop visual observe ${session.name} window ok <result>`];
  else if (!checks.captureAvailable) [blocker, recovery] = [session.capabilities?.screenshot === "blocked" ? session.blocker ?? "screen capture is blocked" : "screenshot and recording capability are unverified", session.capabilities?.screenshot === "blocked" ? session.recovery ?? `Grant screen capture permission, then run noop visual shot ${session.name}` : `Run noop visual shot ${session.name} or record a successful Computer Use capture`];
  else if (!checks.successfulActionObserved) [blocker, recovery] = ["no successful GUI action has been observed", `Perform one target action, then run noop visual observe ${session.name} action ok <result>`];
  return {
    session: session.name, backend: session.backend, target: session.target, currentStep: session.currentStep,
    processes, processObservation: session.processObservation, window: session.window, capabilities: session.capabilities, lastSuccess: session.lastSuccess,
    lastFailure: session.blocker ? { reason: session.blocker, recovery: session.recovery } : undefined,
    blocker: ready ? undefined : blocker, recovery: ready ? undefined : recovery, checks, ready,
  };
}

function status(name: string, required: boolean) {
  const value = report(load(name));
  console.log(JSON.stringify(value, null, 2));
  if (required && !value.ready) process.exitCode = 42;
}

export async function stop(name: string) {
  if (!existsSync(join(dir(name), "session.json"))) return;
  const session = load(name);
  writeFileSync(join(dir(name), "final.json"), JSON.stringify(report(session), null, 2));
  for (const pid of [session.rec, ...session.pids.reverse()]) if (pid) try { process.kill(pid, "SIGTERM"); } catch {}
  rmSync(join(dir(name), "rt"), { recursive: true, force: true });
  rmSync(join(dir(name), "session.json"));
}

export async function visual(args: string[]) {
  const [sub, name = "default", ...rest] = args;
  const separator = rest.indexOf("--");
  switch (sub) {
    case "start": {
      const targetAt = rest.indexOf("--target");
      const target = targetAt >= 0 ? rest[targetAt + 1] : undefined;
      const size = rest.find((value, index) => value !== "--target" && index !== targetAt + 1) ?? "1600x1000";
      return start(name, size, target);
    }
    case "run": return run(name, separator >= 0 ? rest.slice(separator + 1) : rest);
    case "shot": return shot(name, rest[0] ?? join(dir(name), `shot-${Date.now()}.png`));
    case "record": return recStart(name, rest[0] ?? join(dir(name), `rec-${Date.now()}.mp4`));
    case "stop-record": return recStop(name);
    case "input": return input(name, rest);
    case "observe": return observe(name, rest[0] ?? "", rest[1] ?? "", rest.slice(2).join(" "));
    case "status": return status(name, false);
    case "verify": return status(name, true);
    case "stop": return stop(name);
    default:
      console.log(`hub visual start <name> [WxH] [--target <app>]  start an observable GUI session (${backendFor()})
hub visual run <name> -- <cmd...>                 launch and track an app
hub visual observe <name> <kind> <state> [detail] record Computer Use authorization/process/window/capture/action/step evidence
hub visual status <name>                          show processes, window, capabilities, last action and blocker
hub visual verify <name>                          fail closed with exit 42 until all evidence is ready
hub visual shot <name> [out.png]                  screenshot
hub visual record <name> [out.mp4]                start recording;  hub visual stop-record <name>
hub visual input <name> type <text> | key <Return> | click <x> <y>
hub visual stop <name>`);
  }
}

export async function doctor() {
  const need: [string, string][] = [["git", "core"], ["bun", "core"], ["gh", "GitHub"], ["claude", "agent"], ["codex", "agent"]];
  if (process.platform === "linux") need.push(["sway", "visual (GPU headless)"], ["wf-recorder", "visual recording (sway)"], ["grim", "visual screenshot (sway)"],
    ["wtype", "visual input (sway)"], ["Xvfb", "visual fallback"], ["ffmpeg", "visual fallback/recording"], ["xdotool", "visual input (Xvfb)"], ["script", "headless login"]);
  const missing: string[] = [];
  for (const [binary, why] of need) {
    const ok = !!Bun.which(binary);
    if (!ok) missing.push(binary);
    console.log(`${ok ? "✔" : "✘"} ${binary.padEnd(12)} ${why}`);
  }
  console.log(`visual backend: ${backendFor()}`);
  if (missing.length && process.platform === "linux" && Bun.which("pacman"))
    console.log(`\ninstall:  sudo pacman -S --needed ${missing.filter((name) => !["claude", "codex", "bun"].includes(name)).map((name) => name === "Xvfb" ? "xorg-server-xvfb" : name === "script" ? "util-linux" : name === "gh" ? "github-cli" : name).join(" ")}`);
}
