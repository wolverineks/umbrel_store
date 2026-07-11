"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.centralHourSlotIso = centralHourSlotIso;
exports.detectFormat = detectFormat;
exports.parseNbuExport = parseNbuExport;
const ESPI_NS = "http://naesb.org/espi";
function filenameUtility(filename) {
    const lower = filename.toLowerCase();
    if (lower.includes("water"))
        return "water";
    if (lower.includes("electric"))
        return "electric";
    return null;
}
function filenameIds(filename) {
    const match = filename.match(/^(\d+)-(\d+)_/);
    if (!match)
        return { account_id: null, usage_point: null };
    return { account_id: match[1], usage_point: match[2] };
}
function parseXmlTag(block, tag) {
    const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
    return match ? match[1].trim() : null;
}
function parseXmlBlocks(xml, tag) {
    const blocks = [];
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "g");
    let match;
    while ((match = re.exec(xml)) !== null) {
        blocks.push(match[0]);
    }
    return blocks;
}
function whToKwh(value, powerOfTenMultiplier = 0) {
    const scaled = value * Math.pow(10, powerOfTenMultiplier);
    return scaled / 1000;
}
function unixToIso(seconds) {
    return new Date(seconds * 1000).toISOString();
}
function parseGreenButtonXml(content, filename) {
    const { account_id, usage_point } = filenameIds(filename);
    const utility = filenameUtility(filename) ?? "electric";
    let address = null;
    const usagePointEntry = xmlEntryByHref(content, /UsagePoint\/\d+"/);
    if (usagePointEntry) {
        const title = parseXmlTag(usagePointEntry, "title");
        if (title) {
            address = title.replace(/\s+/g, " ").trim();
        }
        const kind = parseXmlTag(usagePointEntry, "kind");
        if (kind) {
            // kind 0 = electricity in ESPI
        }
    }
    const readingTypeBlock = xmlEntryByHref(content, /ReadingType\/\d+"/);
    let powerOfTenMultiplier = 0;
    let unit = "kWh";
    if (readingTypeBlock) {
        const readingTypeContent = parseXmlTag(readingTypeBlock, "content") ?? readingTypeBlock;
        const multiplier = parseXmlTag(readingTypeContent, "powerOfTenMultiplier");
        if (multiplier)
            powerOfTenMultiplier = Number(multiplier);
        const uom = parseXmlTag(readingTypeContent, "uom");
        if (uom === "119")
            unit = "gal";
    }
    const readings = [];
    for (const block of parseXmlBlocks(content, "IntervalBlock")) {
        for (const readingBlock of parseXmlBlocks(block, "IntervalReading")) {
            const start = Number(parseXmlTag(readingBlock, "start") ?? "0");
            const duration = Number(parseXmlTag(readingBlock, "duration") ?? "3600");
            const rawValue = Number(parseXmlTag(readingBlock, "value") ?? "0");
            const value = unit === "kWh" ? whToKwh(rawValue, powerOfTenMultiplier) : rawValue * Math.pow(10, powerOfTenMultiplier);
            readings.push({
                utility,
                granularity: duration >= 86400 ? "day" : "hour",
                period_start: unixToIso(start),
                period_end: unixToIso(start + duration),
                value,
                unit,
                meter_id: null,
                account_id,
                usage_point,
                address,
            });
        }
    }
    return {
        format: "greenbutton_xml",
        utility,
        filename,
        account_id,
        usage_point,
        address,
        readings,
    };
}
function xmlEntryByHref(xml, hrefPattern) {
    const entries = parseXmlBlocks(xml, "entry");
    for (const entry of entries) {
        if (hrefPattern.test(entry))
            return entry;
    }
    return null;
}
function parseHourlyCsv(content, filename) {
    const { account_id, usage_point } = filenameIds(filename);
    const utility = filenameUtility(filename) ?? "electric";
    const unit = utility === "water" ? "gal" : "kWh";
    const lines = content.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) {
        throw new Error("hourly CSV is empty");
    }
    const readings = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line.startsWith(",") || /total/i.test(line))
            continue;
        const parts = splitCsvLine(line);
        const dateLabel = parts[0]?.trim();
        if (!dateLabel || !/\d/.test(dateLabel))
            continue;
        const dateParts = parseNbuDateParts(dateLabel);
        if (!dateParts)
            continue;
        let dayTotal = 0;
        for (let hour = 1; hour <= 24; hour++) {
            const raw = parts[hour]?.trim().replace(/,/g, "");
            if (!raw)
                continue;
            const value = Number(raw);
            if (!Number.isFinite(value))
                continue;
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
function parseHistoryCsv(content, filename) {
    const { account_id, usage_point } = filenameIds(filename);
    const utility = filenameUtility(filename) ?? "electric";
    const lines = content.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) {
        throw new Error("history CSV is empty");
    }
    const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
    const idx = {
        meter: header.indexOf("meter #"),
        readDate: header.indexOf("read date"),
        days: header.indexOf("# of days"),
        readType: header.indexOf("read type"),
        usage: header.indexOf("usage"),
        unit: header.indexOf("unit measure"),
    };
    const readings = [];
    for (let i = 1; i < lines.length; i++) {
        const parts = splitCsvLine(lines[i]);
        const readType = parts[idx.readType]?.trim();
        if (readType !== "MR")
            continue;
        const usage = Number(parts[idx.usage]?.trim());
        if (!Number.isFinite(usage) || usage < 0)
            continue;
        const meterId = parts[idx.meter]?.trim() || null;
        const readDate = parts[idx.readDate]?.trim();
        const days = Number(parts[idx.days]?.trim() ?? "0");
        const unitLabel = parts[idx.unit]?.trim().toLowerCase();
        const unit = unitLabel === "gal" || unitLabel === "gallons" ? "gal" : "kWh";
        const periodEnd = parseIsoDate(readDate);
        if (!periodEnd)
            continue;
        const periodStart = new Date(periodEnd);
        if (days > 0) {
            periodStart.setUTCDate(periodStart.getUTCDate() - days);
        }
        readings.push({
            utility,
            granularity: "billing_period",
            period_start: periodStart.toISOString(),
            period_end: periodEnd.toISOString(),
            value: usage,
            unit,
            meter_id: meterId,
            account_id,
            usage_point,
            address: null,
        });
    }
    return {
        format: "history_csv",
        utility,
        filename,
        account_id,
        usage_point,
        address: null,
        readings,
    };
}
function splitCsvLine(line) {
    const parts = [];
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
function parseNbuDateParts(label) {
    const match = label.trim().match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
    if (!match)
        return null;
    const months = {
        jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
        jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    };
    const month = months[match[2].toLowerCase()];
    if (month === undefined)
        return null;
    return { year: Number(match[3]), month, day: Number(match[1]) };
}
function centralUtcOffsetHours(year, month, day) {
    const dstStart = nthWeekdayOfMonth(year, 2, 0, 2);
    const dstEnd = nthWeekdayOfMonth(year, 10, 0, 1);
    const date = new Date(Date.UTC(year, month, day, 12, 0, 0));
    if (date >= dstStart && date < dstEnd)
        return 5;
    return 6;
}
function nthWeekdayOfMonth(year, month, weekday, nth) {
    const first = new Date(Date.UTC(year, month, 1, 2, 0, 0));
    const firstWeekday = first.getUTCDay();
    const delta = (weekday - firstWeekday + 7) % 7;
    const day = 1 + delta + (nth - 1) * 7;
    return new Date(Date.UTC(year, month, day, 2, 0, 0));
}
function nbuHourIso(year, month, day, hourColumn) {
    const localHour = hourColumn - 1;
    const offset = centralUtcOffsetHours(year, month, day);
    return new Date(Date.UTC(year, month, day, localHour + offset, 0, 0)).toISOString();
}
/** Central-time hour slot (hour 0–23) for a YYYY-MM-DD date key. */
function centralHourSlotIso(dateKey, hour) {
    const [year, month, day] = dateKey.split("-").map(Number);
    const offset = centralUtcOffsetHours(year, month - 1, day);
    return new Date(Date.UTC(year, month - 1, day, hour + offset, 0, 0)).toISOString();
}
function nbuDayStartIso(year, month, day) {
    return nbuHourIso(year, month, day, 1);
}
function parseIsoDate(label) {
    const parsed = new Date(label);
    if (Number.isNaN(parsed.getTime()))
        return null;
    return parsed;
}
function detectFormat(filename, content) {
    const lower = filename.toLowerCase();
    if (lower.endsWith(".xml") || content.includes(`xmlns="${ESPI_NS}"`)) {
        return "greenbutton_xml";
    }
    if (lower.includes("hourly_usage") || /^date\/time,/i.test(content.trim())) {
        return "hourly_csv";
    }
    if (lower.includes("readinghistory") || /^meter #,/i.test(content.trim())) {
        return "history_csv";
    }
    throw new Error("unsupported file format");
}
function parseNbuExport(filename, content) {
    const format = detectFormat(filename, content);
    if (format === "greenbutton_xml")
        return parseGreenButtonXml(content, filename);
    if (format === "hourly_csv")
        return parseHourlyCsv(content, filename);
    return parseHistoryCsv(content, filename);
}
