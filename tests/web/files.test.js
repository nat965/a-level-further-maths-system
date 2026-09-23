import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toCSV, parseCSV, zip, crc32, docToCSVs } from "../../web/js/files.js";
import * as S from "../../web/js/service.js";

const SEED = JSON.parse(readFileSync(new URL("../../web/seed_chapters.json", import.meta.url), "utf8"));

test("CSV round-trips quotes, commas, newlines and unicode", () => {
  const rows = [{ a: 'He said "hi", then left', b: "line1\nline2", c: "√2 & π", d: null }, { a: "", b: "x", c: 3, d: "" }];
  const back = parseCSV(toCSV(rows));
  assert.deepEqual(back, [{ a: 'He said "hi", then left', b: "line1\nline2", c: "√2 & π", d: "" }, { a: "", b: "x", c: "3", d: "" }]);
  assert.deepEqual(parseCSV("﻿x,y\r\n1,2\r\n"), [{ x: "1", y: "2" }]);
  assert.deepEqual(parseCSV(""), []);
});

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("zip opens with a standard unzip tool and contains every table", () => {
  const doc = S.newTracker(SEED);
  S.reviewChapter(doc, "1", 3, 'note, with "quotes"', "2027-01-10");
  const files = docToCSVs(doc);
  const dir = mkdtempSync(join(tmpdir(), "rt-zip-"));
  try {
    writeFileSync(join(dir, "t.zip"), zip(files));
    const listing = execFileSync("python3", ["-c", `
import zipfile, sys, json
z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
print(json.dumps({n: z.read(n).decode() for n in z.namelist()}))`, join(dir, "t.zip")]).toString();
    const got = JSON.parse(listing);
    assert.deepEqual(Object.keys(got).sort(), ["boundaries.csv", "chapters.csv", "mistakes.csv", "paper_questions.csv",
      "papers.csv", "questions.csv", "reviews.csv", "settings.csv", "subtopics.csv"]);
    assert.equal(parseCSV(got["chapters.csv"]).length, 80);
    assert.equal(parseCSV(got["reviews.csv"])[0].note, 'note, with "quotes"');
    assert.match(got["papers.csv"], /^id,paper_code,series/); // empty tables still have headers
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exported CSVs import back into the same tracker", () => {
  const doc = S.newTracker(SEED);
  S.markLearnt(doc, "4", 2, "2027-01-10");
  S.saveSettings(doc, { mistake_retest_days: 5 });
  const files = docToCSVs(doc);
  const copy = S.newTracker(SEED);
  S.replaceTable(copy, "chapters", parseCSV(files["chapters.csv"]));
  S.replaceTable(copy, "settings", parseCSV(files["settings.csv"]));
  assert.deepEqual(copy.chapters, doc.chapters);
  assert.equal(S.settingsOf(copy).mistake_retest_days, 5);
});
