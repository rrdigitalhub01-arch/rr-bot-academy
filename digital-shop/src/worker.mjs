import { check, cleanCatalog, defaultCatalog, identifier, orderItems, ShopError } from './catalog.mjs';
import { equal, profileFrom, telegram, webhookSecret } from './telegram.mjs';

const json = (value, status = 200) => Response.json(value, {
  status,
  headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
});

async function body(request) {
  check(request.headers.get('Content-Type')?.startsWith('application/json'), 'فرمت درخواست معتبر نیست.', 415);
  check(Number(request.headers.get('Content-Length')) <= 400_000, 'حجم اطلاعات بیش از حد مجاز است.', 413);
  const raw = await request.text();
  check(raw.length <= 400_000, 'حجم اطلاعات بیش از حد مجاز است.', 413);
  try { return JSON.parse(raw) ?? {}; } catch { throw new ShopError(400, 'فرمت اطلاعات معتبر نیست.'); }
}

async function shopState(db) {
  const row = await db.prepare('SELECT owner, catalog, revision FROM shop_state WHERE id = 1').first();
  return { owner: row.owner, catalog: row.catalog ? JSON.parse(row.catalog) : defaultCatalog, revision: row.revision };
}

async function publicCatalog(db, catalog) {
  const products = catalog.products.filter(({ active }) => active);
  if (!products.some(({ variants }) => variants.some(({ stock }) => stock !== null))) {
    return { ...catalog, products };
  }
  const { results } = await db.prepare(`
    SELECT json_extract(item.value, '$.productId') AS productId,
           json_extract(item.value, '$.variantId') AS variantId,
           SUM(json_extract(item.value, '$.quantity')) AS sold
    FROM orders, json_each(orders.items) AS item
    WHERE orders.status NOT IN ('cancelled', 'refunded')
    GROUP BY productId, variantId
  `).all();
  const sold = new Map(results.map(item => [item.productId + '/' + item.variantId, item.sold]));
  return {
    ...catalog,
    products: products.map(product => ({
      ...product,
      variants: product.variants.map(variant => ({
        ...variant,
        stock: variant.stock === null ? null :
          Math.max(0, variant.stock - (sold.get(product.id + '/' + variant.id) ?? 0))
      }))
    }))
  };
}

function orderView(row) {
  return {
    id: row.id, status: row.status, createdAt: row.created_at, total: row.total,
    items: JSON.parse(row.items).map(({ stock, ...item }) => item),
    delivery: JSON.parse(row.delivery).map(({ label, value }) => ({ label, value }))
  };
}

const orderById = (db, id) => db.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first();

async function createOrder(db, customer, input) {
  const key = identifier(input.idempotencyKey);
  const previous = await db.prepare('SELECT * FROM orders WHERE customer = ? AND submission = ?').bind(customer, key).first();
  if (previous) return orderView(previous);
  const { catalog, revision } = await shopState(db);
  const items = orderItems(catalog, input.items);
  const total = items.reduce((sum, item) => sum + item.quantity * item.price, 0);
  const allocations = groupVariants(items);
  const row = await db.prepare(`
    INSERT INTO orders (id, customer, submission, status, created_at, total, items, mode)
    SELECT ?, ?, ?, 'placed', ?, ?, ?, 'training'
    WHERE EXISTS (SELECT 1 FROM shop_state WHERE id = 1 AND revision = ?)
      AND NOT EXISTS (
        SELECT 1 FROM json_each(?) AS incoming
        WHERE json_extract(incoming.value, '$.stock') IS NOT NULL
          AND json_extract(incoming.value, '$.quantity') + COALESCE((
            SELECT SUM(json_extract(item.value, '$.quantity'))
            FROM orders, json_each(orders.items) AS item
            WHERE orders.status NOT IN ('cancelled', 'refunded')
              AND json_extract(item.value, '$.productId') = json_extract(incoming.value, '$.productId')
              AND json_extract(item.value, '$.variantId') = json_extract(incoming.value, '$.variantId')
          ), 0) > json_extract(incoming.value, '$.stock')
      )
    ON CONFLICT(customer, submission) DO NOTHING
    RETURNING *
  `).bind('RR-' + crypto.randomUUID().slice(0, 12), customer, key, Date.now(), total,
    JSON.stringify(items), revision, JSON.stringify(allocations)).first();
  if (row) return orderView(row);
  const concurrent = await db.prepare('SELECT * FROM orders WHERE customer = ? AND submission = ?').bind(customer, key).first();
  check(concurrent, 'قیمت یا موجودی تغییر کرد. سبد را تازه‌سازی کن.', 409, 'stock_changed');
  return orderView(concurrent);
}

function groupVariants(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.productId + '/' + item.variantId;
    const previous = groups.get(key);
    groups.set(key, { ...item, quantity: item.quantity + (previous?.quantity ?? 0) });
  }
  return [...groups.values()];
}

