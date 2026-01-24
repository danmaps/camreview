# CamReview v0

Fast, local-only review of trail camera media on Windows. No cloud. No Docker. Safe deletes.

## Features

- One-at-a-time review with Keep / Delete / Favorite
- Swipe gestures and big buttons (mobile-first)
- Undo last action
- Arrow-key browsing + on-screen arrows (no decision required)
- Desktop library drawer with search/filter + critter columns
- Desktop-only batch detect with live per-image feedback
- Resizable library pane on desktop
- Safe deletes (moves into dated `Trash_YYYY-MM-DD/`)
- Favorites, Keeps, and Deletes move into dated folders immediately
- Persistent JSON metadata
- Video streaming with phone-friendly fallback
- Optional AI batch critter detection (desktop)
- Optional AI captions with editable text

## Quick start

1. Copy config:

```bash
copy config.example.json config.json
```

2. Edit `config.json` and set `mediaRoot` to your trailcam folder.
3. Install dependencies:

```bash
npm install
```

4. Start the server:

```bash
npm start
```

The app listens on `http://0.0.0.0:3000`. On your phone, open `http://<your-lan-ip>:3000`.

For auto-reload during development:

```bash
npm run dev
```

## Controls

- Swipe right = Keep
- Swipe left = Delete
- Swipe up = Favorite
- Buttons always work
- Arrow keys browse the queue
- K = Keep, D = Delete, F = Favorite

## Desktop vs mobile

- Desktop view is power-user mode: library drawer, resizable pane, batch detect,
  full keyboard shortcuts, and hover hints.
- Mobile view is streamlined: big buttons + swipes, minimal chrome, and no batch
  detect to keep it fast and thumb-friendly.
- Desktop plays the original MP4 with sound. Mobile uses a lighter preview
  stream when playback is flaky, so it may look choppier but stays reliable.
- Both views share the same review queue, metadata, and safe delete behavior.

## Non-goals

- No filename changes or renaming.
- No permanent deletes (everything is a move you can undo in Explorer).
- No auto-organized albums or collections.
- No cloud sync, accounts, or multi-user features.
- No editing, filters, or color adjustments.

## How deletes work

- Delete moves files immediately into `Trash_YYYY-MM-DD` under `mediaRoot`.
- Favorite moves files immediately into `Favorites_YYYY-MM-DD` under `mediaRoot`.
- Keep moves files immediately into `Keep_YYYY-MM-DD` under `mediaRoot`.
- No permanent deletes in v0.

## Metadata

The metadata file is `trailcam_review.json` and is SQLite-friendly (flat rows). It stores:

- `sessionDate`
- `path`
- `status`
- `reviewedAt`
- `caption`
- `ai` (reserved)
- `critter`, `critterConfidence`, `critterCheckedAt`, `critterModel`

`sessionDate` is created automatically on the first review action and is used for
the dated folder names.

If the metadata file is corrupt, a backup copy is created and a fresh file is used.

## Video behavior

- If a video fails on mobile, CamReview auto-creates a smaller H.264 MP4 on the server
  (requires `ffmpeg`) and plays that version.
- Previews are generated at `previewFps` up to `previewMaxFrames`.
- You can also drop a sidecar preview image (`.gif`, `.jpg`, `.jpeg`, `.png`) with the same
  base name or inside `.camreview/previews/`.

## AI critter detection (optional)

CamReview can call OpenRouter in batch mode (desktop only). It runs through images
without critter data, moves no-animal photos into Trash immediately, and writes
captions for the animal photos.

Captions are always editable inline after generation.

Requirements:

- Set `OPENROUTER_API_KEY` in the server environment.
- Optional: set `OPENROUTER_MODEL` to override the default model.

Results are stored as `critter` and `critterConfidence` fields in the metadata.

## Configuration

See `config.example.json`. Options:

- `mediaRoot` (required)
- `ffmpegPath` (optional, full path to `ffmpeg.exe`)
- `previewFps` (optional, default 2)
- `previewMaxFrames` (optional, default 24)
- `openrouterModel` (optional, default `openai/gpt-4o-mini`)

## API (v0)

- `GET /api/items` -> list unreviewed items
- `POST /api/action` -> keep/delete/favorite and move immediately
- `POST /api/undo` -> undo last action
- `GET /api/preview-frames?path=...&generate=1` -> list or generate preview frames
- `POST /api/transcode` -> create phone-friendly H.264 MP4
- `GET /media?path=...` -> stream image/video
- `POST /api/detect-critters` -> detect animal presence for the current image
- `POST /api/caption` -> save a caption for a file
- `POST /api/caption/generate` -> generate a caption for the current image

## Tests

API tests run against a temporary copy of a few sample files from your
`C:\Users\danny\iCloudDrive\trailcam` folder (originals are never modified).

Run:

```bash
npm test
```

## Troubleshooting

- If `ffmpeg` is installed but not found, set `ffmpegPath` in `config.json`.
- If mobile video still fails, check the server console output for ffmpeg errors.
