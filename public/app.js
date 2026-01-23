const state = {
  items: [],
  index: 0,
  counts: { total: 0, reviewed: 0, remaining: 0 },
  library: [],
  libraryIndex: 0,
  viewMode: "queue",
};

const elements = {
  viewer: document.getElementById("viewer"),
  mediaCard: document.getElementById("mediaCard"),
  imageView: document.getElementById("imageView"),
  previewView: document.getElementById("previewView"),
  videoView: document.getElementById("videoView"),
  emptyState: document.getElementById("emptyState"),
  progressText: document.getElementById("progressText"),
  fileInfo: document.getElementById("fileInfo"),
  fileName: document.getElementById("fileName"),
  status: document.getElementById("status"),
  keepBtn: document.getElementById("keepBtn"),
  deleteBtn: document.getElementById("deleteBtn"),
  favoriteBtn: document.getElementById("favoriteBtn"),
  swipeKeep: document.getElementById("swipeKeep"),
  swipeDelete: document.getElementById("swipeDelete"),
  swipeFavorite: document.getElementById("swipeFavorite"),
  undoBtn: document.getElementById("undoBtn"),
  applyBtn: document.getElementById("applyBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  prevBtn: document.getElementById("prevBtn"),
  nextBtn: document.getElementById("nextBtn"),
  libraryToggle: document.getElementById("libraryToggle"),
  libraryPanel: document.getElementById("libraryPanel"),
  libraryResizer: document.getElementById("libraryResizer"),
  librarySearch: document.getElementById("librarySearch"),
  libraryFilter: document.getElementById("libraryFilter"),
  libraryBody: document.getElementById("libraryBody"),
  libraryMeta: document.getElementById("libraryMeta"),
};

const preload = {
  image: new Image(),
  video: document.createElement("video"),
};
preload.video.preload = "metadata";

const deviceInfo = {
  isTouch:
    (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) ||
    navigator.maxTouchPoints > 0,
};

let actionInFlight = false;
let mediaToken = 0;
let previewToken = 0;
let previewAvailable = false;
let revealPreview = false;
let activeVideoToken = 0;
let currentItemType = "";
const transcodeState = new Map();
const transcodeMap = new Map();
let previewFrames = [];
let previewFrameIndex = 0;
let previewTimer = null;
const swipeState = {
  pointerId: null,
  startX: 0,
  startY: 0,
  lastX: 0,
  lastY: 0,
  dragging: false,
};
const resizeState = {
  dragging: false,
  startX: 0,
  startWidth: 0,
  lastWidth: 0,
};

function setStatus(message) {
  elements.status.textContent = message || "";
}

function setFileName(value) {
  if (!elements.fileName) {
    return;
  }
  elements.fileName.textContent = value || "";
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getTypeBadge(type) {
  if (type === "video") {
    return "\uD83C\uDFA5";
  }
  if (type === "image") {
    return "\uD83D\uDDBC\uFE0F";
  }
  return "\uD83D\uDCC4";
}

function getActiveList() {
  return state.viewMode === "library" ? state.library : state.items;
}

function getActiveIndex() {
  return state.viewMode === "library" ? state.libraryIndex : state.index;
}

function setActiveIndex(index) {
  if (state.viewMode === "library") {
    state.libraryIndex = index;
  } else {
    state.index = index;
  }
}

function currentItem() {
  const list = getActiveList();
  if (list.length === 0) {
    return null;
  }
  const index = getActiveIndex();
  return list[index] || null;
}

function currentPath() {
  const item = currentItem();
  return item ? item.path : "";
}

function updateProgress() {
  const { total, reviewed, remaining } = state.counts;
  elements.progressText.textContent = `${reviewed} / ${total} reviewed | ${remaining} left`;
  if (!total) {
    elements.progressText.textContent = "0 reviewed | 0 left";
  }
}

function updateNavButtons() {
  const list = getActiveList();
  const enabled = list.length > 1;
  const hasItems = list.length > 0;
  if (elements.prevBtn) {
    elements.prevBtn.disabled = !hasItems || !enabled;
  }
  if (elements.nextBtn) {
    elements.nextBtn.disabled = !hasItems || !enabled;
  }
}

function findQueueIndexByPath(path) {
  return state.items.findIndex((item) => item.path === path);
}

function findLibraryIndexByPath(path) {
  return state.library.findIndex((item) => item.path === path);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return "-";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatDate(ms) {
  if (!Number.isFinite(ms)) {
    return "-";
  }
  return new Date(ms).toLocaleString();
}

function formatReviewed(ts) {
  if (!ts) {
    return "-";
  }
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) {
    return "-";
  }
  return new Date(parsed).toLocaleString();
}

function updateActiveRow() {
  const active = currentPath();
  if (!elements.libraryBody) {
    return;
  }
  const rows = elements.libraryBody.querySelectorAll("tr[data-path]");
  let activeRow = null;
  rows.forEach((row) => {
    const isActive = row.dataset.path === active;
    row.classList.toggle("active", isActive);
    if (isActive) {
      activeRow = row;
    }
  });
  if (activeRow && elements.libraryPanel) {
    if (!elements.libraryPanel.classList.contains("collapsed")) {
      activeRow.scrollIntoView({ block: "nearest" });
    }
  }
}


function renderLibrary() {
  if (!elements.libraryBody) {
    return;
  }
  const query = (elements.librarySearch?.value || "")
    .trim()
    .toLowerCase();
  const filter = elements.libraryFilter?.value || "all";
  const allItems = state.library;
  const filtered = allItems.filter((item) => {
    if (filter !== "all" && item.status !== filter) {
      return false;
    }
    if (!query) {
      return true;
    }
    const haystack = `${item.name || ""} ${item.folder || ""} ${item.path || ""}`.toLowerCase();
    return haystack.includes(query);
  });

  const fragment = document.createDocumentFragment();
  for (const item of filtered) {
    const row = document.createElement("tr");
    row.dataset.path = item.path;

    const typeCell = document.createElement("td");
    const typeBadge = document.createElement("span");
    typeBadge.className = "type-badge";
    typeBadge.textContent = getTypeBadge(item.type);
    typeBadge.title = (item.type || "").toUpperCase();
    typeCell.appendChild(typeBadge);

    const nameCell = document.createElement("td");
    nameCell.textContent = item.name || item.path;

    const folderCell = document.createElement("td");
    folderCell.textContent = item.folder || ".";

    const modifiedCell = document.createElement("td");
    modifiedCell.textContent = formatDate(item.capturedAtMs);

    const sizeCell = document.createElement("td");
    sizeCell.textContent = formatBytes(item.sizeBytes);

    const statusCell = document.createElement("td");
    statusCell.textContent = (item.status || "unreviewed").toUpperCase();

    const reviewedCell = document.createElement("td");
    reviewedCell.textContent = formatReviewed(item.reviewedAt);

    row.append(
      typeCell,
      nameCell,
      folderCell,
      modifiedCell,
      sizeCell,
      statusCell,
      reviewedCell
    );
    fragment.appendChild(row);
  }

  elements.libraryBody.replaceChildren(fragment);
  if (elements.libraryMeta) {
    elements.libraryMeta.textContent = `Showing ${filtered.length} of ${allItems.length}`;
  }
  updateActiveRow();
}

const libraryStorageKey = "camreview_library_open";
const libraryWidthKey = "camreview_library_width";
const libraryWidthBounds = { min: 260, max: 640, default: 360 };

function setLibraryOpen(open) {
  if (!elements.libraryPanel) {
    return;
  }
  if (open) {
    elements.libraryPanel.classList.remove("collapsed");
    elements.libraryPanel.setAttribute("aria-hidden", "false");
    if (elements.libraryToggle) {
      elements.libraryToggle.textContent = "Hide List";
    }
  } else {
    elements.libraryPanel.classList.add("collapsed");
    elements.libraryPanel.setAttribute("aria-hidden", "true");
    if (elements.libraryToggle) {
      elements.libraryToggle.textContent = "List";
    }
  }
  try {
    localStorage.setItem(libraryStorageKey, open ? "1" : "0");
  } catch {
    // ignore storage errors
  }

  if (elements.libraryResizer) {
    elements.libraryResizer.classList.toggle("hidden", !open);
  }
}

function applyLibraryWidth(width, persist = true) {
  if (!elements.libraryPanel) {
    return;
  }
  const clamped = clamp(
    width,
    libraryWidthBounds.min,
    libraryWidthBounds.max
  );
  elements.libraryPanel.style.setProperty("--library-width", `${clamped}px`);
  if (persist) {
    try {
      localStorage.setItem(libraryWidthKey, String(clamped));
    } catch {
      // ignore storage errors
    }
  }
}

function getStoredLibraryWidth() {
  try {
    const raw = localStorage.getItem(libraryWidthKey);
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  } catch {
    // ignore storage errors
  }
  return libraryWidthBounds.default;
}

function resetSwipeUI() {
  elements.mediaCard.style.transform = "";
  elements.mediaCard.style.opacity = "";
  elements.mediaCard.classList.remove("dragging");
  elements.swipeKeep.style.opacity = "0";
  elements.swipeDelete.style.opacity = "0";
  elements.swipeFavorite.style.opacity = "0";
  elements.swipeKeep.style.transform = "scale(0.92)";
  elements.swipeDelete.style.transform = "scale(0.92)";
  elements.swipeFavorite.style.transform = "translateX(-50%) scale(0.92)";
}

function showPreview() {
  if (previewAvailable && revealPreview) {
    elements.previewView.classList.remove("hidden");
  } else {
    elements.previewView.classList.add("hidden");
  }
}

function getVideoRelPath(item) {
  if (!item || !item.path) {
    return "";
  }
  return transcodeMap.get(item.path) || item.path;
}

function clearPreviewCycle() {
  if (previewTimer) {
    window.clearInterval(previewTimer);
    previewTimer = null;
  }
  previewFrames = [];
  previewFrameIndex = 0;
}

function setPreviewFrames(frames) {
  clearPreviewCycle();
  previewFrames = frames || [];
  previewFrameIndex = 0;
  if (previewFrames.length > 0) {
    revealPreview = true;
    elements.previewView.src = previewFrames[0];
    previewAvailable = true;
    showPreview();
    if (previewFrames.length > 1) {
      previewTimer = window.setInterval(() => {
        previewFrameIndex =
          (previewFrameIndex + 1) % previewFrames.length;
        elements.previewView.src = previewFrames[previewFrameIndex];
      }, 700);
    }
  } else {
    revealPreview = false;
    previewAvailable = false;
    showPreview();
  }
}

function showEmpty() {
  resetSwipeUI();
  clearPreviewCycle();
  elements.previewView.classList.add("hidden");
  setStatus("");
  revealPreview = false;
  currentItemType = "";
  elements.imageView.classList.add("hidden");
  elements.videoView.classList.add("hidden");
  elements.emptyState.classList.remove("hidden");
  setFileName("");
}

function showMedia(item) {
  const url = `/media?path=${encodeURIComponent(item.path)}`;
  elements.emptyState.classList.add("hidden");
  clearPreviewCycle();
  elements.previewView.classList.add("hidden");
  setStatus("");
  mediaToken += 1;
  previewToken += 1;
  revealPreview = false;
  currentItemType = item.type;

  const cleanedPath = item.path || "";
  setFileName(cleanedPath);

  if (item.type === "video") {
    const previewUrl = `/preview?path=${encodeURIComponent(item.path)}`;
    previewAvailable = false;
    const previewTokenLocal = previewToken;
    const mediaTokenLocal = mediaToken;
    activeVideoToken = mediaTokenLocal;

    elements.previewView.onload = () => {
      if (previewTokenLocal === previewToken) {
        previewAvailable = true;
        showPreview();
      }
    };
    elements.previewView.onerror = () => {
      if (previewTokenLocal === previewToken) {
        previewAvailable = false;
        showPreview();
      }
    };

    const videoRelPath = getVideoRelPath(item);
    const videoUrl = `/media?path=${encodeURIComponent(videoRelPath)}`;

    elements.imageView.classList.add("hidden");
    elements.previewView.classList.add("hidden");
    elements.previewView.src = previewUrl;
    elements.videoView.classList.remove("hidden");
    elements.videoView.poster = previewUrl;
    elements.videoView.src = videoUrl;
    elements.videoView.dataset.token = String(mediaTokenLocal);
    elements.videoView.load();
    elements.videoView.muted = true;
    elements.videoView.loop = true;
    elements.videoView.autoplay = true;
    const playAttempt = elements.videoView.play();
    if (playAttempt && typeof playAttempt.catch === "function") {
      playAttempt.catch(() => {
        if (
          elements.videoView.dataset.token === String(mediaTokenLocal) &&
          currentItemType === "video"
        ) {
          handleVideoFailure("Video playback failed on this device.");
        }
      });
    }
  } else {
    previewAvailable = false;
    activeVideoToken = 0;
    elements.videoView.dataset.token = "";
    elements.videoView.pause();
    elements.videoView.removeAttribute("src");
    elements.videoView.load();
    elements.videoView.classList.add("hidden");
    elements.previewView.classList.add("hidden");
    elements.imageView.classList.remove("hidden");
    elements.imageView.src = url;
  }

  preloadNext();
}


async function requestTranscode() {
  const item = currentItem();
  if (!item || item.type !== "video") {
    return;
  }
  const key = item.path;
  const existing = transcodeState.get(key);
  if (existing === "running" || existing === "ready") {
    return;
  }

  transcodeState.set(key, "running");
  setStatus("Creating a phone-friendly copy...");

  try {
    const response = await fetch("/api/transcode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: item.path }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      if (data.error === "ffmpeg_missing") {
        setStatus("Install ffmpeg on the CamReview computer to enable this.");
      } else {
        setStatus("Transcode failed. Try again later.");
      }
      transcodeState.set(key, "failed");
      return;
    }
    if (data.path) {
      transcodeMap.set(key, data.path);
    }
    transcodeState.set(key, "ready");
    setStatus("");
    showMedia(item);
  } catch (err) {
    setStatus("Transcode failed. Check the server logs.");
    transcodeState.set(key, "failed");
  }
}

async function loadPreviewFrames(generate) {
  const item = currentItem();
  if (!item || item.type !== "video") {
    return;
  }
  const token = mediaToken;
  const params = new URLSearchParams({ path: item.path });
  if (generate) {
    params.set("generate", "1");
  }
  try {
    const response = await fetch(`/api/preview-frames?${params.toString()}`);
    const data = await response.json();
    if (!response.ok || !data.ok) {
      return;
    }
    if (token !== mediaToken || currentItemType !== "video") {
      return;
    }
    const frames = (data.frames || []).map(
      (relPath) => `/media?path=${encodeURIComponent(relPath)}`
    );
    if (frames.length > 0) {
      setPreviewFrames(frames);
    }
  } catch {
    // ignore preview errors
  }
}

function preloadNext() {
  const list = getActiveList();
  const index = getActiveIndex();
  const next = list[index + 1];
  if (!next) {
    return;
  }
  const url = `/media?path=${encodeURIComponent(next.path)}`;
  if (next.type === "video") {
    preload.video.src = url;
  } else {
    preload.image.src = url;
  }
}

function render() {
  updateProgress();
  updateNavButtons();
  const item = currentItem();
  if (!item) {
    showEmpty();
    updateActiveRow();
    return;
  }
  resetSwipeUI();
  showMedia(item);
  updateActiveRow();
}

function selectLibraryPath(path) {
  const libraryIndex = findLibraryIndexByPath(path);
  if (libraryIndex < 0) {
    return;
  }
  const item = state.library[libraryIndex];
  if (item && item.status === "unreviewed") {
    const queueIndex = findQueueIndexByPath(path);
    if (queueIndex >= 0) {
      state.viewMode = "queue";
      state.index = queueIndex;
      render();
      return;
    }
  }
  state.viewMode = "library";
  state.libraryIndex = libraryIndex;
  render();
}

async function fetchItems(selectPath) {
  setStatus("Scanning...");
  const activePath = selectPath || currentPath();
  const activeMode = state.viewMode;

  const [queueResponse, libraryResponse] = await Promise.all([
    fetch("/api/items"),
    fetch("/api/library"),
  ]);
  const queueData = await queueResponse.json();
  const libraryData = await libraryResponse.json();

  state.items = queueData.items || [];
  state.counts = queueData.counts || { total: 0, reviewed: 0, remaining: 0 };
  state.library = libraryData.items || [];
  state.index = 0;
  state.libraryIndex = 0;
  state.viewMode = "queue";

  if (activePath) {
    const queueIndex = findQueueIndexByPath(activePath);
    const libraryIndex = findLibraryIndexByPath(activePath);
    if (activeMode === "library" && libraryIndex >= 0) {
      state.libraryIndex = libraryIndex;
      state.viewMode = "library";
    } else if (queueIndex >= 0) {
      state.index = queueIndex;
      state.viewMode = "queue";
    } else if (libraryIndex >= 0) {
      state.libraryIndex = libraryIndex;
      state.viewMode = "library";
    }
  }
  setStatus("");
  renderLibrary();
  render();
}

async function sendAction(action) {
  const item = currentItem();
  if (!item || actionInFlight) {
    return;
  }
  actionInFlight = true;
  setStatus(`${action}...`);
  try {
    const response = await fetch("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: item.path, action }),
    });
    if (!response.ok) {
      setStatus("Action failed");
      resetSwipeUI();
      return;
    }

    const queueIndex = findQueueIndexByPath(item.path);
    if (queueIndex >= 0) {
      state.items.splice(queueIndex, 1);
      state.counts.reviewed += 1;
      state.counts.remaining = state.items.length;
      state.counts.total = state.counts.reviewed + state.counts.remaining;
      if (state.viewMode === "queue") {
        if (queueIndex < state.index) {
          state.index = Math.max(0, state.index - 1);
        }
        if (state.index >= state.items.length) {
          state.index = 0;
        }
      }
    }

    const libraryIndex = findLibraryIndexByPath(item.path);
    if (libraryIndex >= 0) {
      const updated = {
        ...state.library[libraryIndex],
        status: action,
        reviewedAt: new Date().toISOString(),
      };
      state.library.splice(libraryIndex, 1, updated);
      if (state.viewMode === "library" && state.libraryIndex === libraryIndex) {
        state.libraryIndex = libraryIndex;
      }
    }
    setStatus("");
    renderLibrary();
    render();
  } finally {
    actionInFlight = false;
  }
}

