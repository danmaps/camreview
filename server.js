const express = require("express");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const app = express();
const PORT = 3000;

const CONFIG_PATH =
  process.env.CAMREVIEW_CONFIG_PATH || path.join(__dirname, "config.json");
const DATA_PATH =
  process.env.CAMREVIEW_DATA_PATH || path.join(__dirname, "trailcam_review.json");
const OPENROUTER_ENDPOINT =
  process.env.OPENROUTER_ENDPOINT ||
  "https://openrouter.ai/api/v1/chat/completions";

const SUPPORTED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".mp4", ".mov"]);
const PREVIEW_EXTENSIONS = [".gif", ".jpg", ".jpeg", ".png"];

let mediaRoot = null;
let mediaRootLower = null;
let metadata = { schemaVersion: 1, sessionDate: null, items: [] };
let undoStack = [];
const previewJobs = new Map();
const transcodeJobs = new Map();
let appConfig = {};
let ffmpegCommand = null;
let ffmpegResolved = false;
let ffmpegWarned = false;
let batchJob = null;
const DEFAULT_PREVIEW_FPS = 2;
const DEFAULT_PREVIEW_MAX_FRAMES = 24;

app.use(express.json({ limit: "1mb" }));

const PUBLIC_DIR = path.join(__dirname, "public");

// Default entry point: /browse
app.get("/", (req, res) => {
  res.redirect("/browse");
});

// SPA routes
app.get(["/browse", "/review"], (req, res) => {
  // iOS Safari can be aggressive about caching HTML; keep this fresh during dev.
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.use(
  express.static(PUBLIC_DIR, {
    etag: false,
    lastModified: false,
    setHeaders: (res, filePath) => {
      const lower = String(filePath).toLowerCase();
      if (
        lower.endsWith(".html") ||
        lower.endsWith(".js") ||
        lower.endsWith(".css")
      ) {
        res.setHeader("Cache-Control", "no-store");
      }
    },
  })
);

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
      caption: meta?.caption || "",
      critter: meta?.critter ?? null,
      critterConfidence: meta?.critterConfidence ?? null,
      critterCheckedAt: meta?.critterCheckedAt ?? null,
      critterModel: meta?.critterModel ?? null,
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
    if (!Object.prototype.hasOwnProperty.call(metadata, "sessionDate")) {
      metadata.sessionDate = null;
      await saveMetadata();
    }
  } catch (err) {
    if (err.code === "ENOENT") {
      metadata = { schemaVersion: 1, sessionDate: null, items: [] };
      await saveMetadata();
      return;
    }
    const backupName = `trailcam_review.json.corrupt-${Date.now()}`;
    const backupPath = path.join(path.dirname(DATA_PATH), backupName);
    try {
      await fsp.copyFile(DATA_PATH, backupPath);
    } catch (copyErr) {
      console.error("Failed to backup corrupt metadata:", copyErr.message);
    }
    metadata = { schemaVersion: 1, sessionDate: null, items: [] };
    await saveMetadata();
  }
}

async function saveMetadata() {
  const payload = JSON.stringify(metadata, null, 2);
  await fsp.writeFile(DATA_PATH, payload, "utf8");
}

function formatSessionDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function ensureSessionDate() {
  if (metadata.sessionDate) {
    return metadata.sessionDate;
  }
  const stamp = formatSessionDate(new Date());
  metadata.sessionDate = stamp;
  return stamp;
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

async function moveItemsToFolder(items, folderName, results, keys) {
  if (!Array.isArray(items) || items.length === 0) {
    return;
  }

  const rootPath = path.join(mediaRoot, folderName);
  await fsp.mkdir(rootPath, { recursive: true });

  for (const item of items) {
    if (!item || !item.path) {
      continue;
    }
    if (item.path.toLowerCase().startsWith(`${folderName.toLowerCase()}/`)) {
      continue;
    }
    const srcPath = relPathToFs(item.path);
    if (!isUnderRoot(srcPath)) {
      results[keys.errors].push({ path: item.path, error: "Invalid path" });
      continue;
    }
    try {
      await fsp.access(srcPath, fs.constants.F_OK);
    } catch {
      item.missing = true;
      item.missingAt = new Date().toISOString();
      results[keys.missing].push(item.path);
      continue;
    }

    const basePath = item.originalPath || item.path;
    const destRel = path.posix.join(folderName, basePath);
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
      results[keys.moved].push(destRel);
      console.log(`Moved to ${folderName}: ${destRel}`);
    } catch (err) {
      results[keys.errors].push({ path: item.path, error: err.message });
    }
  }
}

