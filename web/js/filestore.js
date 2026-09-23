// Photos and PDFs of questions, stored in the database through the functions in schema.sql.
// Files go up and come down in 1 MB chunks (as base64), so large PDFs work on any connection.
export const CHUNK_BYTES = 1024 * 1024;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

const MIME_BY_EXT = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
                      gif: "image/gif", heic: "image/heic", heif: "image/heif" };
export const ACCEPT = "image/*,application/pdf,.pdf,.heic,.heif";

// The type to store a file as (some phones give HEIC photos no type at all).
export function mimeOf(file) {
  const ext = String(file.name || "").split(".").pop().toLowerCase();
  const t = String(file.type || "").toLowerCase();
  if (Object.values(MIME_BY_EXT).includes(t)) return t;
  return MIME_BY_EXT[ext] || t || "application/octet-stream";
}

export function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const uuid = () => globalThis.crypto.randomUUID();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class FileStore {
  constructor(remote, code) {
    this.remote = remote;
    this.code = code;
    this.cache = new Map(); // id -> Promise<Blob>
  }

  // Upload a Blob/File. Resolves to the details to keep in the tracker: {id, name, mime, size}.
  async upload(blob, { name = blob.name || "file", mime = mimeOf(blob), onProgress = () => {}, id = uuid() } = {}) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!bytes.length) throw new Error(`${name} is empty`);
    if (bytes.length > MAX_FILE_BYTES) throw new Error(`${name} is ${(bytes.length / 1048576).toFixed(1)} MB: files can be at most 10 MB.`);
    const chunks = Math.ceil(bytes.length / CHUNK_BYTES);
    for (let i = 0; i < chunks; i++) {
      const args = { p_code: this.code, p_file_id: id, p_seq: i, p_chunks: chunks, p_name: name, p_mime: mime,
                     p_size: bytes.length, p_data: toBase64(bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES)) };
      for (let attempt = 0; ; attempt++) {
        try {
          await this.remote.call("put_file_chunk", args);
          break;
        } catch (e) {
          if (!e.offline || attempt >= 3) throw friendly(e);
          await sleep(1000 * (attempt + 1));
        }
      }
      onProgress((i + 1) / chunks);
    }
    this.cache.set(id, Promise.resolve(new Blob([bytes], { type: mime })));
    return { id, name, mime, size: bytes.length };
  }

  // The whole file as a Blob (cached for this visit).
  get(id) {
    if (!this.cache.has(id)) {
      const p = (async () => {
        const first = await this.remote.call("get_file_chunk", { p_code: this.code, p_file_id: id, p_seq: 0 });
        if (!first) throw new Error("This file is missing (it may have been deleted).");
        const parts = [fromBase64(first.data)];
        for (let i = 1; i < first.chunks; i++) {
          const c = await this.remote.call("get_file_chunk", { p_code: this.code, p_file_id: id, p_seq: i });
          parts.push(fromBase64(c.data));
        }
        return new Blob(parts, { type: first.mime });
      })();
      p.catch(() => this.cache.delete(id));
      this.cache.set(id, p);
    }
    return this.cache.get(id);
  }

  // Small files (thumbnails) in batches: resolves to {id: Blob} for the ones found.
  async getSmall(ids) {
    const out = {}, want = [];
    for (const id of new Set(ids)) {
      if (this.cache.has(id)) out[id] = this.cache.get(id);
      else want.push(id);
    }
    for (let i = 0; i < want.length; i += 100) {
      const got = await this.remote.call("get_small_files", { p_code: this.code, p_file_ids: want.slice(i, i + 100) });
      for (const [id, f] of Object.entries(got || {})) {
        const blob = new Blob([fromBase64(f.data)], { type: f.mime });
        this.cache.set(id, Promise.resolve(blob));
        out[id] = blob;
      }
    }
    for (const id of Object.keys(out)) out[id] = await out[id];
    return out;
  }

  remove(ids) { return ids.length ? this.remote.call("delete_files", { p_code: this.code, p_file_ids: ids }) : 0; }
  undelete(ids) { return ids.length ? this.remote.call("undelete_files", { p_code: this.code, p_file_ids: ids }) : 0; }
  list() { return this.remote.call("list_files", { p_code: this.code }); }

  async usage() {
    const files = await this.list();
    const live = files.filter((f) => f.complete && !f.deleted_at);
    return { bytes: live.reduce((s, f) => s + f.size, 0), files: live.length, limit: 100 * 1024 * 1024, all: files };
  }

  // Tidy up files nothing refers to any more (older than a day, so an upload that another
  // device hasn't saved yet is never touched). Returns how many were deleted.
  async cleanUp(referenced, now = Date.now()) {
    const dayAgo = now - 86400000;
    const stale = (await this.list()).filter((f) => !f.deleted_at && !referenced.has(f.file_id) && Date.parse(f.created_at) < dayAgo);
    return stale.length ? this.remove(stale.map((f) => f.file_id)) : 0;
  }
}

function friendly(e) {
  if (/Could not find the function/i.test(e.message)) {
    return new Error("The database needs updating before files can be uploaded: run supabase/schema.sql again in Supabase (see the README).");
  }
  return e;
}
