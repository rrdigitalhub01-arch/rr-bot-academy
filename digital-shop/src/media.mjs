import { check } from './catalog.mjs';
import { catalogMedia, maxImageBytes, mediaPath } from '../public/media.js';

const hasTable = db => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'shop_images'").first();

function contentType(bytes) {
  const starts = signature => signature.every((byte, index) => bytes[index] === byte);
  if (starts([137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png';
  if (starts([255, 216, 255])) return 'image/jpeg';
  if (starts([82, 73, 70, 70]) && [87, 69, 66, 80].every((byte, index) => bytes[8 + index] === byte)) return 'image/webp';
  return '';
}

async function imageBytes(request) {
  check(Number(request.headers.get('Content-Length')) <= maxImageBytes, 'حجم تصویر بیش از حد مجاز است.', 413);
  check(request.body, 'تصویر خالی است.');
  const reader = request.body.getReader();
  const bytes = new Uint8Array(maxImageBytes);
  let size = 0;
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      if (size + value.length > bytes.length) {
        await reader.cancel();
        check(false, 'حجم تصویر بیش از حد مجاز است.', 413);
      }
      bytes.set(value, size);
      size += value.length;
    }
  } finally {
    reader.releaseLock();
  }
  return bytes.subarray(0, size);
}

export async function storeImage(db, id, request) {
  const bytes = await imageBytes(request);
  const type = contentType(bytes);
  check(type && type === request.headers.get('Content-Type'), 'فقط تصویر PNG، JPEG یا WebP مجاز است.', 415);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hash = Array.from(digest, value => value.toString(16).padStart(2, '0')).join('');
  check(id === hash, 'شناسهٔ تصویر معتبر نیست.');
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS shop_images (id TEXT PRIMARY KEY, type TEXT NOT NULL, image BLOB NOT NULL)'),
    db.prepare('INSERT OR IGNORE INTO shop_images (id, type, image) VALUES (?, ?, ?)').bind(id, type, bytes)
  ]);
}

export async function getImage(db, id, method) {
  const row = await hasTable(db) &&
    await db.prepare('SELECT type, image FROM shop_images WHERE id = ?').bind(id).first();
  if (!row) return new Response(null, {status: 404});
  return new Response(method === 'HEAD' ? null : new Uint8Array(row.image), {headers: {
    'Content-Type': row.type,
    'Content-Length': String(row.image.length),
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff'
  }});
}

export async function checkCatalogMedia(db, catalog) {
  const ids = catalogMedia(catalog).map(path => path.match(mediaPath)[1]);
  if (!ids.length) return;
  const row = await hasTable(db) && await db.prepare(
    'SELECT COUNT(*) AS count FROM shop_images WHERE id IN (SELECT value FROM json_each(?))'
  ).bind(JSON.stringify(ids)).first();
  check(row?.count === ids.length, 'بعضی تصویرها در این فروشگاه موجود نیستند. آن‌ها را دوباره انتخاب کن.');
}
