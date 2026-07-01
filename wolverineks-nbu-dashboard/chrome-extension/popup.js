const baseUrlInput = document.getElementById("baseUrl");
const tokenInput = document.getElementById("token");
const statusEl = document.getElementById("status");
const filesInput = document.getElementById("files");

function setStatus(message, kind = "") {
  statusEl.textContent = message;
  statusEl.className = "status " + kind;
}

async function loadSettings() {
  const stored = await chrome.storage.sync.get(["baseUrl", "token"]);
  baseUrlInput.value = stored.baseUrl ?? "";
  tokenInput.value = stored.token ?? "";
}

document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.sync.set({
    baseUrl: baseUrlInput.value.trim().replace(/\/$/, ""),
    token: tokenInput.value.trim(),
  });
  setStatus("Saved.", "ok");
});

document.getElementById("upload").addEventListener("click", async () => {
  const baseUrl = baseUrlInput.value.trim().replace(/\/$/, "");
  const token = tokenInput.value.trim();
  const files = filesInput.files;
  if (!baseUrl || !token) {
    setStatus("Set URL and token first.", "err");
    return;
  }
  if (!files?.length) {
    setStatus("Choose one or more NBU export files.", "err");
    return;
  }

  setStatus("Uploading...");
  try {
    const form = new FormData();
    for (const file of files) {
      form.append("files", file, file.name);
    }
    const res = await fetch(baseUrl + "/api/ingest", {
      method: "POST",
      headers: { "X-Ingest-Token": token },
      body: form,
    });
    const payload = await res.json();
    if (!res.ok) {
      throw new Error(payload.error || "Upload failed");
    }
    const count = payload.imports?.length ?? 1;
    setStatus("Imported " + count + " file(s).", "ok");
  } catch (error) {
    setStatus(error.message || String(error), "err");
  }
});

loadSettings();