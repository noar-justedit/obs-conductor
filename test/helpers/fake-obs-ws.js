'use strict';
// A tiny obs-websocket v5 server for the tests: Hello, Identify with the
// password challenge, Identified or close 4009. Enough to test discovery.
const http = require('http');
const crypto = require('crypto');

const b64sha = s => crypto.createHash('sha256').update(s).digest('base64');

function frame(text) {
  const p = Buffer.from(text);
  const h = p.length < 126 ? Buffer.from([0x81, p.length]) : Buffer.from([0x81, 126, p.length >> 8, p.length & 255]);
  return Buffer.concat([h, p]);
}
function closeFrame(code) { return Buffer.from([0x88, 2, code >> 8, code & 255]); }

function readFrames(buf, onText) {
  while (buf.length >= 2) {
    const op = buf[0] & 15;
    let len = buf[1] & 127, off = 2;
    if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
    const mask = buf.slice(off, off + 4); off += 4;
    if (buf.length < off + len) break;
    const data = Buffer.from(buf.slice(off, off + len)).map((b, i) => b ^ mask[i % 4]);
    if (op === 1) onText(data.toString());
    buf = buf.slice(off + len);
  }
  return buf;
}

function startFakeObsWs({ password = 'secret', port = 0 } = {}) {
  const server = http.createServer((req, res) => { res.writeHead(426); res.end(); });
  const socks = new Set();
  server.shutdown = () => { for (const s of socks) s.destroy(); server.closeAllConnections(); server.close(); };
  server.on('upgrade', (req, sock) => {
    socks.add(sock); sock.on('close', () => socks.delete(sock));
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: obswebsocket.json\r\n\r\n`);
    const salt = 'salt123', challenge = 'chal456';
    sock.write(frame(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.5.2', rpcVersion: 1,
      authentication: password ? { salt, challenge } : undefined } })));
    let buf = Buffer.alloc(0);
    sock.on('data', d => {
      buf = readFrames(Buffer.concat([buf, d]), text => {
        const m = JSON.parse(text);
        if (m.op !== 1) return;
        const want = password ? b64sha(b64sha(password + salt) + challenge) : undefined;
        if (password && m.d.authentication !== want) { sock.end(closeFrame(4009)); return; }
        sock.write(frame(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } })));
      });
    });
    sock.on('error', () => {});
  });
  return new Promise(r => server.listen(port, '127.0.0.1', () => r(server)));
}

module.exports = { startFakeObsWs };
