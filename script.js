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

async function fetchZip() {
  let response;
  try {
    response = await fetch(ZIP_PATH);
  } catch (err) {
    throw new Error("Could not access kb.zip. Make sure it is in the same folder as this page.");
  }
  if (!response.ok) {
    throw new Error("kb.zip was not found next to index.html.");
  }
  return await response.blob();
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

  try {
    const zip = await JSZip.loadAsync(zipBlob);
    const entries = Object.values(zip.files).filter((e) => !e.dir);
    const total = entries.length || 1;
    let completed = 0;

    for (const entry of entries) {
      currentFile.textContent = entry.name;

      const data = await entry.async("blob");
      downloadBlob(data, entry.name);

      completed++;
      setProgress((completed / total) * 100, entry.name);

      // Small delay between downloads so the browser doesn't throttle
      // or block them as a "multiple download" popup flood.
      await sleep(DOWNLOAD_DELAY_MS);
    }

    setProgress(100, "");
    setStatus("Extraction Complete — files saved to your Downloads folder (in a \"kb\" subfolder).", "success");
  } catch (err) {
    console.error(err);
    setStatus("Something went wrong during extraction: " + (err.message || "unknown error"), "error");
  } finally {
    extractBtn.disabled = false;
  }
}

extractBtn.addEventListener("click", extract);
