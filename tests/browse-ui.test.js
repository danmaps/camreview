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
  const styles = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
  const routeCss = fs.readFileSync(path.join(root, "public", "route.css"), "utf8");

  const dom = new JSDOM(html, {
    url: "http://localhost/browse",
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });

  const { window } = dom;
  const mediaProto = window.HTMLMediaElement.prototype;
  const styleTag = window.document.createElement("style");
  styleTag.textContent = `${styles}\n${routeCss}`;
  window.document.head.appendChild(styleTag);

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
      path: "2026-01-21/earlier.jpg",
      name: "earlier.jpg",
      folder: "2026-01-21",
      type: "image",
      status: "unreviewed",
      capturedAtMs: Date.parse("2026-01-21T10:02:00Z"),
      mtimeMs: Date.parse("2026-01-21T10:02:00Z"),
      sizeBytes: 150,
      caption: "",
    },
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
  const viewerDisplay = window.getComputedStyle(
    window.document.getElementById("viewer")
  ).display;

  assert.equal(
    fileName,
    "2026-01-21/newer.jpg",
    "browse viewer should default to the newest item in the full library"
  );
  assert.equal(
    viewerDisplay,
    "flex",
    "browse route should keep the viewer visible"
  );
  assert.match(libraryMeta, /Showing 3 of 3/);
  assert.equal(heatmapMeta, "All media · 3 captures");

  window.eval(`
    browseDayKey = "2026-01-18";
    browseHour = null;
    syncBrowseSelection();
    renderHeatmap();
    renderLibrary();
    render();
  `);

  const fileNameAfterMismatch = window.document.getElementById("fileName").textContent;
  const libraryMetaAfterMismatch = window.document.getElementById("libraryMeta").textContent;
  const heatmapMetaAfterMismatch = window.document.getElementById("heatmapMeta").textContent;

  assert.equal(
    fileNameAfterMismatch,
    "2026-01-21/newer.jpg",
    "browse viewer should stay on visible media when the day selection is stale"
  );
  assert.match(libraryMetaAfterMismatch, /Showing 3 of 3/);
  assert.equal(heatmapMetaAfterMismatch, "All media · 3 captures");

  const dayButton = window.document.querySelector('[data-day="2026-01-19"]');
  assert.ok(dayButton, "expected a heatmap button for 2026-01-19");
  dayButton.click();

  const fileNameAfterDaySelect = window.document.getElementById("fileName").textContent;
  const libraryMetaAfterDaySelect = window.document.getElementById("libraryMeta").textContent;
  const heatmapMetaAfterDaySelect = window.document.getElementById("heatmapMeta").textContent;

  assert.equal(
    fileNameAfterDaySelect,
    "2026-01-19/older.jpg",
    "selecting a day should scope browse to that day's media"
  );
  assert.match(libraryMetaAfterDaySelect, /Showing 1 of 1/);
  assert.equal(heatmapMetaAfterDaySelect, "2026-01-19 · 1 captures");

  dayButton.click();

  const fileNameAfterDayClear = window.document.getElementById("fileName").textContent;
  const libraryMetaAfterDayClear = window.document.getElementById("libraryMeta").textContent;
  const heatmapMetaAfterDayClear = window.document.getElementById("heatmapMeta").textContent;

  assert.equal(
    fileNameAfterDayClear,
    "2026-01-19/older.jpg",
    "clearing the day filter should restore the full library without dropping the current selection"
  );
  assert.match(libraryMetaAfterDayClear, /Showing 3 of 3/);
  assert.equal(heatmapMetaAfterDayClear, "All media · 3 captures");

  console.log("ok - browse route defaults to all media and ignores stale day filters");
}

main().catch((err) => {
  console.error("not ok - browse route defaults to all media and ignores stale day filters");
  console.error(err);
  process.exit(1);
});
