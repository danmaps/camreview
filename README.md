# CamReview v0

Fast, local-only review of trail camera media on Windows. No cloud. No Docker. Safe deletes.

## Features

- One-at-a-time review with Keep / Delete / Favorite
- Swipe gestures and big buttons (mobile-first)
- Undo last action
- Arrow-key browsing + on-screen arrows (no decision required)
- Desktop library drawer with search/filter + critter columns
- Resizable library pane on desktop
- Safe deletes (moves into `Trash/`)
- Favorites move into `Favorites/` on apply
- Persistent JSON metadata
- Video streaming with phone-friendly fallback
- Optional AI critter detection + batch delete marking

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

## How deletes work

- Delete marks the file only.
- "Apply Changes" moves delete-marked files into `Trash/` under `mediaRoot`.
- "Apply Changes" moves favorite-marked files into `Favorites/` under `mediaRoot`.
- No permanent deletes in v0.

## Metadata

The metadata file is `trailcam_review.json` and is SQLite-friendly (flat rows). It stores:

- `path`
- `status`
- `reviewedAt`
- `caption`
- `ai` (reserved)
- `critter`, `critterConfidence`, `critterCheckedAt`, `critterModel`

If the metadata file is corrupt, a backup copy is created and a fresh file is used.

## Video behavior

- If a video fails on mobile, CamReview auto-creates a smaller H.264 MP4 on the server
  (requires `ffmpeg`) and plays that version.
- Previews are generated at `previewFps` up to `previewMaxFrames`.
- You can also drop a sidecar preview image (`.gif`, `.jpg`, `.jpeg`, `.png`) with the same
  base name or inside `.camreview/previews/`.

## AI critter detection (optional)

CamReview can call OpenRouter to detect animals. This is opt-in and sends the current
image to the OpenRouter model only when you click **Detect Animals** (images only).
If a result already exists, CamReview reuses the cached value.

You can also run **AI batch detect** to detect animals across all images and
mark non-animal photos for delete (Apply Changes still controls the move to `Trash/`).

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
- `POST /api/action` -> mark keep/delete/favorite
- `POST /api/undo` -> undo last action
- `POST /api/apply-deletes` -> move delete-marked files to Trash, favorites to Favorites
- `GET /api/preview-frames?path=...&generate=1` -> list or generate preview frames
- `POST /api/transcode` -> create phone-friendly H.264 MP4
- `GET /media?path=...` -> stream image/video
- `POST /api/detect-critters` -> detect animal presence for the current image
- `POST /api/detect-critters/batch-delete` -> batch detect + mark non-animal images for delete
- `GET /api/detect-critters/batch-delete/status` -> poll batch job status

## Troubleshooting

- If `ffmpeg` is installed but not found, set `ffmpegPath` in `config.json`.
- If mobile video still fails, check the server console output for ffmpeg errors.