function deliveryItems(value) {
  check(Array.isArray(value) && value.length <= 60);
  return value.map(item => {
    check(typeof item?.label === 'string' && item.label.trim().length > 0 && item.label.length <= 100);
    check(typeof item?.value === 'string' && item.value.trim().length > 0 && item.value.length <= 2000);
    return { label: item.label.trim(), value: item.value.trim() };
  });
}

async function deliverOrder(db, id, input) {
  const row = await orderById(db, id);
  check(row, 'سفارش پیدا نشد.', 404);
  if (row.status === 'delivered') return orderView(row);
  check(row.status === 'placed', 'این سفارش آمادهٔ تحویل نیست.', 409);
  const delivery = deliveryItems(input.delivery ?? []);
  if (!delivery.length) {
    for (const item of groupVariants(JSON.parse(row.items))) {
      check(item.method === 'code', 'برای محصول با تحویل دستی، توضیح یا کد تحویل وارد کن.');
      const { results } = await db.prepare(`
        SELECT id, value FROM stock_codes
        WHERE product_id = ? AND variant_id = ? AND order_id IS NULL ORDER BY rowid LIMIT ?
      `).bind(item.productId, item.variantId, item.quantity).all();
      check(results.length === item.quantity, 'کد موجود برای این پلن کافی نیست.', 409, 'code_stock');
      for (const code of results) {
        delivery.push({ label: item.name + ' · ' + item.variant, value: code.value, codeId: code.id });
      }
    }
  }
  const payload = JSON.stringify(delivery);
  check(new TextEncoder().encode(payload).byteLength <= 1_000_000, 'حجم اطلاعات تحویل زیاد است.', 413);
  if (delivery.some(item => item.codeId)) {
    const codes = JSON.stringify(delivery.map(({ codeId }) => codeId));
    await db.batch([
      db.prepare(`
        UPDATE orders SET delivery = ?, status = 'delivered'
        WHERE id = ? AND status = 'placed'
          AND (SELECT COUNT(*) FROM stock_codes WHERE id IN (SELECT value FROM json_each(?)) AND order_id IS NULL)
            = json_array_length(?)
      `).bind(payload, id, codes, codes),
      db.prepare(`
        UPDATE stock_codes SET order_id = ?
        WHERE order_id IS NULL AND id IN (
          SELECT json_extract(value, '$.codeId') FROM orders, json_each(orders.delivery)
          WHERE orders.id = ? AND orders.status = 'delivered'
        )
      `).bind(id, id)
    ]);
  } else {
    await db.prepare(
      "UPDATE orders SET delivery = ?, status = 'delivered' WHERE id = ? AND status = 'placed'"
    ).bind(payload, id).run();
  }
  const updated = await orderById(db, id);
  check(updated.status === 'delivered', 'هم‌زمان کدها تغییر کردند. دوباره تلاش کن.', 409, 'code_stock');
  return orderView(updated);
}

async function addCodes(db, input, catalog) {
  const product = catalog.products.find(({ id }) => id === input.productId);
  check(product?.delivery === 'code' && product.variants.some(({ id }) => id === input.variantId), 'پلن قابل تحویل با کد پیدا نشد.');
  check(Array.isArray(input.values) && input.values.length > 0 && input.values.length <= 50);
  const values = input.values.map(value => {
    check(typeof value === 'string' && value.trim().length > 0 && value.length <= 2000);
    return value.trim();
  });
  const results = await db.batch([...new Set(values)].map(value => db.prepare(`
    INSERT INTO stock_codes (id, product_id, variant_id, value) VALUES (?, ?, ?, ?)
    ON CONFLICT(product_id, variant_id, value) DO NOTHING
  `).bind(crypto.randomUUID(), input.productId, input.variantId, value)));
  return results.reduce((count, result) => count + result.meta.changes, 0);
}

async function setup(request, url, env) {
  check(env.BOT_TOKEN && env.SETUP_CODE?.length >= 16,
    'ابتدا BOT_TOKEN و SETUP_CODE (حداقل ۱۶ نویسه) را در Cloudflare وارد کن.', 503, 'setup_missing');
  const { code } = await body(request);
  check(equal(code, env.SETUP_CODE), 'کد راه‌اندازی درست نیست.', 403, 'setup_code');
  const state = await shopState(env.DB);
  if (url.pathname === '/api/setup/connect') {
    check(!state.owner, 'راه‌اندازی اولیه قبلاً انجام شده است.', 409, 'setup_done');
    check(url.protocol === 'https:', 'آدرس فروشگاه باید HTTPS باشد.');
    await telegram(env.BOT_TOKEN, 'setWebhook', {
      url: new URL('/telegram/webhook', url.origin).href,
      secret_token: await webhookSecret(env.BOT_TOKEN), allowed_updates: ['message']
    });
    await telegram(env.BOT_TOKEN, 'setChatMenuButton', {
      menu_button: { type: 'web_app', text: state.catalog.settings.labels.enter, web_app: { url: url.origin + '/' } }
    });
    const bot = await telegram(env.BOT_TOKEN, 'getMe', {});
    return json({ ok: true, username: bot.username, botUrl: 'https://t.me/' + bot.username });
  }
  const profile = await profileFrom(request, env.BOT_TOKEN);
  if (state.owner === profile.id) return json({ ok: true, owner: true });
  const row = await env.DB.prepare(
    'UPDATE shop_state SET owner = ? WHERE id = 1 AND owner IS NULL RETURNING owner'
  ).bind(profile.id).first();
  check(row, 'فروشگاه به حساب دیگری متصل است.', 409, 'setup_done');
  return json({ ok: true, owner: true });
}

