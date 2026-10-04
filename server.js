'use strict';

const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOM_TTL_MS = 10 * 60 * 1000;
const MAX_ROOMS = 500;

const rooms = new Map();

const app = express();
app.disable('x-powered-by');

app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

app.get('/config.js', (req, res) => {
  const turn = [];
  if (process.env.TURN_URL) {
    turn.push({
      urls: process.env.TURN_URL.split(',').map((s) => s.trim()).filter(Boolean),
      username: process.env.TURN_USER || '',
      credential: process.env.TURN_PASS || ''
    });
  }
  res.type('application/javascript').send('window.__NETCFG=' + JSON.stringify({ turn }) + ';');
});

app.use(
  '/vendor',
  express.static(path.join(__dirname, 'node_modules', 'qrcode-generator'), {
    fallthrough: true,
    maxAge: '7d'
  })
);
app.get('/vendor/jsqr.js', (req, res) =>
  res.sendFile(path.join(__dirname, 'node_modules', 'jsqr', 'dist', 'jsQR.js'))
);

const INDEX = path.join(__dirname, 'public', 'index.html');
app.get('/', (req, res) => res.sendFile(INDEX));
app.get(/^\/r\/[A-Za-z0-9-]+$/, (req, res) => res.sendFile(INDEX));

app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 });

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeRoomId() {
  let id;
  do {
    const bytes = crypto.randomBytes(8);
    id = '';
    for (const b of bytes) id += ALPHABET[b % ALPHABET.length];
  } while (rooms.has(id));
  return id;
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function otherPeer(room, ws) {
  return room.peers.find((p) => p !== ws) || null;
}

function touch(room) {
  clearTimeout(room.timer);
  room.timer = setTimeout(() => closeRoom(room, 'expired'), ROOM_TTL_MS);
}

function closeRoom(room, reason) {
  clearTimeout(room.timer);
  rooms.delete(room.id);
  for (const p of room.peers) {
    p.room = null;
    send(p, { t: 'room-closed', reason });
  }
}

function detach(ws) {
  const room = ws.room;
  if (!room) return;
  ws.room = null;
  room.peers = room.peers.filter((p) => p !== ws);
  if (room.peers.length === 0) {
    clearTimeout(room.timer);
    rooms.delete(room.id);
  } else {
    send(room.peers[0], { t: 'peer-left' });
    touch(room);
  }
}

wss.on('connection', (ws) => {
  ws.room = null;
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.t) {
      case 'create': {
        if (ws.room) return;
        if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'error', reason: 'busy' });
        const id = makeRoomId();
        const room = { id, peers: [ws], timer: null };
        rooms.set(id, room);
        ws.room = room;
        touch(room);
        send(ws, { t: 'created', room: id });
        break;
      }

      case 'join': {
        if (ws.room) return;
        const id = String(msg.room || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        const room = rooms.get(id);
        if (!room) return send(ws, { t: 'error', reason: 'not-found' });
        if (room.peers.length >= 2) return send(ws, { t: 'error', reason: 'full' });
        room.peers.push(ws);
        ws.room = room;
        touch(room);
        send(room.peers[0], { t: 'peer-joined' });
        send(ws, { t: 'joined', room: id });
        break;
      }

      case 'signal': {
        const room = ws.room;
        if (!room || !msg.data) return;
        send(otherPeer(room, ws), { t: 'signal', data: msg.data });
        break;
      }

      case 'leave':
        detach(ws);
        break;
    }
  });

  ws.on('close', () => detach(ws));
  ws.on('error', () => detach(ws));
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

function lanUrl() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const i of ifs[name] || []) {
      if (i.family === 'IPv4' && !i.internal) return `http://${i.address}:${PORT}`;
    }
  }
  return null;
}

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Seconds Share is running');
  console.log('  -------------------------------');
  console.log(`  Local:   http://localhost:${PORT}`);
  const lan = lanUrl();
  if (lan) console.log(`  Phone:   ${lan}   (same Wi-Fi)`);
  console.log('');
});
