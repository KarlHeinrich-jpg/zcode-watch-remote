import http from 'node:http';
import crypto from 'node:crypto';

/** Minimal WebSocket *client* (sends masked frames) for the e2e test. */
export class WsClient {
  static connect(url) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const key = crypto.randomBytes(16).toString('base64');
      const req = http.request({
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13',
        },
      });
      req.on('upgrade', (res, socket) => {
        const expect = crypto
          .createHash('sha1')
          .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
          .digest('base64');
        if (res.headers['sec-websocket-accept'] !== expect) {
          reject(new Error('bad Sec-WebSocket-Accept'));
          return;
        }
        resolve(new WsClient(socket));
      });
      req.on('response', (r) => reject(new Error('no upgrade, status ' + r.statusCode)));
      req.on('error', reject);
      req.end();
    });
  }

  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.onmessage = null;
    this.onclose = null;
    socket.on('data', (d) => {
      this.buffer = Buffer.concat([this.buffer, d]);
      for (;;) {
        const f = this._frame();
        if (!f) break;
        this._handle(f);
      }
    });
    socket.on('close', () => this.onclose?.());
    socket.on('error', () => this.onclose?.());
  }

  _frame() {
    const b = this.buffer;
    if (b.length < 2) return null;
    const op = b[0] & 0x0f;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      len = Number(b.readBigUInt64BE(2));
      off = 10;
    }
    if (b.length < off + len) return null;
    const payload = Buffer.from(b.subarray(off, off + len));
    this.buffer = b.subarray(off + len);
    return { op, payload };
  }

  _handle(f) {
    if (f.op === 0x9) {
      this._send(0xa, f.payload); // pong
      return;
    }
    if (f.op === 0x8) {
      this.socket.end();
      this.onclose?.();
      return;
    }
    if (f.op === 0x1) this.onmessage?.(f.payload.toString('utf8'));
  }

  _send(op, payload) {
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x80 | op, 0x80 | len]);
    else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | op;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | op;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  send(text) {
    this._send(0x1, Buffer.from(text, 'utf8'));
  }

  close() {
    try {
      this._send(0x8, Buffer.alloc(2));
    } catch {}
    try {
      this.socket.end();
    } catch {}
  }
}
