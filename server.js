const express = require("express");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const app = express();
const PORT = 3000;

const CONFIG_PATH = path.join(__dirname, "config.json");
const DATA_PATH = path.join(__dirname, "trailcam_review.json");

const SUPPORTED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".mp4", ".mov"]);
const PREVIEW_EXTENSIONS = [".gif", ".jpg", ".jpeg", ".png"];

let mediaRoot = null;
let mediaRootLower = null;
let metadata = { schemaVersion: 1, items: [] };
let undoStack = [];
const previewJobs = new Map();
const transcodeJobs = new Map();
let appConfig = {};
let ffmpegCommand = null;
let ffmpegResolved = false;
let ffmpegWarned = false;
const DEFAULT_PREVIEW_FPS = 2;
const DEFAULT_PREVIEW_MAX_FRAMES = 24;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function normalizeRelPath(relPath) {
  return relPath.split(path.sep).join("/");
}

function relPathToFs(relPath) {
  const safeRel = relPath.split("/").join(path.sep);
  return path.join(mediaRoot, safeRel);
}

function isUnderRoot(fullPath) {
  const resolved = path.resolve(fullPath);
  const lower = resolved.toLowerCase();
  return (
    lower.startsWith(mediaRootLower + path.sep) || lower === mediaRootLower
  );
}

function getMediaType(ext) {
  const lower = ext.toLowerCase();
  if (lower === ".mp4" || lower === ".mov") {
    return "video";
  }
  return "image";
}

function getContentType(ext) {
  const lower = ext.toLowerCase();
  if (lower === ".mov") {
    return "video/quicktime";
  }
  if (lower === ".mp4") {
    return "video/mp4";
  }
  if (lower === ".png") {
    return "image/png";
  }
  if (lower === ".gif") {
    return "image/gif";
  }
  return "image/jpeg";
}

function getPreviewSettings() {
  const fps = Number(appConfig.previewFps);
  const maxFrames = Number(appConfig.previewMaxFrames);
  return {
    fps: Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_PREVIEW_FPS,
    maxFrames:
      Number.isFinite(maxFrames) && maxFrames > 0
        ? maxFrames
        : DEFAULT_PREVIEW_MAX_FRAMES,
  };
}

function mergeWithMetadata(scanItems, map) {
  return scanItems.map((item) => {
    const meta = map.get(item.path);
    return {
      ...item,
      status: meta?.status || "unreviewed",
      reviewedAt: meta?.reviewedAt ?? null,
    };
  });
}

async function resolveFfmpegCommand() {
  if (ffmpegResolved) {
    return ffmpegCommand;
  }
  ffmpegResolved = true;

  const candidates = [];
  if (appConfig.ffmpegPath) {
    candidates.push(appConfig.ffmpegPath);
  }
  if (process.env.FFMPEG_PATH) {
    candidates.push(process.env.FFMPEG_PATH);
  }

  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  candidates.push(path.join(programFiles, "ffmpeg", "bin", "ffmpeg.exe"));
  if (programFilesX86) {
    candidates.push(path.join(programFilesX86, "ffmpeg", "bin", "ffmpeg.exe"));
  }
  candidates.push("C:\\ffmpeg\\bin\\ffmpeg.exe");
  candidates.push("ffmpeg");

  for (const candidate of candidates) {
    if (candidate.toLowerCase() === "ffmpeg") {
      const result = spawnSync("ffmpeg", ["-version"], {
        windowsHide: true,
      });
      if (!result.error) {
        ffmpegCommand = "ffmpeg";
        return ffmpegCommand;
      }
      continue;
    }

    try {
      await fsp.access(candidate, fs.constants.F_OK);
      ffmpegCommand = candidate;
      return ffmpegCommand;
    } catch {
      continue;
    }
  }

  if (!ffmpegWarned) {
    ffmpegWarned = true;
    console.warn("ffmpeg not found. Previews/transcodes are disabled.");
  }

  return null;
}

function getPreviewFrameDir(relPath) {
  const normalized = normalizeRelPath(relPath);
  const parsed = path.posix.parse(normalized);
  return path.posix.join(
    ".camreview",
    "previews",
    parsed.dir,
    parsed.name
  );
}

