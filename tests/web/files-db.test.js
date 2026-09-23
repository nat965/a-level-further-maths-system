// Question files in the database (schema.sql in PGlite): upload in chunks, read back, privacy,
// limits, deleting and restoring.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { createBackend } from "../../tools/dev-backend.mjs";

let be;
const doc = () => ({ format: "revision-tracker", version: 2, chapters: [] });
const b64 = (buf) => Buffer.from(buf).toString("base64");
const MB = 1024 * 1024;

before(async () => { be = await createBackend(); });
after(async () => { await be.close(); });

async function upload(code, bytes, { mime = "image/jpeg", name = "q.jpg", chunk = MB, id = randomUUID() } = {}) {
  const chunks = Math.max(1, Math.ceil(bytes.length / chunk));
  let r;
  for (let i = 0; i < chunks; i++) {
    r = await be.rpc("put_file_chunk", { p_code: code, p_file_id: id, p_seq: i, p_chunks: chunks, p_name: name,
      p_mime: mime, p_size: bytes.length, p_data: b64(bytes.subarray(i * chunk, (i + 1) * chunk)) });
  }
  return { id, last: r };
}

async function download(code, id) {
  const first = await be.rpc("get_file_chunk", { p_code: code, p_file_id: id, p_seq: 0 });
  if (!first) return null;
  const parts = [Buffer.from(first.data, "base64")];
  for (let i = 1; i < first.chunks; i++) {
    parts.push(Buffer.from((await be.rpc("get_file_chunk", { p_code: code, p_file_id: id, p_seq: i })).data, "base64"));
  }
  return { ...first, bytes: Buffer.concat(parts) };
}

test("a multi-chunk file uploads and comes back byte-for-byte", async () => {
  const code = await be.rpc("create_tracker", { p_data: doc() });
  const bytes = randomBytes(Math.floor(2.5 * MB));
  const { id, last } = await upload(code, bytes, { mime: "application/pdf", name: "June 2019 Q8.pdf" });
  assert.deepEqual(last, { complete: true, received: 3 });
  const got = await download(code, id);
  assert.deepEqual([got.name, got.mime, got.size, got.chunks], ["June 2019 Q8.pdf", "application/pdf", bytes.length, 3]);
  assert.ok(got.bytes.equals(bytes));
});

test("unfinished uploads can't be read, and resending a chunk is harmless", async () => {
  const code = await be.rpc("create_tracker", { p_data: doc() });
  const bytes = randomBytes(MB + 10);
  const id = randomUUID();
  const args = (i) => ({ p_code: code, p_file_id: id, p_seq: i, p_chunks: 2, p_name: "a.png", p_mime: "image/png",
    p_size: bytes.length, p_data: b64(bytes.subarray(i * MB, (i + 1) * MB)) });
  assert.deepEqual(await be.rpc("put_file_chunk", args(0)), { complete: false, received: 1 });
  assert.equal(await be.rpc("get_file_chunk", { p_code: code, p_file_id: id, p_seq: 0 }), null);
  assert.deepEqual(await be.rpc("put_file_chunk", args(0)), { complete: false, received: 1 }); // retry
  assert.deepEqual(await be.rpc("put_file_chunk", args(1)), { complete: true, received: 2 });
  assert.ok((await download(code, id)).bytes.equals(bytes));
  await assert.rejects(be.rpc("put_file_chunk", args(1)), /file_exists/);
});

test("files are private to their tracker's code", async () => {
  const mine = await be.rpc("create_tracker", { p_data: doc() });
  const theirs = await be.rpc("create_tracker", { p_data: doc() });
  const { id } = await upload(mine, randomBytes(1000));
  assert.equal(await be.rpc("get_file_chunk", { p_code: theirs, p_file_id: id, p_seq: 0 }), null);
  assert.deepEqual(await be.rpc("get_small_files", { p_code: theirs, p_file_ids: [id] }), {});
  assert.equal(await be.rpc("delete_files", { p_code: theirs, p_file_ids: [id] }), 0);
  assert.equal((await be.rpc("list_files", { p_code: theirs })).length, 0);
  assert.ok(await be.rpc("get_file_chunk", { p_code: mine, p_file_id: id, p_seq: 0 }));
  await assert.rejects(upload("AAAA-BBBB-CCCC", randomBytes(10)), /tracker_not_found/);
  for (const sql of ["select * from public.tracker_files", "select * from public.tracker_file_chunks"]) {
    await assert.rejects(be.db.transaction(async (tx) => { await tx.exec("set local role anon"); await tx.query(sql); }),
      /permission denied/);
  }
});

