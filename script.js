const fileInput = document.getElementById("fileInput");
const fileLabel = document.getElementById("fileLabel");
const extractBtn = document.getElementById("extractBtn");
const progressWrap = document.getElementById("progressWrap");
const progressFill = document.getElementById("progressFill");
const progressLabel = document.getElementById("progressLabel");
const currentFile = document.getElementById("currentFile");
const statusMsg = document.getElementById("statusMsg");

const DOWNLOAD_DELAY_MS = 180; // small gap so the browser doesn't block rapid multi-downloads

let selectedFile = null;

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

// Folder name used to group downloaded files, derived from the chosen zip's
// filename (e.g. "1.zip" -> "1", "kb.zip" -> "kb").
function baseFolderName(fileName) {
  const withoutExt = fileName.replace(/\.zip$/i, "");
  return withoutExt.replace(/[^a-zA-Z0-9_\-]+/g, "_") || "extracted";
}

fileInput.addEventListener("change", () => {
  resetUI();
  const file = fileInput.files && fileInput.files[0];
  if (!file) {
    selectedFile = null;
    fileLabel.textContent = "Choose a .zip file...";
    fileLabel.classList.remove("has-file");
    extractBtn.disabled = true;
    return;
  }

  selectedFile = file;
  fileLabel.textContent = file.name + " (" + formatBytes(file.size) + ")";
  fileLabel.classList.add("has-file");
  extractBtn.disabled = false;
});

// Validates the chosen File object before handing it to JSZip: checks it's
// non-empty and actually starts with a valid zip signature. Catches cases
// like accidentally selecting a renamed non-zip file or a corrupted upload.
async function validateZipFile(file) {
  if (!file || file.size === 0) {
    throw new Error("The selected file is empty (0 bytes). Choose a different file.");
  }

  const headerBytes = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const isZipSignature =
    headerBytes[0] === 0x50 && headerBytes[1] === 0x4b && // "PK"
    (headerBytes[2] === 0x03 || headerBytes[2] === 0x05 || headerBytes[2] === 0x07);

  if (!isZipSignature) {
    throw new Error(
      "\"" + file.name + "\" doesn't look like a valid zip file (wrong file signature). " +
      "Make sure you selected an actual .zip archive and that it isn't corrupted or truncated."
    );
  }

  return file;
}

// Triggers a browser download for a single extracted file, grouped into a
// subfolder named after the source zip (Chromium browsers honor folder
// structure embedded in the download filename).
function downloadBlob(blob, path, folderName) {
  const safePath = folderName + "/" + path.split("/").filter(Boolean).join("/");
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = safePath;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function extract() {
  resetUI();

  if (!selectedFile) {
    setStatus("Choose a .zip file first.", "error");
    return;
  }

  extractBtn.disabled = true;
  fileInput.disabled = true;

  let validFile;
  try {
    setStatus("Reading " + selectedFile.name + "...", "");
    validFile = await validateZipFile(selectedFile);
  } catch (err) {
    setStatus(err.message, "error");
    extractBtn.disabled = false;
    fileInput.disabled = false;
    return;
  }

  progressWrap.classList.remove("hidden");
  setStatus("Extracting...", "");

  let zip;
  try {
    zip = await JSZip.loadAsync(validFile);
  } catch (err) {
    console.error("JSZip failed to parse " + validFile.name + ":", err);
    setStatus(
      "\"" + validFile.name + "\" could not be read as a zip archive (" + (err.message || "corrupted data") + "). " +
      "The file is likely incomplete or corrupted — try re-selecting or re-downloading it.",
      "error"
    );
    extractBtn.disabled = false;
    fileInput.disabled = false;
    return;
  }

  try {
    const entries = Object.values(zip.files).filter((e) => !e.dir);

    if (entries.length === 0) {
      throw new Error("This zip file doesn't contain any files.");
    }

    const folderName = baseFolderName(validFile.name);

    // Track progress by uncompressed bytes, not file count — a handful of
    // large files can dwarf many small ones, so byte-based progress is a
    // much more accurate percentage no matter how the archive is structured.
    const totalBytes = entries.reduce((sum, e) => sum + (e._data ? e._data.uncompressedSize : 0), 0) || 1;
    let processedBytes = 0;

    // A single file's uncompressed bytes must fit in memory at once — browsers
    // have no API to stream a decompressing file straight to disk. This is a
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
      downloadBlob(data, entry.name, folderName);

      processedBytes += entrySize;
      const percent = Math.min(100, (processedBytes / totalBytes) * 100);
      setProgress(percent, entry.name + " (" + formatBytes(entrySize) + ")");

      // Small delay between downloads so the browser doesn't throttle
      // or block them as a "multiple download" popup flood.
      await sleep(DOWNLOAD_DELAY_MS);
    }

    setProgress(100, "");
    setStatus("Extraction Complete — files saved to your Downloads folder (in a \"" + folderName + "\" subfolder).", "success");
  } catch (err) {
    console.error(err);
    if (err && /memory|allocat/i.test(err.message || "")) {
      setStatus("Ran out of memory extracting a large file. Try closing other tabs, use a 64-bit browser, and retry.", "error");
    } else {
      setStatus("Something went wrong during extraction: " + (err.message || "unknown error"), "error");
    }
  } finally {
    extractBtn.disabled = false;
    fileInput.disabled = false;
  }
}

extractBtn.addEventListener("click", extract);
