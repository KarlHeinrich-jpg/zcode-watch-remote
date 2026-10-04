import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ZcodeClient } from './zcode.js';

const TRANSCRIPT_LIMIT = 120;
const TEXT_LIMIT = 1500;
const DETAIL_LIMIT = 300;
const STREAM_FLUSH_MS = 350;

function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function projectNameOf(p) {
  if (!p) return '';
  const norm = String(p).replace(/[\\/]+$/, '');
  const idx = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

/**
 * Bridges ZCode app-server sessions to compact wire events for the watch.
 *
 * ZCode's real event envelope (reconstructed from the CLI and its session DB):
 *   { sessionId, seq, type, payload, deliveryKind, eventId, turnId, timestamp }
 * with `type` in: part.started|part.upserted|part.delta|model.streaming|
 *   tool.updated|permission.requested|permission.resolved|message.upserted|
 *   turn.started|turn.completed|turn.failed|session.updated|userInput.*
 *
 * Tool approvals do NOT arrive as events to answer — the app-server sends a
 * reverse *request* (interaction/requestPermission) that must be answered with
 * { decision: allow|deny|modify|escalate, reason?, modifiedInput? }.
 */
export class SessionHub extends EventEmitter {
  constructor({ cfg, log }) {
    super();
    this.cfg = cfg;
    this.log = log;
    this.client = null;
    this.up = false;
    this.sessions = new Map();          // sessionId -> summary fields
    this.transcripts = new Map();       // sessionId -> [wireEvent]
    this.pendingInteractions = new Map(); // requestId -> interaction
    this.streams = new Map();           // sessionId -> streaming assistant text
    this.watchCount = 0;
    this._subscribed = new Set();
    this.debugFile = null;
  }

  start() {
    this._openDebugFile();
    const client = new ZcodeClient({ ...this._resolvedCommand, log: this.log });
    this.client = client;
    client.on('notification', (msg) => this._onNotification(msg));
    client.on('serverRequest', (msg) => this._onServerRequest(msg));
    client.on('down', () => {
      this.up = false;
      this._broadcastAll();
    });
    client.on('fatal', (err) => {
      this.log.error(`cannot start zcode app-server: ${err.message}`);
      this.log.error('Set ZCODE_BIN (or "command" in the config file) to the zcode CLI or the desktop app zcode.cjs.');
      this.emit('fatal', err);
    });
    client.on('up', () => {
      this.up = true;
      this.log.info('app-server ready');
      this.refreshList().catch(() => {});
    });
    client.start();
    this.refreshTimer = setInterval(() => {
      if (this.up) this.refreshList().catch(() => {});
    }, 15000);
  }

  _openDebugFile() {
    if (!this.cfg.debugEvents) return;
    try {
      const dir = path.dirname(this.cfg.configFile);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'events-debug.jsonl');
      this.debugFile = fs.createWriteStream(file, { flags: 'a' });
      this.log.info(`debug events -> ${file}`);
    } catch (err) {
      this.log.warn('cannot open debug file:', err.message);
    }
  }

  setResolvedCommand(resolved) {
    this._resolvedCommand = resolved;
  }

  setWatchCount(n) {
    this.watchCount = n;
  }

  stop() {
    clearInterval(this.refreshTimer);
    for (const it of this.pendingInteractions.values()) clearTimeout(it.timer);
    this.client?.stop();
    this.debugFile?.end();
  }

  // ---------------------------------------------------------------- sessions

  summaries() {
    const list = [];
    for (const [id, s] of this.sessions) {
      const waiting = [...this.pendingInteractions.values()].some((i) => i.sessionId === id);
      list.push({
        id,
        title: s.title || '(untitled)',
        status: waiting ? 'waiting' : s.status || 'idle',
        mode: s.mode || '',
        projectName: projectNameOf(s.workspace),
        projectPath: s.workspace || '',
        updatedAt: s.updatedAt || 0,
        lastText: s.lastText || '',
        waitingApproval: waiting,
      });
    }
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    return list;
  }

  projects() {
    return (this.cfg.allowedProjects || []).map((p) => ({ path: p, name: projectNameOf(p) }));
  }

  async refreshList() {
    const result = await this.client.request('session/list', {});
    const list = Array.isArray(result?.sessions) ? result.sessions : [];
    let changed = false;
    for (const s of list) {
      const id = s.sessionId || s.id;
      if (!id) continue;
      const prev = this.sessions.get(id);
      const status = String(s.status || prev?.status || 'idle').toLowerCase();
      const title = s.title ?? prev?.title ?? '';
      const workspace = s.workspace?.workspacePath ?? prev?.workspace ?? '';
      const updatedAt = Number(s.updatedAt ?? prev?.updatedAt ?? 0);
      if (!prev || prev.status !== status || prev.title !== title || prev.updatedAt !== updatedAt) changed = true;
      this.sessions.set(id, {
        ...(prev || {}),
        title,
        status,
        mode: s.mode ?? prev?.mode ?? '',
        kind: s.sessionKind ?? prev?.kind ?? '',
        workspace,
        updatedAt,
      });
    }
    if (changed) this._broadcastAll();
  }

  _touch(id, patch = {}) {
    if (!id) return;
    const s = this.sessions.get(id) || { status: 'idle', updatedAt: 0 };
    this.sessions.set(id, { ...s, ...patch, updatedAt: Date.now() });
  }

  async createSession(projectPath) {
    if (!this.up) throw new Error('ZCode app-server is not running');
    const running = [...this.sessions.values()].filter((s) => s.status === 'running').length;
    if (running >= this.cfg.maxSessions) throw new Error(`max ${this.cfg.maxSessions} running sessions`);
    const dir = path.resolve(projectPath);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('project directory not found');
    const allowed = (this.cfg.allowedProjects || []).map((p) => path.resolve(p));
    if (allowed.length && !allowed.includes(dir)) throw new Error('project directory is not in allowedProjects');

    const params = { workspace: { workspacePath: dir, workspaceKey: dir } };
    if (this.cfg.mode) params.mode = this.cfg.mode;
    const result = await this.client.request('session/create', params, 60000);
    const id = result?.sessionId || result?.session?.sessionId;
    if (!id) throw new Error('session/create returned no sessionId');
    this._touch(id, { workspace: dir, status: 'idle', title: '' });
    this.transcripts.set(id, []);
    await this._ensureSubscribed(id);
    this._broadcastAll();
    this.log.info(`created session ${id} in ${dir}`);
    return id;
  }

  async openSession(id) {
    if (!this.up) throw new Error('ZCode app-server is not running');
    const summary = this.summaries().find((s) => s.id === id) || null;
    let events = this.transcripts.get(id) || [];
    if (!events.length) {
      try {
        const read = await this.client.request('session/read', { sessionId: id }, 20000);
        events = this._mapReadResult(id, read);
        this.transcripts.set(id, events.slice());
      } catch (err) {
        this.log.debug(`session/read failed for ${id}: ${err.message}`);
      }
    }
    await this._ensureSubscribed(id);
    return { summary, events };
  }

  async _ensureSubscribed(id) {
    if (this._subscribed.has(id)) return;
    try {
      await this.client.request('session/subscribe', { sessionId: id, deliveryKind: 'web-remote-replayable' });
      this._subscribed.add(id);
    } catch (err) {
      if (/not active/i.test(String(err.message || ''))) {
        try {
          await this.client.request('session/resume', { sessionId: id }, 60000);
          await this.client.request('session/subscribe', { sessionId: id, deliveryKind: 'web-remote-replayable' });
          this._subscribed.add(id);
          this.log.info(`resumed session ${id}`);
          return;
        } catch (err2) {
          throw new Error(`session is busy in another app and cannot be attached: ${err2.message}`);
        }
      }
      throw new Error(`subscribe failed: ${err.message}`);
    }
  }

  async sendPrompt(id, text) {
    if (!this.up) throw new Error('ZCode app-server is not running');
    await this._ensureSubscribed(id);
    this._touch(id, { status: 'running' });
    this._pushEvent(id, { kind: 'text', role: 'user', text: truncate(text, TEXT_LIMIT) });
    await this.client.request('session/send', { sessionId: id, content: String(text) }, 60000);
    this._broadcastAll();
  }

  async stopSession(id) {
    for (const [rid, it] of this.pendingInteractions) {
      if (it.sessionId === id) {
        clearTimeout(it.timer);
        this.pendingInteractions.delete(rid);
      }
    }
    await this.client.request('session/stop', { sessionId: id }, 20000);
    this._touch(id, { status: 'stopped' });
    this._pushEvent(id, { kind: 'status', status: 'stopped' });
    this._broadcastAll();
  }

  async setMode(id, mode) {
    if (!['plan', 'build', 'edit', 'yolo', 'auto'].includes(mode)) throw new Error('invalid mode');
    await this.client.request('session/setMode', { sessionId: id, mode }, 20000);
    this._touch(id, { mode });
    this._broadcastAll();
  }

  removeSession(id) {
    this.transcripts.delete(id);
    this.streams.delete(id);
    this.sessions.delete(id);
    this._subscribed.delete(id);
    this._broadcastAll();
  }

  externalEvent(payload) {
    this.emit('external', payload);
  }

  // ------------------------------------------------------- interactions

  /**
   * A reverse request from the app-server: the agent is blocked until someone
   * answers. Forward it to the watch and apply the fallback policy if nobody is
   * wearing one, so a running turn can never hang forever.
   */
  _onServerRequest(msg) {
    const params = msg.params || {};
    const requestId = String(params.requestId ?? params.toolCallId ?? msg.id);
    const sessionId = String(params.sessionId ?? '');
    const isQuestion = msg.method === 'interaction/requestUserInput';

    const interaction = {
      serverId: msg.id,
      requestId,
      sessionId,
      method: msg.method,
      toolName: params.toolName || params.schema?.toolName || (isQuestion ? 'AskUserQuestion' : 'Tool'),
      summary: truncate(params.reason ?? params.prompt ?? '', 300),
      riskLevel: params.riskLevel || '',
      options: (params.options || []).map((o) => ({
        id: String(o.optionId ?? o.kind ?? ''),
        name: String(o.name ?? o.kind ?? ''),
        description: o.description ? String(o.description) : '',
        response: o.response ?? null,
      })),
      questions: (params.questions || []).map((q) => ({
        header: String(q.header ?? ''),
        question: String(q.question ?? ''),
        multiSelect: !!q.multiSelect,
        options: (q.options || []).map((o) => ({
          label: String(o.label ?? o.value ?? ''),
          description: String(o.description ?? ''),
        })),
      })),
      input: params.input ?? null,
      turnId: params.turnId ? String(params.turnId) : '',
      timer: null,
      answered: false,
    };

    // A late duplicate for the same request id replaces the old one.
    const prev = this.pendingInteractions.get(requestId);
    if (prev?.timer) clearTimeout(prev.timer);
    this.pendingInteractions.set(requestId, interaction);

    if (isQuestion) {
      this._pushInteractionEvent(
        sessionId,
        {
          kind: 'question',
          requestId,
          prompt: interaction.summary,
          tool: interaction.toolName,
          questions: interaction.questions,
        },
        requestId
      );
    } else {
      this.log.info(`approval requested: ${interaction.toolName} (${interaction.riskLevel || 'risk?'}) in ${sessionId}`);
      this._pushInteractionEvent(
        sessionId,
        {
          kind: 'permission',
          requestId,
          tool: interaction.toolName,
          summary: interaction.summary,
          riskLevel: interaction.riskLevel,
          options: interaction.options.map(({ id, name, description }) => ({ id, name, description })),
        },
        requestId
      );
    }
    this._touch(sessionId, { status: 'waiting' });
    this._broadcastAll();
    this._armInteractionFallback(interaction);
  }

  _armInteractionFallback(interaction) {
    const fallback = String(this.cfg.permissionFallback || 'deny').toLowerCase();
    const timeoutMs = Number(this.cfg.permissionTimeoutMs ?? 300000);

    if (this.watchCount === 0 && fallback !== 'wait') {
      this.log.warn(`no watch connected — applying permissionFallback="${fallback}" to ${interaction.requestId}`);
      setImmediate(() => this._answerInteraction(interaction, { auto: true, allow: fallback === 'allow' }));
      return;
    }
    if (timeoutMs > 0) {
      interaction.timer = setTimeout(() => {
        this.log.warn(`approval ${interaction.requestId} timed out after ${timeoutMs}ms — applying "${fallback}"`);
        this._answerInteraction(interaction, { auto: true, allow: fallback === 'allow' });
      }, timeoutMs);
    }
  }

  /** Called when the watch taps Allow/Deny (or answers a question). */
  respondInteraction(sessionId, requestId, answer) {
    const interaction = this.pendingInteractions.get(requestId);
    if (!interaction) throw new Error('this request is no longer pending');
    if (interaction.sessionId && sessionId && interaction.sessionId !== sessionId) {
      throw new Error('request belongs to another session');
    }
    this._answerInteraction(interaction, answer);
  }

  _answerInteraction(interaction, { allow, optionId, text, cancelled, auto }) {
    if (interaction.answered) return;
    interaction.answered = true;
    clearTimeout(interaction.timer);
    this.pendingInteractions.delete(interaction.requestId);

    const result = this._buildInteractionResult(interaction, { allow, optionId, text, cancelled, auto });
    this.client.respond(interaction.serverId, result);
    this.log.info(`approval ${interaction.requestId} -> ${result.decision}${auto ? ' (fallback)' : ''}`);

    this._pushEvent(interaction.sessionId, {
      kind: 'status',
      status: 'running',
      note: `permission ${result.decision}`,
    });
    this._touch(interaction.sessionId, { status: 'running' });
    this._broadcastAll();
  }

  /**
   * ZCode ships a ready-made `response` object with every option — prefer it
   * verbatim; otherwise synthesise the documented decision shape.
   */
  _buildInteractionResult(interaction, { allow, optionId, text, cancelled, auto }) {
    const answeredAt = new Date().toISOString();
    const option = optionId ? interaction.options.find((o) => o.id === optionId) : null;
    if (option?.response?.decision) {
      const r = { ...option.response, resolvedAt: answeredAt };
      if (interaction.method === 'interaction/requestUserInput') r.modifiedInput = this._mergeAnswers(interaction, text, option.name);
      return r;
    }

    if (interaction.method === 'interaction/requestUserInput') {
      if (cancelled) return { decision: 'deny', reason: 'Dismissed from Apple Watch', resolvedAt: answeredAt };
      return {
        decision: 'modify',
        modifiedInput: this._mergeAnswers(interaction, text, option?.name),
        reason: text || undefined,
        resolvedAt: answeredAt,
      };
    }

    // Tool approval / plan approval
    const reason = auto
      ? `Auto-answered by the ZCode Watch bridge (no watch attached)`
      : allow
        ? 'Approved from Apple Watch'
        : 'Denied from Apple Watch';
    const decision = option?.id && option.id !== 'allow' && option.id !== 'deny' ? option.id : allow ? 'allow' : 'deny';
    if (interaction.toolName === 'ExitPlanMode') {
      return allow
        ? { decision: 'allow', reason, resolvedAt: answeredAt }
        : { decision: 'deny', reason: reason || 'Plan rejected from Apple Watch', reasonSource: 'plan_approval_feedback', resolvedAt: answeredAt };
    }
    return { decision, reason, resolvedAt: answeredAt };
  }

  /** AskUserQuestion answers travel as { answers: { "<question>": "<label>" } }. */
  _mergeAnswers(interaction, text, optionName) {
    const base = interaction.input && typeof interaction.input === 'object' ? { ...interaction.input } : {};
    const value = text || optionName || '';
    const answers = {};
    const questions = interaction.questions.length ? interaction.questions : [{ question: 'answer' }];
    for (const q of questions) answers[q.question || 'answer'] = value;
    return { ...base, answers };
  }

  // ------------------------------------------------------------ notifications

  _onNotification(msg) {
    if (msg.method === 'session/event') {
      this._onSessionEvent(msg.params || {});
      return;
    }
    if (msg.method === 'startup/storageState' || msg.method === 'process/resourceSample') return;
    this.log.debug('notification:', msg.method);
  }

  _onSessionEvent(env) {
    const id = env.sessionId || env.sessionID;
    if (!id) return;
    if (this.debugFile) {
      try {
        this.debugFile.write(JSON.stringify({ ts: Date.now(), env }) + '\n');
      } catch {}
    }
    const wire = this._classify(env);
    for (const ev of wire) this._pushEvent(id, ev);
    if (wire.length) this._broadcastAll();
  }

  _mapReadResult(id, read) {
    const items = Array.isArray(read?.items) ? read.items : Array.isArray(read) ? read : Array.isArray(read?.messages) ? read.messages : [];
    const events = [];
    for (const it of items) events.push(...this._classify({ sessionId: id, type: it.type, payload: it.payload ?? it }));
    return events.slice(-TRANSCRIPT_LIMIT);
  }

  /**
   * Maps a real ZCode session event into compact wire events.
   */
  _classify(env) {
    const type = String(env.type || '');
    const p = env.payload && typeof env.payload === 'object' ? env.payload : {};
    const id = env.sessionId;
    const out = [];

    switch (type) {
      case 'model.streaming': {
        const kind = String(p.kind || '');
        const delta = typeof p.delta === 'string' ? p.delta : '';
        if (!delta) return out;
        if (kind === 'text_delta') out.push(...this._stream(id, delta, 'assistant'));
        else if (kind === 'reasoning_delta') out.push(...this._stream(id, delta, 'thinking'));
        return out;
      }

      case 'part.started':
      case 'part.upserted': {
        const part = p.part;
        if (!part || typeof part !== 'object') return out;
        return this._classifyPart(id, part, type === 'part.upserted');
      }

      case 'part.delta':
        // Streaming deltas are handled through model.streaming.
        return out;

      case 'tool.updated': {
        const kind = String(p.kind || '');
        const tool = String(p.toolName || p.tool || 'tool');
        if (kind === 'scheduled') {
          out.push({ kind: 'tool', tool, state: 'started', detail: this._describeToolInput(p.input), callId: p.toolCallId });
        } else if (kind === 'started') {
          out.push({ kind: 'tool', tool, state: 'started', detail: '', callId: p.toolCallId });
        } else if (kind === 'result') {
          out.push({ kind: 'tool', tool, state: 'done', detail: this._describeResult(p.result), callId: p.toolCallId });
        } else if (kind === 'error') {
          out.push({ kind: 'tool', tool, state: 'failed', detail: truncate(p.error?.message ?? p.error?.type ?? 'failed', DETAIL_LIMIT), callId: p.toolCallId });
        } else if (kind === 'batch') {
          const ok = Number(p.successCount ?? 0);
          const total = Array.isArray(p.toolCallIds) ? p.toolCallIds.length : undefined;
          out.push({ kind: 'status', status: 'running', note: `tools ${ok}${total ? '/' + total : ''} ok` });
        }
        // 'progress' events are noise for a watch.
        return out;
      }

      case 'permission.requested': {
        const requestId = String(p.requestId ?? p.toolCallId ?? '');
        // The reverse request carries the same information and is authoritative;
        // if it already arrived (or is on its way) do not emit a duplicate row.
        if (this.pendingInteractions.has(requestId) || this._hasEvent(id, 'permission', requestId)) {
          return out;
        }
        out.push({
          kind: 'permission',
          requestId,
          tool: String(p.toolName || 'tool'),
          summary: truncate(p.reason ?? '', 200),
          riskLevel: String(p.riskLevel || ''),
          options: this._mapOptions(p.options),
          historical: true,
        });
        this._touch(id, { status: 'waiting' });
        return out;
      }

      case 'permission.resolved': {
        const decision = String(p.decision || '');
        if (decision) {
          out.push({ kind: 'status', status: 'running', note: `permission ${decision}` });
          this._touch(id, { status: 'running' });
        }
        return out;
      }

      case 'userInput.requested': {
        out.push({
          kind: 'question',
          requestId: String(p.requestId ?? ''),
          prompt: truncate(p.prompt ?? '', 300),
          choices: Array.isArray(p.choices) ? p.choices.map(String) : [],
          inputType: String(p.inputType || 'text'),
          historical: true,
        });
        return out;
      }

      case 'userInput.resolved':
        out.push({ kind: 'status', status: 'running', note: 'question answered' });
        return out;

      case 'turn.started':
        this._touch(id, { status: 'running' });
        out.push({ kind: 'status', status: 'running' });
        return out;

      case 'turn.completed': {
        this._flushStream(id);
        this._touch(id, { status: 'idle' });
        if (p.response) out.push({ kind: 'result', text: truncate(p.response, TEXT_LIMIT), isError: false });
        out.push({ kind: 'status', status: 'idle' });
        return out;
      }

      case 'turn.failed':
        this._flushStream(id);
        this._touch(id, { status: 'error' });
        out.push({ kind: 'error', message: truncate(p.message ?? p.error?.message ?? 'turn failed', 300) });
        out.push({ kind: 'status', status: 'error' });
        return out;

      case 'message.upserted': {
        const role = String(p.type || p.role || 'assistant').toLowerCase();
        const text = typeof p.content === 'string' ? p.content : p.content?.text;
        if (text && role.includes('user')) {
          this._flushStream(id);
          out.push({ kind: 'text', role: 'user', text: truncate(text, TEXT_LIMIT) });
        }
        return out;
      }

      case 'session.titleUpdated':
      case 'session.created':
      case 'session.updated':
      case 'session.resumed':
        this.refreshList().catch(() => {});
        if (type === 'session.closed') this._touch(id, { status: 'stopped' });
        return out;

      case 'session.closed':
        this._flushStream(id);
        this._touch(id, { status: 'stopped' });
        out.push({ kind: 'status', status: 'stopped' });
        return out;

      default:
        break;
    }

    // Tolerant fallback for shapes we have not catalogued yet.
    return this._classifyLegacy(env);
  }

  _classifyPart(id, part, isUpsert) {
    const out = [];
    const ptype = String(part.type || '');
    const meta = part.metadata || {};
    const synthetic = part.synthetic === true || meta.visibility === 'model-only';

    if (ptype === 'text') {
      if (synthetic) return out;
      this._flushStream(id);
      out.push({ kind: 'text', role: 'assistant', text: truncate(part.text ?? '', TEXT_LIMIT) });
      return out;
    }
    if (ptype === 'reasoning') {
      if (synthetic) return out;
      out.push({ kind: 'thinking', text: truncate(part.text ?? '', DETAIL_LIMIT) });
      return out;
    }
    if (ptype === 'tool') {
      if (isUpsert && part.state?.output !== undefined) this._flushStream(id);
      const status = String(part.state?.status || 'pending');
      const detail =
        part.state?.title ||
        part.state?.error ||
        this._describeToolInput(part.state?.input) ||
        String(part.state?.raw ?? '');
      out.push({
        kind: 'tool',
        tool: String(part.tool || 'tool'),
        state: status === 'completed' ? 'done' : status === 'error' ? 'failed' : 'started',
        detail: truncate(detail, DETAIL_LIMIT),
        callId: String(part.callID ?? part.callId ?? ''),
        output: part.state?.output ? truncate(part.state.output, DETAIL_LIMIT) : undefined,
      });
      return out;
    }
    if (ptype === 'file') {
      out.push({ kind: 'status', status: 'running', note: `file ${truncate(part.filename ?? part.mime ?? '', 60)}` });
      return out;
    }
    // step-start / step-finish are not shown on a watch.
    return out;
  }

  _describeToolInput(input) {
    if (!input) return '';
    if (typeof input === 'string') return truncate(input, DETAIL_LIMIT);
    const d = input.display || {};
    return truncate(d.command || d.filePath || d.description || d.toolName || '', DETAIL_LIMIT);
  }

  _mapOptions(options) {
    return (Array.isArray(options) ? options : []).map((o) => ({
      id: String(o.optionId ?? o.kind ?? ''),
      name: String(o.name ?? o.kind ?? ''),
      description: o.description ? String(o.description) : '',
    }));
  }

  /** Has this session's transcript already recorded an event of that kind? */
  _hasEvent(sessionId, kind, requestId) {
    return this._findEventIndex(sessionId, kind, requestId) >= 0;
  }

  _findEventIndex(sessionId, kind, requestId) {
    const list = this.transcripts.get(sessionId);
    if (!list) return -1;
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (e.kind === kind && (!requestId || e.requestId === requestId)) return i;
    }
    return -1;
  }

  /**
   * Push an interaction card, replacing the placeholder row that the event
   * stream may have produced a moment earlier for the same request id. The
   * wire event carries `replace` so the watch swaps instead of stacking.
   */
  _pushInteractionEvent(sessionId, ev, requestId) {
    const idx = this._findEventIndex(sessionId, ev.kind, requestId);
    const replace = idx >= 0;
    if (replace) this.transcripts.get(sessionId).splice(idx, 1);
    const existing = replace ? (this.transcripts.get(sessionId)[idx] ?? null) : null;
    this._pushEvent(sessionId, replace ? { ...existing, ...ev, replace: true } : ev);
  }

  _describeResult(result) {
    if (!result) return '';
    if (typeof result === 'string') return truncate(result, DETAIL_LIMIT);
    return truncate(result.output ?? result.message ?? result.title ?? '', DETAIL_LIMIT);
  }

  /**
   * Assistant text streams as deltas; accumulate and re-emit a single growing
   * bubble so the watch does not fill its screen with fragments.
   */
  _stream(id, delta, role) {
    const key = `${id}:${role}`;
    let buf = this.streams.get(key);
    if (!buf) {
      buf = { text: '', timer: null, role };
      this.streams.set(key, buf);
    }
    buf.text += delta;
    if (!buf.timer) {
      buf.timer = setTimeout(() => {
        buf.timer = null;
        if (!buf.text) return;
        this._pushEvent(id, {
          kind: role === 'thinking' ? 'thinking' : 'text',
          role: 'assistant',
          text: truncate(buf.text, TEXT_LIMIT),
          streaming: true,
        });
        this._broadcastAll();
      }, STREAM_FLUSH_MS);
    }
    return [];
  }

  _flushStream(id) {
    for (const [key, buf] of [...this.streams.entries()]) {
      if (!key.startsWith(id + ':')) continue;
      clearTimeout(buf.timer);
      if (buf.text) {
        this._pushEvent(id, {
          kind: buf.role === 'thinking' ? 'thinking' : 'text',
          role: 'assistant',
          text: truncate(buf.text, TEXT_LIMIT),
          streaming: true,
        });
      }
      this.streams.delete(key);
    }
  }

  /** Older/unknown shapes: keep the previous tolerant behaviour as a net. */
  _classifyLegacy(env) {
    const out = [];
    const id = env.sessionId;
    const candidates = [];
    if (Array.isArray(env.items)) candidates.push(...env.items);
    if (env.event) candidates.push(env.event);
    if (env.item) candidates.push(env.item);
    if (env.type) candidates.push(env);
    for (const e of candidates) {
      if (!e || typeof e !== 'object') continue;
      const t = String(e.type ?? e.kind ?? '').toLowerCase();
      const tool = e.toolName ?? e.tool ?? e.name;
      if (t.includes('approval') || e.approvalId || t.includes('permission')) {
        out.push({
          kind: 'permission',
          requestId: String(e.approvalId ?? e.requestId ?? e.id ?? ''),
          tool: String(tool || 'tool'),
          summary: truncate(e.summary ?? e.title ?? e.reason ?? '', 200),
          options: [],
          historical: true,
        });
        continue;
      }
      if (t.includes('tool')) {
        const done = /result|complete|finish|end|denied|failed/.test(t) || e.status === 'completed' || e.output !== undefined;
        out.push({ kind: 'tool', tool: String(tool || 'tool'), state: done ? 'done' : 'started', detail: truncate(e.title ?? e.summary ?? '', DETAIL_LIMIT) });
        continue;
      }
      const text = e.text ?? e.delta ?? (typeof e.content === 'string' ? e.content : e.content?.text);
      const role = String(e.role ?? (t.includes('user') ? 'user' : 'assistant')).toLowerCase();
      if (text && (t.includes('text') || t.includes('message') || t.includes('chunk') || t.includes('reasoning'))) {
        out.push({ kind: t.includes('reasoning') ? 'thinking' : 'text', role, text: truncate(text, TEXT_LIMIT) });
        continue;
      }
      if (t.includes('turn') || t.includes('result') || t.includes('complete') || t.includes('idle') || t.includes('stop') || t.includes('status') || t.includes('state')) {
        const status = String(e.status ?? (t.includes('idle') ? 'idle' : t.includes('stop') ? 'stopped' : t.includes('fail') ? 'error' : t.includes('complete') ? 'idle' : 'running')).toLowerCase();
        this._touch(id, { status });
        out.push({ kind: 'status', status });
        const resultText = e.result ?? e.lastAssistantMessage ?? e.finalText;
        if (resultText) out.push({ kind: 'result', text: truncate(resultText, TEXT_LIMIT), isError: !!e.isError });
        continue;
      }
      if (e.error || t.includes('error')) {
        out.push({ kind: 'error', message: truncate(e.error?.message ?? e.message ?? 'error', 300) });
      }
    }
    return out;
  }

  _pushEvent(id, ev) {
    if (!id) return;
    if (!this.transcripts.has(id)) this.transcripts.set(id, []);
    const list = this.transcripts.get(id);
    // Streaming updates replace the previous streaming bubble instead of stacking.
    if (ev.streaming) {
      const last = list[list.length - 1];
      if (last && last.streaming && last.kind === ev.kind) {
        list[list.length - 1] = ev;
      } else {
        list.push(ev);
      }
    } else {
      list.push(ev);
    }
    if (list.length > TRANSCRIPT_LIMIT) list.splice(0, list.length - TRANSCRIPT_LIMIT);

    if (ev.kind === 'text') {
      this._touch(id, { lastText: ev.text, status: ev.role === 'user' ? 'running' : this.sessions.get(id)?.status });
    }
    if (ev.kind === 'result' || (ev.kind === 'status' && ev.status !== 'running')) {
      this._touch(id, { status: ev.status || 'idle' });
    }
    this.emit('event', id, ev);
  }

  _broadcastAll() {
    this.emit('changed');
  }
}
