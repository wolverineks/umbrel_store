export type Utility = "electric" | "water";
export type Granularity = "hour" | "day";

export type ParsedReading = {
  utility: Utility;
  granularity: Granularity;
  period_start: string;
  period_end: string | null;
  value: number;
  unit: "kWh" | "gal";
  meter_id: string | null;
  account_id: string | null;
  usage_point: string | null;
  address: string | null;
};

export type ParseResult = {
  format: "hourly_csv";
  utility: Utility;
  filename: string;
  account_id: string | null;
  usage_point: string | null;
  address: string | null;
  readings: ParsedReading[];
};

function filenameUtility(filename: string): Utility | null {
  const lower = filename.toLowerCase();
  if (lower.includes("water")) return "water";
  if (lower.includes("electric")) return "electric";
  return null;
}

function filenameIds(filename: string): { account_id: string | null; usage_point: string | null } {
  const match = filename.match(/^(\d+)-(\d+)_/);
  if (!match) return { account_id: null, usage_point: null };
  return { account_id: match[1], usage_point: match[2] };
}

function parseHourlyCsv(content: string, filename: string): ParseResult {
  const { account_id, usage_point } = filenameIds(filename);
  const utility = filenameUtility(filename) ?? "electric";
  const unit: "kWh" | "gal" = utility === "water" ? "gal" : "kWh";
  const lines = content.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    throw new Error("hourly CSV is empty");
  }

  const readings: ParsedReading[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith(",") || /total/i.test(line)) continue;

    const parts = splitCsvLine(line);
    const dateLabel = parts[0]?.trim();
    if (!dateLabel || !/\d/.test(dateLabel)) continue;

    const dateParts = parseNbuDateParts(dateLabel);
    if (!dateParts) continue;

    let dayTotal = 0;
    for (let hour = 1; hour <= 24; hour++) {
      const raw = parts[hour]?.trim().replace(/,/g, "");
      if (!raw) continue;
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      dayTotal += value;

      const periodStart = nbuHourIso(dateParts.year, dateParts.month, dateParts.day, hour);
      const periodEnd = new Date(new Date(periodStart).getTime() + 3_600_000).toISOString();

      readings.push({
        utility,
        granularity: "hour",
        period_start: periodStart,
        period_end: periodEnd,
        value,
        unit,
        meter_id: null,
        account_id,
        usage_point,
        address: null,
      });
    }

    const totalRaw = parts[25]?.trim().replace(/,/g, "");
    const totalValue = totalRaw && Number.isFinite(Number(totalRaw)) ? Number(totalRaw) : dayTotal;
    const dayStart = nbuDayStartIso(dateParts.year, dateParts.month, dateParts.day);
    const dayEnd = new Date(new Date(dayStart).getTime() + 86_400_000).toISOString();

    readings.push({
      utility,
      granularity: "day",
      period_start: dayStart,
      period_end: dayEnd,
      value: totalValue,
      unit,
      meter_id: null,
      account_id,
      usage_point,
      address: null,
    });
  }

  return {
    format: "hourly_csv",
    utility,
    filename,
    account_id,
    usage_point,
    address: null,
    readings,
  };
}

function rejectTouCsv(filename: string, content: string): void {
  const lower = filename.toLowerCase();
  if (lower.includes("touusage") || lower.includes("tou_usage") || lower.includes("_tou_")) {
    throw new Error("TOU CSV is no longer supported; sync hourly CSV only");
  }

  const lines = content.trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return;

  const header = splitCsvLine(lines[0]).map((part) => part.trim());
  const headerLower = header.map((part) => part.toLowerCase());
  if (headerLower.includes("tier")) {
    throw new Error("TOU CSV is no longer supported; sync hourly CSV only");
  }

  const first = headerLower[0] ?? "";
  if (/^tier\b/.test(first) && !first.includes("date")) {
    throw new Error("TOU CSV is no longer supported; sync hourly CSV only");
  }
}

function splitCsvLine(line: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

function parseNbuDateParts(label: string): { year: number; month: number; day: number } | null {
  const match = label.trim().match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
  if (!match) return null;
  const months: Record<string, number> = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };
  const month = months[match[2].toLowerCase()];
  if (month === undefined) return null;
  return { year: Number(match[3]), month, day: Number(match[1]) };
}

function centralUtcOffsetHours(year: number, month: number, day: number): number {
  const dstStart = nthWeekdayOfMonth(year, 2, 0, 2);
  const dstEnd = nthWeekdayOfMonth(year, 10, 0, 1);
  const date = new Date(Date.UTC(year, month, day, 12, 0, 0));
  if (date >= dstStart && date < dstEnd) return 5;
  return 6;
}

function nthWeekdayOfMonth(year: number, month: number, weekday: number, nth: number): Date {
  const first = new Date(Date.UTC(year, month, 1, 2, 0, 0));
  const firstWeekday = first.getUTCDay();
  const delta = (weekday - firstWeekday + 7) % 7;
  const day = 1 + delta + (nth - 1) * 7;
  return new Date(Date.UTC(year, month, day, 2, 0, 0));
}

function nbuHourIso(year: number, month: number, day: number, hourColumn: number): string {
  const localHour = hourColumn - 1;
  const offset = centralUtcOffsetHours(year, month, day);
  return new Date(Date.UTC(year, month, day, localHour + offset, 0, 0)).toISOString();
}

/** Central-time hour slot (hour 0–23) for a YYYY-MM-DD date key. */
export function centralHourSlotIso(dateKey: string, hour: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  const offset = centralUtcOffsetHours(year, month - 1, day);
  return new Date(Date.UTC(year, month - 1, day, hour + offset, 0, 0)).toISOString();
}

function nbuDayStartIso(year: number, month: number, day: number): string {
  return nbuHourIso(year, month, day, 1);
}

function rejectHistoryCsv(filename: string, content: string): void {
  const trimmed = content.trim();
  const lower = filename.toLowerCase();
  if (/^meter #,/i.test(trimmed) || lower.includes("readinghistory")) {
    throw new Error("Billing history CSV is no longer supported; sync hourly CSV only");
  }
}

export function detectFormat(filename: string, content: string): "hourly_csv" {
  const trimmed = content.trim();
  const lower = filename.toLowerCase();
  rejectHistoryCsv(filename, content);
  if (/^date\/time,/i.test(trimmed) || lower.includes("hourlyusage") || lower.includes("hourly_usage")) {
    rejectTouCsv(filename, content);
    return "hourly_csv";
  }
  rejectTouCsv(filename, content);
  throw new Error("unsupported file format (CSV only)");
}

export function parseNbuExport(filename: string, content: string): ParseResult {
  detectFormat(filename, content);
  return parseHourlyCsv(content, filename);
}