async function moveItemToPath(item, destRel, results, keys) {
  if (!item || !item.path || !destRel) {
    return;
  }
  const srcPath = relPathToFs(item.path);
  if (!isUnderRoot(srcPath)) {
    if (results && keys) {
      results[keys.errors].push({ path: item.path, error: "Invalid path" });
    }
    return;
  }
  const destPath = relPathToFs(destRel);
  if (!isUnderRoot(destPath)) {
    if (results && keys) {
      results[keys.errors].push({ path: destRel, error: "Invalid path" });
    }
    return;
  }

  try {
    await fsp.access(srcPath, fs.constants.F_OK);
  } catch {
    item.missing = true;
    item.missingAt = new Date().toISOString();
    if (results && keys) {
      results[keys.missing].push(item.path);
    }
    return;
  }

  const destDir = path.dirname(destPath);
  await fsp.mkdir(destDir, { recursive: true });
  try {
    await fsp.rename(srcPath, destPath);
    item.path = normalizeRelPath(destRel);
    item.movedAt = new Date().toISOString();
    if (results && keys) {
      results[keys.moved].push(item.path);
    }
  } catch (err) {
    if (results && keys) {
      results[keys.errors].push({ path: item.path, error: err.message });
    }
  }
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
        critter: null,
        critterConfidence: null,
        critterCheckedAt: null,
        critterModel: null,
        critterError: null,
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
      if (!Object.prototype.hasOwnProperty.call(existing, "caption")) {
        existing.caption = "";
        changed = true;
      }
      if (!Object.prototype.hasOwnProperty.call(existing, "critter")) {
        existing.critter = null;
        changed = true;
      }
      if (!Object.prototype.hasOwnProperty.call(existing, "critterConfidence")) {
        existing.critterConfidence = null;
        changed = true;
      }
      if (!Object.prototype.hasOwnProperty.call(existing, "critterCheckedAt")) {
        existing.critterCheckedAt = null;
        changed = true;
      }
      if (!Object.prototype.hasOwnProperty.call(existing, "critterModel")) {
        existing.critterModel = null;
        changed = true;
      }
      if (!Object.prototype.hasOwnProperty.call(existing, "critterError")) {
        existing.critterError = null;
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

function getOpenRouterConfig() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model =
    process.env.OPENROUTER_MODEL ||
    appConfig.openrouterModel ||
    "openai/gpt-4o-mini";
  const referrer =
    process.env.OPENROUTER_REFERRER || "http://localhost:3000";
  return { apiKey, model, referrer };
}

function postJson(urlString, headers, payload) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(urlString);
    const data = JSON.stringify(payload);
    const isHttp = urlObj.protocol === "http:";
    const transport = isHttp ? require("http") : require("https");
    const defaultPort = isHttp ? 80 : 443;
    const options = {
      method: "POST",
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      port: urlObj.port || defaultPort,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        ...headers,
      },
    };

    const req = transport.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk.toString("utf8")));
      res.on("end", () => {
        resolve({ status: res.statusCode || 0, body });
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function coerceConfidence(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return null;
  }
  let normalized = value;
  if (normalized > 1 && normalized <= 100) {
    normalized = normalized / 100;
  }
  normalized = Math.max(0, Math.min(1, normalized));
  return normalized;
}

function parseCritterResponse(text) {
  if (!text) {
    return null;
  }
  const trimmed = text.trim();
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return null;
    }
  }

  const critterRaw = parsed.critter;
  let critter = null;
  if (typeof critterRaw === "boolean") {
    critter = critterRaw;
  } else if (typeof critterRaw === "string") {
    const lower = critterRaw.toLowerCase();
    if (lower === "true" || lower === "yes") {
      critter = true;
    } else if (lower === "false" || lower === "no") {
      critter = false;
    }
  } else if (typeof critterRaw === "number") {
    critter = critterRaw > 0;
  }

  const confidence = coerceConfidence(parsed.confidence);
  if (critter === null) {
    return null;
  }
  return { critter, confidence };
}

