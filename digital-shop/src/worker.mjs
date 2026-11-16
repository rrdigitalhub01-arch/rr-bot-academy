import { check, cleanCatalog, defaultCatalog, identifier, orderItems, ShopError } from './catalog.mjs';
import { equal, profileFrom, telegram, webhookSecret } from './telegram.mjs';
import { approveCheckout, cancelInvoice, holdTime, invoiceFor, recordPayment, recordRefund, refundOrder } from './stars.mjs';

const modeFor = (env) => env.SHOP_MODE === 'training' ? 'training' : 'live';

function purchasableCatalog(catalog, mode) {
  if (mode === 'training') return catalog;
  return { ...catalog, products: catalog.products.filter(product => product.delivery === 'link' ||
    (product.liveEnabled && catalog.settings.supportUrl && catalog.settings.termsUrl)) };
}


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

async function publicCatalog(db, catalog, mode) {
  const products = purchasableCatalog(catalog, mode).products.filter(({ active }) => active);
  const usesCodes = mode === 'live' && products.some(({ delivery }) => delivery === 'code');
  if (!usesCodes && !products.some(({ variants }) => variants.some(({ stock }) => stock !== null))) {
    return { ...catalog, products };
  }
  const sold = db.prepare(`
    SELECT json_extract(item.value, '$.productId') AS productId,
           json_extract(item.value, '$.variantId') AS variantId,
           SUM(json_extract(item.value, '$.quantity')) AS sold,
           SUM(CASE WHEN orders.status IN ('pending_payment', 'paid') AND json_extract(item.value, '$.method') = 'code'
                    THEN json_extract(item.value, '$.quantity') ELSE 0 END) AS reserved
    FROM orders, json_each(orders.items) AS item
    WHERE orders.mode = ?
      AND (orders.status IN ('placed', 'paid', 'delivered') OR (orders.status = 'refunded' AND orders.delivery <> '[]')
        OR (orders.status = 'pending_payment' AND (orders.checkout_query IS NOT NULL OR orders.hold_until > ?)))
    GROUP BY productId, variantId
  `).bind(mode, Date.now()).all();
  const codeStock = usesCodes && db.prepare(`
    SELECT product_id AS productId, variant_id AS variantId, COUNT(*) AS available
    FROM stock_codes WHERE mode = 'live' AND order_id IS NULL GROUP BY product_id, variant_id
  `).all();
  const [stockRows, codeRows] = await Promise.all([sold, codeStock]);
  const keyFor = item => item.productId + '/' + item.variantId;
  const usage = new Map(stockRows.results.map(item => [keyFor(item), item]));
  const codes = new Map((codeRows?.results ?? []).map(item => [keyFor(item), item.available]));
  return {
    ...catalog,
    products: products.map(product => ({
      ...product,
      variants: product.variants.map(variant => {
        const key = product.id + '/' + variant.id;
        const used = usage.get(key);
        const stock = variant.stock === null ? null : Math.max(0, variant.stock - (used?.sold ?? 0));
        if (usesCodes && product.delivery === 'code') {
          const available = Math.max(0, (codes.get(key) ?? 0) - (used?.reserved ?? 0));
          return { ...variant, stock: stock === null ? available : Math.min(stock, available) };
        }
        return { ...variant, stock };
      })
    }))
  };
}

function orderView(row) {
  const payable = row.status === 'pending_payment' && !row.checkout_query && row.hold_until > Date.now();
  const expired = row.status === 'pending_payment' && !row.checkout_query && !payable;
  return {
    id: row.id, status: expired ? 'cancelled' : row.status, createdAt: row.created_at, total: row.total,
    mode: row.mode, payable, refundPending: Boolean(row.refund_request),
    items: JSON.parse(row.items).map(({ stock, ...item }) => item),
    delivery: row.status === 'delivered' ? JSON.parse(row.delivery).map(({ label, value }) => ({ label, value })) : []
  };
}

const orderById = (db, id) => db.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first();

