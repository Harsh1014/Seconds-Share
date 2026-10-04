'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 5600 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const TMP_A = path.join(os.tmpdir(), `seconds-share-e2e-a-${process.pid}.bin`);
const TMP_B = path.join(os.tmpdir(), `seconds-share-e2e-b-${process.pid}.dat`);
const TMP_C = path.join(os.tmpdir(), `seconds-share-e2e-c-${process.pid}.empty`);
const ALL = [TMP_A, TMP_C, TMP_B];

const TEXT_MSG = 'hello from the other side';

let child = null;
let browser = null;
const expected = new Map();

function waitForServer(retries = 100) {
  return new Promise((resolve, reject) => {
    const tryOnce = (n) => {
      fetch(BASE + '/health')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('bad'))))
        .then(resolve)
        .catch(() => (n <= 0 ? reject(new Error('server did not start')) : setTimeout(() => tryOnce(n - 1), 100)));
    };
    tryOnce(retries);
  });
}

async function click(page, selector) {
  await page.evaluate((sel) => {
    const node = document.querySelector(sel);
    if (!node) throw new Error('missing element ' + sel);
    node.click();
  }, selector);
}

async function race(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(label + ' hung for ' + ms + 'ms')), ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function hashExpr() {
  return `Array.from(new Uint8Array(d)).map((x) => x.toString(16).padStart(2, '0')).join('')`;
}

before(async () => {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore'
  });
  await waitForServer();

  const a = crypto.randomBytes(4 * 1024 * 1024);
  const b = crypto.randomBytes(256 * 1024);
  fs.writeFileSync(TMP_A, a);
  fs.writeFileSync(TMP_B, b);
  fs.writeFileSync(TMP_C, Buffer.alloc(0));
  expected.set(path.basename(TMP_A), sha256(a));
  expected.set(path.basename(TMP_B), sha256(b));
  expected.set(path.basename(TMP_C), sha256(Buffer.alloc(0)));

  browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
});

after(async () => {
  if (browser) await browser.close().catch(() => {});
  if (child) child.kill();
  for (const f of [TMP_A, TMP_B, TMP_C]) {
    try {
      fs.unlinkSync(f);
    } catch {}
  }
});