async function undoLast() {
  setStatus("Undoing...");
  const response = await fetch("/api/undo", { method: "POST" });
  const data = await response.json();
  if (!data.ok) {
    setStatus("Nothing to undo");
    return;
  }
  await fetchItems(data.path);
}

async function applyDeletes() {
  setStatus("Applying changes...");
  const response = await fetch("/api/apply-deletes", { method: "POST" });
  const data = await response.json();
  if (!data.ok) {
    setStatus("Apply failed");
    return;
  }
  const movedTrash = Array.isArray(data.moved) ? data.moved.length : 0;
  const movedFavorites = Array.isArray(data.favoritesMoved)
    ? data.favoritesMoved.length
    : 0;
  const parts = [];
  if (movedTrash) {
    parts.push(`Trash: ${movedTrash}`);
  }
  if (movedFavorites) {
    parts.push(`Favorites: ${movedFavorites}`);
  }
  if (parts.length === 0) {
    setStatus("No changes to apply");
  } else {
    setStatus(`Moved ${parts.join(" | ")}`);
  }
  await fetchItems();
}

elements.keepBtn.addEventListener("click", () => sendAction("keep"));
elements.deleteBtn.addEventListener("click", () => sendAction("delete"));
elements.favoriteBtn.addEventListener("click", () => sendAction("favorite"));
elements.undoBtn.addEventListener("click", undoLast);
elements.applyBtn.addEventListener("click", applyDeletes);
elements.refreshBtn.addEventListener("click", () => fetchItems());
elements.prevBtn.addEventListener("click", () => moveIndex(-1));
elements.nextBtn.addEventListener("click", () => moveIndex(1));
if (elements.libraryToggle) {
  elements.libraryToggle.addEventListener("click", () => {
    const isOpen = !elements.libraryPanel?.classList.contains("collapsed");
    setLibraryOpen(!isOpen);
  });
}
if (elements.librarySearch) {
  elements.librarySearch.addEventListener("input", () => {
    renderLibrary();
  });
}
if (elements.libraryFilter) {
  elements.libraryFilter.addEventListener("change", () => {
    renderLibrary();
  });
}
if (elements.libraryBody) {
  elements.libraryBody.addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-path]");
    if (!row) {
      return;
    }
    selectLibraryPath(row.dataset.path);
  });
}
function onResizerDown(event) {
  if (!elements.libraryPanel || !elements.libraryResizer) {
    return;
  }
  if (elements.libraryPanel.classList.contains("collapsed")) {
    return;
  }
  if (event.pointerType === "mouse" && event.button !== 0) {
    return;
  }
  if (resizeState.dragging) {
    return;
  }
  resizeState.dragging = true;
  resizeState.startX = event.clientX;
  resizeState.startWidth = elements.libraryPanel.getBoundingClientRect().width;
  resizeState.lastWidth = resizeState.startWidth;
  elements.libraryResizer.classList.add("active");
  document.body.classList.add("resizing");
  elements.libraryResizer.setPointerCapture?.(event.pointerId);
  window.addEventListener("pointermove", onResizerMove);
  window.addEventListener("pointerup", onResizerUp);
  window.addEventListener("pointercancel", onResizerUp);
  event.preventDefault();
}

