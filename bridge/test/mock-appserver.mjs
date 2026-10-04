import readline from 'node:readline';

/**
 * Mock of `zcode app-server --stdio` used by the e2e test.
 * Emits protocol shapes matching what we probed on the real CLI; the SessionHub
 * classifier must map these into wire events without knowing exact upstream formats.
 */

const sessions = new Map();
let seq = 0;
let n = 0;
let serverSeq = 0;
const serverPending = new Map();

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
function notif(method, params) {
  out({ method, params });
}
function event(sessionId, ev) {
  notif('session/event', { sessionId, seq: ++seq, event: ev });
}

sessions.set('sess_desktop_1', {
  id: 'sess_desktop_1',
  title: 'Fix login bug',
  status: 'idle',
  mode: 'build',
  kind: 'interactive',
  workspace: 'C:\\code\\web',
  updatedAt: Date.now() - 60000,
  backlog: [{ type: 'text', role: 'assistant', text: 'old assistant message' }],
});
sessions.set('sess_remote_1', {
  id: 'sess_remote_1',
  title: 'Owned elsewhere (not active here)',
  status: 'idle',
  mode: 'edit',
  kind: 'interactive',
  workspace: 'C:\\code\\api',
  updatedAt: Date.now() - 120000,
  notActiveHere: true,
  backlog: [{ type: 'text', role: 'user', text: 'old user message' }],
});

function serverRequest(method, params) {
  return new Promise((resolve) => {
    const id = 'server-' + (++serverSeq);
    serverPending.set(id, resolve);
    out({ id, method, params });
    setTimeout(() => {
      if (serverPending.has(id)) {
        serverPending.delete(id);
        resolve(null);
      }
    }, 5000);
  });
}

async function handle(m) {
  const p = m.params || {};
  switch (m.method) {
    case 'session/list': {
      out({
        id: m.id,
        result: {
          sessions: [...sessions.values()].map((s) => ({
            sessionId: s.id,
            title: s.title,
            status: s.status,
            mode: s.mode,
            sessionKind: s.kind,
            createdAt: s.updatedAt - 1000,
            updatedAt: s.updatedAt,
            workspace: { workspacePath: s.workspace, workspaceKey: s.workspace },
          })),
        },
      });
      return;
    }
    case 'session/create': {
      if (!p.workspace?.workspacePath) {
        out({ id: m.id, error: { code: -32602, message: 'workspace required' } });
        return;
      }
      const id = 'sess_mock_' + ++n;
      sessions.set(id, {
        id,
        title: '',
        status: 'idle',
        mode: p.mode || 'build',
        kind: 'interactive',
        workspace: p.workspace.workspacePath,
        updatedAt: Date.now(),
        backlog: [],
      });
      await serverRequest('session/requestRuntimePreferences', { sessionId: id, scope: 'runtime-materialization' });
      out({ id: m.id, result: { sessionId: id } });
      return;
    }
    case 'session/subscribe': {
      const s = sessions.get(p.sessionId);
      if (!s) {
        out({ id: m.id, error: { code: -32004, message: 'Session is not active: ' + p.sessionId } });
        return;
      }
      if (s.notActiveHere) {
        out({ id: m.id, error: { code: -32004, message: 'Session is not active: ' + p.sessionId } });
        return;
      }
      out({ id: m.id, result: { ok: true } });
      return;
    }
    case 'session/resume': {
      const s = sessions.get(p.sessionId);
      if (!s) {
        out({ id: m.id, error: { code: -32004, message: 'no such session' } });
        return;
      }
      s.notActiveHere = false;
      out({ id: m.id, result: { sessionId: s.id } });
      return;
    }
    case 'session/read': {
      const s = sessions.get(p.sessionId);
      out({ id: m.id, result: { items: s?.backlog || [] } });
      return;
    }
    case 'session/setMode': {
      const s = sessions.get(p.sessionId);
      if (s) s.mode = p.mode;
      out({ id: m.id, result: { ok: true } });
      return;
    }
    case 'session/send': {
      runTurn(p);
      out({ id: m.id, result: { ok: true } });
      return;
    }
    case 'session/stop': {
      const s = sessions.get(p.sessionId);
      if (s) {
        (s.timers || []).forEach(clearTimeout);
        s.status = 'stopped';
        s.updatedAt = Date.now();
        event(p.sessionId, { type: 'session-stopped', status: 'stopped' });
      }
      out({ id: m.id, result: { ok: true } });
      return;
    }
    default:
      out({ id: m.id, error: { code: -32601, message: 'unknown method: ' + m.method } });
  }
}

function runTurn(p) {
  const id = p.sessionId;
  const s = sessions.get(id);
  if (!s) return;
  const content = p.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === 'tool-approval-response') {
        event(id, { type: 'text', role: 'assistant', text: 'approval received: ' + (item.approved ? 'approved' : 'denied') });
        event(id, { type: 'turn-complete', status: 'idle', result: item.approved ? 'Approved and done.' : 'Denied.', isError: !item.approved });
        s.status = 'idle';
        s.updatedAt = Date.now();
        return;
      }
    }
    out({ id: 'unhandled-array', error: { code: -32602, message: 'unsupported content array (test only)' } });
    return;
  }
  const text = String(content ?? '');
  const timers = [];
  timers.push(setTimeout(() => event(id, { type: 'text', role: 'assistant', text: 'Echo: ' + text }), 30));
  timers.push(setTimeout(() => event(id, { type: 'tool-call', toolName: 'Bash', summary: 'ls -la' }), 60));
  timers.push(setTimeout(() => event(id, { type: 'tool-result', toolName: 'Bash', output: '2 files' }), 90));
  if (/approval/i.test(text)) {
    timers.push(
      setTimeout(() => {
        event(id, { type: 'tool-approval-request', approvalId: 'ap_' + ++n, toolName: 'Bash', summary: 'rm -rf /tmp/x' });
        s.status = 'waiting';
        s.updatedAt = Date.now();
      }, 120)
    );
  } else if (/slow/i.test(text)) {
    timers.push(setTimeout(() => event(id, { type: 'text', role: 'assistant', text: 'still working...' }), 150));
    // No turn-complete: stays "running" until stopped.
  } else {
    timers.push(
      setTimeout(() => {
        event(id, { type: 'turn-complete', status: 'idle', result: 'Turn done: ' + text, isError: false });
        s.status = 'idle';
        s.updatedAt = Date.now();
      }, 150)
    );
  }
  s.timers = timers;
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.id !== undefined && m.method) {
    handle(m).catch((err) => out({ id: m.id, error: { code: -32000, message: err.message } }));
    return;
  }
  if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
    const resolveFn = serverPending.get(m.id);
    if (resolveFn) {
      serverPending.delete(m.id);
      resolveFn(m);
    }
  }
});

notif('startup/storageState', { phase: 'checking' });
notif('startup/storageState', { phase: 'ready' });
