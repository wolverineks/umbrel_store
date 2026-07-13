importScripts("settings.js");

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "verify-ingest-token") {
    void verifyIngestToken()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
});

async function umbrelFetch(path, init = {}) {
  const { baseUrl, token } = await getActiveUmbrelSettings();
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      "X-Ingest-Token": token,
    },
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new Error(payload?.error || `Request failed (${response.status}).`);
  }
  return payload;
}

async function verifyIngestToken() {
  await umbrelFetch("/api/ingest/ping", { method: "GET", cache: "no-store" });
}