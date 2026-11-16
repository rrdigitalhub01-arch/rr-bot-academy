import {defaultCatalog as defaults} from "./default-catalog.js";

export {defaults};

const STORAGE_KEY = "rr-academy-digital-shop-v1";
export const shopState = readStorage(STORAGE_KEY, {catalog: defaults, orders: [], keys: {}, codes: []});

export function readStorage(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? structuredClone(fallback);
  } catch {
    return structuredClone(fallback);
  }
}

export function writeStorage(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch {
    throw new Error("فضای ذخیره‌سازی مرورگر در دسترس نیست.");
  }
}

export function id() {
  return globalThis.crypto.randomUUID();
}

function selectValue(value, available, fallback) {
  return available.includes(value) ? value : fallback;
}

function trim(value, limit = 240) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

export function safeUrl(value, local = false) {
  if (typeof value !== "string") return "";
  if (local && /^\/assets\/[A-Za-z0-9_.-]+$/.test(value)) return value;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
  } catch {
    return "";
  }
}

function color(value, fallback) {
  return typeof value === "string" && /^#[a-f\d]{6}$/i.test(value) ? value : fallback;
}

function validateItems(items, max) {
  return Array.isArray(items) ? items.filter(item => item && typeof item === "object").slice(0, max) : [];
}

export function cleanCatalog(source) {
  if (!source || typeof source !== "object" || !source.settings || !Array.isArray(source.categories) || !Array.isArray(source.products)) {
    throw new Error("فایل تنظیمات فروشگاه معتبر نیست.");
  }

  const initial = defaults.settings;
  const input = source.settings;
  const settings = {
    name: trim(input.name, 70) || initial.name,
    welcome: trim(input.welcome, 500),
    bannerTitle: trim(input.bannerTitle, 100),
    bannerText: trim(input.bannerText, 500),
    bannerImage: safeUrl(input.bannerImage, true),
    bannerProductId: trim(input.bannerProductId, 72),
    logo: safeUrl(input.logo, true),
    primary: color(input.primary, initial.primary),
    background: color(input.background, initial.background),
    surface: color(input.surface, initial.surface),
    text: color(input.text, initial.text),
    accent: color(input.accent, initial.accent),
    radius: Number.isInteger(input.radius) ? Math.max(4, Math.min(36, input.radius)) : initial.radius,
    font: selectValue(input.font, ["system", "tahoma", "serif"], initial.font),
    labels: Object.fromEntries(Object.entries(initial.labels).map(([key, value]) => [
      key, trim(input.labels?.[key], 32) || value,
    ])),
    supportUrl: safeUrl(input.supportUrl),
    termsUrl: safeUrl(input.termsUrl),
  };

  const categories = validateItems(source.categories, 50).map(category => ({
    id: trim(category.id, 72) || id(),
    name: trim(category.name, 64),
  })).filter(category => category.name);

  const categoryIds = new Set(categories.map(category => category.id));
  if (categoryIds.size !== categories.length) throw new Error("شناسهٔ دسته‌ها تکراری است.");

  const products = validateItems(source.products, 150).map(product => {
    const delivery = selectValue(product.delivery, ["manual", "code", "gift", "link"], "manual");
    const variants = validateItems(product.variants, 20).map(variant => ({
      id: trim(variant.id, 72) || id(),
      name: trim(variant.name, 80),
      price: Number.isSafeInteger(variant.price) ? Math.max(1, Math.min(1_000_000, variant.price)) : 1,
      stock: Number.isSafeInteger(variant.stock) ? Math.max(0, Math.min(1_000_000, variant.stock)) : null,
    })).filter(variant => variant.name);
    const fields = validateItems(product.fields, 10).map(field => ({
      id: trim(field.id, 72) || id(),
      label: trim(field.label, 64),
      type: selectValue(field.type, ["text", "number", "select"], "text"),
      required: field.required === true,
      options: Array.isArray(field.options) ? field.options.map(option => trim(option, 80)).filter(Boolean).slice(0, 30) : [],
    })).filter(field => field.label);
    if (new Set(variants.map(variant => variant.id)).size !== variants.length ||
        new Set(fields.map(field => field.id)).size !== fields.length) {
      throw new Error("شناسهٔ پلن‌ها یا فیلدهای محصول تکراری است.");
    }
    return {
      id: trim(product.id, 72) || id(),
      categoryId: trim(product.categoryId, 72),
      name: trim(product.name, 80),
      description: trim(product.description, 1500),
      image: safeUrl(product.image, true),
      active: product.active === true,
      liveEnabled: product.liveEnabled === true,
      delivery,
      link: safeUrl(product.link),
      variants: delivery === "link" ? [] : variants,
      fields: delivery === "link" ? [] : fields,
    };
  });

  const productIds = new Set(products.map(product => product.id));
  if (productIds.size !== products.length) throw new Error("شناسهٔ محصولات تکراری است.");
  if (!productIds.has(settings.bannerProductId)) settings.bannerProductId = "";
  for (const product of products) {
    if (!product.name || !categoryIds.has(product.categoryId)) {
      throw new Error("نام و دستهٔ هر محصول باید مشخص باشند.");
    }
    if (product.delivery === "link" ? !product.link : !product.variants.length) {
      throw new Error(`محصول «${product.name}» به لینک معتبر یا یک پلن نیاز دارد.`);
    }
    if (product.fields.some(field => field.type === "select" && !field.options.length)) {
      throw new Error(`گزینه‌های فیلد انتخابی «${product.name}» را مشخص کنید.`);
    }
  }
  return {settings, categories, products};
}

