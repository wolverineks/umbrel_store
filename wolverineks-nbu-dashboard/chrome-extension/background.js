const DASHBOARD_BRIDGE_ID = "nbu-umbrel-dashboard-bridge";

async function registerDashboardBridge(baseUrl) {
  const trimmed = (baseUrl || "").trim().replace(/\/$/, "");
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [DASHBOARD_BRIDGE_ID] });
  } catch {
    // Script may not exist yet.
  }
  if (!trimmed) return;
  let origin;
  try {
    origin = new URL(trimmed).origin;
  } catch {
    return;
  }
  await chrome.scripting.registerContentScripts([
    {
      id: DASHBOARD_BRIDGE_ID,
      js: ["dashboard-bridge.js"],
      matches: [`${origin}/*`],
      runAt: "document_idle",
    },
  ]);
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.sync.get(["baseUrl"]).then(({ baseUrl }) => registerDashboardBridge(baseUrl));
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "set-sync-view") {
    void chrome.storage.local
      .set({
        pendingSyncView: {
          ...message.view,
          queuedAt: new Date().toISOString(),
        },
      })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "register-dashboard-bridge") {
    void registerDashboardBridge(message.baseUrl)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
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

  if (message?.type === "get-sync-view-queue") {
    void getSyncViewQueueFromUmbrel()
      .then((queue) => sendResponse({ ok: true, queue }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error), queue: null }));
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
    throw new Error(payload?.error || `Umbrel request failed (${response.status}).`);
  }

  return payload;
}

async function getSyncViewQueueFromUmbrel() {
  const payload = await umbrelFetch("/api/sync-view/queue", { cache: "no-store" });
  return payload?.queue ?? null;
}

async function uploadExport(filename, content) {
  const payload = await umbrelFetch("/api/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename, content }),
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