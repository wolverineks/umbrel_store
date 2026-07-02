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
    return /\/CC\//i.test(window.location.href) &&
      (/Reports\.xml/i.test(window.location.href) ||
        /MeterReadingHistory\.xml/i.test(window.location.href));
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
        <button class="nbu-primary" id="nbu-sync-all" type="button">Sync everything on this page</button>
        <button class="nbu-secondary" id="nbu-sync-plan" type="button">Preview sync plan</button>
        <div class="nbu-mini">Full sync can take a while on Consumption Report pages.</div>
      </div>
    `;
    document.documentElement.appendChild(panel);

    const pageKind = /MeterReadingHistory\.xml/i.test(window.location.href)
      ? "History"
      : "Consumption";
    panel.querySelector("#nbu-page-kind").textContent = pageKind;

    panel.querySelector("#nbu-sync-all").addEventListener("click", () => {
      setStatus("Starting full sync…");
      setProgress(0);
      window.postMessage({ source: "nbu-umbrel-content", type: "START_SYNC" }, "*");
    });

    panel.querySelector("#nbu-sync-plan").addEventListener("click", () => {
      window.postMessage({ source: "nbu-umbrel-content", type: "PLAN_SYNC" }, "*");
    });

    return panel;
  }

  function setStatus(text, kind = "") {
    const el = document.getElementById("nbu-sync-status");
    if (!el) return;
    el.textContent = text;
    el.className = "nbu-status" + (kind ? ` ${kind}` : "");
  }

  function setProgress(ratio) {
    const bar = document.getElementById("nbu-progress-bar");
    if (!bar) return;
    bar.style.width = `${Math.max(0, Math.min(100, ratio * 100))}%`;
  }

  function postToPage(message) {
    window.postMessage({ source: "nbu-umbrel-content", ...message }, "*");
  }

  async function uploadToUmbrel(filename, content) {
    const response = await chrome.runtime.sendMessage({
      type: "upload-export",
      filename,
      content,
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Upload failed");
    }
    return response.result;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "nbu-umbrel-page") return;

    if (event.data.type === "UPLOAD_REQUEST") {
      void uploadToUmbrel(event.data.filename, event.data.content)
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
      setStatus(`Syncing ${event.data.total} exports…`);
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
      setStatus(
        event.data.total
          ? `Plan: ${event.data.total} exports. Examples:\n${preview}`
          : "No exports found on this page.",
      );
      return;
    }

    if (event.data.type === "SYNC_DONE") {
      setProgress(1);
      const msg = `Done. Uploaded ${event.data.uploaded}, skipped ${event.data.skipped}, failed ${event.data.failed}.`;
      setStatus(msg, event.data.failed ? "err" : "ok");
      return;
    }

    if (event.data.type === "SYNC_ERROR") {
      setStatus(event.data.error || "Sync failed.", "err");
    }
  });

  function boot() {
    injectPageBridge();
    ensurePanel();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  const observer = new MutationObserver(() => ensurePanel());
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();