async function webhook(request, url, env) {
  check(env.BOT_TOKEN && equal(request.headers.get('X-Telegram-Bot-Api-Secret-Token'), await webhookSecret(env.BOT_TOKEN)),
    'درخواست از تلگرام نیست.', 403);
  const { message } = await body(request);
  if (!message || message.chat.type !== 'private') return json({ ok: true });
  const command = message.text?.split(/\s+/)[0]?.split('@')[0];
  if (command === '/start') {
    const { catalog: { settings } } = await shopState(env.DB);
    await telegram(env.BOT_TOKEN, 'sendMessage', {
      chat_id: message.chat.id,
      text: settings.welcome || settings.name,
      reply_markup: { inline_keyboard: [[
        { text: settings.labels.enter, web_app: { url: url.origin + '/' } }
      ]] }
    });
  }
  return json({ ok: true });
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  if (path === '/telegram/webhook' && method === 'POST') return webhook(request, url, env);
  if (!path.startsWith('/api/')) return json({ error: 'صفحه پیدا نشد.' }, 404);
  if (path === '/api/health' && method === 'GET') {
    await shopState(env.DB);
    return json({ ok: true, mode: 'training' });
  }
  if (path === '/api/catalog' && method === 'GET') {
    const { catalog } = await shopState(env.DB);
    return json(await publicCatalog(env.DB, catalog));
  }
  if (method === 'POST' && (path === '/api/setup/connect' || path === '/api/setup/claim')) {
    return setup(request, url, env);
  }
  const profile = await profileFrom(request, env.BOT_TOKEN);
  const state = await shopState(env.DB);
  const owner = state.owner === profile.id;
  if (path === '/api/me' && method === 'GET') return json({ owner, profile, mode: 'training', hasOwner: Boolean(state.owner) });
  if (path === '/api/orders' && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT * FROM orders WHERE customer = ? ORDER BY created_at DESC LIMIT 100'
    ).bind(profile.id).all();
    return json({ orders: results.map(orderView) });
  }
  if (path === '/api/orders' && method === 'POST') {
    return json({ order: await createOrder(env.DB, profile.id, await body(request)), invoiceUrl: null }, 201);
  }
  if (path.startsWith('/api/admin/')) check(owner, 'این بخش فقط برای صاحب فروشگاه باز می‌شود.', 403, 'owner_required');
  if (path === '/api/admin/catalog' && method === 'GET') return json(state.catalog);
  if (path === '/api/admin/catalog' && method === 'PUT') {
    const catalog = cleanCatalog(await body(request));
    await env.DB.prepare('UPDATE shop_state SET catalog = ?, revision = revision + 1 WHERE id = 1').bind(JSON.stringify(catalog)).run();
    return json(catalog);
  }
  if (path === '/api/admin/orders' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 200').all();
    return json({ orders: results.map(orderView) });
  }
  const delivery = path.match(/^\/api\/admin\/orders\/([\w-]+)\/delivery$/);
  if (delivery && method === 'POST') return json({ order: await deliverOrder(env.DB, delivery[1], await body(request)) });
  if (path === '/api/admin/codes' && method === 'GET') {
    const { results } = await env.DB.prepare(`
      SELECT product_id AS productId, variant_id AS variantId,
        SUM(order_id IS NULL) AS available, SUM(order_id IS NOT NULL) AS assigned
      FROM stock_codes GROUP BY product_id, variant_id
    `).all();
    return json({ codes: results });
  }
  if (path === '/api/admin/codes' && method === 'POST') {
    return json({ added: await addCodes(env.DB, await body(request), state.catalog) }, 201);
  }
  return json({ error: 'مسیر پیدا نشد.', code: 'not_found' }, 404);
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof ShopError) return json({ error: error.message, code: error.code }, error.status);
      console.error('Shop request failed:', error.name);
      return json({ error: 'درخواست انجام نشد. دوباره تلاش کن.', code: 'server_error' }, 500);
    }
  }
};
