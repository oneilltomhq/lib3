#!/usr/bin/env node
// CLI for a live rack page: calls any Rack method through the bridge.
// Usage: node scripts/rackctl.mjs <method> [args...]
//   args parse as JSON when possible, otherwise pass as strings
//   @path inlines a file's contents parsed as JSON (for replay sessions)
// Examples:
//   node scripts/rackctl.mjs status
//   node scripts/rackctl.mjs params
//   node scripts/rackctl.mjs set /p/bend 0.6 2000
//   node scripts/rackctl.mjs snap squelchy
//   node scripts/rackctl.mjs replay @examples/knot-morph-lab/sessions/build-up.json 2
import { readFileSync } from "fs";
import WebSocket from "ws";

const PORT = Number(process.env.RACK_BRIDGE_PORT ?? 5175);
const TIMEOUT_MS = Number(process.env.RACK_TIMEOUT_MS ?? 120_000);

const [method, ...rawArgs] = process.argv.slice(2);
if (!method) {
  console.error("usage: rackctl.mjs <method> [args...]   (methods: status, params, get, set, pulse, snap, apply, snaps, snapshot, dropSnap, session, clearSession, replay, lift)");
  process.exit(1);
}

const args = rawArgs.map((arg) => {
  if (arg.startsWith("@")) return JSON.parse(readFileSync(arg.slice(1), "utf8"));
  try {
    return JSON.parse(arg);
  } catch {
    return arg;
  }
});

const sock = new WebSocket(`ws://127.0.0.1:${PORT}`);
const timer = setTimeout(() => {
  console.error(`timed out after ${TIMEOUT_MS} ms`);
  process.exit(1);
}, TIMEOUT_MS);

sock.on("open", () => {
  sock.send(JSON.stringify({ role: "cli" }));
  sock.send(JSON.stringify({ id: 1, method, args }));
});

sock.on("message", (data) => {
  const msg = JSON.parse(data);
  if (msg.id !== 1) return;
  clearTimeout(timer);
  if (msg.ok) {
    console.log(typeof msg.result === "string" ? msg.result : JSON.stringify(msg.result, null, 2));
  } else {
    console.error(`ERROR: ${msg.error}`);
    process.exitCode = 1;
  }
  sock.close();
});

sock.on("error", (error) => {
  console.error(`bridge not reachable at ws://127.0.0.1:${PORT} — start it with: pnpm bridge (${error.message})`);
  process.exit(1);
});
