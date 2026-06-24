import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const APP_VERSION = "1.1.0";
const DATA_ROOT = process.env.PRINTER_DATA_DIR ?? "/data";
const SCANS_DIR = path.join(DATA_ROOT, "scans");
const SETTINGS_PATH = path.join(DATA_ROOT, "settings.json");
const ICON_PATH = path.join(__dirname, "icon.svg");
const PRINT_JOB_TEST_PATH = path.join(__dirname, "print-job.test");
const IPPTOOL_PATH = process.env.IPPTOOL_PATH?.trim() || "/usr/bin/ipptool";
const PDFTOPPM_PATH = process.env.PDFTOPPM_PATH?.trim() || "/usr/bin/pdftoppm";

const ESCL_NS = "http://schemas.hp.com/imaging/escl/2011/05/03";
const PWG_NS = "http://www.pwg.org/schemas/2010/12/sm";

type Settings = {
  printer_host: string;
  printer_name: string;
  black_ink_reorder_url: string;
  color_ink_reorder_url: string;
};

type ScanRecord = {
  id: string;
  filename: string;
  display_name?: string;
  content_type: string;
  source: "platen" | "adf";
  color_mode: string;
  resolution: number;
  format: string;
  page_count: number;
  created_at: string;
};

function scanDisplayName(record: ScanRecord): string {
  const custom = record.display_name?.trim();
  if (custom) return custom;
  const when = new Date(record.created_at).toLocaleString();
  return `Scan ${when}`;
}

function normalizeScanRecord(record: ScanRecord): ScanRecord {
  return {
    ...record,
    display_name: scanDisplayName(record),
  };
}

type ScanOptions = {
  source: "platen" | "adf";
  color_mode: "RGB24" | "Grayscale8" | "BlackAndWhite1";
  resolution: number;
  format: "image/jpeg" | "application/pdf";
};

type PrintOptions = {
  copies: number;
  sides: "one-sided" | "two-sided-long-edge" | "two-sided-short-edge";
  color: "color" | "monochrome";
  media: string;
};

const DEFAULT_BLACK_INK_REORDER_URL =
  "https://www.amazon.com/Brother-Genuine-LC501XL2PK-Cartridges-Printers/dp/B0FKL36T9M/ref=sr_1_3?crid=3U2IHBBOA24L9&dib=eyJ2IjoiMSJ9.FY1W4QzVZuxABV-W0Koybv3iJrNFKC9fV9XQvujf95XxqJbvjfFInM62PkNC7fffAvXcX1NQrxL5z9HHhZs0FxAqT9kvsRS2P59ZpXkNhahp4nio-aiWm1N5LoBWaYKTNwv_aKYw6Gma9oLzQPlWYBwjChqhEBreCssiCFZBIp-tsx2mwiWjE8mUe586D5dc4N5hzSjXI9imBQ0ZvuVSFLjsucuN2KS1W79G-6XPprk.lXlPGVisv7rNSOIaDtGgxGR7DBfNLn-1F73gelzNQso&dib_tag=se&keywords=brother%2Blc501xl&qid=1782261557&sprefix=brother%2Blc501xl%2Caps%2C188&sr=8-3&th=1";

const DEFAULT_COLOR_INK_REORDER_URL =
  "https://www.amazon.com/Brother-Genuine-LC501XL2PK-Cartridges-Printers/dp/B0FKLH56D3/ref=sr_1_3?crid=3U2IHBBOA24L9&dib=eyJ2IjoiMSJ9.FY1W4QzVZuxABV-W0Koybv3iJrNFKC9fV9XQvujf95XxqJbvjfFInM62PkNC7fffAvXcX1NQrxL5z9HHhZs0FxAqT9kvsRS2P59ZpXkNhahp4nio-aiWm1N5LoBWaYKTNwv_aKYw6Gma9oLzQPlWYBwjChqhEBreCssiCFZBIp-tsx2mwiWjE8mUe586D5dc4N5hzSjXI9imBQ0ZvuVSFLjsucuN2KS1W79G-6XPprk.lXlPGVisv7rNSOIaDtGgxGR7DBfNLn-1F73gelzNQso&dib_tag=se&keywords=brother%2Blc501xl&qid=1782261557&sprefix=brother%2Blc501xl%2Caps%2C188&sr=8-3&th=1";

