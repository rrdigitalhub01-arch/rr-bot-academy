import { createWorker } from './worker.mjs';
import { assets, statements } from 'rr-dashboard-resources';

function findSchema(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'shop_state'").first();
}

async function initializeDatabase(db) {
  if (await findSchema(db)) return;
  try {
    await db.batch(statements.map(sql => db.prepare(sql)));
  } catch (error) {
    // A parallel setup request may have completed the same atomic batch.
    if (!await findSchema(db)) throw error;
  }
}

const worker = createWorker(initializeDatabase);

export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/') || pathname === '/telegram/webhook') {
      return worker.fetch(request, env);
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
    }

    const path = pathname === '/' || pathname === '/setup' || pathname === '/setup/'
      ? '/index.html'
      : pathname;
    const asset = Object.hasOwn(assets, path) ? assets[path] : undefined;
    if (!asset) return new Response(null, { status: 404 });

    return new Response(request.method === 'HEAD' ? null : Uint8Array.from(atob(asset.chunks.join('')), char => char.charCodeAt(0)), {
      headers: {
        'Content-Type': asset.type,
        'X-Content-Type-Options': 'nosniff'
      }
    });
  }
};
