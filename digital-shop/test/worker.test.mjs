import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import worker from '../src/worker.mjs';
import dashboardWorker from '../dashboard/worker.mjs';
import { defaultCatalog } from '../src/catalog.mjs';
import { webhookSecret } from '../src/telegram.mjs';

const token = '0000:local-test-token';
const code = 'local-setup-test-code';
const origin = 'https://shop.example';

function signedProfile(id, authDate = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams({ auth_date: authDate.toString(), user: JSON.stringify({ id, first_name: 'Tester' }) });
  params.sort();
  const data = [...params].map(([key, value]) => key + '=' + value).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', createHmac('sha256', secret).update(data).digest('hex'));
  return 'tma ' + params;
}

function fixture(mode = 'training', { handler = worker, empty = false } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  if (!empty) {
    for (const migration of ['0001_shop.sql', '0002_stars.sql']) {
      sqlite.exec(readFileSync(new URL('../migrations/' + migration, import.meta.url), 'utf8'));
    }
  }

  function bind(sql, args) {
    return {
      async first() { return sqlite.prepare(sql).get(...args) ?? null; },
      async all() { return { results: sqlite.prepare(sql).all(...args) }; },
      async run() { return { meta: { changes: sqlite.prepare(sql).run(...args).changes } }; }
    };
  }

  const env = {
    BOT_TOKEN: token, SETUP_CODE: code, SHOP_MODE: mode,
    DB: {
      prepare(sql) { return { ...bind(sql, []), bind: (...args) => bind(sql, args) }; },
      async batch(statements) {
        sqlite.exec('BEGIN');
        try {
          const out = [];
          for (const statement of statements) out.push(await statement.run());
          sqlite.exec('COMMIT');
          return out;
        } catch (error) {
          sqlite.exec('ROLLBACK');
          throw error;
        }
      }
    }
  };

  return async function request(path, { id, method = 'GET', data, headers, bytes, raw = false } = {}) {
    const request = new Request(origin + path, {
      method,
      headers: {
        ...(id ? { Authorization: signedProfile(id) } : {}),
        ...(data ? { 'Content-Type': 'application/json' } : {}),
        ...headers
      },
      body: data ? JSON.stringify(data) : bytes
    });
    const response = await handler.fetch(request, env);
    return raw ? response : { status: response.status, json: await response.json() };
  };
}

const checkout = (key, productId = 'vpn-subscription', variantId = 'one-month') => ({
  idempotencyKey: key,
  items: [{ productId, variantId, quantity: 1, price: 1, fields: {} }]
});

