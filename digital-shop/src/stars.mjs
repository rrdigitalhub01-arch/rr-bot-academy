import { check } from './catalog.mjs';
import { telegram } from './telegram.mjs';

export const holdTime = 20 * 60 * 1000;
const refundLeaseTime = 60 * 1000;

const paymentOrder = (db, id) => db.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first();

export async function invoiceFor(env, row) {
  if (row.mode !== 'live' || row.status !== 'pending_payment' || row.hold_until <= Date.now() || row.checkout_query) return null;
  if (row.invoice_url) return row.invoice_url;
  const items = JSON.parse(row.items);
  const url = await telegram(env.BOT_TOKEN, 'createInvoiceLink', {
    title: 'سفارش ' + row.id,
    description: Array.from(items.map(item => item.name + ' × ' + item.quantity).join('، ')).slice(0, 240).join(''),
    payload: row.id,
    provider_token: '',
    currency: 'XTR',
    prices: [{ label: 'جمع سفارش', amount: row.total }]
  });
  check(typeof url === 'string' && url.startsWith('https://t.me/'), 'تلگرام آدرس فاکتور معتبری نداد.', 502);
  const saved = await env.DB.prepare(`
    UPDATE orders SET invoice_url = COALESCE(invoice_url, ?)
    WHERE id = ? AND status = 'pending_payment' AND checkout_query IS NULL AND hold_until > ?
    RETURNING invoice_url
  `).bind(url, row.id, Date.now()).first();
  return saved?.invoice_url ?? null;
}

export async function cancelInvoice(db, id, customer) {
  return db.prepare(`
    UPDATE orders SET status = 'cancelled'
    WHERE id = ? AND customer = ? AND mode = 'live' AND status = 'pending_payment' AND checkout_query IS NULL
    RETURNING *
  `).bind(id, customer).first();
}

export async function approveCheckout(env, query) {
  const { id, invoice_payload: order, from, currency, total_amount: amount } = query;
  const row = currency === 'XTR' && id && order && from?.id && Number.isSafeInteger(amount) && await env.DB.prepare(`
    UPDATE orders SET checkout_query = ?
    WHERE id = ? AND customer = ? AND total = ? AND mode = 'live' AND status = 'pending_payment'
      AND (checkout_query = ? OR (checkout_query IS NULL AND hold_until > ?))
    RETURNING id
  `).bind(id, order, String(from.id), amount, id, Date.now()).first();
  await telegram(env.BOT_TOKEN, 'answerPreCheckoutQuery', {
    pre_checkout_query_id: id,
    ok: Boolean(row),
    ...(row ? {} : { error_message: 'این فاکتور معتبر نیست یا مهلت آن تمام شده. در فروشگاه سفارش تازه ثبت کن.' })
  });
}

export async function recordPayment(db, buyer, payment) {
  const { currency, invoice_payload: order, total_amount: amount, telegram_payment_charge_id: charge } = payment;
  if (currency !== 'XTR' || !order || !charge || !Number.isSafeInteger(amount)) return;
  // An approval holds stock even after invoice expiry. Duplicate updates never change a settled order.
  await db.prepare(`
    UPDATE orders SET status = 'paid', payment_charge = ?
    WHERE id = ? AND customer = ? AND total = ? AND mode = 'live'
      AND status = 'pending_payment' AND checkout_query IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM orders WHERE payment_charge = ?)
  `).bind(charge, order, buyer, amount, charge).run();
}

export async function recordRefund(db, payment) {
  const { currency, invoice_payload: order, total_amount: amount, telegram_payment_charge_id: charge } = payment;
  if (currency !== 'XTR' || !order || !charge || !Number.isSafeInteger(amount)) return;
  await db.prepare(`
    UPDATE orders SET status = 'refunded', refund_request = NULL, refund_started = NULL
    WHERE id = ? AND total = ? AND payment_charge = ? AND mode = 'live' AND status IN ('paid', 'delivered')
  `).bind(order, amount, charge).run();
}

export async function refundOrder(env, id) {
  const current = await paymentOrder(env.DB, id);
  check(current, 'سفارش پیدا نشد.', 404);
  if (current.status === 'refunded') return current;
  const lease = crypto.randomUUID();
  const now = Date.now();
  const row = await env.DB.prepare(`
    UPDATE orders SET refund_request = ?, refund_started = ?
    WHERE id = ? AND mode = 'live' AND payment_charge IS NOT NULL AND status IN ('paid', 'delivered')
      AND (refund_request IS NULL OR refund_started < ?)
    RETURNING *
  `).bind(lease, now, id, now - refundLeaseTime).first();
  check(row, 'بازپرداخت این سفارش در دست بررسی است یا هنوز پرداختی ثبت نشده.', 409);
  const refunded = await telegram(env.BOT_TOKEN, 'refundStarPayment', {
    user_id: Number(row.customer), telegram_payment_charge_id: row.payment_charge
  });
  check(refunded === true, 'تلگرام بازپرداخت را تأیید نکرد.', 502);
  await recordRefund(env.DB, {
    currency: 'XTR', invoice_payload: id, total_amount: row.total, telegram_payment_charge_id: row.payment_charge
  });
  return paymentOrder(env.DB, id);
}