function getPreviewFramePattern(relPath) {
  return path.posix.join(getPreviewFrameDir(relPath), "frame_%03d.jpg");
}

async function listPreviewFrames(relPath) {
  const dirRel = getPreviewFrameDir(relPath);
  const dirPath = relPathToFs(dirRel);
  if (!isUnderRoot(dirPath)) {
    return [];
  }

  let entries;
  try {
    entries = await fsp.readdir(dirPath);
  } catch {
    return [];
  }

  return entries
    .filter((name) => name.startsWith("frame_") && name.endsWith(".jpg"))
    .sort()
    .map((name) => path.posix.join(dirRel, name));
}

function getPreviewCandidates(relPath) {
  const normalized = normalizeRelPath(relPath);
  const parsed = path.posix.parse(normalized);
  const base = path.posix.join(parsed.dir, parsed.name);
  const candidates = [];

  for (const ext of PREVIEW_EXTENSIONS) {
    candidates.push(path.posix.join(".camreview", "previews", `${base}${ext}`));
    candidates.push(`${base}${ext}`);
  }

  return candidates;
}

async function findPreview(relPath) {
  for (const candidate of getPreviewCandidates(relPath)) {
    const fsPath = relPathToFs(candidate);
    if (!isUnderRoot(fsPath)) {
      continue;
    }
    try {
      await fsp.access(fsPath, fs.constants.F_OK);
      return { fsPath, relPath: candidate };
    } catch {
      continue;
    }
  }
  const frames = await listPreviewFrames(relPath);
  if (frames.length > 0) {
    const fsPath = relPathToFs(frames[0]);
    if (isUnderRoot(fsPath)) {
      return { fsPath, relPath: frames[0] };
    }
  }
  return null;
}

async function generatePreviewFrames(relPath) {
  const normalized = normalizeRelPath(relPath);
  const ext = path.posix.extname(normalized).toLowerCase();
  if (ext !== ".mp4" && ext !== ".mov") {
    return [];
  }

  const { fps, maxFrames } = getPreviewSettings();
  const existing = await listPreviewFrames(normalized);
  if (existing.length >= maxFrames && maxFrames > 0) {
    return existing;
  }

  const ffmpeg = await resolveFfmpegCommand();
  if (!ffmpeg) {
    return [];
  }

  const destPatternRel = getPreviewFramePattern(normalized);
  const destPatternPath = relPathToFs(destPatternRel);
  if (!isUnderRoot(destPatternPath)) {
    return [];
  }

  if (previewJobs.has(destPatternPath)) {
    await previewJobs.get(destPatternPath);
  } else {
    const job = new Promise((resolve, reject) => {
      const srcPath = relPathToFs(normalized);
      if (!isUnderRoot(srcPath)) {
        reject(new Error("Invalid source path"));
        return;
      }
      fsp
        .mkdir(path.dirname(destPatternPath), { recursive: true })
        .then(() => {
          const args = [
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            srcPath,
            "-vf",
            `fps=${fps},scale=640:-1:flags=lanczos`,
            "-frames:v",
            String(maxFrames),
            destPatternPath,
          ];
          const proc = spawn(ffmpeg, args, { windowsHide: true });
          proc.on("error", reject);
          proc.on("close", (code) => {
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`ffmpeg exited with ${code}`));
            }
          });
        })
        .catch(reject);
    });

    previewJobs.set(destPatternPath, job);
    try {
      await job;
    } catch (err) {
      console.warn("Preview generation failed:", err.message);
    } finally {
      previewJobs.delete(destPatternPath);
    }
  }

  return await listPreviewFrames(normalized);
}

async function generatePreview(relPath) {
  const frames = await generatePreviewFrames(relPath);
  if (frames.length > 0) {
    const first = frames[0];
    return { fsPath: relPathToFs(first), relPath: first };
  }
  return null;
}

function getTranscodeRelPath(relPath) {
  const normalized = normalizeRelPath(relPath);
  const parsed = path.posix.parse(normalized);
  return path.posix.join(
    ".camreview",
    "transcodes",
    parsed.dir,
    `${parsed.name}.mp4`
  );
}

