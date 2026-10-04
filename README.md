# Seconds Share

Instant peer-to-peer file sharing through a QR code. Open the site, create a link,
scan it with any phone camera - files travel **directly between the two devices**
over WebRTC. Nothing is uploaded, nothing is stored, no account, no app install.

Works **iPhone ↔ Android**, **iPhone ↔ iPhone**, **Android ↔ Android**.

## Quick start

```bash
npm install
npm start
```

Open `http://localhost:3000`. The console prints a **Phone:** URL (your LAN IP) -
open that on your phone (same Wi-Fi), or scan the QR from another device.

Test it:

1. PC opens the site → **Create share link** → QR appears.
2. Phone scans the QR with its normal camera app → browser opens → devices connect.
3. Send files / a folder / a photo / text → watch the speed.

Run tests:

```bash
npm test
```

## Use it from anywhere (internet)

The signaling server must be reachable by both devices, so it needs a public
HTTPS + WSS address. Two options:

### Option A - Cloudflare Tunnel (instant, free, no deploy)

```bash
cloudflared tunnel --url http://localhost:3000
```

It prints an `https://…trycloudflare.com` URL. Everyone uses that URL; QR and
links work across the world. Keep `npm start` and the tunnel running.

### Option B - Deploy to Render

`render.yaml` is included. Push this folder to a Git repo, create a Render **Web
Service** from it (or use the Blueprint), and it builds itself. HTTPS/WSS is
provided automatically.

## How it stays fast

- The server only brokers the introduction (room + SDP/ICE relay) - file bytes
  never touch it.
- WebRTC DataChannel, adaptive chunks (up to 256 KB per message), streamed with
  `File.slice()` (memory safe on the sender) and backpressure
  (`bufferedAmountLow` = 2 MB / 8 MB) so the pipe stays saturated.
- **Receiver streams to disk** via the origin-private file system (OPFS) for any
  file ≥ 4 MB: chunks are written to storage as they arrive, so a 6 GB movie
  never sits in RAM. Small files use an instant in-memory path. Falls back to
  memory buffering where OPFS is unavailable (plain `http://` LAN URLs - use an
  https link for multi-GB files).
- Same Wi-Fi → direct LAN link: realistic 30-120 MB/s (a 6 GB movie in ~1-3
  min; gigabit-wired / excellent Wi-Fi can hit ~30-60 s). Never slower than
  that and no upload/download double wait.
- Across the internet → direct peer-to-peer, limited only by the slower side's
  upload bandwidth.

## Big files (5-6 GB movies)

Works - with two conditions:

1. **Receiving device needs free disk space** equal to the file (it is written
   to disk as it downloads, then saved via the Save button / download / share
   sheet).
2. **Use an https link** (Cloudflare Tunnel or Render) - browsers disable disk
   write APIs on plain `http://LAN-IP` addresses, which forces the memory
   fallback for huge files.

## Strict NAT / relay fallback (TURN)

Most home/mobile networks connect directly using STUN. If both devices are behind
symmetric NATs you need a TURN relay. Set env vars and restart:

```bash
TURN_URL=turn:your.turn.server:3478
TURN_USER=user
TURN_PASS=pass
```

Free options exist (e.g. a small VPS with `coturn`, or free-tier TURN providers).
Without TURN, such pairs will show "Could not establish a direct connection".

## Browser support

| Action        | Safari (iOS 15+) | Chrome / Edge | Firefox |
| ------------- | ---------------- | ------------- | ------- |
| Send          | yes              | yes           | yes     |
| Receive + Save| yes (share sheet → "Save to Files") | yes (auto download) | yes |

Notes:

- **iPhone:** iOS suspends background tabs - keep the tab open during transfer.
  Received files are saved via the share sheet (one tap on **Save**).
- Files are buffered in memory on the receiver; very large files (1 GB+) may be
  heavy on older phones.
- Both devices must stay on the page until the transfer finishes.

## Project layout

```
server.js          Express static + WebSocket signaling (rooms, relay)
public/index.html  Single page UI
public/net.js      WebRTC + chunked transfer engine
public/app.js      UI, QR, file pickers, progress, saving
public/style.css   Styling
test/              Signaling + browser end-to-end tests (node --test)
```

## Protocol (data channel)

- `{"k":"meta","id":…,"files":[{name,size,type}]}` - batch header (JSON frame)
- binary frames - raw file chunks, in order, per file
- `{"k":"done","id":…}` - batch finished (JSON frame)
- `{"k":"text","text":…}` - text message (JSON frame)

The channel is ordered and reliable, so file boundaries are implied by sizes.
