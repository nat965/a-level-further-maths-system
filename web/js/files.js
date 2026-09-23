// CSV reading/writing and a tiny ZIP writer (for "Export CSV"), with no dependencies.
import { TABLES } from "./service.js";

export function toCSV(rows, columns) {
  const cols = columns || [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
}

// RFC 4180 CSV -> array of objects keyed by the header row.
export function parseCSV(text) {
  text = text.replace(/^﻿/, "");
  const rows = [];
  let row = [], field = "", i = 0, quoted = false;
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (ch === '"') { quoted = false; i++; continue; }
      field += ch; i++; continue;
    }
    if (ch === '"') { quoted = true; i++; continue; }
    if (ch === ",") { row.push(field); field = ""; i++; continue; }
    if (ch === "\r" || ch === "\n") {
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += ch; i++;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, j) => [h, r[j] ?? ""])));
}

// One CSV per table (settings as key/value rows, like the desktop app's export).
export function docToCSVs(doc) {
  const out = {};
  for (const t of TABLES) out[`${t}.csv`] = toCSV(doc[t], doc[t].length ? undefined : COLUMNS[t]);
  out["settings.csv"] = toCSV(Object.entries(doc.settings || {}).map(([key, value]) => ({ key, value: JSON.stringify(value) })), ["key", "value"]);
  return out;
}

const COLUMNS = {
  chapters: ["id", "strand", "book", "ch_num", "title", "sections", "level", "summary_status", "exercises_status", "examq_status", "confidence", "first_learnt", "notes", "sort_order"],
  reviews: ["id", "chapter_id", "reviewed_on", "confidence_before", "confidence_after", "note", "created_at"],
  papers: ["id", "paper_code", "series", "sat_on", "mark", "max_mark", "time_taken_min", "notes"],
  paper_questions: ["id", "paper_id", "q_num", "chapter_id", "marks_lost", "error_type", "fix"],
  boundaries: ["id", "paper_code", "series", "a_star", "a", "b", "c", "d", "e"],
  mistakes: ["id", "logged_on", "chapter_id", "source", "what_wrong", "correct_method", "retest_on", "retest_passed", "passed_on"],
};

// ---------------------------------------------------------------- zip (stored, no compression)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zip(files, date = new Date()) {
  const enc = new TextEncoder();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const data = typeof content === "string" ? enc.encode(content) : content;
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true); local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true); local.setUint16(28, 0, true);
    locals.push(new Uint8Array(local.buffer), nameBytes, data);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true); central.setUint16(4, 20, true); central.setUint16(6, 20, true);
    central.setUint16(8, 0x0800, true); central.setUint16(10, 0, true); central.setUint16(12, dosTime, true);
    central.setUint16(14, dosDate, true); central.setUint32(16, crc, true); central.setUint32(20, data.length, true);
    central.setUint32(24, data.length, true); central.setUint16(28, nameBytes.length, true);
    central.setUint32(42, offset, true);
    centrals.push(new Uint8Array(central.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = centrals.reduce((s, b) => s + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  const n = Object.keys(files).length;
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, n, true); end.setUint16(10, n, true);
  end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((s, b) => s + b.length, 0));
  let p = 0;
  for (const b of parts) { out.set(b, p); p += b.length; }
  return out;
}
