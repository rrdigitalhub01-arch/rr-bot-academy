import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import worker from '../src/worker.mjs';
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

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_shop.sql', import.meta.url), 'utf8'));

  function bind(sql, args) {
    const stmt = sqlite.prepare(sql);
    return {
      async first() { return stmt.get(...args) ?? null; },
      async all() { return { results: stmt.all(...args) }; },
      async run() { return { meta: { changes: stmt.run(...args).changes } }; }
    };
  }

  const env = {
    BOT_TOKEN: token, SETUP_CODE: code,
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

  return async function request(path, { id, method = 'GET', data, headers } = {}) {
    const request = new Request(origin + path, {
      method,
      headers: {
        ...(id ? { Authorization: signedProfile(id) } : {}),
        ...(data ? { 'Content-Type': 'application/json' } : {}),
        ...headers
      },
      body: data ? JSON.stringify(data) : undefined
    });
    const response = await worker.fetch(request, env);
    return { status: response.status, json: await response.json() };
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
