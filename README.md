# CamReview v0

Fast, local-only review of trail camera media on Windows. No cloud. No Docker. Safe deletes.

## Setup

1. Edit `config.json` and set `mediaRoot` to your trailcam folder.
2. Install dependencies:

```bash
npm install
```

3. Start the server:

```bash
npm start
```

The app listens on `http://0.0.0.0:3000`. On your phone, open `http://<your-lan-ip>:3000`.

## What it does

- Scans `mediaRoot` recursively (ignores any `Trash` folder).
- Shows one item at a time for Keep / Delete / Favorite.
- Swipe right to Keep, left to Delete, up to Favorite (buttons still work).
- Stores review metadata in `trailcam_review.json`.
- Deletes are logical until you tap "Apply Deletes".
- Apply Deletes moves files into `Trash/` under `mediaRoot`.
- Video previews: if a video cannot play, CamReview looks for a sidecar preview
  image (`.gif`, `.jpg`, `.jpeg`, `.png`) with the same base name or inside
  `.camreview/previews/` and shows it instead.

## Metadata

The metadata file is `trailcam_review.json` and is SQLite-friendly (flat rows). It stores:

- `path`
- `status`
- `reviewedAt`
- `caption`
- `ai` (reserved)

If the metadata file is corrupt, a backup copy is created and a fresh file is used.

## API (v0)

- `GET /api/items` -> list unreviewed items
- `POST /api/action` -> mark keep/delete/favorite
- `POST /api/undo` -> undo last action
- `POST /api/apply-deletes` -> move delete-marked files to Trash
- `GET /api/preview-frames?path=...&generate=1` -> list or generate preview frames
- `GET /media?path=...` -> stream image/video

## Notes

- No permanent deletes in v0.
- Single-user, local-only.
- Video streaming supports range requests.
- If a phone cannot decode some videos, you can drop preview GIFs in
  `.camreview/previews/<same folders>/<name>.gif` to ensure something displays.
- If `ffmpeg` is available on your PATH, CamReview will auto-generate a JPG
  preview the first time a video preview is requested.
- If `ffmpeg` is installed but not on PATH, set `"ffmpegPath"` in `config.json`
  to the full `ffmpeg.exe` path.
- When a video fails on mobile, CamReview will auto-create a smaller
  H.264 MP4 on the server (requires `ffmpeg`).
- Use `POST /api/transcode` if you want to create a smaller H.264 MP4 manually.
- Tune preview density with `previewFps` and `previewMaxFrames` in `config.json`.
