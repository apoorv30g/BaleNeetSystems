const zlib = require("zlib");

function parseXlsx(buffer) {
  const entries = readZipEntries(buffer);
  const sharedStrings = parseSharedStrings(entries.get("xl/sharedStrings.xml") || "");
  const sheetPath = firstWorksheetPath(entries);
  if (!sheetPath) return [];
  const sheetXml = entries.get(sheetPath);
  if (!sheetXml) return [];

  const matrix = parseWorksheet(sheetXml, sharedStrings);
  const headerRowIndex = matrix.findIndex(row => row.filter(Boolean).length >= 2);
  if (headerRowIndex < 0) return [];

  const headers = matrix[headerRowIndex].map(value => String(value || "").trim());
  return matrix.slice(headerRowIndex + 1)
    .filter(row => row.some(Boolean))
    .map(row => {
      const record = {};
      headers.forEach((header, index) => {
        if (header) record[header] = row[index] || "";
      });
      return record;
    });
}

function readZipEntries(buffer) {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) throw new Error("Invalid XLSX file: zip directory not found");

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = new Map();
  let offset = centralDirOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + fileNameLength).toString("utf8").replace(/\\/g, "/");

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8
      ? zlib.inflateRawSync(compressed)
      : method === 0
        ? compressed
        : Buffer.alloc(0);

    if (data.length) entries.set(name, data.toString("utf8"));
    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function findEndOfCentralDirectory(buffer) {
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66000); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function firstWorksheetPath(entries) {
  if (entries.has("xl/worksheets/sheet1.xml")) return "xl/worksheets/sheet1.xml";
  return [...entries.keys()].filter(name => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name)).sort()[0] || "";
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(match => extractText(match[1]));
}

function parseWorksheet(xml, sharedStrings) {
  const rows = [];
  const rowMatches = xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g);
  for (const rowMatch of rowMatches) {
    const row = [];
    const cellMatches = rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g);
    for (const cellMatch of cellMatches) {
      const attrs = cellMatch[1] || "";
      const body = cellMatch[2] || "";
      const ref = attr(attrs, "r");
      const column = ref ? columnIndex(ref) : row.length;
      row[column] = readCellValue(attrs, body, sharedStrings);
    }
    rows.push(row.map(value => value || ""));
  }
  return rows;
}

function readCellValue(attrs, body, sharedStrings) {
  const type = attr(attrs, "t");
  if (type === "inlineStr") return extractText(body);

  const value = firstTag(body, "v");
  if (type === "s") return sharedStrings[Number(value || 0)] || "";
  if (type === "b") return value === "1" ? "TRUE" : "FALSE";
  if (type === "str") return decodeXml(value);
  return decodeXml(value);
}

function extractText(xml) {
  return [...String(xml || "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
    .map(match => decodeXml(match[1]))
    .join("");
}

function firstTag(xml, tag) {
  const match = String(xml || "").match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return match ? match[1] : "";
}

function attr(attrs, name) {
  const match = String(attrs || "").match(new RegExp(`${name}="([^"]*)"`));
  return match ? decodeXml(match[1]) : "";
}

function columnIndex(ref) {
  const letters = String(ref || "").replace(/[^A-Z]/gi, "").toUpperCase();
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return Math.max(0, index - 1);
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .trim();
}

module.exports = { parseXlsx };