test('scan link -> connect -> multi-file + text peer to peer', { timeout: 120000 }, async () => {
  const pageA = await browser.newPage();
  const pageB = await browser.newPage();
  const errors = [];
  pageA.on('pageerror', (e) => errors.push('A: ' + e.message));
  pageB.on('pageerror', (e) => errors.push('B: ' + e.message));

  // 1. A creates a room and shows a QR
  await pageA.goto(BASE + '/', { waitUntil: 'load' });
  await pageA.waitForSelector('#scr-home:not(.hidden)');
  await click(pageA, '#btn-create');
  let qrReady = false;
  const qrTl = [];
  for (let i = 0; i < 40; i++) {
    const snap = await pageA.evaluate(() => ({
      screen: document.querySelector('.screen:not(.hidden)')?.id,
      status: document.getElementById('status-text')?.textContent,
      err: document.getElementById('home-error').textContent,
      toast: document.getElementById('toast').textContent,
      state: window.__ss.state()
    }));
    qrTl.push(`+${(i * 0.5).toFixed(1)}s ${snap.screen}/${snap.status} state=${JSON.stringify(snap.state)}`);
    if (snap.screen === 'scr-wait') {
      qrReady = true;
      break;
    }
    if (snap.err || (snap.toast && snap.toast !== 'Transfer received')) {
      qrTl.push(`  err="${snap.err}" toast="${snap.toast}"`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!qrReady) {
    throw new Error('QR never appeared. page errors: ' + JSON.stringify(errors) + '\n' + qrTl.join('\n'));
  }

  const link = await pageA.$eval('#link-text', (el) => el.value);
  assert.match(link, /\/r\/[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const qrHtml = await pageA.$eval('#qr', (el) => el.innerHTML);
  assert.match(qrHtml, /<svg/);

  // 2. B "scans" the link and both connect
  await pageB.goto(link, { waitUntil: 'load' });
  const screenOf = (p) => p.evaluate(() => document.querySelector('.screen:not(.hidden)')?.id);
  let connected = false;
  const connTl = [];
  for (let i = 0; i < 40; i++) {
    const [sa, sb] = [await screenOf(pageA), await screenOf(pageB)];
    connTl.push(`+${(i * 0.5).toFixed(1)}s A=${sa} B=${sb}`);
    if (sa === 'scr-room' && sb === 'scr-room') {
      connected = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!connected) throw new Error('connect timeline:\n' + connTl.join('\n'));

  assert.match(await pageA.$eval('#status', (el) => el.className), /ok/);

  // 3. A sends two files
  const input = await pageA.$('#in-files');
  await race(input.uploadFile(...ALL), 10000, 'uploadFile');

  const senderHashes = await pageA.evaluate(async (expr) => {
    const out = {};
    for (const f of window.__ss.sent()) {
      const buf = await f.arrayBuffer();
      const d = await crypto.subtle.digest('SHA-256', buf);
      out[f.name] = eval(expr);
    }
    return out;
  }, hashExpr());
  assert.deepEqual(Object.keys(senderHashes).sort(), ALL.map((f) => path.basename(f)).sort());
  for (const [name, hash] of Object.entries(senderHashes)) {
    assert.equal(hash, expected.get(name), 'sender reads ' + name + ' correctly');
  }

  // 4. B receives all three (empty file sits in the middle), byte-for-byte
  let receivedCount = 0;
  for (let i = 0; i < 60 && receivedCount < 3; i++) {
    receivedCount = await pageB.evaluate(() => window.__ss.files().filter((f) => f.done && f.blob).length);
    if (receivedCount < 3) await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(receivedCount, 3, 'all three files received');

  const receivedHashes = await pageB.evaluate(async (expr) => {
    const out = {};
    for (const f of window.__ss.files()) {
      const buf = await f.blob.arrayBuffer();
      const d = await crypto.subtle.digest('SHA-256', buf);
      out[f.name] = eval(expr);
      out[f.name + '#size'] = f.blob.size;
      out[f.name + '#sink'] = !!f.usedSink;
    }
    return out;
  }, hashExpr());

  for (const src of ALL) {
    const name = path.basename(src);
    assert.equal(receivedHashes[name], expected.get(name), 'received bytes of ' + name + ' match exactly');
    assert.equal(receivedHashes[name + '#size'], fs.statSync(src).size, 'received size of ' + name);
  }
  assert.equal(receivedHashes[path.basename(TMP_A) + '#sink'], true, '4 MB file streamed to disk (OPFS)');
  assert.equal(receivedHashes[path.basename(TMP_B) + '#sink'], false, 'small file used memory path');
  assert.equal(receivedHashes[path.basename(TMP_C) + '#sink'], false, 'empty file used memory path');

  // 5. A shows all rows as Sent
  const sentRow = await pageA.$$eval('#tr-list .tr.out .tr-state', (els) => els.map((e) => e.textContent));
  assert.equal(sentRow.filter((t) => t.startsWith('Sent')).length, 3, 'sender rows marked Sent: ' + JSON.stringify(sentRow));

  // 6. B sends text back - guest device must be able to send too
  await pageB.evaluate((msg) => {
    document.getElementById('btn-text').click();
    document.getElementById('txt').value = msg;
  }, TEXT_MSG);
  await click(pageB, '#btn-send-text');

  let textOk = false;
  for (let i = 0; i < 30 && !textOk; i++) {
    textOk = await pageA.evaluate(
      (msg) => Array.from(document.querySelectorAll('#tr-list .text-in-body')).some((e) => e.textContent === msg),
      TEXT_MSG
    );
    if (!textOk) await new Promise((r) => setTimeout(r, 500));
  }
  if (!textOk) {
    const diag = {
      B: await pageB.evaluate(() => ({ toast: document.getElementById('toast').textContent, state: window.__ss.state() })),
      A: await pageA.evaluate(() => ({ state: window.__ss.state(), list: document.getElementById('tr-list').textContent }))
    };
    throw new Error('text never arrived: ' + JSON.stringify(diag));
  }

  assert.deepEqual(errors, [], 'no page errors: ' + errors.join('; '));

  await pageA.close();
  await pageB.close();
});