function onResizerMove(event) {
  if (!resizeState.dragging) {
    return;
  }
  const delta = event.clientX - resizeState.startX;
  const nextWidth = resizeState.startWidth - delta;
  resizeState.lastWidth = nextWidth;
  applyLibraryWidth(nextWidth, false);
}

function onResizerUp() {
  if (!resizeState.dragging) {
    return;
  }
  resizeState.dragging = false;
  if (elements.libraryResizer) {
    elements.libraryResizer.classList.remove("active");
  }
  document.body.classList.remove("resizing");
  applyLibraryWidth(resizeState.lastWidth, true);
  window.removeEventListener("pointermove", onResizerMove);
  window.removeEventListener("pointerup", onResizerUp);
  window.removeEventListener("pointercancel", onResizerUp);
}

if (elements.libraryResizer) {
  elements.libraryResizer.addEventListener("pointerdown", onResizerDown);
}

function moveIndex(delta) {
  if (actionInFlight) {
    return;
  }
  const list = getActiveList();
  const total = list.length;
  if (!total) {
    return;
  }
  const nextIndex = (getActiveIndex() + delta + total) % total;
  setActiveIndex(nextIndex);
  render();
}

function isCurrentVideo() {
  return (
    currentItemType === "video" &&
    activeVideoToken !== 0 &&
    elements.videoView.dataset.token === String(activeVideoToken)
  );
}