async function createOrder(env, customer, input, mode) {
  const db = env.DB;
  const key = identifier(input.idempotencyKey);
  const bySubmission = () => db.prepare('SELECT * FROM orders WHERE customer = ? AND submission = ?').bind(customer, key).first();
  const previous = await bySubmission();
  if (previous) {
    check(previous.mode === mode, 'روش پرداخت تغییر کرده. سبد را دوباره بساز.', 409);
    return previous;
  }
  const { catalog, revision } = await shopState(db);
  const live = mode === 'live';
  if (live) {
    check(catalog.settings.termsUrl && catalog.settings.supportUrl,
      'فروشگاه هنوز شرایط خرید و مسیر پشتیبانی پرداخت را تنظیم نکرده.', 409, 'shop_not_ready');
    check(input.acceptedTermsUrl === catalog.settings.termsUrl, 'شرایط خرید را بخوان و تأیید کن.', 400, 'terms_required');
  }
  const items = orderItems(purchasableCatalog(catalog, mode), input.items);
  const total = items.reduce((sum, item) => sum + item.quantity * item.price, 0);
  const allocations = JSON.stringify(groupVariants(items));
  const now = Date.now();
  const row = await db.prepare(`
    WITH incoming AS (
      SELECT json_extract(value, '$.productId') AS product, json_extract(value, '$.variantId') AS variant,
             json_extract(value, '$.quantity') AS units, json_extract(value, '$.stock') AS cap,
             json_extract(value, '$.method') AS method
      FROM json_each(?1)
    ), committed AS (
      SELECT orders.status, json_extract(item.value, '$.productId') AS product,
             json_extract(item.value, '$.variantId') AS variant, json_extract(item.value, '$.quantity') AS units,
             json_extract(item.value, '$.method') AS method
      FROM orders, json_each(orders.items) AS item
      WHERE orders.mode = ?2
        AND (orders.status IN ('placed', 'paid', 'delivered') OR (orders.status = 'refunded' AND orders.delivery <> '[]')
          OR (orders.status = 'pending_payment' AND (orders.checkout_query IS NOT NULL OR orders.hold_until > ?3)))
    )
    INSERT INTO orders (id, customer, submission, status, created_at, total, items, mode, hold_until, accepted_terms_url)
    SELECT ?4, ?5, ?6, ?7, ?3, ?8, ?9, ?2, ?10, ?11
    WHERE EXISTS (SELECT 1 FROM shop_state WHERE id = 1 AND revision = ?12)
      AND NOT EXISTS (
        SELECT 1 FROM incoming
        WHERE (cap IS NOT NULL AND incoming.units + COALESCE((
          SELECT SUM(committed.units) FROM committed
          WHERE committed.product = incoming.product AND committed.variant = incoming.variant
        ), 0) > cap)
        OR (?2 = 'live' AND incoming.method = 'code' AND incoming.units + COALESCE((
          SELECT SUM(committed.units) FROM committed
          WHERE committed.product = incoming.product AND committed.variant = incoming.variant
            AND committed.status IN ('pending_payment', 'paid') AND committed.method = 'code'
        ), 0) > (
          SELECT COUNT(*) FROM stock_codes
          WHERE mode = 'live' AND order_id IS NULL AND product_id = incoming.product AND variant_id = incoming.variant
        ))
      )
    ON CONFLICT(customer, submission) DO NOTHING
    RETURNING *
  `).bind(allocations, mode, now, 'RR-' + crypto.randomUUID().slice(0, 12), customer, key,
    live ? 'pending_payment' : 'placed', total, JSON.stringify(items), live ? now + holdTime : null,
    live ? input.acceptedTermsUrl : null, revision).first();
  if (row) return row;
  const concurrent = await bySubmission();
  check(concurrent?.mode === mode, 'قیمت یا موجودی تغییر کرد. سبد را تازه‌سازی کن.', 409, 'stock_changed');
  return concurrent;
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
  check((row.mode === 'live' ? row.status === 'paid' : row.status === 'placed') && !row.refund_request,
    'سفارش باید پرداخت شده باشد و در حال بازپرداخت نباشد.', 409);
  const delivery = deliveryItems(input.delivery ?? []);
  if (!delivery.length) {
    for (const item of groupVariants(JSON.parse(row.items))) {
      check(item.method === 'code', 'برای محصول با تحویل دستی، توضیح یا کد تحویل وارد کن.');
      const { results } = await db.prepare(`
        SELECT id, value FROM stock_codes
        WHERE product_id = ? AND variant_id = ? AND mode = ? AND order_id IS NULL ORDER BY rowid LIMIT ?
      `).bind(item.productId, item.variantId, row.mode, item.quantity).all();
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
        WHERE id = ? AND status = ? AND refund_request IS NULL
          AND (SELECT COUNT(*) FROM stock_codes WHERE id IN (SELECT value FROM json_each(?)) AND order_id IS NULL)
            = json_array_length(?)
      `).bind(payload, id, row.status, codes, codes),
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
      "UPDATE orders SET delivery = ?, status = 'delivered' WHERE id = ? AND status = ? AND refund_request IS NULL"
    ).bind(payload, id, row.status).run();
  }
  const updated = await orderById(db, id);
  check(updated.status === 'delivered', 'هم‌زمان کدها تغییر کردند. دوباره تلاش کن.', 409, 'code_stock');
  return orderView(updated);
}

async function addCodes(db, input, catalog, mode) {
  const product = catalog.products.find(({ id }) => id === input.productId);
  check(product?.delivery === 'code' && product.variants.some(({ id }) => id === input.variantId), 'پلن قابل تحویل با کد پیدا نشد.');
  check(Array.isArray(input.values) && input.values.length > 0 && input.values.length <= 50);
  const values = input.values.map(value => {
    check(typeof value === 'string' && value.trim().length > 0 && value.length <= 2000);
    return value.trim();
  });
  const results = await db.batch([...new Set(values)].map(value => db.prepare(`
    INSERT INTO stock_codes (id, product_id, variant_id, value, mode) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(product_id, variant_id, value) DO NOTHING
  `).bind(crypto.randomUUID(), input.productId, input.variantId, value, mode)));
  return results.reduce((count, result) => count + result.meta.changes, 0);
}

async function connectTelegram(env, url, label) {
  check(url.protocol === 'https:', 'آدرس فروشگاه باید HTTPS باشد.');
  await telegram(env.BOT_TOKEN, 'setWebhook', {
    url: new URL('/telegram/webhook', url.origin).href,
    secret_token: await webhookSecret(env.BOT_TOKEN), allowed_updates: ['message', 'pre_checkout_query']
  });
  await telegram(env.BOT_TOKEN, 'setChatMenuButton', {
    menu_button: { type: 'web_app', text: label, web_app: { url: url.origin + '/' } }
  });
}

async function setup(request, url, env) {
  check(env.BOT_TOKEN && env.SETUP_CODE?.length >= 16,
    'ابتدا BOT_TOKEN و SETUP_CODE (حداقل ۱۶ نویسه) را در Cloudflare وارد کن.', 503, 'setup_missing');
  const { code } = await body(request);
  check(equal(code, env.SETUP_CODE), 'کد راه‌اندازی درست نیست.', 403, 'setup_code');
  const state = await shopState(env.DB);
  if (url.pathname === '/api/setup/connect') {
    check(!state.owner, 'راه‌اندازی اولیه قبلاً انجام شده است.', 409, 'setup_done');
    await connectTelegram(env, url, state.catalog.settings.labels.enter);
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
  const { message, pre_checkout_query: checkout } = await body(request);
  if (checkout) {
    await approveCheckout(env, checkout);
    return json({ ok: true });
  }
  if (!message || message.chat?.type !== 'private') return json({ ok: true });
  if (message.successful_payment) {
    await recordPayment(env.DB, String(message.from?.id ?? message.chat.id), message.successful_payment);
    return json({ ok: true });
  }
  if (message.refunded_payment) {
    await recordRefund(env.DB, message.refunded_payment);
    return json({ ok: true });
  }
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
  if (command === '/paysupport' || command === '/terms') {
    const { catalog: { settings } } = await shopState(env.DB);
    const terms = command === '/terms';
    const link = terms ? settings.termsUrl : settings.supportUrl;
    await telegram(env.BOT_TOKEN, 'sendMessage', {
      chat_id: message.chat.id,
      text: link
        ? (terms ? 'شرایط خرید فروشگاه را بخوان:' : 'برای پیگیری پرداخت، کد سفارشت را برای پشتیبانی بفرست:') + '\n' + link
        : 'مدیر هنوز این بخش را تنظیم نکرده است.'
    });
  }
  return json({ ok: true });
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const mode = modeFor(env);
  if (path === '/telegram/webhook' && method === 'POST') return webhook(request, url, env);
  if (!path.startsWith('/api/')) return json({ error: 'صفحه پیدا نشد.' }, 404);
  if (path === '/api/health' && method === 'GET') {
    await shopState(env.DB);
    return json({ ok: true, mode });
  }
  if (path === '/api/catalog' && method === 'GET') {
    const { catalog } = await shopState(env.DB);
    return json(await publicCatalog(env.DB, catalog, mode));
  }
  if (method === 'POST' && (path === '/api/setup/connect' || path === '/api/setup/claim')) {
    return setup(request, url, env);
  }
  const profile = await profileFrom(request, env.BOT_TOKEN);
  const state = await shopState(env.DB);
  const owner = state.owner === profile.id;
  if (path === '/api/me' && method === 'GET') return json({ owner, profile, mode, hasOwner: Boolean(state.owner) });
  if (path === '/api/orders' && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT * FROM orders WHERE customer = ? ORDER BY created_at DESC LIMIT 100'
    ).bind(profile.id).all();
    return json({ orders: results.map(orderView) });
  }
  if (path === '/api/orders' && method === 'POST') {
    const row = await createOrder(env, profile.id, await body(request), mode);
    return json({ order: orderView(row), invoiceUrl: await invoiceFor(env, row) }, 201);
  }
  const invoiceAction = path.match(/^\/api\/orders\/([\w-]+)\/(invoice|cancel)$/);
  if (invoiceAction && method === 'POST') {
    const [, id, action] = invoiceAction;
    const row = await orderById(env.DB, id);
    check(row?.customer === profile.id, 'سفارش پیدا نشد.', 404);
    if (action === 'cancel') {
      const cancelled = await cancelInvoice(env.DB, id, profile.id);
      check(cancelled, 'این فاکتور در حال پردازش است یا امکان لغو ندارد.', 409);
      return json({ order: orderView(cancelled) });
    }
    const invoiceUrl = await invoiceFor(env, row);
    check(invoiceUrl, 'فاکتور قابل پرداخت نیست. وضعیت سفارش را تازه‌سازی کن.', 409);
    return json({ invoiceUrl });
  }
  if (path.startsWith('/api/admin/')) check(owner, 'این بخش فقط برای صاحب فروشگاه باز می‌شود.', 403, 'owner_required');
  if (path === '/api/admin/telegram/connect' && method === 'POST') {
    await connectTelegram(env, url, state.catalog.settings.labels.enter);
    return json({ ok: true });
  }
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
  const refund = path.match(/^\/api\/admin\/orders\/([\w-]+)\/refund$/);
  if (refund && method === 'POST') return json({ order: orderView(await refundOrder(env, refund[1])) });
  if (path === '/api/admin/codes' && method === 'GET') {
    const { results } = await env.DB.prepare(`
      SELECT product_id AS productId, variant_id AS variantId,
        SUM(order_id IS NULL) AS available, SUM(order_id IS NOT NULL) AS assigned
      FROM stock_codes WHERE mode = ? GROUP BY product_id, variant_id
    `).bind(mode).all();
    return json({ codes: results });
  }
  if (path === '/api/admin/codes' && method === 'POST') {
    return json({ added: await addCodes(env.DB, await body(request), state.catalog, mode) }, 201);
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
