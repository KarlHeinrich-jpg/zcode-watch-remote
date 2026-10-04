import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WsClient } from './wsclient.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(__dirname, '..', 'src', 'index.js');
const MOCK = path.join(__dirname, 'mock-appserver.mjs');
const PORT = 8899;
const PIN = '123456';
const TOKEN = 'test-token';

const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcwr-test-'));
const cfgFile = path.join(cfgDir, 'config.json');
fs.writeFileSync(
  cfgFile,
  JSON.stringify({
    port: PORT,
    pin: PIN,
    token: TOKEN,
    bridgeName: 'test-bridge',
    command: `node ${MOCK}`,
    mode: 'build',
    allowedProjects: [cfgDir],
  })
);

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(name + (extra ? ` — ${extra}` : ''));
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function collector(ws) {
  const events = [];
  const waiters = [];
  ws.onmessage = (text) => {
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    events.push(m);
    for (const w of [...waiters]) {
      if (w.pred(m)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      }
    }
  };
  return {
    events,
    wait: (pred, timeoutMs = 8000, label = 'message') =>
      new Promise((resolve, reject) => {
        const found = events.find(pred);
        if (found) {
          resolve(found);
          return;
        }
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) {
            waiters.splice(i, 1);
            reject(new Error(`timeout waiting for ${label}; got: ${events.map((e) => e.type).join(',')}`));
          }
        }, timeoutMs);
      }),
  };
}

// ---------------------------------------------------------------- run
console.log('ZCode Watch Bridge — end-to-end test\n');
console.log('starting bridge with mock app-server...');

const bridge = spawn(process.execPath, [BRIDGE, '--config', cfgFile], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, ZCODE_REMOTE_DEBUG: '1' },
});
let bridgeLog = '';
bridge.stdout.on('data', (d) => (bridgeLog += d));
bridge.stderr.on('data', (d) => (bridgeLog += d));

const cleanup = () => {
  try {
    bridge.kill();
  } catch {}
  try {
    fs.rmSync(cfgDir, { recursive: true, force: true });
  } catch {}
};
process.on('exit', cleanup);