async function getCritterImageInfo(item) {
  if (!item || !item.path) {
    return null;
  }
  if (item.type === "image") {
    const fsPath = relPathToFs(item.path);
    if (!isUnderRoot(fsPath)) {
      return null;
    }
    return {
      fsPath,
      relPath: item.path,
    };
  }

  let frames = await listPreviewFrames(item.path);
  if (frames.length === 0) {
    frames = await generatePreviewFrames(item.path);
  }
  if (frames.length > 0) {
    const relPath = frames[0];
    const fsPath = relPathToFs(relPath);
    if (isUnderRoot(fsPath)) {
      return { fsPath, relPath };
    }
  }

  const preview = await findPreview(item.path);
  if (preview) {
    return { fsPath: preview.fsPath, relPath: preview.relPath };
  }

  return null;
}

async function callOpenRouterForCritter(imageInfo, model, options = {}) {
  const { apiKey, referrer } = getOpenRouterConfig();
  if (!apiKey) {
    return { error: "missing_key" };
  }
  const ext = path.extname(imageInfo.fsPath).toLowerCase();
  const mime = getContentType(ext);
  const buffer = await fsp.readFile(imageInfo.fsPath);
  const base64 = buffer.toString("base64");
  const imageUrl = `data:${mime};base64,${base64}`;

  const payload = {
    model,
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "You are a vision classifier. Reply with JSON only: {\"critter\": true|false, \"confidence\": 0-1}.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Detect whether a visible animal is present. Return JSON only with critter and confidence.",
          },
          {
            type: "image_url",
            image_url: { url: imageUrl },
          },
        ],
      },
    ],
  };

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "HTTP-Referer": referrer,
    "X-Title": "CamReview",
  };

  const response = await postJson(OPENROUTER_ENDPOINT, headers, payload);
  if (response.status < 200 || response.status >= 300) {
    return { error: `openrouter_${response.status}` };
  }
  let data;
  try {
    data = JSON.parse(response.body);
  } catch {
    return { error: "parse_error" };
  }
  const content = data?.choices?.[0]?.message?.content || "";
  if (options.logResponse) {
    const context = options.context ? ` (${options.context})` : "";
    console.log(`OpenRouter response${context}: ${content}`);
  }
  const parsed = parseCritterResponse(content);
  if (!parsed) {
    return { error: "invalid_response" };
  }
  return { ...parsed };
}

async function callOpenRouterForCaption(imageInfo, model) {
  const { apiKey, referrer } = getOpenRouterConfig();
  if (!apiKey) {
    return { error: "missing_key" };
  }
  const ext = path.extname(imageInfo.fsPath).toLowerCase();
  const mime = getContentType(ext);
  const buffer = await fsp.readFile(imageInfo.fsPath);
  const base64 = buffer.toString("base64");
  const imageUrl = `data:${mime};base64,${base64}`;

  const payload = {
    model,
    temperature: 0.7,
    max_tokens: 160,
    messages: [
      {
        role: "system",
        content:
          "You write short, whimsical captions. Output plain text only (no quotes, no hashtags).",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Write 2-3 sentences about what's happening in the image. Focus on animals and action; avoid describing the environment unless it's obvious. You can mention time/season if it feels right. No camera references.",
          },
          {
            type: "image_url",
            image_url: { url: imageUrl },
          },
        ],
      },
    ],
  };

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "HTTP-Referer": referrer,
    "X-Title": "CamReview",
  };

  const response = await postJson(OPENROUTER_ENDPOINT, headers, payload);
  if (response.status < 200 || response.status >= 300) {
    return { error: `openrouter_${response.status}` };
  }
  let data;
  try {
    data = JSON.parse(response.body);
  } catch {
    return { error: "parse_error" };
  }
  const content = (data?.choices?.[0]?.message?.content || "").trim();
  if (!content) {
    return { error: "invalid_response" };
  }
  return { caption: content };
}

