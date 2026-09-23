// Get photos ready to upload (in the browser): shrink big phone photos so they upload quickly
// and don't fill the storage, and make a small thumbnail for lists. PDFs are uploaded as they are.
import { mimeOf, MAX_FILE_BYTES } from "./filestore.js";

const MAX_SIDE = 2000;        // plenty to read handwriting and printed questions
const THUMB_SIDE = 320;
const KEEP_IF_UNDER = 700 * 1024;

async function decode(file) {
  if (typeof createImageBitmap !== "function") return null;
  try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch { return null; }
}

function encode(bitmap, maxSide, quality) {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale)), h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; // transparent PNGs become white, not black, as JPEG
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't process the photo"))), "image/jpeg", quality));
}

const jpgName = (name) => String(name || "photo").replace(/\.[^.]+$/, "") + ".jpg";

// Resolves to {main: {blob, name, mime}, thumb: {blob, name, mime} | null}.
export async function prepareUpload(file) {
  const mime = mimeOf(file);
  if (mime === "application/pdf") {
    if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} is over 10 MB: try a smaller scan.`);
    return { main: { blob: file, name: file.name, mime }, thumb: null };
  }
  if (!mime.startsWith("image/")) throw new Error(`${file.name}: only photos and PDFs can be uploaded.`);
  const bitmap = await decode(file);
  if (!bitmap) {
    // e.g. an iPhone HEIC photo in a browser that can't open them: keep the original
    if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} is over 10 MB.`);
    return { main: { blob: file, name: file.name, mime }, thumb: null };
  }
  try {
    const small = Math.max(bitmap.width, bitmap.height) <= MAX_SIDE && file.size <= KEEP_IF_UNDER
      && (mime === "image/jpeg" || mime === "image/png");
    const main = small ? { blob: file, name: file.name, mime } : { blob: await encode(bitmap, MAX_SIDE, 0.85), name: jpgName(file.name), mime: "image/jpeg" };
    const thumb = { blob: await encode(bitmap, THUMB_SIDE, 0.7), name: `thumb-${jpgName(file.name)}`, mime: "image/jpeg" };
    return { main, thumb };
  } finally {
    bitmap.close?.();
  }
}

// Upload prepared files; resolves to the file details to keep in the tracker. If anything fails,
// whatever was already uploaded is deleted again.
export async function uploadAll(store, files, onProgress = () => {}) {
  const prepared = [];
  for (const f of files) prepared.push(await prepareUpload(f));
  const total = prepared.reduce((s, p) => s + p.main.blob.size + (p.thumb ? p.thumb.blob.size : 0), 0) || 1;
  let done = 0;
  const uploaded = [], ids = [];
  try {
    for (const p of prepared) {
      const size = p.main.blob.size;
      const main = await store.upload(p.main.blob, { name: p.main.name, mime: p.main.mime,
        onProgress: (x) => onProgress((done + x * size) / total) });
      ids.push(main.id);
      done += size;
      let thumbId = null;
      if (p.thumb) {
        const t = await store.upload(p.thumb.blob, { name: p.thumb.name, mime: p.thumb.mime });
        ids.push(t.id);
        thumbId = t.id;
        done += p.thumb.blob.size;
      }
      onProgress(done / total);
      uploaded.push({ ...main, thumb_id: thumbId });
    }
    return uploaded;
  } catch (e) {
    try { await store.remove(ids); } catch { /* best effort */ }
    throw e;
  }
}
