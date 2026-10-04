'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const WebSocket = require('ws');

const PORT = 3400 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
let child = null;

function waitForServer(retries = 100) {
  return new Promise((resolve, reject) => {
    const tryOnce = (n) => {
      fetch(BASE + '/health')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('bad status'))))
        .then(resolve)
        .catch(() => {
          if (n <= 0) return reject(new Error('server did not start'));
          setTimeout(() => tryOnce(n - 1), 100);
        });
    };
    tryOnce(retries);
  });
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    ws.inbox = [];
    ws.waiters = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const i = ws.waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) {
        const w = ws.waiters.splice(i, 1)[0];
        clearTimeout(w.timer);
        w.resolve(msg);
      } else {
        ws.inbox.push(msg);
      }
    });
    ws.next = (pred, ms = 4000) =>
      new Promise((res, rej) => {
        const i = ws.inbox.findIndex(pred);
        if (i >= 0) return res(ws.inbox.splice(i, 1)[0]);
        const w = { pred, resolve: res, reject: rej };
        w.timer = setTimeout(() => {
          const j = ws.waiters.indexOf(w);
          if (j >= 0) ws.waiters.splice(j, 1);
          rej(new Error('timeout waiting for message'));
        }, ms);
        ws.waiters.push(w);
      });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

before(async () => {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForServer();
});

after(() => {
  if (child) child.kill();
});

test('serves the app shell', async () => {
  const res = await fetch(BASE + '/');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Seconds Share/);
  assert.match(html, /scr-home/);
});

test('serves room deep link as the app', async () => {
  const res = await fetch(BASE + '/r/ABCD1234');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /scr-home/);
});

test('serves config and vendor bundles', async () => {
  const cfg = await fetch(BASE + '/config.js');
  assert.equal(cfg.status, 200);
  assert.match(await cfg.text(), /__NETCFG/);
  const qr = await fetch(BASE + '/vendor/qrcode.js');
  assert.equal(qr.status, 200);
  const scanner = await fetch(BASE + '/vendor/jsqr.js');
  assert.equal(scanner.status, 200);
  const app = await fetch(BASE + '/app.js');
  assert.equal(app.status, 200);
  assert.match(await (await fetch(BASE + '/')).text(), /btn-scan/);
});

test('create -> join -> signal relay -> peer-left', async () => {
  const host = await connect();
  host.send(JSON.stringify({ t: 'create' }));
  const created = await host.next((m) => m.t === 'created');
  assert.match(created.room, /^[A-HJ-NP-Z2-9]{8}$/);

  const guest = await connect();
  guest.send(JSON.stringify({ t: 'join', room: created.room }));
  const joined = await guest.next((m) => m.t === 'joined');
  assert.equal(joined.room, created.room);

  const peerJoined = await host.next((m) => m.t === 'peer-joined');
  assert.ok(peerJoined);

  host.send(JSON.stringify({ t: 'signal', data: { sdp: { type: 'offer', sdp: 'v=0' } } }));
  const relayed = await guest.next((m) => m.t === 'signal');
  assert.equal(relayed.data.sdp.type, 'offer');

  guest.send(JSON.stringify({ t: 'signal', data: { candidate: { candidate: 'cand' } } }));
  const back = await host.next((m) => m.t === 'signal');
  assert.equal(back.data.candidate.candidate, 'cand');

  guest.close();
  const left = await host.next((m) => m.t === 'peer-left');
  assert.ok(left);

  host.close();
});

test('joining an unknown room reports not-found', async () => {
  const ws = await connect();
  ws.send(JSON.stringify({ t: 'join', room: 'ZZZZZZZZ' }));
  const err = await ws.next((m) => m.t === 'error');
  assert.equal(err.reason, 'not-found');
  ws.close();
});

test('third peer is rejected with full', async () => {
  const host = await connect();
  host.send(JSON.stringify({ t: 'create' }));
  const created = await host.next((m) => m.t === 'created');

  const guest = await connect();
  guest.send(JSON.stringify({ t: 'join', room: created.room }));
  await guest.next((m) => m.t === 'joined');
  await host.next((m) => m.t === 'peer-joined');

  const third = await connect();
  third.send(JSON.stringify({ t: 'join', room: created.room }));
  const err = await third.next((m) => m.t === 'error');
  assert.equal(err.reason, 'full');

  third.close();
  guest.close();
  host.close();
});
