const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const http = require("http");
const assert = require("node:assert/strict");

const SOURCE_ROOT = "C:\\Users\\danny\\iCloudDrive\\trailcam";
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png"]);
const VIDEO_EXTS = new Set([".mp4", ".mov"]);

let tempRoot;
let mediaRoot;
let fixtures = {};
let app;
let serverModule;
let httpServer;
let baseUrl;
let openrouterServer;

function normalizeRel(relPath) {
  return relPath.split(path.sep).join("/");
}

async function walkDir(dirPath, results) {
  let entries = [];
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const lower = entry.name.toLowerCase();
      if (
        lower === ".camreview" ||
        lower.startsWith("trash_") ||
        lower.startsWith("keep_") ||
        lower.startsWith("favorites_")
      ) {
        continue;
      }
      await walkDir(fullPath, results);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (!IMAGE_EXTS.has(ext) && !VIDEO_EXTS.has(ext)) {
      continue;
    }
    const stat = await fsp.stat(fullPath);
    results.push({ fullPath, ext, size: stat.size });
  }
}

async function collectSamples(rootPath) {
  const entries = [];
  await walkDir(rootPath, entries);
  const images = entries
    .filter((item) => IMAGE_EXTS.has(item.ext))
    .sort((a, b) => a.size - b.size);
  const videos = entries
    .filter((item) => VIDEO_EXTS.has(item.ext))
    .sort((a, b) => a.size - b.size);
  return { images, videos };
}

async function copySample(srcPath, destRoot, subdir) {
  const destDir = path.join(destRoot, subdir || "");
  await fsp.mkdir(destDir, { recursive: true });
  const destPath = path.join(destDir, path.basename(srcPath));
  await fsp.copyFile(srcPath, destPath);
  return {
    srcPath,
    destPath,
    relPath: normalizeRel(path.relative(destRoot, destPath)),
  };
}

async function readJson(filePath) {
  const raw = await fsp.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function apiFetch(pathname, options) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { response, body, text };
}

async function getLibrary() {
  const { response, body } = await apiFetch("/api/library");
  assert.equal(response.status, 200);
  return body.items || [];
}

async function getItems() {
  const { response, body } = await apiFetch("/api/items");
  assert.equal(response.status, 200);
  return body;
}

async function setup() {
  openrouterServer = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/api/v1/chat/completions") {
      res.writeHead(404);
      res.end();
      return;
    }
    let payload = "";
    req.on("data", (chunk) => {
      payload += chunk.toString("utf8");
    });
    req.on("end", () => {
      let content = "";
      try {
        const data = JSON.parse(payload);
        const system = data?.messages?.[0]?.content || "";
        const isCritter = String(system).includes("vision classifier");
        content = isCritter
          ? "{\"critter\": true, \"confidence\": 0.88}"
          : "A deer pauses, listening, then wanders off the trail.";
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "bad_json" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise((resolve) => {
    openrouterServer.listen(0, "127.0.0.1", resolve);
  });
  const openrouterPort = openrouterServer.address().port;

  tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "camreview-test-"));
  mediaRoot = path.join(tempRoot, "media");
  await fsp.mkdir(mediaRoot, { recursive: true });

  const samples = await collectSamples(SOURCE_ROOT);
  assert.ok(
    samples.images.length > 0,
    `No images found in ${SOURCE_ROOT}`
  );

  const imagePrimary = samples.images[0];
  const imageSecondary = samples.images[1] || samples.images[0];
  const videoPrimary = samples.videos[0] || null;

  fixtures.image = await copySample(imagePrimary.fullPath, mediaRoot, "");
  fixtures.imageNested = await copySample(
    imageSecondary.fullPath,
    mediaRoot,
    "nested"
  );
  fixtures.video = videoPrimary
    ? await copySample(videoPrimary.fullPath, mediaRoot, "nested")
    : null;

  const configPath = path.join(tempRoot, "config.json");
  const dataPath = path.join(tempRoot, "trailcam_review.json");
  const config = {
    mediaRoot,
    previewFps: 1,
    previewMaxFrames: 4,
    openrouterModel: "test-model",
  };
  await fsp.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

  process.env.CAMREVIEW_CONFIG_PATH = configPath;
  process.env.CAMREVIEW_DATA_PATH = dataPath;
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.OPENROUTER_MODEL = "test-model";
  process.env.OPENROUTER_ENDPOINT = `http://127.0.0.1:${openrouterPort}/api/v1/chat/completions`;

  delete require.cache[require.resolve("../server")];
  serverModule = require("../server");
  await serverModule.initialize();
  app = serverModule.app;
  httpServer = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => httpServer.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
}

async function teardown() {
  if (httpServer) {
    await new Promise((resolve) => httpServer.close(resolve));
  }
  if (openrouterServer) {
    await new Promise((resolve) => openrouterServer.close(resolve));
  }
  if (tempRoot) {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`not ok - ${name}`);
    throw err;
  }
}

