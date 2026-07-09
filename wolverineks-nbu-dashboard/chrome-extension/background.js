chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "upload-export") {
    void uploadExport(message.filename, message.content)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "nbu-export") {
    void uploadExport(message.filename, message.content)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "report-sync-errors") {
    void reportSyncErrors(message)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
});

async function uploadExport(filename, content) {
  const stored = await chrome.storage.sync.get(["baseUrl", "token"]);
  if (!stored.baseUrl || !stored.token) {
    throw new Error("Configure Umbrel URL and ingest token in the extension popup.");
  }

  const res = await fetch(stored.baseUrl.replace(/\/$/, "") + "/api/ingest", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Ingest-Token": stored.token,
    },
    body: JSON.stringify({ filename, content }),
  });

  const payload = await res.json();
  if (!res.ok) {
    throw new Error(payload.error || "Upload failed");
  }

  const inserted = payload.import?.reading_count ?? payload.imports?.[0]?.reading_count ?? 0;
  return { ...payload, skipped: inserted === 0 };
}

async function reportSyncErrors(message) {
  const stored = await chrome.storage.sync.get(["baseUrl", "token"]);
  if (!stored.baseUrl || !stored.token) {
    throw new Error("Configure Umbrel URL and ingest token in the extension popup.");
  }

  const res = await fetch(stored.baseUrl.replace(/\/$/, "") + "/api/sync-errors", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Ingest-Token": stored.token,
    },
    body: JSON.stringify({
      utility: message.utility,
      object_id: message.object_id,
      errors: message.errors,
    }),
  });

  const payload = await res.json();
  if (!res.ok) {
    throw new Error(payload.error || "Could not report sync errors.");
  }
  return payload;
}