elements.videoView.addEventListener("playing", () => {
  if (!isCurrentVideo()) {
    return;
  }
  clearPreviewCycle();
  revealPreview = false;
  showPreview();
  setStatus("");
});

elements.videoView.addEventListener("error", () => {
  if (!isCurrentVideo()) {
    return;
  }
  handleVideoFailure("Video format not supported.");
});

elements.imageView.addEventListener("load", () => {
  if (currentItemType !== "image") {
    return;
  }
  setStatus("");
});

function handleVideoFailure(message) {
  if (!isCurrentVideo()) {
    return;
  }
  revealPreview = true;
  showPreview();
  elements.videoView.classList.add("hidden");
  loadPreviewFrames(true);
  if (deviceInfo.isTouch) {
    requestTranscode();
  } else {
    setStatus(message || "Video playback failed.");
  }
}

function updateSwipeLabels(dx, dy, rect) {
  const xProgress = clamp(Math.abs(dx) / (rect.width * 0.35), 0, 1);
  const yProgress = clamp(Math.abs(dy) / (rect.height * 0.35), 0, 1);

  const keepOpacity = dx > 0 ? xProgress : 0;
  const deleteOpacity = dx < 0 ? xProgress : 0;
  const favoriteOpacity = dy < 0 ? yProgress : 0;

  elements.swipeKeep.style.opacity = keepOpacity.toString();
  elements.swipeDelete.style.opacity = deleteOpacity.toString();
  elements.swipeFavorite.style.opacity = favoriteOpacity.toString();

  const keepScale = 0.92 + keepOpacity * 0.08;
  const deleteScale = 0.92 + deleteOpacity * 0.08;
  const favoriteScale = 0.92 + favoriteOpacity * 0.08;

  elements.swipeKeep.style.transform = `scale(${keepScale})`;
  elements.swipeDelete.style.transform = `scale(${deleteScale})`;
  elements.swipeFavorite.style.transform = `translateX(-50%) scale(${favoriteScale})`;
}

