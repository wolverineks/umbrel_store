(function () {
  const PANEL_ID = "nbu-umbrel-sync-panel";

  function injectPageBridge() {
    if (document.documentElement.dataset.nbuUmbrelBridge) return;
    document.documentElement.dataset.nbuUmbrelBridge = "1";
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("page-bridge.js");
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  }

  function ensureStyles() {
    if (document.getElementById("nbu-umbrel-sync-style")) return;
    const style = document.createElement("style");
    style.id = "nbu-umbrel-sync-style";
    style.textContent = `
      #${PANEL_ID} {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 2147483646;
        width: 280px;
        background: #ffffff;
        border: 1px solid #cbd5e1;
        border-radius: 14px;
        box-shadow: 0 16px 40px rgba(15, 23, 42, 0.18);
        font: 13px/1.4 system-ui, sans-serif;
        color: #0f172a;
      }
      #${PANEL_ID} .nbu-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 12px 14px 8px;
        font-weight: 700;
      }
      #${PANEL_ID} .nbu-version {
        font-size: 11px;
        font-weight: 600;
        color: #64748b;
      }
      #${PANEL_ID} .nbu-body {
        padding: 0 14px 12px;
      }
      #${PANEL_ID} .nbu-status {
        min-height: 2.8em;
        color: #64748b;
        margin-bottom: 10px;
      }
      #${PANEL_ID} .nbu-status.ok { color: #16a34a; }
      #${PANEL_ID} .nbu-status.err { color: #dc2626; }
      #${PANEL_ID} button {
        width: 100%;
        border: 0;
        border-radius: 10px;
        padding: 10px 12px;
        font: inherit;
        cursor: pointer;
        margin-bottom: 8px;
      }
      #${PANEL_ID} .nbu-primary {
        background: #1d4ed8;
        color: #fff;
      }
      #${PANEL_ID} .nbu-secondary {
        background: #f8fafc;
        color: #0f172a;
        border: 1px solid #cbd5e1;
      }
      #${PANEL_ID} .nbu-progress {
        height: 6px;
        background: #e2e8f0;
        border-radius: 999px;
        overflow: hidden;
        margin-bottom: 10px;
      }
      #${PANEL_ID} .nbu-progress > span {
        display: block;
        height: 100%;
        width: 0;
        background: #1d4ed8;
        transition: width 0.2s ease;
      }
      #${PANEL_ID} .nbu-mini {
        font-size: 11px;
        color: #64748b;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function isRelevantPage() {
    return /\/CC\//i.test(window.location.href) && /Reports\.xml/i.test(window.location.href);
  }

  function ensurePanel() {
    if (!isRelevantPage()) return null;
    ensureStyles();
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;

    const version = chrome.runtime.getManifest().version;
    panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="nbu-head">
        <span>NBU → Umbrel</span>
        <span>
          <span class="nbu-mini" id="nbu-page-kind"></span>
          <span class="nbu-version">v${version}</span>
        </span>
      </div>
      <div class="nbu-body">
        <div class="nbu-progress"><span id="nbu-progress-bar"></span></div>
        <div class="nbu-status" id="nbu-sync-status">Ready to sync this page to Umbrel.</div>
        <button class="nbu-primary" id="nbu-sync-view" type="button">Sync current view</button>
        <button class="nbu-secondary" id="nbu-sync-recent" type="button">Sync last 30 days</button>
        <button class="nbu-secondary" id="nbu-sync-all" type="button">Sync full history</button>
        <button class="nbu-secondary" id="nbu-sync-plan" type="button">Preview sync plan</button>
        <button class="nbu-secondary" id="nbu-copy-object-id" type="button">Copy Object ID</button>
        <div class="nbu-mini">Consumption sync fetches hourly CSV per day. Sync current view uses the date range shown on this page.</div>
        <div class="nbu-mini">Copy Object ID and paste it into the Umbrel dashboard for verify snippets.</div>
      </div>
    `;
    document.documentElement.appendChild(panel);

    panel.querySelector("#nbu-page-kind").textContent = "Consumption";

    panel.querySelector("#nbu-sync-view").addEventListener("click", () => {
      setProgress(0);
      setStatus("Syncing current portal view…");
      window.postMessage(
        {
          source: "nbu-umbrel-content",
          type: "START_SYNC",
          options: { detectPortalView: true },
        },
        "*",
      );
    });

    panel.querySelector("#nbu-sync-recent").addEventListener("click", () => {
      setStatus("Starting recent sync…");
      setProgress(0);
      window.postMessage(
        { source: "nbu-umbrel-content", type: "START_SYNC", options: { recentDays: 30 } },
        "*",
      );
    });

    panel.querySelector("#nbu-sync-all").addEventListener("click", () => {
      setStatus("Starting full history sync…");
      setProgress(0);
      window.postMessage({ source: "nbu-umbrel-content", type: "START_SYNC", options: {} }, "*");
    });

    panel.querySelector("#nbu-sync-plan").addEventListener("click", () => {
      window.postMessage(
        { source: "nbu-umbrel-content", type: "PLAN_SYNC", options: { recentDays: 30 } },
        "*",
      );
    });

    panel.querySelector("#nbu-copy-object-id").addEventListener("click", () => {
      window.postMessage({ source: "nbu-umbrel-content", type: "GET_OBJECT_ID" }, "*");
    });

    return panel;
  }

  function setStatus(text, kind = "") {
    const el = document.getElementById("nbu-sync-status");
    if (!el) return;
    el.textContent = text;
    el.className = "nbu-status" + (kind ? ` ${kind}` : "");
  }

  async function copyText(text) {
    if (!text) throw new Error("nothing to copy");
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {
        // Fall back below.
      }
    }
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.left = "-9999px";
    area.style.top = "0";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.focus();
    area.select();
    area.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    if (!ok) throw new Error("copy failed");
  }

  function setProgress(ratio) {
    const bar = document.getElementById("nbu-progress-bar");
    if (!bar) return;
    bar.style.width = `${Math.max(0, Math.min(100, ratio * 100))}%`;
  }

  function postToPage(message) {
    window.postMessage({ source: "nbu-umbrel-content", ...message }, "*");
  }

  async function uploadToUmbrel(filename, content, address = null) {
    const response = await chrome.runtime.sendMessage({
      type: "upload-export",
      filename,
      content,
      address,
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Upload failed");
    }
    return response.result;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "nbu-umbrel-page") return;

    if (event.data.type === "VERIFY_INGEST_REQUEST") {
      void chrome.runtime
        .sendMessage({ type: "verify-ingest-token" })
        .then((response) => {
          postToPage({
            type: "VERIFY_INGEST_RESULT",
            requestId: event.data.requestId,
            ok: Boolean(response?.ok),
            error: response?.error || null,
          });
        })
        .catch((error) => {
          postToPage({
            type: "VERIFY_INGEST_RESULT",
            requestId: event.data.requestId,
            ok: false,
            error: error.message || String(error),
          });
        });
      return;
    }

    if (event.data.type === "UPLOAD_REQUEST") {
      void uploadToUmbrel(event.data.filename, event.data.content, event.data.address ?? null)
        .then((result) => {
          postToPage({
            type: "UPLOAD_RESULT",
            requestId: event.data.requestId,
            ok: true,
            result,
          });
        })
        .catch((error) => {
          postToPage({
            type: "UPLOAD_RESULT",
            requestId: event.data.requestId,
            ok: false,
            error: error.message || String(error),
          });
        });
      return;
    }

    if (event.data.type === "SYNC_START") {
      const viewHint =
        event.data.viewStart && event.data.viewEnd
          ? ` (${event.data.viewStart}${event.data.viewEnd !== event.data.viewStart ? `–${event.data.viewEnd}` : ""})`
          : "";
      setStatus(`Syncing ${event.data.total} export${event.data.total === 1 ? "" : "s"}${viewHint}…`);
      setProgress(0);
      return;
    }

    if (event.data.type === "SYNC_PROGRESS") {
      setStatus(`${event.data.index}/${event.data.total}: ${event.data.label}`);
      setProgress(event.data.index / event.data.total);
      return;
    }

    if (event.data.type === "SYNC_PLAN") {
      const preview = (event.data.jobs || []).join("\n");
      const mode = event.data.mode ? `${event.data.mode} · ` : "";
      setStatus(
        event.data.total
          ? `Plan: ${mode}${event.data.total} exports. Examples:\n${preview}`
          : "No exports found on this page.",
      );
      return;
    }

    if (event.data.type === "SYNC_DONE") {
      setProgress(1);
      const msg = `Done. Uploaded ${event.data.uploaded}, skipped ${event.data.skipped}, failed ${event.data.failed}.`;
      setStatus(msg, event.data.failed ? "err" : "ok");
      refreshPendingViewLabel();
      if (event.data.errorDetails?.length) {
        void chrome.runtime.sendMessage({
          type: "report-sync-errors",
          utility: event.data.utility,
          object_id: event.data.objectId,
          errors: event.data.errorDetails,
        });
      }
      return;
    }

    if (event.data.type === "SYNC_ERROR") {
      setStatus(event.data.error || "Sync failed.", "err");
    }

    if (event.data.type === "OBJECT_ID") {
      const objectId = event.data.objectId;
      if (!objectId) {
        setStatus("No meter found on this page.", "err");
        return;
      }
      const label = event.data.meterLabel ? ` (${event.data.meterLabel})` : "";
      void copyText(objectId)
        .then(() => {
          setStatus(`Copied Object ID${label}. Paste into Umbrel dashboard → Save Object ID.`, "ok");
        })
        .catch(() => setStatus("Copy failed.", "err"));
    }
  });

  function boot() {
    injectPageBridge();
    ensurePanel();
    refreshPendingViewLabel();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  const observer = new MutationObserver(() => ensurePanel());
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();