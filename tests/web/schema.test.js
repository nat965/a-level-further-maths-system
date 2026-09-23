// Runs supabase/schema.sql in real Postgres (PGlite) and checks the functions the website uses.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createBackend } from "../../tools/dev-backend.mjs";

let be;
const doc = (extra = {}) => ({ format: "revision-tracker", version: 2, chapters: [], ...extra });

before(async () => { be = await createBackend(); });
after(async () => { await be.close(); });

test("create returns a formatted code and load finds it (case, spaces, dashes ignored)", async () => {
  const code = await be.rpc("create_tracker", { p_data: doc({ note: "hi" }) });
  assert.match(code, /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  for (const typed of [code, code.toLowerCase(), code.replace(/-/g, ""), ` ${code.replace(/-/g, " ")} `]) {
    const t = await be.rpc("load_tracker", { p_code: typed });
    assert.equal(t.version, 1);
    assert.equal(t.data.note, "hi");
  }
});

test("schema.sql can be run again over an existing database without losing trackers", async () => {
  const code = await be.rpc("create_tracker", { p_data: doc({ keep: true }) });
  const { readFileSync } = await import("node:fs");
  await be.db.exec(readFileSync(new URL("../../supabase/schema.sql", import.meta.url), "utf8"));
  assert.equal((await be.rpc("load_tracker", { p_code: code })).data.keep, true);
});

test("unknown code loads nothing", async () => {
  assert.equal(await be.rpc("load_tracker", { p_code: "AAAA-BBBB-CCCC" }), null);
});

test("codes are random and trackers are separate", async () => {
  const a = await be.rpc("create_tracker", { p_data: doc({ who: "a" }) });
  const b = await be.rpc("create_tracker", { p_data: doc({ who: "b" }) });
  assert.notEqual(a, b);
  assert.equal((await be.rpc("load_tracker", { p_code: a })).data.who, "a");
  assert.equal((await be.rpc("load_tracker", { p_code: b })).data.who, "b");
});

test("save bumps the version and rejects stale versions (another device saved first)", async () => {
  const code = await be.rpc("create_tracker", { p_data: doc({ n: 0 }) });
  assert.deepEqual(await be.rpc("save_tracker", { p_code: code, p_data: doc({ n: 1 }), p_version: 1 }), { version: 2 });
  // stale version: nothing saved, told the current version (a normal answer, not an error)
  assert.deepEqual(await be.rpc("save_tracker", { p_code: code, p_data: doc({ n: 99 }), p_version: 1 }),
    { conflict: true, version: 2 });
  assert.deepEqual(await be.rpc("save_tracker", { p_code: code, p_data: doc({ n: 2 }), p_version: 2 }), { version: 3 });
  const t = await be.rpc("load_tracker", { p_code: code });
  assert.deepEqual([t.version, t.data.n], [3, 2]);
  await assert.rejects(be.rpc("save_tracker", { p_code: "ZZZZ-ZZZZ-ZZZZ", p_data: doc(), p_version: 1 }),
    /tracker_not_found/);
});

test("rejects data that isn't a tracker, or is too big", async () => {
  await assert.rejects(be.rpc("create_tracker", { p_data: { hello: 1 } }), /invalid_data/);
  const code = await be.rpc("create_tracker", { p_data: doc() });
  await assert.rejects(be.rpc("save_tracker", { p_code: code, p_data: [1, 2], p_version: 1 }), /invalid_data/);
  const huge = doc({ blob: "x".repeat(5_100_000) });
  await assert.rejects(be.rpc("save_tracker", { p_code: code, p_data: huge, p_version: 1 }), /too_large/);
});

test("first save of the day keeps a backup, and a backup can be restored", async () => {
  const code = await be.rpc("create_tracker", { p_data: doc({ n: 0 }) });
  await be.rpc("save_tracker", { p_code: code, p_data: doc({ n: 1 }), p_version: 1 });
  await be.rpc("save_tracker", { p_code: code, p_data: doc({ n: 2 }), p_version: 2 });
  let backups = await be.rpc("list_backups", { p_code: code });
  assert.equal(backups.length, 1);                  // one daily backup, taken before the first save
  assert.equal(backups[0].kind, "daily");
  const v = await be.rpc("restore_backup", { p_code: code, p_backup_id: backups[0].id });
  assert.equal(v, 4);
  assert.equal((await be.rpc("load_tracker", { p_code: code })).data.n, 0);
  backups = await be.rpc("list_backups", { p_code: code });
  assert.deepEqual(backups.map((b) => b.kind).sort(), ["daily", "pre-restore"]);
  // someone else's code can't see or restore these backups
  const other = await be.rpc("create_tracker", { p_data: doc() });
  assert.deepEqual(await be.rpc("list_backups", { p_code: other }), []);
  await assert.rejects(be.rpc("restore_backup", { p_code: other, p_backup_id: backups[0].id }), /backup_not_found/);
});

test("old daily backups are pruned after 14 days, and the site is capped at 500 trackers", async () => {
  const code = await be.rpc("create_tracker", { p_data: doc() });
  const hash = (await be.db.query("select public.rt_hash($1) h", [code])).rows[0].h;
  await be.db.query(`insert into public.tracker_backups (code_hash, kind, day, data)
                     values ($1, 'daily', current_date - 20, '{}'), ($1, 'daily', current_date - 10, '{}')`, [hash]);
  await be.rpc("save_tracker", { p_code: code, p_data: doc(), p_version: 1 });
  const days = (await be.rpc("list_backups", { p_code: code })).length;
  assert.equal(days, 2); // the 10-day-old one and today's; the 20-day-old one is gone
  const n = (await be.db.query("select count(*)::int n from public.trackers")).rows[0].n;
  await be.db.query(`insert into public.trackers (code_hash, data)
                     select 'filler' || g, '{"format":"revision-tracker"}' from generate_series(1, $1::int) g`, [500 - n]);
  await assert.rejects(be.rpc("create_tracker", { p_data: doc() }), /site is full/);
  await be.db.query("delete from public.trackers where code_hash like 'filler%'");
  assert.match(await be.rpc("create_tracker", { p_data: doc() }), /^\w{4}-\w{4}-\w{4}$/);
});

test("the public role can't touch the tables directly, only the functions", async () => {
  await be.rpc("create_tracker", { p_data: doc() });
  for (const sql of ["select * from public.trackers", "select * from public.tracker_backups",
                     "delete from public.trackers", "select public.rt_check('{}'::jsonb)"]) {
    await assert.rejects(be.db.transaction(async (tx) => {
      await tx.exec("set local role anon");
      await tx.query(sql);
    }), /permission denied/, sql);
  }
});

test("HTTP handler behaves like Supabase's REST API", async () => {
  const calls = [];
  const fakeRes = () => {
    const r = { status: 0, body: "", writeHead(s) { r.status = s; }, end(b) { r.body = b || ""; } };
    calls.push(r);
    return r;
  };
  const req = (path, body, headers = { apikey: "k" }) => {
    const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
    return { url: path, method: "POST", headers, async *[Symbol.asyncIterator]() { yield* chunks; } };
  };
  let res = fakeRes();
  await be.handle(req("/rest/v1/rpc/create_tracker", { p_data: doc() }), res);
  assert.equal(res.status, 200);
  const code = JSON.parse(res.body);
  res = fakeRes();
  await be.handle(req("/rest/v1/rpc/save_tracker", { p_code: code, p_data: doc(), p_version: 7 }), res);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { conflict: true, version: 1 });
  res = fakeRes();
  await be.handle(req("/rest/v1/rpc/save_tracker", { p_code: "ZZZZ-ZZZZ-ZZZZ", p_data: doc(), p_version: 1 }), res);
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).message, "tracker_not_found");
  res = fakeRes();
  await be.handle(req("/rest/v1/trackers", null), res);
  assert.equal(res.status, 404);
  res = fakeRes();
  await be.handle(req("/rest/v1/rpc/load_tracker", { p_code: code }, {}), res);
  assert.equal(res.status, 401);
});
