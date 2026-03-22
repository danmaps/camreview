const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const assert = require("node:assert/strict");

async function main() {
  const path = require("path");
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "camreview-capture-"));
  const samplePath = path.join(tempRoot, "copied-image.jpg");

  try {
    await fsp.writeFile(samplePath, "fake-image-data", "utf8");

    const originalCaptureTime = new Date("2026-01-21T11:37:12Z");
    await fsp.utimes(samplePath, originalCaptureTime, originalCaptureTime);

    delete require.cache[require.resolve("../server")];
    const { getCapturedAtMs } = require("../server");
    const stat = await fsp.stat(samplePath);
    assert.equal(
      new Date(getCapturedAtMs(stat)).toISOString(),
      originalCaptureTime.toISOString(),
      "capturedAtMs should stay anchored to the original file time, not the copy/import time"
    );

    console.log("ok - copied media keeps original capture time in library payload");
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("not ok - copied media keeps original capture time in library payload");
  console.error(err);
  process.exit(1);
});
