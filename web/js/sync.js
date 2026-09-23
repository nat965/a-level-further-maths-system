// Talking to the database (Supabase's REST API) and keeping this device's copy of the tracker
// in step with it.
import { normalize } from "./service.js";

export class RemoteError extends Error {
  constructor(message, { status = 0, offline = false } = {}) {
    super(message);
    this.status = status;
    this.offline = offline;
  }
}

export class Remote {
  constructor({ url, key, fetchImpl = globalThis.fetch.bind(globalThis) }) {
    this.url = String(url || "").replace(/\/+$/, "");
    this.key = key;
    this.fetch = fetchImpl;
  }

  async call(fn, args) {
    const headers = { "Content-Type": "application/json", apikey: this.key };
    if (String(this.key).startsWith("eyJ")) headers.Authorization = `Bearer ${this.key}`; // legacy anon JWT
    let res;
    try {
      res = await this.fetch(`${this.url}/rest/v1/rpc/${fn}`, { method: "POST", headers, body: JSON.stringify(args) });
    } catch {
      throw new RemoteError("Can't reach the server. Check your internet connection.", { offline: true });
    }
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) {
      const msg = (body && (body.message || body.msg || body.error)) || `Server error (${res.status})`;
      throw new RemoteError(msg, { status: res.status, offline: res.status >= 500 || res.status === 0 });
    }
    return body;
  }

  create(data) { return this.call("create_tracker", { p_data: data }); }
  load(code) { return this.call("load_tracker", { p_code: code }); }
  // Resolves to the new version number; rejects with "conflict" if another device saved first.
  async save(code, data, version) {
    const r = await this.call("save_tracker", { p_code: code, p_data: data, p_version: version });
    if (r && r.conflict) throw new RemoteError("conflict", { status: 409 });
    return r.version;
  }
  listBackups(code) { return this.call("list_backups", { p_code: code }); }
  restoreBackup(code, id) { return this.call("restore_backup", { p_code: code, p_backup_id: id }); }
}

export const normalizeCode = (code) => String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
export const formatCode = (code) => normalizeCode(code).replace(/(.{4})(?=.)/g, "$1-");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One open tracker. Changes are "ops": functions that change the document in place. They're
// applied here straight away (so the page never waits for the network) and saved in order in
// the background. If another device saved first, the latest version is loaded and the unsaved
// ops are re-applied on top of it, so neither device's changes are lost.
export class Tracker {
  constructor(remote, code, { onChange = () => {}, onStatus = () => {}, retryDelays = [1000, 2000, 5000, 10000, 30000] } = {}) {
    this.remote = remote;
    this.code = formatCode(code);
    this.onChange = onChange;
    this.onStatus = onStatus;
    this.retryDelays = retryDelays;
    this.doc = null;
    this.version = null;
    this.pending = [];
    this.saving = false;
    this.status = "saved";
  }

  async open() {
    const r = await this.remote.load(this.code);
    if (!r) throw new RemoteError("No tracker has that code. Check it and try again.", { status: 404 });
    this.doc = normalize(r.data);
    this.version = r.version;
    return this.doc;
  }

  setStatus(s, detail) { this.status = s; this.onStatus(s, detail); }

  // Apply an op now and queue it for saving. Throws (changing nothing) if the op rejects the input.
  apply(op) {
    const next = structuredClone(this.doc);
    op(next);
    this.doc = next;
    this.pending.push(op);
    this.setStatus("saving");
    this.flush();
    return next;
  }

  // Replace the whole tracker (imports): an op that swaps in the new document.
  replace(doc) { return this.apply((d) => { for (const k of Object.keys(d)) delete d[k]; Object.assign(d, structuredClone(doc)); }); }

  get unsaved() { return this.pending.length > 0; }

  async flush() {
    if (this.saving) return this.savingPromise;
    this.saving = true;
    this.savingPromise = this.#loop().finally(() => { this.saving = false; });
    return this.savingPromise;
  }

  async #loop() {
    let attempt = 0;
    while (this.pending.length) {
      const count = this.pending.length;
      const snapshot = this.doc;
      try {
        this.version = await this.remote.save(this.code, snapshot, this.version);
        this.pending.splice(0, count);
        attempt = 0;
      } catch (e) {
        if (e.message === "conflict") {
          await this.#merge();
          continue;
        }
        if (e.offline) {
          this.setStatus("offline", e.message);
          await sleep(this.retryDelays[Math.min(attempt++, this.retryDelays.length - 1)]);
          continue;
        }
        this.setStatus("error", e.message);
        return;
      }
    }
    this.setStatus("saved");
  }

  async #merge() {
    const r = await this.remote.load(this.code);
    if (!r) throw new RemoteError("This tracker no longer exists.");
    let doc = normalize(r.data);
    const kept = [], dropped = [];
    for (const op of this.pending) {
      try {
        const next = structuredClone(doc);
        op(next);
        doc = next;
        kept.push(op);
      } catch (err) {
        dropped.push(err.message);
      }
    }
    this.pending = kept;
    this.doc = doc;
    this.version = r.version;
    this.onChange({ merged: true, dropped });
  }

  // Pick up changes made on another device (only when nothing is waiting to be saved here).
  async refresh() {
    if (this.pending.length || this.saving) return false;
    const r = await this.remote.load(this.code);
    if (!r || r.version === this.version || this.pending.length) return false;
    this.doc = normalize(r.data);
    this.version = r.version;
    this.onChange({ refreshed: true });
    return true;
  }
}
