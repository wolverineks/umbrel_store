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

  function parseBillingDates(html) {
    const ranges = [];
    const re =
      /billingDates\.push\(\{billing:billingDate, start:new Date\((\d+), (\d+), (\d+)\), end:new Date\((\d+), (\d+), (\d+)\) \}\)/g;
    let match;
    while ((match = re.exec(html)) !== null) {
      ranges.push({
        start: new Date(Number(match[1]), Number(match[2]), Number(match[3])),
        end: new Date(Number(match[4]), Number(match[5]), Number(match[6])),
      });
    }
    return ranges;
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

  function getUtilType() {
    const href = window.location.href;
    if (/utilType=W|utility=W/i.test(href)) return "W";
    return "E";
  }

  function utilityLabel(utilType) {
    return utilType === "W" ? "Water" : "Electric";
  }

  function getObjectIds() {
    const select = document.querySelector("select#meter");
    if (!select) {
      if (typeof window.objectId === "string" && window.objectId) {
        return [window.objectId.replace("_PTR", "").replace("_virtual", "")];
      }
      return [];
    }
    return [...select.options].map((option) =>
      option.value.replace("_PTR", "").replace("_virtual", ""),
    );
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

  function monthRanges(firstDate, lastDate) {
    const ranges = [];
    let cursor = new Date(firstDate.getFullYear(), firstDate.getMonth(), 1);
    while (cursor <= lastDate) {
      const start = new Date(cursor);
      const end = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
      ranges.push({ start, end, label: `Month ${formatYmd(start)}` });
      cursor = end;
    }
    return ranges;
  }

  function weekRanges(firstDate, lastDate) {
    const ranges = [];
    let start = new Date(firstDate.getTime());
    start.setDate(start.getDate() - start.getDay());
    while (start <= lastDate) {
      const end = addDays(start, 7);
      ranges.push({ start: new Date(start), end, label: `Week ${formatYmd(start)}` });
      start = end;
    }
    return ranges;
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

  function exportJobsForRange(range, objectId, utilType, rangeKind) {
    const base = {
      ObjectId: objectId,
      utilType,
      View: "usage",
      Type: "Tier",
    };
    const times = isoRange(range.start, range.end, rangeKind === "Bill");
    const util = utilityLabel(utilType);
    const stamp = formatYmd(range.start).replace(/-/g, "");
    const meterSuffix = objectId.slice(0, 8);

    return [
      {
        kind: "greenbutton",
        rangeKind,
        label: `${range.label} · Green Button`,
        filename: `nbu-${meterSuffix}-${stamp}_${rangeKind}_GreenButton_${util}.xml`,
        url: buildExportUrl("ExportGreenButtonData.xml", { ...base, ...times }),
      },
      {
        kind: "csv-all",
        rangeKind,
        label: `${range.label} · CSV all`,
        filename: `nbu-${meterSuffix}-${stamp}_${rangeKind}_ALL_${util}.csv`,
        url: buildExportUrl("ExportExcelReadData.xml", { ...base, ...times, Type: "all" }),
      },
      {
        kind: "csv-tou",
        rangeKind,
        label: `${range.label} · CSV TOU`,
        filename: `nbu-${meterSuffix}-${stamp}_${rangeKind}_TOU_${util}.csv`,
        url: buildExportUrl("ExportExcelReadData.xml", { ...base, ...times, Type: "Tier" }),
      },
    ];
  }

  function recentCutoff(days) {
    const cutoff = new Date();
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - days);
    return cutoff;
  }

  function rangeIsRecent(range, cutoff) {
    return range.end > cutoff || range.start >= cutoff;
  }

  function buildConsumptionJobs(html, options = {}) {
    const utilType = getUtilType();
    const parsedFirst = parseFirstDate(html) || new Date(Date.now() - 365 * 86_400_000);
    const lastDate = new Date();
    const recentDays = options.recentDays ?? null;
    const cutoff = recentDays ? recentCutoff(recentDays) : null;
    const firstDate =
      cutoff && parsedFirst < cutoff ? new Date(cutoff.getTime()) : parsedFirst;
    const billingDates = parseBillingDates(html);
    const objectIds = getObjectIds();
    const jobs = [];

    for (const objectId of objectIds) {
      const meterLabel = getMeterLabel(objectId);
      for (const range of monthRanges(firstDate, lastDate)) {
        if (cutoff && !rangeIsRecent(range, cutoff)) continue;
        jobs.push(...exportJobsForRange(range, objectId, utilType, "Month").map((job) => ({
          ...job,
          meterLabel,
          objectId,
        })));
      }
      for (const range of weekRanges(firstDate, lastDate)) {
        if (cutoff && !rangeIsRecent(range, cutoff)) continue;
        jobs.push(...exportJobsForRange(range, objectId, utilType, "Week").map((job) => ({
          ...job,
          meterLabel,
          objectId,
        })));
      }
      for (const range of dayRanges(firstDate, lastDate)) {
        jobs.push(...exportJobsForRange(range, objectId, utilType, "Day").map((job) => ({
          ...job,
          meterLabel,
          objectId,
        })));
      }
      for (const billing of billingDates) {
        if (cutoff && billing.end < cutoff) continue;
        const range = {
          start: billing.start,
          end: billing.end,
          label: `Bill ${formatYmd(billing.start)}`,
        };
        jobs.push(...exportJobsForRange(range, objectId, utilType, "Bill").map((job) => ({
          ...job,
          meterLabel,
          objectId,
        })));
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
    if (/xmlns="http:\/\/naesb.org\/espi"/i.test(trimmed)) return trimmed;
    if (/^Meter #,/i.test(trimmed)) return trimmed;
    if (/^Date\/Time,/i.test(trimmed)) return trimmed;
    if (contentType.includes("xml") && trimmed.startsWith("<?xml")) return trimmed;
    if (contentType.includes("csv") || /^[0-9/T:," -]+/i.test(trimmed.slice(0, 40))) return trimmed;
    if (trimmed.includes("<feed") && trimmed.includes("espi")) return trimmed;
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

  async function runSync(options = {}) {
    const jobs = pageJobs(options);
    if (!jobs.length) {
      post("SYNC_ERROR", { error: "Open the Consumption Report or Meter Reading History page first." });
      return;
    }

    post("SYNC_START", {
      total: jobs.length,
      page: window.location.href,
      mode: options.recentDays ? `recent-${options.recentDays}` : "full",
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
        mode: event.data.options?.recentDays ? `last ${event.data.options.recentDays} days` : "full history",
        jobs: jobs.slice(0, 5).map((job) => job.label),
      });
    }
  });
})();