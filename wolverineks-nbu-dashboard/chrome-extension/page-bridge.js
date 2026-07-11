(function () {
  if (window.__nbuUmbrelPageBridge) return;
  window.__nbuUmbrelPageBridge = true;

  const BASE = "https://myinfo.nbutexas.com/CC/connect/users/home/indicators/";
  const BILL_BASE = "https://myinfo.nbutexas.com/CC/connect/users/bill/indicators/";
  const DELAY_MS = 350;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function post(type, payload) {
    window.postMessage({ source: "nbu-umbrel-page", type, ...payload }, "*");
  }

  function parseFirstDate(html) {
    const match = html.match(/var firstDate = parseDate\("([^"]*)"\)/);
    if (!match || !match[1]) return null;
    return parsePortalDate(match[1]);
  }

  function parsePortalDate(value) {
    if (!value) return null;
    const parts = value.split("-").map(Number);
    if (parts.length !== 3) return new Date(value);
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function formatYmd(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function addDays(date, days) {
    const next = new Date(date.getTime());
    next.setDate(next.getDate() + days);
    return next;
  }

  function yesterdayStart() {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - 1);
    return date;
  }

  function clampRangeForExport(range) {
    const yesterday = yesterdayStart();
    const maxExclusiveEnd = addDays(yesterday, 1);
    if (range.start > yesterday) return null;
    const start = new Date(range.start.getTime());
    let end = new Date(range.end.getTime());
    if (end > maxExclusiveEnd) end = maxExclusiveEnd;
    if (end <= start) return null;
    return { start, end, label: range.label };
  }

  function getUtilType() {
    const href = window.location.href;
    if (/utilType=W|utility=W/i.test(href)) return "W";
    return "E";
  }

  function utilityLabel(utilType) {
    return utilType === "W" ? "Water" : "Electric";
  }

  function normalizeObjectId(value) {
    return value.replace("_PTR", "").replace("_virtual", "");
  }

  function getObjectIds() {
    const select = document.querySelector("select#meter");
    if (!select) {
      if (typeof window.objectId === "string" && window.objectId) {
        return [normalizeObjectId(window.objectId)];
      }
      return [];
    }
    return [...select.options].map((option) => normalizeObjectId(option.value));
  }

  function getSelectedObjectId() {
    const select = document.querySelector("select#meter");
    if (select?.value) return normalizeObjectId(select.value);
    const ids = getObjectIds();
    return ids[0] ?? null;
  }

  function getMeterLabel(objectId) {
    const select = document.querySelector("select#meter");
    if (!select) return objectId;
    const option = [...select.options].find((entry) => entry.value.startsWith(objectId));
    return option?.textContent?.trim() || objectId;
  }

  function buildExportUrl(endpoint, params) {
    const url = new URL(`${BASE}${endpoint}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  function buildBillExportUrl(endpoint, params) {
    const url = new URL(`${BILL_BASE}${endpoint}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  function isoRange(startDate, endDate, inclusiveEnd = false) {
    const end = inclusiveEnd ? addDays(endDate, 1) : endDate;
    return {
      StartDateTime: `${formatYmd(startDate)}T00:00:00`,
      EndDateTime: `${formatYmd(end)}T00:00:00`,
    };
  }

  function parseYmd(value) {
    const parts = String(value).split("-").map(Number);
    if (parts.length !== 3) return null;
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function detectPortalViewRange() {
    const html = document.documentElement.innerHTML;
    const patterns = [
      /(?:var|let|const)\s+startDate\s*=\s*parseDate\("([^"]+)"\)/i,
      /(?:var|let|const)\s+chartStartDate\s*=\s*parseDate\("([^"]+)"\)/i,
    ];
    const endPatterns = [
      /(?:var|let|const)\s+endDate\s*=\s*parseDate\("([^"]+)"\)/i,
      /(?:var|let|const)\s+chartEndDate\s*=\s*parseDate\("([^"]+)"\)/i,
    ];

    let startValue = null;
    let endValue = null;
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) {
        startValue = match[1];
        break;
      }
    }
    for (const pattern of endPatterns) {
      const match = html.match(pattern);
      if (match?.[1]) {
        endValue = match[1];
        break;
      }
    }

    if (startValue && endValue) {
      return { start: startValue, end: endValue, source: "portal" };
    }

    const dateInput = document.querySelector(
      'input[type="date"], input[name*="date" i], input[id*="date" i]',
    );
    if (dateInput?.value) {
      return { start: dateInput.value, end: dateInput.value, source: "portal-input" };
    }

    return null;
  }

  function meterObjectIds() {
    const objectIds = getObjectIds();
    if (objectIds.length) return objectIds;
    const selected = getSelectedObjectId();
    return selected ? [selected] : [];
  }

  function buildViewJobs(viewStart, viewEnd) {
    const start = parseYmd(viewStart);
    const end = parseYmd(viewEnd);
    if (!start || !end) return [];

    const utilType = getUtilType();
    const objectIds = meterObjectIds();
    if (!objectIds.length) return [];

    const effectiveEnd = end < start ? start : end;
    const jobs = [];

    for (const objectId of objectIds) {
      const meterLabel = getMeterLabel(objectId);
      for (const range of dayRanges(start, effectiveEnd)) {
        for (const job of csvJobsForRange(range, objectId, utilType, "View")) {
          jobs.push({ ...job, meterLabel, objectId });
        }
      }
    }

    return jobs;
  }

  function dayRanges(firstDate, lastDate) {
    const ranges = [];
    let cursor = new Date(firstDate.getTime());
    while (cursor <= lastDate) {
      const end = addDays(cursor, 1);
      ranges.push({ start: new Date(cursor), end, label: `Day ${formatYmd(cursor)}` });
      cursor = end;
    }
    return ranges;
  }

  function csvJobForRange(range, objectId, utilType, rangeKind) {
    const effectiveRange =
      rangeKind === "View" ? range : clampRangeForExport(range);
    if (!effectiveRange) return null;

    const base = {
      ObjectId: objectId,
      utilType,
      View: "usage",
      Type: "all",
    };
    const times = isoRange(effectiveRange.start, effectiveRange.end, rangeKind === "View");
    const util = utilityLabel(utilType);
    const stamp = formatYmd(effectiveRange.start).replace(/-/g, "");
    const meterSuffix = objectId.slice(0, 8);

    return {
      kind: "csv",
      rangeKind,
      label: `${effectiveRange.label} · Hourly CSV`,
      filename: `nbu-${meterSuffix}-${stamp}_${rangeKind}_HourlyUsage_${util}.csv`,
      url: buildExportUrl("ExportExcelReadData.xml", { ...base, ...times }),
    };
  }

  function csvJobsForRange(range, objectId, utilType, rangeKind) {
    const hourly = csvJobForRange(range, objectId, utilType, rangeKind);
    return hourly ? [hourly] : [];
  }

  function historyCutoff(months, lastDate) {
    const cutoff = new Date(lastDate.getTime());
    cutoff.setMonth(cutoff.getMonth() - months);
    return cutoff;
  }

  function recentCutoff(days) {
    const cutoff = new Date();
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - days);
    return cutoff;
  }

  function buildConsumptionJobs(html, options = {}) {
    const utilType = getUtilType();
    const parsedFirst = parseFirstDate(html) || new Date(Date.now() - 365 * 86_400_000);
    const lastDate = yesterdayStart();
    const recentDays = options.recentDays ?? null;
    const maxHistoryMonths = options.maxHistoryMonths ?? 24;
    const recentStart = recentDays ? recentCutoff(recentDays) : null;
    const historyStart = historyCutoff(maxHistoryMonths, lastDate);
    let firstDate = parsedFirst;
    if (recentStart && parsedFirst < recentStart) {
      firstDate = new Date(recentStart.getTime());
    } else if (!recentStart && parsedFirst < historyStart) {
      firstDate = new Date(historyStart.getTime());
    }
    const objectIds = getObjectIds();
    const jobs = [];

    for (const objectId of objectIds) {
      const meterLabel = getMeterLabel(objectId);
      for (const range of dayRanges(firstDate, lastDate)) {
        for (const job of csvJobsForRange(range, objectId, utilType, "Day")) {
          jobs.push({ ...job, meterLabel, objectId });
        }
      }
    }

    return jobs;
  }

  function historyExportCandidates(objectId, utilType) {
    const params = { utility: utilType, ObjectId: objectId };
    const bare = { utility: utilType };
    return [
      buildBillExportUrl("ExportMeterReadingHistory.xml", params),
      buildBillExportUrl("ExportMeterReadingHistory.xml", bare),
      buildBillExportUrl("ExportReadingHistory.xml", params),
      buildBillExportUrl("ExportExcelReadData.xml", { ...params, Type: "all" }),
    ];
  }

  function buildHistoryJobs() {
    const utilType = getUtilType();
    const util = utilityLabel(utilType);
    const objectIds = getObjectIds();
    const jobs = [];
    for (const objectId of objectIds) {
      jobs.push({
        kind: "history",
        rangeKind: "History",
        label: `${getMeterLabel(objectId)} · Reading history`,
        filename: `nbu-${objectId.slice(0, 8)}_${util}ReadingHistory_.csv`,
        urls: historyExportCandidates(objectId, utilType),
        meterLabel: getMeterLabel(objectId),
        objectId,
      });
    }
    return jobs;
  }

  function pageJobs(options = {}) {
    if (options.viewStart && options.viewEnd) {
      return buildViewJobs(options.viewStart, options.viewEnd);
    }

    if (options.detectPortalView) {
      const detected = detectPortalViewRange();
      if (detected) {
        return buildViewJobs(detected.start, detected.end);
      }
      return [];
    }

    const html = document.documentElement.innerHTML;
    if (/MeterReadingHistory\.xml/i.test(window.location.href)) {
      return buildHistoryJobs();
    }
    if (/Reports\.xml/i.test(window.location.href)) {
      return buildConsumptionJobs(html, options);
    }
    return [];
  }

  function filenameFromDisposition(header, fallback) {
    if (!header) return fallback;
    const match = /filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i.exec(header);
    const raw = decodeURIComponent(match?.[1] || match?.[2] || "");
    return raw || fallback;
  }

  function normalizeContent(text, contentType) {
    const trimmed = text.trim();
    if (!trimmed) return null;
    if (/xmlns="http:\/\/naesb.org\/espi"/i.test(trimmed)) return null;
    if (trimmed.includes("<feed") && trimmed.includes("espi")) return null;
    if (/^Meter #,/i.test(trimmed)) return trimmed;
    if (/^Date\/Time,/i.test(trimmed)) return trimmed;
    if (contentType.includes("csv") || /^[0-9/A-Za-z:," -]+/i.test(trimmed.slice(0, 40))) {
      if (trimmed.startsWith("<?xml")) return null;
      return trimmed;
    }
    return null;
  }

  async function fetchJob(job) {
    const urls = job.urls || [job.url];
    let lastError = "empty or unsupported response";
    let lastStatus = null;
    let lastUrl = urls[0] || null;
    for (const url of urls) {
      lastUrl = url;
      try {
        const response = await fetch(url, { credentials: "include", cache: "no-store" });
        lastStatus = response.status;
        if (!response.ok) {
          lastError = `HTTP ${response.status}`;
          continue;
        }
        const contentType = response.headers.get("content-type") || "";
        const text = await response.text();
        const content = normalizeContent(text, contentType);
        if (!content) {
          lastError = "empty or unsupported response";
          continue;
        }
        const filename = filenameFromDisposition(
          response.headers.get("content-disposition"),
          job.filename,
        );
        return { filename, content };
      } catch (error) {
        lastError = error.message || String(error);
      }
    }
    const failure = new Error(lastError);
    failure.status = lastStatus;
    failure.url = lastUrl;
    throw failure;
  }

  function isIngestAuthError(error) {
    return /invalid ingest token/i.test(error?.message || "");
  }

  function verifyIngestToken() {
    return new Promise((resolve, reject) => {
      const requestId = `verify-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const timeout = setTimeout(() => {
        window.removeEventListener("message", onResponse);
        reject(new Error("token check timeout"));
      }, 15_000);

      function onResponse(event) {
        if (event.source !== window || event.data?.source !== "nbu-umbrel-content") return;
        if (event.data.type !== "VERIFY_INGEST_RESULT" || event.data.requestId !== requestId) return;
        clearTimeout(timeout);
        window.removeEventListener("message", onResponse);
        if (event.data.ok) resolve();
        else reject(new Error(event.data.error || "invalid ingest token"));
      }

      window.addEventListener("message", onResponse);
      post("VERIFY_INGEST_REQUEST", { requestId });
    });
  }

  async function runSync(options = {}) {
    try {
      await verifyIngestToken();
    } catch (error) {
      post("SYNC_ERROR", { error: error.message || "invalid ingest token" });
      return;
    }

    const jobs = pageJobs(options);
    if (!jobs.length) {
      if (options.viewStart && options.viewEnd) {
        if (!meterObjectIds().length) {
          post("SYNC_ERROR", {
            error:
              "No meter on this page. Open the Consumption Report, wait for the meter dropdown to load, then retry.",
          });
        } else {
          post("SYNC_ERROR", {
            error: `Could not build exports for ${options.viewStart}${options.viewEnd !== options.viewStart ? `–${options.viewEnd}` : ""}.`,
          });
        }
      } else if (options.detectPortalView) {
        post("SYNC_ERROR", {
          error:
            "No view to sync. On Umbrel: pick a day → Queue for extension. Or open a dated chart on Customer Connect.",
        });
      } else {
        post("SYNC_ERROR", { error: "Open the Consumption Report or Meter Reading History page first." });
      }
      return;
    }

    let mode = "full";
    if (options.viewStart && options.viewEnd) {
      mode = `view:${options.viewStart}${options.viewEnd !== options.viewStart ? `–${options.viewEnd}` : ""}`;
    } else if (options.detectPortalView) {
      mode = "portal-view";
    } else if (options.recentDays) {
      mode = `recent-${options.recentDays}`;
    }

    post("SYNC_START", {
      total: jobs.length,
      page: window.location.href,
      mode,
      viewStart: options.viewStart ?? null,
      viewEnd: options.viewEnd ?? null,
    });
    let uploaded = 0;
    let skipped = 0;
    const errors = [];
    const utilType = getUtilType();

    for (let index = 0; index < jobs.length; index++) {
      const job = jobs[index];
      post("SYNC_PROGRESS", {
        index: index + 1,
        total: jobs.length,
        label: `${job.meterLabel}: ${job.label}`,
      });

      try {
        const result = await fetchJob(job);
        const upload = await requestUpload(result.filename, result.content);
        if (upload?.skipped) skipped += 1;
        else uploaded += 1;
      } catch (error) {
        const message = error.message || String(error);
        if (isIngestAuthError(error)) {
          post("SYNC_ERROR", { error: message });
          return;
        }
        errors.push({
          label: `${job.meterLabel}: ${job.label}`,
          url: error.url || job.url || job.urls?.[0] || null,
          error: message,
          status: error.status ?? null,
          objectId: job.objectId || null,
        });
      }

      await sleep(DELAY_MS);
    }

    post("SYNC_DONE", {
      uploaded,
      skipped,
      failed: errors.length,
      errors: errors.map((item) => `${item.label}: ${item.error}`),
      errorDetails: errors,
      utility: utilType === "W" ? "water" : "electric",
      objectId: jobs[0]?.objectId || null,
    });
  }

  function requestUpload(filename, content) {
    return new Promise((resolve, reject) => {
      const requestId = `upload-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const timeout = setTimeout(() => {
        window.removeEventListener("message", onResponse);
        reject(new Error("upload timeout"));
      }, 60_000);

      function onResponse(event) {
        if (event.source !== window || event.data?.source !== "nbu-umbrel-content") return;
        if (event.data.type !== "UPLOAD_RESULT" || event.data.requestId !== requestId) return;
        clearTimeout(timeout);
        window.removeEventListener("message", onResponse);
        if (event.data.ok) resolve(event.data.result);
        else reject(new Error(event.data.error || "upload failed"));
      }

      window.addEventListener("message", onResponse);
      post("UPLOAD_REQUEST", { requestId, filename, content });
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "nbu-umbrel-content") return;
    if (event.data.type === "START_SYNC") {
      void runSync(event.data.options || {});
    }
    if (event.data.type === "PLAN_SYNC") {
      const jobs = pageJobs(event.data.options || {});
      post("SYNC_PLAN", {
        total: jobs.length,
        mode: event.data.options?.recentDays
          ? `last ${event.data.options.recentDays} days · Hourly CSV · daily`
          : "full history · Hourly CSV · daily",
        jobs: jobs.slice(0, 5).map((job) => job.label),
      });
    }
    if (event.data.type === "GET_OBJECT_ID") {
      const objectId = getSelectedObjectId();
      post("OBJECT_ID", {
        objectId,
        objectIds: getObjectIds(),
        meterLabel: objectId ? getMeterLabel(objectId) : null,
      });
    }
  });
})();