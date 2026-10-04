import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';

/**
 * Speaks the "ZCode Protocol" with `zcode app-server --stdio`:
 *   client -> server: {"id": "...", "method": "session/...", "params": {...}}   (newline-delimited JSON)
 *   server -> client: {"id": "...", "result": ...} | {"id": ..., "error": {...}} | {"method": "...", "params": {...}}
 * The server may also send requests (id + method, no result) which must be answered.
 */
export class ZcodeClient extends EventEmitter {
  constructor({ command, args, shell, log }) {
    super();
    this.command = command;
    this.args = args;
    this.shell = shell;
    this.log = log;
    this.child = null;
    this.seq = 0;
    this.pending = new Map();
    this.stopped = false;
    this.ready = false;
    this.restartTimer = null;
  }

  start() {
    this.stopped = false;
    this._spawn();
  }

  _spawn() {
    let child;
    try {
      child = spawn(this.command, this.args, {
        shell: !!this.shell,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, ZCODE_WATCH_REMOTE: '1' },
      });
    } catch (err) {
      this.emit('fatal', err);
      return;
    }
    this.child = child;
    this.ready = false;
    this.log.info(`spawning app-server: ${this.command} ${this.args.join(' ')}`);

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => this._onLine(line));

    child.stderr.setEncoding('utf8');
    let stderrTail = '';
    child.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d).slice(-2000);
      this.log.debug('zcode stderr:', String(d).trim().slice(0, 200));
    });

    child.on('error', (err) => {
      if (!this.ready) this.emit('fatal', err);
      else this.log.warn('child error:', err.message);
    });

    child.on('exit', (code) => {
      this.ready = false;
      for (const p of this.pending.values()) p.reject(new Error(`app-server exited (code ${code})`));
      this.pending.clear();
      this.emit('down');
      if (!this.stopped) {
        this.log.warn(`app-server exited (code ${code}). stderr tail: ${stderrTail.trim().slice(-300) || '(empty)'}`);
        this.log.warn('restarting app-server in 3s...');
        this.restartTimer = setTimeout(() => {
          if (!this.stopped) this._spawn();
        }, 3000);
      }
    });
  }

  _onLine(line) {
    line = line.trim();
    if (!line) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.log.debug('non-JSON output:', line.slice(0, 120));
      return;
    }
    // Server -> client request: has id + method, no result/error. Must be answered.
    if (msg.id !== undefined && msg.method && msg.result === undefined && msg.error === undefined) {
      this._answerServerRequest(msg);
      return;
    }
    // Response to one of our requests
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    // Notification
    if (msg.method) this.emit('notification', msg);
    if (!this.ready) {
      this.ready = true;
      this.emit('up');
    }
  }

  _answerServerRequest(msg) {
    const reply = (result) => {
      try {
        this.child.stdin.write(JSON.stringify({ id: msg.id, result }) + '\n');
      } catch {}
    };
    if (msg.method === 'session/requestRuntimePreferences') {
      reply({
        nativeSearchEnhancementsEnabled: false,
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: true,
        modelContextBudgetStrategy: 'preflight-v1',
      });
      return;
    }
    this.log.debug(`auto-acking server request: ${msg.method}`);
    reply({});
  }

  request(method, params = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.child || !this.child.stdin.writable) {
        reject(new Error('app-server not running'));
        return;
      }
      const id = `c${++this.seq}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.log.debug(`> ${method}`);
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    const child = this.child;
    if (!child) return;
    try {
      if (process.platform === 'win32' && child.pid) {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        child.kill('SIGTERM');
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {}
        }, 2000);
      }
    } catch {}
  }
}