function commitSwipe(action, rect) {
  const distanceX = rect.width * 1.2;
  const distanceY = rect.height * 1.2;
  let targetX = 0;
  let targetY = 0;
  let rotate = 0;

  if (action === "keep") {
    targetX = distanceX;
    rotate = 12;
  } else if (action === "delete") {
    targetX = -distanceX;
    rotate = -12;
  } else if (action === "favorite") {
    targetY = -distanceY;
  }

  elements.mediaCard.classList.remove("dragging");
  elements.mediaCard.style.transform = `translate(${targetX}px, ${targetY}px) rotate(${rotate}deg)`;
  elements.mediaCard.style.opacity = "0";

  window.setTimeout(() => {
    resetSwipeUI();
    sendAction(action);
  }, 180);
}

function onPointerDown(event) {
  if (actionInFlight || swipeState.pointerId !== null) {
    return;
  }
  const item = currentItem();
  if (!item) {
    return;
  }

  const target = event.target;
  if (target && target.closest && target.closest(".nav-arrow")) {
    return;
  }

  if (event.pointerType === "mouse" && event.button !== 0) {
    return;
  }

  if (item.type === "video") {
    const rect = elements.viewer.getBoundingClientRect();
    if (event.clientY > rect.bottom - 90) {
      return;
    }
  }

  swipeState.pointerId = event.pointerId;
  swipeState.startX = event.clientX;
  swipeState.startY = event.clientY;
  swipeState.lastX = event.clientX;
  swipeState.lastY = event.clientY;
  swipeState.dragging = false;
}

