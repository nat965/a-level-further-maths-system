// A stand-in for Supabase used by the tests and local development: the real schema.sql runs
// in PGlite (Postgres compiled to WebAssembly) and HTTP calls are answered the way Supabase's
// REST API answers them (POST /rest/v1/rpc/<function> with a JSON object of named arguments).
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

const SCHEMA = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");

// Functions the website may call, with their argument names and SQL types.
const RPC = {
  create_tracker: { p_data: "jsonb" },
  load_tracker: { p_code: "text" },
  save_tracker: { p_code: "text", p_data: "jsonb", p_version: "integer" },
  list_backups: { p_code: "text" },
  backup_tracker: { p_code: "text" },
  put_file_chunk: { p_code: "text", p_file_id: "text", p_seq: "integer", p_chunks: "integer", p_name: "text",
                    p_mime: "text", p_size: "integer", p_data: "text" },
  get_file_chunk: { p_code: "text", p_file_id: "text", p_seq: "integer" },
  get_small_files: { p_code: "text", p_file_ids: "jsonb" },
  delete_files: { p_code: "text", p_file_ids: "jsonb" },
  undelete_files: { p_code: "text", p_file_ids: "jsonb" },
  list_files: { p_code: "text" },
  restore_backup: { p_code: "text", p_backup_id: "bigint" },
};

export async function createBackend({ dataDir } = {}) {
  const db = await PGlite.create({ ...(dataDir ? { dataDir } : {}), extensions: { pgcrypto } });
  // Supabase has these roles already; create them so the grants in schema.sql apply.
  await db.exec(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    end $$;`);
  await db.exec(SCHEMA);

  // Calls run as the anon role, like a browser using the public key does on Supabase.
  async function rpc(name, args) {
    const spec = RPC[name];
    if (!spec) throw Object.assign(new Error(`Could not find the function public.${name}`), { status: 404 });
    const keys = Object.keys(args || {});
    for (const k of keys) if (!(k in spec)) throw Object.assign(new Error(`unexpected argument ${k}`), { status: 400 });
    const params = keys.map((k) => (spec[k] === "jsonb" ? JSON.stringify(args[k]) : args[k]));
    const call = `select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}::${spec[k]}`).join(", ")}) as result`;
    return db.transaction(async (tx) => {
      await tx.exec("set local role anon");
      const res = await tx.query(call, params);
      return res.rows[0].result;
    });
  }

  // Minimal PostgREST-shaped HTTP handler. Returns true if it handled the request.
  async function handle(req, res) {
    const url = new URL(req.url, "http://x");
    const m = url.pathname.match(/^\/rest\/v1\/rpc\/(\w+)$/);
    if (!m && !url.pathname.startsWith("/rest/v1/")) return false;
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "apikey, authorization, content-type, content-profile, prefer",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    };
    if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return true; }
    const send = (status, body) => {
      res.writeHead(status, { ...cors, "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (!req.headers.apikey) return send(401, { message: "No API key found in request" }), true;
    if (!m || req.method !== "POST") return send(404, { message: "Not found (only RPC calls are allowed)" }), true;
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const result = await rpc(m[1], body ? JSON.parse(body) : {});
      send(200, result === undefined ? null : result);
    } catch (e) {
      send(e.status || 400, { code: e.code || "P0001", message: e.message });
    }
    return true;
  }

  return { db, rpc, handle, close: () => db.close() };
}
