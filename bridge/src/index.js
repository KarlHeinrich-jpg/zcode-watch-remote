#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import { loadConfig, saveConfig, resolveZcodeCommand, BRIDGE_VERSION } from './config.js';
import { makeLogger } from './log.js';
import { acceptWebSocket } from './wsserver.js';
import { SessionHub } from './hub.js';
import { createHttpHandler, lanAddresses } from './http.js';

const log = makeLogger('bridge');
const cfg = loadConfig();

if (cfg.help) {
  console.log(`zcode-watch-bridge v${BRIDGE_VERSION}

Usage: zcode-watch-bridge [--port N] [--reset-pin] [--config path]

Serves a WebSocket endpoint (path /ws) that the ZCode Remote Apple Watch app
connects to. Pair once with the 6-digit PIN, then control ZCode sessions.

Config file: ${cfg.configFile}
Env: ZCODE_BIN=/path/to/zcode   ZCODE_REMOTE_DEBUG=1`);
  process.exit(0);
}

saveConfig(cfg); // persist pin/token on first run

const hub = new SessionHub({ cfg, log });
const resolved = resolveZcodeCommand(cfg);
if (resolved) {
  hub.setResolvedCommand(resolved);
} else {
  log.error('Cannot find the zcode CLI. Set ZCODE_BIN or "command" in the config file.');
}

const server = http.createServer(createHttpHandler({ cfg, hub, log, broadcastExternal: (p) => hub.externalEvent(p) }));
/** conn -> { authed, device, badAttempts } */
const wsClients = new Map();

function authedCount() {
  let n = 0;
  for (const state of wsClients.values()) if (state.authed) n++;
  return n;
}

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  const conn = acceptWebSocket(req, socket);
  if (!conn) return;
  const state = { authed: false, device: '', badAttempts: 0 };
  wsClients.set(conn, state);
  log.info(`watch connected (${wsClients.size} online)`);

  conn.onmessage = (text) => {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    handleWatchMessage(conn, state, msg).catch((err) => {
      log.warn('message handler error:', err.message);
      send(conn, { type: 'error', message: err.message });
    });
  };

  conn.onclose = () => {
    wsClients.delete(conn);
    hub.setWatchCount(authedCount());
    log.info(`watch disconnected (${wsClients.size} online)`);
  };
});

function send(conn, obj) {
  try {
    conn.send(JSON.stringify(obj));
  } catch {}
}

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const c of wsClients.keys()) {
    try {
      c.send(data);
    } catch {}
  }
}