const DEFAULT_SETTINGS: Settings = {
  printer_host: process.env.PRINTER_HOST?.trim() || "192.168.86.31",
  printer_name: "Brother MFC-J1360DW",
  black_ink_reorder_url: DEFAULT_BLACK_INK_REORDER_URL,
  color_ink_reorder_url: DEFAULT_COLOR_INK_REORDER_URL,
};

async function ensureDataDirs(): Promise<void> {
  await mkdir(SCANS_DIR, { recursive: true });
}

async function loadSettings(): Promise<Settings> {
  if (!existsSync(SETTINGS_PATH)) {
    return { ...DEFAULT_SETTINGS };
  }
  try {
    const raw = await readFile(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      printer_host: parsed.printer_host?.trim() || DEFAULT_SETTINGS.printer_host,
      printer_name: parsed.printer_name?.trim() || DEFAULT_SETTINGS.printer_name,
      black_ink_reorder_url:
        parsed.black_ink_reorder_url === undefined
          ? DEFAULT_SETTINGS.black_ink_reorder_url
          : parsed.black_ink_reorder_url.trim(),
      color_ink_reorder_url:
        parsed.color_ink_reorder_url === undefined
          ? DEFAULT_SETTINGS.color_ink_reorder_url
          : parsed.color_ink_reorder_url.trim(),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(settings: Settings): Promise<void> {
  await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

function normalizeReorderUrl(value: string | undefined, current: string): string {
  if (value === undefined) return current;
  const trimmed = value.trim();
  if (!trimmed) return "";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Reorder links must be valid http or https URLs.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Reorder links must use http or https.");
  }
  return trimmed;
}

function printerBaseUrl(host: string): string {
  return `http://${host}`;
}

function esclBaseUrl(host: string): string {
  return `http://${host}/eSCL`;
}

function ippUri(host: string): string {
  return `ipp://${host}/ipp/print`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
  });
  res.end(body);
}

function sendText(res: ServerResponse, statusCode: number, body: string, contentType = "text/plain; charset=utf-8"): void {
  const buffer = Buffer.from(body);
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": buffer.length,
  });
  res.end(buffer);
}

function sendBytes(
  res: ServerResponse,
  statusCode: number,
  contentType: string,
  body: Buffer,
  downloadName?: string,
): void {
  const headers: Record<string, string | number> = {
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

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const body = await readBody(req);
  if (body.length === 0) return {} as T;
  return JSON.parse(body.toString("utf8")) as T;
}

function xmlTagValue(xml: string, tag: string): string | null {
  const patterns = [
    new RegExp(`<(?:[\\w-]+:)?${tag}[^>]*>([^<]*)</(?:[\\w-]+:)?${tag}>`, "i"),
    new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "i"),
  ];
  for (const pattern of patterns) {
    const match = xml.match(pattern);
    if (match?.[1] !== undefined) return match[1].trim();
  }
  return null;
}