try {
  // wait for the bridge to listen
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    if (/Watch URL/.test(bridgeLog)) break;
  }
  ok('bridge started', /Watch URL/.test(bridgeLog), bridgeLog.slice(-300));

  const health = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json());
  ok('GET /health reports ok', health.ok === true, JSON.stringify(health));

  const html = await fetch(`http://127.0.0.1:${PORT}/`).then((r) => r.text());
  ok('status page shows PIN', html.includes(PIN));

  const hookBad = await fetch(`http://127.0.0.1:${PORT}/hook?event=stop`);
  ok('hook rejects bad token', hookBad.status === 401);

  const hookGood = await fetch(`http://127.0.0.1:${PORT}/hook?token=${TOKEN}&event=stop&message=done`);
  ok('hook accepts valid token', hookGood.status === 200);

  // ------------------------------------------------------------- pairing
  console.log('\npairing:');
  const ws = await WsClient.connect(`ws://127.0.0.1:${PORT}/ws`);
  const c = collector(ws);

  ws.send(JSON.stringify({ type: 'pair', pin: '000000' }));
  const bad = await c.wait((m) => m.type === 'error' && m.error === 'bad-pin', 5000, 'bad-pin error');
  ok('wrong PIN rejected', !!bad);

  ws.send(JSON.stringify({ type: 'prompt', sessionId: 'x', text: 'nope' }));
  const unauth = await c.wait((m) => m.type === 'error' && m.error === 'unauthorized', 5000, 'unauthorized');
  ok('unauthenticated prompt rejected', !!unauth);

  ws.send(JSON.stringify({ type: 'pair', pin: PIN, device: 'Test Watch' }));
  const paired = await c.wait((m) => m.type === 'paired', 5000, 'paired');
  ok('correct PIN pairs and returns token', paired.token === TOKEN);
  ok('paired payload includes sessions', Array.isArray(paired.sessions) && paired.sessions.length >= 2, JSON.stringify(paired.sessions?.length));

  const listMsg = await c.wait((m) => m.type === 'sessions', 5000, 'sessions broadcast');
  const desk = listMsg.sessions.find((s) => s.id === 'sess_desktop_1');
  ok('session list mirrors app-server', !!desk && desk.title === 'Fix login bug');
  ok('projectName derived from workspace', desk?.projectName === 'web', desk?.projectName);

  // ------------------------------------------------------------ new session
  console.log('\nnew session + prompt:');
  ws.send(JSON.stringify({ type: 'new-session', projectPath: cfgDir }));
  const created = await c.wait((m) => m.type === 'session-created', 15000, 'session-created');
  ok('session created', /^sess_/.test(created.sessionId), created.sessionId);

  const state = await c.wait((m) => m.type === 'session-state' && m.sessionId === created.sessionId, 8000, 'session-state');
  ok('session-state arrives', !!state);

  ws.send(JSON.stringify({ type: 'prompt', sessionId: created.sessionId, text: 'hello world' }));
  await c.wait((m) => m.type === 'prompt-accepted', 8000, 'prompt-accepted');
  ok('prompt accepted', true);

  const evText = await c.wait(
    (m) => m.type === 'session-event' && m.sessionId === created.sessionId && m.ev?.kind === 'text' && /Echo: hello world/.test(m.ev.text),
    8000,
    'assistant text event'
  );
  ok('assistant text streamed to watch', !!evText);

  const evToolStart = await c.wait(
    (m) => m.type === 'session-event' && m.ev?.kind === 'tool' && m.ev.state === 'started',
    8000,
    'tool started'
  );
  ok('tool-start event mapped', evToolStart.ev.tool === 'Bash', evToolStart.ev.tool);
  const evToolDone = await c.wait(
    (m) => m.type === 'session-event' && m.ev?.kind === 'tool' && m.ev.state === 'done',
    8000,
    'tool done'
  );
  ok('tool-done event mapped', !!evToolDone);

  const result = await c.wait((m) => m.type === 'session-event' && m.ev?.kind === 'result', 8000, 'turn result');
  ok('turn result mapped', /Turn done/.test(result.ev.text), result.ev.text);

  // ---------------------------------------------------------------- approval
  console.log('\napproval flow:');
  ws.send(JSON.stringify({ type: 'prompt', sessionId: created.sessionId, text: 'please request approval for this' }));
  const perm = await c.wait(
    (m) => m.type === 'session-event' && m.ev?.kind === 'permission' && m.sessionId === created.sessionId,
    8000,
    'permission request'
  );
  ok('permission request surfaced with requestId', /^ap_/.test(perm.ev.requestId), perm.ev.requestId);
  ok('permission includes tool name', perm.ev.tool === 'Bash', perm.ev.tool);

  const waiting = await c.wait((m) => m.type === 'sessions' && m.sessions?.find((s) => s.id === created.sessionId)?.waitingApproval, 8000, 'waiting status');
  ok('session marked waiting for approval', !!waiting);

  ws.send(JSON.stringify({ type: 'permission-response', sessionId: created.sessionId, requestId: perm.ev.requestId, allow: true }));
  const accepted = await c.wait((m) => m.type === 'permission-accepted', 8000, 'permission-accepted');
  ok('permission relay accepted by app-server', !!accepted);
  const afterApproval = await c.wait(
    (m) => m.type === 'session-event' && m.ev?.kind === 'text' && /approval received: approved/.test(m.ev.text),
    8000,
    'approval echo'
  );
  ok('approval reached the session as a message item', !!afterApproval);

  // ------------------------------------------------------------- interrupt
  console.log('\ninterrupt + mode:');
  ws.send(JSON.stringify({ type: 'prompt', sessionId: created.sessionId, text: 'this is slow please' }));
  await sleep(400);
  ws.send(JSON.stringify({ type: 'interrupt', sessionId: created.sessionId }));
  const stopped = await c.wait(
    (m) => m.type === 'session-event' && m.ev?.kind === 'status' && m.ev.status === 'stopped',
    8000,
    'stopped status'
  );
  ok('interrupt stops the session', !!stopped);

  ws.send(JSON.stringify({ type: 'set-mode', sessionId: created.sessionId, mode: 'plan' }));
  const modeBroadcast = await c.wait((m) => m.type === 'sessions' && m.sessions?.find((s) => s.id === created.sessionId)?.mode === 'plan', 8000, 'mode change');
  ok('set-mode propagates to watch list', !!modeBroadcast);

  // ----------------------------------------------------------- reconnect
  console.log('\nreconnect:');
  ws.close();
  await sleep(300);
  const ws2 = await WsClient.connect(`ws://127.0.0.1:${PORT}/ws`);
  const c2 = collector(ws2);
  ws2.send(JSON.stringify({ type: 'hello', device: 'Test Watch 2', token: TOKEN }));
  const welcome = await c2.wait((m) => m.type === 'welcome', 5000, 'welcome');
  ok('token reconnect skips PIN', welcome.bridgeName === 'test-bridge');
  ok('welcome carries sessions', Array.isArray(welcome.sessions) && welcome.sessions.length >= 3);

  const opened = await (async () => {
    ws2.send(JSON.stringify({ type: 'session-open', sessionId: created.sessionId }));
    return c2.wait((m) => m.type === 'session-state' && m.sessionId === created.sessionId, 8000, 'reopen');
  })();
  ok('reopening a session returns its transcript', Array.isArray(opened.events), String(opened.events?.length));

  ws2.send(JSON.stringify({ type: 'hello', token: 'wrong' }));
  const badToken = await c2.wait((m) => m.type === 'error' && m.error === 'bad-token', 5000, 'bad token');
  ok('bad token rejected', !!badToken);

  // -------------------------------------------------- external hook push
  console.log('\nexternal hook:');
  const ws3 = await WsClient.connect(`ws://127.0.0.1:${PORT}/ws`);
  const c3 = collector(ws3);
  ws3.send(JSON.stringify({ type: 'hello', token: TOKEN }));
  await c3.wait((m) => m.type === 'welcome', 5000, 'welcome 3');
  await fetch(`http://127.0.0.1:${PORT}/hook?token=${TOKEN}&event=notification&message=build%20finished`);
  const ext = await c3.wait((m) => m.type === 'external-event' && /build finished/.test(m.message), 5000, 'external event');
  ok('hook notification pushed to watch', !!ext);
  ok('hook event carries event name', ext.event === 'notification', ext.event);

  // ------------------------------------------------------- cross-process
  console.log('\ncross-process session takeover:');
  ws3.send(JSON.stringify({ type: 'session-open', sessionId: 'sess_remote_1' }));
  const remote = await c3.wait((m) => m.type === 'session-state' && m.sessionId === 'sess_remote_1', 10000, 'remote session state');
  ok('session owned by another app is resumed and opened', !!remote);
  const names = c3.events.filter((m) => m.type === 'sessions').pop()?.sessions?.find((s) => s.id === 'sess_remote_1');
  ok('resumed session appears in list', !!names);

  // ------------------------------------------------------------- reauth
  console.log('\nsecurity:');
  const ws4 = await WsClient.connect(`ws://127.0.0.1:${PORT}/ws`);
  let closed = false;
  ws4.onclose = () => (closed = true);
  for (let i = 0; i < 4; i++) {
    ws4.send(JSON.stringify({ type: 'pair', pin: '999999' }));
    await sleep(120);
  }
  await sleep(600);
  ok('repeated bad PINs close the connection', closed);

} catch (err) {
  fail++;
  failures.push('uncaught: ' + err.message);
  console.error('\nUNCAUGHT ERROR:', err.stack);
  console.error('\n--- bridge log (tail) ---\n' + bridgeLog.slice(-2000));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(fail ? 1 : 0);
