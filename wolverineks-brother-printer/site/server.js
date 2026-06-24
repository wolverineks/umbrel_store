"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_http_1 = require("node:http");
const node_crypto_1 = require("node:crypto");
const node_child_process_1 = require("node:child_process");
const promises_1 = require("node:fs/promises");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const APP_VERSION = "1.2.0";
const DATA_ROOT = process.env.PRINTER_DATA_DIR ?? "/data";
const SCANS_DIR = node_path_1.default.join(DATA_ROOT, "scans");
const SETTINGS_PATH = node_path_1.default.join(DATA_ROOT, "settings.json");
const ICON_PATH = node_path_1.default.join(__dirname, "icon.svg");
const PRINT_JOB_TEST_PATH = node_path_1.default.join(__dirname, "print-job.test");
const IPPTOOL_PATH = process.env.IPPTOOL_PATH?.trim() || "/usr/bin/ipptool";
const PDFTOPPM_PATH = process.env.PDFTOPPM_PATH?.trim() || "/usr/bin/pdftoppm";
const IPP_ATTRS_TEST_PATH = process.env.IPP_ATTRS_TEST_PATH?.trim() || "/usr/share/cups/ipptool/get-printer-attributes.test";
const ESCL_NS = "http://schemas.hp.com/imaging/escl/2011/05/03";
const PWG_NS = "http://www.pwg.org/schemas/2010/12/sm";
function scanDisplayName(record) {
    const custom = record.display_name?.trim();
    if (custom)
        return custom;
    const when = new Date(record.created_at).toLocaleString();
    return `Scan ${when}`;
}
function normalizeScanRecord(record) {
    return {
        ...record,
        display_name: scanDisplayName(record),
    };
}
const DEFAULT_BLACK_INK_REORDER_URL = "https://www.amazon.com/Brother-Genuine-LC501XL2PK-Cartridges-Printers/dp/B0FKL36T9M/ref=sr_1_3?crid=3U2IHBBOA24L9&dib=eyJ2IjoiMSJ9.FY1W4QzVZuxABV-W0Koybv3iJrNFKC9fV9XQvujf95XxqJbvjfFInM62PkNC7fffAvXcX1NQrxL5z9HHhZs0FxAqT9kvsRS2P59ZpXkNhahp4nio-aiWm1N5LoBWaYKTNwv_aKYw6Gma9oLzQPlWYBwjChqhEBreCssiCFZBIp-tsx2mwiWjE8mUe586D5dc4N5hzSjXI9imBQ0ZvuVSFLjsucuN2KS1W79G-6XPprk.lXlPGVisv7rNSOIaDtGgxGR7DBfNLn-1F73gelzNQso&dib_tag=se&keywords=brother%2Blc501xl&qid=1782261557&sprefix=brother%2Blc501xl%2Caps%2C188&sr=8-3&th=1";
const DEFAULT_COLOR_INK_REORDER_URL = "https://www.amazon.com/Brother-Genuine-LC501XL2PK-Cartridges-Printers/dp/B0FKLH56D3/ref=sr_1_3?crid=3U2IHBBOA24L9&dib=eyJ2IjoiMSJ9.FY1W4QzVZuxABV-W0Koybv3iJrNFKC9fV9XQvujf95XxqJbvjfFInM62PkNC7fffAvXcX1NQrxL5z9HHhZs0FxAqT9kvsRS2P59ZpXkNhahp4nio-aiWm1N5LoBWaYKTNwv_aKYw6Gma9oLzQPlWYBwjChqhEBreCssiCFZBIp-tsx2mwiWjE8mUe586D5dc4N5hzSjXI9imBQ0ZvuVSFLjsucuN2KS1W79G-6XPprk.lXlPGVisv7rNSOIaDtGgxGR7DBfNLn-1F73gelzNQso&dib_tag=se&keywords=brother%2Blc501xl&qid=1782261557&sprefix=brother%2Blc501xl%2Caps%2C188&sr=8-3&th=1";
const DEFAULT_SETTINGS = {
    printer_host: process.env.PRINTER_HOST?.trim() || "192.168.86.31",
    printer_name: "Brother MFC-J1360DW",
    black_ink_reorder_url: DEFAULT_BLACK_INK_REORDER_URL,
    color_ink_reorder_url: DEFAULT_COLOR_INK_REORDER_URL,
};
async function ensureDataDirs() {
    await (0, promises_1.mkdir)(SCANS_DIR, { recursive: true });
}
async function loadSettings() {
    if (!(0, node_fs_1.existsSync)(SETTINGS_PATH)) {
        return { ...DEFAULT_SETTINGS };
    }
    try {
        const raw = await (0, promises_1.readFile)(SETTINGS_PATH, "utf8");
        const parsed = JSON.parse(raw);
        return {
            printer_host: parsed.printer_host?.trim() || DEFAULT_SETTINGS.printer_host,
            printer_name: parsed.printer_name?.trim() || DEFAULT_SETTINGS.printer_name,
            black_ink_reorder_url: parsed.black_ink_reorder_url === undefined
                ? DEFAULT_SETTINGS.black_ink_reorder_url
                : parsed.black_ink_reorder_url.trim(),
            color_ink_reorder_url: parsed.color_ink_reorder_url === undefined
                ? DEFAULT_SETTINGS.color_ink_reorder_url
                : parsed.color_ink_reorder_url.trim(),
        };
    }
    catch {
        return { ...DEFAULT_SETTINGS };
    }
}
async function saveSettings(settings) {
    await (0, promises_1.writeFile)(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}
function normalizeReorderUrl(value, current) {
    if (value === undefined)
        return current;
    const trimmed = value.trim();
    if (!trimmed)
        return "";
    let parsed;
    try {
        parsed = new URL(trimmed);
    }
    catch {
        throw new Error("Reorder links must be valid http or https URLs.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Reorder links must use http or https.");
    }
    return trimmed;
}
function printerBaseUrl(host) {
    return `http://${host}`;
}
function esclBaseUrl(host) {
    return `http://${host}/eSCL`;
}
function ippUri(host) {
    return `ipp://${host}/ipp/print`;
}
function escapeHtml(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
function sendJson(res, statusCode, payload) {
    const body = Buffer.from(JSON.stringify(payload));
    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": body.length,
    });
    res.end(body);
}
function sendText(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
    const buffer = Buffer.from(body);
    res.writeHead(statusCode, {
        "Content-Type": contentType,
        "Content-Length": buffer.length,
    });
    res.end(buffer);
}
function sendBytes(res, statusCode, contentType, body, downloadName) {
    const headers = {
        "Content-Type": contentType,
        "Content-Length": body.length,
    };
    if (downloadName) {
        const asciiFallback = downloadName.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
        const encoded = encodeURIComponent(downloadName);
        headers["Content-Disposition"] =
            `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
    }
    res.writeHead(statusCode, headers);
    res.end(body);
}
async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}
async function readJson(req) {
    const body = await readBody(req);
    if (body.length === 0)
        return {};
    return JSON.parse(body.toString("utf8"));
}
function xmlTagValue(xml, tag) {
    const patterns = [
        new RegExp(`<(?:[\\w-]+:)?${tag}[^>]*>([^<]*)</(?:[\\w-]+:)?${tag}>`, "i"),
        new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "i"),
    ];
    for (const pattern of patterns) {
        const match = xml.match(pattern);
        if (match?.[1] !== undefined)
            return match[1].trim();
    }
    return null;
}
function xmlAllTagValues(xml, tag) {
    const pattern = new RegExp(`<(?:[\\w-]+:)?${tag}[^>]*>([^<]*)</(?:[\\w-]+:)?${tag}>`, "gi");
    const values = [];
    let match;
    while ((match = pattern.exec(xml)) !== null) {
        values.push(match[1].trim());
    }
    return values;
}
async function fetchPrinterText(host, route, timeoutMs = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(`${printerBaseUrl(host)}${route}`, {
            signal: controller.signal,
            headers: { Accept: "text/html,application/xml,text/xml,*/*" },
        });
        if (!response.ok) {
            throw new Error(`Printer returned HTTP ${response.status} for ${route}`);
        }
        return await response.text();
    }
    finally {
        clearTimeout(timer);
    }
}
async function fetchEscl(host, route, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
        return await fetch(`${esclBaseUrl(host)}${route}`, {
            ...init,
            signal: controller.signal,
        });
    }
    finally {
        clearTimeout(timer);
    }
}
const MEDIA_LABELS = {
    "na_letter_8.5x11in": "Letter",
    "iso_a4_210x297mm": "A4",
    "na_legal_8.5x14in": "Legal",
    "na_executive_7.25x10.5in": "Executive",
    "iso_a5_148x210mm": "A5",
    "iso_a6_105x148mm": "A6",
    "na_number-10_4.125x9.5in": "Envelope #10",
    "iso_dl_110x220mm": "DL Envelope",
    "iso_c5_162x229mm": "C5 Envelope",
    "na_monarch_3.875x7.5in": "Monarch Envelope",
    "na_foolscap_8.5x13in": "Foolscap",
    "na_oficio_8.5x13.4in": "Oficio",
    "om_india-legal_215x345mm": "India Legal",
    "na_index-4x6_4x6in": "4×6 Index",
    "oe_photo-l_3.5x5in": "3.5×5 Photo",
    "na_5x7_5x7in": "5×7",
    "na_index-5x8_5x8in": "5×8 Index",
};
const COLOR_MODE_LABELS = {
    RGB24: "Color",
    Grayscale8: "Grayscale",
    BlackAndWhite1: "Black & white",
};
const FORMAT_LABELS = {
    "image/jpeg": "JPEG",
    "application/pdf": "PDF",
};
const SIDES_LABELS = {
    "one-sided": "One-sided",
    "two-sided-long-edge": "Two-sided (long edge)",
    "two-sided-short-edge": "Two-sided (short edge)",
};
function formatMediaLabel(media) {
    const trimmed = media.trim();
    return MEDIA_LABELS[trimmed] ?? trimmed.replace(/^(na_|iso_|oe_|om_)/, "").replace(/_/g, " ");
}
function formatAdfState(state) {
    const normalized = state.trim();
    const lower = normalized.toLowerCase();
    if (lower.includes("loaded"))
        return "Paper loaded";
    if (lower.includes("empty"))
        return "Empty";
    if (lower.includes("jam"))
        return "Paper jam";
    if (lower.includes("mispick"))
        return "Misfeed";
    if (lower.includes("processing"))
        return "Processing";
    return normalized.replace(/^ScannerAdf/i, "").replace(/([a-z])([A-Z])/g, "$1 $2").trim() || normalized;
}
function parseIppKeywordList(value) {
    if (!value)
        return [];
    const parts = Array.isArray(value) ? value : [value];
    return [...new Set(parts.flatMap((entry) => entry.split(",").map((item) => item.trim()).filter(Boolean)))];
}
const ippStatusCache = new Map();
const IPP_STATUS_CACHE_MS = 30_000;
async function getIppStatusSummary(host) {
    const cached = ippStatusCache.get(host);
    if (cached && Date.now() - cached.at < IPP_STATUS_CACHE_MS) {
        return cached.data;
    }
    const empty = {
        available: false,
        media_ready: null,
        media_default: null,
        media_supported: [],
        sides_supported: [],
        color_modes_supported: [],
        queued_job_count: null,
        accepting_jobs: null,
        printer_state: null,
        alert_descriptions: [],
        sleep_or_warmup: false,
    };
    const ipp = await getIppDiagnostics(host);
    if (!ipp.available) {
        const summary = { ...empty, error: ipp.error };
        ippStatusCache.set(host, { at: Date.now(), data: summary });
        return summary;
    }
    const alertDescriptions = parseIppKeywordList(ippAttrValue(ipp.attributes, "printer-alert-description"));
    const sleepOrWarmup = alertDescriptions.some((entry) => /sleep|warm/i.test(entry));
    const queuedRaw = ippAttrValue(ipp.attributes, "queued-job-count");
    const acceptingRaw = ippAttrValue(ipp.attributes, "printer-is-accepting-jobs");
    const summary = {
        available: true,
        media_ready: ippAttrValue(ipp.attributes, "media-ready"),
        media_default: ippAttrValue(ipp.attributes, "media-default"),
        media_supported: parseIppKeywordList(ippAttrValue(ipp.attributes, "media-supported")),
        sides_supported: parseIppKeywordList(ippAttrValue(ipp.attributes, "sides-supported")),
        color_modes_supported: parseIppKeywordList(ippAttrValue(ipp.attributes, "print-color-mode-supported")),
        queued_job_count: queuedRaw == null ? null : Number.parseInt(queuedRaw, 10),
        accepting_jobs: acceptingRaw == null ? null : acceptingRaw === "true",
        printer_state: ippAttrValue(ipp.attributes, "printer-state"),
        alert_descriptions: alertDescriptions,
        sleep_or_warmup: sleepOrWarmup,
    };
    ippStatusCache.set(host, { at: Date.now(), data: summary });
    return summary;
}
function buildIppAlerts(ipp) {
    if (!ipp.available)
        return [];
    const alerts = [];
    if (ipp.sleep_or_warmup) {
        alerts.push({
            severity: "info",
            title: "Printer sleeping",
            message: "The printer may be in sleep or warmup mode. The first scan or print can take longer than usual.",
        });
    }
    if (ipp.queued_job_count != null && ipp.queued_job_count > 0) {
        alerts.push({
            severity: "info",
            title: "Jobs queued",
            message: `${ipp.queued_job_count} job${ipp.queued_job_count === 1 ? "" : "s"} waiting in the printer queue.`,
        });
    }
    if (ipp.accepting_jobs === false) {
        alerts.push({
            severity: "warning",
            title: "Not accepting jobs",
            message: "The printer is not accepting new print jobs right now.",
        });
    }
    return alerts;
}
function mergeStatusAlerts(primary, extra) {
    const merged = [...primary];
    for (const alert of extra) {
        const duplicate = merged.some((existing) => existing.title === alert.title || existing.message === alert.message);
        if (!duplicate)
            merged.push(alert);
    }
    return merged;
}
async function getScannerStatus(host) {
    const xml = await fetchPrinterText(host, "/eSCL/ScannerStatus");
    const adfState = xmlTagValue(xml, "AdfState") ?? "Unknown";
    const staleScanJobs = parseEsclScanJobs(xml).length;
    return {
        state: xmlTagValue(xml, "State") ?? "Unknown",
        adf_state: adfState,
        adf_state_label: formatAdfState(adfState),
        version: xmlTagValue(xml, "Version"),
        stale_scan_jobs: staleScanJobs,
    };
}
async function getScannerCapabilities(host) {
    const xml = await fetchPrinterText(host, "/eSCL/ScannerCapabilities");
    const resolutions = xmlAllTagValues(xml, "XResolution")
        .map((value) => Number.parseInt(value, 10))
        .filter((value) => Number.isFinite(value));
    const uniqueResolutions = [...new Set(resolutions)].sort((a, b) => a - b);
    const formats = xmlAllTagValues(xml, "DocumentFormat");
    const colorModes = xmlAllTagValues(xml, "ColorMode");
    const hasAdf = xml.includes("<scan:Adf") || xml.includes(":Adf>");
    const maxWidth = Number.parseInt(xmlTagValue(xml, "MaxWidth") ?? "2550", 10);
    const maxHeight = Number.parseInt(xmlTagValue(xml, "MaxHeight") ?? "3507", 10);
    return {
        make_and_model: xmlTagValue(xml, "MakeAndModel") ?? "Brother MFC-J1360DW",
        serial_number: xmlTagValue(xml, "SerialNumber"),
        has_adf: hasAdf,
        max_width: maxWidth,
        max_height: maxHeight,
        resolutions: uniqueResolutions.length > 0 ? uniqueResolutions : [100, 200, 300, 600],
        formats: [...new Set(formats)],
        color_modes: [...new Set(colorModes)],
        feeder_capacity: Number.parseInt(xmlTagValue(xml, "FeederCapacity") ?? "20", 10),
    };
}
const BROTHER_INK_COLOR_CODES = {
    BK: "Black",
    M: "Magenta",
    C: "Cyan",
    Y: "Yellow",
};
function inkReorderUrl(color, settings) {
    const url = color === "Black" ? settings.black_ink_reorder_url : settings.color_ink_reorder_url;
    const trimmed = url.trim();
    return trimmed || undefined;
}
function inkReorderUrlFromBrotherCode(code, settings) {
    const color = BROTHER_INK_COLOR_CODES[code.trim().toUpperCase()];
    return color ? inkReorderUrl(color, settings) : undefined;
}
function inkReorderUrlFromStatusMessage(message, settings) {
    const match = message.trim().match(/^Ink (?:Low|Empty) \(([^)]+)\)$/i);
    return match ? inkReorderUrlFromBrotherCode(match[1], settings) : undefined;
}
function decodeHtmlEntities(text) {
    return text
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
}
function parseMonitorStatus(html) {
    const match = html.match(/<span class="moni\s+([^"]+)"[^>]*>([\s\S]*?)<\/span>/i);
    if (!match) {
        return { message: "Status unavailable", level: "unknown" };
    }
    const className = match[1];
    const message = decodeHtmlEntities(match[2].replace(/<[^>]+>/g, "").trim()) || "Status unavailable";
    let level = "unknown";
    if (className.includes("moniReady"))
        level = "ready";
    else if (className.includes("moniWarning"))
        level = "warning";
    else if (className.includes("moniBusy"))
        level = "busy";
    else if (className.includes("moniError"))
        level = "error";
    return { message, level };
}
function expandBrotherStatusMessage(message) {
    const normalized = message.trim();
    const inkLowMatch = normalized.match(/^Ink Low \(([^)]+)\)$/i);
    if (inkLowMatch) {
        const code = inkLowMatch[1].trim().toUpperCase();
        const color = BROTHER_INK_COLOR_CODES[code] ?? code;
        return `${color} ink is low. Replace or refill the ${color.toLowerCase()} ink cartridge.`;
    }
    const inkEmptyMatch = normalized.match(/^Ink Empty \(([^)]+)\)$/i);
    if (inkEmptyMatch) {
        const code = inkEmptyMatch[1].trim().toUpperCase();
        const color = BROTHER_INK_COLOR_CODES[code] ?? code;
        return `${color} ink is empty. Replace the ${color.toLowerCase()} ink cartridge before printing.`;
    }
    if (/^paper empty$/i.test(normalized)) {
        return "Paper tray is empty. Add paper before printing.";
    }
    if (/paper jam/i.test(normalized)) {
        return "Paper jam detected. Open the printer and clear the jam.";
    }
    if (/cover open/i.test(normalized)) {
        return "A printer cover is open. Close it to continue.";
    }
    return normalized;
}
function buildInkAlerts(ink, settings) {
    const alerts = [];
    for (const level of ink.cartridges) {
        const reorderUrl = inkReorderUrl(level.color, settings);
        if (level.percent === 0) {
            alerts.push({
                severity: "error",
                title: `${level.color} cartridge empty`,
                message: `The ${level.color.toLowerCase()} ink cartridge appears empty.`,
                reorder_url: reorderUrl,
            });
        }
        else if (level.low) {
            alerts.push({
                severity: "warning",
                title: `${level.color} cartridge low`,
                message: `The ${level.color.toLowerCase()} ink cartridge is running low (${level.percent}%).`,
                reorder_url: reorderUrl,
            });
        }
    }
    for (const level of ink.reservoir) {
        if (level.percent <= 5) {
            alerts.push({
                severity: "warning",
                title: `${level.color} reservoir low`,
                message: `The internal ${level.color.toLowerCase()} ink reservoir is very low (${level.percent}%).`,
            });
        }
    }
    return alerts;
}
function buildStatusAlerts(monitor, ink, settings) {
    const alerts = [];
    const expanded = expandBrotherStatusMessage(monitor.message);
    if (monitor.level === "ready") {
        alerts.push({
            severity: "success",
            title: "Ready to print",
            message: monitor.message === "Ready" ? "The printer is idle and ready." : expanded,
        });
    }
    else if (monitor.level === "busy") {
        alerts.push({
            severity: "info",
            title: "Printer busy",
            message: expanded,
        });
    }
    else if (monitor.level === "warning") {
        alerts.push({
            severity: "warning",
            title: "Printer needs attention",
            message: expanded,
            reorder_url: inkReorderUrlFromStatusMessage(monitor.message, settings),
        });
    }
    else if (monitor.level === "error") {
        alerts.push({
            severity: "error",
            title: "Printer error",
            message: expanded,
            reorder_url: inkReorderUrlFromStatusMessage(monitor.message, settings),
        });
    }
    else if (monitor.message !== "Status unavailable") {
        alerts.push({
            severity: "info",
            title: "Printer status",
            message: expanded,
        });
    }
    for (const inkAlert of buildInkAlerts(ink, settings)) {
        const duplicate = alerts.some((alert) => alert.title.toLowerCase().includes(inkAlert.title.split(" ")[0].toLowerCase()) ||
            alert.message.toLowerCase().includes(inkAlert.title.split(" ")[0].toLowerCase()));
        if (!duplicate)
            alerts.push(inkAlert);
    }
    return alerts;
}
function parseInkLevels(html) {
    const cartridgeSection = html.match(/<table id="inkLevel"[\s\S]*?<\/table>/i)?.[0] ?? "";
    const reservoirSection = html.match(/<table id="internalInkLevel"[\s\S]*?<\/table>/i)?.[0] ?? "";
    const headerCells = [...(cartridgeSection.match(/<tr>[\s\S]*?<\/tr>/i)?.[0] ?? "").matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((match) => match[1].toLowerCase().includes("low"));
    const cartridgeHeights = [...cartridgeSection.matchAll(/class="tonerremain"[^>]*height="(\d+)"/gi)].map((m) => Number.parseInt(m[1], 10));
    const reservoirHeights = [...reservoirSection.matchAll(/class="tonerremain"[^>]*height="(\d+)"/gi)].map((m) => Number.parseInt(m[1], 10));
    const colors = ["Magenta", "Cyan", "Yellow", "Black"];
    const toLevels = (heights, lows = []) => colors.map((color, index) => {
        const height = heights[index] ?? 0;
        const percent = Math.max(0, Math.min(100, Math.round((height / 48) * 100)));
        return { color, percent, low: lows[index] ?? percent <= 15 };
    });
    return {
        cartridges: toLevels(cartridgeHeights, headerCells),
        reservoir: toLevels(reservoirHeights),
    };
}
async function getPrinterStatus(host, settings) {
    const [statusHtml, monitorHtml] = await Promise.all([
        fetchPrinterText(host, "/home/status.html"),
        fetchPrinterText(host, "/home/monitor.html"),
    ]);
    const ink = parseInkLevels(statusHtml);
    const pageYield = parsePageYield(statusHtml);
    const monitor = parseMonitorStatus(monitorHtml);
    const alerts = buildStatusAlerts(monitor, ink, settings);
    return {
        device_status: monitor.message,
        device_status_level: monitor.level,
        device_status_detail: expandBrotherStatusMessage(monitor.message),
        alerts,
        ink,
        page_yield: pageYield,
    };
}
function parsePageYield(html) {
    const section = html.match(/<table id="possiblePrintNum"[\s\S]*?<\/table>/i)?.[0];
    if (!section)
        return null;
    const values = [...section.matchAll(/<th><span>([^<]*)<\/span><\/th>/gi)].map((match) => decodeHtmlEntities(match[1].trim()));
    if (values.length < 4)
        return null;
    return {
        magenta: values[0],
        cyan: values[1],
        yellow: values[2],
        black: values[3],
    };
}
function parseStatusPageModel(html) {
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    return titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : null;
}
function parseStatusPageMonitor(html) {
    const match = html.match(/<span class="moni\s+([^"]+)"[^>]*>([\s\S]*?)<\/span>/i);
    if (!match) {
        return { message: "Status unavailable", level: "unknown" };
    }
    const className = match[1];
    const message = decodeHtmlEntities(match[2].replace(/<[^>]+>/g, "").trim()) || "Status unavailable";
    let level = "unknown";
    if (className.includes("moniReady"))
        level = "ready";
    else if (className.includes("moniWarning"))
        level = "warning";
    else if (className.includes("moniBusy"))
        level = "busy";
    else if (className.includes("moniError"))
        level = "error";
    return { message, level };
}
function parseEsclScanJobs(xml) {
    const blocks = xml.match(/<scan:JobInfo>[\s\S]*?<\/scan:JobInfo>/gi) ?? [];
    return blocks.map((block) => ({
        job_uri: xmlTagValue(block, "JobUri"),
        job_uuid: xmlTagValue(block, "JobUuid"),
        age_ms: Number.parseInt(xmlTagValue(block, "Age") ?? "0", 10),
        images_completed: Number.parseInt(xmlTagValue(block, "ImagesCompleted") ?? "0", 10),
        images_to_transfer: Number.parseInt(xmlTagValue(block, "ImagesToTransfer") ?? "0", 10),
        job_state: xmlTagValue(block, "JobState"),
        job_state_reason: xmlTagValue(block, "JobStateReason"),
    }));
}
function parseEsclCapabilitiesExtended(xml) {
    return {
        escl_version: xmlTagValue(xml, "Version"),
        make_and_model: xmlTagValue(xml, "MakeAndModel"),
        serial_number: xmlTagValue(xml, "SerialNumber"),
        manufacturer: xmlTagValue(xml, "Manufacturer"),
        uuid: xmlTagValue(xml, "UUID"),
        admin_uri: xmlTagValue(xml, "AdminURI"),
        icon_uri: xmlTagValue(xml, "IconURI"),
        certifications: xmlAllTagValues(xml, "Name"),
        color_modes: xmlAllTagValues(xml, "ColorMode"),
        document_formats: [...new Set([...xmlAllTagValues(xml, "DocumentFormat"), ...xmlAllTagValues(xml, "DocumentFormatExt")])],
        color_spaces: xmlAllTagValues(xml, "ColorSpace"),
        scan_intents: xmlAllTagValues(xml, "Intent"),
        binary_renderings: xmlAllTagValues(xml, "BinaryRendering"),
        feeder_capacity: Number.parseInt(xmlTagValue(xml, "FeederCapacity") ?? "0", 10) || null,
        adf_options: xmlAllTagValues(xml, "AdfOption"),
        blank_page_detection: xmlTagValue(xml, "BlankPageDetection"),
        blank_page_detection_and_removal: xmlTagValue(xml, "BlankPageDetectionAndRemoval"),
        platen: {
            min_width: Number.parseInt(xmlTagValue(xml, "MinWidth") ?? "0", 10),
            max_width: Number.parseInt(xmlTagValue(xml, "MaxWidth") ?? "0", 10),
            min_height: Number.parseInt(xmlTagValue(xml, "MinHeight") ?? "0", 10),
            max_height: Number.parseInt(xmlTagValue(xml, "MaxHeight") ?? "0", 10),
            max_optical_x_resolution: Number.parseInt(xmlTagValue(xml, "MaxOpticalXResolution") ?? "0", 10),
            max_optical_y_resolution: Number.parseInt(xmlTagValue(xml, "MaxOpticalYResolution") ?? "0", 10),
            max_physical_width: Number.parseInt(xmlTagValue(xml, "MaxPhysicalWidth") ?? "0", 10),
            max_physical_height: Number.parseInt(xmlTagValue(xml, "MaxPhysicalHeight") ?? "0", 10),
        },
        compression: {
            min: xmlTagValue(xml, "Min"),
            max: xmlTagValue(xml, "Max"),
            normal: xmlTagValue(xml, "Normal"),
            step: xmlTagValue(xml, "Step"),
        },
        brightness: {
            min: xmlTagValue(xml, "Min"),
            max: xmlTagValue(xml, "Max"),
            normal: xmlTagValue(xml, "Normal"),
        },
        contrast: {
            min: xmlTagValue(xml, "Min"),
            max: xmlTagValue(xml, "Max"),
            normal: xmlTagValue(xml, "Normal"),
        },
    };
}
function parseIppToolOutput(output) {
    const attrs = {};
    const lines = output.split("\n");
    for (const line of lines) {
        const match = line.match(/^\s+([\w-]+)\s+\([^)]+\)\s*=\s*(.+)$/);
        if (!match)
            continue;
        const key = match[1];
        const value = match[2].trim();
        const existing = attrs[key];
        if (existing === undefined) {
            attrs[key] = value;
        }
        else if (Array.isArray(existing)) {
            existing.push(value);
        }
        else {
            attrs[key] = [existing, value];
        }
    }
    return attrs;
}
function ippAttrValue(attrs, key) {
    const value = attrs[key];
    if (value === undefined)
        return null;
    if (Array.isArray(value))
        return value.join(", ");
    return value;
}
const SUPPLY_TYPE_LABELS = {
    inkCartridge: "Ink cartridge",
    inkTank: "Ink tank",
    tonerCartridge: "Toner cartridge",
    toner: "Toner",
};
const SUPPLY_CLASS_LABELS = {
    supplyThatIsConsumed: "Consumable",
    supplyThatIsFilled: "Refillable supply",
};
const SUPPLY_UNIT_LABELS = {
    tenthsOfMilliliters: "milliliters (×0.1)",
    percent: "percent",
    pages: "pages",
};
function titleCaseWord(value) {
    const trimmed = value.trim();
    if (!trimmed)
        return "";
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}
function splitPrinterSupplyEntries(raw) {
    const trimmed = raw.trim();
    if (!trimmed)
        return [];
    return trimmed
        .split(/,(?=type=)/i)
        .map((entry) => entry.trim())
        .filter(Boolean);
}
function parseSupplyDescriptions(value) {
    if (!value)
        return [];
    const parts = Array.isArray(value) ? value : [value];
    return parts.flatMap((entry) => entry.split(",").map((item) => item.trim()).filter(Boolean));
}
function formatSupplyLevel(level, unit) {
    if (level === null || Number.isNaN(level))
        return "Unknown";
    if (level === -3)
        return "Not reported by printer";
    if (level === -2)
        return "Unknown";
    if (level === -1)
        return "Other";
    if (level === 0)
        return "Empty";
    if (unit === "tenthsOfMilliliters")
        return `${(level / 10).toFixed(1)} ml remaining`;
    if (unit === "percent")
        return `${level}% remaining`;
    if (unit === "pages")
        return `${level} pages remaining`;
    return `${level} remaining`;
}
function formatSupplyCapacity(maxCapacity, unit) {
    if (maxCapacity === null || Number.isNaN(maxCapacity))
        return "Unknown";
    if (maxCapacity <= -2)
        return "Not reported";
    if (maxCapacity === -1)
        return "Other";
    if (maxCapacity === 0)
        return "None";
    if (unit === "tenthsOfMilliliters")
        return `${(maxCapacity / 10).toFixed(1)} ml capacity`;
    if (unit === "percent")
        return `${maxCapacity}% scale`;
    if (unit === "pages")
        return `${maxCapacity} page capacity`;
    return String(maxCapacity);
}
function inferSupplyLevelHint(level) {
    if (level === -3)
        return "Printer did not report a numeric level (common when ink is present).";
    if (level === 0)
        return "Printer reports this supply is empty.";
    if (level != null && level > 0)
        return "Numeric level reported by the printer.";
    return "";
}
function parsePrinterSupplyEntry(entry, description) {
    const fields = {};
    for (const part of entry.split(";")) {
        const trimmed = part.trim();
        if (!trimmed)
            continue;
        const separator = trimmed.indexOf("=");
        if (separator === -1)
            continue;
        fields[trimmed.slice(0, separator).trim().toLowerCase()] = trimmed.slice(separator + 1).trim();
    }
    const type = fields.type ?? "unknown";
    const colorantName = fields.colorantname ?? null;
    const level = fields.level == null ? null : Number.parseInt(fields.level, 10);
    const maxCapacity = fields.maxcapacity == null ? null : Number.parseInt(fields.maxcapacity, 10);
    const unit = fields.unit ?? null;
    const supplyClass = fields.class ?? null;
    const typeLabel = SUPPLY_TYPE_LABELS[type] ?? type;
    const classLabel = supplyClass ? (SUPPLY_CLASS_LABELS[supplyClass] ?? supplyClass) : "Supply";
    const unitLabel = unit ? (SUPPLY_UNIT_LABELS[unit] ?? unit) : "units";
    const colorLabel = description?.trim() || (colorantName ? `${titleCaseWord(colorantName)} ink` : typeLabel);
    const levelStatus = formatSupplyLevel(level, unit);
    const capacityStatus = formatSupplyCapacity(maxCapacity, unit);
    const levelHint = inferSupplyLevelHint(level);
    const summary = `${colorLabel} — ${levelStatus}${levelHint ? ` (${levelHint})` : ""}`;
    return {
        type,
        type_label: typeLabel,
        colorant_name: colorantName,
        label: colorLabel,
        level,
        max_capacity: maxCapacity,
        unit,
        unit_label: unitLabel,
        class: supplyClass,
        class_label: classLabel,
        level_status: levelStatus,
        capacity_status: capacityStatus,
        summary,
    };
}
function parsePrinterSupplies(raw, descriptions) {
    const rawText = Array.isArray(raw) ? raw.join(",") : raw ?? "";
    const descriptionList = parseSupplyDescriptions(descriptions);
    return splitPrinterSupplyEntries(rawText).map((entry, index) => parsePrinterSupplyEntry(entry, descriptionList[index]));
}
async function probePrinterEndpoint(host, route) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
        const response = await fetch(`${printerBaseUrl(host)}${route}`, {
            signal: controller.signal,
            headers: { Accept: "text/html,application/xml,text/xml,*/*" },
        });
        return {
            route,
            ok: response.ok,
            status_code: response.status,
            latency_ms: Date.now() - started,
        };
    }
    catch (error) {
        return {
            route,
            ok: false,
            latency_ms: Date.now() - started,
            error: error instanceof Error ? error.message : String(error),
        };
    }
    finally {
        clearTimeout(timer);
    }
}
async function getIppDiagnostics(host) {
    if (!(0, node_fs_1.existsSync)(IPPTOOL_PATH)) {
        return {
            available: false,
            attributes: {},
            error: `ipptool was not found at ${IPPTOOL_PATH}`,
        };
    }
    if (!(0, node_fs_1.existsSync)(IPP_ATTRS_TEST_PATH)) {
        return {
            available: false,
            attributes: {},
            error: `IPP attributes test was not found at ${IPP_ATTRS_TEST_PATH}`,
        };
    }
    const result = await runCommand(IPPTOOL_PATH, ["-tv", "-d", `uri=${ippUri(host)}`, IPP_ATTRS_TEST_PATH], 20000);
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (result.code !== 0 && !output.includes("status-code = successful-ok")) {
        return {
            available: false,
            attributes: {},
            error: output || "ipptool get-printer-attributes failed",
        };
    }
    return {
        available: true,
        attributes: parseIppToolOutput(output),
    };
}
async function getLibraryDiagnostics() {
    const scans = await listScans();
    let totalBytes = 0;
    const sources = {};
    const formats = {};
    for (const record of scans) {
        sources[record.source] = (sources[record.source] ?? 0) + 1;
        formats[record.format] = (formats[record.format] ?? 0) + 1;
        const filePath = node_path_1.default.join(SCANS_DIR, record.filename);
        if ((0, node_fs_1.existsSync)(filePath)) {
            try {
                const fileStat = await (0, promises_1.stat)(filePath);
                totalBytes += fileStat.size;
            }
            catch {
                // ignore unreadable files
            }
        }
    }
    return {
        scan_count: scans.length,
        total_bytes: totalBytes,
        latest_scan_at: scans[0]?.created_at ?? null,
        sources,
        formats,
    };
}
async function getDiagnostics(settings) {
    const host = settings.printer_host;
    const generatedAt = new Date().toISOString();
    const printerErrors = [];
    const library = await getLibraryDiagnostics();
    const probes = await Promise.all([
        probePrinterEndpoint(host, "/home/status.html"),
        probePrinterEndpoint(host, "/home/monitor.html"),
        probePrinterEndpoint(host, "/eSCL/ScannerStatus"),
        probePrinterEndpoint(host, "/eSCL/ScannerCapabilities"),
    ]);
    const printerReachable = probes.some((probe) => probe.ok);
    let printer = null;
    let capabilities = null;
    let scannerStatusXml = null;
    let capabilitiesXml = null;
    let statusHtml = null;
    let monitorHtml = null;
    let statusPageMonitor = null;
    let pageYield = null;
    let statusPageModel = null;
    let esclCapabilities = null;
    let esclScanJobs = [];
    let scannerStatus = null;
    try {
        [statusHtml, monitorHtml, scannerStatusXml, capabilitiesXml] = await Promise.all([
            fetchPrinterText(host, "/home/status.html"),
            fetchPrinterText(host, "/home/monitor.html"),
            fetchPrinterText(host, "/eSCL/ScannerStatus"),
            fetchPrinterText(host, "/eSCL/ScannerCapabilities"),
        ]);
        statusPageMonitor = parseStatusPageMonitor(statusHtml);
        pageYield = parsePageYield(statusHtml);
        statusPageModel = parseStatusPageModel(statusHtml);
        esclCapabilities = parseEsclCapabilitiesExtended(capabilitiesXml);
        esclScanJobs = parseEsclScanJobs(scannerStatusXml);
        scannerStatus = await getScannerStatus(host);
        capabilities = await getScannerCapabilities(host);
        printer = await getPrinterStatus(host, settings);
    }
    catch (error) {
        printerErrors.push(error instanceof Error ? error.message : String(error));
    }
    let ipp = {
        available: false,
        attributes: {},
    };
    try {
        ipp = await getIppDiagnostics(host);
        if (!ipp.available && ipp.error) {
            printerErrors.push(ipp.error);
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ipp = { available: false, attributes: {}, error: message };
        printerErrors.push(message);
    }
    return {
        generated_at: generatedAt,
        app_version: APP_VERSION,
        app: {
            settings: {
                printer_host: settings.printer_host,
                printer_name: settings.printer_name,
                black_ink_reorder_configured: Boolean(settings.black_ink_reorder_url.trim()),
                color_ink_reorder_configured: Boolean(settings.color_ink_reorder_url.trim()),
            },
            runtime: {
                node_version: process.version,
                platform: process.platform,
                arch: process.arch,
                uptime_seconds: Math.round(process.uptime()),
                port: process.env.PORT ?? "3000",
                node_env: process.env.NODE_ENV ?? "development",
                data_root: DATA_ROOT,
                settings_file_exists: (0, node_fs_1.existsSync)(SETTINGS_PATH),
                scans_dir_exists: (0, node_fs_1.existsSync)(SCANS_DIR),
                ipptool_path: IPPTOOL_PATH,
                ipptool_available: (0, node_fs_1.existsSync)(IPPTOOL_PATH),
                pdftoppm_path: PDFTOPPM_PATH,
                pdftoppm_available: (0, node_fs_1.existsSync)(PDFTOPPM_PATH),
                ipp_attrs_test_path: IPP_ATTRS_TEST_PATH,
                ipp_attrs_test_available: (0, node_fs_1.existsSync)(IPP_ATTRS_TEST_PATH),
            },
            library,
        },
        printer: {
            host: settings.printer_host,
            reachable: printerReachable,
            endpoints: {
                http_base: printerBaseUrl(host),
                escl_base: esclBaseUrl(host),
                ipp_uri: ippUri(host),
            },
            probes,
            monitor: printer
                ? {
                    message: printer.device_status,
                    level: printer.device_status_level,
                    detail: printer.device_status_detail,
                }
                : statusPageMonitor,
            status: printer,
            status_page: {
                model: statusPageModel,
                monitor: statusPageMonitor,
                page_yield: pageYield,
            },
            ink: printer?.ink ?? null,
            alerts: printer?.alerts ?? [],
            scanner: scannerStatus,
            capabilities,
            escl: {
                capabilities: esclCapabilities,
                scan_jobs: esclScanJobs,
            },
            ipp: {
                available: ipp.available,
                error: ipp.error,
                printer_name: ippAttrValue(ipp.attributes, "printer-name"),
                printer_info: ippAttrValue(ipp.attributes, "printer-info"),
                make_and_model: ippAttrValue(ipp.attributes, "printer-make-and-model"),
                printer_state: ippAttrValue(ipp.attributes, "printer-state"),
                printer_state_reasons: ippAttrValue(ipp.attributes, "printer-state-reasons"),
                printer_state_message: ippAttrValue(ipp.attributes, "printer-state-message"),
                printer_up_time_seconds: ippAttrValue(ipp.attributes, "printer-up-time"),
                queued_job_count: ippAttrValue(ipp.attributes, "queued-job-count"),
                accepting_jobs: ippAttrValue(ipp.attributes, "printer-is-accepting-jobs"),
                pages_per_minute: ippAttrValue(ipp.attributes, "pages-per-minute"),
                pages_per_minute_color: ippAttrValue(ipp.attributes, "pages-per-minute-color"),
                media_ready: ippAttrValue(ipp.attributes, "media-ready"),
                media_default: ippAttrValue(ipp.attributes, "media-default"),
                alert_descriptions: ippAttrValue(ipp.attributes, "printer-alert-description"),
                supply_descriptions: ippAttrValue(ipp.attributes, "printer-supply-description"),
                supplies: ippAttrValue(ipp.attributes, "printer-supply"),
                supplies_parsed: parsePrinterSupplies(ipp.attributes["printer-supply"], ipp.attributes["printer-supply-description"]),
                device_id: ippAttrValue(ipp.attributes, "printer-device-id"),
                printer_uuid: ippAttrValue(ipp.attributes, "printer-uuid"),
                document_formats: ippAttrValue(ipp.attributes, "document-format-supported"),
                color_modes: ippAttrValue(ipp.attributes, "print-color-mode-supported"),
                sides_supported: ippAttrValue(ipp.attributes, "sides-supported"),
                media_supported: ippAttrValue(ipp.attributes, "media-supported"),
                attributes: ipp.attributes,
            },
            errors: printerErrors,
        },
    };
}
function buildScanSettingsXml(options, maxWidth, maxHeight) {
    const inputSource = options.source === "adf" ? "Feeder" : "Platen";
    return `<?xml version="1.0" encoding="UTF-8"?>
<scan:ScanSettings xmlns:scan="${ESCL_NS}" xmlns:pwg="${PWG_NS}">
  <pwg:Version>2.6</pwg:Version>
  <pwg:ScanRegions>
    <pwg:ScanRegion>
      <pwg:ContentRegionUnits>escl:ThreeHundredthsOfInches</pwg:ContentRegionUnits>
      <pwg:Width>${maxWidth}</pwg:Width>
      <pwg:Height>${maxHeight}</pwg:Height>
      <pwg:XOffset>0</pwg:XOffset>
      <pwg:YOffset>0</pwg:YOffset>
    </pwg:ScanRegion>
  </pwg:ScanRegions>
  <scan:InputSource>${inputSource}</scan:InputSource>
  <scan:ColorMode>${options.color_mode}</scan:ColorMode>
  <scan:XResolution>${options.resolution}</scan:XResolution>
  <scan:YResolution>${options.resolution}</scan:YResolution>
  <pwg:DocumentFormat>${options.format}</pwg:DocumentFormat>
</scan:ScanSettings>`;
}
function scanJobUrl(host, uri) {
    if (uri.startsWith("http"))
        return uri;
    return `${printerBaseUrl(host)}${uri.startsWith("/") ? uri : `/${uri}`}`;
}
async function waitForScannerIdle(host, timeoutMs = 30000, required = true) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const status = await getScannerStatus(host);
        if (status.state.toLowerCase() === "idle")
            return true;
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (required) {
        throw new Error("Scanner is busy. Wait a moment, then try again.");
    }
    return false;
}
async function deleteScanJob(host, jobUrl) {
    try {
        await fetch(jobUrl, { method: "DELETE" });
    }
    catch {
        // Ignore cleanup failures.
    }
}
async function cancelActiveScanJobs(host) {
    const xml = await fetchPrinterText(host, "/eSCL/ScannerStatus");
    const jobUris = [...new Set(xmlAllTagValues(xml, "JobUri"))];
    let canceled = 0;
    for (const uri of jobUris) {
        try {
            const response = await fetch(scanJobUrl(host, uri), { method: "DELETE" });
            if (response.ok)
                canceled += 1;
        }
        catch {
            // Ignore cleanup failures for stale jobs.
        }
    }
    if (canceled > 0) {
        await new Promise((resolve) => setTimeout(resolve, 750));
    }
    return canceled;
}
async function ensureScannerReady(host) {
    const status = await getScannerStatus(host);
    if (status.state.toLowerCase() === "idle")
        return;
    for (let attempt = 0; attempt < 4; attempt += 1) {
        await cancelActiveScanJobs(host);
        const idle = await waitForScannerIdle(host, 10000, false);
        if (idle)
            return;
    }
    throw new Error("Scanner is busy with an earlier scan job. Wait a few seconds and try again.");
}
async function fetchNextDocument(jobUrl, timeoutMs = 180000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(`${jobUrl}/NextDocument`, { signal: controller.signal });
    }
    finally {
        clearTimeout(timer);
    }
}
async function performScan(host, options) {
    const capabilities = await getScannerCapabilities(host);
    await ensureScannerReady(host);
    const status = await getScannerStatus(host);
    if (options.source === "adf" && status.adf_state.toLowerCase().includes("empty")) {
        throw new Error("ADF is empty. Load documents in the feeder or switch to the flatbed.");
    }
    if (!capabilities.formats.includes(options.format)) {
        throw new Error(`Scanner does not support format ${options.format}`);
    }
    const settingsXml = buildScanSettingsXml(options, capabilities.max_width, capabilities.max_height);
    const createResponse = await fetchEscl(host, "/ScanJobs", {
        method: "POST",
        headers: { "Content-Type": "text/xml; charset=utf-8" },
        body: settingsXml,
    });
    if (createResponse.status !== 201 && createResponse.status !== 200) {
        const body = await createResponse.text();
        throw new Error(`Failed to create scan job (HTTP ${createResponse.status}): ${body.slice(0, 200)}`);
    }
    let jobUrl = createResponse.headers.get("Location") ?? createResponse.headers.get("location");
    if (!jobUrl) {
        throw new Error("Failed to create scan job: printer did not return a job location.");
    }
    if (!jobUrl.startsWith("http")) {
        jobUrl = `${esclBaseUrl(host)}${jobUrl.startsWith("/") ? "" : "/"}${jobUrl}`;
    }
    const buffers = [];
    let contentType = options.format;
    const maxPages = options.source === "platen" ? 1 : 50;
    for (let page = 0; page < maxPages; page += 1) {
        let docResponse;
        try {
            docResponse = await fetchNextDocument(jobUrl);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes("abort")) {
                throw new Error("Scan timed out. Make sure the document is on the flatbed and try again.");
            }
            throw error;
        }
        if (docResponse.status === 404 || docResponse.status === 410)
            break;
        if (!docResponse.ok) {
            const text = await docResponse.text();
            if (page === 0) {
                throw new Error(`Failed to fetch scanned document (HTTP ${docResponse.status}): ${text.slice(0, 200)}`);
            }
            break;
        }
        const type = docResponse.headers.get("Content-Type");
        if (type)
            contentType = type.split(";")[0].trim();
        buffers.push(Buffer.from(await docResponse.arrayBuffer()));
        if (options.source === "platen")
            break;
    }
    if (buffers.length === 0) {
        await deleteScanJob(host, jobUrl);
        throw new Error("No scanned pages were returned by the printer.");
    }
    await deleteScanJob(host, jobUrl);
    await cancelActiveScanJobs(host);
    await waitForScannerIdle(host, 15000, false);
    return { buffers, contentType };
}
function extensionForContentType(contentType) {
    if (contentType.includes("pdf"))
        return ".pdf";
    if (contentType.includes("png"))
        return ".png";
    if (contentType.includes("jpeg") || contentType.includes("jpg"))
        return ".jpg";
    return ".bin";
}
async function saveScan(buffers, contentType, options) {
    const id = (0, node_crypto_1.randomUUID)();
    const ext = extensionForContentType(contentType);
    const filename = `${id}${buffers.length > 1 ? "-multipage" : ""}${ext}`;
    const filePath = node_path_1.default.join(SCANS_DIR, filename);
    const merged = buffers.length === 1 ? buffers[0] : Buffer.concat(buffers);
    await (0, promises_1.writeFile)(filePath, merged);
    const createdAt = new Date().toISOString();
    const record = {
        id,
        filename,
        display_name: `Scan ${new Date(createdAt).toLocaleString()}`,
        content_type: contentType,
        source: options.source,
        color_mode: options.color_mode,
        resolution: options.resolution,
        format: options.format,
        page_count: buffers.length,
        created_at: createdAt,
    };
    await (0, promises_1.writeFile)(node_path_1.default.join(SCANS_DIR, `${id}.json`), JSON.stringify(record, null, 2));
    return record;
}
async function listScans() {
    if (!(0, node_fs_1.existsSync)(SCANS_DIR))
        return [];
    const files = await (0, promises_1.readdir)(SCANS_DIR);
    const records = [];
    for (const file of files) {
        if (!file.endsWith(".json"))
            continue;
        try {
            const raw = await (0, promises_1.readFile)(node_path_1.default.join(SCANS_DIR, file), "utf8");
            records.push(JSON.parse(raw));
        }
        catch {
            // ignore invalid metadata
        }
    }
    return records
        .map((record) => normalizeScanRecord(record))
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
}
async function getScanRecord(id) {
    const metaPath = node_path_1.default.join(SCANS_DIR, `${id}.json`);
    if (!(0, node_fs_1.existsSync)(metaPath))
        return null;
    const raw = await (0, promises_1.readFile)(metaPath, "utf8");
    return normalizeScanRecord(JSON.parse(raw));
}
async function renameScan(id, displayName) {
    const record = await getScanRecord(id);
    if (!record)
        return null;
    const trimmed = displayName.trim();
    if (!trimmed) {
        throw new Error("Name cannot be empty.");
    }
    if (trimmed.length > 120) {
        throw new Error("Name is too long.");
    }
    if (/[\\/<>:"|?*]/.test(trimmed)) {
        throw new Error("Name contains invalid characters.");
    }
    const updated = { ...record, display_name: trimmed };
    await (0, promises_1.writeFile)(node_path_1.default.join(SCANS_DIR, `${id}.json`), JSON.stringify(updated, null, 2));
    return updated;
}
async function deleteScan(id) {
    const record = await getScanRecord(id);
    if (!record)
        return false;
    await (0, promises_1.rm)(node_path_1.default.join(SCANS_DIR, record.filename), { force: true });
    await (0, promises_1.rm)(node_path_1.default.join(SCANS_DIR, `${id}.json`), { force: true });
    return true;
}
function runCommand(command, args, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
        const child = (0, node_child_process_1.spawn)(command, args);
        let stdout = "";
        let stderr = "";
        let settled = false;
        const timer = setTimeout(() => {
            if (settled)
                return;
            child.kill("SIGTERM");
            settled = true;
            reject(new Error(`Command timed out: ${command} ${args.join(" ")}`));
        }, timeoutMs);
        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });
        child.on("error", (error) => {
            if (settled)
                return;
            clearTimeout(timer);
            settled = true;
            if (error.code === "ENOENT") {
                reject(new Error(`Command not found: ${command}`));
                return;
            }
            reject(error);
        });
        child.on("close", (code) => {
            if (settled)
                return;
            clearTimeout(timer);
            settled = true;
            resolve({ stdout, stderr, code: code ?? 1 });
        });
    });
}
function sortPagePaths(paths) {
    return [...paths].sort((left, right) => {
        const leftMatch = left.match(/-(\d+)\.[^.]+$/);
        const rightMatch = right.match(/-(\d+)\.[^.]+$/);
        const leftNum = Number.parseInt(leftMatch?.[1] ?? "0", 10);
        const rightNum = Number.parseInt(rightMatch?.[1] ?? "0", 10);
        return leftNum - rightNum;
    });
}
async function convertImageToJpeg(inputPath, outputPath) {
    for (const command of ["magick", "convert"]) {
        const result = await runCommand(command, [inputPath, "-quality", "90", outputPath]);
        if (result.code === 0)
            return;
    }
    throw new Error("Failed to convert image to JPEG for printing.");
}
async function preparePrintPages(filePath) {
    const ext = node_path_1.default.extname(filePath).toLowerCase();
    const cleanup = [];
    if (ext === ".pdf") {
        if (!(0, node_fs_1.existsSync)(PDFTOPPM_PATH)) {
            throw new Error(`pdftoppm was not found at ${PDFTOPPM_PATH}. Reinstall the app so the container can install poppler-utils.`);
        }
        const prefix = node_path_1.default.join(DATA_ROOT, `print-page-${(0, node_crypto_1.randomUUID)()}`);
        const result = await runCommand(PDFTOPPM_PATH, ["-jpeg", "-r", "300", filePath, prefix], 180000);
        if (result.code !== 0) {
            throw new Error(result.stderr.trim() || result.stdout.trim() || "Failed to convert PDF to images for printing.");
        }
        const base = node_path_1.default.basename(prefix);
        const dir = node_path_1.default.dirname(prefix);
        const pages = sortPagePaths((await (0, promises_1.readdir)(dir))
            .filter((name) => name.startsWith(`${base}-`) && name.endsWith(".jpg"))
            .map((name) => node_path_1.default.join(dir, name)));
        if (pages.length === 0) {
            throw new Error("The PDF did not produce any printable pages.");
        }
        cleanup.push(...pages);
        return { pages, cleanup };
    }
    if (ext === ".png" || ext === ".webp" || ext === ".gif") {
        const outputPath = node_path_1.default.join(DATA_ROOT, `print-img-${(0, node_crypto_1.randomUUID)()}.jpg`);
        await convertImageToJpeg(filePath, outputPath);
        cleanup.push(outputPath);
        return { pages: [outputPath], cleanup };
    }
    if (ext === ".jpg" || ext === ".jpeg") {
        return { pages: [filePath], cleanup: [] };
    }
    throw new Error("Unsupported file type. Upload a PDF, JPEG, or PNG.");
}
function formatPrintError(result) {
    const output = `${result.stderr}\n${result.stdout}`.trim();
    if (output.includes("document-format-not-supported")) {
        return "The printer does not support this file format. Try PDF, JPEG, or PNG.";
    }
    if (output.includes("client-error")) {
        return output.split("\n").find((line) => line.includes("client-error")) ?? output;
    }
    return output || "Print command failed";
}
async function ensurePrintTools() {
    if (!(0, node_fs_1.existsSync)(IPPTOOL_PATH)) {
        throw new Error(`ipptool was not found at ${IPPTOOL_PATH}. Reinstall the app so the container can install the ipptool package.`);
    }
    if (!(0, node_fs_1.existsSync)(PRINT_JOB_TEST_PATH)) {
        throw new Error("Print job template is missing from the app bundle.");
    }
}
async function getPrintWarnings(host, options, settings) {
    const warnings = [];
    try {
        const printer = await getPrinterStatus(host, settings);
        const blackCartridge = printer.ink.cartridges.find((level) => level.color === "Black");
        if (options.color === "monochrome" && blackCartridge && (blackCartridge.percent === 0 || blackCartridge.low)) {
            warnings.push("Black ink is low or empty. Monochrome jobs may not print until the black cartridge is replaced.");
        }
        if (printer.device_status_level === "warning" || printer.device_status_level === "error") {
            warnings.push(printer.device_status_detail);
        }
    }
    catch {
        // Ignore status lookup failures and still attempt printing.
    }
    return warnings;
}
async function sendIppPrintJob(host, filePath, options) {
    const copies = String(Math.max(1, Math.min(999, options.copies)));
    const result = await runCommand(IPPTOOL_PATH, [
        "-T",
        "60",
        "-f",
        filePath,
        "-d",
        `uri=${ippUri(host)}`,
        "-d",
        "user=wolverineks",
        "-d",
        `filename=${filePath}`,
        "-d",
        "filetype=image/jpeg",
        "-d",
        `copies=${copies}`,
        "-d",
        `color_mode=${options.color}`,
        "-d",
        `sides=${options.sides}`,
        "-d",
        `media=${options.media}`,
        PRINT_JOB_TEST_PATH,
    ]);
    if (result.code !== 0) {
        throw new Error(formatPrintError(result));
    }
}
async function printFile(host, filePath, options, settings) {
    await ensurePrintTools();
    const warnings = await getPrintWarnings(host, options, settings);
    const prepared = await preparePrintPages(filePath);
    const cleanup = [...prepared.cleanup];
    try {
        for (const pagePath of prepared.pages) {
            await sendIppPrintJob(host, pagePath, options);
        }
        const pageLabel = prepared.pages.length === 1 ? "page" : "pages";
        return {
            message: `Sent ${prepared.pages.length} ${pageLabel} to the printer.`,
            warnings,
            pages_printed: prepared.pages.length,
        };
    }
    finally {
        await Promise.all(cleanup.map((filePath) => (0, promises_1.rm)(filePath, { force: true })));
    }
}
function parseMultipart(contentType, body) {
    const match = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/);
    if (!match)
        throw new Error("Missing multipart boundary");
    const boundary = Buffer.from(`--${match[1] ?? match[2]}`);
    const fields = {};
    let fileName = null;
    let fileData = null;
    const parts = body.toString("binary").split(boundary.toString("binary"));
    for (const part of parts) {
        if (!part || part === "--\r\n" || part === "--")
            continue;
        const trimmed = part.replace(/^\r\n/, "").replace(/\r\n$/, "");
        const separator = trimmed.indexOf("\r\n\r\n");
        if (separator === -1)
            continue;
        const headers = trimmed.slice(0, separator);
        const content = trimmed.slice(separator + 4).replace(/\r\n$/, "");
        const nameMatch = headers.match(/name="([^"]+)"/i);
        const fileMatch = headers.match(/filename="([^"]*)"/i);
        if (!nameMatch)
            continue;
        const name = nameMatch[1];
        if (fileMatch) {
            fileName = fileMatch[1] || "upload.bin";
            fileData = Buffer.from(content, "binary");
        }
        else {
            fields[name] = content;
        }
    }
    return { fields, fileName, fileData };
}
const API_CATALOG = {
    app_rest: [
        {
            method: "GET",
            path: "/api/status",
            description: "Printer, scanner, and ink snapshot for the dashboard.",
        },
        {
            method: "GET",
            path: "/api/diagnostics",
            description: "Diagnostics split into app (runtime, library) and printer (ink, eSCL, IPP) sections.",
        },
        {
            method: "GET",
            path: "/api/explorer",
            description: "API catalog and response schemas split into app and printer sections.",
        },
        {
            method: "GET",
            path: "/api/settings",
            description: "Saved app settings including printer host and ink reorder links.",
        },
        {
            method: "PUT",
            path: "/api/settings",
            body: '{ "printer_host", "printer_name", "black_ink_reorder_url", "color_ink_reorder_url" }',
            description: "Update app settings.",
        },
        {
            method: "GET",
            path: "/api/scans",
            description: "List saved scans in the library.",
        },
        {
            method: "GET",
            path: "/api/scans/:id/file",
            description: "Download a saved scan file.",
        },
        {
            method: "PATCH",
            path: "/api/scans/:id",
            body: '{ "display_name": "My scan" }',
            description: "Rename a saved scan.",
        },
        {
            method: "DELETE",
            path: "/api/scans/:id",
            description: "Delete a saved scan and its file.",
        },
        {
            method: "POST",
            path: "/api/scan",
            body: '{ "source": "platen|adf", "color_mode": "RGB24", "resolution": 300, "format": "image/jpeg" }',
            description: "Scan from the platen or ADF and save to the library.",
        },
        {
            method: "POST",
            path: "/api/print",
            body: "multipart/form-data: file, copies, sides, color, media",
            description: "Print an uploaded PDF, JPEG, or PNG via IPP.",
        },
        {
            method: "POST",
            path: "/api/copy",
            body: '{ "source", "color_mode", "copies", "sides" }',
            description: "Scan then print in one step.",
        },
    ],
    printer_http: [
        {
            method: "GET",
            path: "http://{printer_host}/home/status.html",
            description: "Brother web status page with ink levels and page yield.",
        },
        {
            method: "GET",
            path: "http://{printer_host}/home/monitor.html",
            description: "Compact device status message used by the dashboard.",
        },
        {
            method: "GET",
            path: "http://{printer_host}/eSCL/ScannerStatus",
            description: "eSCL scanner state, ADF state, and recent scan jobs.",
        },
        {
            method: "GET",
            path: "http://{printer_host}/eSCL/ScannerCapabilities",
            description: "eSCL scanner capabilities, resolutions, and supported formats.",
        },
        {
            method: "IPP",
            path: "ipp://{printer_host}/ipp/print",
            description: "IPP print queue used by ipptool for print jobs and attributes.",
        },
    ],
};
const API_RESPONSE_SCHEMAS = {
    "GET /api/status": {
        settings: {
            printer_host: "string — printer IP or hostname",
            printer_name: "string — display name",
            black_ink_reorder_url: "string — Amazon or custom reorder URL",
            color_ink_reorder_url: "string — Amazon or custom reorder URL",
        },
        scanner: {
            state: "string — eSCL State (e.g. Idle, Processing)",
            adf_state: "string — eSCL AdfState (e.g. ScannerAdfLoaded)",
            adf_state_label: "string — human-readable ADF state",
            version: "string|null — eSCL protocol version",
            stale_scan_jobs: "number — recent eSCL scan jobs listed on the device",
        },
        capabilities: {
            make_and_model: "string",
            serial_number: "string|null",
            has_adf: "boolean",
            max_width: "number — scan area width in 1/300 inch units",
            max_height: "number — scan area height in 1/300 inch units",
            resolutions: "number[] — supported DPI values",
            formats: "string[] — e.g. application/pdf, image/jpeg",
            color_modes: "string[] — e.g. RGB24, Grayscale8, BlackAndWhite1",
            feeder_capacity: "number — ADF sheet capacity",
        },
        printer: {
            device_status: "string — raw monitor message (e.g. Ready, Replace Ink (BK))",
            device_status_level: "ready|warning|busy|error|unknown",
            device_status_detail: "string — expanded human-readable status",
            alerts: [
                {
                    severity: "success|info|warning|error",
                    title: "string",
                    message: "string",
                    reorder_url: "string|optional — present on ink alerts when configured",
                },
            ],
            ink: {
                cartridges: [
                    {
                        color: "Magenta|Cyan|Yellow|Black",
                        percent: "number 0-100",
                        low: "boolean",
                    },
                ],
                reservoir: [
                    {
                        color: "Magenta|Cyan|Yellow|Black",
                        percent: "number 0-100",
                        low: "boolean",
                    },
                ],
            },
            page_yield: {
                magenta: "string — approx. ISO pages remaining",
                cyan: "string",
                yellow: "string",
                black: "string",
            },
        },
        ipp: {
            available: "boolean",
            error: "string|optional",
            media_ready: "string|null — loaded paper size keyword",
            media_default: "string|null",
            media_supported: "string[]",
            sides_supported: "string[]",
            color_modes_supported: "string[]",
            queued_job_count: "number|null",
            accepting_jobs: "boolean|null",
            printer_state: "string|null — idle|processing|stopped",
            alert_descriptions: "string[]",
            sleep_or_warmup: "boolean",
        },
        error: "string — present on HTTP 502 when the printer cannot be reached",
    },
    "GET /api/diagnostics": {
        generated_at: "string — ISO timestamp",
        app_version: "string",
        app: {
            settings: {
                printer_host: "string — configured target, not live printer data",
                printer_name: "string",
                black_ink_reorder_configured: "boolean",
                color_ink_reorder_configured: "boolean",
            },
            runtime: {
                node_version: "string",
                platform: "string",
                arch: "string",
                uptime_seconds: "number",
                port: "string",
                node_env: "string",
                data_root: "string",
                settings_file_exists: "boolean",
                scans_dir_exists: "boolean",
                ipptool_path: "string",
                ipptool_available: "boolean",
                pdftoppm_path: "string",
                pdftoppm_available: "boolean",
                ipp_attrs_test_path: "string",
                ipp_attrs_test_available: "boolean",
            },
            library: {
                scan_count: "number",
                total_bytes: "number",
                latest_scan_at: "string|null — ISO timestamp",
                sources: "Record<string, number>",
                formats: "Record<string, number>",
            },
        },
        printer: {
            host: "string",
            reachable: "boolean",
            endpoints: {
                http_base: "string",
                escl_base: "string",
                ipp_uri: "string",
            },
            probes: "EndpointProbe[] — live HTTP/eSCL probes to the Brother device",
            monitor: "{ message, level, detail }",
            status_page: "{ model, monitor, page_yield }",
            ink: "{ cartridges, reservoir }",
            alerts: "StatusAlert[]",
            scanner: "eSCL scanner status summary",
            capabilities: "parsed ScannerCapabilities summary",
            escl: "{ capabilities, scan_jobs }",
            ipp: "parsed IPP get-printer-attributes summary + attributes map",
            errors: "string[] — printer fetch/IPP errors",
        },
    },
    "GET /api/scans": {
        scans: [
            {
                id: "string — UUID",
                filename: "string",
                display_name: "string",
                content_type: "string",
                source: "platen|adf",
                color_mode: "string",
                resolution: "number",
                format: "string",
                page_count: "number",
                created_at: "string — ISO timestamp",
            },
        ],
    },
    "GET /api/settings": {
        printer_host: "string",
        printer_name: "string",
        black_ink_reorder_url: "string",
        color_ink_reorder_url: "string",
    },
    "GET /api/explorer": {
        fetched_at: "string — ISO timestamp",
        app_version: "string",
        app: {
            catalog: "API_CATALOG.app_rest",
            response_schemas: "app endpoint schemas",
            settings: "configured app settings summary",
            runtime: "Node/container runtime",
        },
        printer: {
            catalog: "API_CATALOG.printer_http",
            response_schemas: "Brother device API schemas",
            endpoints: "{ http_base, escl_base, ipp_uri }",
        },
    },
    "POST /api/scan": {
        record: "ScanRecord — saved library entry",
        preview_url: "string|optional — /api/scans/:id/file for image scans",
        error: "string — on failure",
    },
    "POST /api/print": {
        message: "string",
        warnings: "string[]",
        pages_printed: "number",
        error: "string — on failure",
    },
    "POST /api/copy": {
        message: "string",
        warnings: "string[]",
        pages_printed: "number",
        record: "ScanRecord",
        error: "string — on failure",
    },
    "Brother GET /home/monitor.html (parsed)": {
        message: "string — span.moni text (e.g. Ready, Replace Ink (BK), Ink Low (BK))",
        level: "ready|warning|busy|error|unknown — from moniReady/moniWarning/moniBusy/moniError class",
    },
    "Brother GET /home/status.html (parsed)": {
        ink_cartridges: "InkLevel[] — from #inkLevel tonerremain heights (order: M, C, Y, BK)",
        ink_reservoir: "InkLevel[] — from #internalInkLevel",
        page_yield: "{ magenta, cyan, yellow, black } — from #possiblePrintNum",
        status_monitor: "{ message, level } — from embedded #moni_data span",
        model: "string — from <title>",
    },
    "Brother GET /eSCL/ScannerStatus (XML)": {
        "pwg:Version": "string — e.g. 2.93",
        "pwg:State": "string — scanner state",
        "scan:AdfState": "string — ADF paper state",
        "scan:Jobs/scan:JobInfo[]": {
            "pwg:JobUri": "string",
            "pwg:JobUuid": "string — urn:uuid:…",
            "scan:Age": "number — milliseconds",
            "pwg:ImagesCompleted": "number",
            "pwg:ImagesToTransfer": "number",
            "pwg:JobState": "string",
            "pwg:JobStateReasons/pwg:JobStateReason": "string",
        },
    },
    "Brother GET /eSCL/ScannerCapabilities (XML)": {
        "pwg:Version": "string",
        "pwg:MakeAndModel": "string",
        "pwg:SerialNumber": "string",
        "scan:Manufacturer": "string",
        "scan:UUID": "string",
        "scan:AdminURI": "string",
        "scan:IconURI": "string",
        "scan:Certifications/scan:Certification": { "scan:Name": "string", "scan:Version": "string" },
        "scan:Platen/scan:PlatenInputCaps": {
            "scan:MinWidth": "number",
            "scan:MaxWidth": "number",
            "scan:MaxHeight": "number",
            "scan:MaxOpticalXResolution": "number",
            "scan:MaxOpticalYResolution": "number",
            "scan:ColorModes/scan:ColorMode": "string[]",
            "pwg:DocumentFormat": "string[]",
        },
        "scan:Adf/scan:AdfSimplexInputCaps": "same shape as platen with taller MaxHeight",
        "scan:FeederCapacity": "number",
        "scan:AdfOptions/scan:AdfOption": "string[]",
    },
    "Brother IPP get-printer-attributes": {
        "printer-name": "string — Bonjour-style name",
        "printer-info": "string — model description",
        "printer-make-and-model": "string",
        "printer-state": "idle|processing|stopped",
        "printer-state-reasons": "keyword — e.g. marker-supply-empty-error",
        "printer-state-message": "string",
        "printer-up-time": "integer — seconds",
        "printer-is-accepting-jobs": "boolean",
        "queued-job-count": "integer",
        "pages-per-minute": "integer",
        "pages-per-minute-color": "integer",
        "printer-alert-description": "text[] — e.g. Replace Ink (BK)",
        "printer-supply": "octetString[] — ink cartridge levels encoded per PWG supply",
        "printer-supply-description": "text[] — Magenta/Cyan/Yellow/Black Ink Cartridge",
        supplies_parsed: [
            {
                label: "string — e.g. Magenta Ink Cartridge",
                type_label: "string — e.g. Ink cartridge",
                level_status: "string — e.g. Not reported by printer, Empty, 42% remaining",
                capacity_status: "string",
                class_label: "string — e.g. Consumable",
                summary: "string — human-readable one-liner",
            },
        ],
        "media-ready": "keyword — loaded paper size",
        "media-supported": "keyword[] — supported paper sizes",
        "print-color-mode-supported": "keyword[] — color, monochrome, auto",
        "sides-supported": "keyword[] — one-sided, two-sided-long-edge, two-sided-short-edge",
        "document-format-supported": "mimeMediaType[]",
        "printer-device-id": "text — MFG:Brother;MDL:MFC-J1360DW;…",
        "printer-uuid": "uri — urn:uuid:…",
        note: "Full attribute list returned in diagnostics → ipp.attributes",
    },
};
function renderResponseSchemaPanels(names) {
    return names
        .filter((name) => name in API_RESPONSE_SCHEMAS)
        .map((name) => `<details class="json-panel"><summary>${escapeHtml(name)}</summary><pre>${escapeHtml(JSON.stringify(API_RESPONSE_SCHEMAS[name], null, 2))}</pre></details>`)
        .join("");
}
function renderApiCatalogTable(rows, columns) {
    const header = columns.map((col) => "<th>" + escapeHtml(col.label) + "</th>").join("");
    const body = rows
        .map((row) => {
        const cells = columns
            .map((col) => "<td>" + escapeHtml(row[col.key] == null ? "—" : String(row[col.key])) + "</td>")
            .join("");
        return "<tr>" + cells + "</tr>";
    })
        .join("");
    return '<table class="api-table"><thead><tr>' + header + "</tr></thead><tbody>" + body + "</tbody></table>";
}
function buildExplorerPayload(settings) {
    const appSchemaNames = Object.keys(API_RESPONSE_SCHEMAS).filter((name) => /^[A-Z]+ /.test(name));
    const printerSchemaNames = Object.keys(API_RESPONSE_SCHEMAS).filter((name) => name.startsWith("Brother "));
    return {
        fetched_at: new Date().toISOString(),
        app_version: APP_VERSION,
        app: {
            catalog: API_CATALOG.app_rest,
            response_schemas: Object.fromEntries(appSchemaNames.map((name) => [name, API_RESPONSE_SCHEMAS[name]])),
            settings: {
                printer_host: settings.printer_host,
                printer_name: settings.printer_name,
                black_ink_reorder_configured: Boolean(settings.black_ink_reorder_url.trim()),
                color_ink_reorder_configured: Boolean(settings.color_ink_reorder_url.trim()),
            },
            runtime: {
                node_version: process.version,
                platform: process.platform,
                arch: process.arch,
                uptime_seconds: Math.round(process.uptime()),
                port: process.env.PORT ?? "3000",
                node_env: process.env.NODE_ENV ?? "development",
                data_root: DATA_ROOT,
                ipptool_available: (0, node_fs_1.existsSync)(IPPTOOL_PATH),
                pdftoppm_available: (0, node_fs_1.existsSync)(PDFTOPPM_PATH),
            },
        },
        printer: {
            catalog: API_CATALOG.printer_http,
            response_schemas: Object.fromEntries(printerSchemaNames.map((name) => [name, API_RESPONSE_SCHEMAS[name]])),
            endpoints: {
                http_base: printerBaseUrl(settings.printer_host),
                escl_base: esclBaseUrl(settings.printer_host),
                ipp_uri: ippUri(settings.printer_host),
            },
        },
    };
}
function renderPage(active, content) {
    const nav = [
        { id: "dashboard", label: "Dashboard", href: "/" },
        { id: "scan", label: "Scan", href: "/scan" },
        { id: "print", label: "Print", href: "/print" },
        { id: "copy", label: "Copy", href: "/copy" },
        { id: "library", label: "Library", href: "/library" },
        { id: "diagnostics", label: "Diagnostics", href: "/diagnostics" },
        { id: "api", label: "API Explorer", href: "/api" },
        { id: "settings", label: "Settings", href: "/settings" },
    ];
    const navHtml = nav
        .map((item) => `<a class="nav-link${item.id === active ? " active" : ""}" href="${item.href}">${escapeHtml(item.label)}</a>`)
        .join("");
    const activeLabel = nav.find((item) => item.id === active)?.label ?? "Brother Print & Scan";
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Brother Print &amp; Scan</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f8fafc;
      --panel: #ffffff;
      --text: #0f172a;
      --muted: #64748b;
      --border: #e2e8f0;
      --accent: #0b5cab;
      --accent-soft: #dbeafe;
      --danger: #dc2626;
      --success: #16a34a;
      --shadow: 0 10px 30px rgba(15, 23, 42, 0.08);
    }
    html[data-theme="dark"] {
      color-scheme: dark;
      --bg: #0b1220;
      --panel: #111827;
      --text: #e5e7eb;
      --muted: #94a3b8;
      --border: #1f2937;
      --accent: #60a5fa;
      --accent-soft: #1e3a5f;
      --shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    .layout {
      display: grid;
      grid-template-columns: 240px 1fr;
      min-height: 100vh;
    }
    .sidebar {
      background: var(--panel);
      border-right: 1px solid var(--border);
      padding: 1.5rem 1rem;
      position: sticky;
      top: 0;
      height: 100vh;
    }
    .brand {
      display: flex;
      gap: 0.75rem;
      align-items: center;
      margin-bottom: 1.5rem;
      padding: 0 0.5rem;
    }
    .brand img { width: 40px; height: 40px; border-radius: 10px; }
    .brand h1 { font-size: 1rem; margin: 0; }
    .brand p { margin: 0.15rem 0 0; color: var(--muted); font-size: 0.8rem; }
    .nav-link {
      display: block;
      padding: 0.7rem 0.85rem;
      border-radius: 0.75rem;
      color: var(--text);
      text-decoration: none;
      margin-bottom: 0.25rem;
    }
    .nav-link:hover, .nav-link.active {
      background: var(--accent-soft);
      color: var(--accent);
    }
    .sidebar-supplies {
      margin: 0 0.5rem 1rem;
      padding-top: 0.25rem;
      border-top: 1px solid var(--border);
    }
    .sidebar-supplies-label {
      margin: 0 0 0.35rem 0.35rem;
      color: var(--muted);
      font-size: 0.72rem;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .supplies-link {
      display: block;
      padding: 0.55rem 0.75rem;
      border-radius: 0.65rem;
      color: var(--accent);
      text-decoration: none;
      font-size: 0.88rem;
      margin-bottom: 0.15rem;
    }
    .supplies-link:hover {
      background: var(--accent-soft);
    }
    .ink-reorder-link {
      font-size: 0.8rem;
      font-weight: 600;
      margin-left: 0.35rem;
      white-space: nowrap;
    }
    .sidebar-footer {
      position: absolute;
      left: 1rem;
      right: 1rem;
      bottom: 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .sidebar-footer-actions {
      display: flex;
      gap: 0.5rem;
    }
    .app-version {
      font-size: 0.7rem;
      color: var(--muted);
      text-align: center;
      opacity: 0.7;
    }
    .main { padding: 1.5rem; }
    .mobile-header,
    .sidebar-backdrop {
      display: none;
    }
    .menu-toggle {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--border);
      background: var(--panel);
      border-radius: 0.65rem;
      padding: 0.45rem 0.55rem;
      cursor: pointer;
      color: var(--text);
      flex-shrink: 0;
    }
    .menu-toggle .icon {
      width: 1.25rem;
      height: 1.25rem;
    }
    .mobile-header-title {
      margin: 0;
      font-size: 1rem;
      font-weight: 700;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
      flex: 1;
    }
    .toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
      margin-bottom: 1.25rem;
    }
    .toolbar h2 { margin: 0; font-size: 1.5rem; }
    .toolbar-actions {
      justify-content: flex-end;
    }
    .grid {
      display: grid;
      gap: 1rem;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    }
    .diagnostics-grid {
      display: grid;
      gap: 1rem;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    }
    .diagnostics-card h3 {
      margin: 0 0 0.75rem;
      font-size: 1rem;
    }
    .diagnostics-section {
      margin-top: 0.85rem;
      padding-top: 0.85rem;
      border-top: 1px solid var(--border);
    }
    .diagnostics-section:first-of-type {
      margin-top: 0;
      padding-top: 0;
      border-top: none;
    }
    .diagnostics-section h4 {
      margin: 0 0 0.5rem;
      font-size: 0.92rem;
    }
    .diagnostics-card-panel > summary {
      cursor: pointer;
      list-style: none;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
    }
    .diagnostics-card-panel > summary::-webkit-details-marker { display: none; }
    .diagnostics-card-panel > summary::before {
      content: "▸";
      color: var(--muted);
      font-size: 0.85rem;
      flex-shrink: 0;
    }
    .diagnostics-card-panel[open] > summary::before { content: "▾"; }
    .diagnostics-card-summary h3 {
      margin: 0;
      font-size: 1rem;
      flex: 1;
    }
    .diagnostics-card-hint {
      font-size: 0.82rem;
      text-align: right;
    }
    .diagnostics-card-body {
      margin-top: 0.75rem;
      padding-top: 0.75rem;
      border-top: 1px solid var(--border);
    }
    .diagnostics-panel {
      margin-top: 0.85rem;
      padding-top: 0.85rem;
      border-top: 1px solid var(--border);
    }
    .diagnostics-panel > summary {
      cursor: pointer;
      list-style: none;
      font-weight: 600;
      font-size: 0.92rem;
      display: flex;
      align-items: center;
      gap: 0.45rem;
    }
    .diagnostics-panel > summary::-webkit-details-marker { display: none; }
    .diagnostics-panel > summary::before {
      content: "▸";
      color: var(--muted);
      font-size: 0.78rem;
    }
    .diagnostics-panel[open] > summary::before { content: "▾"; }
    .diagnostics-panel-body {
      padding-top: 0.45rem;
    }
    .stat-row {
      display: flex;
      justify-content: space-between;
      gap: 1rem;
      padding: 0.35rem 0;
      font-size: 0.9rem;
    }
    .stat-row span:last-child {
      text-align: right;
      word-break: break-word;
      max-width: 62%;
    }
    .tile-refresh {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--border);
      background: var(--panel);
      border-radius: 0.65rem;
      padding: 0.45rem 0.55rem;
      cursor: pointer;
      color: var(--text);
    }
    .tile-refresh .icon {
      width: 1.1rem;
      height: 1.1rem;
    }
    .tile-refresh.spinning .icon {
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .api-toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 0.65rem;
      align-items: center;
      margin-bottom: 1rem;
    }
    .api-toolbar .muted { flex: 1; min-width: 12rem; }
    .api-section { margin-top: 1.25rem; }
    .api-section h2 {
      font-size: 1.05rem;
      margin: 0 0 0.75rem;
    }
    .api-section h3 {
      font-size: 0.92rem;
      margin: 1rem 0 0.5rem;
      color: var(--muted);
    }
    .api-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.82rem;
    }
    .api-table th,
    .api-table td {
      border: 1px solid var(--border);
      padding: 0.55rem 0.65rem;
      text-align: left;
      vertical-align: top;
    }
    .api-table th {
      background: var(--bg);
      color: var(--muted);
      font-weight: 700;
    }
    .json-panel {
      margin-top: 0.5rem;
    }
    .json-panel summary {
      cursor: pointer;
      font-weight: 600;
      font-size: 0.88rem;
      padding: 0.45rem 0;
    }
    .json-panel pre {
      margin: 0.35rem 0 0;
      padding: 0.85rem;
      border-radius: 0.75rem;
      border: 1px solid var(--border);
      background: var(--bg);
      overflow: auto;
      max-height: 28rem;
      font-size: 0.72rem;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .json-panel.error pre {
      border-color: #fecaca;
      color: #b91c1c;
    }
    .source-group {
      margin-bottom: 2rem;
    }
    .source-group-header {
      margin-bottom: 1rem;
      padding-bottom: 0.85rem;
      border-bottom: 2px solid var(--border);
    }
    .source-group.app-source .source-group-header {
      border-color: var(--accent);
    }
    .source-group.printer-source .source-group-header {
      border-color: #ca8a04;
    }
    html[data-theme="dark"] .source-group.printer-source .source-group-header {
      border-color: #eab308;
    }
    .source-group-header h2 {
      margin: 0;
      font-size: 1.2rem;
    }
    .source-group-header p {
      margin: 0.35rem 0 0;
    }
    .source-badge {
      display: inline-block;
      font-size: 0.7rem;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      padding: 0.2rem 0.55rem;
      border-radius: 999px;
      margin-bottom: 0.4rem;
    }
    .source-badge.app {
      background: var(--accent-soft);
      color: var(--accent);
    }
    .source-badge.printer {
      background: #fffbeb;
      color: #b45309;
    }
    html[data-theme="dark"] .source-badge.printer {
      background: #451a03;
      color: #fcd34d;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 1rem;
      padding: 1.25rem;
      box-shadow: var(--shadow);
    }
    .card h3 { margin: 0 0 0.5rem; font-size: 1rem; }
    .muted { color: var(--muted); }
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.35rem 0.7rem;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 0.85rem;
      font-weight: 600;
    }
    .status-pill.success { background: #ecfdf5; color: #047857; }
    .status-pill.info { background: #eff6ff; color: #1d4ed8; }
    .status-pill.warning { background: #fffbeb; color: #b45309; }
    .status-pill.error { background: #fef2f2; color: #b91c1c; }
    html[data-theme="dark"] .status-pill.success { background: #052e16; color: #86efac; }
    html[data-theme="dark"] .status-pill.info { background: #1e3a5f; color: #93c5fd; }
    html[data-theme="dark"] .status-pill.warning { background: #451a03; color: #fcd34d; }
    html[data-theme="dark"] .status-pill.error { background: #450a0a; color: #fca5a5; }
    .notifications {
      display: grid;
      gap: 0.75rem;
      margin-bottom: 1rem;
    }
    .notification {
      border-radius: 0.9rem;
      padding: 0.95rem 1rem;
      border: 1px solid var(--border);
      background: var(--panel);
      box-shadow: var(--shadow);
    }
    .notification strong {
      display: block;
      margin-bottom: 0.25rem;
    }
    .notification.success { border-color: #86efac; background: #ecfdf5; color: #065f46; }
    .notification.info { border-color: #93c5fd; background: #eff6ff; color: #1e3a8a; }
    .notification.warning { border-color: #fcd34d; background: #fffbeb; color: #92400e; }
    .notification.error { border-color: #fca5a5; background: #fef2f2; color: #991b1b; }
    html[data-theme="dark"] .notification.success { background: #052e16; color: #bbf7d0; }
    html[data-theme="dark"] .notification.info { background: #172554; color: #bfdbfe; }
    html[data-theme="dark"] .notification.warning { background: #451a03; color: #fde68a; }
    html[data-theme="dark"] .notification.error { background: #450a0a; color: #fecaca; }
    .ink-bar {
      height: 10px;
      border-radius: 999px;
      background: var(--border);
      overflow: hidden;
      margin-top: 0.35rem;
    }
    .ink-bar > span {
      display: block;
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, var(--accent), #1d4ed8);
    }
    .ink-bar.black > span { background: #111827; }
    .ink-bar.magenta > span { background: #db2777; }
    .ink-bar.cyan > span { background: #0891b2; }
    .ink-bar.yellow > span { background: #ca8a04; }
    .ink-color-group {
      margin-bottom: 1rem;
    }
    .ink-color-group:last-child {
      margin-bottom: 0;
    }
    .ink-color-title {
      font-weight: 600;
      font-size: 0.92rem;
      margin-bottom: 0.45rem;
      display: flex;
      justify-content: space-between;
      gap: 0.5rem;
    }
    .ink-level-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 5.5rem;
      gap: 0.65rem;
      align-items: end;
    }
    .ink-sublabel-row {
      min-width: 0;
    }
    .ink-sublabel-header {
      display: flex;
      justify-content: space-between;
      font-size: 0.82rem;
      margin-bottom: 0.25rem;
      gap: 0.35rem;
    }

    .ink-sublabel-header span:first-child {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    label { display: block; font-size: 0.9rem; margin-bottom: 0.35rem; }
    input, select, button, textarea {
      font: inherit;
    }
    input, select {
      width: 100%;
      border: 1px solid var(--border);
      background: var(--panel);
      color: var(--text);
      border-radius: 0.75rem;
      padding: 0.7rem 0.85rem;
    }
    button, .button {
      border: 0;
      border-radius: 0.75rem;
      padding: 0.75rem 1rem;
      background: var(--accent);
      color: white;
      cursor: pointer;
      font-weight: 600;
    }
    button.secondary, .button.secondary {
      background: transparent;
      color: var(--text);
      border: 1px solid var(--border);
    }
    button:disabled { opacity: 0.6; cursor: wait; }
    .form-grid {
      display: grid;
      gap: 1rem;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    }
    .actions { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-top: 1rem; }
    .message {
      margin-top: 1rem;
      padding: 0.85rem 1rem;
      border-radius: 0.75rem;
      display: none;
    }
    .message.show { display: block; }
    .message.error { background: #fef2f2; color: #b91c1c; }
    .message.success { background: #ecfdf5; color: #047857; }
    .message.info { background: #eff6ff; color: #1e3a8a; }
    html[data-theme="dark"] .message.info { background: #172554; color: #bfdbfe; }
    .scan-list {
      display: grid;
      gap: 0.75rem;
    }
    .library-layout {
      display: grid;
      grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
      gap: 1rem;
      min-height: 520px;
    }
    .library-sidebar {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      max-height: 72vh;
      overflow: auto;
      padding-right: 0.25rem;
    }
    .library-item {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      width: 100%;
      padding: 0.65rem 0.75rem;
      border: 1px solid var(--border);
      border-radius: 0.85rem;
      background: var(--panel);
      color: var(--text);
      cursor: pointer;
      text-align: left;
    }
    .library-item:hover,
    .library-item.active {
      border-color: var(--accent);
      background: var(--accent-soft);
    }
    .library-thumb {
      width: 44px;
      height: 44px;
      border-radius: 0.55rem;
      object-fit: cover;
      border: 1px solid var(--border);
      background: var(--bg);
      flex: 0 0 44px;
    }
    .library-thumb.pdf-thumb {
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.65rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      color: var(--accent);
    }
    .library-item-text {
      min-width: 0;
      flex: 1;
    }
    .library-item-text strong {
      display: block;
      font-size: 0.9rem;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .library-item-text span {
      display: block;
      color: var(--muted);
      font-size: 0.75rem;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .library-preview-panel {
      display: flex;
      flex-direction: column;
      gap: 1rem;
      min-height: 520px;
      border: 1px solid var(--border);
      border-radius: 1rem;
      background: var(--panel);
      padding: 1rem;
    }
    .library-preview-stage {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 360px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 0.9rem;
      overflow: hidden;
    }
    .library-preview-large {
      max-width: 100%;
      max-height: 68vh;
      object-fit: contain;
    }
    .library-preview-large.pdf-preview {
      width: 100%;
      height: 68vh;
      border: 0;
      background: white;
    }
    .library-preview-empty {
      color: var(--muted);
      text-align: center;
      padding: 2rem;
    }
    .library-preview-meta h3 {
      margin: 0;
      font-size: 1.1rem;
    }
    .library-preview-meta p {
      margin: 0.35rem 0 0;
      color: var(--muted);
      font-size: 0.9rem;
    }
    .library-rename {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
    }
    .library-rename input {
      flex: 1;
      min-width: 180px;
    }
    .preview {
      margin-top: 1rem;
      max-width: 100%;
      border-radius: 0.75rem;
      border: 1px solid var(--border);
    }
    @media (max-width: 900px) {
      .layout {
        grid-template-columns: 1fr;
        grid-template-rows: auto 1fr;
      }
      .mobile-header {
        display: flex;
        align-items: center;
        gap: 0.65rem;
        padding: 0.85rem 1rem;
        background: var(--panel);
        border-bottom: 1px solid var(--border);
        position: sticky;
        top: 0;
        z-index: 30;
        grid-column: 1;
        grid-row: 1;
      }
      .sidebar-backdrop {
        display: block;
        position: fixed;
        inset: 0;
        background: rgba(15, 23, 42, 0.45);
        z-index: 35;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.2s ease;
      }
      html[data-theme="dark"] .sidebar-backdrop {
        background: rgba(0, 0, 0, 0.55);
      }
      .sidebar-backdrop.open {
        opacity: 1;
        pointer-events: auto;
      }
      .sidebar {
        position: fixed;
        top: 0;
        left: 0;
        bottom: 0;
        width: min(280px, 86vw);
        height: 100vh;
        z-index: 40;
        transform: translateX(-105%);
        transition: transform 0.22s ease;
        box-shadow: var(--shadow);
      }
      .sidebar.open {
        transform: translateX(0);
      }
      .main {
        padding: 1rem;
        grid-column: 1;
        grid-row: 2;
      }
      .library-layout { grid-template-columns: 1fr; }
      .library-sidebar { max-height: none; }
      .library-preview-stage { min-height: 280px; }
    }
  </style>
</head>
<body>
  <div class="layout">
    <header class="mobile-header">
      <button type="button" class="menu-toggle" id="menu-toggle" aria-label="Open menu" aria-expanded="false" aria-controls="sidebar">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16"/>
        </svg>
      </button>
      <h2 class="mobile-header-title">${escapeHtml(activeLabel)}</h2>
    </header>
    <div class="sidebar-backdrop" id="sidebar-backdrop" hidden></div>
    <aside class="sidebar" id="sidebar">
      <div class="brand">
        <img src="/icon.svg" alt="" />
        <div>
          <h1>Brother Print &amp; Scan</h1>
          <p>MFC-J1360DW</p>
        </div>
      </div>
      <nav>${navHtml}</nav>
      <div class="sidebar-supplies" id="sidebar-supplies" hidden>
        <p class="sidebar-supplies-label">Reorder ink</p>
        <div id="sidebar-supplies-links"></div>
      </div>
      <div class="sidebar-footer">
        <div class="sidebar-footer-actions">
          <button class="secondary" id="theme-toggle" type="button">Theme</button>
          <button class="secondary" id="refresh-status" type="button">Refresh</button>
        </div>
        <div class="app-version">v${APP_VERSION}</div>
      </div>
    </aside>
    <main class="main">
      ${content}
    </main>
  </div>
  <script>
    const themeKey = "brother-printer-theme";
    const root = document.documentElement;
    const savedTheme = localStorage.getItem(themeKey);
    if (savedTheme === "dark") root.setAttribute("data-theme", "dark");
    document.getElementById("theme-toggle")?.addEventListener("click", () => {
      const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      if (next === "dark") root.setAttribute("data-theme", "dark");
      else root.removeAttribute("data-theme");
      localStorage.setItem(themeKey, next);
    });
    function escapeAttr(value) {
      return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    }
    const MEDIA_LABELS = ${JSON.stringify(MEDIA_LABELS)};
    const COLOR_MODE_LABELS = ${JSON.stringify(COLOR_MODE_LABELS)};
    const FORMAT_LABELS = ${JSON.stringify(FORMAT_LABELS)};
    const SIDES_LABELS = ${JSON.stringify(SIDES_LABELS)};
    function formatMediaLabel(media) {
      const trimmed = String(media || "").trim();
      return MEDIA_LABELS[trimmed] || trimmed.replace(/^(na_|iso_|oe_|om_)/, "").replace(/_/g, " ");
    }
    function formatAdfStateLabel(state) {
      const normalized = String(state || "").trim();
      const lower = normalized.toLowerCase();
      if (lower.includes("loaded")) return "Paper loaded";
      if (lower.includes("empty")) return "Empty";
      if (lower.includes("jam")) return "Paper jam";
      if (lower.includes("mispick")) return "Misfeed";
      if (lower.includes("processing")) return "Processing";
      return normalized.replace(/^ScannerAdf/i, "").replace(/([a-z])([A-Z])/g, "$1 $2").trim() || normalized;
    }
    function replaceSelectOptions(select, options, preferredValue) {
      if (!select) return;
      const entries = Array.isArray(options) ? options : [];
      if (!entries.length) return;
      select.innerHTML = entries.map((entry) => {
        const value = typeof entry === "string" ? entry : entry.value;
        const label = typeof entry === "string" ? entry : entry.label;
        return '<option value="' + escapeAttr(value) + '">' + label + '</option>';
      }).join("");
      const values = entries.map((entry) => (typeof entry === "string" ? entry : entry.value));
      if (preferredValue && values.includes(preferredValue)) {
        select.value = preferredValue;
      }
    }
    function renderSidebarSupplies(settings) {
      const container = document.getElementById("sidebar-supplies");
      const links = document.getElementById("sidebar-supplies-links");
      if (!container || !links || !settings) return;
      const items = [];
      if (settings.black_ink_reorder_url) {
        items.push({ label: "Black cartridges", url: settings.black_ink_reorder_url });
      }
      if (settings.color_ink_reorder_url) {
        items.push({ label: "Color cartridges", url: settings.color_ink_reorder_url });
      }
      if (!items.length) {
        container.hidden = true;
        links.innerHTML = "";
        return;
      }
      container.hidden = false;
      links.innerHTML = items.map((item) =>
        '<a class="supplies-link" href="' + escapeAttr(item.url) + '" target="_blank" rel="noopener noreferrer">' + item.label + '</a>'
      ).join("");
    }
    async function refreshSidebarStatus() {
      try {
        const res = await fetch("/api/status");
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to load status");
        renderSidebarSupplies(data.settings);
      } catch {
        const supplies = document.getElementById("sidebar-supplies");
        if (supplies) supplies.hidden = true;
      }
    }
    window.refreshSidebarStatus = refreshSidebarStatus;
    refreshSidebarStatus();
    setInterval(refreshSidebarStatus, 30000);
    document.getElementById("refresh-status")?.addEventListener("click", () => {
      refreshSidebarStatus();
      if (typeof window.refreshDashboard === "function") window.refreshDashboard();
      else location.reload();
    });
    (function () {
      const toggle = document.getElementById("menu-toggle");
      const sidebar = document.getElementById("sidebar");
      const backdrop = document.getElementById("sidebar-backdrop");
      if (!toggle || !sidebar || !backdrop) return;

      const mq = window.matchMedia("(max-width: 900px)");

      function setOpen(open) {
        sidebar.classList.toggle("open", open);
        backdrop.classList.toggle("open", open);
        backdrop.hidden = !open;
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
        toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
        document.body.style.overflow = open && mq.matches ? "hidden" : "";
      }

      function closeSidebar() {
        setOpen(false);
      }

      toggle.addEventListener("click", () => {
        setOpen(!sidebar.classList.contains("open"));
      });
      backdrop.addEventListener("click", closeSidebar);
      sidebar.querySelectorAll(".nav-link").forEach((link) => {
        link.addEventListener("click", closeSidebar);
      });
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") closeSidebar();
      });
      mq.addEventListener("change", () => {
        if (!mq.matches) closeSidebar();
      });
    })();
  </script>
</body>
</html>`;
}
function dashboardContent() {
    return `
    <div class="toolbar toolbar-actions">
      <span class="status-pill" id="connection-pill">Checking printer…</span>
    </div>
    <div class="notifications" id="notifications" hidden></div>
    <div class="grid">
      <section class="card">
        <h3>Device</h3>
        <p class="muted" id="device-model">—</p>
        <p class="muted" id="device-serial" hidden style="margin-top:0.5rem">—</p>
        <p id="device-status" style="margin-top:0.75rem">—</p>
        <p class="muted" id="device-status-detail" style="margin-top:0.5rem">—</p>
        <p class="muted" id="device-paper" hidden style="margin-top:0.5rem">—</p>
        <p class="muted" id="device-queue" hidden style="margin-top:0.5rem">—</p>
        <p class="muted" id="device-host" style="margin-top:0.5rem">—</p>
      </section>
      <section class="card">
        <h3>Scanner</h3>
        <p id="scanner-state">—</p>
        <p class="muted" id="scanner-adf" style="margin-top:0.5rem">—</p>
      </section>
      <section class="card">
        <h3>Ink</h3>
        <div id="ink-levels"></div>
      </section>
    </div>
    <script>
      function escapeAttr(value) {
        return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
      }
      function alertReorderLink(alert) {
        if (!alert.reorder_url) return "";
        return ' <a class="ink-reorder-link" href="' + escapeAttr(alert.reorder_url) + '" target="_blank" rel="noopener noreferrer">Reorder</a>';
      }
      function pageYieldForColor(color, pageYield) {
        if (!pageYield) return "";
        const map = {
          Magenta: pageYield.magenta,
          Cyan: pageYield.cyan,
          Yellow: pageYield.yellow,
          Black: pageYield.black,
        };
        return map[color] || "";
      }
      function pageYieldLabel(value) {
        const text = String(value || "").trim();
        if (!text || text === "----") return "";
        return " · ~" + text + " pages";
      }
      function inkSublabelBar(label, level, variant) {
        const cls = level.color.toLowerCase();
        const lowTag = level.low ? ' <span class="muted">(low)</span>' : '';
        const variantClass = variant === "reservoir" ? " ink-sublabel-row--reservoir" : " ink-sublabel-row--cartridge";
        return '<div class="ink-sublabel-row' + variantClass + '">' +
          '<div class="ink-sublabel-header"><span class="muted">' + label + lowTag + '</span><span>' + level.percent + '%</span></div>' +
          '<div class="ink-bar ' + cls + '"><span style="width:' + level.percent + '%"></span></div>' +
          '</div>';
      }
      function renderInkTile(ink, pageYield) {
        const colors = ["Magenta", "Cyan", "Yellow", "Black"];
        return colors.map((color) => {
          const cartridge = (ink.cartridges || []).find((level) => level.color === color);
          const reservoir = (ink.reservoir || []).find((level) => level.color === color);
          const yieldTag = pageYieldLabel(pageYieldForColor(color, pageYield));
          return '<div class="ink-color-group">' +
            '<div class="ink-color-title"><span>' + color + '</span><span class="muted">' + yieldTag + '</span></div>' +
            '<div class="ink-level-row">' +
            (cartridge ? inkSublabelBar("Cartridge", cartridge, "cartridge") : '<div class="ink-sublabel-row ink-sublabel-row--cartridge"></div>') +
            (reservoir ? inkSublabelBar("Res.", reservoir, "reservoir") : '<div class="ink-sublabel-row ink-sublabel-row--reservoir"></div>') +
            '</div></div>';
        }).join("");
      }
      function renderNotifications(alerts) {
        const container = document.getElementById("notifications");
        if (!alerts || !alerts.length) {
          container.hidden = true;
          container.innerHTML = "";
          return;
        }
        container.hidden = false;
        container.innerHTML = alerts.map((alert) =>
          '<div class="notification ' + alert.severity + '"><strong>' + alert.title + '</strong><span>' + alert.message + alertReorderLink(alert) + '</span></div>'
        ).join("");
      }
      function pillLabel(level, message) {
        if (level === "ready") return "Ready";
        if (level === "busy") return "Busy";
        if (level === "warning") return message || "Warning";
        if (level === "error") return message || "Error";
        return "Connected";
      }
      async function refreshDashboard() {
        const pill = document.getElementById("connection-pill");
        try {
          const res = await fetch("/api/status");
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Failed to load status");
          const level = data.printer.device_status_level || "unknown";
          pill.className = "status-pill " + (level === "unknown" ? "info" : level);
          pill.textContent = pillLabel(level, data.printer.device_status);
          renderNotifications(data.printer.alerts || []);
          if (typeof window.refreshSidebarStatus === "function") window.refreshSidebarStatus();
          document.getElementById("device-model").textContent = data.capabilities.make_and_model;
          const serialEl = document.getElementById("device-serial");
          if (serialEl) {
            if (data.capabilities.serial_number) {
              serialEl.hidden = false;
              serialEl.textContent = "Serial: " + data.capabilities.serial_number;
            } else {
              serialEl.hidden = true;
              serialEl.textContent = "";
            }
          }
          document.getElementById("device-status").textContent = "Printer says: " + data.printer.device_status;
          document.getElementById("device-status-detail").textContent = data.printer.device_status_detail;
          const paperEl = document.getElementById("device-paper");
          const ipp = data.ipp || {};
          if (paperEl) {
            if (ipp.media_ready) {
              paperEl.hidden = false;
              paperEl.textContent = "Paper loaded: " + formatMediaLabel(ipp.media_ready);
            } else {
              paperEl.hidden = true;
              paperEl.textContent = "";
            }
          }
          const queueEl = document.getElementById("device-queue");
          if (queueEl) {
            if (ipp.available) {
              const queueParts = [];
              if (ipp.queued_job_count != null) {
                queueParts.push(ipp.queued_job_count + " job" + (ipp.queued_job_count === 1 ? "" : "s") + " queued");
              }
              if (ipp.accepting_jobs != null) {
                queueParts.push(ipp.accepting_jobs ? "accepting jobs" : "not accepting jobs");
              }
              if (ipp.printer_state) {
                queueParts.push("IPP state: " + ipp.printer_state);
              }
              if (queueParts.length) {
                queueEl.hidden = false;
                queueEl.textContent = queueParts.join(" · ");
              } else {
                queueEl.hidden = true;
                queueEl.textContent = "";
              }
            } else {
              queueEl.hidden = true;
              queueEl.textContent = "";
            }
          }
          document.getElementById("device-host").textContent = data.settings.printer_host;
          document.getElementById("scanner-state").textContent = "Scanner: " + data.scanner.state;
          const adfLabel = data.scanner.adf_state_label || formatAdfStateLabel(data.scanner.adf_state);
          document.getElementById("scanner-adf").textContent = "ADF: " + adfLabel;
          const pageYield = data.printer.page_yield || null;
          document.getElementById("ink-levels").innerHTML = renderInkTile(data.printer.ink, pageYield);
        } catch (error) {
          pill.className = "status-pill error";
          pill.textContent = "Offline";
          renderNotifications([{
            severity: "error",
            title: "Cannot reach printer",
            message: error.message,
          }]);
          document.getElementById("device-status").textContent = error.message;
          document.getElementById("device-status-detail").textContent = "";
        }
      }
      window.refreshDashboard = refreshDashboard;
      refreshDashboard();
      setInterval(refreshDashboard, 30000);
    </script>`;
}
function scanContent() {
    return `
    <section class="card">
      <p class="muted" id="scan-device-status">Loading scanner status…</p>
      <div class="message info" id="scan-stale-jobs" hidden></div>
      <form id="scan-form">
        <div class="form-grid">
          <div>
            <label for="source">Input source</label>
            <select id="source" name="source">
              <option value="platen">Flatbed</option>
              <option value="adf">Document feeder</option>
            </select>
          </div>
          <div>
            <label for="color_mode">Color mode</label>
            <select id="color_mode" name="color_mode"></select>
          </div>
          <div>
            <label for="resolution">Resolution</label>
            <select id="resolution" name="resolution"></select>
          </div>
          <div>
            <label for="format">Format</label>
            <select id="format" name="format"></select>
          </div>
        </div>
        <div class="actions">
          <button type="submit" id="scan-btn">Start scan</button>
        </div>
        <div class="message" id="scan-message"></div>
        <img class="preview" id="scan-preview" hidden alt="Latest scan preview" />
      </form>
    </section>
    <script>
      const form = document.getElementById("scan-form");
      const message = document.getElementById("scan-message");
      const preview = document.getElementById("scan-preview");
      const button = document.getElementById("scan-btn");
      const deviceStatus = document.getElementById("scan-device-status");
      const staleJobs = document.getElementById("scan-stale-jobs");
      const sourceSelect = document.getElementById("source");
      const colorModeSelect = document.getElementById("color_mode");
      const resolutionSelect = document.getElementById("resolution");
      const formatSelect = document.getElementById("format");

      async function loadScanOptions() {
        try {
          const res = await fetch("/api/status");
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Failed to load scanner options");

          const caps = data.capabilities || {};
          const scanner = data.scanner || {};
          const adfLabel = scanner.adf_state_label || formatAdfStateLabel(scanner.adf_state);
          if (deviceStatus) {
            deviceStatus.textContent = "Scanner: " + (scanner.state || "Unknown") + " · ADF: " + adfLabel;
          }

          if (staleJobs) {
            const count = scanner.stale_scan_jobs || 0;
            if (count > 0) {
              staleJobs.hidden = false;
              staleJobs.className = "message info show";
              staleJobs.textContent = count + " leftover scan job" + (count === 1 ? "" : "s") + " on the printer. They will be cleared automatically when you start a scan.";
            } else {
              staleJobs.hidden = true;
              staleJobs.textContent = "";
            }
          }

          const colorModes = (caps.color_modes || []).map((mode) => ({
            value: mode,
            label: COLOR_MODE_LABELS[mode] || mode,
          }));
          if (!colorModes.length) {
            colorModes.push(
              { value: "RGB24", label: "Color" },
              { value: "Grayscale8", label: "Grayscale" },
              { value: "BlackAndWhite1", label: "Black & white" },
            );
          }
          replaceSelectOptions(colorModeSelect, colorModes, "RGB24");

          const resolutions = (caps.resolutions || []).map((dpi) => ({
            value: String(dpi),
            label: dpi + " dpi",
          }));
          if (!resolutions.length) {
            resolutions.push(
              { value: "200", label: "200 dpi" },
              { value: "300", label: "300 dpi" },
              { value: "600", label: "600 dpi" },
            );
          }
          replaceSelectOptions(resolutionSelect, resolutions, resolutions.some((entry) => entry.value === "300") ? "300" : resolutions[0]?.value);

          const formats = (caps.formats || []).map((format) => ({
            value: format,
            label: FORMAT_LABELS[format] || format,
          }));
          if (!formats.length) {
            formats.push(
              { value: "image/jpeg", label: "JPEG" },
              { value: "application/pdf", label: "PDF" },
            );
          }
          replaceSelectOptions(formatSelect, formats, "image/jpeg");

          if (sourceSelect) {
            const adfOption = sourceSelect.querySelector('option[value="adf"]');
            if (adfOption) {
              const adfEmpty = String(scanner.adf_state || "").toLowerCase().includes("empty");
              adfOption.disabled = !caps.has_adf || adfEmpty;
              adfOption.textContent = caps.has_adf
                ? ("Document feeder" + (adfEmpty ? " (empty)" : ""))
                : "Document feeder (unavailable)";
            }
            if (!caps.has_adf && sourceSelect.value === "adf") {
              sourceSelect.value = "platen";
            }
          }
        } catch (error) {
          if (deviceStatus) deviceStatus.textContent = error.message;
          replaceSelectOptions(colorModeSelect, [
            { value: "RGB24", label: "Color" },
            { value: "Grayscale8", label: "Grayscale" },
            { value: "BlackAndWhite1", label: "Black & white" },
          ], "RGB24");
          replaceSelectOptions(resolutionSelect, [
            { value: "200", label: "200 dpi" },
            { value: "300", label: "300 dpi" },
            { value: "600", label: "600 dpi" },
          ], "300");
          replaceSelectOptions(formatSelect, [
            { value: "image/jpeg", label: "JPEG" },
            { value: "application/pdf", label: "PDF" },
          ], "image/jpeg");
        }
      }

      loadScanOptions();

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        button.disabled = true;
        message.className = "message show";
        message.textContent = "Scanning… keep the document on the flatbed. The scanner should start momentarily.";
        preview.hidden = true;
        try {
          const payload = Object.fromEntries(new FormData(form).entries());
          payload.resolution = Number(payload.resolution);
          const res = await fetch("/api/scan", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Scan failed");
          message.className = "message success show";
          message.textContent = "Scan saved to library (" + data.record.page_count + " page(s)).";
          if (data.preview_url) {
            preview.src = data.preview_url;
            preview.hidden = false;
          }
        } catch (error) {
          message.className = "message error show";
          message.textContent = error.message;
        } finally {
          button.disabled = false;
        }
      });
    </script>`;
}
function printContent() {
    return `
    <section class="card">
      <form id="print-form" enctype="multipart/form-data">
        <div class="form-grid">
          <div>
            <label for="file">Document</label>
            <input id="file" name="file" type="file" accept=".pdf,.jpg,.jpeg,.png,image/*,application/pdf" required />
          </div>
          <div>
            <label for="copies">Copies</label>
            <input id="copies" name="copies" type="number" min="1" max="99" value="1" />
          </div>
          <div>
            <label for="sides">Sides</label>
            <select id="sides" name="sides"></select>
          </div>
          <div>
            <label for="color">Color</label>
            <select id="color" name="color">
              <option value="color">Color</option>
              <option value="monochrome">Black &amp; white</option>
            </select>
          </div>
          <div>
            <label for="media">Paper</label>
            <select id="media" name="media"></select>
          </div>
        </div>
        <p class="muted" id="print-paper-note" hidden style="margin-top:0.75rem"></p>
        <div class="actions">
          <button type="submit" id="print-btn">Send to printer</button>
        </div>
        <div class="message" id="print-message"></div>
      </form>
    </section>
    <script>
      const form = document.getElementById("print-form");
      const message = document.getElementById("print-message");
      const button = document.getElementById("print-btn");
      const sidesSelect = document.getElementById("sides");
      const mediaSelect = document.getElementById("media");
      const paperNote = document.getElementById("print-paper-note");

      async function loadPrintOptions() {
        try {
          const res = await fetch("/api/status");
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Failed to load print options");
          const ipp = data.ipp || {};

          const sides = (ipp.sides_supported || []).map((side) => ({
            value: side,
            label: SIDES_LABELS[side] || side,
          }));
          if (!sides.length) {
            sides.push(
              { value: "one-sided", label: "One-sided" },
              { value: "two-sided-long-edge", label: "Two-sided (long edge)" },
              { value: "two-sided-short-edge", label: "Two-sided (short edge)" },
            );
          }
          replaceSelectOptions(sidesSelect, sides, "one-sided");

          const media = (ipp.media_supported || []).map((entry) => ({
            value: entry,
            label: formatMediaLabel(entry),
          }));
          if (!media.length) {
            media.push(
              { value: "na_letter_8.5x11in", label: "Letter" },
              { value: "iso_a4_210x297mm", label: "A4" },
              { value: "na_legal_8.5x14in", label: "Legal" },
              { value: "na_number-10_4.125x9.5in", label: "Envelope #10" },
            );
          }
          const preferredMedia = ipp.media_ready || ipp.media_default || "na_letter_8.5x11in";
          replaceSelectOptions(mediaSelect, media, preferredMedia);

          if (paperNote && ipp.media_ready) {
            paperNote.hidden = false;
            paperNote.textContent = "Printer reports " + formatMediaLabel(ipp.media_ready) + " loaded.";
          } else if (paperNote) {
            paperNote.hidden = true;
            paperNote.textContent = "";
          }
        } catch (error) {
          replaceSelectOptions(sidesSelect, [
            { value: "one-sided", label: "One-sided" },
            { value: "two-sided-long-edge", label: "Two-sided (long edge)" },
            { value: "two-sided-short-edge", label: "Two-sided (short edge)" },
          ], "one-sided");
          replaceSelectOptions(mediaSelect, [
            { value: "na_letter_8.5x11in", label: "Letter" },
            { value: "iso_a4_210x297mm", label: "A4" },
            { value: "na_legal_8.5x14in", label: "Legal" },
            { value: "na_number-10_4.125x9.5in", label: "Envelope #10" },
          ], "na_letter_8.5x11in");
        }
      }

      loadPrintOptions();

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        button.disabled = true;
        message.className = "message show";
        message.textContent = "Sending print job…";
        try {
          const res = await fetch("/api/print", { method: "POST", body: new FormData(form) });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Print failed");
          message.className = "message success show";
          const warningText = Array.isArray(data.warnings) && data.warnings.length
            ? " Warning: " + data.warnings.join(" ")
            : "";
          message.textContent = (data.message || "Print job submitted.") + warningText;
          form.reset();
        } catch (error) {
          message.className = "message error show";
          message.textContent = error.message;
        } finally {
          button.disabled = false;
        }
      });
    </script>`;
}
function copyContent() {
    return `
    <section class="card">
      <p class="muted">Scan a document and send it straight to the printer.</p>
      <form id="copy-form">
        <div class="form-grid">
          <div>
            <label for="source">Input source</label>
            <select id="source" name="source">
              <option value="platen">Flatbed</option>
              <option value="adf">Document feeder</option>
            </select>
          </div>
          <div>
            <label for="color_mode">Color mode</label>
            <select id="color_mode" name="color_mode">
              <option value="RGB24">Color</option>
              <option value="Grayscale8">Grayscale</option>
              <option value="BlackAndWhite1">Black &amp; white</option>
            </select>
          </div>
          <div>
            <label for="copies">Copies</label>
            <input id="copies" name="copies" type="number" min="1" max="99" value="1" />
          </div>
          <div>
            <label for="sides">Sides</label>
            <select id="sides" name="sides"></select>
          </div>
          <div>
            <label for="media">Paper</label>
            <select id="media" name="media"></select>
          </div>
        </div>
        <p class="muted" id="copy-paper-note" hidden style="margin-top:0.75rem"></p>
        <div class="actions">
          <button type="submit" id="copy-btn">Scan and print</button>
        </div>
        <div class="message" id="copy-message"></div>
      </form>
    </section>
    <script>
      const form = document.getElementById("copy-form");
      const message = document.getElementById("copy-message");
      const button = document.getElementById("copy-btn");
      const copySidesSelect = document.getElementById("sides");
      const copyMediaSelect = document.getElementById("media");
      const copyPaperNote = document.getElementById("copy-paper-note");
      const copySourceSelect = document.getElementById("source");
      const copyColorModeSelect = document.getElementById("color_mode");

      async function loadCopyOptions() {
        try {
          const res = await fetch("/api/status");
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Failed to load copy options");
          const ipp = data.ipp || {};
          const caps = data.capabilities || {};
          const scanner = data.scanner || {};

          const colorModes = (caps.color_modes || []).map((mode) => ({
            value: mode,
            label: COLOR_MODE_LABELS[mode] || mode,
          }));
          if (!colorModes.length) {
            colorModes.push(
              { value: "RGB24", label: "Color" },
              { value: "Grayscale8", label: "Grayscale" },
              { value: "BlackAndWhite1", label: "Black & white" },
            );
          }
          replaceSelectOptions(copyColorModeSelect, colorModes, "RGB24");

          const sides = (ipp.sides_supported || []).map((side) => ({
            value: side,
            label: SIDES_LABELS[side] || side,
          }));
          if (!sides.length) {
            sides.push(
              { value: "one-sided", label: "One-sided" },
              { value: "two-sided-long-edge", label: "Two-sided (long edge)" },
            );
          }
          replaceSelectOptions(copySidesSelect, sides, "one-sided");

          const media = (ipp.media_supported || []).map((entry) => ({
            value: entry,
            label: formatMediaLabel(entry),
          }));
          if (!media.length) {
            media.push(
              { value: "na_letter_8.5x11in", label: "Letter" },
              { value: "iso_a4_210x297mm", label: "A4" },
            );
          }
          const preferredMedia = ipp.media_ready || ipp.media_default || "na_letter_8.5x11in";
          replaceSelectOptions(copyMediaSelect, media, preferredMedia);

          if (copyPaperNote && ipp.media_ready) {
            copyPaperNote.hidden = false;
            copyPaperNote.textContent = "Printer reports " + formatMediaLabel(ipp.media_ready) + " loaded.";
          } else if (copyPaperNote) {
            copyPaperNote.hidden = true;
            copyPaperNote.textContent = "";
          }

          if (copySourceSelect) {
            const adfOption = copySourceSelect.querySelector('option[value="adf"]');
            if (adfOption) {
              const adfEmpty = String(scanner.adf_state || "").toLowerCase().includes("empty");
              adfOption.disabled = !caps.has_adf || adfEmpty;
              adfOption.textContent = caps.has_adf
                ? ("Document feeder" + (adfEmpty ? " (empty)" : ""))
                : "Document feeder (unavailable)";
            }
          }
        } catch (error) {
          replaceSelectOptions(copySidesSelect, [
            { value: "one-sided", label: "One-sided" },
            { value: "two-sided-long-edge", label: "Two-sided (long edge)" },
          ], "one-sided");
          replaceSelectOptions(copyMediaSelect, [
            { value: "na_letter_8.5x11in", label: "Letter" },
            { value: "iso_a4_210x297mm", label: "A4" },
          ], "na_letter_8.5x11in");
        }
      }

      loadCopyOptions();

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        button.disabled = true;
        message.className = "message show";
        message.textContent = "Scanning, then printing…";
        try {
          const payload = Object.fromEntries(new FormData(form).entries());
          payload.copies = Number(payload.copies);
          const res = await fetch("/api/copy", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Copy failed");
          message.className = "message success show";
          message.textContent = data.message || "Copy job completed.";
        } catch (error) {
          message.className = "message error show";
          message.textContent = error.message;
        } finally {
          button.disabled = false;
        }
      });
    </script>`;
}
function libraryContent() {
    return `
    <section class="card">
      <div class="library-layout" id="library-layout" hidden>
        <div class="library-sidebar" id="library-list"></div>
        <div class="library-preview-panel">
          <div class="library-preview-stage" id="library-preview-stage">
            <div class="library-preview-empty">Select a scan to preview it.</div>
          </div>
          <div class="library-preview-meta" id="library-preview-meta" hidden>
            <h3 id="library-preview-title"></h3>
            <p id="library-preview-details"></p>
          </div>
          <div class="library-rename" id="library-rename" hidden>
            <input id="library-rename-input" type="text" maxlength="120" />
            <button id="library-rename-btn" type="button">Rename</button>
            <a class="button secondary" id="library-download-btn" href="#">Download</a>
            <button class="secondary" id="library-delete-btn" type="button">Delete</button>
          </div>
        </div>
      </div>
      <p class="muted" id="library-empty" hidden>No saved scans yet.</p>
    </section>
    <script>
      let libraryScans = [];
      let selectedScanId = null;

      function escapeHtml(value) {
        return String(value)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
      }

      function isImageScan(scan) {
        return scan.content_type && scan.content_type.startsWith("image/");
      }

      function scanFileUrl(scan) {
        return "/api/scans/" + encodeURIComponent(scan.id) + "/file";
      }

      function thumbHtml(scan) {
        if (isImageScan(scan)) {
          return '<img class="library-thumb" src="' + scanFileUrl(scan) + '" alt="" loading="lazy" />';
        }
        return '<div class="library-thumb pdf-thumb">PDF</div>';
      }

      function previewHtml(scan) {
        if (isImageScan(scan)) {
          return '<img class="library-preview-large" src="' + scanFileUrl(scan) + '" alt="" />';
        }
        return '<iframe class="library-preview-large pdf-preview" src="' + scanFileUrl(scan) + '" title="PDF preview"></iframe>';
      }

      function renderPreview(scan) {
        const stage = document.getElementById("library-preview-stage");
        const meta = document.getElementById("library-preview-meta");
        const rename = document.getElementById("library-rename");
        const title = document.getElementById("library-preview-title");
        const details = document.getElementById("library-preview-details");
        const renameInput = document.getElementById("library-rename-input");
        const downloadBtn = document.getElementById("library-download-btn");
        if (!scan) {
          stage.innerHTML = '<div class="library-preview-empty">Select a scan to preview it.</div>';
          meta.hidden = true;
          rename.hidden = true;
          return;
        }
        stage.innerHTML = previewHtml(scan);
        meta.hidden = false;
        rename.hidden = false;
        title.textContent = scan.display_name || scan.filename;
        details.textContent = scan.source + " · " + scan.resolution + " dpi · " + scan.page_count + " page(s) · " + new Date(scan.created_at).toLocaleString();
        renameInput.value = scan.display_name || scan.filename;
        downloadBtn.href = scanFileUrl(scan);
        downloadBtn.setAttribute("download", scan.filename);
      }

      function selectScan(id) {
        selectedScanId = id;
        document.querySelectorAll(".library-item").forEach((button) => {
          button.classList.toggle("active", button.dataset.id === id);
        });
        const scan = libraryScans.find((entry) => entry.id === id);
        renderPreview(scan || null);
      }

      async function renameSelectedScan() {
        if (!selectedScanId) return;
        const input = document.getElementById("library-rename-input");
        const res = await fetch("/api/scans/" + encodeURIComponent(selectedScanId), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ display_name: input.value }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Rename failed");
        await loadLibrary(selectedScanId);
      }

      async function deleteSelectedScan() {
        if (!selectedScanId) return;
        if (!confirm("Delete this scan?")) return;
        await fetch("/api/scans/" + encodeURIComponent(selectedScanId), { method: "DELETE" });
        selectedScanId = null;
        await loadLibrary();
      }

      async function loadLibrary(preferredId) {
        const layout = document.getElementById("library-layout");
        const list = document.getElementById("library-list");
        const empty = document.getElementById("library-empty");
        const res = await fetch("/api/scans");
        const data = await res.json();
        libraryScans = data.scans || [];
        if (!libraryScans.length) {
          layout.hidden = true;
          empty.hidden = false;
          list.innerHTML = "";
          renderPreview(null);
          return;
        }
        layout.hidden = false;
        empty.hidden = true;
        list.innerHTML = libraryScans.map((scan) => {
          const when = new Date(scan.created_at).toLocaleDateString();
          return '<button class="library-item" data-id="' + escapeHtml(scan.id) + '" type="button">' +
            thumbHtml(scan) +
            '<div class="library-item-text"><strong>' + escapeHtml(scan.display_name || scan.filename) + '</strong><span>' + escapeHtml(when) + ' · ' + escapeHtml(String(scan.resolution)) + ' dpi</span></div>' +
            '</button>';
        }).join("");
        list.querySelectorAll(".library-item").forEach((button) => {
          button.addEventListener("click", () => selectScan(button.dataset.id));
        });
        const nextId = preferredId && libraryScans.some((scan) => scan.id === preferredId)
          ? preferredId
          : (selectedScanId && libraryScans.some((scan) => scan.id === selectedScanId) ? selectedScanId : libraryScans[0].id);
        selectScan(nextId);
      }

      document.getElementById("library-rename-btn")?.addEventListener("click", async () => {
        try {
          await renameSelectedScan();
        } catch (error) {
          alert(error.message);
        }
      });
      document.getElementById("library-rename-input")?.addEventListener("keydown", async (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        try {
          await renameSelectedScan();
        } catch (error) {
          alert(error.message);
        }
      });
      document.getElementById("library-delete-btn")?.addEventListener("click", deleteSelectedScan);
      loadLibrary();
    </script>`;
}
function apiExplorerContent() {
    const restRows = API_CATALOG.app_rest.map((row) => ({
        method: row.method,
        path: row.path,
        query: ("body" in row ? row.body : undefined) || "—",
        description: row.description,
    }));
    const printerRows = API_CATALOG.printer_http.map((row) => ({
        method: row.method,
        path: row.path,
        description: row.description,
    }));
    const restTable = renderApiCatalogTable(restRows, [
        { key: "method", label: "Method" },
        { key: "path", label: "Path" },
        { key: "query", label: "Body" },
        { key: "description", label: "Description" },
    ]);
    const printerTable = renderApiCatalogTable(printerRows, [
        { key: "method", label: "Method" },
        { key: "path", label: "Path" },
        { key: "description", label: "Description" },
    ]);
    const appSchemaNames = Object.keys(API_RESPONSE_SCHEMAS).filter((name) => /^[A-Z]+ /.test(name));
    const printerSchemaNames = Object.keys(API_RESPONSE_SCHEMAS).filter((name) => name.startsWith("Brother "));
    return `
    <div class="toolbar">
      <div>
        <p class="muted" style="margin:0">All <code>/api/*</code> routes are served by this Umbrel app. Printer protocols are documented separately for direct device access.</p>
      </div>
      <button type="button" class="tile-refresh" id="api-refresh-all" aria-label="Refresh all data">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
      </button>
    </div>
    <div class="card">
      <div class="api-toolbar">
        <span class="muted" id="api-fetched-at">Not loaded yet</span>
      </div>
      <p class="muted" style="margin:0">POST endpoints are documented in the reference tables but not auto-run.</p>
    </div>

    <section class="source-group app-source">
      <div class="source-group-header">
        <span class="source-badge app">App API</span>
        <h2>Brother Print &amp; Scan app</h2>
        <p class="muted">REST endpoints served by this Umbrel app — settings, library, and orchestration.</p>
      </div>
      <div class="card api-section">
        <h2>Live responses</h2>
        <p class="muted" style="margin:0 0 0.75rem">These panels call app endpoints. Responses that include printer data (status, diagnostics) are fetched by the app from your Brother device on the LAN.</p>
        <details class="json-panel" open><summary>GET /api/status</summary><pre id="api-data-status">Loading…</pre></details>
        <details class="json-panel" open><summary>GET /api/diagnostics</summary><pre id="api-data-diagnostics">Loading…</pre></details>
        <details class="json-panel" open><summary>GET /api/explorer</summary><pre id="api-data-explorer">Loading…</pre></details>
        <details class="json-panel" open><summary>GET /api/scans</summary><pre id="api-data-scans">Loading…</pre></details>
        <details class="json-panel" open><summary>GET /api/settings</summary><pre id="api-data-settings">Loading…</pre></details>
      </div>
      <div class="card api-section">
        <h2>REST reference</h2>
        ${restTable}
      </div>
      <div class="card api-section">
        <h2>Response structures</h2>
        ${renderResponseSchemaPanels(appSchemaNames)}
      </div>
    </section>

    <section class="source-group printer-source">
      <div class="source-group-header">
        <span class="source-badge printer">Printer API</span>
        <h2>Brother MFC-J1360DW</h2>
        <p class="muted">Data read from the printer over HTTP, eSCL, and IPP on your LAN.</p>
      </div>
      <div class="card api-section">
        <h2>Device endpoints</h2>
        <p class="muted" style="margin:0 0 0.75rem">Replace <code>{printer_host}</code> with your configured IP.</p>
        ${printerTable}
      </div>
      <div class="card api-section">
        <h2>Response structures</h2>
        ${renderResponseSchemaPanels(printerSchemaNames)}
      </div>
    </section>

    <script>
      function prettyJson(value) {
        try {
          return JSON.stringify(value, null, 2);
        } catch {
          return String(value);
        }
      }

      async function fetchPanel(url) {
        const res = await fetch(url);
        const contentType = res.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const data = await res.json();
          return { ok: res.ok, status: res.status, body: data };
        }
        const text = await res.text();
        return { ok: res.ok, status: res.status, body: text };
      }

      function setPanel(id, payload, isError) {
        const el = document.getElementById(id);
        if (!el) return;
        const panel = el.closest(".json-panel");
        if (panel) panel.classList.toggle("error", Boolean(isError));
        el.textContent = typeof payload === "string" ? payload : prettyJson(payload);
      }

      async function loadApiExplorer() {
        const button = document.getElementById("api-refresh-all");
        if (button) {
          button.disabled = true;
          button.classList.add("spinning");
        }
        const fetchedAt = document.getElementById("api-fetched-at");
        if (fetchedAt) fetchedAt.textContent = "Loading…";

        const [status, diagnostics, scans, settings, explorer] = await Promise.all([
          fetchPanel("/api/status"),
          fetchPanel("/api/diagnostics"),
          fetchPanel("/api/scans"),
          fetchPanel("/api/settings"),
          fetchPanel("/api/explorer"),
        ]);

        const explorerBody = explorer.body || {};

        setPanel("api-data-status", { status: status.status, ok: status.ok, body: status.body }, !status.ok);
        setPanel("api-data-diagnostics", { status: diagnostics.status, ok: diagnostics.ok, body: diagnostics.body }, !diagnostics.ok);
        setPanel("api-data-explorer", { status: explorer.status, ok: explorer.ok, body: explorer.body }, !explorer.ok);
        setPanel("api-data-scans", { status: scans.status, ok: scans.ok, body: scans.body }, !scans.ok);
        setPanel("api-data-settings", { status: settings.status, ok: settings.ok, body: settings.body }, !settings.ok);

        if (fetchedAt) {
          const stamp = explorerBody.fetched_at || new Date().toISOString();
          fetchedAt.textContent = "Last fetched " + new Date(stamp).toLocaleString();
        }

        if (button) {
          button.disabled = false;
          button.classList.remove("spinning");
        }
      }

      document.getElementById("api-refresh-all")?.addEventListener("click", loadApiExplorer);
      loadApiExplorer();
    </script>`;
}
function diagnosticsContent() {
    return `
    <div class="toolbar toolbar-actions">
      <button type="button" class="tile-refresh" id="diagnostics-refresh" aria-label="Refresh diagnostics">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
      </button>
    </div>
    <div id="diagnostics-content">
      <div class="card"><p class="muted">Loading diagnostics…</p></div>
    </div>
    <script>
      function escapeHtml(value) {
        return String(value)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
      }
      function formatDiagValue(value) {
        if (value === null || value === undefined || value === "") return "—";
        return escapeHtml(String(value));
      }
      function formatDiagTimestamp(value) {
        if (!value) return "—";
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? formatDiagValue(value) : escapeHtml(date.toLocaleString());
      }
      function formatBytes(value) {
        if (!value) return "0 B";
        const units = ["B", "KB", "MB", "GB"];
        let size = Number(value);
        let unit = 0;
        while (size >= 1024 && unit < units.length - 1) {
          size /= 1024;
          unit += 1;
        }
        return escapeHtml(size.toFixed(size >= 10 || unit === 0 ? 0 : 1) + " " + units[unit]);
      }
      function diagnosticsRow(label, valueHtml) {
        return '<div class="stat-row"><span class="muted">' + escapeHtml(label) + '</span><span>' + valueHtml + '</span></div>';
      }
      function diagnosticsSection(title, rowsHtml, options) {
        if (!rowsHtml) return "";
        const collapsible = !options || options.collapsible !== false;
        if (!collapsible) {
          return '<div class="diagnostics-section"><h4>' + escapeHtml(title) + '</h4>' + rowsHtml + '</div>';
        }
        const openAttr = options && options.open ? " open" : "";
        return '<details class="diagnostics-panel"' + openAttr + '><summary>' + escapeHtml(title) + '</summary><div class="diagnostics-panel-body">' + rowsHtml + '</div></details>';
      }
      function diagnosticsCard(title, bodyHtml, options) {
        const openAttr = !options || options.open !== false ? " open" : "";
        const hint = options && options.hint
          ? '<span class="muted diagnostics-card-hint">' + escapeHtml(options.hint) + '</span>'
          : "";
        return '<details class="card diagnostics-card-panel"' + openAttr + '>' +
          '<summary class="diagnostics-card-summary"><h3>' + escapeHtml(title) + '</h3>' + hint + '</summary>' +
          '<div class="diagnostics-card-body">' + bodyHtml + '</div>' +
          '</details>';
      }
      function renderInkRows(levels, title) {
        if (!levels || !levels.length) return "";
        const rows = levels.map((level) =>
          diagnosticsRow(level.color, formatDiagValue(level.percent + "%" + (level.low ? " (low)" : "")))
        ).join("");
        return diagnosticsSection(title, rows, { collapsible: false });
      }
      function renderProbeRows(probes) {
        if (!probes || !probes.length) return "";
        const rows = probes.map((probe) => {
          const status = probe.ok
            ? "HTTP " + probe.status_code + " (" + probe.latency_ms + " ms)"
            : (probe.error || "Failed") + " (" + probe.latency_ms + " ms)";
          return diagnosticsRow(probe.route, formatDiagValue(status));
        }).join("");
        return diagnosticsSection("Endpoint probes", rows);
      }
      function renderJobRows(jobs) {
        if (!jobs || !jobs.length) return "";
        const rows = jobs.slice(0, 8).map((job, index) =>
          diagnosticsRow(
            "Job " + (index + 1),
            formatDiagValue(
              (job.job_state || "Unknown") +
              (job.job_state_reason ? " (" + job.job_state_reason + ")" : "") +
              " · " + job.images_completed + "/" + job.images_to_transfer +
              " images · age " + Math.round((job.age_ms || 0) / 1000) + "s"
            )
          )
        ).join("");
        return diagnosticsSection("Recent eSCL scan jobs", rows);
      }
      function formatIppAttributeValue(key, value, suppliesParsed) {
        if (key !== "printer-supply") {
          const text = Array.isArray(value) ? value.join(", ") : String(value);
          return formatDiagValue(text);
        }
        const supplies = suppliesParsed || [];
        if (!supplies.length) {
          const text = Array.isArray(value) ? value.join(", ") : String(value);
          return formatDiagValue(text);
        }
        return supplies.map((supply) =>
          '<div style="margin-bottom:0.45rem"><strong>' + escapeHtml(supply.label) + '</strong><br>' +
          '<span class="muted">' + escapeHtml(supply.summary) + '</span></div>'
        ).join("");
      }
      function renderSupplyRows(supplies) {
        if (!supplies || !supplies.length) return "";
        const rows = supplies.map((supply) =>
          diagnosticsRow(
            supply.label,
            formatDiagValue(
              supply.level_status +
              " · " + supply.type_label +
              " · " + supply.class_label +
              (supply.capacity_status !== "Not reported" ? " · capacity " + supply.capacity_status : "")
            )
          )
        ).join("");
        return diagnosticsSection("Ink supplies (IPP decoded)", rows, { open: true });
      }
      function renderIppAttributeRows(attributes, suppliesParsed) {
        if (!attributes) return "";
        const keys = Object.keys(attributes).sort();
        const rows = keys.map((key) => {
          const value = attributes[key];
          return diagnosticsRow(key, formatIppAttributeValue(key, value, suppliesParsed));
        }).join("");
        return diagnosticsSection("Raw IPP attributes (" + keys.length + ")", rows);
      }
      function renderDiagnostics(data) {
        const root = document.getElementById("diagnostics-content");
        if (!root) return;

        if (data.error && !data.app && !data.printer) {
          root.innerHTML = '<div class="card"><p class="message error">' + escapeHtml(data.error) + '</p></div>';
          return;
        }

        const app = data.app || {};
        const printer = data.printer || {};
        const runtime = app.runtime || {};
        const library = app.library || {};
        const settings = app.settings || {};
        const endpoints = printer.endpoints || {};
        const monitor = printer.monitor || {};
        const ipp = printer.ipp || {};
        const escl = printer.escl || {};
        const caps = printer.capabilities || {};

        const runtimeHint = [runtime.node_version, runtime.uptime_seconds != null ? runtime.uptime_seconds + "s uptime" : ""]
          .filter(Boolean)
          .join(" · ");
        const scannerHint = [
          printer.scanner?.state,
          printer.scanner?.adf_state_label || printer.scanner?.adf_state,
        ].filter(Boolean).join(" · ");
        const ippHint = [
          ipp.printer_state,
          ipp.queued_job_count != null ? ipp.queued_job_count + " queued" : "",
        ].filter(Boolean).join(" · ");
        const connectionHint = printer.reachable ? "Reachable" : "Unreachable";

        const appOverviewCard = diagnosticsCard("App overview",
          diagnosticsRow("Generated", formatDiagTimestamp(data.generated_at)) +
          diagnosticsRow("App version", formatDiagValue(data.app_version)) +
          diagnosticsRow("Configured printer", formatDiagValue(settings.printer_host)) +
          diagnosticsRow("Printer reachable", printer.reachable ? "Yes" : "No"),
          { open: true },
        );

        const runtimeCard = diagnosticsCard("Runtime",
          diagnosticsRow("Node", formatDiagValue(runtime.node_version)) +
          diagnosticsRow("Platform", formatDiagValue(runtime.platform + " " + runtime.arch)) +
          diagnosticsRow("Uptime", formatDiagValue(runtime.uptime_seconds + "s")) +
          diagnosticsRow("Port", formatDiagValue(runtime.port)) +
          diagnosticsRow("Environment", formatDiagValue(runtime.node_env)) +
          diagnosticsRow("Data root", formatDiagValue(runtime.data_root)) +
          diagnosticsRow("Settings file", runtime.settings_file_exists ? "Present" : "Missing") +
          diagnosticsRow("Scans directory", runtime.scans_dir_exists ? "Present" : "Missing") +
          diagnosticsRow("ipptool", runtime.ipptool_available ? "Available" : "Missing") +
          diagnosticsRow("pdftoppm", runtime.pdftoppm_available ? "Available" : "Missing") +
          diagnosticsRow("IPP test file", runtime.ipp_attrs_test_available ? "Available" : "Missing"),
          { open: false, hint: runtimeHint },
        );

        const settingsCard = diagnosticsCard("Settings & library",
          diagnosticsRow("Display name", formatDiagValue(settings.printer_name)) +
          diagnosticsRow("Black reorder link", settings.black_ink_reorder_configured ? "Configured" : "Not set") +
          diagnosticsRow("Color reorder link", settings.color_ink_reorder_configured ? "Configured" : "Not set") +
          diagnosticsRow("Saved scans", formatDiagValue(library.scan_count)) +
          diagnosticsRow("Library size", formatBytes(library.total_bytes)) +
          diagnosticsRow("Latest scan", formatDiagTimestamp(library.latest_scan_at)),
          { open: true, hint: (library.scan_count || 0) + " scans" },
        );

        const printerConnectionCard = diagnosticsCard("Connection",
          diagnosticsRow("Printer host", formatDiagValue(printer.host)) +
          diagnosticsRow("Reachable", printer.reachable ? "Yes" : "No") +
          diagnosticsRow("HTTP base", formatDiagValue(endpoints.http_base)) +
          diagnosticsRow("eSCL base", formatDiagValue(endpoints.escl_base)) +
          diagnosticsRow("IPP URI", formatDiagValue(endpoints.ipp_uri)) +
          renderProbeRows(printer.probes) +
          (printer.errors?.length ? diagnosticsSection("Errors", printer.errors.map((entry) => diagnosticsRow("Notice", formatDiagValue(entry))).join("")) : ""),
          { open: true, hint: connectionHint },
        );

        const deviceCard = diagnosticsCard("Device status",
          diagnosticsRow("Status", formatDiagValue(monitor.message)) +
          diagnosticsRow("Level", formatDiagValue(monitor.level)) +
          diagnosticsRow("Detail", formatDiagValue(monitor.detail)) +
          diagnosticsRow("Status page model", formatDiagValue(printer.status_page?.model)) +
          diagnosticsRow("Status page monitor", formatDiagValue(printer.status_page?.monitor?.message)),
          { open: true, hint: monitor.message || "—" },
        );

        const inkCard = diagnosticsCard("Ink",
          renderInkRows(printer.ink?.cartridges, "Cartridges") +
          renderInkRows(printer.ink?.reservoir, "Internal reservoir") +
          (printer.status_page?.page_yield
            ? diagnosticsSection("Approx. page yield (ISO)", (
                diagnosticsRow("Magenta", formatDiagValue(printer.status_page.page_yield.magenta)) +
                diagnosticsRow("Cyan", formatDiagValue(printer.status_page.page_yield.cyan)) +
                diagnosticsRow("Yellow", formatDiagValue(printer.status_page.page_yield.yellow)) +
                diagnosticsRow("Black", formatDiagValue(printer.status_page.page_yield.black))
              ), { open: false })
            : ""),
          { open: true, hint: "Cartridges & reservoir" },
        );

        const scannerCard = diagnosticsCard("Scanner (eSCL)",
          diagnosticsRow("State", formatDiagValue(printer.scanner?.state)) +
          diagnosticsRow("ADF state", formatDiagValue(printer.scanner?.adf_state_label || printer.scanner?.adf_state)) +
          diagnosticsRow("eSCL version", formatDiagValue(printer.scanner?.version)) +
          diagnosticsRow("Make and model", formatDiagValue(caps.make_and_model)) +
          diagnosticsRow("Serial number", formatDiagValue(caps.serial_number)) +
          diagnosticsRow("ADF", caps.has_adf ? "Yes" : "No") +
          diagnosticsRow("Feeder capacity", formatDiagValue(caps.feeder_capacity)) +
          diagnosticsRow("Max scan area", formatDiagValue(caps.max_width + " × " + caps.max_height)) +
          diagnosticsRow("Resolutions", formatDiagValue((caps.resolutions || []).join(", "))) +
          diagnosticsRow("Color modes", formatDiagValue((caps.color_modes || []).join(", "))) +
          diagnosticsRow("Formats", formatDiagValue((caps.formats || []).join(", "))) +
          (escl.capabilities
            ? diagnosticsSection("Extended capabilities", (
                diagnosticsRow("Manufacturer", formatDiagValue(escl.capabilities.manufacturer)) +
                diagnosticsRow("UUID", formatDiagValue(escl.capabilities.uuid)) +
                diagnosticsRow("Admin URI", formatDiagValue(escl.capabilities.admin_uri)) +
                diagnosticsRow("Certifications", formatDiagValue((escl.capabilities.certifications || []).join(", "))) +
                diagnosticsRow("Color spaces", formatDiagValue((escl.capabilities.color_spaces || []).join(", "))) +
                diagnosticsRow("Scan intents", formatDiagValue((escl.capabilities.scan_intents || []).join(", "))) +
                diagnosticsRow("ADF options", formatDiagValue((escl.capabilities.adf_options || []).join(", "))) +
                diagnosticsRow("Platen max optical", formatDiagValue(escl.capabilities.platen.max_optical_x_resolution + " × " + escl.capabilities.platen.max_optical_y_resolution + " dpi")) +
                diagnosticsRow("Blank page removal", formatDiagValue(escl.capabilities.blank_page_detection_and_removal))
              ), { open: false })
            : "") +
          renderJobRows(escl.scan_jobs),
          { open: false, hint: scannerHint },
        );

        const ippCard = diagnosticsCard("IPP printer",
          diagnosticsRow("Available", ipp.available ? "Yes" : "No") +
          (ipp.error ? diagnosticsRow("Error", formatDiagValue(ipp.error)) : "") +
          diagnosticsRow("Printer name", formatDiagValue(ipp.printer_name)) +
          diagnosticsRow("Printer info", formatDiagValue(ipp.printer_info)) +
          diagnosticsRow("Make and model", formatDiagValue(ipp.make_and_model)) +
          diagnosticsRow("State", formatDiagValue(ipp.printer_state)) +
          diagnosticsRow("State reasons", formatDiagValue(ipp.printer_state_reasons)) +
          diagnosticsRow("State message", formatDiagValue(ipp.printer_state_message)) +
          diagnosticsRow("Up time", formatDiagValue(ipp.printer_up_time_seconds ? ipp.printer_up_time_seconds + "s" : "")) +
          diagnosticsRow("Queued jobs", formatDiagValue(ipp.queued_job_count)) +
          diagnosticsRow("Accepting jobs", formatDiagValue(ipp.accepting_jobs)) +
          diagnosticsRow("Pages per minute", formatDiagValue(ipp.pages_per_minute)) +
          diagnosticsRow("Color PPM", formatDiagValue(ipp.pages_per_minute_color)) +
          diagnosticsRow("Media ready", formatDiagValue(ipp.media_ready)) +
          diagnosticsRow("Media default", formatDiagValue(ipp.media_default)) +
          diagnosticsRow("Alert descriptions", formatDiagValue(ipp.alert_descriptions)) +
          renderSupplyRows(ipp.supplies_parsed) +
          diagnosticsRow("Supply descriptions", formatDiagValue(ipp.supply_descriptions)) +
          diagnosticsRow("Device ID", formatDiagValue(ipp.device_id)) +
          diagnosticsRow("Printer UUID", formatDiagValue(ipp.printer_uuid)) +
          diagnosticsRow("Document formats", formatDiagValue(ipp.document_formats)) +
          diagnosticsRow("Print color modes", formatDiagValue(ipp.color_modes)) +
          diagnosticsRow("Sides supported", formatDiagValue(ipp.sides_supported)) +
          diagnosticsRow("Media supported", formatDiagValue(ipp.media_supported)) +
          renderIppAttributeRows(ipp.attributes, ipp.supplies_parsed),
          { open: false, hint: ippHint },
        );

        const alertsCard = diagnosticsCard("Alerts",
          ((printer.alerts && printer.alerts.length)
            ? printer.alerts.map((alert) =>
                diagnosticsRow(alert.title, formatDiagValue(alert.message + (alert.severity ? " [" + alert.severity + "]" : "")))
              ).join("")
            : '<p class="muted">No active alerts.</p>'),
          { open: true, hint: (printer.alerts?.length || 0) + " active" },
        );

        root.innerHTML =
          '<section class="source-group app-source">' +
            '<div class="source-group-header">' +
              '<span class="source-badge app">App diagnostics</span>' +
              '<h2>Brother Print &amp; Scan app</h2>' +
              '<p class="muted">Umbrel container runtime, settings, and scan library.</p>' +
            '</div>' +
            '<div class="diagnostics-grid">' +
              appOverviewCard + runtimeCard + settingsCard +
            '</div>' +
          '</section>' +
          '<section class="source-group printer-source">' +
            '<div class="source-group-header">' +
              '<span class="source-badge printer">Printer diagnostics</span>' +
              '<h2>Brother MFC-J1360DW</h2>' +
              '<p class="muted">Live data from the printer over HTTP, eSCL, and IPP.</p>' +
            '</div>' +
            '<div class="diagnostics-grid">' +
              printerConnectionCard + deviceCard + inkCard + alertsCard + scannerCard + ippCard +
            '</div>' +
          '</section>';
      }

      async function refreshDiagnostics() {
        const root = document.getElementById("diagnostics-content");
        if (root) root.innerHTML = '<div class="card"><p class="muted">Loading diagnostics…</p></div>';
        try {
          const res = await fetch("/api/diagnostics");
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Failed to load diagnostics");
          renderDiagnostics(data);
        } catch (error) {
          if (root) {
            root.innerHTML = '<div class="card"><p class="message error">' + escapeHtml(error.message) + '</p></div>';
          }
        }
      }

      window.refreshDiagnostics = refreshDiagnostics;
      document.getElementById("diagnostics-refresh")?.addEventListener("click", refreshDiagnostics);
      refreshDiagnostics();
    </script>`;
}
function settingsContent(settings) {
    return `
    <section class="card">
      <form id="settings-form">
        <div class="form-grid">
          <div>
            <label for="printer_host">Printer IP address</label>
            <input id="printer_host" name="printer_host" value="${escapeHtml(settings.printer_host)}" required />
          </div>
          <div>
            <label for="printer_name">Display name</label>
            <input id="printer_name" name="printer_name" value="${escapeHtml(settings.printer_name)}" />
          </div>
        </div>
        <p class="muted" style="margin-top:1rem">Your printer is currently reachable at <strong>${escapeHtml(settings.printer_host)}</strong>. The Umbrel server must be on the same local network.</p>
        <h3 style="margin-top:1.5rem">Ink reorder links</h3>
        <p class="muted" style="margin-top:0.35rem">These links appear in the side menu and on low-ink alerts. Leave blank to hide a link.</p>
        <div class="form-grid" style="margin-top:0.75rem">
          <div>
            <label for="black_ink_reorder_url">Black cartridge link</label>
            <input id="black_ink_reorder_url" name="black_ink_reorder_url" type="url" value="${escapeHtml(settings.black_ink_reorder_url)}" placeholder="https://..." />
          </div>
          <div>
            <label for="color_ink_reorder_url">Color cartridge link</label>
            <input id="color_ink_reorder_url" name="color_ink_reorder_url" type="url" value="${escapeHtml(settings.color_ink_reorder_url)}" placeholder="https://..." />
          </div>
        </div>
        <div class="actions">
          <button type="submit">Save settings</button>
        </div>
        <div class="message" id="settings-message"></div>
      </form>
    </section>
    <script>
      const form = document.getElementById("settings-form");
      const message = document.getElementById("settings-message");
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const payload = Object.fromEntries(new FormData(form).entries());
        const res = await fetch("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        message.className = "message show " + (res.ok ? "success" : "error");
        message.textContent = res.ok ? "Settings saved." : (data.error || "Save failed");
        if (res.ok && typeof window.refreshSidebarStatus === "function") window.refreshSidebarStatus();
      });
    </script>`;
}
async function handleApi(req, res, route, settings) {
    if (route === "/api/explorer" && req.method === "GET") {
        sendJson(res, 200, buildExplorerPayload(settings));
        return true;
    }
    if (route === "/api/diagnostics" && req.method === "GET") {
        try {
            const diagnostics = await getDiagnostics(settings);
            sendJson(res, 200, diagnostics);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            sendJson(res, 500, { error: message, app_version: APP_VERSION });
        }
        return true;
    }
    if (route === "/api/status" && req.method === "GET") {
        try {
            const [scanner, capabilities, printer, ipp] = await Promise.all([
                getScannerStatus(settings.printer_host),
                getScannerCapabilities(settings.printer_host),
                getPrinterStatus(settings.printer_host, settings),
                getIppStatusSummary(settings.printer_host),
            ]);
            sendJson(res, 200, {
                settings,
                scanner,
                capabilities,
                printer: {
                    ...printer,
                    alerts: mergeStatusAlerts(printer.alerts, buildIppAlerts(ipp)),
                },
                ipp,
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            sendJson(res, 502, { error: message, settings });
        }
        return true;
    }
    if (route === "/api/scan" && req.method === "POST") {
        try {
            const body = await readJson(req);
            const options = {
                source: body.source === "adf" ? "adf" : "platen",
                color_mode: body.color_mode ?? "RGB24",
                resolution: Number(body.resolution) || 300,
                format: body.format === "application/pdf" ? "application/pdf" : "image/jpeg",
            };
            const result = await performScan(settings.printer_host, options);
            const record = await saveScan(result.buffers, result.contentType, options);
            const previewUrl = result.contentType.startsWith("image/") ? `/api/scans/${record.id}/file` : undefined;
            sendJson(res, 200, { record, preview_url: previewUrl });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            sendJson(res, 500, { error: message });
        }
        return true;
    }
    if (route === "/api/scans" && req.method === "GET") {
        const scans = await listScans();
        sendJson(res, 200, { scans });
        return true;
    }
    const scanFileMatch = route.match(/^\/api\/scans\/([^/]+)\/file$/);
    if (scanFileMatch && req.method === "GET") {
        const id = decodeURIComponent(scanFileMatch[1]);
        const record = await getScanRecord(id);
        if (!record) {
            sendJson(res, 404, { error: "Scan not found" });
            return true;
        }
        const filePath = node_path_1.default.join(SCANS_DIR, record.filename);
        if (!(0, node_fs_1.existsSync)(filePath)) {
            sendJson(res, 404, { error: "Scan file missing" });
            return true;
        }
        const body = await (0, promises_1.readFile)(filePath);
        const downloadName = `${scanDisplayName(record)}${node_path_1.default.extname(record.filename)}`;
        sendBytes(res, 200, record.content_type, body, downloadName);
        return true;
    }
    const scanIdMatch = route.match(/^\/api\/scans\/([^/]+)$/);
    if (scanIdMatch && req.method === "PATCH") {
        try {
            const id = decodeURIComponent(scanIdMatch[1]);
            const body = await readJson(req);
            if (!body.display_name?.trim()) {
                sendJson(res, 400, { error: "display_name is required" });
                return true;
            }
            const updated = await renameScan(id, body.display_name);
            if (!updated) {
                sendJson(res, 404, { error: "Scan not found" });
                return true;
            }
            sendJson(res, 200, { scan: updated });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            sendJson(res, 400, { error: message });
        }
        return true;
    }
    if (scanIdMatch && req.method === "DELETE") {
        const id = decodeURIComponent(scanIdMatch[1]);
        const deleted = await deleteScan(id);
        sendJson(res, deleted ? 200 : 404, { ok: deleted });
        return true;
    }
    if (route === "/api/print" && req.method === "POST") {
        try {
            const contentType = req.headers["content-type"] ?? "";
            if (!contentType.startsWith("multipart/form-data")) {
                sendJson(res, 400, { error: "Expected multipart upload" });
                return true;
            }
            const body = await readBody(req);
            const parsed = parseMultipart(contentType, body);
            if (!parsed.fileData || !parsed.fileName) {
                sendJson(res, 400, { error: "Missing file upload" });
                return true;
            }
            const tempPath = node_path_1.default.join(DATA_ROOT, `print-${(0, node_crypto_1.randomUUID)()}-${parsed.fileName}`);
            await (0, promises_1.writeFile)(tempPath, parsed.fileData);
            try {
                const options = {
                    copies: Number.parseInt(parsed.fields.copies ?? "1", 10) || 1,
                    sides: parsed.fields.sides || "one-sided",
                    color: parsed.fields.color === "monochrome" ? "monochrome" : "color",
                    media: parsed.fields.media || "na_letter_8.5x11in",
                };
                const result = await printFile(settings.printer_host, tempPath, options, settings);
                sendJson(res, 200, result);
            }
            finally {
                await (0, promises_1.rm)(tempPath, { force: true });
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            sendJson(res, 500, { error: message });
        }
        return true;
    }
    if (route === "/api/copy" && req.method === "POST") {
        try {
            const body = await readJson(req);
            const scanOptions = {
                source: body.source === "adf" ? "adf" : "platen",
                color_mode: body.color_mode ?? "RGB24",
                resolution: 300,
                format: "image/jpeg",
            };
            const printOptions = {
                copies: Number(body.copies) || 1,
                sides: body.sides || "one-sided",
                color: body.color_mode === "BlackAndWhite1" ? "monochrome" : "color",
                media: body.media?.trim() || "na_letter_8.5x11in",
            };
            const scanResult = await performScan(settings.printer_host, scanOptions);
            const record = await saveScan(scanResult.buffers, scanResult.contentType, scanOptions);
            const filePath = node_path_1.default.join(SCANS_DIR, record.filename);
            const printResult = await printFile(settings.printer_host, filePath, printOptions, settings);
            sendJson(res, 200, {
                ...printResult,
                message: `Copied ${record.page_count} page(s) to the printer.`,
                record,
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            sendJson(res, 500, { error: message });
        }
        return true;
    }
    if (route === "/api/settings" && req.method === "GET") {
        sendJson(res, 200, settings);
        return true;
    }
    if (route === "/api/settings" && req.method === "PUT") {
        try {
            const body = await readJson(req);
            const next = {
                printer_host: body.printer_host?.trim() || settings.printer_host,
                printer_name: body.printer_name?.trim() || settings.printer_name,
                black_ink_reorder_url: normalizeReorderUrl(body.black_ink_reorder_url, settings.black_ink_reorder_url),
                color_ink_reorder_url: normalizeReorderUrl(body.color_ink_reorder_url, settings.color_ink_reorder_url),
            };
            await saveSettings(next);
            sendJson(res, 200, next);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            sendJson(res, 400, { error: message });
        }
        return true;
    }
    return false;
}
async function main() {
    await ensureDataDirs();
    const server = (0, node_http_1.createServer)(async (req, res) => {
        try {
            const url = new URL(req.url ?? "/", "http://localhost");
            const route = url.pathname;
            const settings = await loadSettings();
            if (route === "/icon.svg" && req.method === "GET") {
                if ((0, node_fs_1.existsSync)(ICON_PATH)) {
                    const icon = await (0, promises_1.readFile)(ICON_PATH);
                    sendBytes(res, 200, "image/svg+xml", icon);
                    return;
                }
            }
            if (await handleApi(req, res, route, settings)) {
                return;
            }
            if (req.method === "GET") {
                if (route === "/") {
                    sendText(res, 200, renderPage("dashboard", dashboardContent()), "text/html; charset=utf-8");
                    return;
                }
                if (route === "/scan") {
                    sendText(res, 200, renderPage("scan", scanContent()), "text/html; charset=utf-8");
                    return;
                }
                if (route === "/print") {
                    sendText(res, 200, renderPage("print", printContent()), "text/html; charset=utf-8");
                    return;
                }
                if (route === "/copy") {
                    sendText(res, 200, renderPage("copy", copyContent()), "text/html; charset=utf-8");
                    return;
                }
                if (route === "/library") {
                    sendText(res, 200, renderPage("library", libraryContent()), "text/html; charset=utf-8");
                    return;
                }
                if (route === "/diagnostics") {
                    sendText(res, 200, renderPage("diagnostics", diagnosticsContent()), "text/html; charset=utf-8");
                    return;
                }
                if (route === "/api") {
                    sendText(res, 200, renderPage("api", apiExplorerContent()), "text/html; charset=utf-8");
                    return;
                }
                if (route === "/settings") {
                    sendText(res, 200, renderPage("settings", settingsContent(settings)), "text/html; charset=utf-8");
                    return;
                }
            }
            sendJson(res, 404, { error: "Not found" });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            sendJson(res, 500, { error: message });
        }
    });
    const port = Number.parseInt(process.env.PORT ?? "3000", 10);
    server.listen(port, "0.0.0.0", () => {
        console.log(`Brother Print & Scan v${APP_VERSION} listening on :${port}`);
    });
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