async function findTranscode(relPath) {
  const destRel = getTranscodeRelPath(relPath);
  const destPath = relPathToFs(destRel);
  if (!isUnderRoot(destPath)) {
    return null;
  }
  try {
    await fsp.access(destPath, fs.constants.F_OK);
    return { fsPath: destPath, relPath: destRel };
  } catch {
    return null;
  }
}

async function generateTranscode(relPath) {
  const normalized = normalizeRelPath(relPath);
  const ext = path.posix.extname(normalized).toLowerCase();
  if (ext !== ".mp4" && ext !== ".mov") {
    return null;
  }

  const destRel = getTranscodeRelPath(normalized);
  const destPath = relPathToFs(destRel);
  if (!isUnderRoot(destPath)) {
    return null;
  }

  try {
    await fsp.access(destPath, fs.constants.F_OK);
    return { fsPath: destPath, relPath: destRel };
  } catch {
    // continue
  }

  const ffmpeg = await resolveFfmpegCommand();
  if (!ffmpeg) {
    return null;
  }

  if (transcodeJobs.has(destPath)) {
    await transcodeJobs.get(destPath);
  } else {
    const job = new Promise((resolve, reject) => {
      const srcPath = relPathToFs(normalized);
      if (!isUnderRoot(srcPath)) {
        reject(new Error("Invalid source path"));
        return;
      }
      fsp
        .mkdir(path.dirname(destPath), { recursive: true })
        .then(() => {
          const args = [
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            srcPath,
            "-vf",
            "scale=1280:-2:flags=lanczos",
            "-c:v",
            "libx264",
            "-profile:v",
            "baseline",
            "-level",
            "3.0",
            "-pix_fmt",
            "yuv420p",
            "-preset",
            "veryfast",
            "-crf",
            "28",
            "-an",
            "-movflags",
            "+faststart",
            destPath,
          ];
          const proc = spawn(ffmpeg, args, { windowsHide: true });
          proc.on("error", reject);
          proc.on("close", (code) => {
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`ffmpeg exited with ${code}`));
            }
          });
        })
        .catch(reject);
    });

    transcodeJobs.set(destPath, job);
    try {
      await job;
    } finally {
      transcodeJobs.delete(destPath);
    }
  }

  try {
    await fsp.access(destPath, fs.constants.F_OK);
    return { fsPath: destPath, relPath: destRel };
  } catch {
    return null;
  }
}

function buildMetadataMap() {
  const map = new Map();
  for (const item of metadata.items) {
    if (item && item.path) {
      map.set(item.path, item);
    }
  }
  return map;
}

async function loadConfig() {
  const raw = await fsp.readFile(CONFIG_PATH, "utf8");
  const data = JSON.parse(raw);
  if (!data.mediaRoot) {
    throw new Error("config.json must include mediaRoot");
  }
  appConfig = data;
  mediaRoot = path.resolve(__dirname, data.mediaRoot);
  mediaRootLower = mediaRoot.toLowerCase();
}

async function loadMetadata() {
  try {
    const raw = await fsp.readFile(DATA_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.items)) {
      throw new Error("Invalid metadata shape");
    }
    metadata = parsed;
  } catch (err) {
    if (err.code === "ENOENT") {
      metadata = { schemaVersion: 1, items: [] };
      await saveMetadata();
      return;
    }
    const backupName = `trailcam_review.json.corrupt-${Date.now()}`;
    const backupPath = path.join(__dirname, backupName);
    try {
      await fsp.copyFile(DATA_PATH, backupPath);
    } catch (copyErr) {
      console.error("Failed to backup corrupt metadata:", copyErr.message);
    }
    metadata = { schemaVersion: 1, items: [] };
    await saveMetadata();
  }
}

async function saveMetadata() {
  const payload = JSON.stringify(metadata, null, 2);
  await fsp.writeFile(DATA_PATH, payload, "utf8");
}

