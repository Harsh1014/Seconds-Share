'use strict';

const Net = (() => {
  const HIGH = 8 * 1024 * 1024;
  const LOW = 2 * 1024 * 1024;
  const FALLBACK_CHUNK = 16 * 1024;
  const SINK_MIN = 4 * 1024 * 1024;
  const isSafari = /^((?!chrome|chromium|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent);
  const CHUNK_CAP = isSafari ? 64 * 1024 : 256 * 1024;
  const canSink =
    typeof navigator !== 'undefined' &&
    navigator.storage &&
    typeof navigator.storage.getDirectory === 'function';

  const listeners = {};
  function on(ev, fn) {
    (listeners[ev] || (listeners[ev] = [])).push(fn);
  }
  function emit(ev, ...args) {
    (listeners[ev] || []).forEach((fn) => fn(...args));
  }

  const cfg = window.__NETCFG || { turn: [] };
  const iceServers = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
  ].concat(Array.isArray(cfg.turn) ? cfg.turn : []);

  let ws = null;
  let pc = null;
  let dc = null;
  let room = null;
  let isHost = false;
  let peerReady = false;
  let remoteDescSet = false;
  let queuedCandidates = [];
  let waiters = [];

  const outgoing = [];
  let sending = false;
  let currentBatch = null;
  let incoming = null;

  function status(s, extra) {
    emit('status', s, extra);
  }

  function route(m) {
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].match(m)) {
        const w = waiters.splice(i, 1)[0];
        clearTimeout(w.timer);
        w.resolve(m);
        return true;
      }
    }
    return false;
  }

  function waitMsg(match, ms = 15000) {
    return new Promise((resolve, reject) => {
      const w = { match, resolve, reject };
      w.timer = setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        reject(new Error('timeout'));
      }, ms);
      waiters.push(w);
    });
  }

  function wsSend(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  function openWS() {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const sock = new WebSocket(`${proto}://${location.host}`);
      sock.onopen = () => resolve(sock);
      sock.onerror = () => reject(new Error('signaling-unreachable'));
      sock.onclose = () => {
        if (!peerReady && !dc) emit('closed', 'signaling-lost');
      };
      sock.onmessage = (e) => {
        let m;
        try {
          m = JSON.parse(e.data);
        } catch {
          return;
        }
        if (route(m)) return;
        handleServer(m);
      };
      ws = sock;
    });
  }

  function handleServer(m) {
    switch (m.t) {
      case 'peer-joined':
        isHost = true;
        peerReady = true;
        emit('peer-joined');
        startAsHost();
        break;
      case 'joined':
        room = m.room;
        peerReady = true;
        emit('joined', m.room);
        startAsGuest();
        break;
      case 'signal':
        handleSignal(m.data);
        break;
      case 'peer-left':
        dropPeer('peer-left');
        break;
      case 'room-closed':
        dropPeer('room-closed:' + (m.reason || ''));
        break;
      case 'error':
        emit('error', m.reason || 'unknown');
        break;
    }
  }

  async function create() {
    isHost = true;
    await openWS();
    wsSend({ t: 'create' });
    const m = await waitMsg((x) => x.t === 'created' || x.t === 'error');
    if (m.t === 'error') throw new Error(m.reason);
    room = m.room;
    emit('created', room);
    return room;
  }

  async function join(id) {
    isHost = false;
    await openWS();
    wsSend({ t: 'join', room: id });
    const m = await waitMsg((x) => x.t === 'joined' || x.t === 'error');
    if (m.t === 'error') throw new Error(m.reason);
    room = m.room;
    peerReady = true;
    emit('joined', m.room);
    startAsGuest();
    return m.room;
  }

  function newPeer() {
    pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
    pc.onicecandidate = (e) => {
      if (e.candidate) wsSend({ t: 'signal', data: { candidate: e.candidate } });
    };
    pc.onconnectionstatechange = () => {
      if (pc && (pc.connectionState === 'failed' || pc.connectionState === 'closed')) {
        dropPeer('connection-failed');
      }
    };
    pc.ondatachannel = (e) => {
      dc = e.channel;
      wireChannel(dc);
    };
  }

  function startAsHost() {
    if (pc) return;
    newPeer();
    dc = pc.createDataChannel('x', { ordered: true });
    wireChannel(dc);
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => wsSend({ t: 'signal', data: { sdp: pc.localDescription } }))
      .catch((err) => emit('error', 'offer-failed:' + err.message));
  }

  function startAsGuest() {
    if (pc) return;
    newPeer();
  }

  async function handleSignal(data) {
    if (!pc && (data.sdp || data.candidate)) newPeer();
    try {
      if (data.sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        remoteDescSet = true;
        await flushCandidates();
        if (data.sdp.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          wsSend({ t: 'signal', data: { sdp: pc.localDescription } });
        }
      } else if (data.candidate) {
        if (remoteDescSet) await pc.addIceCandidate(data.candidate);
        else queuedCandidates.push(data.candidate);
      }
    } catch (err) {
      emit('error', 'signal-failed:' + err.message);
    }
  }

  async function flushCandidates() {
    const q = queuedCandidates;
    queuedCandidates = [];
    for (const c of q) {
      try {
        await pc.addIceCandidate(c);
      } catch (err) {
        console.warn('ICE add failed', err);
      }
    }
  }

  function wireChannel(ch) {
    ch.binaryType = 'arraybuffer';
    ch.bufferedAmountLowThreshold = LOW;
    ch.onopen = () => {
      status('connected');
      emit('connected');
      pump();
    };
    ch.onclose = () => {
      if (peerReady) dropPeer('channel-closed');
    };
    ch.onerror = () => {};
    ch.onmessage = onChannelMessage;
  }

  function chunkSize() {
    const m = pc && pc.sctp && pc.sctp.maxMessageSize;
    if (typeof m === 'number' && m > 0) return Math.min(CHUNK_CAP, m);
    return FALLBACK_CHUNK;
  }

  function sendCtrl(obj) {
    if (dc && dc.readyState === 'open') dc.send(JSON.stringify(obj));
  }

  function onChannelMessage(ev) {
    if (typeof ev.data === 'string') {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      handleControl(m);
      return;
    }
    handleChunk(ev.data);
  }

  function handleControl(m) {
    switch (m.k) {
      case 'meta': {
        if (incoming && !incoming.finished) {
          emit('incoming-aborted', incoming);
        }
        const files = (m.files || []).map((f) => ({
          name: f.name,
          size: f.size,
          type: f.type || 'application/octet-stream',
          received: 0,
          chunks: [],
          blob: null,
          done: false,
          error: null,
          sink: canSink && f.size >= SINK_MIN,
          useSink: canSink && f.size >= SINK_MIN,
          writer: null,
          opfsHandle: null,
          openTried: false,
          writeError: null,
          usedSink: false,
          writeChain: Promise.resolve(),
          finalizePromise: null
        }));
        incoming = {
          id: m.id,
          files,
          total: files.reduce((s, f) => s + f.size, 0),
          idx: 0,
          received: 0,
          finished: false,
          startedAt: Date.now()
        };
        emit('incoming-start', incoming);
        skipEmptyFiles();
        break;
      }
      case 'text':
        emit('text', m.text || '');
        break;
      case 'done': {
        if (!incoming) break;
        const batch = incoming;
        const f = batch.files[batch.idx];
        if (f && f.received > 0 && f.received < f.size && !f.finalizePromise) {
          f.error = 'incomplete';
          emit('file-error', f);
        }
        incoming = null;
        Promise.all(batch.files.map((x) => x.finalizePromise || Promise.resolve()))
          .catch(() => {})
          .then(() => {
            batch.finished = true;
            emit('incoming-done', batch);
          });
        break;
      }
    }
  }

  let opfsRoot = null;
  function getOPFSRoot() {
    if (!opfsRoot) opfsRoot = navigator.storage.getDirectory();
    return opfsRoot;
  }

  async function openWriter(f) {
    const root = await getOPFSRoot();
    const flat = f.name.replace(/[\\/:*?"<>|]+/g, '__');
    try {
      await root.removeEntry(flat, { recursive: true });
    } catch (e) {}
    const handle = await root.getFileHandle(flat, { create: true });
    const writer = await handle.createWritable();
    f.opfsHandle = handle;
    return writer;
  }

  function queueWrite(f, buf) {
    if (!f.useSink) {
      f.chunks.push(buf);
      return;
    }
    f.writeChain = f.writeChain
      .then(async () => {
        if (!f.useSink) {
          f.chunks.push(buf);
          return;
        }
        if (!f.openTried) {
          f.openTried = true;
          try {
            f.writer = await openWriter(f);
            f.usedSink = true;
          } catch (e) {
            f.useSink = false;
          }
        }
        if (f.writer) await f.writer.write(buf);
        else f.chunks.push(buf);
      })
      .catch((err) => {
        f.writeError = err;
        f.useSink = false;
      });
  }

  function skipEmptyFiles() {
    if (!incoming) return;
    while (incoming.files[incoming.idx] && incoming.files[incoming.idx].size === 0) {
      const empty = incoming.files[incoming.idx];
      empty.finalizePromise = finalizeIncoming(empty);
      incoming.idx++;
    }
  }

  function handleChunk(buf) {
    if (!incoming || incoming.finished) return;
    const f = incoming.files[incoming.idx];
    if (!f) return;
    f.received += buf.byteLength;
    incoming.received += buf.byteLength;
    emit('recv-progress', incoming);
    queueWrite(f, buf);
    if (f.received >= f.size && !f.finalizePromise) {
      f.finalizePromise = finalizeIncoming(f);
      incoming.idx++;
      skipEmptyFiles();
    }
  }

  async function finalizeIncoming(f) {
    try {
      await f.writeChain;
      if (f.writeError) throw f.writeError;
      if (f.writer) {
        await f.writer.close();
        f.writer = null;
        f.blob = await f.opfsHandle.getFile();
      } else {
        f.blob = new Blob(f.chunks, { type: f.type });
        f.chunks = null;
      }
      f.done = true;
      f.saved = false;
      emit('file', f);
    } catch (err) {
      f.writer = null;
      f.error = err && err.name === 'QuotaExceededError' ? 'storage-full' : 'write-failed';
      emit('file-error', f);
    }
  }

  function enqueueFiles(files) {
    const items = files.map((f) => ({
      file: f,
      name: f._path || f.webkitRelativePath || f.name || 'file'
    }));
    return enqueue({ kind: 'files', items });
  }

  function enqueueText(text) {
    return enqueue({ kind: 'text', text });
  }

  function enqueue(task) {
    if (!dc || dc.readyState !== 'open') return Promise.reject(new Error('not-connected'));
    const p = new Promise((resolve, reject) => {
      task.resolve = resolve;
      task.reject = reject;
    });
    outgoing.push(task);
    pump();
    return p;
  }

  async function pump() {
    if (sending || !dc || dc.readyState !== 'open') return;
    sending = true;
    try {
      while (outgoing.length) {
        const task = outgoing.shift();
        try {
          if (task.kind === 'text') {
            sendCtrl({ k: 'text', text: task.text });
            emit('sent-text');
            task.resolve();
          } else {
            await sendBatch(task);
            task.resolve();
          }
        } catch (err) {
          task.reject(err);
        }
      }
    } finally {
      sending = false;
    }
  }

  async function waitForDrain(nextBytes = 0, forceProgress = false) {
    while (
      dc &&
      dc.readyState === 'open' &&
      dc.bufferedAmount + nextBytes > (forceProgress ? LOW : HIGH)
    ) {
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          dc.removeEventListener('bufferedamountlow', finish);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(finish, 500);
        dc.addEventListener('bufferedamountlow', finish);
      });
    }
    if (!dc || dc.readyState !== 'open') throw new Error('channel-closed');
    if (forceProgress) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!dc || dc.readyState !== 'open') throw new Error('channel-closed');
    }
  }

  async function sendChunk(buf) {
    while (dc && dc.readyState === 'open') {
      await waitForDrain(buf.byteLength);
      try {
        dc.send(buf);
        return;
      } catch (err) {
        if (!/send queue is full/i.test(err.message || '')) throw err;
        await waitForDrain(buf.byteLength, true);
      }
    }
    throw new Error('channel-closed');
  }

  async function sendBatch(task) {
    const id = Math.random().toString(36).slice(2, 10);
    const total = task.items.reduce((s, i) => s + i.file.size, 0);
    const batch = { id, total, enqueued: 0, startedAt: Date.now(), size: chunkSize() };
    currentBatch = batch;
    emit('send-start', {
      id,
      total,
      files: task.items.map((i) => ({ name: i.name, size: i.file.size }))
    });
    sendCtrl({
      k: 'meta',
      id,
      files: task.items.map((i) => ({ name: i.name, size: i.file.size, type: i.file.type }))
    });

    const tick = setInterval(() => {
      const flushed = Math.max(0, batch.enqueued - (dc ? dc.bufferedAmount : 0));
      emit('send-progress', { id, bytes: Math.min(flushed, total), total });
    }, 250);
    emit('send-progress', { id, bytes: 0, total });

    try {
      for (const item of task.items) {
        let offset = 0;
        const size = item.file.size;
        while (offset < size) {
          const end = Math.min(offset + batch.size, size);
          const buf = await item.file.slice(offset, end).arrayBuffer();
          await sendChunk(buf);
          offset += buf.byteLength;
          batch.enqueued += buf.byteLength;
        }
      }
      sendCtrl({ k: 'done', id });
      const flushed = Math.max(0, batch.enqueued - (dc ? dc.bufferedAmount : 0));
      emit('send-progress', { id, bytes: Math.min(flushed, total), total });
      emit('send-done', { id, total, elapsed: Date.now() - batch.startedAt });
    } catch (err) {
      emit('send-error', { id, error: err.message });
      throw err;
    } finally {
      clearInterval(tick);
      currentBatch = null;
    }
  }

  function dropPeer(reason) {
    const hadPeer = peerReady || !!dc;
    peerReady = false;
    remoteDescSet = false;
    queuedCandidates = [];
    currentBatch = null;
    incoming = null;
    for (const t of outgoing.splice(0)) t.reject(new Error('disconnected'));
    try {
      if (dc) dc.close();
    } catch {}
    try {
      if (pc) pc.close();
    } catch {}
    dc = null;
    pc = null;
    if (ws) {
      try {
        ws.close();
      } catch {}
      ws = null;
    }
    room = null;
    if (hadPeer) {
      emit('peer-left', reason);
      status('closed', reason);
    }
  }

  function leave() {
    if (ws && ws.readyState === WebSocket.OPEN) wsSend({ t: 'leave' });
    dropPeer('leave');
    emit('closed', 'leave');
  }

  function isBusy() {
    return sending || outgoing.length > 0;
  }

  return {
    on,
    create,
    join,
    leave,
    sendFiles: enqueueFiles,
    sendText: enqueueText,
    isBusy,
    state: () => ({
      dc: dc ? dc.readyState : null,
      pc: pc ? pc.connectionState : null,
      ice: pc ? pc.iceConnectionState : null,
      peerReady,
      ws: ws ? ws.readyState : null,
      room
    }),
    get room() {
      return room;
    }
  };
})();
