# Lean

Lean extracts executive compensation tables from Canadian AIC PDFs and helps review and export CSVs.

## API Key

CompLift calls the Anthropic API directly from your browser. **No server is involved** — your API key never leaves your device.

On first launch, a prompt asks you to enter your Anthropic API key. The key is saved to your browser's `localStorage` and sent with each request to `api.anthropic.com`. You can update it at any time via the key icon in the header.

**Get a key:** [console.anthropic.com](https://console.anthropic.com)

> **Security note:** Because the key is stored client-side, anyone with access to your browser's DevTools could read it. Only use this app on trusted devices, and rotate your key if you suspect exposure.

## Run locally

1. Install dependencies:

```bash
npm install
```

2. Run dev server:

```bash
npm run dev
```

Open http://localhost:5173 and enter your Anthropic API key when prompted.

## Deploy to Vercel

1. Push the repo to GitHub.
2. In Vercel, import the project and set:
   - Framework Preset: `Vite`
   - Build Command: `npm run build`
   - Output Directory: `dist`
3. Deploy — no environment variables needed.

Each user supplies their own Anthropic API key through the in-app UI.

## Project structure

- `src/components/CompLift.jsx` — main UI component.
- `src/pages/Home.jsx` — landing page.
- `src/pages/Viewer.jsx` — page that renders the `CompLift` component.
- `src/App.jsx`, `src/main.jsx` — routing and app bootstrap.
- `complift.jsx` — original single-file version (kept for reference).

## Features

- Enter your Anthropic API key once; it persists across sessions in `localStorage`.
- Drop multiple PDF AICs to extract compensation tables via the Anthropic API.
- Flag uncertain values for manual review and correction.
- Export per-document or aggregated CSVs.
