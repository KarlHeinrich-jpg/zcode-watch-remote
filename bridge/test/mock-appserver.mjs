import readline from 'node:readline';

/**
 * Mock of `zcode app-server --stdio`.
 *
 * Shapes here are copied from the real CLI: the session event envelope is
 * {sessionId, seq, type, payload, deliveryKind, eventId, turnId, timestamp}
 * and tool approvals arrive as a *reverse request* (interaction/requestPermission)
 * that the bridge must answer with {decision, reason, resolvedAt}.
 */

const sessions = new Map();
let seq = 0;
let serverSeq = 0;
let n = 0;
const serverPending = new Map();
const marks = []; // recorded decisions/answers, echoed back so tests can assert

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function emit(sessionId, type, payload) {
  out({
    method: 'session/event',
    params: {
      sessionId,
      seq: ++seq,
      type,
      payload,
      deliveryKind: 'web-remote-replayable',
      eventId: 'ev_' + seq,
      turnId: 'turn_1',
      timestamp: Date.now(),
    },
  });
}

function serverRequest(method, params, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const id = 'server-' + ++serverSeq;
    serverPending.set(id, resolve);
    out({ id, method, params });
    setTimeout(() => {
      if (serverPending.has(id)) {
        serverPending.delete(id);
        resolve(null); // timed out
      }
    }, timeoutMs);
  });
}

sessions.set('sess_desktop_1', {
  id: 'sess_desktop_1',
  title: 'Fix login bug',
  status: 'idle',
  mode: 'build',
  kind: 'interactive',
  workspace: 'C:\\code\\web',
  updatedAt: Date.now() - 60000,
  backlog: [
    { type: 'part.upserted', payload: { part: { type: 'text', text: 'old assistant message' } } },
    { type: 'part.upserted', payload: { part: { type: 'tool', callID: 'call_old', tool: 'Read', state: { status: 'completed', title: 'read auth.ts', output: '120 lines' } } } },
  ],
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
  backlog: [{ type: 'part.upserted', payload: { part: { type: 'text', text: 'old user visible message' } } }],
});