async function walkDir(dirPath, items) {
  let entries = [];
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    console.error(`Failed to read directory: ${dirPath}`, err.message);
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const lowerName = entry.name.toLowerCase();
      if (lowerName === "trash" || lowerName === ".camreview") {
        continue;
      }
      await walkDir(fullPath, items);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      continue;
    }
    try {
      const stat = await fsp.stat(fullPath);
      const rel = path.relative(mediaRoot, fullPath);
      if (rel.startsWith("..")) {
        continue;
      }
      const relPath = normalizeRelPath(rel);
      const parsed = path.posix.parse(relPath);
      const birthtimeMs = Number(stat.birthtimeMs);
      const capturedAtMs =
        Number.isFinite(birthtimeMs) && birthtimeMs > 0
          ? birthtimeMs
          : stat.mtimeMs;
      items.push({
        path: relPath,
        name: parsed.base,
        folder: parsed.dir || ".",
        mtimeMs: stat.mtimeMs,
        capturedAtMs,
        sizeBytes: stat.size,
        type: getMediaType(ext),
      });
    } catch (err) {
      console.error(`Failed to stat file: ${fullPath}`, err.message);
    }
  }
}

async function scanMedia() {
  const items = [];
  await walkDir(mediaRoot, items);
  items.sort((a, b) => {
    if (a.capturedAtMs === b.capturedAtMs) {
      return a.path.localeCompare(b.path);
    }
    return a.capturedAtMs - b.capturedAtMs;
  });
  return items;
}

async function syncMetadata(scanItems) {
  const map = buildMetadataMap();
  let changed = false;

  for (const scanItem of scanItems) {
    const existing = map.get(scanItem.path);
    if (!existing) {
      map.set(scanItem.path, {
        path: scanItem.path,
        status: "unreviewed",
        reviewedAt: null,
        caption: "",
        ai: null,
      });
      changed = true;
    } else {
      if (!existing.status) {
        existing.status = "unreviewed";
        changed = true;
      }
      if (!Object.prototype.hasOwnProperty.call(existing, "reviewedAt")) {
        existing.reviewedAt = null;
        changed = true;
      }
    }
  }

  if (changed) {
    metadata.items = Array.from(map.values());
    await saveMetadata();
  }

  return map;
}

app.get("/api/items", async (req, res) => {
  try {
    const scanItems = await scanMedia();
    const map = await syncMetadata(scanItems);
    const merged = mergeWithMetadata(scanItems, map);
    const unreviewed = merged.filter((item) => {
      const meta = map.get(item.path);
      return meta && meta.status === "unreviewed";
    });
    const reviewed = scanItems.length - unreviewed.length;
    res.json({
      items: unreviewed,
      counts: {
        total: scanItems.length,
        reviewed,
        remaining: unreviewed.length,
      },
    });
  } catch (err) {
    console.error("Failed to list items:", err.message);
    res.status(500).json({ error: "Failed to scan media" });
  }
});

app.get("/api/library", async (req, res) => {
  try {
    const scanItems = await scanMedia();
    const map = await syncMetadata(scanItems);
    const merged = mergeWithMetadata(scanItems, map);
    res.json({ items: merged });
  } catch (err) {
    console.error("Failed to list library:", err.message);
    res.status(500).json({ error: "Failed to scan media" });
  }
});

app.post("/api/action", async (req, res) => {
  const { path: relPath, action } = req.body || {};
  const allowed = new Set(["keep", "delete", "favorite"]);
  if (!relPath || !allowed.has(action)) {
    res.status(400).json({ error: "Invalid action" });
    return;
  }

  const normalizedPath = normalizeRelPath(relPath);
  const map = buildMetadataMap();
  const entry = map.get(normalizedPath);
  if (!entry) {
    res.status(404).json({ error: "Item not found" });
    return;
  }

  undoStack.push({
    path: normalizedPath,
    prevStatus: entry.status,
    prevReviewedAt: entry.reviewedAt ?? null,
  });

  entry.status = action;
  entry.reviewedAt = new Date().toISOString();

  metadata.items = Array.from(map.values());
  await saveMetadata();

  res.json({ ok: true });
});

