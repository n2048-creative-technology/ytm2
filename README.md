# local-vr-router (ytm2)

Status: Finished. Working Node.js signaling server with a phone client and an admin dashboard; usable as-is for local-network VR video streaming between phones.

## What it does

A local WebRTC signaling/router server for streaming live camera video from one
phone to another over the local network, intended for phone-based VR viewing
(e.g. stereo/side-by-side video feeds).

- Phones open the app in a mobile browser, register with the server over a
  WebSocket, and can send their camera feed to another registered phone (or
  receive one) via WebRTC.
- An admin dashboard lets you see all connected phones, manually route who
  sends video to whom, broadcast to all phones, toggle VR/local-view modes,
  and push on-screen overlay text to a phone.
- The server only relays WebRTC signaling messages (offer/answer/ICE) over
  WebSockets — actual video flows peer-to-peer between phones once connected.

## How it works / project layout

- `server.js` — Express + `ws` WebSocket server. Serves the static `public/`
  folder, exposes `/admin`, and handles the signaling protocol: client
  registration (`register`), routing who-sends-to-whom (`route`), forwarding
  WebRTC `signal` messages, and admin `client-control` commands (e.g. toggle
  VR mode, push overlay text). Also runs a ping/pong heartbeat to detect and
  clean up dead connections. Optionally serves HTTPS if
  `HTTPS_KEY_PATH`/`HTTPS_CERT_PATH` are set (required for PWA install
  prompts on some browsers).
- `config.js` — minimal config (currently just the default HTTPS port).
- `public/index.html` + `public/client.js` + `public/client.css` — the phone
  client: registers with the server, captures the device camera, sends/
  receives WebRTC video, shows local/remote video panes, and a small control
  overlay (device name, VR mode toggle, local view toggle).
- `public/admin.html` + `public/admin.js` + `public/admin.css` — the admin
  dashboard: lists connected phones and their routing state, lets you
  reroute senders/receivers, broadcast, and send overlay text; also renders a
  QR code (`public/qrcode.js`) for phones to scan and join.
- `public/manifest.json` + `public/service-worker.js` + `public/icons/` —
  makes the phone client installable as a PWA.

## Requirements

- Node.js 18+ (or Docker)
- Dependencies (see `package.json`): `express`, `helmet`, `ws`

## Running it

### With Docker (recommended)

```bash
docker build -t local-vr-router .

# HTTP (simplest, but PWA install prompts require HTTPS/localhost)
docker run --rm -p 3000:3000 local-vr-router

# HTTPS (needed for camera access / PWA install on most mobile browsers
# when not on localhost)
docker run --rm -p 8443:8443 \
  -e HTTPS_KEY_PATH=/certs/server.key \
  -e HTTPS_CERT_PATH=/certs/server.crt \
  -v /path/to/certs:/certs \
  local-vr-router
```

### Directly with Node

```bash
npm install
node server.js
# or: npm start
```

By default the server listens on port 3000 (HTTP) or 8443 (HTTPS, if
`HTTPS_KEY_PATH`/`HTTPS_CERT_PATH` env vars are set). Override with `PORT`.

Then, on each phone (same local network), open `http://<host-ip>:3000/` in a
mobile browser to join as a client, and open `http://<host-ip>:3000/admin` on
a laptop/desktop to control routing.

Note: most mobile browsers require HTTPS (or `localhost`) to grant camera
access, so for real device testing you'll usually want the HTTPS mode with a
self-signed or real certificate.

## License

MIT License — see [LICENSE](LICENSE).
