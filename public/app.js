const state = {
  items: [],
  index: 0,
  counts: { total: 0, reviewed: 0, remaining: 0 },
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
  fileExt: document.getElementById("fileExt"),
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

function setStatus(message) {
  elements.status.textContent = message || "";
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function currentItem() {
  if (state.items.length === 0) {
    return null;
  }
  return state.items[state.index] || null;
}

function updateProgress() {
  const { total, reviewed, remaining } = state.counts;
  elements.progressText.textContent = `${reviewed} / ${total} reviewed | ${remaining} left`;
  if (!total) {
    elements.progressText.textContent = "0 reviewed | 0 left";
  }
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
  elements.fileName.textContent = "";
  elements.fileExt.textContent = "";
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
  elements.fileName.textContent = cleanedPath;
  const extMatch = cleanedPath.match(/\.[^./\\]+$/);
  const extText = extMatch ? extMatch[0].toUpperCase() : "FILE";
  let badge = "📄";
  if (item.type === "video") {
    badge = "🎥";
  } else if (item.type === "image") {
    badge = "🖼️";
  }
  elements.fileExt.textContent = badge;
  elements.fileExt.title = extText;

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
  const next = state.items[state.index + 1];
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
  const item = currentItem();
  if (!item) {
    showEmpty();
    return;
  }
  resetSwipeUI();
  showMedia(item);
}

async function fetchItems(selectPath) {
  setStatus("Scanning...");
  const response = await fetch("/api/items");
  const data = await response.json();
  state.items = data.items || [];
  state.counts = data.counts || { total: 0, reviewed: 0, remaining: 0 };
  state.index = 0;

  if (selectPath) {
    const idx = state.items.findIndex((item) => item.path === selectPath);
    if (idx >= 0) {
      state.index = idx;
    }
  }
  setStatus("");
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

    state.items.splice(state.index, 1);
    state.counts.reviewed += 1;
    state.counts.remaining = state.items.length;
    state.counts.total = state.counts.reviewed + state.counts.remaining;
    if (state.index >= state.items.length) {
      state.index = 0;
    }
    setStatus("");
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
  const movedCount = data.moved ? data.moved.length : 0;
  setStatus(`Moved ${movedCount} item(s) to Trash`);
  await fetchItems();
}

elements.keepBtn.addEventListener("click", () => sendAction("keep"));
elements.deleteBtn.addEventListener("click", () => sendAction("delete"));
elements.favoriteBtn.addEventListener("click", () => sendAction("favorite"));
elements.undoBtn.addEventListener("click", undoLast);
elements.applyBtn.addEventListener("click", applyDeletes);
elements.refreshBtn.addEventListener("click", () => fetchItems());

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

fetchItems().catch(() => {
  setStatus("Failed to load items");
});