app.post("/api/undo", async (req, res) => {
  const last = undoStack.pop();
  if (!last) {
    res.json({ ok: false });
    return;
  }

  const map = buildMetadataMap();
  const entry = map.get(last.path);
  if (!entry) {
    res.json({ ok: false });
    return;
  }

  entry.status = last.prevStatus || "unreviewed";
  entry.reviewedAt = last.prevReviewedAt ?? null;

  metadata.items = Array.from(map.values());
  await saveMetadata();

  res.json({ ok: true, path: last.path });
});

app.post("/api/apply-deletes", async (req, res) => {
  const map = buildMetadataMap();
  const deleteItems = metadata.items.filter(
    (item) => item.status === "delete"
  );
  const favoriteItems = metadata.items.filter(
    (item) => item.status === "favorite"
  );
  const results = {
    moved: [],
    missing: [],
    errors: [],
    favoritesMoved: [],
    favoritesMissing: [],
    favoritesErrors: [],
  };

  if (deleteItems.length === 0 && favoriteItems.length === 0) {
    res.json({ ok: true, ...results });
    return;
  }

  const trashRoot = path.join(mediaRoot, "Trash");
  await fsp.mkdir(trashRoot, { recursive: true });

  for (const item of deleteItems) {
    if (item.path.toLowerCase().startsWith("trash/")) {
      continue;
    }
    const srcPath = relPathToFs(item.path);
    if (!isUnderRoot(srcPath)) {
      results.errors.push({ path: item.path, error: "Invalid path" });
      continue;
    }
    try {
      await fsp.access(srcPath, fs.constants.F_OK);
    } catch {
      item.missing = true;
      item.missingAt = new Date().toISOString();
      results.missing.push(item.path);
      continue;
    }

    const destRel = path.posix.join("Trash", item.path);
    const destPath = relPathToFs(destRel);
    const destDir = path.dirname(destPath);
    await fsp.mkdir(destDir, { recursive: true });

    try {
      await fsp.rename(srcPath, destPath);
      if (!item.originalPath) {
        item.originalPath = item.path;
      }
      item.path = destRel;
      item.movedAt = new Date().toISOString();
      results.moved.push(destRel);
      console.log(`Moved to Trash: ${destRel}`);
    } catch (err) {
      results.errors.push({ path: item.path, error: err.message });
    }
  }

  if (favoriteItems.length > 0) {
    const favoritesRoot = path.join(mediaRoot, "Favorites");
    await fsp.mkdir(favoritesRoot, { recursive: true });
  }

  for (const item of favoriteItems) {
    const lower = item.path.toLowerCase();
    if (lower.startsWith("favorites/") || lower.startsWith("trash/")) {
      continue;
    }
    const srcPath = relPathToFs(item.path);
    if (!isUnderRoot(srcPath)) {
      results.favoritesErrors.push({ path: item.path, error: "Invalid path" });
      continue;
    }
    try {
      await fsp.access(srcPath, fs.constants.F_OK);
    } catch {
      item.missing = true;
      item.missingAt = new Date().toISOString();
      results.favoritesMissing.push(item.path);
      continue;
    }

    const destRel = path.posix.join("Favorites", item.path);
    const destPath = relPathToFs(destRel);
    const destDir = path.dirname(destPath);
    await fsp.mkdir(destDir, { recursive: true });

    try {
      await fsp.rename(srcPath, destPath);
      if (!item.originalPath) {
        item.originalPath = item.path;
      }
      item.path = destRel;
      item.favoritedAt = new Date().toISOString();
      results.favoritesMoved.push(destRel);
      console.log(`Moved to Favorites: ${destRel}`);
    } catch (err) {
      results.favoritesErrors.push({ path: item.path, error: err.message });
    }
  }

  metadata.items = Array.from(map.values());
  await saveMetadata();

  res.json({ ok: true, ...results });
});

