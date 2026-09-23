// The browser's file client against the real database functions (over HTTP, like the website).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { createBackend } from "../../tools/dev-backend.mjs";
import { Remote } from "../../web/js/sync.js";
import { FileStore, mimeOf, toBase64, fromBase64, CHUNK_BYTES } from "../../web/js/filestore.js";

let be, server, url;
before(async () => {
  be = await createBackend();
  server = http.createServer(async (req, res) => { if (!(await be.handle(req, res))) { res.writeHead(404); res.end(); } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await be.close(); });

const remote = () => new Remote({ url, key: "k" });
const newStore = async () => {
  const code = await remote().create({ format: "revision-tracker", version: 2, chapters: [] });
  return new FileStore(remote(), code);
};

test("base64 helpers round-trip binary data", () => {
  const bytes = new Uint8Array(randomBytes(100_003));
  assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
  assert.equal(toBase64(new Uint8Array([104, 105])), "aGk=");
});

test("file types, including phone photos with no type", () => {
  assert.equal(mimeOf({ name: "scan.PDF", type: "" }), "application/pdf");
  assert.equal(mimeOf({ name: "IMG_1234.HEIC", type: "" }), "image/heic");
  assert.equal(mimeOf({ name: "photo", type: "image/jpeg" }), "image/jpeg");
});

test("upload a big PDF in chunks with progress, then download it intact", async () => {
  const fs = await newStore();
  const bytes = randomBytes(Math.floor(2.3 * CHUNK_BYTES));
  const progress = [];
  const meta = await fs.upload(new Blob([bytes], { type: "application/pdf" }), { name: "paper.pdf", onProgress: (p) => progress.push(p) });
  assert.deepEqual([meta.name, meta.mime, meta.size], ["paper.pdf", "application/pdf", bytes.length]);
  assert.deepEqual(progress.map((p) => p.toFixed(2)), ["0.33", "0.67", "1.00"]);
  const fresh = new FileStore(remote(), fs.code); // another device: nothing cached
  const blob = await fresh.get(meta.id);
  assert.equal(blob.type, "application/pdf");
  assert.ok(Buffer.from(await blob.arrayBuffer()).equals(bytes));
});

test("thumbnails in one call; missing files report clearly", async () => {
  const fs = await newStore();
  const a = await fs.upload(new Blob([randomBytes(3000)], { type: "image/jpeg" }), { name: "a.jpg" });
  const b = await fs.upload(new Blob([randomBytes(4000)], { type: "image/png" }), { name: "b.png" });
  const other = new FileStore(remote(), fs.code);
  const got = await other.getSmall([a.id, b.id, "6f1c2d3e-0000-4000-8000-000000000000"]);
  assert.deepEqual(Object.keys(got).sort(), [a.id, b.id].sort());
  assert.equal(got[b.id].size, 4000);
  await assert.rejects(other.get("6f1c2d3e-0000-4000-8000-000000000000"), /missing/);
});

test("too-big files and wrong types are refused before or at upload", async () => {
  const fs = await newStore();
  await assert.rejects(fs.upload(new Blob([new Uint8Array(10 * 1024 * 1024 + 1)]), { name: "huge.pdf", mime: "application/pdf" }), /at most 10 MB/);
  await assert.rejects(fs.upload(new Blob(["<html>"], { type: "text/html" }), { name: "x.html" }), /isn't supported/);
  await assert.rejects(fs.upload(new Blob([]), { name: "empty.jpg" }), /empty/);
});

test("delete, undelete, usage and tidying up unused files", async () => {
  const fs = await newStore();
  const keep = await fs.upload(new Blob([randomBytes(1000)], { type: "image/jpeg" }), { name: "keep.jpg" });
  const junk = await fs.upload(new Blob([randomBytes(2000)], { type: "image/jpeg" }), { name: "junk.jpg" });
  let u = await fs.usage();
  assert.deepEqual([u.bytes, u.files], [3000, 2]);
  // nothing is tidied up while it's less than a day old
  assert.equal(await fs.cleanUp(new Set([keep.id])), 0);
  assert.equal(await fs.cleanUp(new Set([keep.id]), Date.now() + 2 * 86400000), 1);
  u = await fs.usage();
  assert.deepEqual([u.bytes, u.files], [1000, 1]);
  assert.equal(await fs.undelete([junk.id]), 1);
  assert.equal((await fs.usage()).files, 2);
  assert.equal(await fs.remove([keep.id, junk.id]), 2);
  assert.equal((await fs.usage()).files, 0);
});

test("an out-of-date database gets a clear message", async () => {
  const old = { call: async () => { const e = new Error("Could not find the function public.put_file_chunk(p_chunks, ...) in the schema cache"); throw e; } };
  const fs = new FileStore(old, "AAAA-BBBB-CCCC");
  await assert.rejects(fs.upload(new Blob([new Uint8Array(5)]), { name: "a.jpg", mime: "image/jpeg" }), /run supabase\/schema.sql again/);
});
