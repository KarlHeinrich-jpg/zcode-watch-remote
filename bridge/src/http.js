import os from 'node:os';
import { BRIDGE_VERSION } from './config.js';

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}

function statusPage({ cfg, hub, token }) {
  const sessions = hub.summaries();
  const rows = sessions
    .map(
      (s) => `<tr><td>${escapeHtml(s.projectName)}</td><td>${escapeHtml(s.title)}</td><td>${escapeHtml(s.status)}${s.waitingApproval ? ' ⚠ approval' : ''}</td><td>${new Date(s.updatedAt).toLocaleTimeString()}</td></tr>`
    )
    .join('\n');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>ZCode Watch Bridge</title>
<style>body{font-family:ui-sans-serif,system-ui;margin:2rem;max-width:52rem;color:#111}
code,pre{background:#f4f4f5;padding:2px 6px;border-radius:4px}table{border-collapse:collapse;width:100%}
td,th{border:1px solid #ddd;padding:6px 10px;text-align:left}th{background:#fafafa}</style></head>
<body>
<h1>🟢 ZCode Watch Bridge <small style="color:#888">v${BRIDGE_VERSION}</small></h1>
<p>Bridge name: <b>${escapeHtml(cfg.bridgeName)}</b> · Pairing PIN: <b style="font-size:1.3em">${escapeHtml(cfg.pin)}</b></p>
<p>Enter the address below in the ZCode Remote app on your Apple Watch:</p>
<p><code>${escapeHtml(lanAddresses(cfg.port).join(' &nbsp;|&nbsp; '))}</code></p>
<h2>Sessions (${sessions.length})</h2>
<table><tr><th>Project</th><th>Title</th><th>Status</th><th>Updated</th></tr>${rows || '<tr><td colspan="4">No sessions yet</td></tr>'}</table>
<h2>Notify from ZCode hooks</h2>
<pre>curl "http://127.0.0.1:${cfg.port}/hook?token=${token.slice(0, 4)}…&amp;event=stop&amp;message=Task%20done"</pre>
<p style="color:#888">The full token is in <code>${escapeHtml(cfg.configFile)}</code> — keep it on the LAN only.</p>
</body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** LAN IPv4 addresses where the bridge is reachable, e.g. ws://192.168.1.5:8788 */
export function lanAddresses(port) {
  const out = [];
  for (const ifs of Object.values(os.networkInterfaces())) {
    for (const addr of ifs || []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push(`ws://${addr.address}:${port}`);
    }
  }
  if (!out.length) out.push(`ws://127.0.0.1:${port}`);
  return out;
}

export function createHttpHandler({ cfg, hub, log, broadcastExternal }) {
  return function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (p === '/health') {
      json(res, 200, { ok: hub.up, bridge: cfg.bridgeName, version: BRIDGE_VERSION, appServer: hub.up ? 'up' : 'down' });
      return;
    }

    if (p === '/hook') {
      const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const token = bearer || url.searchParams.get('token') || '';
      if (token !== cfg.token) {
        json(res, 401, { ok: false, error: 'invalid token' });
        return;
      }
      const respond = () => json(res, 200, { ok: true });
      if (req.method === 'GET') {
        broadcastExternal({
          event: url.searchParams.get('event') || 'notification',
          message: url.searchParams.get('message') || '',
          project: url.searchParams.get('project') || '',
        });
        respond();
        return;
      }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (d) => {
          body += d;
          if (body.length > 65536) req.destroy();
        });
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body || '{}');
            broadcastExternal({
              event: String(parsed.event || 'notification'),
              message: String(parsed.message || ''),
              project: String(parsed.project || ''),
            });
          } catch {
            json(res, 400, { ok: false, error: 'invalid JSON' });
            return;
          }
          respond();
        });
        return;
      }
      json(res, 405, { ok: false, error: 'method not allowed' });
      return;
    }

    if (p === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(statusPage({ cfg, hub, token: cfg.token }));
      return;
    }

    json(res, 404, { ok: false, error: 'not found' });
  };
}