test("only photos and PDFs, at most 10 MB, well-formed chunks", async () => {
  const code = await be.rpc("create_tracker", { p_data: doc() });
  await assert.rejects(upload(code, randomBytes(100), { mime: "text/html", name: "x.html" }), /isn't supported/);
  await assert.rejects(be.rpc("put_file_chunk", { p_code: code, p_file_id: randomUUID(), p_seq: 0, p_chunks: 12,
    p_name: "big.pdf", p_mime: "application/pdf", p_size: 11 * MB, p_data: b64(randomBytes(10)) }), /at most 10 MB/);
  await assert.rejects(upload(code, randomBytes(100), { chunk: 50, id: "not-a-uuid" }), /uuid/);
  await assert.rejects(be.rpc("put_file_chunk", { p_code: code, p_file_id: randomUUID(), p_seq: 3, p_chunks: 2,
    p_name: "x.jpg", p_mime: "image/jpeg", p_size: 10, p_data: b64(randomBytes(10)) }), /invalid_chunk/);
  // a file whose chunks don't add up to the size it claimed is rejected
  await assert.rejects(be.rpc("put_file_chunk", { p_code: code, p_file_id: randomUUID(), p_seq: 0, p_chunks: 1,
    p_name: "x.jpg", p_mime: "image/jpeg", p_size: 999, p_data: b64(randomBytes(10)) }), /size_mismatch/);
});

test("thumbnails come back in one call", async () => {
  const code = await be.rpc("create_tracker", { p_data: doc() });
  const a = await upload(code, randomBytes(5000));
  const b = await upload(code, randomBytes(8000), { mime: "image/png" });
  const big = await upload(code, randomBytes(300 * 1024));
  const got = await be.rpc("get_small_files", { p_code: code, p_file_ids: [a.id, b.id, big.id, randomUUID()] });
  assert.deepEqual(Object.keys(got).sort(), [a.id, b.id].sort());
  assert.equal(got[b.id].mime, "image/png");
  assert.equal(Buffer.from(got[a.id].data, "base64").length, 5000);
});

test("deleted files stay readable (for restored backups), can be undeleted, and free up quota", async () => {
  const code = await be.rpc("create_tracker", { p_data: doc() });
  const { id } = await upload(code, randomBytes(2000));
  assert.equal(await be.rpc("delete_files", { p_code: code, p_file_ids: [id] }), 1);
  assert.ok(await be.rpc("get_file_chunk", { p_code: code, p_file_id: id, p_seq: 0 }));
  assert.ok((await be.rpc("list_files", { p_code: code }))[0].deleted_at);
  assert.equal(await be.rpc("undelete_files", { p_code: code, p_file_ids: [id] }), 1);
  assert.equal((await be.rpc("list_files", { p_code: code }))[0].deleted_at, null);
  // files deleted over 14 days ago and uploads abandoned for a day are purged
  await be.rpc("delete_files", { p_code: code, p_file_ids: [id] });
  const hash = (await be.db.query("select public.rt_hash($1) h", [code])).rows[0].h;
  await be.db.query("update public.tracker_files set deleted_at = now() - interval '15 days' where code_hash = $1", [hash]);
  const stale = randomUUID();
  await be.rpc("put_file_chunk", { p_code: code, p_file_id: stale, p_seq: 0, p_chunks: 2, p_name: "x.jpg",
    p_mime: "image/jpeg", p_size: MB + 1, p_data: b64(randomBytes(MB)) });
  await be.db.query("update public.tracker_files set created_at = now() - interval '2 days' where file_id = $1", [stale]);
  await upload(code, randomBytes(10)); // any new upload tidies up
  const left = await be.rpc("list_files", { p_code: code });
  assert.equal(left.length, 1);
  assert.equal(left[0].size, 10);
});

test("each tracker gets 100 MB and the whole site 350 MB", async () => {
  const code = await be.rpc("create_tracker", { p_data: doc() });
  const hash = (await be.db.query("select public.rt_hash($1) h", [code])).rows[0].h;
  // pretend this tracker already holds 99.9 MB
  await be.db.query(`insert into public.tracker_files (code_hash, file_id, name, mime, size, chunks, complete)
                     values ($1, $2, 'old.pdf', 'application/pdf', $3, 1, true)`, [hash, randomUUID(), 100 * MB - 500]);
  await assert.rejects(upload(code, randomBytes(1000)), /storage is full \(100 MB\)/);
  const small = await upload(code, randomBytes(400));
  assert.equal(small.last.complete, true);
  // deleting frees space for this tracker
  await be.db.query("update public.tracker_files set deleted_at = now() where code_hash = $1 and name = 'old.pdf'", [hash]);
  assert.equal((await upload(code, randomBytes(1000))).last.complete, true);
  // site-wide cap
  const other = await be.rpc("create_tracker", { p_data: doc() });
  const otherHash = (await be.db.query("select public.rt_hash($1) h", [other])).rows[0].h;
  const used = (await be.db.query("select coalesce(sum(size),0)::bigint n from public.tracker_files")).rows[0].n;
  await be.db.query(`insert into public.tracker_files (code_hash, file_id, name, mime, size, chunks, complete)
                     values ($1, $2, 'filler', 'application/pdf', $3, 1, true)`, [otherHash, randomUUID(), 350 * MB - Number(used) - 100]);
  await assert.rejects(upload(code, randomBytes(1000)), /site's file storage is full/);
  await be.db.query("delete from public.tracker_files where name = 'filler'");
});

test("deleting a tracker deletes its files", async () => {
  const code = await be.rpc("create_tracker", { p_data: doc() });
  await upload(code, randomBytes(3000));
  const hash = (await be.db.query("select public.rt_hash($1) h", [code])).rows[0].h;
  await be.db.query("delete from public.trackers where code_hash = $1", [hash]);
  const n = (await be.db.query("select count(*)::int n from public.tracker_file_chunks where code_hash = $1", [hash])).rows[0].n;
  assert.equal(n, 0);
});
