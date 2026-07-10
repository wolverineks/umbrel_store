(function () {
  if (window.__nbuUmbrelDashboardBridge) return;
  window.__nbuUmbrelDashboardBridge = true;

  const CENTRAL_TZ = "America/Chicago";

  function centralTodayKey() {
    return new Intl.DateTimeFormat("en-CA", { timeZone: CENTRAL_TZ }).format(new Date());
  }

  function addDaysToDateKey(dateKey, days) {
    const [year, month, day] = dateKey.split("-").map(Number);
    const next = new Date(Date.UTC(year, month - 1, day + days));
    return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(next);
  }

  function getDashboardView() {
    const day = document.getElementById("day")?.value;
    const range = document.getElementById("range")?.value;
    const utility = document.getElementById("utility")?.value || "electric";

    if (day) {
      return { start: day, end: day, utility, label: day };
    }

    const days = Number(range);
    if (Number.isFinite(days) && days > 0) {
      const end = addDaysToDateKey(centralTodayKey(), -1);
      const start = addDaysToDateKey(end, -(days - 1));
      return { start, end, utility, label: `Last ${days} days` };
    }

    return null;
  }

  function queueCurrentView() {
    const view = getDashboardView();
    if (!view) {
      window.dispatchEvent(
        new CustomEvent("nbu-queue-sync-result", {
          detail: { ok: false, error: "Pick a specific day or a day range (not All data)." },
        }),
      );
      return;
    }

    chrome.runtime
      .sendMessage({ type: "set-sync-view", view })
      .then(() => {
        window.dispatchEvent(
          new CustomEvent("nbu-queue-sync-result", {
            detail: { ok: true, view },
          }),
        );
      })
      .catch((error) => {
        window.dispatchEvent(
          new CustomEvent("nbu-queue-sync-result", {
            detail: { ok: false, error: error?.message || String(error) },
          }),
        );
      });
  }

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.id === "queue-extension-sync") {
      queueCurrentView();
    }
  });
})();