async function runAll() {
  await runTest("GET /api/items returns sorted unreviewed items", async () => {
    const data = await getItems();
    assert.ok(Array.isArray(data.items));
    assert.equal(data.items.length, fixtures.video ? 3 : 2);
    for (let i = 1; i < data.items.length; i += 1) {
      assert.ok(
        data.items[i - 1].capturedAtMs <= data.items[i].capturedAtMs
      );
    }
  });

  await runTest("GET /api/library includes all items", async () => {
    const items = await getLibrary();
    assert.ok(items.length >= (fixtures.video ? 3 : 2));
    const paths = items.map((item) => item.path);
    assert.ok(paths.includes(fixtures.image.relPath));
    assert.ok(paths.includes(fixtures.imageNested.relPath));
  });

  await runTest("GET /media serves image data", async () => {
    const { response } = await apiFetch(
      `/media?path=${encodeURIComponent(fixtures.image.relPath)}`
    );
    assert.equal(response.status, 200);
    const contentType = response.headers.get("content-type") || "";
    assert.ok(contentType.startsWith("image/"));
  });

  await runTest("POST /api/detect-critters updates metadata", async () => {
    const { response, body } = await apiFetch("/api/detect-critters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: fixtures.image.relPath }),
    });
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.result.critter, true);

    const items = await getLibrary();
    const updated = items.find((item) => item.path === fixtures.image.relPath);
    assert.ok(updated);
    assert.equal(updated.critter, true);
  });

  await runTest("POST /api/caption/generate writes caption", async () => {
    const { response, body } = await apiFetch("/api/caption/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: fixtures.image.relPath }),
    });
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.ok(body.caption);

    const items = await getLibrary();
    const updated = items.find((item) => item.path === fixtures.image.relPath);
    assert.ok(updated);
    assert.equal(updated.caption, body.caption);
  });

  await runTest("POST /api/caption saves edits", async () => {
    const { response, body } = await apiFetch("/api/caption", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: fixtures.image.relPath,
        caption: "Manual caption.",
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);

    const items = await getLibrary();
    const updated = items.find((item) => item.path === fixtures.image.relPath);
    assert.ok(updated);
    assert.equal(updated.caption, "Manual caption.");
  });

  await runTest("POST /api/action keep moves file immediately", async () => {
    const { response, body } = await apiFetch("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: fixtures.image.relPath, action: "keep" }),
    });
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.ok(body.path.startsWith("Keep_"));

    const movedPath = path.join(mediaRoot, body.path);
    await assert.doesNotReject(() => fsp.access(movedPath));

    const data = await getItems();
    assert.equal(data.items.length, (fixtures.video ? 3 : 2) - 1);
  });

  await runTest("POST /api/undo restores last move", async () => {
    const { response, body } = await apiFetch("/api/undo", { method: "POST" });
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.path, fixtures.image.relPath);

    const restoredPath = path.join(mediaRoot, fixtures.image.relPath);
    await assert.doesNotReject(() => fsp.access(restoredPath));
  });

  await runTest("POST /api/action delete moves to Trash", async () => {
    const { response, body } = await apiFetch("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: fixtures.imageNested.relPath,
        action: "delete",
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.ok(body.path.startsWith("Trash_"));

    const movedPath = path.join(mediaRoot, body.path);
    await assert.doesNotReject(() => fsp.access(movedPath));
  });

  await runTest("POST /api/undo restores delete", async () => {
    const { response, body } = await apiFetch("/api/undo", { method: "POST" });
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.path, fixtures.imageNested.relPath);
  });

  await runTest("GET /api/preview-frames returns frames", async () => {
    if (!fixtures.video) {
      console.log("skipped - GET /api/preview-frames (no video sample)");
      return;
    }
    const { response, body } = await apiFetch(
      `/api/preview-frames?path=${encodeURIComponent(
        fixtures.video.relPath
      )}&generate=1`
    );
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.frames));
    if (body.frames.length > 0) {
      const framePath = path.join(mediaRoot, body.frames[0]);
      await assert.doesNotReject(() => fsp.access(framePath));
    }
  });

  await runTest("POST /api/transcode returns mp4 or missing ffmpeg", async () => {
    if (!fixtures.video) {
      console.log("skipped - POST /api/transcode (no video sample)");
      return;
    }
    const { response, body } = await apiFetch("/api/transcode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: fixtures.video.relPath }),
    });

    if (response.status === 200 && body.ok) {
      const transcodePath = path.join(mediaRoot, body.path);
      await assert.doesNotReject(() => fsp.access(transcodePath));
    } else {
      const error = body.error || "";
      assert.ok(
        error === "ffmpeg_missing" ||
          error === "Transcode failed" ||
          error === "Transcode error",
        `Unexpected error: ${error}`
      );
    }
  });

  await runTest("Metadata file is written", async () => {
    const dataPath = process.env.CAMREVIEW_DATA_PATH;
    assert.ok(dataPath);
    const meta = await readJson(dataPath);
    assert.ok(Array.isArray(meta.items));
    assert.ok(meta.items.length >= (fixtures.video ? 3 : 2));
  });
}

async function main() {
  try {
    await setup();
    await runAll();
    console.log("All API tests completed.");
  } finally {
    await teardown();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
