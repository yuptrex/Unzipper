const extractBtn = document.getElementById("extractBtn");
const progressWrap = document.getElementById("progressWrap");
const progressFill = document.getElementById("progressFill");
const progressLabel = document.getElementById("progressLabel");
const currentFile = document.getElementById("currentFile");
const statusMsg = document.getElementById("statusMsg");

const ZIP_PATH = "kb.zip";

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

async function writeFileToDir(dirHandle, path, data) {
  const parts = path.split("/").filter(Boolean);
  const fileName = parts.pop();
  let currentDir = dirHandle;

  for (const part of parts) {
    currentDir = await currentDir.getDirectoryHandle(part, { create: true });
  }

  const fileHandle = await currentDir.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(data);
  await writable.close();
}

async function extract() {
  resetUI();

  if (!window.showDirectoryPicker) {
    setStatus("Your browser doesn't support folder access (File System Access API). Try Chrome or Edge.", "error");
    return;
  }

  if (window.location.protocol === "file:") {
    setStatus(
      "This page is open directly from disk (file://). The folder picker needs a local server — see instructions below the button.",
      "error"
    );
    return;
  }

  extractBtn.disabled = true;

  let dirHandle;
  try {
    dirHandle = await window.showDirectoryPicker();
  } catch (err) {
    console.error("showDirectoryPicker failed:", err.name, err.message);
    if (err.name === "AbortError") {
      setStatus("Folder selection was cancelled.", "error");
    } else if (err.name === "SecurityError") {
      setStatus("Folder access was blocked by the browser (SecurityError). This usually happens on file:// pages or inside embedded webviews — try opening this page via a local server in a normal browser tab.", "error");
    } else if (err.name === "NotAllowedError") {
      setStatus("Permission to access the folder was denied.", "error");
    } else {
      setStatus("Could not open the folder picker (" + err.name + "). Try a different browser tab, not an embedded webview.", "error");
    }
    extractBtn.disabled = false;
    return;
  }

  if (!dirHandle) {
    setStatus("No folder was selected.", "error");
    extractBtn.disabled = false;
    return;
  }

  // Verify/request readwrite permission
  try {
    const perm = await dirHandle.requestPermission({ mode: "readwrite" });
    if (perm !== "granted") {
      throw new Error("permission-denied");
    }
  } catch (err) {
    setStatus("Write permission to the selected folder was denied.", "error");
    extractBtn.disabled = false;
    return;
  }

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
    const entries = Object.values(zip.files);
    const total = entries.length || 1;
    let completed = 0;

    for (const entry of entries) {
      currentFile.textContent = entry.name;

      if (entry.dir) {
        await entry.async("string").catch(() => {});
      } else {
        const data = await entry.async("blob");
        await writeFileToDir(dirHandle, entry.name, data);
      }

      completed++;
      setProgress((completed / total) * 100, entry.name);
    }

    setProgress(100, "");
    setStatus("Extraction Complete", "success");
  } catch (err) {
    console.error(err);
    setStatus("Something went wrong during extraction: " + (err.message || "unknown error"), "error");
  } finally {
    extractBtn.disabled = false;
  }
}

extractBtn.addEventListener("click", extract);
