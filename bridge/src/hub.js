import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ZcodeClient } from './zcode.js';

const TRANSCRIPT_LIMIT = 120;
const TEXT_LIMIT = 1500;
const DETAIL_LIMIT = 300;

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
 */
export class SessionHub extends EventEmitter {
  constructor({ cfg, log }) {
    super();
    this.cfg = cfg;
    this.log = log;
    this.client = null;
    this.up = false;
    // sessionId -> { title, status, mode, workspace, kind, updatedAt, lastText }
    this.sessions = new Map();
    // sessionId -> [wireEvent]
    this.transcripts = new Map();
    // sessionId -> { requestId, tool, summary }
    this.pendingApproval = new Map();
    this.debugFile = null;
  }

  start() {
    this._openDebugFile();
    const resolved = this._resolvedCommand;
    const client = new ZcodeClient({ ...resolved, log: this.log });
    this.client = client;
    client.on('notification', (msg) => this._onNotification(msg));
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
    // Periodic refresh keeps the watch list in sync even without events.
    this.refreshTimer = setInterval(() => {
      if (this.up) this.refreshList().catch(() => {});
    }, 15000);
  }

  _openDebugFile() {
    if (!this.cfg.debugEvents) return;
    try {
      const dir = path.dirname(this.cfg.configFile);
      fs.mkdirSync(dir, { recursive: true });
      this.debugFile = fs.createWriteStream(path.join(dir, 'events-debug.jsonl'), { flags: 'a' });
      this.log.info(`debug events -> ${path.join(dir, 'events-debug.jsonl')}`);
    } catch (err) {
      this.log.warn('cannot open debug file:', err.message);
    }
  }

  setResolvedCommand(resolved) {
    this._resolvedCommand = resolved;
  }

  stop() {
    clearInterval(this.refreshTimer);
    this.client?.stop();
    this.debugFile?.end();
  }

  // ---------------------------------------------------------------- sessions

