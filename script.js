const extractBtn = document.getElementById("extractBtn");
const progressWrap = document.getElementById("progressWrap");
const progressFill = document.getElementById("progressFill");
const progressLabel = document.getElementById("progressLabel");
const currentFile = document.getElementById("currentFile");
const statusMsg = document.getElementById("statusMsg");

const ZIP_PATH = "kb.zip";
const DOWNLOAD_DELAY_MS = 180; // small gap so the browser doesn't block rapid multi-downloads

function setProgress(percent, fileName) {
  progressFill.style.width = percent + "%";
  progressLabel.textContent = Math.round(percent) + "%";
  if (fileName !== undefined) currentFile.textContent = fileName;
}

function setStatus(text, type) {
  statusMsg.textContent = text;
  statusMsg.className = "status-msg" + (type ? " " + type : "");
}

function resetUI() {
  setStatus("", "");
  progressWrap.classList.add("hidden");
  setProgress(0, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

async function fetchZip() {
  let response;
  try {
    response = await fetch(ZIP_PATH, { cache: "no-store" });
  } catch (err) {
    throw new Error("Could not access " + ZIP_PATH + ". Make sure it is in the same folder as this page.");
  }
  if (!response.ok) {
    throw new Error(ZIP_PATH + " was not found next to index.html (server returned " + response.status + ").");
  }

  const blob = await response.blob();

  // Sanity-check what we actually got before handing it to JSZip.
  // A misconfigured server/route can return an HTML error page with a
  // 200 status, or a proxy/dev-server can truncate a large binary response —
  // both produce exactly this "corrupted zip" symptom downstream.
  if (blob.size === 0) {
    throw new Error(ZIP_PATH + " downloaded as an empty file (0 bytes). Re-check the file on the server.");
  }

  const headerBytes = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  const isZipSignature =
    headerBytes[0] === 0x50 && headerBytes[1] === 0x4b && // "PK"
    (headerBytes[2] === 0x03 || headerBytes[2] === 0x05 || headerBytes[2] === 0x07);

  if (!isZipSignature) {
    throw new Error(
      "The file received at " + ZIP_PATH + " isn't a valid zip (wrong signature). " +
      "This usually means the server sent an HTML page (e.g. a 404) instead of the actual file, " +
      "or the download was cut short. Try re-downloading it and confirm its file size matches the original."
    );
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) !== blob.size) {
    throw new Error(
      ZIP_PATH + " appears to have been truncated in transit (expected " + contentLength +
      " bytes, got " + blob.size + "). Try again, possibly over a more stable connection or local server."
    );
  }

  return blob;
}

// Triggers a browser download for a single file. Uses the "kb/" prefix so
// Chrome/Edge group extracted files into a "kb" subfolder inside Downloads
// (folder structure in the download name is honored by Chromium browsers).
function downloadBlob(blob, path) {
  const safePath = "kb/" + path.split("/").filter(Boolean).join("/");
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = safePath;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke slightly later so the browser has time to start the download
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function extract() {
  resetUI();
  extractBtn.disabled = true;

  let zipBlob;
  try {
    setStatus("Reading kb.zip...", "");
    zipBlob = await fetchZip();
  } catch (err) {
    setStatus(err.message, "error");
    extractBtn.disabled = false;
    return;
  }

  progressWrap.classList.remove("hidden");
  setStatus("Extracting...", "");

  let zip;
  try {
    zip = await JSZip.loadAsync(zipBlob);
  } catch (err) {
    console.error("JSZip failed to parse " + ZIP_PATH + ":", err);
    setStatus(
      ZIP_PATH + " could not be read as a zip archive (" + (err.message || "corrupted data") + "). " +
      "The file is likely incomplete or corrupted — try re-saving/re-uploading it and reload the page.",
      "error"
    );
    extractBtn.disabled = false;
    return;
  }

  try {
    const entries = Object.values(zip.files).filter((e) => !e.dir);

    // Track progress by uncompressed bytes, not file count — a handful of
    // large files can dwarf many small ones, so byte-based progress is a
    // much more accurate percentage no matter how the archive is structured.
    const totalBytes = entries.reduce((sum, e) => sum + (e._data ? e._data.uncompressedSize : 0), 0) || 1;
    let processedBytes = 0;

    // A single file's uncompressed bytes must fit in memory at once — browsers
    // have no API to stream a decompressed file straight to disk. This is a
    // platform limit, not something this script can work around. Warn early
    // rather than let the tab silently hang or crash on a huge single file.
    const LARGE_FILE_WARN_BYTES = 1.5 * 1024 * 1024 * 1024; // 1.5 GB
    const largestEntry = entries.reduce(
      (max, e) => ((e._data ? e._data.uncompressedSize : 0) > max ? (e._data ? e._data.uncompressedSize : 0) : max),
      0
    );
    if (largestEntry > LARGE_FILE_WARN_BYTES) {
      setStatus(
        "Warning: this archive contains a single file around " + formatBytes(largestEntry) +
        " uncompressed. Very large individual files may run out of browser memory. Continuing...",
        ""
      );
      await sleep(1200);
    }

    // Process one file at a time: decompress -> download -> release the blob
    // before moving on. This keeps peak memory to roughly the size of the
    // single largest file, rather than the whole archive, no matter how many
    // total gigabytes the archive unpacks to.
    for (const entry of entries) {
      currentFile.textContent = entry.name;
      setStatus("Extracting...", "");

      const entrySize = entry._data ? entry._data.uncompressedSize : 0;
      const data = await entry.async("blob");
      downloadBlob(data, entry.name);

      processedBytes += entrySize;
      const percent = Math.min(100, (processedBytes / totalBytes) * 100);
      setProgress(percent, entry.name + " (" + formatBytes(entrySize) + ")");

      // Small delay between downloads so the browser doesn't throttle
      // or block them as a "multiple download" popup flood.
      await sleep(DOWNLOAD_DELAY_MS);
    }

    setProgress(100, "");
    setStatus("Extraction Complete — files saved to your Downloads folder (in a \"kb\" subfolder).", "success");
  } catch (err) {
    console.error(err);
    if (err && /memory|allocat/i.test(err.message || "")) {
      setStatus("Ran out of memory extracting a large file. Try closing other tabs, use a 64-bit browser, and retry.", "error");
    } else {
      setStatus("Something went wrong during extraction: " + (err.message || "unknown error"), "error");
    }
  } finally {
    extractBtn.disabled = false;
  }
}

extractBtn.addEventListener("click", extract);