async function detectCritterForPath(targetPath) {
  const scanItems = await scanMedia();
  const map = await syncMetadata(scanItems);
  const normalizedTarget = normalizeRelPath(targetPath);
  const item = scanItems.find((entry) => entry.path === normalizedTarget);
  if (!item) {
    return { error: "not_found", status: 404 };
  }
  if (item.type !== "image") {
    return { error: "not_image", status: 400 };
  }
  const meta = map.get(item.path);
  if (!meta) {
    return { error: "not_found", status: 404 };
  }

  if (typeof meta.critter === "boolean") {
    return {
      result: {
        critter: meta.critter,
        confidence: meta.critterConfidence,
        model: meta.critterModel,
        cached: true,
      },
    };
  }

  const model = getOpenRouterConfig().model;
  const imageInfo = await getCritterImageInfo(item);
  if (!imageInfo) {
    meta.critterError = "no_preview";
    meta.critterCheckedAt = new Date().toISOString();
    meta.critterModel = model;
    metadata.items = Array.from(map.values());
    await saveMetadata();
    return { error: "no_preview", status: 500 };
  }

  const result = await callOpenRouterForCritter(imageInfo, model);
  if (result.error) {
    meta.critterError = result.error;
    meta.critterCheckedAt = new Date().toISOString();
    meta.critterModel = model;
    metadata.items = Array.from(map.values());
    await saveMetadata();
    return { error: result.error, status: 502 };
  }

  meta.critter = result.critter;
  meta.critterConfidence = result.confidence;
  meta.critterCheckedAt = new Date().toISOString();
  meta.critterModel = model;
  meta.critterError = null;
  metadata.items = Array.from(map.values());
  await saveMetadata();

  return {
    result: {
      critter: result.critter,
      confidence: result.confidence,
      model,
    },
  };
}

async function runBatchCritterDeleteJob(jobId, scope) {
  if (!batchJob || batchJob.id !== jobId) {
    return;
  }
  batchJob.status = "running";
  batchJob.phase = "scanning";
  batchJob.processed = 0;
  batchJob.matched = 0;
  batchJob.deleted = 0;
  batchJob.failed = 0;
  batchJob.total = 0;

  let scanItems;
  let map;
  try {
    scanItems = await scanMedia();
    map = await syncMetadata(scanItems);
  } catch (err) {
    batchJob.status = "error";
    batchJob.error = err.message;
    batchJob.finishedAt = new Date().toISOString();
    return;
  }

  const model = getOpenRouterConfig().model;
  batchJob.phase = "detecting";

  const candidates = scanItems.filter((item) => {
    if (item.type !== "image") {
      return false;
    }
    const meta = map.get(item.path);
    if (!meta) {
      return false;
    }
    if (scope === "unreviewed" && meta.status !== "unreviewed") {
      return false;
    }
    return true;
  });

  batchJob.total = candidates.length;

  const toTrash = [];
  for (const item of candidates) {
    const meta = map.get(item.path);
    if (!meta) {
      continue;
    }
    try {
      let critter = meta.critter;
      let confidence = meta.critterConfidence;

      if (typeof critter !== "boolean") {
        const imageInfo = await getCritterImageInfo(item);
        if (!imageInfo) {
          meta.critterError = "no_preview";
          meta.critterCheckedAt = new Date().toISOString();
          meta.critterModel = model;
          batchJob.failed += 1;
        } else {
          const result = await callOpenRouterForCritter(imageInfo, model, {
            logResponse: true,
            context: item.path,
          });
          if (result.error) {
            meta.critterError = result.error;
            meta.critterCheckedAt = new Date().toISOString();
            meta.critterModel = model;
            batchJob.failed += 1;
          } else {
            critter = result.critter;
            confidence = result.confidence;
            meta.critter = result.critter;
            meta.critterConfidence = result.confidence;
            meta.critterCheckedAt = new Date().toISOString();
            meta.critterModel = model;
            meta.critterError = null;
          }
        }
      }

      if (typeof critter === "boolean") {
        if (critter) {
          batchJob.matched += 1;
        } else {
          batchJob.deleted += 1;
          meta.status = "delete";
          meta.reviewedAt = new Date().toISOString();
          toTrash.push(meta);
        }
      }
    } catch (err) {
      meta.critterError = "exception";
      meta.critterCheckedAt = new Date().toISOString();
      batchJob.failed += 1;
    } finally {
      batchJob.processed += 1;
      metadata.items = Array.from(map.values());
      await saveMetadata();
    }
  }

  batchJob.status = "done";
  batchJob.finishedAt = new Date().toISOString();
}