  summaries() {
    const list = [];
    for (const [id, s] of this.sessions) {
      list.push({
        id,
        title: s.title || '(untitled)',
        status: this.pendingApproval.has(id) ? 'waiting' : s.status || 'idle',
        mode: s.mode || '',
        projectName: projectNameOf(s.workspace),
        projectPath: s.workspace || '',
        updatedAt: s.updatedAt || 0,
        lastText: s.lastText || '',
        waitingApproval: this.pendingApproval.has(id),
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
    const seen = new Set();
    let changed = false;
    for (const s of list) {
      const id = s.sessionId || s.id;
      if (!id) continue;
      seen.add(id);
      const prev = this.sessions.get(id);
      const status = String(s.status || prev?.status || 'idle').toLowerCase();
      const title = s.title ?? prev?.title ?? '';
      const workspace = s.workspace?.workspacePath ?? prev?.workspace ?? '';
      const updatedAt = Number(s.updatedAt ?? prev?.updatedAt ?? 0);
      if (!prev || prev.status !== status || prev.title !== title || prev.updatedAt !== updatedAt) {
        changed = true;
      }
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
    // Keep bridge-created sessions even if list pagination lags
    for (const id of [...this.transcripts.keys()]) if (!seen.has(id) && !this.sessions.has(id)) this.sessions.set(id, { status: 'unknown', updatedAt: 0 });
    if (changed) this._broadcastAll();
  }

  _touch(id, patch = {}) {
    const s = this.sessions.get(id) || { status: 'idle', updatedAt: 0 };
    this.sessions.set(id, { ...s, ...patch, updatedAt: Date.now() });
  }

  async createSession(projectPath) {
    if (!this.up) throw new Error('ZCode app-server is not running');
    const count = [...this.sessions.values()].filter((s) => s.status === 'running').length;
    if (count >= this.cfg.maxSessions) throw new Error(`max ${this.cfg.maxSessions} running sessions`);
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
      // Fill from persisted transcript, best effort
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
    if (this._subscribed?.has(id)) return;
    this._subscribed = this._subscribed || new Set();
    try {
      await this.client.request('session/subscribe', { sessionId: id, deliveryKind: 'web-remote-replayable' });
      this._subscribed.add(id);
    } catch (err) {
      const msg = String(err.message || '');
      if (/not active/i.test(msg)) {
        // Session owned by another process (desktop app / terminal). Try to take it over.
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
    this.pendingApproval.delete(id);
    this._touch(id, { status: 'running' });
    this._pushEvent(id, { kind: 'text', role: 'user', text: truncate(text, TEXT_LIMIT) });
    await this.client.request('session/send', { sessionId: id, content: String(text) }, 60000);
    this._broadcastAll();
  }

  async stopSession(id) {
    this.pendingApproval.delete(id);
    await this.client.request('session/stop', { sessionId: id }, 20000);
    this._touch(id, { status: 'stopped' });
    this._pushEvent(id, { kind: 'status', status: 'stopped' });
    this._broadcastAll();
  }

  async setMode(id, mode) {
    if (!['build', 'edit', 'plan', 'yolo'].includes(mode)) throw new Error('invalid mode');
    await this.client.request('session/setMode', { sessionId: id, mode }, 20000);
    this._touch(id, { mode });
    this._broadcastAll();
  }

  /**
   * Relay an approval decision made on the watch back into the session.
   * The exact upstream call is version-dependent, so try a small ladder.
   */
  async respondApproval(id, requestId, approved) {
    const pending = this.pendingApproval.get(id);
    this.pendingApproval.delete(id);
    const reason = approved ? 'Approved from Apple Watch' : 'Denied from Apple Watch';
    const item = { type: 'tool-approval-response', approvalId: requestId, approved, reason };
    const attempts = [
      () => this.client.request('session/send', { sessionId: id, content: [item] }, 30000),
      () => this.client.request('session/send', { sessionId: id, content: JSON.stringify([item]) }, 30000),
      () => this.client.request('session/approvalResponse', { sessionId: id, approvalId: requestId, approved, reason }, 30000),
    ];
    let lastErr;
    for (const attempt of attempts) {
      try {
        await attempt();
        this._pushEvent(id, { kind: 'status', status: 'running', note: approved ? 'approved' : 'denied' });
        this._broadcastAll();
        return { ok: true };
      } catch (err) {
        lastErr = err;
      }
    }
    this.log.warn(`approval relay failed for ${id}: ${lastErr.message}`);
    throw lastErr;
  }

  removeSession(id) {
    this.transcripts.delete(id);
    this.pendingApproval.delete(id);
    this.sessions.delete(id);
    this._subscribed?.delete(id);
    this._broadcastAll();
  }

  externalEvent(payload) {
    this.emit('external', payload);
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

  _onSessionEvent(params) {
    const id = params.sessionId || params.sessionID;
    if (!id) return;
    if (this.debugFile) {
      try {
        this.debugFile.write(JSON.stringify({ ts: Date.now(), params }) + '\n');
      } catch {}
    }
    const wire = this._classifyEvent(params);
    for (const ev of wire) this._pushEvent(id, ev);
    if (wire.length) this._broadcastAll();
  }

  _mapReadResult(id, read) {
    const items = Array.isArray(read?.items) ? read.items : Array.isArray(read) ? read : Array.isArray(read?.messages) ? read.messages : [];
    const events = [];
    for (const it of items) events.push(...this._classifyEvent({ sessionId: id, event: it }));
    return events.slice(-TRANSCRIPT_LIMIT);
  }

  /**
   * Tolerant classifier: the app-server event payload shape may evolve between
   * CLI versions. Match on well-known type/kind substrings and field names, and
   * drop anything unrecognized (captured to the debug file when enabled).
   */
  _classifyEvent(params) {
    const out = [];
    const candidates = [];
    if (Array.isArray(params?.items)) candidates.push(...params.items);
    if (params?.event) candidates.push(params.event);
    if (params?.item) candidates.push(params.item);
    if (params?.type || params?.kind) candidates.push(params);
    for (const e of candidates) {
      if (!e || typeof e !== 'object') continue;
      const t = String(e.type ?? e.kind ?? '').toLowerCase();
      const tool = e.toolName ?? e.tool_name ?? e.tool ?? e.name;
      if (t.includes('approval') || e.approvalId || t.includes('permission')) {
        out.push({
          kind: 'permission',
          requestId: String(e.approvalId ?? e.requestId ?? e.id ?? ''),
          tool: String(tool || 'tool'),
          summary: truncate(e.summary ?? e.title ?? e.reason ?? '', 200),
        });
        continue;
      }
      if (t.includes('tool')) {
        const done = /result|complete|finish|end|denied|failed/.test(t) || e.status === 'completed' || e.output !== undefined;
        out.push({
          kind: 'tool',
          tool: String(tool || 'tool'),
          state: done ? 'done' : 'started',
          detail: truncate(e.summary ?? e.title ?? (e.output !== undefined ? JSON.stringify(e.output) : ''), DETAIL_LIMIT),
        });
        continue;
      }
      const text = e.text ?? e.delta ?? (typeof e.content === 'string' ? e.content : e.content?.text) ?? e.message;
      if (t.includes('text') || t.includes('message') || t === 'assistant' || t === 'user' || (text && t.includes('chunk'))) {
        const role = String(e.role ?? (t === 'user' || t.includes('user') ? 'user' : 'assistant')).toLowerCase();
        if (text) out.push({ kind: 'text', role, text: truncate(text, TEXT_LIMIT) });
        continue;
      }
      if (t.includes('turn') || t.includes('result') || t.includes('complete') || t.includes('finish') || t.includes('idle') || t.includes('stop') || t.includes('status') || t.includes('state')) {
        const status = String(e.status ?? (t.includes('idle') ? 'idle' : t.includes('stop') ? 'stopped' : t.includes('fail') || e.isError ? 'failed' : t.includes('complete') || t.includes('result') ? 'idle' : t)).toLowerCase();
        this._touch(params.sessionId, { status });
        if (status === 'running') this._touch(params.sessionId, { status: 'running' });
        out.push({ kind: 'status', status });
        const resultText = e.result ?? e.lastAssistantMessage ?? e.finalText;
        if (resultText) out.push({ kind: 'result', text: truncate(resultText, TEXT_LIMIT), isError: !!e.isError });
        continue;
      }
      if (e.error || t.includes('error')) {
        out.push({ kind: 'error', message: truncate(e.error?.message ?? e.message ?? 'error', 300) });
        continue;
      }
      this.log.debug('unclassified event:', JSON.stringify(e).slice(0, 160));
    }
    // Keep session status fresh from status-bearing events
    return out;
  }

  _pushEvent(id, ev) {
    if (!this.transcripts.has(id)) this.transcripts.set(id, []);
    const list = this.transcripts.get(id);
    list.push(ev);
    if (list.length > TRANSCRIPT_LIMIT) list.splice(0, list.length - TRANSCRIPT_LIMIT);
    if (ev.kind === 'text') {
      this._touch(id, { lastText: ev.text, status: ev.role === 'user' ? 'running' : this.sessions.get(id)?.status });
    }
    if (ev.kind === 'permission' && ev.requestId) {
      this.pendingApproval.set(id, { requestId: ev.requestId, tool: ev.tool, summary: ev.summary });
      this._touch(id, { status: 'waiting' });
    }
    if (ev.kind === 'result' || (ev.kind === 'status' && ev.status !== 'running')) {
      this.pendingApproval.delete(id);
    }
    this.emit('event', id, ev);
  }

  _broadcastAll() {
    this.emit('changed');
  }
}
