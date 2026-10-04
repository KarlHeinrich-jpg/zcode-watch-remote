import crypto from 'node:crypto';

/**
 * Minimal RFC 6455 WebSocket server-side implementation (zero dependencies).
 * Handles the upgrade handshake, text frames, fragmentation, ping/pong and close.
 */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { cont: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa };
const MAX_MESSAGE = 4 * 1024 * 1024;

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

export class WebSocketConnection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOp = 0;
    this.alive = true;
    this.onmessage = null;
    this.onclose = null;
    this.missedPongs = 0;
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._closed());
    socket.on('error', () => this._closed());
  }

  _onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      let frame;
      try {
        frame = this._readFrame();
      } catch {
        this.close(1009);
        return;
      }
      if (!frame) return;
      this._handleFrame(frame);
      if (!this.alive) return;
    }
  }

  _readFrame() {
    const b = this.buffer;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const op = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(MAX_MESSAGE)) throw new Error('frame too large');
      len = Number(big);
      off = 10;
    }
    if (len > MAX_MESSAGE) throw new Error('frame too large');
    const maskLen = masked ? 4 : 0;
    if (b.length < off + maskLen + len) return null;
    let payload = b.subarray(off + maskLen, off + maskLen + len);
    if (masked) {
      const mask = b.subarray(off, off + 4);
      payload = Buffer.from(payload); // unshare before unmasking
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    }
    this.buffer = b.subarray(off + maskLen + len);
    return { fin, op, payload };
  }

  _handleFrame({ fin, op, payload }) {
    switch (op) {
      case OP.text:
      case OP.binary:
        if (fin) {
          if (this.fragments.length) this.fragments = [];
          this._emit(op, payload);
        } else {
          this.fragmentOp = op;
          this.fragments.push(payload);
        }
        break;
      case OP.cont:
        this.fragments.push(payload);
        if (Buffer.concat(this.fragments).length > MAX_MESSAGE) {
          this.close(1009);
          return;
        }
        if (fin) {
          const buf = Buffer.concat(this.fragments);
          this.fragments = [];
          this._emit(this.fragmentOp, buf);
        }
        break;
      case OP.ping:
        this._sendFrame(OP.pong, payload);
        break;
      case OP.pong:
        this.missedPongs = 0;
        break;
      case OP.close:
        try {
          this._sendFrame(OP.close, payload.subarray(0, Math.min(2, payload.length)));
        } catch {}
        this.socket.end();
        this._closed();
        break;
      default:
        break;
    }
  }

  _emit(op, payload) {
    if (this.onmessage) this.onmessage(payload.toString('utf8'), op);
  }

  _sendFrame(op, payload) {
    if (!this.alive) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | op, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | op;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | op;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  send(text) {
    if (this.alive) this._sendFrame(OP.text, Buffer.from(text, 'utf8'));
  }

  ping() {
    if (this.alive) this._sendFrame(OP.ping, Buffer.alloc(0));
  }

  close(code = 1000) {
    if (!this.alive) return;
    const body = Buffer.alloc(2);
    body.writeUInt16BE(code);
    try {
      this._sendFrame(OP.close, body);
      this.socket.end();
    } catch {}
    this._closed();
  }

  _closed() {
    if (!this.alive) return;
    this.alive = false;
    if (this.onclose) this.onclose();
  }
}

/** Perform the HTTP upgrade handshake; returns a WebSocketConnection or null. */
export function acceptWebSocket(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const upgrade = (req.headers.upgrade || '').toLowerCase();
  if (!key || upgrade !== 'websocket') {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return null;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n` +
      '\r\n'
  );
  socket.setNoDelay(true);
  return new WebSocketConnection(socket);
}