async function handle(m) {
  const p = m.params || {};
  switch (m.method) {
    case 'session/list':
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
      // The real CLI asks this mid-create and hangs without an answer.
      const prefs = await serverRequest('session/requestRuntimePreferences', { sessionId: id, scope: 'runtime-materialization' }, 15000);
      if (!prefs) {
        out({ id: m.id, error: { code: -32022, data: { timeoutMs: 15000 }, message: 'Client request timed out: session/requestRuntimePreferences' } });
        return;
      }
      out({ id: m.id, result: { sessionId: id } });
      return;
    }

    case 'session/subscribe': {
      const s = sessions.get(p.sessionId);
      if (!s || s.notActiveHere) {
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

    case 'session/read':
      out({ id: m.id, result: { items: sessions.get(p.sessionId)?.backlog || [] } });
      return;

    case 'session/setMode': {
      const s = sessions.get(p.sessionId);
      if (s) s.mode = p.mode;
      out({ id: m.id, result: { ok: true } });
      return;
    }

    case 'session/send': {
      out({ id: m.id, result: { ok: true } });
      runTurn(p).catch((err) => emit(p.sessionId, 'turn.failed', { message: err.message }));
      return;
    }

    case 'session/stop': {
      const s = sessions.get(p.sessionId);
      if (s) {
        (s.timers || []).forEach(clearTimeout);
        s.timers = [];
        s.status = 'stopped';
        s.updatedAt = Date.now();
      }
      out({ id: m.id, result: { ok: true } });
      emit(p.sessionId, 'session.closed', { reason: 'stopped-by-user' });
      return;
    }

    default:
      out({ id: m.id, error: { code: -32601, message: 'unknown method: ' + m.method } });
  }
}

async function runTurn(p) {
  const id = p.sessionId;
  const s = sessions.get(id);
  if (!s) return;
  const text = String(p.content ?? '');
  const timers = [];
  const later = (ms, fn) => timers.push(setTimeout(fn, ms));

  emit(id, 'turn.started', { turnNumber: 1 });
  later(30, () => emit(id, 'model.streaming', { kind: 'reasoning_delta', delta: 'Thinking about it…', partId: 'pr_0' }));
  later(60, () => {
    emit(id, 'model.streaming', { kind: 'text_delta', delta: 'Echo: ', partId: 'pr_1' });
    emit(id, 'model.streaming', { kind: 'text_delta', delta: text, partId: 'pr_1' });
  });
  later(90, () => emit(id, 'model.streaming', { kind: 'text_end', partId: 'pr_1' }));
  later(120, () => emit(id, 'part.upserted', { part: { type: 'text', text: 'Echo: ' + text, metadata: {} } }));
  later(150, () => emit(id, 'tool.updated', { kind: 'scheduled', toolCallId: 'call_1', toolName: 'Bash', input: { display: { command: 'ls -la' } } }));
  later(180, () => emit(id, 'tool.updated', { kind: 'started', toolCallId: 'call_1', toolName: 'Bash' }));
  later(200, () => emit(id, 'tool.updated', { kind: 'progress', toolCallId: 'call_1', elapsedMs: 30 }));
  later(220, () =>
    emit(id, 'part.upserted', {
      part: { type: 'tool', callID: 'call_1', tool: 'Bash', state: { status: 'completed', title: 'ls -la', output: '2 files', input: { display: { command: 'ls -la' } } } },
    })
  );

  if (/approval/i.test(text)) {
    later(260, async () => {
      const rid = 'ap_' + ++n; // real servers use a fresh id per request
      const options = [
        { optionId: 'allow', kind: 'allow', name: 'Allow once', response: { decision: 'allow' } },
        { optionId: 'deny', kind: 'deny', name: 'Deny', response: { decision: 'deny', reason: 'denied by user' } },
      ];
      s.status = 'waiting';
      emit(id, 'permission.requested', {
        requestId: rid,
        toolCallId: 'call_' + n,
        toolName: 'Bash',
        riskLevel: 'high',
        reason: 'rm -rf /tmp/x deletes files',
        input: { command: 'rm -rf /tmp/x' },
        options,
      });
      const reply = await serverRequest('interaction/requestPermission', {
        sessionId: id,
        requestId: rid,
        toolCallId: 'call_' + n,
        toolName: 'Bash',
        riskLevel: 'high',
        reason: 'rm -rf /tmp/x deletes files',
        input: { command: 'rm -rf /tmp/x' },
        options,
      });
      const decision = reply?.result?.decision ?? '(no answer)';
      marks.push({ kind: 'permission', requestId: rid, decision, reason: reply?.result?.reason, resolvedAt: reply?.result?.resolvedAt, modifiedInput: reply?.result?.modifiedInput });
      emit(id, 'permission.resolved', { requestId: rid, decision, reason: reply?.result?.reason });
      s.status = 'running';
      finish(id, `Turn done: ${text} [approval=${decision}]`);
    });
    s.timers = timers;
    return;
  }

  if (/question/i.test(text)) {
    later(260, async () => {
      const qid = 'q_' + ++n;
      emit(id, 'userInput.requested', { requestId: qid, prompt: 'Which database should I use?', inputType: 'choice', choices: ['Postgres', 'SQLite'] });
      const reply = await serverRequest('interaction/requestUserInput', {
        sessionId: id,
        requestId: qid,
        toolCallId: 'call_3',
        toolName: 'AskUserQuestion',
        prompt: 'Which database should I use?',
        input: { questions: [{ header: 'DB', question: 'Which database should I use?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] },
        questions: [
          { header: 'DB', question: 'Which database should I use?', multiSelect: false, options: [{ label: 'Postgres', description: 'server' }, { label: 'SQLite', description: 'file' }] },
        ],
        schema: { toolName: 'AskUserQuestion' },
      });
      const answer = reply?.result?.modifiedInput?.answers?.['Which database should I use?'] ?? '(no answer)';
      marks.push({ kind: 'question', requestId: qid, decision: reply?.result?.decision, answer });
      emit(id, 'userInput.resolved', { requestId: qid, value: answer });
      finish(id, `Turn done: ${text} [answer=${answer}]`);
    });
    s.timers = timers;
    return;
  }

  if (/slow/i.test(text)) {
    later(300, () => emit(id, 'model.streaming', { kind: 'text_delta', delta: 'still working…', partId: 'pr_2' }));
    s.timers = timers; // never finishes until stopped
    return;
  }

  later(300, () => finish(id, `Turn done: ${text}`));
  s.timers = timers;
}

function finish(id, response) {
  const s = sessions.get(id);
  if (s) {
    if (s.status === 'stopped') return;
    s.status = 'idle';
    s.updatedAt = Date.now();
  }
  emit(id, 'turn.completed', {
    response,
    tokenCount: 128,
    toolCallCount: 1,
    duration: 420,
    usage: { inputTokens: 100, outputTokens: 28 },
  });
}

// A way for the test to read back what the bridge answered.
async function handleClientLine(m) {
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
  // Test hook: read back every decision the bridge sent us.
  if (m.method === 'test/marks') {
    out({ id: m.id, result: { marks } });
    return;
  }
  handleClientLine(m);
});

out({ method: 'startup/storageState', params: { phase: 'ready' } });