test('onboarding and webhook use only the assigned bot and a safe private secret', async () => {
  const request = fixture();
  const calls = [];
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ method: new URL(url).pathname.split('/').at(-1), data: JSON.parse(options.body) });
    return Response.json({ ok: true, result: { username: 'test_shop_bot' } });
  };
  try {
    assert.equal((await request('/api/setup/connect', { method: 'POST', data: { code: 'wrong' } })).status, 403);
    const connect = await request('/api/setup/connect', { method: 'POST', data: { code } });
    assert.equal(connect.json.botUrl, 'https://t.me/test_shop_bot');
    assert.equal(calls[0].data.url, origin + '/telegram/webhook');
    assert.equal(calls[0].data.secret_token, await webhookSecret(token));
    assert.equal(calls[1].data.menu_button.web_app.url, origin + '/');
    assert.equal((await request('/api/setup/claim', { method: 'POST', data: { code }, id: 100 })).status, 200);
    assert.equal((await request('/api/setup/claim', { method: 'POST', data: { code }, id: 101 })).status, 409);
    const data = { message: { chat: { type: 'private', id: 101 }, text: '/start' } };
    assert.equal((await request('/telegram/webhook', { method: 'POST', data })).status, 403);
    const valid = await request('/telegram/webhook', {
      method: 'POST', data, headers: { 'X-Telegram-Bot-Api-Secret-Token': await webhookSecret(token) }
    });
    assert.equal(valid.status, 200);
    assert.equal(calls.at(-1).data.reply_markup.inline_keyboard[0][0].web_app.url, origin + '/');
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

test('dashboard bundle serves storefront assets and initializes a fresh D1 during setup', async (t) => {
  for (const [path, file] of [
    ['/setup', 'index.html'],
    ['/shop.js', 'shop.js'],
    ['/image-editor.js', 'image-editor.js'],
    ['/pages.js', 'pages.js'],
    ['/assets/gift.webp', 'assets/gift.webp']
  ]) {
    const response = await dashboardWorker.fetch(new Request(origin + path), {});
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), readFileSync(new URL('../public/' + file, import.meta.url)));
  }

  const request = fixture('training', { handler: dashboardWorker, empty: true });
  const telegram = t.mock.method(globalThis, 'fetch', () =>
    Response.json({ ok: true, result: { username: 'test_shop_bot' } }));
  const connect = code => request('/api/setup/connect', { method: 'POST', data: { code } });

  assert.equal((await connect('wrong')).status, 403);
  assert.equal(telegram.mock.callCount(), 0);
  assert.equal((await connect(code)).json.botUrl, 'https://t.me/test_shop_bot');
  assert.equal((await connect(code)).status, 200);
  assert.equal((await request('/api/health')).status, 200);
  assert.equal((await request('/api/setup/claim', { method: 'POST', data: { code }, id: 100 })).status, 200);
});

test('owner changes catalog and adds a fourth product; server price and order access are authoritative', async () => {
  const request = fixture();
  const catalog = structuredClone(defaultCatalog);
  catalog.settings.name = 'فروشگاه من';
  catalog.settings.primary = '#AA5510';
  catalog.settings.bannerProductId = 'custom';
  catalog.categories.push({ id: 'download', name: 'دانلود' });
  catalog.products.push({
    id: 'custom', categoryId: 'download', name: 'کد دانلود', description: 'فایل تمرین', image: '',
    delivery: 'code', active: true, link: '', variants: [{ id: 'v1', name: 'پلن تازه', price: 37, stock: 1 }], fields: []
  });
  await request('/api/setup/claim', { method: 'POST', data: { code }, id: 100 });
  assert.equal((await request('/api/admin/catalog', { method: 'PUT', data: catalog, id: 101 })).status, 403);
  assert.equal((await request('/api/admin/catalog', { method: 'PUT', data: catalog, id: 100 })).status, 200);
  const browse = await request('/api/catalog');
  assert.equal(browse.json.settings.name, catalog.settings.name);
  assert.equal(browse.json.settings.bannerProductId, 'custom');
  assert.equal(browse.json.products.length, 4);
  const add = await request('/api/admin/codes', {
    method: 'POST', id: 100, data: { productId: 'custom', variantId: 'v1', values: ['TRAINING-01', 'TRAINING-01'] }
  });
  assert.equal(add.json.added, 1);
  const input = { id: 101, method: 'POST', data: checkout('new-cart', 'custom', 'v1') };
  const a = await request('/api/orders', input);
  assert.equal(a.status, 201);
  assert.equal(a.json.order.total, 37);
  assert.equal(a.json.invoiceUrl, null);
  assert.equal((await request('/api/orders', input)).json.order.id, a.json.order.id);
  const b = await request('/api/orders', { ...input, id: 102 });
  assert.equal(b.json.code, 'stock_changed');
  const stock = (await request('/api/catalog')).json.products.find(item => item.id === 'custom').variants[0].stock;
  assert.equal(stock, 0);
  assert.equal((await request('/api/orders', { id: 102 })).json.orders.length, 0);
  const delivery = await request('/api/admin/orders/' + a.json.order.id + '/delivery', {
    id: 100, method: 'POST', data: { delivery: [] }
  });
  assert.equal(delivery.json.order.status, 'delivered');
  assert.equal((await request('/api/orders', { id: 101 })).json.orders[0].delivery[0].value, 'TRAINING-01');
  assert.equal((await request('/api/admin/codes', { id: 100 })).json.codes[0].assigned, 1);
  assert.equal(JSON.stringify((await request('/api/catalog')).json).includes('TRAINING-01'), false);
  assert.equal((await request('/api/orders', { id: 102 })).json.orders.length, 0);
});