function onPointerMove(event) {
  if (swipeState.pointerId !== event.pointerId) {
    return;
  }
  if (actionInFlight) {
    return;
  }

  const dx = event.clientX - swipeState.startX;
  const dy = event.clientY - swipeState.startY;
  swipeState.lastX = event.clientX;
  swipeState.lastY = event.clientY;

  const distance = Math.hypot(dx, dy);
  if (!swipeState.dragging && distance < 12) {
    return;
  }

  if (!swipeState.dragging) {
    swipeState.dragging = true;
    elements.mediaCard.classList.add("dragging");
    if (elements.viewer.setPointerCapture) {
      elements.viewer.setPointerCapture(event.pointerId);
    }
  }

  const rect = elements.viewer.getBoundingClientRect();
  const rotate = clamp((dx / rect.width) * 14, -14, 14);
  elements.mediaCard.style.transform = `translate(${dx}px, ${dy}px) rotate(${rotate}deg)`;
  updateSwipeLabels(dx, dy, rect);
  event.preventDefault();
}

function onPointerEnd(event) {
  if (swipeState.pointerId !== event.pointerId) {
    return;
  }

  const dx = swipeState.lastX - swipeState.startX;
  const dy = swipeState.lastY - swipeState.startY;
  const rect = elements.viewer.getBoundingClientRect();

  const thresholdX = Math.max(90, rect.width * 0.22);
  const thresholdY = Math.max(90, rect.height * 0.22);

  let action = null;
  if (dx > thresholdX) {
    action = "keep";
  } else if (dx < -thresholdX) {
    action = "delete";
  } else if (dy < -thresholdY) {
    action = "favorite";
  }

  if (swipeState.dragging) {
    if (action) {
      commitSwipe(action, rect);
    } else {
      resetSwipeUI();
    }
  }

  swipeState.pointerId = null;
  swipeState.dragging = false;
}

