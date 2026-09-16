# ArcherFormReplay

A mobile/tablet web app for archers to review their shot form on video. One device acts as **master** — it listens for the sound of the arrow release and records its own camera — while any number of **slave** devices on the same local network (shared Wi-Fi or a phone hotspot) each contribute a synced camera angle. After a release, a short clip (configurable seconds before/after) is pulled from each device and shown on the master for review, with adjustable playback speed.

Built with Angular, deployed as a static site to GitHub Pages. There is no backend — device pairing uses a free public WebRTC signaling broker only to establish a direct peer-to-peer connection between devices on the same network; video never leaves the LAN.

Status: scaffolding in place; recording/trigger/playback and multi-device sync are being built out in phases (see the project plan).

## Development server

```bash
npm start
```

Open `http://localhost:4200/`. Camera/microphone access requires either `localhost` or HTTPS, so this works for local dev; testing from another device on the LAN needs a self-signed HTTPS dev server (see Angular CLI's `--ssl` options) or the deployed GitHub Pages URL.

## Building

```bash
npx ng build --configuration production --base-href /ArcherFormReplay/
```

Output goes to `dist/ArcherFormReplay/browser`.

## Running unit tests

```bash
npm test
```

Runs the [Vitest](https://vitest.dev/) test runner.

## Deployment (GitHub Pages)

`.github/workflows/deploy.yml` builds the app and publishes `dist/ArcherFormReplay/browser` to GitHub Pages on every push to `main`.

One-time setup after the repo exists on GitHub:

1. Push this repo to `https://github.com/<your-username>/ArcherFormReplay`.
2. In the repo's **Settings → Pages**, set **Source** to **GitHub Actions**.
3. Push to `main` (or run the workflow manually) — the site will be live at `https://<your-username>.github.io/ArcherFormReplay/`.
