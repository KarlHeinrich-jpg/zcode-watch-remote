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
    permissionFallback: 'deny',
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    sessionEvents: (sessionId) => events.filter((e) => e.type === 'session-event' && e.sessionId === sessionId).map((e) => e.ev),
    wait: (pred, timeoutMs = 10000, label = 'message') =>
      new Promise((resolve, reject) => {
        const found = events.find(pred);
        if (found) return resolve(found);
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

let ws;
let c;
let sessionId;

try {
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    if (/Watch URL/.test(bridgeLog)) break;
  }
  ok('bridge started', /Watch URL/.test(bridgeLog), bridgeLog.slice(-300));

  const health = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json());
  ok('GET /health reports ok', health.ok === true, JSON.stringify(health));

  const html = await fetch(`http://127.0.0.1:${PORT}/`).then((r) => r.text());
  ok('status page shows PIN', html.includes(PIN));
  ok('hook rejects bad token', (await fetch(`http://127.0.0.1:${PORT}/hook?event=stop`)).status === 401);
  ok('hook accepts valid token', (await fetch(`http://127.0.0.1:${PORT}/hook?token=${TOKEN}&event=stop&message=done`)).status === 200);

  // ------------------------------------------------------------- pairing
  console.log('\npairing:');
  ws = await WsClient.connect(`ws://127.0.0.1:${PORT}/ws`);
  c = collector(ws);

  ws.send(JSON.stringify({ type: 'pair', pin: '000000' }));
  ok('wrong PIN rejected', !!(await c.wait((m) => m.type === 'error' && m.error === 'bad-pin', 5000, 'bad-pin')));

  ws.send(JSON.stringify({ type: 'prompt', sessionId: 'x', text: 'nope' }));
  ok('unauthenticated prompt rejected', !!(await c.wait((m) => m.type === 'error' && m.error === 'unauthorized', 5000, 'unauthorized')));

  ws.send(JSON.stringify({ type: 'pair', pin: PIN, device: 'Test Watch' }));
  const paired = await c.wait((m) => m.type === 'paired', 5000, 'paired');
  ok('correct PIN pairs and returns token', paired.token === TOKEN);

  const list = await c.wait((m) => m.type === 'sessions', 5000, 'sessions');
  const desk = list.sessions.find((s) => s.id === 'sess_desktop_1');
  ok('session list mirrors app-server', !!desk && desk.title === 'Fix login bug');
  ok('projectName derived from workspace', desk?.projectName === 'web', desk?.projectName);

  // ------------------------------------------------------------ new session
  console.log('\nnew session (reverse request during create):');
  ws.send(JSON.stringify({ type: 'new-session', projectPath: cfgDir }));
  const created = await c.wait((m) => m.type === 'session-created', 20000, 'session-created');
  sessionId = created.sessionId;
  ok('session/create completes (runtime preferences answered)', /^sess_/.test(sessionId), sessionId);

  // --------------------------------------------------- real event envelope
  console.log('\nreal session event shapes:');
  ws.send(JSON.stringify({ type: 'prompt', sessionId, text: 'hello world' }));
  await c.wait((m) => m.type === 'prompt-accepted', 8000, 'prompt-accepted');

  const evs = () => c.sessionEvents(sessionId);

  await c.wait((m) => m.type === 'session-event' && m.ev?.kind === 'thinking', 10000, 'thinking delta');
  ok('model.streaming reasoning_delta -> thinking', true);

  await c.wait(
    (m) => m.type === 'session-event' && m.ev?.kind === 'text' && m.ev.streaming && /Echo: hello world/.test(m.ev.text),
    10000,
    'streaming text accumulated'
  );
  ok('text deltas accumulate into one streaming bubble', true);

  const finalText = await c.wait(
    (m) => m.type === 'session-event' && m.ev?.kind === 'text' && !m.ev.streaming && /Echo: hello world/.test(m.ev.text),
    10000,
    'part.upserted text'
  );
  ok('part.upserted text becomes the final message', finalText.ev.role === 'assistant');

  const toolDone = await c.wait((m) => m.type === 'session-event' && m.ev?.kind === 'tool' && m.ev.state === 'done', 10000, 'tool completed');
  ok('tool.updated/part.upserted -> tool done', toolDone.ev.tool === 'Bash' && toolDone.ev.detail === 'ls -la', JSON.stringify(toolDone.ev));
  ok('tool carries its callId', toolDone.ev.callId === 'call_1', toolDone.ev.callId);

  const result = await c.wait((m) => m.type === 'session-event' && m.ev?.kind === 'result', 10000, 'turn result');
  ok('turn.completed -> result with the agent response', /Turn done: hello world/.test(result.ev.text), result.ev.text);

  await c.wait((m) => m.type === 'session-event' && m.ev?.kind === 'status' && m.ev.status === 'idle', 8000, 'idle status');
  const statuses = evs().filter((e) => e.kind === 'status').map((e) => e.status);
  ok('status events track running -> idle', statuses.includes('running') && statuses.includes('idle'), statuses.join(','));

  // --------------------------------------------------------------- approval
  console.log('\napproval (reverse request -> watch -> decision):');
  ws.send(JSON.stringify({ type: 'prompt', sessionId, text: 'this needs approval please' }));
  const perm = await c.wait(
    (m) => m.type === 'session-event' && m.ev?.kind === 'permission' && m.sessionId === sessionId,
    15000,
    'permission event'
  );
  const firstRequestId = perm.ev.requestId;
  ok('interaction/requestPermission surfaces with requestId', /^ap_/.test(firstRequestId), firstRequestId);
  ok('approval carries the tool and risk level', perm.ev.tool === 'Bash' && perm.ev.riskLevel === 'high', JSON.stringify(perm.ev));
  ok('approval carries the options the server offered', perm.ev.options?.length === 2 && perm.ev.options[0].name === 'Allow once', JSON.stringify(perm.ev.options));

  const waiting = await c.wait(
    (m) => m.type === 'sessions' && m.sessions?.find((s) => s.id === sessionId)?.waitingApproval,
    8000,
    'waiting status'
  );
  ok('session marked as waiting for approval', !!waiting);

  ws.send(JSON.stringify({ type: 'permission-response', sessionId, requestId: firstRequestId, allow: true, optionId: 'allow' }));
  const accepted = await c.wait((m) => m.type === 'permission-accepted', 8000, 'permission-accepted');
  ok('bridge accepts the watch decision', !!accepted);

  const afterAllow = await c.wait(
    (m) => m.type === 'session-event' && m.ev?.kind === 'result' && /approval=allow/.test(m.ev.text),
    15000,
    'allow reached the agent'
  );
  ok("option-based 'allow' decision reaches the app-server", /approval=allow/.test(afterAllow.ev.text), afterAllow.ev.text);

  const resolvedStatus = evs().find((e) => e.kind === 'status' && /permission allow/.test(e.note || ''));
  ok('permission.resolved is reflected to the watch', !!resolvedStatus);

  // denied path
  ws.send(JSON.stringify({ type: 'prompt', sessionId, text: 'deny this approval request' }));
  const perm2 = await c.wait(
    (m) => m.type === 'session-event' && m.ev?.kind === 'permission' && m.ev.requestId !== firstRequestId,
    15000,
    'second permission event'
  );
  ok('a second approval gets its own requestId', !!perm2 && perm2.ev.requestId !== firstRequestId, perm2.ev.requestId);
  ws.send(JSON.stringify({ type: 'permission-response', sessionId, requestId: perm2.ev.requestId, allow: false, optionId: 'deny' }));
  const afterDeny = await c.wait(
    (m) => m.type === 'session-event' && m.ev?.kind === 'result' && /approval=deny/.test(m.ev.text),
    15000,
    'deny reached the agent'
  );
  ok("'deny' decision reaches the app-server", /approval=deny/.test(afterDeny.ev.text), afterDeny.ev.text);

  // ---------------------------------------------------------------- question
  console.log('\nAskUserQuestion (watch answers the agent):');
  ws.send(JSON.stringify({ type: 'prompt', sessionId, text: 'I have a question for you' }));
  const question = await c.wait(
    (m) => m.type === 'session-event' && m.ev?.kind === 'question' && m.ev.questions?.length,
    15000,
    'question event with choices'
  );
  const questionId = question.ev.requestId;
  ok('interaction/requestUserInput surfaces as a question', /^q_/.test(questionId), questionId);
  ok('question carries the choices the agent offered', question.ev.questions?.[0]?.options?.[0]?.label === 'Postgres', JSON.stringify(question.ev.questions));
  ok('the richer card replaces the placeholder (replace flag)', question.ev.replace === true, JSON.stringify(question.ev));

  ws.send(JSON.stringify({ type: 'answer-input', sessionId, requestId: questionId, text: 'SQLite' }));
  const answered = await c.wait((m) => m.type === 'input-accepted', 8000, 'input-accepted');
  ok('bridge accepts the answer', !!answered);
  const afterAnswer = await c.wait(
    (m) => m.type === 'session-event' && m.ev?.kind === 'result' && /answer=SQLite/.test(m.ev.text),
    15000,
    'answer reached the agent'
  );
  ok('answer is merged into modifiedInput.answers', /answer=SQLite/.test(afterAnswer.ev.text), afterAnswer.ev.text);

  // ------------------------------------------------------------- interrupt
  console.log('\ninterrupt + mode:');
  ws.send(JSON.stringify({ type: 'prompt', sessionId, text: 'this is slow please' }));
  await sleep(400);
  ws.send(JSON.stringify({ type: 'interrupt', sessionId }));
  const stopped = await c.wait((m) => m.type === 'session-event' && m.ev?.kind === 'status' && m.ev.status === 'stopped', 10000, 'stopped');
  ok('interrupt stops the session', !!stopped);

  ws.send(JSON.stringify({ type: 'set-mode', sessionId, mode: 'auto' }));
  const modeAuto = await c.wait((m) => m.type === 'sessions' && m.sessions?.find((s) => s.id === sessionId)?.mode === 'auto', 8000, 'mode auto');
  ok("mode 'auto' is accepted", !!modeAuto);

  ws.send(JSON.stringify({ type: 'set-mode', sessionId, mode: 'plan' }));
  await c.wait((m) => m.type === 'sessions' && m.sessions?.find((s) => s.id === sessionId)?.mode === 'plan', 8000, 'mode plan');
  ok('mode switches propagate to the list', true);

  // ------------------------------------------------------------- reconnect
  console.log('\nreconnect + replay:');
  ws.close();
  await sleep(300);
  const ws2 = await WsClient.connect(`ws://127.0.0.1:${PORT}/ws`);
  const c2 = collector(ws2);
  ws2.send(JSON.stringify({ type: 'hello', device: 'Test Watch 2', token: TOKEN }));
  const welcome = await c2.wait((m) => m.type === 'welcome', 5000, 'welcome');
  ok('token reconnect skips the PIN', welcome.bridgeName === 'test-bridge');

  ws2.send(JSON.stringify({ type: 'session-open', sessionId }));
  const opened = await c2.wait((m) => m.type === 'session-state' && m.sessionId === sessionId, 10000, 'reopen');
  ok('reopening replays the transcript', Array.isArray(opened.events) && opened.events.length > 0, String(opened.events?.length));
  ok('replayed transcript keeps rich events', opened.events.some((e) => e.kind === 'tool') && opened.events.some((e) => e.kind === 'permission'));

  ws2.send(JSON.stringify({ type: 'hello', token: 'wrong' }));
  ok('bad token rejected', !!(await c2.wait((m) => m.type === 'error' && m.error === 'bad-token', 5000, 'bad token')));

  // -------------------------------------------------- cross-process session
  console.log('\ncross-process session takeover:');
  const ws3 = await WsClient.connect(`ws://127.0.0.1:${PORT}/ws`);
  const c3 = collector(ws3);
  ws3.send(JSON.stringify({ type: 'hello', token: TOKEN }));
  await c3.wait((m) => m.type === 'welcome', 5000, 'welcome 3');
  ws3.send(JSON.stringify({ type: 'session-open', sessionId: 'sess_remote_1' }));
  const remote = await c3.wait((m) => m.type === 'session-state' && m.sessionId === 'sess_remote_1', 12000, 'remote');
  ok('session owned by another app is resumed and opened', !!remote);
  ok('resumed session replays persisted parts', remote.events?.length >= 1, String(remote.events?.length));

  // -------------------------------------------------------- external hook
  console.log('\nexternal hook:');
  await fetch(`http://127.0.0.1:${PORT}/hook?token=${TOKEN}&event=notification&message=build%20finished`);
  const ext = await c3.wait((m) => m.type === 'external-event' && /build finished/.test(m.message), 5000, 'external');
  ok('hook notification pushed to the watch', ext.event === 'notification');

  // ------------------------------------------------------------- security
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

  // --------------------------------------------------- permission fallback
  console.log('\npermission fallback with no watch attached:');
  for (const w of [ws2, ws3]) w.close();
  await sleep(500);
  const wsF = await WsClient.connect(`ws://127.0.0.1:${PORT}/ws`);
  const cF = collector(wsF);
  wsF.send(JSON.stringify({ type: 'hello', device: 'Fallback Watch', token: TOKEN }));
  await cF.wait((m) => m.type === 'welcome', 5000, 'welcome F');
  wsF.send(JSON.stringify({ type: 'prompt', sessionId, text: 'an approval is coming, then I leave' }));
  await cF.wait((m) => m.type === 'prompt-accepted', 8000, 'prompt-accepted F');
  // Walk away: no watch is attached when the agent asks for permission.
  wsF.close();
  await sleep(3000);

  ok('bridge auto-answers when no watch is attached', /no watch connected/.test(bridgeLog), bridgeLog.slice(-200));
  ok('fallback logs which decision was applied', /permissionFallback="deny"/.test(bridgeLog), bridgeLog.slice(-200));

  const wsG = await WsClient.connect(`ws://127.0.0.1:${PORT}/ws`);
  const cG = collector(wsG);
  wsG.send(JSON.stringify({ type: 'hello', device: 'Back Again', token: TOKEN }));
  await cG.wait((m) => m.type === 'welcome', 5000, 'welcome G');
  wsG.send(JSON.stringify({ type: 'session-open', sessionId }));
  const fallbackState = await cG.wait((m) => m.type === 'session-state' && m.sessionId === sessionId, 12000, 'fallback state');
  const fallbackResult = fallbackState.events?.find((e) => e.kind === 'result' && /approval=deny/.test(e.text || ''));
  ok('the safe default (deny) reached the agent', !!fallbackResult, JSON.stringify(fallbackState.events?.slice(-3)));

} catch (err) {
  fail++;
  failures.push('uncaught: ' + err.message);
  console.error('\nUNCAUGHT ERROR:', err.stack);
  console.error('\n--- bridge log (tail) ---\n' + bridgeLog.slice(-2500));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(fail ? 1 : 0);
