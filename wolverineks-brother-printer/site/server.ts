import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const APP_VERSION = "1.0.2";
const DATA_ROOT = process.env.PRINTER_DATA_DIR ?? "/data";
const SCANS_DIR = path.join(DATA_ROOT, "scans");
const SETTINGS_PATH = path.join(DATA_ROOT, "settings.json");
const ICON_PATH = path.join(__dirname, "icon.svg");

const ESCL_NS = "http://schemas.hp.com/imaging/escl/2011/05/03";
const PWG_NS = "http://www.pwg.org/schemas/2010/12/sm";

type Settings = {
  printer_host: string;
  printer_name: string;
};

type ScanRecord = {
  id: string;
  filename: string;
  content_type: string;
  source: "platen" | "adf";
  color_mode: string;
  resolution: number;
  format: string;
  page_count: number;
  created_at: string;
};

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

const DEFAULT_SETTINGS: Settings = {
  printer_host: process.env.PRINTER_HOST?.trim() || "192.168.86.31",
  printer_name: "Brother MFC-J1360DW",
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
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(settings: Settings): Promise<void> {
  await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2));
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
};

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
    const colorMap: Record<string, string> = {
      BK: "Black",
      M: "Magenta",
      C: "Cyan",
      Y: "Yellow",
    };
    const code = inkLowMatch[1].trim().toUpperCase();
    const color = colorMap[code] ?? code;
    return `${color} ink is low. Replace or refill the ${color.toLowerCase()} ink cartridge.`;
  }
  const inkEmptyMatch = normalized.match(/^Ink Empty \(([^)]+)\)$/i);
  if (inkEmptyMatch) {
    const colorMap: Record<string, string> = {
      BK: "Black",
      M: "Magenta",
      C: "Cyan",
      Y: "Yellow",
    };
    const code = inkEmptyMatch[1].trim().toUpperCase();
    const color = colorMap[code] ?? code;
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

function buildInkAlerts(ink: { cartridges: InkLevel[]; reservoir: InkLevel[] }): StatusAlert[] {
  const alerts: StatusAlert[] = [];
  for (const level of ink.cartridges) {
    if (level.percent === 0) {
      alerts.push({
        severity: "error",
        title: `${level.color} cartridge empty`,
        message: `The ${level.color.toLowerCase()} ink cartridge appears empty.`,
      });
    } else if (level.low) {
      alerts.push({
        severity: "warning",
        title: `${level.color} cartridge low`,
        message: `The ${level.color.toLowerCase()} ink cartridge is running low (${level.percent}%).`,
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
    });
  } else if (monitor.level === "error") {
    alerts.push({
      severity: "error",
      title: "Printer error",
      message: expanded,
    });
  } else if (monitor.message !== "Status unavailable") {
    alerts.push({
      severity: "info",
      title: "Printer status",
      message: expanded,
    });
  }

  for (const inkAlert of buildInkAlerts(ink)) {
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

async function getPrinterStatus(host: string) {
  const [statusHtml, monitorHtml] = await Promise.all([
    fetchPrinterText(host, "/home/status.html"),
    fetchPrinterText(host, "/home/monitor.html"),
  ]);
  const ink = parseInkLevels(statusHtml);
  const monitor = parseMonitorStatus(monitorHtml);
  const alerts = buildStatusAlerts(monitor, ink);
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

async function waitForScannerIdle(host: string, timeoutMs = 120000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const status = await getScannerStatus(host);
    if (status.state.toLowerCase() === "idle") return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Scanner did not become idle in time");
}

async function pollScanJob(jobUrl: string, timeoutMs = 180000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await fetch(jobUrl, { method: "GET" });
    const xml = await response.text();
    const state = (xmlTagValue(xml, "JobState") ?? xmlTagValue(xml, "State") ?? "").toLowerCase();
    if (state === "completed" || state === "canceled") return;
    if (state === "aborted" || state === "failed") {
      throw new Error(`Scan job failed with state: ${state}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Scan job timed out");
}

async function performScan(host: string, options: ScanOptions): Promise<{ buffers: Buffer[]; contentType: string }> {
  const capabilities = await getScannerCapabilities(host);
  const status = await getScannerStatus(host);
  if (status.state.toLowerCase() !== "idle") {
    throw new Error(`Scanner is ${status.state}. Try again in a moment.`);
  }
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

  let jobUrl = createResponse.headers.get("Location");
  if (!jobUrl && (createResponse.status === 201 || createResponse.status === 200)) {
    jobUrl = createResponse.headers.get("location");
  }
  if (!jobUrl) {
    const body = await createResponse.text();
    throw new Error(`Failed to create scan job (HTTP ${createResponse.status}): ${body.slice(0, 200)}`);
  }

  if (!jobUrl.startsWith("http")) {
    jobUrl = `${esclBaseUrl(host)}${jobUrl.startsWith("/") ? "" : "/"}${jobUrl}`;
  }

  await pollScanJob(jobUrl);

  const buffers: Buffer[] = [];
  let contentType: string = options.format;
  for (let page = 0; page < 50; page += 1) {
    const docResponse = await fetch(`${jobUrl}/NextDocument`);
    if (docResponse.status === 404 || docResponse.status === 410) break;
    if (!docResponse.ok) {
      const text = await docResponse.text();
      if (page === 0) throw new Error(`Failed to fetch scanned document: ${text.slice(0, 200)}`);
      break;
    }
    const type = docResponse.headers.get("Content-Type");
    if (type) contentType = type.split(";")[0].trim();
    buffers.push(Buffer.from(await docResponse.arrayBuffer()));
    if (options.source === "platen") break;
  }

  if (buffers.length === 0) {
    throw new Error("No scanned pages were returned by the printer.");
  }

  await waitForScannerIdle(host, 30000);
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
  const record: ScanRecord = {
    id,
    filename,
    content_type: contentType,
    source: options.source,
    color_mode: options.color_mode,
    resolution: options.resolution,
    format: options.format,
    page_count: buffers.length,
    created_at: new Date().toISOString(),
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
  return records.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

async function getScanRecord(id: string): Promise<ScanRecord | null> {
  const metaPath = path.join(SCANS_DIR, `${id}.json`);
  if (!existsSync(metaPath)) return null;
  const raw = await readFile(metaPath, "utf8");
  return JSON.parse(raw) as ScanRecord;
}

async function deleteScan(id: string): Promise<boolean> {
  const record = await getScanRecord(id);
  if (!record) return false;
  await rm(path.join(SCANS_DIR, record.filename), { force: true });
  await rm(path.join(SCANS_DIR, `${id}.json`), { force: true });
  return true;
}

function runCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

async function ensurePrinterQueue(host: string): Promise<string> {
  const queueName = `brother_${host.replace(/[^a-zA-Z0-9]/g, "_")}`;
  const uri = ippUri(host);
  await runCommand("lpadmin", ["-p", queueName, "-E", "-v", uri, "-m", "everywhere", "-o", "printer-is-shared=false"]);
  return queueName;
}

async function printFile(host: string, filePath: string, options: PrintOptions): Promise<void> {
  const queueName = await ensurePrinterQueue(host);
  const args = [
    "-d",
    queueName,
    "-n",
    String(Math.max(1, Math.min(999, options.copies))),
    "-o",
    `sides=${options.sides}`,
    "-o",
    `print-color-mode=${options.color}`,
    "-o",
    `media=${options.media}`,
    filePath,
  ];
  const result = await runCommand("lp", args);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "Print command failed");
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
    .scan-list, .library-list {
      display: grid;
      gap: 0.75rem;
    }
    .scan-item, .library-item {
      display: flex;
      justify-content: space-between;
      gap: 1rem;
      align-items: center;
      padding: 1rem;
      border: 1px solid var(--border);
      border-radius: 0.9rem;
      background: var(--panel);
    }
    .preview {
      margin-top: 1rem;
      max-width: 100%;
      border-radius: 0.75rem;
      border: 1px solid var(--border);
    }
    @media (max-width: 900px) {
      .layout { grid-template-columns: 1fr; }
      .sidebar { position: static; height: auto; }
      .sidebar-footer { position: static; margin-top: 1rem; }
    }
  </style>
</head>
<body>
  <div class="layout">
    <aside class="sidebar">
      <div class="brand">
        <img src="/icon.svg" alt="" />
        <div>
          <h1>Brother Print &amp; Scan</h1>
          <p>MFC-J1360DW</p>
        </div>
      </div>
      <nav>${navHtml}</nav>
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
    document.getElementById("refresh-status")?.addEventListener("click", () => {
      if (typeof window.refreshDashboard === "function") window.refreshDashboard();
      else location.reload();
    });
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
          '<div class="notification ' + alert.severity + '"><strong>' + alert.title + '</strong><span>' + alert.message + '</span></div>'
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
        message.textContent = "Scanning… place your document on the flatbed or in the ADF.";
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
          message.textContent = data.message || "Print job submitted.";
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
      <div class="library-list" id="library-list"></div>
      <p class="muted" id="library-empty" hidden>No saved scans yet.</p>
    </section>
    <script>
      async function loadLibrary() {
        const list = document.getElementById("library-list");
        const empty = document.getElementById("library-empty");
        const res = await fetch("/api/scans");
        const data = await res.json();
        if (!data.scans.length) {
          list.innerHTML = "";
          empty.hidden = false;
          return;
        }
        empty.hidden = true;
        list.innerHTML = data.scans.map((scan) => {
          const when = new Date(scan.created_at).toLocaleString();
          return '<div class="library-item"><div><strong>' + scan.filename + '</strong><div class="muted">' + scan.source + ' · ' + scan.resolution + ' dpi · ' + when + '</div></div><div class="actions"><a class="button secondary" href="/api/scans/' + scan.id + '/file">Download</a><button class="secondary" data-id="' + scan.id + '" type="button">Delete</button></div></div>';
        }).join("");
        list.querySelectorAll("button[data-id]").forEach((button) => {
          button.addEventListener("click", async () => {
            if (!confirm("Delete this scan?")) return;
            await fetch("/api/scans/" + button.dataset.id, { method: "DELETE" });
            loadLibrary();
          });
        });
      }
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
        getPrinterStatus(settings.printer_host),
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
    sendBytes(res, 200, record.content_type, body, record.filename);
    return true;
  }

  const scanDeleteMatch = route.match(/^\/api\/scans\/([^/]+)$/);
  if (scanDeleteMatch && req.method === "DELETE") {
    const id = decodeURIComponent(scanDeleteMatch[1]);
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
        await printFile(settings.printer_host, tempPath, options);
        sendJson(res, 200, { message: "Print job submitted to the printer." });
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
      const result = await performScan(settings.printer_host, scanOptions);
      const record = await saveScan(result.buffers, result.contentType, scanOptions);
      const filePath = path.join(SCANS_DIR, record.filename);
      await printFile(settings.printer_host, filePath, printOptions);
      sendJson(res, 200, {
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