elements.viewer.addEventListener("pointerdown", onPointerDown);
elements.viewer.addEventListener("pointermove", onPointerMove);
elements.viewer.addEventListener("pointerup", onPointerEnd);
elements.viewer.addEventListener("pointercancel", onPointerEnd);

window.addEventListener("keydown", (event) => {
  if (event.defaultPrevented) {
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) {
    return;
  }
  const target = event.target;
  if (target && target.closest) {
    const tag = target.tagName;
    if (
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      target.isContentEditable
    ) {
      return;
    }
  }
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    moveIndex(-1);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    moveIndex(1);
  } else if (event.key === "k" || event.key === "K") {
    event.preventDefault();
    sendAction("keep");
  } else if (event.key === "d" || event.key === "D") {
    event.preventDefault();
    sendAction("delete");
  } else if (event.key === "f" || event.key === "F") {
    event.preventDefault();
    sendAction("favorite");
  }
});

let initialLibraryOpen = false;
try {
  initialLibraryOpen = localStorage.getItem(libraryStorageKey) === "1";
} catch {
  initialLibraryOpen = false;
}
applyLibraryWidth(getStoredLibraryWidth(), false);
setLibraryOpen(initialLibraryOpen);

fetchItems().catch(() => {
  setStatus("Failed to load items");
});