function xmlAllTagValues(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<(?:[\\w-]+:)?${tag}[^>]*>([^<]*)</(?:[\\w-]+:)?${tag}>`, "gi");
  const values: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    values.push(match[1].trim());
  }
  return values;
}

async function fetchPrinterText(host: string, route: string, timeoutMs = 8000): Promise<string> {
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
  } finally {
    clearTimeout(timer);
  }
}

async function fetchEscl(host: string, route: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    return await fetch(`${esclBaseUrl(host)}${route}`, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function getScannerStatus(host: string) {
  const xml = await fetchPrinterText(host, "/eSCL/ScannerStatus");
  return {
    state: xmlTagValue(xml, "State") ?? "Unknown",
    adf_state: xmlTagValue(xml, "AdfState") ?? "Unknown",
    version: xmlTagValue(xml, "Version"),
  };
}

async function getScannerCapabilities(host: string) {
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

type InkLevel = {
  color: string;
  percent: number;
  low: boolean;
};

type DeviceStatusLevel = "ready" | "warning" | "busy" | "error" | "unknown";

type StatusAlert = {
  severity: "success" | "info" | "warning" | "error";
  title: string;
  message: string;
  reorder_url?: string;
};

const BROTHER_INK_COLOR_CODES: Record<string, string> = {
  BK: "Black",
  M: "Magenta",
  C: "Cyan",
  Y: "Yellow",
};

function inkReorderUrl(color: string, settings: Settings): string | undefined {
  const url = color === "Black" ? settings.black_ink_reorder_url : settings.color_ink_reorder_url;
  const trimmed = url.trim();
  return trimmed || undefined;
}

function inkReorderUrlFromBrotherCode(code: string, settings: Settings): string | undefined {
  const color = BROTHER_INK_COLOR_CODES[code.trim().toUpperCase()];
  return color ? inkReorderUrl(color, settings) : undefined;
}

function inkReorderUrlFromStatusMessage(message: string, settings: Settings): string | undefined {
  const match = message.trim().match(/^Ink (?:Low|Empty) \(([^)]+)\)$/i);
  return match ? inkReorderUrlFromBrotherCode(match[1], settings) : undefined;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function parseMonitorStatus(html: string): { message: string; level: DeviceStatusLevel } {
  const match = html.match(/<span class="moni\s+([^"]+)"[^>]*>([\s\S]*?)<\/span>/i);
  if (!match) {
    return { message: "Status unavailable", level: "unknown" };
  }
  const className = match[1];
  const message = decodeHtmlEntities(match[2].replace(/<[^>]+>/g, "").trim()) || "Status unavailable";
  let level: DeviceStatusLevel = "unknown";
  if (className.includes("moniReady")) level = "ready";
  else if (className.includes("moniWarning")) level = "warning";
  else if (className.includes("moniBusy")) level = "busy";
  else if (className.includes("moniError")) level = "error";
  return { message, level };
}

function expandBrotherStatusMessage(message: string): string {
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

function buildInkAlerts(
  ink: { cartridges: InkLevel[]; reservoir: InkLevel[] },
  settings: Settings,
): StatusAlert[] {
  const alerts: StatusAlert[] = [];
  for (const level of ink.cartridges) {
    const reorderUrl = inkReorderUrl(level.color, settings);
    if (level.percent === 0) {
      alerts.push({
        severity: "error",
        title: `${level.color} cartridge empty`,
        message: `The ${level.color.toLowerCase()} ink cartridge appears empty.`,
        reorder_url: reorderUrl,
      });
    } else if (level.low) {
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

function buildStatusAlerts(
  monitor: { message: string; level: DeviceStatusLevel },
  ink: { cartridges: InkLevel[]; reservoir: InkLevel[] },
  settings: Settings,
): StatusAlert[] {
  const alerts: StatusAlert[] = [];
  const expanded = expandBrotherStatusMessage(monitor.message);

  if (monitor.level === "ready") {
    alerts.push({
      severity: "success",
      title: "Ready to print",
      message: monitor.message === "Ready" ? "The printer is idle and ready." : expanded,
    });
  } else if (monitor.level === "busy") {
    alerts.push({
      severity: "info",
      title: "Printer busy",
      message: expanded,
    });
  } else if (monitor.level === "warning") {
    alerts.push({
      severity: "warning",
      title: "Printer needs attention",
      message: expanded,
      reorder_url: inkReorderUrlFromStatusMessage(monitor.message, settings),
    });
  } else if (monitor.level === "error") {
    alerts.push({
      severity: "error",
      title: "Printer error",
      message: expanded,
      reorder_url: inkReorderUrlFromStatusMessage(monitor.message, settings),
    });
  } else if (monitor.message !== "Status unavailable") {
    alerts.push({
      severity: "info",
      title: "Printer status",
      message: expanded,
    });
  }

  for (const inkAlert of buildInkAlerts(ink, settings)) {
    const duplicate = alerts.some(
      (alert) =>
        alert.title.toLowerCase().includes(inkAlert.title.split(" ")[0].toLowerCase()) ||
        alert.message.toLowerCase().includes(inkAlert.title.split(" ")[0].toLowerCase()),
    );
    if (!duplicate) alerts.push(inkAlert);
  }

  return alerts;
}

function parseInkLevels(html: string): { cartridges: InkLevel[]; reservoir: InkLevel[] } {
  const cartridgeSection = html.match(/<table id="inkLevel"[\s\S]*?<\/table>/i)?.[0] ?? "";
  const reservoirSection = html.match(/<table id="internalInkLevel"[\s\S]*?<\/table>/i)?.[0] ?? "";
  const headerCells = [...(cartridgeSection.match(/<tr>[\s\S]*?<\/tr>/i)?.[0] ?? "").matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map(
    (match) => match[1].toLowerCase().includes("low"),
  );
  const cartridgeHeights = [...cartridgeSection.matchAll(/class="tonerremain"[^>]*height="(\d+)"/gi)].map((m) => Number.parseInt(m[1], 10));
  const reservoirHeights = [...reservoirSection.matchAll(/class="tonerremain"[^>]*height="(\d+)"/gi)].map((m) => Number.parseInt(m[1], 10));
  const colors = ["Magenta", "Cyan", "Yellow", "Black"];
  const toLevels = (heights: number[], lows: boolean[] = []): InkLevel[] =>
    colors.map((color, index) => {
      const height = heights[index] ?? 0;
      const percent = Math.max(0, Math.min(100, Math.round((height / 48) * 100)));
      return { color, percent, low: lows[index] ?? percent <= 15 };
    });
  return {
    cartridges: toLevels(cartridgeHeights, headerCells),
    reservoir: toLevels(reservoirHeights),
  };
}

async function getPrinterStatus(host: string, settings: Settings) {
  const [statusHtml, monitorHtml] = await Promise.all([
    fetchPrinterText(host, "/home/status.html"),
    fetchPrinterText(host, "/home/monitor.html"),
  ]);
  const ink = parseInkLevels(statusHtml);
  const monitor = parseMonitorStatus(monitorHtml);
  const alerts = buildStatusAlerts(monitor, ink, settings);
  return {
    device_status: monitor.message,
    device_status_level: monitor.level,
    device_status_detail: expandBrotherStatusMessage(monitor.message),
    alerts,
    ink,
  };
}

function buildScanSettingsXml(options: ScanOptions, maxWidth: number, maxHeight: number): string {
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

function scanJobUrl(host: string, uri: string): string {
  if (uri.startsWith("http")) return uri;
  return `${printerBaseUrl(host)}${uri.startsWith("/") ? uri : `/${uri}`}`;
}

async function waitForScannerIdle(host: string, timeoutMs = 30000, required = true): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const status = await getScannerStatus(host);
    if (status.state.toLowerCase() === "idle") return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (required) {
    throw new Error("Scanner is busy. Wait a moment, then try again.");
  }
  return false;
}

async function deleteScanJob(host: string, jobUrl: string): Promise<void> {
  try {
    await fetch(jobUrl, { method: "DELETE" });
  } catch {
    // Ignore cleanup failures.
  }
}

async function cancelActiveScanJobs(host: string): Promise<number> {
  const xml = await fetchPrinterText(host, "/eSCL/ScannerStatus");
  const jobUris = [...new Set(xmlAllTagValues(xml, "JobUri"))];
  let canceled = 0;
  for (const uri of jobUris) {
    try {
      const response = await fetch(scanJobUrl(host, uri), { method: "DELETE" });
      if (response.ok) canceled += 1;
    } catch {
      // Ignore cleanup failures for stale jobs.
    }
  }
  if (canceled > 0) {
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return canceled;
}

async function ensureScannerReady(host: string): Promise<void> {
  const status = await getScannerStatus(host);
  if (status.state.toLowerCase() === "idle") return;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await cancelActiveScanJobs(host);
    const idle = await waitForScannerIdle(host, 10000, false);
    if (idle) return;
  }

  throw new Error("Scanner is busy with an earlier scan job. Wait a few seconds and try again.");
}

async function fetchNextDocument(jobUrl: string, timeoutMs = 180000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${jobUrl}/NextDocument`, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function performScan(host: string, options: ScanOptions): Promise<{ buffers: Buffer[]; contentType: string }> {
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

  const buffers: Buffer[] = [];
  let contentType: string = options.format;
  const maxPages = options.source === "platen" ? 1 : 50;

  for (let page = 0; page < maxPages; page += 1) {
    let docResponse: Response;
    try {
      docResponse = await fetchNextDocument(jobUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("abort")) {
        throw new Error("Scan timed out. Make sure the document is on the flatbed and try again.");
      }
      throw error;
    }

    if (docResponse.status === 404 || docResponse.status === 410) break;
    if (!docResponse.ok) {
      const text = await docResponse.text();
      if (page === 0) {
        throw new Error(`Failed to fetch scanned document (HTTP ${docResponse.status}): ${text.slice(0, 200)}`);
      }
      break;
    }

    const type = docResponse.headers.get("Content-Type");
    if (type) contentType = type.split(";")[0].trim();
    buffers.push(Buffer.from(await docResponse.arrayBuffer()));
    if (options.source === "platen") break;
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

function extensionForContentType(contentType: string): string {
  if (contentType.includes("pdf")) return ".pdf";
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return ".jpg";
  return ".bin";
}

async function saveScan(
  buffers: Buffer[],
  contentType: string,
  options: ScanOptions,
): Promise<ScanRecord> {
  const id = randomUUID();
  const ext = extensionForContentType(contentType);
  const filename = `${id}${buffers.length > 1 ? "-multipage" : ""}${ext}`;
  const filePath = path.join(SCANS_DIR, filename);
  const merged = buffers.length === 1 ? buffers[0] : Buffer.concat(buffers);
  await writeFile(filePath, merged);
  const createdAt = new Date().toISOString();
  const record: ScanRecord = {
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
  await writeFile(path.join(SCANS_DIR, `${id}.json`), JSON.stringify(record, null, 2));
  return record;
}

async function listScans(): Promise<ScanRecord[]> {
  if (!existsSync(SCANS_DIR)) return [];
  const files = await readdir(SCANS_DIR);
  const records: ScanRecord[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = await readFile(path.join(SCANS_DIR, file), "utf8");
      records.push(JSON.parse(raw) as ScanRecord);
    } catch {
      // ignore invalid metadata
    }
  }
  return records
    .map((record) => normalizeScanRecord(record))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

async function getScanRecord(id: string): Promise<ScanRecord | null> {
  const metaPath = path.join(SCANS_DIR, `${id}.json`);
  if (!existsSync(metaPath)) return null;
  const raw = await readFile(metaPath, "utf8");
  return normalizeScanRecord(JSON.parse(raw) as ScanRecord);
}

async function renameScan(id: string, displayName: string): Promise<ScanRecord | null> {
  const record = await getScanRecord(id);
  if (!record) return null;
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
  const updated: ScanRecord = { ...record, display_name: trimmed };
  await writeFile(path.join(SCANS_DIR, `${id}.json`), JSON.stringify(updated, null, 2));
  return updated;
}

async function deleteScan(id: string): Promise<boolean> {
  const record = await getScanRecord(id);
  if (!record) return false;
  await rm(path.join(SCANS_DIR, record.filename), { force: true });
  await rm(path.join(SCANS_DIR, `${id}.json`), { force: true });
  return true;
}

function runCommand(
  command: string,
  args: string[],
  timeoutMs = 120000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
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
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error(`Command not found: ${command}`));
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

function sortPagePaths(paths: string[]): string[] {
  return [...paths].sort((left, right) => {
    const leftMatch = left.match(/-(\d+)\.[^.]+$/);
    const rightMatch = right.match(/-(\d+)\.[^.]+$/);
    const leftNum = Number.parseInt(leftMatch?.[1] ?? "0", 10);
    const rightNum = Number.parseInt(rightMatch?.[1] ?? "0", 10);
    return leftNum - rightNum;
  });
}

async function convertImageToJpeg(inputPath: string, outputPath: string): Promise<void> {
  for (const command of ["magick", "convert"]) {
    const result = await runCommand(command, [inputPath, "-quality", "90", outputPath]);
    if (result.code === 0) return;
  }
  throw new Error("Failed to convert image to JPEG for printing.");
}

async function preparePrintPages(filePath: string): Promise<{ pages: string[]; cleanup: string[] }> {
  const ext = path.extname(filePath).toLowerCase();
  const cleanup: string[] = [];

  if (ext === ".pdf") {
    if (!existsSync(PDFTOPPM_PATH)) {
      throw new Error(
        `pdftoppm was not found at ${PDFTOPPM_PATH}. Reinstall the app so the container can install poppler-utils.`,
      );
    }
    const prefix = path.join(DATA_ROOT, `print-page-${randomUUID()}`);
    const result = await runCommand(PDFTOPPM_PATH, ["-jpeg", "-r", "300", filePath, prefix], 180000);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || "Failed to convert PDF to images for printing.");
    }
    const base = path.basename(prefix);
    const dir = path.dirname(prefix);
    const pages = sortPagePaths(
      (await readdir(dir))
        .filter((name) => name.startsWith(`${base}-`) && name.endsWith(".jpg"))
        .map((name) => path.join(dir, name)),
    );
    if (pages.length === 0) {
      throw new Error("The PDF did not produce any printable pages.");
    }
    cleanup.push(...pages);
    return { pages, cleanup };
  }

  if (ext === ".png" || ext === ".webp" || ext === ".gif") {
    const outputPath = path.join(DATA_ROOT, `print-img-${randomUUID()}.jpg`);
    await convertImageToJpeg(filePath, outputPath);
    cleanup.push(outputPath);
    return { pages: [outputPath], cleanup };
  }

  if (ext === ".jpg" || ext === ".jpeg") {
    return { pages: [filePath], cleanup: [] };
  }

  throw new Error("Unsupported file type. Upload a PDF, JPEG, or PNG.");
}

function formatPrintError(result: { stdout: string; stderr: string; code: number }): string {
  const output = `${result.stderr}\n${result.stdout}`.trim();
  if (output.includes("document-format-not-supported")) {
    return "The printer does not support this file format. Try PDF, JPEG, or PNG.";
  }
  if (output.includes("client-error")) {
    return output.split("\n").find((line) => line.includes("client-error")) ?? output;
  }
  return output || "Print command failed";
}

async function ensurePrintTools(): Promise<void> {
  if (!existsSync(IPPTOOL_PATH)) {
    throw new Error(
      `ipptool was not found at ${IPPTOOL_PATH}. Reinstall the app so the container can install the ipptool package.`,
    );
  }
  if (!existsSync(PRINT_JOB_TEST_PATH)) {
    throw new Error("Print job template is missing from the app bundle.");
  }
}

async function getPrintWarnings(host: string, options: PrintOptions, settings: Settings): Promise<string[]> {
  const warnings: string[] = [];
  try {
    const printer = await getPrinterStatus(host, settings);
    const blackCartridge = printer.ink.cartridges.find((level) => level.color === "Black");
    if (options.color === "monochrome" && blackCartridge && (blackCartridge.percent === 0 || blackCartridge.low)) {
      warnings.push(
        "Black ink is low or empty. Monochrome jobs may not print until the black cartridge is replaced.",
      );
    }
    if (printer.device_status_level === "warning" || printer.device_status_level === "error") {
      warnings.push(printer.device_status_detail);
    }
  } catch {
    // Ignore status lookup failures and still attempt printing.
  }
  return warnings;
}

async function sendIppPrintJob(
  host: string,
  filePath: string,
  options: PrintOptions,
): Promise<void> {
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

type PrintResult = {
  message: string;
  warnings: string[];
  pages_printed: number;
};

async function printFile(
  host: string,
  filePath: string,
  options: PrintOptions,
  settings: Settings,
): Promise<PrintResult> {
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
  } finally {
    await Promise.all(cleanup.map((filePath) => rm(filePath, { force: true })));
  }
}

function parseMultipart(
  contentType: string,
  body: Buffer,
): { fields: Record<string, string>; fileName: string | null; fileData: Buffer | null } {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/);
  if (!match) throw new Error("Missing multipart boundary");
  const boundary = Buffer.from(`--${match[1] ?? match[2]}`);
  const fields: Record<string, string> = {};
  let fileName: string | null = null;
  let fileData: Buffer | null = null;
  const parts = body.toString("binary").split(boundary.toString("binary"));
  for (const part of parts) {
    if (!part || part === "--\r\n" || part === "--") continue;
    const trimmed = part.replace(/^\r\n/, "").replace(/\r\n$/, "");
    const separator = trimmed.indexOf("\r\n\r\n");
    if (separator === -1) continue;
    const headers = trimmed.slice(0, separator);
    const content = trimmed.slice(separator + 4).replace(/\r\n$/, "");
    const nameMatch = headers.match(/name="([^"]+)"/i);
    const fileMatch = headers.match(/filename="([^"]*)"/i);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    if (fileMatch) {
      fileName = fileMatch[1] || "upload.bin";
      fileData = Buffer.from(content, "binary");
    } else {
      fields[name] = content;
    }
  }
  return { fields, fileName, fileData };
}

