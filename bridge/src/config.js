import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const BRIDGE_VERSION = '0.1.0';
export const DEFAULT_PORT = 8788;

export function configDir() {
  return process.env.ZCODE_REMOTE_CONFIG_DIR || path.join(os.homedir(), '.zcode-watch-remote');
}

function configFilePath(override) {
  return override || path.join(configDir(), 'config.json');
}

function randomPin() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

export function loadConfig(argv = process.argv.slice(2)) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') flags.port = Number(argv[++i]);
    else if (a === '--config') flags.configFile = argv[++i];
    else if (a === '--reset-pin') flags.resetPin = true;
    else if (a === '--help' || a === '-h') flags.help = true;
  }

  const file = configFilePath(flags.configFile);
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // first run or unreadable — start fresh
  }

  const cfg = {
    port: stored.port ?? DEFAULT_PORT,
    bind: stored.bind ?? '0.0.0.0',
    bridgeName: stored.bridgeName ?? os.hostname(),
    pin: stored.pin ?? randomPin(),
    token: stored.token ?? crypto.randomBytes(24).toString('hex'),
    // Empty command -> auto-detect (env var, desktop app bundle, PATH)
    command: stored.command ?? '',
    appServerArgs: stored.appServerArgs ?? ['app-server', '--stdio'],
    // Default permission mode for sessions created from the watch: build | edit | plan | yolo
    mode: stored.mode ?? 'build',
    // Directories the watch is allowed to open new sessions in. Empty -> cwd.
    allowedProjects: stored.allowedProjects ?? [],
    maxSessions: stored.maxSessions ?? 8,
    // Forward unrecognized session/event payloads to a debug file for protocol iteration
    debugEvents: stored.debugEvents ?? false,
    configFile: file,
    help: !!flags.help,
  };

  if (flags.port) cfg.port = flags.port;
  if (flags.resetPin) {
    cfg.pin = randomPin();
    cfg.token = crypto.randomBytes(24).toString('hex');
  }

  return cfg;
}

export function saveConfig(cfg) {
  const { configFile, ...persist } = cfg;
  const dir = path.dirname(configFile);
  fs.mkdirSync(dir, { recursive: true });
  const prev = {};
  try {
    Object.assign(prev, JSON.parse(fs.readFileSync(configFile, 'utf8')));
  } catch {}
  // Keep runtime-only keys out of the file
  delete persist.debugEvents;
  fs.writeFileSync(configFile, JSON.stringify({ ...prev, ...persist }, null, 2));
}

/**
 * Split a config-supplied command line like `node C:\path\zcode.cjs` or
 * `"/Applications/ZCode.app/.../zcode" app-server` into tokens, honoring quotes.
 */
function tokenize(line) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * Locate the zcode CLI that speaks the "ZCode Protocol" (`zcode app-server --stdio`).
 * Priority: $ZCODE_BIN -> config.command -> desktop app bundle -> PATH.
 * Returns { command, args, shell } or null.
 *
 * Accepts, in order of specificity:
 *   - a path to zcode.cjs / zcode.mjs (run with the current node)
 *   - a full command line, e.g. `node /opt/zcode/zcode.cjs` or `/usr/local/bin/zcode`
 *   - a bare executable name resolved through PATH
 */
export function resolveZcodeCommand(cfg) {
  const args = [...cfg.appServerArgs];
  const candidates = [];
  if (process.env.ZCODE_BIN) candidates.push(process.env.ZCODE_BIN);
  if (cfg.command) candidates.push(cfg.command);
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'ZCode', 'resources', 'glm', 'zcode.cjs'));
    candidates.push('C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs');
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs');
  }
  candidates.push('zcode'); // PATH fallback

  for (const c of candidates) {
    if (!c) continue;
    const tokens = tokenize(c);
    if (!tokens.length) continue;

    // 1) A script/binary path, possibly preceded by `node` (or another runner)
    const head = tokens[0];
    const tail = tokens.slice(1);
    const scriptIsLast = /\.(cjs|mjs|js)$/i.test(tokens[tokens.length - 1]);
    if (scriptIsLast) {
      const script = tokens[tokens.length - 1];
      if (fs.existsSync(script)) {
        const runner = tail.length > 1 ? { command: head, args: tail.slice(0, -1) } : { command: process.execPath, args: [] };
        return { ...runner, args: [...runner.args, script, ...args], shell: false };
      }
      continue;
    }

    // 2) A plain executable path (absolute or relative)
    if (head.includes('/') || head.includes('\\')) {
      if (fs.existsSync(head)) return { command: head, args: [...tail, ...args], shell: false };
      continue;
    }

    // 3) Bare command name: let a shell resolve it (.cmd/.ps1 shims on Windows)
    const line = [head, ...tail, ...args].join(' ');
    return { command: line, args: [], shell: process.platform === 'win32' };
  }
  return null;
}