function saveDemo() {
  writeStorage(STORAGE_KEY, shopState);
}

function sampleOrder(body) {
  const previous = shopState.keys[body.idempotencyKey];
  if (previous) return {order: shopState.orders.find(order => order.id === previous), invoiceUrl: null};
  const quantities = new Map();
  const items = body.items.map(item => {
    const product = shopState.catalog.products.find(entry => entry.id === item.productId && entry.active);
    const variant = product?.variants.find(entry => entry.id === item.variantId);
    if (!variant || product.delivery === "link") throw new Error("یکی از کالاها دیگر فعال نیست.");
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 50) {
      throw new Error("تعداد کالا معتبر نیست.");
    }
    const previousQuantity = quantities.get(variant) ?? 0;
    const quantity = previousQuantity + item.quantity;
    if (variant.stock !== null && variant.stock < quantity) throw new Error(`موجودی «${product.name}» کافی نیست.`);
    quantities.set(variant, quantity);
    const fields = Object.fromEntries(product.fields.map(field => {
      const value = trim(item.fields?.[field.id], 180);
      if (!value && field.required ||
          value && field.type === "number" && !/^[0-9۰-۹٠-٩]+$/.test(value) ||
          value && field.type === "select" && !field.options.includes(value)) {
        throw new Error(`فیلد «${field.label}» را بررسی کنید.`);
      }
      return [field.id, value];
    }));
    return {
      productId: product.id, variantId: variant.id, name: product.name, variant: variant.name,
      quantity: item.quantity, price: variant.price, fields,
    };
  });
  if (!items.length) throw new Error("سبد خرید خالی است.");
  for (const [variant, quantity] of quantities) {
    if (variant.stock !== null) variant.stock -= quantity;
  }
  const order = {
    id: "RR-" + id().slice(0, 8).toUpperCase(),
    status: "placed",
    createdAt: new Date().toISOString(),
    total: items.reduce((total, item) => total + item.price * item.quantity, 0),
    items,
    delivery: [],
  };
  shopState.orders.unshift(order);
  shopState.keys[body.idempotencyKey] = order.id;
  saveDemo();
  return {order, invoiceUrl: null};
}

