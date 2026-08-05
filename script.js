const extractBtn = document.getElementById("extractBtn");
const progressWrap = document.getElementById("progressWrap");
const progressFill = document.getElementById("progressFill");
const progressLabel = document.getElementById("progressLabel");
const statusMsg = document.getElementById("statusMsg");

const ZIP_PATH = "kb.zip";

// Belt-and-suspenders zoom lock: the viewport meta tag disables pinch-zoom
// on most browsers, but some (notably iOS Safari) still allow gesture-based
// zoom and double-tap zoom unless explicitly blocked in JS as well.
document.addEventListener("gesturestart", (e) => e.preventDefault());
document.addEventListener("gesturechange", (e) => e.preventDefault());
let lastTouchEnd = 0;
document.addEventListener(
  "touchend",
  (e) => {
    const now = Date.now();
    if (now - lastTouchEnd <= 300) {
      e.preventDefault();
    }
    lastTouchEnd = now;
  },
  { passive: false }
);

function setProgress(percent) {
  progressFill.style.width = percent + "%";
  progressLabel.textContent = Math.round(percent) + "%";
}

function setStatus(text, type) {
  statusMsg.textContent = text;
  statusMsg.className = "status-msg" + (type ? " " + type : "");
}

function resetUI() {
  setStatus("", "");
  progressWrap.classList.add("hidden");
  setProgress(0);
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
    throw new Error(ZIP_PATH + " was not found next to index.html (server returned " + response.status + "). Make sure kb.zip was actually uploaded/deployed alongside index.html, style.css, and script.js.");
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
      "This means kb.zip is missing from the deployed folder, or the server returned an " +
      "error page (like a 404) instead of the file. Confirm kb.zip sits next to index.html " +
      "in your deployment and that its filename is exactly \"kb.zip\" (case-sensitive)."
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

// Triggers a single browser download for the final combined output zip.
function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
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
  setStatus("Loading archive...", "");

  let zip;
  try {
    zip = await JSZip.loadAsync(zipBlob);
  } catch (err) {
    console.error("JSZip failed to parse kb.zip:", err);
    setStatus(
      "kb.zip could not be read as a zip archive (" + (err.message || "corrupted data") + "). " +
      "The file is likely incomplete or corrupted — try re-uploading kb.zip and reload the page.",
      "error"
    );
    extractBtn.disabled = false;
    return;
  }

  try {
    const entries = Object.values(zip.files).filter((e) => !e.dir);

    if (entries.length === 0) {
      throw new Error("kb.zip doesn't contain any files.");
    }

    // Repackage into a brand-new zip so the final result is a single file,
    // instead of triggering one download per entry. Everything is held in
    // memory (RAM) throughout — no intermediate disk writes — which is fine
    // for archives well within available system memory.
    const outputZip = new JSZip();
    let filesCopied = 0;

    for (const entry of entries) {
      setStatus("Loading Game....", "");

      const data = await entry.async("uint8array");
      // STORE (no compression) here: the source files are already compressed
      // inside kb.zip, so re-running DEFLATE on already-compressed bytes costs
      // significant CPU time for little to no size reduction. STORE just
      // packages the bytes as-is, which is much faster to generate.
      outputZip.file(entry.name, data, { compression: "STORE" });

      filesCopied++;
      // Reading phase counts for the first half of the progress bar.
      const percent = (filesCopied / entries.length) * 50;
      setProgress(percent);
    }

    setStatus("Building final archive...", "");

    const outputBlob = await outputZip.generateAsync(
      { type: "blob", compression: "STORE" },
      (metadata) => {
        // Generation phase counts for the second half of the progress bar.
        const percent = 50 + (metadata.percent / 100) * 50;
        setProgress(percent);
      }
    );

    setProgress(100);
    setStatus("Starting download...", "");
    downloadBlob(outputBlob, "kb-extracted.zip");
    setStatus("Extraction Complete — \"kb-extracted.zip\" saved to your Downloads folder.", "success");
  } catch (err) {
    console.error(err);
    if (err && /memory|allocat/i.test(err.message || "")) {
      setStatus("Ran out of browser memory. Try closing other tabs and retry.", "error");
    } else {
      setStatus("Something went wrong during extraction: " + (err.message || "unknown error"), "error");
    }
  } finally {
    extractBtn.disabled = false;
  }
}

extractBtn.addEventListener("click", extract);