app.post("/api/detect-critters", async (req, res) => {
  const payload = req.body || {};
  const targetPath = payload.path ? normalizeRelPath(payload.path) : "";

  const { apiKey } = getOpenRouterConfig();
  if (!apiKey) {
    res.status(400).json({ ok: false, error: "missing_key" });
    return;
  }

  if (!targetPath) {
    res.status(400).json({ ok: false, error: "missing_path" });
    return;
  }

  const ext = path.posix.extname(targetPath).toLowerCase();
  if (![".jpg", ".jpeg", ".png"].includes(ext)) {
    res.status(400).json({ ok: false, error: "not_image" });
    return;
  }

  try {
    const { result, error, status } = await detectCritterForPath(targetPath);
    if (error) {
      res.status(status || 500).json({ ok: false, error });
      return;
    }
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: "detect_failed" });
  }
});

app.post("/api/caption", async (req, res) => {
  const payload = req.body || {};
  const relPath = payload.path ? normalizeRelPath(payload.path) : "";
  const caption =
    typeof payload.caption === "string" ? payload.caption : "";
  if (!relPath) {
    res.status(400).json({ ok: false, error: "missing_path" });
    return;
  }
  if (caption.length > 1000) {
    res.status(400).json({ ok: false, error: "caption_too_long" });
    return;
  }

  const scanItems = await scanMedia();
  const map = await syncMetadata(scanItems);
  const entry = map.get(relPath);
  if (!entry) {
    res.status(404).json({ ok: false, error: "not_found" });
    return;
  }

  entry.caption = caption;
  metadata.items = Array.from(map.values());
  await saveMetadata();
  res.json({ ok: true, caption: entry.caption });
});

app.post("/api/caption/generate", async (req, res) => {
  const payload = req.body || {};
  const relPath = payload.path ? normalizeRelPath(payload.path) : "";
  if (!relPath) {
    res.status(400).json({ ok: false, error: "missing_path" });
    return;
  }
  const { apiKey } = getOpenRouterConfig();
  if (!apiKey) {
    res.status(400).json({ ok: false, error: "missing_key" });
    return;
  }

  const scanItems = await scanMedia();
  const map = await syncMetadata(scanItems);
  const item = scanItems.find((entry) => entry.path === relPath);
  if (!item) {
    res.status(404).json({ ok: false, error: "not_found" });
    return;
  }
  if (item.type !== "image") {
    res.status(400).json({ ok: false, error: "not_image" });
    return;
  }

  const imageInfo = await getCritterImageInfo(item);
  if (!imageInfo) {
    res.status(500).json({ ok: false, error: "no_preview" });
    return;
  }

  const model = getOpenRouterConfig().model;
  const result = await callOpenRouterForCaption(imageInfo, model);
  if (result.error) {
    res.status(502).json({ ok: false, error: result.error });
    return;
  }

  const entry = map.get(relPath);
  if (!entry) {
    res.status(404).json({ ok: false, error: "not_found" });
    return;
  }
  entry.caption = result.caption;
  metadata.items = Array.from(map.values());
  await saveMetadata();

  res.json({ ok: true, caption: result.caption, model });
});