async function handleWatchMessage(conn, state, msg) {
  switch (msg.type) {
    case 'ping':
      send(conn, { type: 'pong' });
      return;

    case 'pair': {
      if (String(msg.pin || '') !== cfg.pin) {
        state.badAttempts++;
        log.warn(`bad pairing attempt #${state.badAttempts}`);
        send(conn, { type: 'error', error: 'bad-pin', message: 'Pairing PIN is incorrect' });
        if (state.badAttempts >= 3) conn.close(4003);
        return;
      }
      state.authed = true;
      state.device = String(msg.device || 'Apple Watch');
      hub.setWatchCount(authedCount());
      log.info(`paired: ${state.device}`);
      send(conn, {
        type: 'paired',
        token: cfg.token,
        bridgeName: cfg.bridgeName,
        bridgeVersion: BRIDGE_VERSION,
        projects: hub.projects(),
        sessions: hub.summaries(),
      });
      send(conn, { type: 'sessions', sessions: hub.summaries() });
      return;
    }

    case 'hello': {
      if (String(msg.token || '') !== cfg.token) {
        send(conn, { type: 'error', error: 'bad-token', message: 'Token rejected — pair again' });
        conn.close(4001);
        return;
      }
      state.authed = true;
      state.device = String(msg.device || 'Apple Watch');
      hub.setWatchCount(authedCount());
      log.info(`hello from ${state.device}`);
      send(conn, {
        type: 'welcome',
        bridgeName: cfg.bridgeName,
        bridgeVersion: BRIDGE_VERSION,
        projects: hub.projects(),
        sessions: hub.summaries(),
      });
      send(conn, { type: 'sessions', sessions: hub.summaries() });
      return;
    }
  }

  if (!state.authed) {
    send(conn, { type: 'error', error: 'unauthorized', message: 'Pair first' });
    return;
  }

  switch (msg.type) {
    case 'sessions-list':
      send(conn, { type: 'sessions', sessions: hub.summaries() });
      return;

    case 'new-session': {
      const id = await hub.createSession(String(msg.projectPath || ''));
      send(conn, { type: 'session-created', sessionId: id });
      const opened = await hub.openSession(id);
      send(conn, { type: 'session-state', sessionId: id, status: 'idle', events: opened.events });
      return;
    }

    case 'session-open': {
      const id = String(msg.sessionId || '');
      const opened = await hub.openSession(id);
      const summary = opened.summary || hub.summaries().find((s) => s.id === id) || null;
      send(conn, {
        type: 'session-state',
        sessionId: id,
        summary,
        status: summary?.status || 'idle',
        events: opened.events,
      });
      return;
    }

    case 'session-close':
      // Nothing to release server-side; the watch just stops viewing.
      return;

    case 'prompt': {
      const id = String(msg.sessionId || '');
      await hub.sendPrompt(id, String(msg.text || ''));
      send(conn, { type: 'prompt-accepted', sessionId: id });
      return;
    }

    case 'interrupt':
      await hub.stopSession(String(msg.sessionId || ''));
      return;

    case 'permission-response': {
      const id = String(msg.sessionId || '');
      try {
        await hub.respondInteraction(id, String(msg.requestId || ''), {
          allow: !!msg.allow,
          optionId: msg.optionId ? String(msg.optionId) : undefined,
        });
        send(conn, { type: 'permission-accepted', sessionId: id, requestId: msg.requestId });
      } catch (err) {
        send(conn, { type: 'error', error: 'approval-failed', sessionId: id, message: err.message });
      }
      return;
    }

    case 'answer-input': {
      const id = String(msg.sessionId || '');
      try {
        await hub.respondInteraction(id, String(msg.requestId || ''), {
          text: msg.text !== undefined ? String(msg.text) : undefined,
          cancelled: !!msg.cancelled,
        });
        send(conn, { type: 'input-accepted', sessionId: id, requestId: msg.requestId });
      } catch (err) {
        send(conn, { type: 'error', error: 'answer-failed', sessionId: id, message: err.message });
      }
      return;
    }

    case 'set-mode':
      await hub.setMode(String(msg.sessionId || ''), String(msg.mode || ''));
      return;

    case 'remove-session':
      hub.removeSession(String(msg.sessionId || ''));
      return;

    default:
      log.debug('unknown watch message type:', msg.type);
  }
}

// Push hub changes to watches
let sessionsDirty = false;
hub.on('changed', () => {
  if (sessionsDirty) return;
  sessionsDirty = true;
  setTimeout(() => {
    sessionsDirty = false;
    broadcast({ type: 'sessions', sessions: hub.summaries() });
  }, 300);
});
hub.on('event', (sessionId, ev) => {
  broadcast({ type: 'session-event', sessionId, ev });
});
hub.on('external', (payload) => {
  broadcast({ type: 'external-event', ...payload });
});

hub.start();

// Heartbeat: ping watches every 25s, drop after 2 missed pongs
setInterval(() => {
  for (const c of [...wsClients.keys()]) {
    if (!c.alive) continue;
    if (c.missedPongs >= 2) {
      c.close(4000);
      continue;
    }
    if (c.missedPongs >= 1) c.missedPongs++;
    else c.missedPongs = 1;
    c.ping();
  }
}, 25000).unref();

function shutdown() {
  log.info('shutting down...');
  hub.stop();
  for (const c of wsClients.keys()) c.close(1001);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ---------------------------------------------------------------- banner
const addresses = lanAddresses(cfg.port);

server.listen(cfg.port, cfg.bind, () => {
  console.log('');
  console.log('  ZCode Watch Bridge v' + BRIDGE_VERSION);
  console.log('  ──────────────────────────────────────────');
  console.log(`  Bridge name : ${cfg.bridgeName}`);
  console.log(`  Pairing PIN : ${cfg.pin}   (token: ${cfg.token.slice(0, 6)}…)`);
  console.log(`  Config file : ${cfg.configFile}`);
  console.log(`  App-server  : ${hub.up ? 'connected' : resolved ? 'starting…' : 'NOT FOUND (set ZCODE_BIN)'}`);
  console.log('  Watch URL   :');
  for (const a of addresses) console.log(`                ${a}`);
  console.log('  ──────────────────────────────────────────');
  console.log('  On the watch: enter the address above, then type this PIN.');
  console.log('');
});

server.on('error', (err) => {
  log.error(`cannot listen on ${cfg.bind}:${cfg.port} — ${err.message}`);
  process.exit(1);
});
