chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "upload-export") {
    void uploadExport(message.filename, message.content, message.address ?? null)
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

  if (message?.type === "verify-ingest-token") {
    void verifyIngestToken()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
});

async function umbrelSettings() {
  const stored = await chrome.storage.sync.get(["baseUrl", "token"]);
  const baseUrl = stored.baseUrl?.trim().replace(/\/$/, "") ?? "";
  const token = stored.token?.trim() ?? "";
  if (!baseUrl || !token) {
    throw new Error("Configure Umbrel URL and ingest token in the extension popup.");
  }
  return { baseUrl, token };
}

async function umbrelFetch(path, init = {}) {
  const { baseUrl, token } = await umbrelSettings();
  const requestUrl = `${baseUrl}${path}`;
  const response = await fetch(requestUrl, {
    ...init,
    headers: {
      ...(init.headers || {}),
      "X-Ingest-Token": token,
    },
  });

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location") || "";
    throw new Error(
      `Umbrel redirected (${response.status})${location ? ` to ${location}` : ""}. ` +
        "Use the exact dashboard URL copied from your browser address bar.",
    );
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message = payload?.error || `Umbrel request failed (${response.status}).`;
    const error = new Error(message);
    error.status = response.status;
    if (response.status === 401) {
      error.code = "INGEST_AUTH";
    }
    throw error;
  }

  return payload;
}

function isIngestAuthError(error) {
  return (
    error?.code === "INGEST_AUTH" ||
    /invalid ingest token/i.test(error?.message || "")
  );
}

async function verifyIngestToken() {
  await umbrelFetch("/api/ingest/ping", { method: "GET", cache: "no-store" });
}

async function uploadExport(filename, content, address = null) {
  try {
    return await uploadExportPayload(filename, content, address);
  } catch (error) {
    if (isIngestAuthError(error)) {
      throw new Error("invalid ingest token. Copy the current token from the Umbrel dashboard Setup page.");
    }
    throw error;
  }
}

async function uploadExportPayload(filename, content, address = null) {
  const payload = await umbrelFetch("/api/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename,
      content,
      address: address || null,
    }),
  });

  const inserted = payload.import?.reading_count ?? payload.imports?.[0]?.reading_count ?? 0;
  return { ...payload, skipped: inserted === 0 };
}

async function reportSyncErrors(message) {
  return umbrelFetch("/api/sync-errors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      utility: message.utility,
      object_id: message.object_id,
      errors: message.errors,
    }),
  });
}