test('existing dashboard installs can publish photos and custom page options', async () => {
  const request = fixture('training', { handler: dashboardWorker });
  const catalog = structuredClone(defaultCatalog);
  const image = readFileSync(new URL('../public/assets/gift.webp', import.meta.url));
  const imageId = createHash('sha256').update(image).digest('hex');
  const publicPath = '/api/media/' + imageId;
  const uploadPath = '/api/admin/media/' + imageId;
  const upload = { method: 'PUT', bytes: image, headers: { 'Content-Type': 'image/webp' } };
  const save = { method: 'PUT', id: 100, data: catalog };
  Object.assign(catalog.settings, { logo: publicPath, bannerImage: publicPath });
  catalog.products[0].image = publicPath;
  catalog.pages = [{ id: 'help', title: 'راهنما', text: 'روش خرید' }];
  catalog.pageButtons = [
    { page: 'shop', label: 'راهنما', target: 'page:help' },
    { page: 'page:help', label: 'مشاهدهٔ محصول', target: 'product:' + catalog.products[0].id }
  ];

  await request('/api/setup/claim', { method: 'POST', data: { code }, id: 100 });
  assert.equal((await request(publicPath, { raw: true })).status, 404);
  assert.equal((await request('/api/admin/catalog', save)).status, 400);
  assert.equal((await request(uploadPath, { ...upload, id: 101 })).status, 403);
  assert.equal((await request(uploadPath, { ...upload, id: 100, bytes: Buffer.from('<svg/>') })).status, 415);
  assert.equal((await request(uploadPath, { ...upload, id: 100, bytes: Buffer.alloc(450001) })).status, 413);
  assert.equal((await request(uploadPath, { ...upload, id: 100 })).status, 201);
  assert.equal((await request(uploadPath, { ...upload, id: 100 })).status, 201);
  assert.equal((await request('/api/admin/catalog', save)).status, 200);

  const response = await request(publicPath, { raw: true });
  assert.equal(response.headers.get('content-type'), 'image/webp');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), image);
  const head = await request(publicPath, { method: 'HEAD', raw: true });
  assert.equal(head.headers.get('content-length'), String(image.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);

  const { json: storefront } = await request('/api/catalog');
  assert.equal(storefront.settings.logo, publicPath);
  assert.equal(storefront.settings.bannerImage, publicPath);
  assert.equal(storefront.products[0].image, publicPath);
  assert.deepEqual(storefront.pages, catalog.pages);
  assert.deepEqual(storefront.pageButtons, catalog.pageButtons);
  catalog.pageButtons[1].target = 'javascript:alert(1)';
  assert.equal((await request('/api/admin/catalog', save)).status, 400);
  assert.deepEqual((await request('/api/catalog')).json.pageButtons, storefront.pageButtons);
});

test('rejects stale Telegram identity, unchecked fields, and non-purchasable listings', async () => {
  const request = fixture();
  assert.equal((await request('/api/me', { headers: { Authorization: signedProfile(101, 1000) } })).status, 401);
  await request('/api/setup/claim', { method: 'POST', data: { code }, id: 100 });
  const catalog = structuredClone(defaultCatalog);
  catalog.products[2].fields = [{ id: 'devices', label: 'تعداد دستگاه', type: 'select', required: true, options: ['۱', '۲'] }];
  await request('/api/admin/catalog', { method: 'PUT', data: catalog, id: 100 });
  assert.equal((await request('/api/orders', { id: 101, method: 'POST', data: checkout('missing') })).status, 400);
  assert.equal((await request('/api/orders', { id: 101, method: 'POST', data: checkout('stars', 'stars-guide', 'none') })).status, 409);
  const url = '/api/admin/catalog';
  catalog.settings.logo = 'javascript:alert(1)';
  assert.equal((await request(url, { id: 100, method: 'PUT', data: catalog })).status, 400);
});