export function createDemoApi() {
  return async function demoApi(path, {method = "GET", body} = {}) {
    if (path === "/api/me") {
      return {owner: true, profile: {id: "demo-owner", first_name: "کارآموز"}, mode: "training"};
    }
    if (path === "/api/catalog") {
      return structuredClone({...shopState.catalog, products: shopState.catalog.products.filter(product => product.active)});
    }
    if (path === "/api/admin/catalog") {
      if (method === "PUT") {
        shopState.catalog = cleanCatalog(body);
        saveDemo();
      }
      return structuredClone(shopState.catalog);
    }
    if (path === "/api/orders" && method === "POST") return structuredClone(sampleOrder(body));
    if (path === "/api/orders" || path === "/api/admin/orders") return {orders: structuredClone(shopState.orders)};
    if (path === "/api/admin/codes") {
      if (method === "POST") {
        const product = shopState.catalog.products.find(entry => entry.id === body.productId && entry.delivery === "code");
        const variant = product?.variants.find(entry => entry.id === body.variantId);
        if (!variant) throw new Error("اول محصول و پلن را ذخیره کنید.");
        const existing = new Set(shopState.codes.map(entry => entry.value));
        const values = [...new Set(body.values.map(value => trim(value, 600)).filter(Boolean))].filter(value => !existing.has(value));
        shopState.codes.push(...values.map(value => ({productId: product.id, variantId: variant.id, value, orderId: null})));
        saveDemo();
        return {added: values.length};
      }
      const groups = new Map();
      for (const code of shopState.codes) {
        const key = JSON.stringify([code.productId, code.variantId]);
        const entry = groups.get(key) ?? {productId: code.productId, variantId: code.variantId, available: 0, assigned: 0};
        if (code.orderId) entry.assigned++;
        else entry.available++;
        groups.set(key, entry);
      }
      return {codes: [...groups.values()]};
    }
    const deliveryPath = /^\/api\/admin\/orders\/([^/]+)\/delivery$/.exec(path);
    if (deliveryPath) {
      const order = shopState.orders.find(entry => entry.id === decodeURIComponent(deliveryPath[1]));
      if (!order || order.status !== "placed") throw new Error("این سفارش آمادهٔ تحویل نیست.");
      const output = body.delivery.map(entry => ({label: trim(entry.label), value: trim(entry.value, 600)}))
        .filter(entry => entry.label && entry.value);
      if (!output.length && body.delivery.length) throw new Error("عنوان و مقدار تحویل را وارد کنید.");
      const chosen = new Set();
      if (!output.length) {
        for (const item of order.items) {
          const product = shopState.catalog.products.find(entry => entry.id === item.productId);
          if (product?.delivery !== "code") throw new Error("این سفارش به تحویل دستی نیاز دارد.");
          for (let count = 0; count < item.quantity; count++) {
            const code = shopState.codes.find(entry => entry.productId === item.productId &&
              entry.variantId === item.variantId && !entry.orderId && !chosen.has(entry));
            if (!code) throw new Error("موجودی کد کافی نیست.");
            chosen.add(code);
            output.push({label: item.name, value: code.value});
          }
        }
      }
      for (const code of chosen) code.orderId = order.id;
      order.status = "delivered";
      order.delivery = output;
      saveDemo();
      return {order: structuredClone(order)};
    }
    throw new Error("این بخش در پیش‌نمایش مرورگر در دسترس نیست.");
  };
}

export function createRemoteApi(telegram) {
  return async function callApi(path, {method = "GET", body} = {}) {
    const headers = {Accept: "application/json"};
    if (telegram?.initData) headers.Authorization = `tma ${telegram.initData}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(path, {method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store"});
    const data = await response.json().catch(() => null);
    if (!response.ok || !data) {
      const error = new Error(data?.error || "ارتباط با فروشگاه برقرار نشد. دوباره امتحان کنید.");
      error.code = data?.code;
      throw error;
    }
    return data;
  };
}
