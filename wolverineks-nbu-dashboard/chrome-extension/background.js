chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "nbu-export") return;
  void uploadExport(message.filename, message.content)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
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
  if (!res.ok) throw new Error(payload.error || "Upload failed");
  return payload;
}

chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state || delta.state.current !== "complete") return;

  const [item] = await chrome.downloads.search({ id: delta.id });
  if (!item?.filename) return;

  const lower = item.filename.toLowerCase();
  if (!lower.endsWith(".xml") && !lower.endsWith(".csv")) return;
  if (!/549\d+-\d+|electric|water|readinghistory|hourly_usage/i.test(item.filename)) return;

  const stored = await chrome.storage.sync.get(["baseUrl", "token", "autoUpload"]);
  if (!stored.autoUpload || !stored.baseUrl || !stored.token) return;

  try {
    const response = await fetch(item.url);
    const content = await response.text();
    const filename = item.filename.split(/[\\/]/).pop();
    await fetch(stored.baseUrl.replace(/\/$/, "") + "/api/ingest", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ingest-Token": stored.token,
      },
      body: JSON.stringify({ filename, content }),
    });
  } catch (_error) {
    // Portal downloads are often blob: URLs the background worker cannot re-fetch.
  }
});