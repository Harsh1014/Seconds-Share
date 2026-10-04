'use strict';

(() => {
  const $ = (id) => document.getElementById(id);

  const el = {
    status: $('status'),
    statusText: $('status-text'),
    home: $('scr-home'),
    wait: $('scr-wait'),
    conn: $('scr-conn'),
    room: $('scr-room'),
    btnCreate: $('btn-create'),
    frmOpen: $('frm-open'),
    inpOpen: $('inp-open'),
    btnScan: $('btn-scan'),
    scanPanel: $('scan-panel'),
    scanVideo: $('scan-video'),
    scanStatus: $('scan-status'),
    btnScanCancel: $('btn-scan-cancel'),
    homeError: $('home-error'),
    qr: $('qr'),
    linkText: $('link-text'),
    btnCopy: $('btn-copy'),
    btnCancel: $('btn-cancel'),
    connText: $('conn-text'),
    peerText: $('peer-text'),
    btnLeave: $('btn-leave'),
    btnFiles: $('btn-files'),
    btnFolder: $('btn-folder'),
    btnPhoto: $('btn-photo'),
    btnText: $('btn-text'),
    textBox: $('text-box'),
    txt: $('txt'),
    btnSendText: $('btn-send-text'),
    inFiles: $('in-files'),
    inFolder: $('in-folder'),
    inPhoto: $('in-photo'),
    trList: $('tr-list'),
    trEmpty: $('tr-empty'),
    rate: $('rate'),
    btnSaveAll: $('btn-save-all'),
    toast: $('toast')
  };

  const screens = [el.home, el.wait, el.conn, el.room];
  const isIOS =
    /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  let shareUrl = '';
  let scanStream = null;
  let scanFrame = null;
  let scanActive = false;
  let lastScanFrameAt = 0;
  const scanCanvas = document.createElement('canvas');
  const scanContext = scanCanvas.getContext('2d', { willReadFrequently: true });
  let wakeLock = null;
  let toastTimer = null;
  let activeInBatch = null;
  let lastSent = [];
  const receivedFiles = [];
  const outBatches = new Map();
  const inRows = new Map();
  const inRate = makeTracker();
  const outRate = makeTracker();

  function makeTracker() {
    return {
      last: 0,
      t: 0,
      ema: 0,
      activeUntil: 0,
      update(bytes, now) {
        if (this.t) {
          const dt = (now - this.t) / 1000;
          if (dt > 0.05) {
            const inst = Math.max(0, (bytes - this.last) / dt);
            this.ema = this.ema ? this.ema * 0.7 + inst * 0.3 : inst;
            this.last = bytes;
            this.t = now;
          }
        } else {
          this.last = bytes;
          this.t = now;
        }
        this.activeUntil = now + 1500;
      },
      reset() {
        this.last = 0;
        this.t = 0;
        this.ema = 0;
        this.activeUntil = 0;
      }
    };
  }

  function show(screen) {
    screens.forEach((s) => s.classList.toggle('hidden', s !== screen));
  }

  function setStatus(kind, text) {
    el.status.className = 'pill ' + kind;
    el.statusText.textContent = text;
  }

  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 2600);
  }

  function homeError(msg) {
    el.homeError.textContent = msg;
    el.homeError.classList.toggle('hidden', !msg);
  }

  function fmtBytes(b) {
    if (b < 1024) return b + ' B';
    const u = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do {
      b /= 1024;
      i++;
    } while (b >= 1024 && i < u.length - 1);
    return (b < 10 ? b.toFixed(1) : Math.round(b)) + ' ' + u[i];
  }

  function fmtEta(sec) {
    sec = Math.max(1, Math.round(sec));
    if (sec < 60) return sec + 's left';
    return Math.floor(sec / 60) + 'm ' + (sec % 60) + 's left';
  }

  function safeName(name) {
    return String(name || 'file').replace(/[\\/:*?"<>|]+/g, '_');
  }

  function prettyRoom(id) {
    return id.length === 8 ? id.slice(0, 4) + '-' + id.slice(4) : id;
  }

  function goHome(msg) {
    stopQrScan();
    if (location.pathname !== '/') history.replaceState(null, '', '/');
    shareUrl = '';
    outBatches.clear();
    inRows.clear();
    activeInBatch = null;
    receivedFiles.length = 0;
    el.trList.innerHTML = '';
    el.rate.textContent = '';
    el.trEmpty.classList.remove('hidden');
    el.btnSaveAll.classList.add('hidden');
    el.textBox.classList.add('hidden');
    el.txt.value = '';
    inRate.reset();
    outRate.reset();
    releaseWake();
    show(el.home);
    setStatus('idle', 'Ready');
    homeError(msg || '');
  }

  async function keepAwake() {
    try {
      if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) {
      /* not supported */
    }
  }

  function releaseWake() {
    try {
      if (wakeLock) wakeLock.release();
    } catch (e) {}
    wakeLock = null;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !el.room.classList.contains('hidden')) keepAwake();
  });

  /* ---------------- transfer rows ---------------- */

  function makeRow(opts) {
    const li = document.createElement('li');
    li.className = 'tr ' + (opts.dir === 'out' ? 'out' : 'in');
    li.innerHTML =
      '<div class="tr-main"><span class="tr-name"></span><span class="tr-sub"></span></div>' +
      '<div class="tr-bar"><i></i></div>' +
      '<div class="tr-foot"><span class="tr-state"></span></div>';
    li.querySelector('.tr-name').textContent = opts.name;
    li.querySelector('.tr-name').title = opts.name;
    li.querySelector('.tr-sub').textContent = opts.size != null ? fmtBytes(opts.size) : '';
    li.querySelector('.tr-state').textContent = opts.state || '';
    el.trList.appendChild(li);
    el.trEmpty.classList.add('hidden');
    return {
      li,
      bar: li.querySelector('.tr-bar i'),
      barWrap: li.querySelector('.tr-bar'),
      state: li.querySelector('.tr-state'),
      sub: li.querySelector('.tr-sub'),
      setPct(p) {
        this.bar.style.width = Math.max(0, Math.min(100, p)) + '%';
      },
      setState(text) {
        this.state.textContent = text;
      },
      noBar() {
        this.barWrap.classList.add('no-bar');
        this.sub.textContent = '';
      }
    };
  }

  function addSaveButton(row, file) {
    const foot = row.li.querySelector('.tr-foot');
    let btn = foot.querySelector('.save');
    if (!btn) {
      btn = document.createElement('button');
      btn.className = 'btn primary sm save';
      btn.type = 'button';
      foot.appendChild(btn);
    }
    btn.textContent = 'Save';
    btn.onclick = () => {
      if (saveFile(file)) btn.textContent = 'Save again';
    };
    el.btnSaveAll.classList.remove('hidden');
  }

  function saveFile(file) {
    if (!file.blob) return false;
    const name = safeName(file.name);
    const native = file.blob instanceof File && safeName(file.blob.name) === name ? file.blob : null;
    if (isIOS && navigator.canShare && navigator.share) {
      const f = native || new File([file.blob], name, { type: file.type });
      if (navigator.canShare({ files: [f] })) {
        navigator
          .share({ files: [f] })
          .then(() => {
            file.saved = true;
          })
          .catch(() => {});
        return true;
      }
    }
    try {
      const url = URL.createObjectURL(file.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 120000);
      file.saved = true;
      return true;
    } catch (e) {
      toast('Tap Save and choose where to keep it');
      return false;
    }
  }

  function rateLine(remaining) {
    const now = performance.now();
    const parts = [];
    if (inRate.activeUntil > now && inRate.ema > 0) parts.push(fmtBytes(inRate.ema) + '/s in');
    if (outRate.activeUntil > now && outRate.ema > 0) parts.push(fmtBytes(outRate.ema) + '/s out');
    if (remaining > 0) {
      const dirIn = inRate.activeUntil > now;
      const tracker = dirIn ? inRate : outRate;
      if (tracker.ema > 0) parts.push(fmtEta(remaining / tracker.ema));
    }
    el.rate.textContent = parts.join(' · ');
  }

  setInterval(() => rateLine(0), 400);

  /* ---------------- net events ---------------- */

  Net.on('created', (room) => {
    shareUrl = location.origin + '/r/' + prettyRoom(room);
    el.linkText.value = shareUrl;
    renderQR(shareUrl);
    show(el.wait);
    setStatus('wait', 'Waiting for scan');
  });

  Net.on('peer-joined', () => {
    show(el.conn);
    el.connText.textContent = 'Device found - linking directly…';
    setStatus('conn', 'Connecting');
  });

  Net.on('joined', () => {
    show(el.conn);
    el.connText.textContent = 'Connected - opening direct link…';
    setStatus('conn', 'Connecting');
  });

  Net.on('connected', () => {
    show(el.room);
    el.peerText.textContent = 'Connected - direct device link';
    setStatus('ok', 'Connected');
    keepAwake();
  });

  Net.on('incoming-start', (batch) => {
    if (activeInBatch && !activeInBatch.finished) {
      const prefix = activeInBatch.id + ':';
      inRows.forEach((row, key) => {
        if (key.startsWith(prefix)) row.setState('Replaced by new transfer');
      });
    }
    activeInBatch = batch;
    if (batch.total > 768 * 1024 * 1024 && !window.isSecureContext) {
      toast('Tip: use the https link for multi-GB transfers');
    }
    batch.files.forEach((f, i) => {
      const row = makeRow({ dir: 'in', name: f.name, size: f.size, state: 'Receiving 0%' });
      inRows.set(batch.id + ':' + i, row);
    });
  });

  Net.on('recv-progress', (batch) => {
    inRate.update(batch.received, performance.now());
    batch.files.forEach((f, i) => {
      const row = inRows.get(batch.id + ':' + i);
      if (!row || f.done) return;
      const pct = f.size ? Math.floor((f.received / f.size) * 100) : 0;
      row.setPct(f.size ? (f.received / f.size) * 100 : 0);
      row.setState('Receiving ' + pct + '%');
    });
    rateLine(batch.total - batch.received);
  });

  Net.on('file', (file) => {
    const batch = activeInBatch;
    if (batch) {
      const idx = batch.files.indexOf(file);
      const row = idx >= 0 ? inRows.get(batch.id + ':' + idx) : null;
      if (row) {
        row.setPct(100);
        row.setState('Received · ' + fmtBytes(file.size));
        addSaveButton(row, file);
      }
    }
    receivedFiles.push(file);
    if (!isIOS) setTimeout(() => saveFile(file), 150);
  });

  Net.on('file-error', (file) => {
    const batch = activeInBatch;
    if (!batch) return;
    const idx = batch.files.indexOf(file);
    const row = idx >= 0 ? inRows.get(batch.id + ':' + idx) : null;
    if (row) row.setState(file.error === 'storage-full' ? 'Not enough storage on device' : 'Transfer incomplete');
  });

  Net.on('incoming-done', () => {
    activeInBatch = null;
    inRate.reset();
    el.rate.textContent = '';
    toast('Transfer received');
  });

  Net.on('text', (text) => {
    const row = makeRow({ dir: 'in', name: 'Text message', size: null, state: '' });
    row.noBar();
    const wrap = document.createElement('div');
    wrap.className = 'text-in';
    const pre = document.createElement('div');
    pre.className = 'text-in-body';
    pre.textContent = text.length > 400 ? text.slice(0, 400) + '…' : text;
    const btn = document.createElement('button');
    btn.className = 'btn sm';
    btn.type = 'button';
    btn.textContent = text.length > 400 ? 'Copy full text' : 'Copy';
    btn.onclick = () => {
      navigator.clipboard
        .writeText(text)
        .then(() => {
          btn.textContent = 'Copied';
          setTimeout(() => (btn.textContent = 'Copy'), 1500);
        })
        .catch(() => toast('Copy blocked by browser'));
    };
    wrap.appendChild(pre);
    wrap.appendChild(btn);
    row.li.insertBefore(wrap, row.barWrap);
    toast('Text received');
  });

  Net.on('send-start', (batch) => {
    outBatches.set(batch.id, batch.files);
    batch.files.forEach((f, i) => {
      const row = makeRow({ dir: 'out', name: f.name, size: f.size, state: 'Sending 0%' });
      inRows.set('out:' + batch.id + ':' + i, row);
    });
  });

  Net.on('send-progress', (batch) => {
    outRate.update(batch.bytes, performance.now());
    const files = outBatches.get(batch.id) || [];
    let base = 0;
    files.forEach((f, i) => {
      const row = inRows.get('out:' + batch.id + ':' + i);
      if (!row) return;
      const take = Math.min(Math.max(batch.bytes - base, 0), f.size);
      base += f.size;
      const pct = f.size ? (take / f.size) * 100 : 100;
      row.setPct(pct);
      if (pct < 100) row.setState('Sending ' + Math.floor(pct) + '%');
    });
    rateLine(batch.total - batch.bytes);
  });

  Net.on('send-done', (batch) => {
    const files = outBatches.get(batch.id) || [];
    files.forEach((f, i) => {
      const row = inRows.get('out:' + batch.id + ':' + i);
      if (!row) return;
      row.setPct(100);
      row.setState('Sent · ' + fmtBytes(f.size));
    });
    outBatches.delete(batch.id);
    outRate.reset();
    el.rate.textContent = '';
    toast('Sent in ' + (batch.elapsed / 1000).toFixed(1) + 's');
  });

  Net.on('send-error', () => toast('Send failed - connection lost'));

  Net.on('sent-text', () => {
    const row = makeRow({ dir: 'out', name: 'Text message', size: null, state: 'Sent' });
    row.noBar();
  });

  Net.on('peer-left', (reason) => {
    if (reason === 'leave') return;
    goHome();
    toast('Other device disconnected');
  });

  Net.on('closed', (reason) => {
    if (reason !== 'leave') goHome();
  });

  Net.on('error', (reason) => {
    if (reason === 'not-found') goHome('That link is invalid or has expired. Ask for a new QR code.');
    else if (reason === 'full') goHome('This link is already connected to another device.');
    else if (reason === 'busy') goHome('Server is busy - try again in a moment.');
    else if (String(reason).indexOf('signal') >= 0 || String(reason).indexOf('offer') >= 0) {
      goHome('Could not establish a direct connection. Check both networks.');
    } else toast('Connection problem: ' + reason);
  });

  function renderQR(text) {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    el.qr.innerHTML = qr.createSvgTag({
      cellSize: 4,
      margin: 3,
      alt: 'QR code with this transfer link',
      scalable: true
    });
    const svg = el.qr.querySelector('svg');
    if (svg) {
      svg.removeAttribute('width');
      svg.removeAttribute('height');
    }
  }

  /* ---------------- actions ---------------- */

  el.btnCreate.addEventListener('click', async () => {
    stopQrScan();
    homeError('');
    el.btnCreate.disabled = true;
    setStatus('conn', 'Creating link');
    try {
      await Net.create();
    } catch (err) {
      const m = String(err.message);
      if (m === 'busy') goHome('Server is busy - try again in a moment.');
      else goHome('Could not start a session. Is the server running?');
    } finally {
      el.btnCreate.disabled = false;
    }
  });

  el.btnCancel.addEventListener('click', () => {
    Net.leave();
    goHome();
  });

  el.btnLeave.addEventListener('click', () => {
    Net.leave();
    goHome();
  });

  el.btnCopy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      el.btnCopy.textContent = 'Copied';
      setTimeout(() => (el.btnCopy.textContent = 'Copy'), 1500);
    } catch (e) {
      el.linkText.select();
      toast('Press Ctrl+C / Cmd+C to copy');
    }
  });

  function extractId(str) {
    str = String(str || '').trim();
    const m =
      str.match(/\/r\/([A-Za-z0-9-]+)/i) ||
      str.match(/[?&]r=([A-Za-z0-9-]+)/i) ||
      str.match(/\b([A-Za-z0-9]{6,10})\b/);
    return m ? m[1].replace(/[^A-Za-z0-9]/g, '').toUpperCase() : null;
  }

  async function startJoin(id) {
    stopQrScan();
    homeError('');
    show(el.conn);
    el.connText.textContent = 'Joining room ' + prettyRoom(id) + '…';
    setStatus('conn', 'Joining');
    try {
      await Net.join(id);
    } catch (err) {
      const m = String(err.message);
      if (m === 'not-found') goHome('That link is invalid or has expired. Ask for a new QR code.');
      else if (m === 'full') goHome('This link is already connected to another device.');
      else goHome('Could not reach the server. Try again.');
    }
  }

  el.frmOpen.addEventListener('submit', (e) => {
    e.preventDefault();
    const id = extractId(el.inpOpen.value);
    if (!id) {
      homeError('That does not look like a share link or code.');
      return;
    }
    el.inpOpen.value = '';
    startJoin(id);
  });

  function stopQrScan() {
    scanActive = false;
    if (scanFrame !== null) cancelAnimationFrame(scanFrame);
    scanFrame = null;
    if (scanStream) scanStream.getTracks().forEach((track) => track.stop());
    scanStream = null;
    el.scanVideo.pause();
    el.scanVideo.srcObject = null;
    el.scanPanel.classList.add('hidden');
  }

  async function startQrScan() {
    homeError('');
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      homeError('Camera scanning needs HTTPS. Open the secure share link and try again.');
      return;
    }
    scanActive = true;
    el.scanPanel.classList.remove('hidden');
    el.scanStatus.textContent = 'Starting camera…';
    el.btnScan.disabled = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' } }
      });
      if (!scanActive) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      scanStream = stream;
      el.scanVideo.srcObject = stream;
      await el.scanVideo.play();
      el.scanStatus.textContent = 'Point the camera at a Seconds Share QR code.';
      lastScanFrameAt = 0;
      scanFrame = requestAnimationFrame(scanQrFrame);
    } catch (err) {
      stopQrScan();
      homeError(
        err && err.name === 'NotAllowedError'
          ? 'Camera permission was denied. Allow camera access and try again.'
          : 'Could not start the camera. Check camera access and try again.'
      );
    } finally {
      el.btnScan.disabled = false;
    }
  }

  function scanQrFrame(now) {
    if (!scanActive) return;
    scanFrame = requestAnimationFrame(scanQrFrame);
    if (now - lastScanFrameAt < 120 || !el.scanVideo.videoWidth) return;
    lastScanFrameAt = now;
    const width = Math.min(800, el.scanVideo.videoWidth);
    const height = Math.round((width / el.scanVideo.videoWidth) * el.scanVideo.videoHeight);
    scanCanvas.width = width;
    scanCanvas.height = height;
    scanContext.drawImage(el.scanVideo, 0, 0, width, height);
    const pixels = scanContext.getImageData(0, 0, width, height);
    const result = jsQR(pixels.data, width, height, { inversionAttempts: 'dontInvert' });
    if (!result) return;
    const id = extractId(result.data);
    if (!id) {
      el.scanStatus.textContent = 'That QR code is not a Seconds Share link. Keep scanning…';
      return;
    }
    stopQrScan();
    startJoin(id);
  }

  el.btnScan.addEventListener('click', startQrScan);
  el.btnScanCancel.addEventListener('click', stopQrScan);

  el.btnFiles.addEventListener('click', () => el.inFiles.click());
  el.btnFolder.addEventListener('click', () => el.inFolder.click());
  el.btnPhoto.addEventListener('click', () => el.inPhoto.click());
  el.btnText.addEventListener('click', () => {
    el.textBox.classList.toggle('hidden');
    if (!el.textBox.classList.contains('hidden')) el.txt.focus();
  });

  function sendFilesNow(files) {
    const list = Array.from(files || []).filter((f) => f);
    if (!list.length) return;
    lastSent = list;
    Net.sendFiles(list).catch((err) => {
      if (err.message === 'not-connected') toast('Not connected yet');
      else toast('Send failed: ' + err.message);
    });
  }

  el.inFiles.addEventListener('change', () => {
    sendFilesNow(el.inFiles.files);
    el.inFiles.value = '';
  });
  el.inFolder.addEventListener('change', () => {
    sendFilesNow(el.inFolder.files);
    el.inFolder.value = '';
  });
  el.inPhoto.addEventListener('change', () => {
    sendFilesNow(el.inPhoto.files);
    el.inPhoto.value = '';
  });

  el.btnSendText.addEventListener('click', () => {
    const text = el.txt.value.trim();
    if (!text) return;
    Net.sendText(text)
      .then(() => {
        el.txt.value = '';
        el.textBox.classList.add('hidden');
      })
      .catch(() => toast('Not connected yet'));
  });

  el.btnSaveAll.addEventListener('click', () => {
    const pending = receivedFiles.filter((f) => f.blob && !f.saved);
    const list = pending.length ? pending : receivedFiles.filter((f) => f.blob);
    if (!list.length) return;
    if (isIOS && list.length > 1) {
      saveFile(list[0]);
      toast('Tap each Save button on iPhone');
      return;
    }
    list.forEach((f, i) => setTimeout(() => saveFile(f), i * 250));
  });

  /* ---------------- drag & drop ---------------- */

  async function filesFromDataTransfer(dt) {
    const out = [];
    const items = dt.items ? Array.from(dt.items) : [];
    const entries = items.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
    if (entries.some(Boolean)) {
      for (const entry of entries) {
        if (entry) await walkEntry(entry, '', out);
      }
    } else {
      for (const f of dt.files) out.push(f);
    }
    return out;
  }

  function walkEntry(entry, prefix, out) {
    return new Promise((resolve) => {
      if (entry.isFile) {
        entry.file(
          (f) => {
            if (f) {
              f._path = prefix + entry.name;
              out.push(f);
            }
            resolve();
          },
          () => resolve()
        );
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const readAll = () => {
          reader.readEntries(
            async (batch) => {
              if (!batch.length) return resolve();
              for (const e of batch) await walkEntry(e, prefix + entry.name + '/', out);
              readAll();
            },
            () => resolve()
          );
        };
        readAll();
      } else resolve();
    });
  }

  window.addEventListener('dragover', (e) => {
    if (el.room.classList.contains('hidden')) return;
    e.preventDefault();
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) document.body.classList.remove('dragging');
  });
  window.addEventListener('drop', async (e) => {
    document.body.classList.remove('dragging');
    if (el.room.classList.contains('hidden')) return;
    e.preventDefault();
    sendFilesNow(await filesFromDataTransfer(e.dataTransfer));
  });

  /* ---------------- paste ---------------- */

  document.addEventListener('paste', (e) => {
    if (el.room.classList.contains('hidden')) return;
    const target = e.target;
    const inField = target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT');
    const cd = e.clipboardData;
    if (!cd) return;
    const files = Array.from(cd.files || []).filter((f) => f);
    if (files.length) {
      e.preventDefault();
      sendFilesNow(files);
      return;
    }
    if (!inField) {
      const text = cd.getData('text');
      if (text) {
        e.preventDefault();
        el.textBox.classList.remove('hidden');
        el.txt.value = text;
        el.txt.focus();
      }
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (!el.room.classList.contains('hidden')) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  /* ---------------- boot ---------------- */

  const fromUrl =
    (location.pathname.match(/^\/r\/([A-Za-z0-9-]+)$/i) || [])[1] ||
    new URLSearchParams(location.search).get('r');

  goHome();
  if (fromUrl) startJoin(extractId(fromUrl) || fromUrl);

  window.__ss = {
    files: () => receivedFiles.slice(),
    sent: () => lastSent.slice(),
    state: () => Net.state(),
    connected: () => !el.room.classList.contains('hidden')
  };
})();