app.post("/api/transcode", async (req, res) => {
  const { path: relPath } = req.body || {};
  if (!relPath) {
    res.status(400).json({ ok: false, error: "Missing path" });
    return;
  }

  const normalizedPath = normalizeRelPath(relPath);
  const fsPath = relPathToFs(normalizedPath);
  if (!isUnderRoot(fsPath)) {
    res.status(400).json({ ok: false, error: "Invalid path" });
    return;
  }

  const ext = path.posix.extname(normalizedPath).toLowerCase();
  if (ext !== ".mp4" && ext !== ".mov") {
    res.status(400).json({ ok: false, error: "Not a video" });
    return;
  }

  const ffmpeg = await resolveFfmpegCommand();
  if (!ffmpeg) {
    res.status(500).json({ ok: false, error: "ffmpeg_missing" });
    return;
  }

  try {
    const result = await generateTranscode(normalizedPath);
    if (!result) {
      res.status(500).json({ ok: false, error: "Transcode failed" });
      return;
    }
    res.json({ ok: true, status: "ready", path: result.relPath });
  } catch (err) {
    res.status(500).json({ ok: false, error: "Transcode error" });
  }
});

app.get("/media", async (req, res) => {
  const relPath = req.query.path;
  if (!relPath) {
    res.status(400).send("Missing path");
    return;
  }

  const normalizedPath = normalizeRelPath(relPath);
  let fsPath = relPathToFs(normalizedPath);
  if (!isUnderRoot(fsPath)) {
    res.status(400).send("Invalid path");
    return;
  }

  const ext = path.extname(fsPath).toLowerCase();
  const isVideo = ext === ".mp4" || ext === ".mov";

  let stat;
  try {
    stat = await fsp.stat(fsPath);
  } catch (err) {
    res.status(404).send("Not found");
    return;
  }

  const contentType = getContentType(ext);
  const range = req.headers.range;

  if (isVideo && range) {
    const size = stat.size;
    const match = range.match(/bytes=(\\d+)-(\\d*)/);
    const start = match ? parseInt(match[1], 10) : 0;
    const end = match && match[2] ? parseInt(match[2], 10) : size - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkSize,
      "Content-Type": contentType,
    });

    fs.createReadStream(fsPath, { start, end }).pipe(res);
    return;
  }

  res.setHeader("Content-Type", contentType);
  fs.createReadStream(fsPath).pipe(res);
});

app.get("/preview", async (req, res) => {
  const relPath = req.query.path;
  if (!relPath) {
    res.status(400).send("Missing path");
    return;
  }

  const normalizedPath = normalizeRelPath(relPath);
  let preview;
  try {
    preview = await findPreview(normalizedPath);
    if (!preview) {
      preview = await generatePreview(normalizedPath);
    }
  } catch (err) {
    res.status(500).send("Preview error");
    return;
  }

  if (!preview) {
    res.status(404).send("No preview");
    return;
  }

  const ext = path.extname(preview.fsPath).toLowerCase();
  res.setHeader("Content-Type", getContentType(ext));
  fs.createReadStream(preview.fsPath).pipe(res);
});

app.get("/api/preview-frames", async (req, res) => {
  const relPath = req.query.path;
  if (!relPath) {
    res.status(400).json({ ok: false, error: "Missing path" });
    return;
  }

  const normalizedPath = normalizeRelPath(relPath);
  const fsPath = relPathToFs(normalizedPath);
  if (!isUnderRoot(fsPath)) {
    res.status(400).json({ ok: false, error: "Invalid path" });
    return;
  }

  const ext = path.posix.extname(normalizedPath).toLowerCase();
  if (ext !== ".mp4" && ext !== ".mov") {
    res.json({ ok: true, frames: [] });
    return;
  }

  let frames = await listPreviewFrames(normalizedPath);
  if (frames.length === 0 && req.query.generate === "1") {
    frames = await generatePreviewFrames(normalizedPath);
  }

  res.json({ ok: true, frames });
});

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err.message);
  res.status(500).json({ error: "Server error" });
});

async function start() {
  try {
    await loadConfig();
    await loadMetadata();
    await fsp.mkdir(mediaRoot, { recursive: true });
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`CamReview running on http://0.0.0.0:${PORT}`);
    });
  } catch (err) {
    console.error("Failed to start:", err.message);
    process.exit(1);
  }
}

start();
