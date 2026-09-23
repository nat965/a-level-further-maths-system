// Run the whole website locally, with no Supabase account needed:
//   npm install && npm run dev            -> http://127.0.0.1:8080
// Options: --port 8080  --data <folder> (keep data between runs; default: in memory)
//          --today 2027-01-10 (pretend it's another day, for testing)
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createBackend } from "./dev-backend.mjs";

const ROOT = fileURLToPath(new URL("../web/", import.meta.url));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
                ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

export async function startDevServer({ port = 8080, dataDir, today } = {}) {
  const backend = await createBackend({ dataDir });
  const server = http.createServer(async (req, res) => {
    try {
      if (await backend.handle(req, res)) return;
      const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
      if (path === "/config.js") {
        const cfg = { supabaseUrl: `http://${req.headers.host}`, supabaseKey: "local-dev-key", ...(today ? { today } : {}) };
        res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(`export default ${JSON.stringify(cfg)};\n`);
      }
      const file = normalize(join(ROOT, path.endsWith("/") ? `${path}index.html` : path));
      if (!file.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) { res.writeHead(403); return res.end(); }
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": `${TYPES[extname(file)] || "application/octet-stream"}; charset=utf-8`, "Cache-Control": "no-store" });
      res.end(body);
    } catch (e) {
      res.writeHead(e.code === "ENOENT" ? 404 : 500);
      res.end(e.code === "ENOENT" ? "Not found" : String(e));
    }
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return { server, backend, url: `http://127.0.0.1:${server.address().port}/`,
           close: async () => { server.close(); await backend.close(); } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const s = await startDevServer({ port: Number(arg("port") ?? 8080), dataDir: arg("data"), today: arg("today") });
  console.log(`Revision Tracker (local) running at ${s.url}`);
}
