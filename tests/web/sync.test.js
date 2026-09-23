// The sync engine against the real database functions (schema.sql in PGlite), called over the
// same HTTP interface the website uses.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { createBackend } from "../../tools/dev-backend.mjs";
import { Remote, Tracker, formatCode, normalizeCode } from "../../web/js/sync.js";
import * as S from "../../web/js/service.js";

const SEED = JSON.parse(readFileSync(new URL("../../web/seed_chapters.json", import.meta.url), "utf8"));
const T = "2027-01-10";
let be, server, url;
let down = false; // simulate losing the connection

before(async () => {
  be = await createBackend();
  server = http.createServer(async (req, res) => {
    if (down) { req.socket.destroy(); return; }
    if (!(await be.handle(req, res))) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await be.close(); });

const remote = () => new Remote({ url, key: "test-key" });
const fast = { retryDelays: [20, 40] };

async function newCode() {
  return remote().create(S.newTracker(SEED));
}

test("code helpers", () => {
  assert.equal(normalizeCode(" abcd-efgh jkmn "), "ABCDEFGHJKMN");
  assert.equal(formatCode("abcdefghjkmn"), "ABCD-EFGH-JKMN");
});

test("create, open, change, and open again on another device", async () => {
  const code = await newCode();
  const a = new Tracker(remote(), code.toLowerCase(), fast);
  await a.open();
  assert.equal(a.doc.chapters.length, 80);
  a.apply((d) => S.markLearnt(d, "3", 2, T));
  a.apply((d) => S.reviewChapter(d, "3", 3, "Ex 3A", T));
  await a.flush();
  assert.equal(a.status, "saved");
  assert.equal(a.version, 3);
  const b = new Tracker(remote(), code, fast);
  await b.open();
  const c = S.getChapter(b.doc, "3", T);
  assert.deepEqual([c.first_learnt, c.confidence, c.review_count], [T, 3, 6]); // 6 subtopics
});

test("a wrong code is refused", async () => {
  await assert.rejects(new Tracker(remote(), "AAAA-BBBB-CCCC").open(), /No tracker has that code/);
});

test("invalid changes throw and change nothing", async () => {
  const t = new Tracker(remote(), await newCode(), fast);
  await t.open();
  const before = JSON.stringify(t.doc);
  assert.throws(() => t.apply((d) => S.markLearnt(d, "3", 9, T)), /Confidence/);
  assert.equal(JSON.stringify(t.doc), before);
  assert.equal(t.unsaved, false);
});

test("two devices editing at once: both changes survive", async () => {
  const code = await newCode();
  const phone = new Tracker(remote(), code, fast), laptop = new Tracker(remote(), code, fast);
  await phone.open(); await laptop.open();
  const merged = [];
  laptop.onChange = (info) => merged.push(info);
  phone.apply((d) => S.markLearnt(d, "1", 4, T));
  await phone.flush();
  laptop.apply((d) => S.createMistake(d, { chapter_id: "2", what_wrong: "sign error" }, T, { id: "m1" }));
  await laptop.flush();
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0], { merged: true, dropped: [] });
  const check = new Tracker(remote(), code);
  await check.open();
  assert.equal(S.getChapter(check.doc, "1", T).first_learnt, T);
  assert.equal(check.doc.mistakes.length, 1);
  assert.equal(check.version, 3);
});

test("a change that no longer makes sense after merging is dropped, not forced", async () => {
  const code = await newCode();
  const a = new Tracker(remote(), code, fast), b = new Tracker(remote(), code, fast);
  await a.open(); await b.open();
  a.apply((d) => S.markLearnt(d, "5", 3, T));
  await a.flush();
  const merges = [];
  b.onChange = (info) => merges.push(info);
  b.apply((d) => S.markLearnt(d, "5", 1, T));          // already learnt on the other device
  b.apply((d) => S.updateChapter(d, "6", { notes: "kept" }, T));
  await b.flush();
  assert.equal(merges[0].dropped.length, 1);
  assert.match(merges[0].dropped[0], /Already marked/);
  const check = new Tracker(remote(), code);
  await check.open();
  assert.equal(S.getChapter(check.doc, "5", T).confidence, 3);
  assert.equal(S.getChapter(check.doc, "6", T).notes, "kept");
});

test("changes made while offline save once the connection returns", async () => {
  const t = new Tracker(remote(), await newCode(), fast);
  await t.open();
  const statuses = [];
  t.onStatus = (s) => statuses.push(s);
  down = true;
  t.apply((d) => S.updateChapter(d, "9", { notes: "written on the bus" }, T));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(t.status, "offline");
  assert.equal(t.unsaved, true);
  down = false;
  await t.flush();
  assert.equal(t.status, "saved");
  assert.ok(statuses.includes("offline"));
  const check = new Tracker(remote(), t.code);
  await check.open();
  assert.equal(S.getChapter(check.doc, "9", T).notes, "written on the bus");
});

test("refresh picks up another device's changes when nothing is pending", async () => {
  const code = await newCode();
  const a = new Tracker(remote(), code, fast), b = new Tracker(remote(), code, fast);
  await a.open(); await b.open();
  a.apply((d) => S.saveSettings(d, { mistake_retest_days: 3 }));
  await a.flush();
  assert.equal(await b.refresh(), true);
  assert.equal(S.settingsOf(b.doc).mistake_retest_days, 3);
  assert.equal(await b.refresh(), false);
});

test("backups can be listed and restored through the client", async () => {
  const t = new Tracker(remote(), await newCode(), fast);
  await t.open();
  t.apply((d) => S.updateChapter(d, "1", { notes: "v2" }, T));
  await t.flush();
  const backups = await t.remote.listBackups(t.code);
  assert.equal(backups.length, 1);
  await t.remote.restoreBackup(t.code, backups[0].id);
  await t.refresh();
  assert.equal(S.getChapter(t.doc, "1", T).notes, "");
});