const termsUrl = 'https://owner.example/terms';
const supportUrl = 'https://t.me/shop_contact';
const liveCheckout = (key) => ({ ...checkout(key), acceptedTermsUrl: termsUrl });

async function prepareLive(request) {
  await request('/api/setup/claim', { method: 'POST', data: { code }, id: 100 });
  const catalog = structuredClone(defaultCatalog);
  catalog.settings.termsUrl = termsUrl;
  catalog.settings.supportUrl = supportUrl;
  catalog.products.find(product => product.id === 'vpn-subscription').liveEnabled = true;
  assert.equal((await request('/api/admin/catalog', { method: 'PUT', id: 100, data: catalog })).status, 200);
  assert.equal((await request('/api/admin/codes', { method: 'POST', id: 100, data: {
    productId: 'vpn-subscription', variantId: 'one-month', values: ['SELLER-STOCK-01']
  } })).json.added, 1);
}

async function captureTelegram(run) {
  const fetchOriginal = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const method = new URL(url).pathname.split('/').at(-1);
    calls.push({ method, data: JSON.parse(options.body) });
    return Response.json({ ok: true, result: method === 'createInvoiceLink' ? 'https://t.me/$invoice' : true });
  };
  try { return await run(calls); } finally { globalThis.fetch = fetchOriginal; }
}

async function telegramUpdate(request, data) {
  return request('/telegram/webhook', {
    method: 'POST', data, headers: { 'X-Telegram-Bot-Api-Secret-Token': await webhookSecret(token) }
  });
}