app.post("/api/detect-critters/batch-delete", async (req, res) => {
  if (batchJob && batchJob.status === "running") {
    res.status(409).json({ ok: false, error: "job_running", job: batchJob });
    return;
  }

  const payload = req.body || {};
  const scope = payload.scope === "unreviewed" ? "unreviewed" : "all";

  const { apiKey } = getOpenRouterConfig();
  if (!apiKey) {
    res.status(400).json({ ok: false, error: "missing_key" });
    return;
  }

  batchJob = {
    id: Date.now().toString(36),
    status: "starting",
    phase: "detecting",
    total: 0,
    processed: 0,
    matched: 0,
    deleted: 0,
    failed: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  };

  runBatchCritterDeleteJob(batchJob.id, scope).catch((err) => {
    if (batchJob && batchJob.id) {
      batchJob.status = "error";
      batchJob.error = err.message;
      batchJob.finishedAt = new Date().toISOString();
    }
  });

  res.json({ ok: true, job: batchJob });
});

app.get("/api/detect-critters/batch-delete/status", (req, res) => {
  if (!batchJob) {
    res.json({ ok: true, status: "idle" });
    return;
  }
  res.json({ ok: true, job: batchJob });
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

  const prevStatus = entry.status;
  const prevReviewedAt = entry.reviewedAt ?? null;
  const prevFavoritedAt = entry.favoritedAt ?? null;
  const prevPath = normalizedPath;
  const sessionDate = ensureSessionDate();
  const folderName =
    action === "delete"
      ? `Trash_${sessionDate}`
      : action === "favorite"
      ? `Favorites_${sessionDate}`
      : `Keep_${sessionDate}`;
  const moveResults = { moved: [], missing: [], errors: [] };
  await moveItemsToFolder([entry], folderName, moveResults, {
    moved: "moved",
    missing: "missing",
    errors: "errors",
  });

  if (moveResults.errors.length > 0) {
    entry.status = prevStatus;
    entry.reviewedAt = prevReviewedAt;
    entry.favoritedAt = prevFavoritedAt;
    metadata.items = Array.from(map.values());
    await saveMetadata();
    res.status(500).json({ ok: false, error: "move_failed" });
    return;
  }

  const now = new Date().toISOString();
  entry.status = action;
  entry.reviewedAt = now;
  if (action === "favorite") {
    entry.favoritedAt = now;
  } else if (Object.prototype.hasOwnProperty.call(entry, "favoritedAt")) {
    entry.favoritedAt = null;
  }

  undoStack.push({
    prevPath,
    nextPath: entry.path,
    prevStatus,
    prevReviewedAt,
    prevFavoritedAt,
  });

  metadata.items = Array.from(map.values());
  await saveMetadata();

  res.json({
    ok: true,
    prevPath,
    path: entry.path,
    status: entry.status,
    reviewedAt: entry.reviewedAt,
    favoritedAt: entry.favoritedAt ?? null,
    missing: moveResults.missing.length > 0,
  });
});

app.post("/api/undo", async (req, res) => {
  const last = undoStack.pop();
  if (!last) {
    res.json({ ok: false });
    return;
  }

  const map = buildMetadataMap();
  const entry = map.get(last.nextPath) || map.get(last.prevPath);
  if (!entry) {
    undoStack.push(last);
    res.json({ ok: false });
    return;
  }

  if (entry.path !== last.prevPath) {
    const moveResults = { moved: [], missing: [], errors: [] };
    await moveItemToPath(entry, last.prevPath, moveResults, {
      moved: "moved",
      missing: "missing",
      errors: "errors",
    });
    if (moveResults.errors.length > 0) {
      undoStack.push(last);
      res.status(500).json({ ok: false, error: "undo_move_failed" });
      return;
    }
  }

  entry.status = last.prevStatus || "unreviewed";
  entry.reviewedAt = last.prevReviewedAt ?? null;
  if (Object.prototype.hasOwnProperty.call(entry, "favoritedAt")) {
    entry.favoritedAt = last.prevFavoritedAt ?? null;
  }

  metadata.items = Array.from(map.values());
  await saveMetadata();

  res.json({ ok: true, path: entry.path });
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

async function initialize() {
  await loadConfig();
  await loadMetadata();
  await fsp.mkdir(mediaRoot, { recursive: true });
}

async function start() {
  try {
    await initialize();
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`CamReview running on http://0.0.0.0:${PORT}`);
    });
  } catch (err) {
    console.error("Failed to start:", err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  start();
}

module.exports = { app, initialize };
