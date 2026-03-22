const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");

function buildJsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    async json() {
      return payload;
    },
  };
}

async function main() {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const script = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");

  const dom = new JSDOM(html, {
    url: "http://localhost/browse",
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });

  const { window } = dom;
  const mediaProto = window.HTMLMediaElement.prototype;

  window.matchMedia = (query) => ({
    matches: query.includes("min-width: 900px"),
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  });

  mediaProto.load = function load() {};
  mediaProto.pause = function pause() {};
  mediaProto.play = function play() {
    return Promise.resolve();
  };

  const queueItems = [
    {
      path: "2026-01-19/older.jpg",
      name: "older.jpg",
      folder: "2026-01-19",
      type: "image",
      status: "unreviewed",
      capturedAtMs: Date.parse("2026-01-19T16:31:50Z"),
      mtimeMs: Date.parse("2026-01-19T16:31:50Z"),
      sizeBytes: 100,
      caption: "",
    },
  ];

  const libraryItems = [
    queueItems[0],
    {
      path: "2026-01-21/newer.jpg",
      name: "newer.jpg",
      folder: "2026-01-21",
      type: "image",
      status: "unreviewed",
      capturedAtMs: Date.parse("2026-01-21T11:37:12Z"),
      mtimeMs: Date.parse("2026-01-21T11:37:12Z"),
      sizeBytes: 200,
      caption: "",
    },
  ];

  window.fetch = async (url) => {
    if (url === "/api/items") {
      return buildJsonResponse({
        items: queueItems,
        counts: { total: libraryItems.length, reviewed: 0, remaining: 2 },
      });
    }
    if (url === "/api/library") {
      return buildJsonResponse({ items: libraryItems });
    }
    return buildJsonResponse({ ok: true });
  };

  window.eval(script);
  await new Promise((resolve) => window.setTimeout(resolve, 25));

  const fileName = window.document.getElementById("fileName").textContent;
  const libraryMeta = window.document.getElementById("libraryMeta").textContent;
  const heatmapMeta = window.document.getElementById("heatmapMeta").textContent;

  assert.equal(
    fileName,
    "2026-01-21/newer.jpg",
    "browse viewer should follow the browse day selection"
  );
  assert.match(libraryMeta, /Showing 1 of 1/);
  assert.match(heatmapMeta, /2026-01-21/);

  console.log("ok - browse route viewer stays in sync with browse selection");
}

main().catch((err) => {
  console.error("not ok - browse route viewer stays in sync with browse selection");
  console.error(err);
  process.exit(1);
});