function renderPage(active: string, content: string): string {
  const nav = [
    { id: "dashboard", label: "Dashboard", href: "/" },
    { id: "scan", label: "Scan", href: "/scan" },
    { id: "print", label: "Print", href: "/print" },
    { id: "copy", label: "Copy", href: "/copy" },
    { id: "library", label: "Library", href: "/library" },
    { id: "settings", label: "Settings", href: "/settings" },
  ];
  const navHtml = nav
    .map(
      (item) =>
        `<a class="nav-link${item.id === active ? " active" : ""}" href="${item.href}">${escapeHtml(item.label)}</a>`,
    )
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
    .grid {
      display: grid;
      gap: 1rem;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
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

function dashboardContent(): string {
  return `
    <div class="toolbar">
      <h2>Dashboard</h2>
      <span class="status-pill" id="connection-pill">Checking printer…</span>
    </div>
    <div class="notifications" id="notifications" hidden></div>
    <div class="grid">
      <section class="card">
        <h3>Device</h3>
        <p class="muted" id="device-model">—</p>
        <p id="device-status" style="margin-top:0.75rem">—</p>
        <p class="muted" id="device-status-detail" style="margin-top:0.5rem">—</p>
        <p class="muted" id="device-host" style="margin-top:0.5rem">—</p>
      </section>
      <section class="card">
        <h3>Scanner</h3>
        <p id="scanner-state">—</p>
        <p class="muted" id="scanner-adf" style="margin-top:0.5rem">—</p>
      </section>
      <section class="card">
        <h3>Cartridge Ink</h3>
        <div id="ink-cartridges"></div>
      </section>
      <section class="card">
        <h3>Internal Reservoir</h3>
        <div id="ink-reservoir"></div>
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
      function inkBar(level) {
        const cls = level.color.toLowerCase();
        const lowTag = level.low ? ' <span class="muted">(low)</span>' : '';
        return '<div style="margin-bottom:0.75rem"><div style="display:flex;justify-content:space-between"><span>' + level.color + lowTag + '</span><span>' + level.percent + '%</span></div><div class="ink-bar ' + cls + '"><span style="width:' + level.percent + '%"></span></div></div>';
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
          document.getElementById("device-status").textContent = "Printer says: " + data.printer.device_status;
          document.getElementById("device-status-detail").textContent = data.printer.device_status_detail;
          document.getElementById("device-host").textContent = data.settings.printer_host;
          document.getElementById("scanner-state").textContent = "Scanner: " + data.scanner.state;
          document.getElementById("scanner-adf").textContent = "ADF: " + data.scanner.adf_state;
          document.getElementById("ink-cartridges").innerHTML = data.printer.ink.cartridges.map(inkBar).join("");
          document.getElementById("ink-reservoir").innerHTML = data.printer.ink.reservoir.map(inkBar).join("");
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

function scanContent(): string {
  return `
    <div class="toolbar"><h2>Scan</h2></div>
    <section class="card">
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
            <select id="color_mode" name="color_mode">
              <option value="RGB24">Color</option>
              <option value="Grayscale8">Grayscale</option>
              <option value="BlackAndWhite1">Black &amp; white</option>
            </select>
          </div>
          <div>
            <label for="resolution">Resolution</label>
            <select id="resolution" name="resolution">
              <option value="200">200 dpi</option>
              <option value="300" selected>300 dpi</option>
              <option value="600">600 dpi</option>
            </select>
          </div>
          <div>
            <label for="format">Format</label>
            <select id="format" name="format">
              <option value="image/jpeg">JPEG</option>
              <option value="application/pdf">PDF</option>
            </select>
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

function printContent(): string {
  return `
    <div class="toolbar"><h2>Print</h2></div>
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
            <select id="sides" name="sides">
              <option value="one-sided">One-sided</option>
              <option value="two-sided-long-edge">Two-sided (long edge)</option>
              <option value="two-sided-short-edge">Two-sided (short edge)</option>
            </select>
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
            <select id="media" name="media">
              <option value="na_letter_8.5x11in">Letter</option>
              <option value="iso_a4_210x297mm">A4</option>
              <option value="na_legal_8.5x14in">Legal</option>
              <option value="na_number-10_4.125x9.5in">Envelope #10</option>
            </select>
          </div>
        </div>
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

function copyContent(): string {
  return `
    <div class="toolbar"><h2>Copy</h2></div>
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
            <select id="sides" name="sides">
              <option value="one-sided">One-sided</option>
              <option value="two-sided-long-edge">Two-sided (long edge)</option>
            </select>
          </div>
        </div>
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

function libraryContent(): string {
  return `
    <div class="toolbar"><h2>Scan Library</h2></div>
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

function settingsContent(settings: Settings): string {
  return `
    <div class="toolbar"><h2>Settings</h2></div>
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

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  route: string,
  settings: Settings,
): Promise<boolean> {
  if (route === "/api/status" && req.method === "GET") {
    try {
      const [scanner, capabilities, printer] = await Promise.all([
        getScannerStatus(settings.printer_host),
        getScannerCapabilities(settings.printer_host),
        getPrinterStatus(settings.printer_host, settings),
      ]);
      sendJson(res, 200, { settings, scanner, capabilities, printer });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 502, { error: message, settings });
    }
    return true;
  }

  if (route === "/api/scan" && req.method === "POST") {
    try {
      const body = await readJson<Partial<ScanOptions>>(req);
      const options: ScanOptions = {
        source: body.source === "adf" ? "adf" : "platen",
        color_mode: body.color_mode ?? "RGB24",
        resolution: Number(body.resolution) || 300,
        format: body.format === "application/pdf" ? "application/pdf" : "image/jpeg",
      };
      const result = await performScan(settings.printer_host, options);
      const record = await saveScan(result.buffers, result.contentType, options);
      const previewUrl =
        result.contentType.startsWith("image/") ? `/api/scans/${record.id}/file` : undefined;
      sendJson(res, 200, { record, preview_url: previewUrl });
    } catch (error) {
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
    const filePath = path.join(SCANS_DIR, record.filename);
    if (!existsSync(filePath)) {
      sendJson(res, 404, { error: "Scan file missing" });
      return true;
    }
    const body = await readFile(filePath);
    const downloadName = `${scanDisplayName(record)}${path.extname(record.filename)}`;
    sendBytes(res, 200, record.content_type, body, downloadName);
    return true;
  }

  const scanIdMatch = route.match(/^\/api\/scans\/([^/]+)$/);
  if (scanIdMatch && req.method === "PATCH") {
    try {
      const id = decodeURIComponent(scanIdMatch[1]);
      const body = await readJson<{ display_name?: string }>(req);
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
    } catch (error) {
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
      const tempPath = path.join(DATA_ROOT, `print-${randomUUID()}-${parsed.fileName}`);
      await writeFile(tempPath, parsed.fileData);
      try {
        const options: PrintOptions = {
          copies: Number.parseInt(parsed.fields.copies ?? "1", 10) || 1,
          sides: (parsed.fields.sides as PrintOptions["sides"]) || "one-sided",
          color: parsed.fields.color === "monochrome" ? "monochrome" : "color",
          media: parsed.fields.media || "na_letter_8.5x11in",
        };
        const result = await printFile(settings.printer_host, tempPath, options, settings);
        sendJson(res, 200, result);
      } finally {
        await rm(tempPath, { force: true });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: message });
    }
    return true;
  }

  if (route === "/api/copy" && req.method === "POST") {
    try {
      const body = await readJson<Partial<ScanOptions & PrintOptions>>(req);
      const scanOptions: ScanOptions = {
        source: body.source === "adf" ? "adf" : "platen",
        color_mode: body.color_mode ?? "RGB24",
        resolution: 300,
        format: "image/jpeg",
      };
      const printOptions: PrintOptions = {
        copies: Number(body.copies) || 1,
        sides: (body.sides as PrintOptions["sides"]) || "one-sided",
        color: body.color_mode === "BlackAndWhite1" ? "monochrome" : "color",
        media: "na_letter_8.5x11in",
      };
      const scanResult = await performScan(settings.printer_host, scanOptions);
      const record = await saveScan(scanResult.buffers, scanResult.contentType, scanOptions);
      const filePath = path.join(SCANS_DIR, record.filename);
      const printResult = await printFile(settings.printer_host, filePath, printOptions, settings);
      sendJson(res, 200, {
        ...printResult,
        message: `Copied ${record.page_count} page(s) to the printer.`,
        record,
      });
    } catch (error) {
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
      const body = await readJson<Partial<Settings>>(req);
      const next: Settings = {
        printer_host: body.printer_host?.trim() || settings.printer_host,
        printer_name: body.printer_name?.trim() || settings.printer_name,
        black_ink_reorder_url: normalizeReorderUrl(body.black_ink_reorder_url, settings.black_ink_reorder_url),
        color_ink_reorder_url: normalizeReorderUrl(body.color_ink_reorder_url, settings.color_ink_reorder_url),
      };
      await saveSettings(next);
      sendJson(res, 200, next);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 400, { error: message });
    }
    return true;
  }

  return false;
}

async function main(): Promise<void> {
  await ensureDataDirs();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const route = url.pathname;
      const settings = await loadSettings();

      if (route === "/icon.svg" && req.method === "GET") {
        if (existsSync(ICON_PATH)) {
          const icon = await readFile(ICON_PATH);
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
        if (route === "/settings") {
          sendText(res, 200, renderPage("settings", settingsContent(settings)), "text/html; charset=utf-8");
          return;
        }
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
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