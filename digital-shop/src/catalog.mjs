import { defaultCatalog } from "../public/default-catalog.js";

export { defaultCatalog };

export class ShopError extends Error {
  constructor(status, message, code = 'invalid') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function check(condition, message = 'مقدار واردشده معتبر نیست.', status = 400, code) {
  if (!condition) throw new ShopError(status, message, code);
}

function string(value, max, required = false) {
  check(typeof value === 'string' && value.trim().length <= max && (!required || value.trim()));
  return value.trim();
}

export function identifier(value) {
  check(typeof value === 'string' && /^[\w-]{1,80}$/.test(value), 'شناسه معتبر نیست.');
  return value;
}

function unique(list) {
  check(new Set(list.map(({ id }) => id)).size === list.length, 'شناسهٔ تکراری وجود دارد.');
  return list;
}

function collection(list, max) {
  check(Array.isArray(list) && list.length <= max);
  return list;
}

function color(value) {
  check(typeof value === 'string' && /^#[\da-f]{6}$/i.test(value), 'رنگ باید با # و شش کاراکتر وارد شود.');
  return value;
}

function publicUrl(value, { media = false } = {}) {
  const url = string(value ?? '', 640);
  if (!url) return '';
  if (media && /^\/assets\/[\w.-]+$/.test(url)) return url;
  check(/^https:\/\/[^\s]+$/.test(url), 'لینک باید با https:// شروع شود.');
  try {
    const parsed = new URL(url);
    check(parsed.hostname && !parsed.username && !parsed.password);
    return parsed.href;
  } catch {
    throw new ShopError(400, 'لینک معتبر نیست.');
  }
}

function integer(value, min, max) {
  check(Number.isSafeInteger(value) && value >= min && value <= max);
  return value;
}

export function cleanCatalog(input) {
  check(input && typeof input.settings === 'object' && input.settings);
  const src = input.settings;
  const labels = src.labels ?? {};
  const font = src.font ?? 'system';
  check(['system', 'tahoma', 'serif'].includes(font), 'فونت انتخابی معتبر نیست.');
  const settings = {
    name: string(src.name, 70, true), welcome: string(src.welcome, 500),
    bannerTitle: string(src.bannerTitle, 100), bannerText: string(src.bannerText, 500),
    bannerImage: publicUrl(src.bannerImage, { media: true }),
    bannerProductId: src.bannerProductId ? identifier(src.bannerProductId) : '',
    logo: publicUrl(src.logo, { media: true }),
    primary: color(src.primary), background: color(src.background), surface: color(src.surface),
    text: color(src.text), accent: color(src.accent), radius: integer(src.radius, 4, 36),
    font,
    labels: Object.fromEntries(Object.entries(defaultCatalog.settings.labels).map(([key, fallback]) => [key, string(labels[key] ?? fallback, 35, true)])),
    supportUrl: publicUrl(src.supportUrl), termsUrl: publicUrl(src.termsUrl)
  };
  const categories = unique(collection(input.categories, 50).map(item => {
    check(item && typeof item === "object");
    return { id: identifier(item.id), name: string(item.name, 70, true) };
  }));
  const categoryIds = new Set(categories.map(({ id }) => id));
  const products = unique(collection(input.products, 150).map(item => {
    check(item && categoryIds.has(item.categoryId), 'برای محصول یک دستهٔ معتبر انتخاب کن.');
    check(['manual', 'code', 'gift', 'link'].includes(item.delivery));
    const link = publicUrl(item.link);
    check(item.delivery !== 'link' || link, 'برای این محصول لینک لازم است.');
    const variants = unique(collection(item.variants, 20).map(variant => ({
      id: identifier(variant.id), name: string(variant.name, 90, true),
      price: integer(variant.price, 1, 1_000_000),
      stock: variant.stock === null ? null : integer(variant.stock, 0, 1_000_000)
    })));
    check(item.delivery === 'link' || variants.length, 'برای محصول حداقل یک پلن بساز.');
    const fields = unique(collection(item.fields, 10).map(field => {
      check(['text', 'number', 'select'].includes(field.type));
      const options = field.type === 'select' ? collection(field.options, 30).map(value => string(value, 80, true)) : [];
      check(field.type !== 'select' || options.length, 'فیلد انتخابی به گزینه نیاز دارد.');
      return { id: identifier(field.id), label: string(field.label, 100, true), type: field.type, required: field.required === true, options };
    }));
    return {
      id: identifier(item.id), categoryId: item.categoryId, name: string(item.name, 90, true),
      description: string(item.description, 1500), image: publicUrl(item.image, { media: true }),
      active: item.active === true, liveEnabled: item.liveEnabled === true, delivery: item.delivery, link, variants, fields
    };
  }));
  return { settings, categories, products };
}

export function orderItems(catalog, requested) {
  check(Array.isArray(requested) && requested.length > 0 && requested.length <= 20, 'سبد باید بین یک تا ۲۰ ردیف داشته باشد.');
  return requested.map((item) => {
    check(item && typeof item === 'object');
    const product = catalog.products.find(({ id, active }) => active && id === item.productId);
    const variant = product?.variants.find(({ id }) => id === item.variantId);
    check(variant && product.delivery !== 'link', 'محصول یا پلن در دسترس نیست.', 409, 'unavailable');
    const fields = Object.create(null);
    for (const field of product.fields) {
      const value = string(String(item.fields?.[field.id] ?? ''), 200, field.required);
      check(!value || field.type !== 'number' || /^[0-9۰-۹٠-٩]+$/.test(value), 'برای «' + field.label + '» عدد وارد کن.');
      check(!value || field.type !== 'select' || field.options.includes(value), 'گزینهٔ «' + field.label + '» معتبر نیست.');
      fields[field.id] = value;
    }
    return {
      productId: product.id, variantId: variant.id, name: product.name, variant: variant.name,
      quantity: integer(item.quantity, 1, 50), price: variant.price, stock: variant.stock,
      method: product.delivery, fields
    };
  });
}
