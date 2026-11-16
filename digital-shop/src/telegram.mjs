import { check, ShopError } from './catalog.mjs';

const encoder = new TextEncoder();

async function hmac(key, value) {
  const bytes = typeof key === 'string' ? encoder.encode(key) : key;
  const imported = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, encoder.encode(value)));
}

const toHex = (bytes) => Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');

export function equal(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index++) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

export async function profileFrom(request, token) {
  const authorization = request.headers.get('Authorization') ?? '';
  const raw = authorization.startsWith('tma ') ? authorization.slice(4) : '';
  check(authorization && raw && raw.length <= 8192 && token, 'فروشگاه را از داخل تلگرام دوباره باز کن.', 401, 'telegram_auth');
  const params = new URLSearchParams(raw);
  const digest = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  const now = Math.floor(Date.now() / 1000);
  check(digest && /^[\da-f]{64}$/.test(digest) && authDate > now - 3600 && authDate <= now + 60,
    'نشست منقضی شده. فروشگاه را دوباره از ربات باز کن.', 401, 'telegram_auth');
  params.delete('hash');
  check(new Set(params.keys()).size === [...params.keys()].length, 'ورود تلگرام معتبر نیست.', 401, 'telegram_auth');
  params.sort();
  const sign = toHex(await hmac(await hmac('WebAppData', token), [...params].map(([key, value]) => key + '=' + value).join('\n')));
  check(equal(sign, digest), 'ورود تلگرام معتبر نیست.', 401, 'telegram_auth');
  let user;
  try { user = JSON.parse(params.get('user')); } catch { /* handled below */ }
  check(user && Number.isSafeInteger(user.id) && user.id > 0, 'ورود تلگرام معتبر نیست.', 401, 'telegram_auth');
  return { id: String(user.id), first_name: user.first_name ?? '' };
}

export const webhookSecret = async (token) => toHex(await hmac(token, 'rr-digital-shop:webhook:v1'));

export async function telegram(token, method, body) {
  const url = 'https://api.telegram.org/bot' + token + '/' + method;
  try {
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(7000)
    });
    const output = await response.json();
    if (response.ok && output.ok === true) return output.result;
  } catch {
    // Connection and parsing errors can contain the signed bot URL.
  }
  throw new ShopError(502, 'ارتباط با تلگرام برقرار نشد. تنظیمات ربات را بررسی کن.', 'telegram_upstream');
}