test('live Stars invoice enforces terms, reserves stock, verifies the payer, and refunds at most once', async () => {
  const request = fixture('live');
  assert.deepEqual((await request('/api/health')).json, { ok: true, mode: 'live' });
  assert.equal((await request('/api/catalog')).json.products.length, 1);
  await prepareLive(request);
  assert.deepEqual((await request('/api/catalog')).json.products.map(product => product.id), ['stars-guide', 'vpn-subscription']);

  await captureTelegram(async calls => {
    const post = (path, data, id = 101) => request(path, { method: 'POST', data, id });
    assert.equal((await post('/api/admin/telegram/connect')).status, 403);
    assert.equal((await post('/api/admin/telegram/connect', null, 100)).status, 200);
    assert.deepEqual(calls.find(call => call.method === 'setWebhook').data.allowed_updates, ['message', 'pre_checkout_query']);
    assert.equal((await post('/api/orders', checkout('invalid-terms'))).json.code, 'terms_required');
    const result = await post('/api/orders', liveCheckout('first-order'));
    const { order, invoiceUrl } = result.json;
    const route = '/api/orders/' + order.id;
    const adminRoute = '/api/admin/orders/' + order.id;
    assert.equal(result.status, 201);
    assert.equal(order.status, 'pending_payment');
    assert.equal(order.total, 120);
    assert.equal(order.payable, true);
    assert.equal(invoiceUrl, 'https://t.me/$invoice');
    const invoice = calls.find(call => call.method === 'createInvoiceLink').data;
    assert.equal(invoice.payload, order.id);
    assert.equal(invoice.currency, 'XTR');
    assert.equal(invoice.provider_token, '');
    assert.equal(invoice.prices.length, 1);
    assert.equal(invoice.prices[0].amount, 120);
    assert.equal((await post('/api/orders', liveCheckout('first-order'))).json.order.id, order.id);
    assert.equal(calls.filter(call => call.method === 'createInvoiceLink').length, 1);

    assert.equal((await post('/api/orders', liveCheckout('other-order'), 102)).json.code, 'stock_changed');
    assert.equal((await post(route + '/invoice', null, 102)).status, 404);
    assert.equal((await post(adminRoute + '/delivery', { delivery: [] }, 100)).status, 409);

    const preCheckout = { id: 'q-ok', from: { id: 101 }, invoice_payload: order.id, total_amount: 120, currency: 'XTR' };
    for (const query of [{ ...preCheckout, from: { id: 102 } }, { ...preCheckout, total_amount: 121 },
      { ...preCheckout, currency: 'USD' }, preCheckout, preCheckout, { ...preCheckout, id: 'second' }]) {
      assert.equal((await telegramUpdate(request, { pre_checkout_query: query })).status, 200);
    }
    assert.deepEqual(calls.filter(call => call.method === 'answerPreCheckoutQuery').map(call => call.data.ok),
      [false, false, false, true, true, false]);
    assert.equal((await post(route + '/cancel')).status, 409);

    const pay = { currency: 'XTR', invoice_payload: order.id, total_amount: 120, telegram_payment_charge_id: 'charge-one' };
    const message = { from: { id: 101 }, chat: { id: 101, type: 'private' }, successful_payment: pay };
    await telegramUpdate(request, { message: { ...message, successful_payment: { ...pay, total_amount: 119 } } });
    assert.equal((await request('/api/orders', { id: 101 })).json.orders[0].status, 'pending_payment');
    await telegramUpdate(request, { message });
    await telegramUpdate(request, { message });
    assert.equal((await request('/api/orders', { id: 101 })).json.orders[0].status, 'paid');
    assert.equal((await request('/api/orders', { id: 102 })).json.orders.length, 0);

    const delivered = await post(adminRoute + '/delivery', { delivery: [] }, 100);
    assert.equal(delivered.json.order.delivery[0].value, 'SELLER-STOCK-01');
    assert.equal(delivered.json.order.status, 'delivered');
    assert.equal((await post(adminRoute + '/refund')).status, 403);
    assert.equal((await post(adminRoute + '/refund', null, 100)).json.order.status, 'refunded');
    assert.equal((await post(adminRoute + '/refund', null, 100)).json.order.status, 'refunded');
    assert.deepEqual(calls.filter(call => call.method === 'refundStarPayment').map(call => call.data), [
      { user_id: 101, telegram_payment_charge_id: 'charge-one' }
    ]);
    const history = (await request('/api/orders', { id: 101 })).json.orders[0];
    assert.equal(history.status, 'refunded');
    assert.deepEqual(history.delivery, []);
    assert.equal((await post('/api/orders', liveCheckout('yet-another'), 102)).json.code, 'stock_changed');
    await telegramUpdate(request, { message: { chat: { id: 101, type: 'private' }, text: '/paysupport' } });
    assert.match(calls.at(-1).data.text, /shop_contact/);
  });
});

test('a cancelled invoice releases its reservation and cannot be paid later', async () => {
  const request = fixture('live');
  await prepareLive(request);
  await captureTelegram(async calls => {
    const input = { method: 'POST', id: 101, data: liveCheckout('first') };
    const first = (await request('/api/orders', input)).json.order;
    assert.equal((await request('/api/orders/' + first.id + '/cancel', { method: 'POST', id: 101 })).json.order.status, 'cancelled');
    await telegramUpdate(request, { pre_checkout_query: {
      id: 'late-cancelled', from: { id: 101 }, invoice_payload: first.id, total_amount: 120, currency: 'XTR'
    } });
    assert.equal(calls.at(-1).data.ok, false);
    const second = await request('/api/orders', { ...input, id: 102, data: liveCheckout('reordered') });
    assert.equal(second.status, 201);
    assert.notEqual(second.json.order.id, first.id);
  });
});
