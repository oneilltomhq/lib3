// WebSocket relay between a browser rack (any example opened with ?bridge)
// and CLI/agent clients. Transport only: routes RPC requests {id, method,
// args} to the rack page and replies {id, ok, result|error} back. All
// semantics live in the page's Rack instance.
// Usage: pnpm bridge   (listens on ws://127.0.0.1:5175)
import { WebSocketServer } from "ws";

const PORT = Number(process.env.RACK_BRIDGE_PORT ?? 5175);
const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

let rack = null;
let nextId = 1;
const pending = new Map(); // serverId -> { client, id }

const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
log(`rack bridge listening on ws://127.0.0.1:${PORT}`);

wss.on("connection", (sock) => {
  let role = null;

  sock.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    if (msg.role) {
      role = msg.role;
      if (role === "rack") {
        if (rack && rack !== sock) rack.close();
        rack = sock;
        log("rack connected");
      }
      return;
    }

    if (role === "rack") {
      // reply from the page: route back to the client that asked
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (entry.client.readyState === 1) {
        entry.client.send(JSON.stringify({ ...msg, id: entry.id }));
      }
      return;
    }

    // request from a CLI/agent client: {id, method, args}
    if (msg.method === "status") {
      sock.send(JSON.stringify({
        id: msg.id,
        ok: true,
        result: { rackConnected: rack?.readyState === 1, pending: pending.size },
      }));
      return;
    }
    if (rack?.readyState !== 1) {
      sock.send(JSON.stringify({
        id: msg.id,
        ok: false,
        error: "no rack connected — open an example with ?bridge while the bridge runs",
      }));
      return;
    }
    const serverId = nextId++;
    pending.set(serverId, { client: sock, id: msg.id });
    rack.send(JSON.stringify({ id: serverId, method: msg.method, args: msg.args ?? [] }));
  });

  sock.on("close", () => {
    if (sock === rack) {
      rack = null;
      log("rack disconnected");
    }
    for (const [serverId, entry] of pending) {
      if (entry.client === sock) pending.delete(serverId);
    }
  });
});
