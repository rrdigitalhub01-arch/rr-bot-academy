import {createDemoApi, createRemoteApi, defaults, id, readStorage, safeUrl, writeStorage} from "./model.js";
import {button, empty, field, fmt, href, input, node, orderCard, picture, price, select, setTheme} from "./ui.js";
import {showStudio} from "./studio.js";

const screen = document.querySelector("#screen");
const header = document.querySelector("#header");
const navigation = document.querySelector("#navigation");
const notice = document.querySelector("#notice");
const telegram = window.Telegram?.WebApp;
const demo = !telegram?.initData && !location.pathname.startsWith("/setup");
const api = demo ? createDemoApi() : createRemoteApi(telegram);
const icons = {shop: "▦", cart: "▱", orders: "☷", pages: "▤"};
const state = {
  page: location.pathname.startsWith("/setup") ? "setup" : "shop",
  owner: false, hasOwner: true, training: true, category: "", query: "", shopScroll: 0,
  catalog: structuredClone(defaults), cart: [], checkoutKey: id(), checkoutBusy: false, acceptedTermsUrl: "", orders: [],
};

let toastTimer;
let cartKey;

function notify(message) {
  notice.textContent = message;
  notice.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { notice.hidden = true; }, 3800);
}

function rememberCart() {
  if (!cartKey) return;
  try {
    writeStorage(cartKey, {items: state.cart, checkoutKey: state.checkoutKey});
  } catch (error) {
    notify(error.message);
  }
}

function updateCart(updated) {
  state.cart = updated;
  state.checkoutKey = id();
  state.acceptedTermsUrl = "";
  rememberCart();
  renderHeader();
  renderNav();
}

function go(page) {
  if (state.page === "shop" && page === "detail") state.shopScroll = window.scrollY;
  if (state.page !== "detail" && page === "shop") state.shopScroll = 0;
  state.page = page;
  window.scrollTo(0, 0);
  render();
  if (page === "shop" && state.shopScroll) window.scrollTo(0, state.shopScroll);
}

async function updateCatalog() {
  state.catalog = await api("/api/catalog");
}

function renderHeader() {
  const settings = state.catalog.settings;
  const actions = [];
  if (state.page === "setup") {
    actions.push(telegram?.initData ? button("بازگشت به فروشگاه", () => go("shop"), "ghost") :
      node("a", {href: "/", class: "button ghost"}, "پیش‌نمایش"));
  } else if (state.page === "studio") actions.push(button("بازگشت به فروشگاه", () => go("shop"), "ghost"));
  else if (state.owner && state.page !== "setup") actions.push(button(settings.labels.admin, () => go("studio"), "ghost"));
  if (state.page === "shop" && demo) actions.push(node("a", {href: "/setup", class: "button ghost"}, "اتصال ربات"));
  else if (state.page === "shop" && !state.hasOwner) {
    actions.push(button("راه‌اندازی مدیریت", () => go("setup"), "ghost"));
  }
  if (state.page !== "studio" && state.page !== "setup" && safeUrl(settings.supportUrl) && (!demo || state.page !== "shop")) {
    actions.push(href(settings.labels.support, settings.supportUrl, "ghost"));
  }
  header.replaceChildren(node("div", {class: "header-inner"},
    node("div", {class: "brand"},
      node("span", {class: "brand-mark", "aria-hidden": "true"}, safeUrl(settings.logo, true) ?
        picture(settings.logo, "brand-logo", "", false) : state.catalog.settings.name === defaults.settings.name ? "RR" : settings.name.slice(0, 2)),
      node("div", {class: "brand-copy"},
        node("span", {class: "brand-name"}, settings.name),
        state.training && node("span", {class: "badge"}, demo ? "پیش‌نمایش آزمایشی" : "فروشگاه آزمایشی"),
      ),
    ),
    node("div", {class: "header-actions"}, actions),
  ));
}

function renderNav() {
  navigation.hidden = ["studio", "setup"].includes(state.page);
  if (navigation.hidden) return;
  const count = state.cart.reduce((sum, item) => sum + item.quantity, 0);
  const pages = ["shop", "cart", "orders"];
  if (state.catalog.pages?.length) pages.push("pages");
  navigation.classList.toggle("with-pages", pages.length === 4);
  navigation.replaceChildren(...pages.map(page =>
    node("button", {type: "button", onclick: () => go(page), "aria-current": (state.page === page ||
      page === "shop" && state.page === "detail" || page === "pages" && state.page.startsWith("page:")) ? "page" : undefined},
    node("span", {class: "nav-icon", "aria-hidden": "true"}, icons[page]),
    node("span", {}, page === "pages" ? "صفحه‌ها" : state.catalog.settings.labels[page], page === "cart" && count ? " · " + fmt(count) : "")),
  ));
}

function render() {
  const settings = state.catalog.settings;
  setTheme(document.documentElement, settings);
  document.title = settings.name;
  document.querySelector('meta[name="theme-color"]').content = settings.background;
  renderHeader();
  renderNav();
  screen.setAttribute("aria-busy", "false");
  screen.className = "screen";
  if (state.page === "detail") {
    telegram?.BackButton?.show();
    showDetail();
    return;
  }
  if (state.page.startsWith("page:")) telegram?.BackButton?.show();
  else telegram?.BackButton?.hide();
  if (state.page === "pages" || state.page.startsWith("page:")) showPages();
  else if (state.page === "cart") showCart();
  else if (state.page === "orders") showOrders();
  else if (state.page === "studio") {
    showStudio({screen, api, demo, training: state.training, notify, updateCatalog, rerender: render, go});
  } else if (state.page === "setup") showSetup();
  else showShop();
}

function renderBuyerPage(content) {
  const productPage = state.page === "detail" ? "product:" + state.product.id : "";
  const actions = (state.catalog.pageButtons ?? []).filter(option => option.page === state.page || option.page === productPage)
    .map(({label, target}) => {
      if (safeUrl(target)) return href(label, target, "subtle");
      if (target.startsWith("product:")) {
        const product = state.catalog.products.find(product => product.id === target.slice(8));
        return product && button(label, () => openProduct(product), "subtle");
      }
      return button(label, () => go(target), "subtle");
    }).filter(Boolean);
  if (actions.length) content.append(node("nav", {class: "row wrap page-options", "aria-label": "گزینه‌های صفحه"}, actions));
  screen.replaceChildren(content);
}

function showPages() {
  const pages = state.catalog.pages ?? [];
  const page = pages.find(page => "page:" + page.id === state.page);
  const content = page ? node("section", {class: "panel stack narrow"},
    node("h1", {}, page.title),
    page.text && node("p", {class: "page-text"}, page.text),
  ) : node("section", {class: "stack narrow"},
    node("h1", {}, "صفحه‌ها"),
    pages.map(page => button(page.title, () => go("page:" + page.id), "subtle")),
  );
  renderBuyerPage(content);
}

function featuredBanner(settings, products, openProduct) {
  if (!settings.bannerTitle && !settings.bannerText && !safeUrl(settings.bannerImage, true)) return null;
  const featured = products.find(product => product.id === settings.bannerProductId);
  const hero = node("section", {class: "hero"},
    safeUrl(settings.bannerImage, true) && picture(settings.bannerImage, "hero-picture", "", false),
    node("div", {class: "hero-copy stack compact"},
      settings.bannerTitle && node("h2", {}, settings.bannerTitle),
      settings.bannerText && node("p", {}, settings.bannerText),
      featured && button("مشاهدهٔ محصول", () => openProduct(featured), "primary"),
    ),
  );
  return hero;
}

function productCard(product, openProduct) {
  const stock = product.variants.filter(variant => variant.stock === null || variant.stock > 0);
  const cost = stock.length ? Math.min(...stock.map(variant => variant.price)) : 0;
  return node("button", {type: "button", class: "product", onclick: () => openProduct(product)},
    picture(product.image, "product-picture"),
    node("span", {class: "product-copy"},
      node("span", {class: "product-name"}, product.name),
      product.delivery === "link" ? node("small", {class: "highlight"}, "مشاهدهٔ راهنما") :
        stock.length ? node("small", {class: "price"}, price(cost)) : node("small", {class: "muted"}, "ناموجود"),
    ),
  );
}

function openProduct(product) {
  state.product = product;
  state.variantId = product.variants.find(variant => variant.stock === null || variant.stock > 0)?.id;
  state.productQuantity = 1;
  state.productFields = {};
  go("detail");
}

function showShop() {
  screen.classList.add("store-view");
  const {settings, categories, products} = state.catalog;
  const list = node("div");
  const search = input({type: "search", placeholder: "جست‌وجوی محصول", "aria-label": "جست‌وجوی محصول", value: state.query,
    oninput: event => { state.query = event.target.value; showProducts(); }});
  const categoryButtons = [["", "همه"], ...categories.map(category => [category.id, category.name])].map(([key, title]) =>
    node("button", {type: "button", class: "chip", "aria-pressed": String(state.category === key), onclick: event => {
      state.category = key;
      for (const chip of categoryButtons) chip.setAttribute("aria-pressed", String(chip === event.currentTarget));
      showProducts();
    }}, title));
  function showProducts() {
    const query = state.query.trim().toLocaleLowerCase("fa").replaceAll("ي", "ی").replaceAll("ك", "ک");
    const matches = products.filter(product => (!state.category || product.categoryId === state.category) &&
      (product.name + " " + product.description).toLocaleLowerCase("fa").replaceAll("ي", "ی").replaceAll("ك", "ک").includes(query));
    list.replaceChildren(matches.length ? node("div", {class: "cards"}, matches.map(product => productCard(product, openProduct))) :
      empty("محصولی پیدا نشد", "عبارت جست‌وجو یا دسته را عوض کنید."));
  }
  showProducts();
  renderBuyerPage(node("div", {class: "stack"},
    node("div", {class: "stack compact"},
      node("h1", {}, settings.labels.shop),
      settings.welcome && node("p", {class: "muted"}, settings.welcome),
    ),
    node("div", {class: "search"}, node("span", {class: "search-icon", "aria-hidden": "true"}), search),
    featuredBanner(settings, products, openProduct),
    node("div", {class: "chips", "aria-label": "دسته‌های محصولات"}, categoryButtons),
    list,
    demo && safeUrl(settings.supportUrl) && node("div", {},
      href(settings.labels.support, settings.supportUrl, "ghost")),
  ));
}

const deliveryText = {
  manual: "پس از آماده شدن، نتیجهٔ تحویل در سفارش‌ها نمایش داده می‌شود.",
  code: "کد یا لینک اختصاصی در بخش سفارش‌ها نمایش داده می‌شود.",
  gift: "وضعیت ارسال گیفت از بخش سفارش‌ها قابل پیگیری است.",
};

function customerField(descriptor) {
  const value = state.productFields[descriptor.id] ?? "";
  const attributes = {required: descriptor.required, name: descriptor.id,
    oninput: event => { state.productFields[descriptor.id] = event.target.value; }};
  const control = descriptor.type === "select" ?
    select([["", "انتخاب کنید"], ...descriptor.options.map(option => [option, option])], value, attributes) :
    input({type: "text", inputmode: descriptor.type === "number" ? "numeric" : undefined,
      pattern: descriptor.type === "number" ? "[0-9۰-۹٠-٩]+" : undefined,
      maxlength: 180, value, ...attributes});
  return field(descriptor.label + (descriptor.required ? " *" : ""), control);
}

function stepper(quantity, change, maximum = 50, busy = false) {
  return node("div", {class: "stepper"},
    button("−", () => change(quantity - 1), "square ghost", {disabled: busy || quantity <= 1, "aria-label": "کم کردن تعداد"}),
    node("output", {"aria-label": "تعداد"}, fmt(quantity)),
    button("+", () => change(quantity + 1), "square ghost", {disabled: busy || quantity >= maximum, "aria-label": "زیاد کردن تعداد"}),
  );
}

function showDetail() {
  const product = state.product;
  const settings = state.catalog.settings;
  const back = button("بازگشت به فروشگاه", () => go("shop"), "ghost");
  const content = node("div", {class: "stack narrow"},
    node("div", {}, back),
    picture(product.image, "detail-picture", "", false),
    node("h1", {}, product.name),
    node("p", {class: "muted"}, product.description),
  );
  if (product.delivery === "link") {
    if (safeUrl(product.link)) content.append(href("مشاهدهٔ راهنمای رسمی", product.link, "primary"));
    renderBuyerPage(content);
    return;
  }
  const form = node("form", {class: "panel stack", onsubmit: event => { event.preventDefault(); addToCart(product); }});
  const variants = node("div", {class: "chips", "aria-label": "انتخاب پلن"});
  let quantityArea;
  const selected = () => product.variants.find(variant => variant.id === state.variantId);
  const remaining = () => {
    const variant = selected();
    if (!variant) return 0;
    const inCart = state.cart.filter(item => item.productId === product.id && item.variantId === variant.id)
      .reduce((sum, item) => sum + item.quantity, 0);
    return Math.max(0, Math.min(variant.stock ?? 50, 50) - inCart);
  };
  function syncVariant() {
    for (const [index, chip] of [...variants.children].entries()) {
      chip.setAttribute("aria-pressed", String(product.variants[index].id === state.variantId));
    }
    quantityArea.replaceChildren(
      node("div", {class: "row between wrap"},
        node("div", {class: "stack compact"},
          node("strong", {class: "price"}, selected() ? price(selected().price * state.productQuantity) : "ناموجود"),
          node("small", {class: "muted"}, deliveryText[product.delivery]),
        ),
        remaining() > 0 && stepper(state.productQuantity, value => {
          state.productQuantity = value;
          syncVariant();
        }, remaining()),
      ),
      node("button", {type: "submit", class: "button primary block", disabled: remaining() < 1}, "افزودن به " + settings.labels.cart),
    );
  }
  for (const variant of product.variants) {
    variants.append(node("button", {type: "button", class: "chip", disabled: variant.stock === 0, onclick: () => {
      state.variantId = variant.id;
      state.productQuantity = 1;
      syncVariant();
    }}, variant.name, variant.stock === 0 ? " · ناموجود" : ""));
  }
  quantityArea = node("div", {class: "stack"});
  form.append(node("h2", {}, "انتخاب پلن"), variants, ...product.fields.map(customerField), quantityArea);
  syncVariant();
  content.append(form);
  renderBuyerPage(content);
}

function addToCart(product) {
  if (state.checkoutBusy) {
    notify("ثبت سفارش قبلی هنوز در حال انجام است.");
    return;
  }
  const variant = product.variants.find(entry => entry.id === state.variantId);
  if (!variant) return;
  const fields = Object.fromEntries(product.fields.map(field => [field.id, state.productFields[field.id] ?? ""]));
  const items = state.cart.slice();
  const existingIndex = items.findIndex(item => item.productId === product.id && item.variantId === variant.id &&
    JSON.stringify(item.fields) === JSON.stringify(fields));
  const sameVariant = items.filter(item => item.productId === product.id && item.variantId === variant.id)
    .reduce((sum, item) => sum + item.quantity, 0);
  if (sameVariant + state.productQuantity > Math.min(variant.stock ?? 50, 50)) {
    notify("تعداد انتخابی بیشتر از موجودی است.");
    return;
  }
  if (existingIndex >= 0) {
    const previous = items[existingIndex];
    items[existingIndex] = {...previous, quantity: previous.quantity + state.productQuantity};
  } else {
    if (items.length >= 20) {
      notify("سبد خرید حداکثر ۲۰ ردیف کالا می‌پذیرد.");
      return;
    }
    items.push({productId: product.id, variantId: variant.id, quantity: state.productQuantity, fields});
  }
  updateCart(items);
  notify("به سبد خرید اضافه شد.");
  go("cart");
}

function showCart() {
  const settings = state.catalog.settings;
  const navigateToShop = button("بازگشت به فروشگاه", () => go("shop"), "primary");
  const content = node("div", {class: "stack narrow"}, node("h1", {}, settings.labels.cart));
  if (state.cart.length === 0) {
    content.append(empty("سبد خرید خالی است", "با انتخاب یک محصول، خریدت را شروع کن.", navigateToShop));
    renderBuyerPage(content);
    return;
  }
  let total = 0;
  let unavailable = false;
  for (const [index, item] of state.cart.entries()) {
    const product = state.catalog.products.find(entry => entry.id === item.productId);
    const variant = product?.variants.find(entry => entry.id === item.variantId);
    const otherQuantity = state.cart.filter((line, position) => position !== index && line.productId === item.productId && line.variantId === item.variantId)
      .reduce((sum, line) => sum + line.quantity, 0);
    const maximum = Math.max(0, Math.min(variant?.stock ?? 50, 50) - otherQuantity);
    unavailable ||= !variant || item.quantity > maximum;
    if (variant) total += variant.price * item.quantity;
    const remove = () => { updateCart(state.cart.filter((_, position) => position !== index)); showCart(); };
    const change = quantity => {
      updateCart(state.cart.map((line, position) => position === index ? {...line, quantity} : line));
      showCart();
    };
    content.append(node("article", {class: "panel stack compact"},
      node("div", {class: "row"},
        picture(product?.image, "mini-picture"),
        node("div", {class: "grow"},
          node("h3", {}, product?.name ?? "محصول غیرفعال"),
          node("p", {class: "muted"}, variant?.name ?? "این گزینه تغییر کرده است."),
          product?.fields.map(field => item.fields?.[field.id] ?
            node("small", {class: "muted"}, field.label, " · ", item.fields[field.id], " ") : null),
        ),
        variant && node("span", {class: "price nowrap"}, price(variant.price * item.quantity)),
      ),
      node("div", {class: "row between"},
        variant && stepper(item.quantity, change, maximum, state.checkoutBusy),
        button("حذف محصول", remove, "ghost danger", {disabled: state.checkoutBusy}),
      ),
      (!variant || item.quantity > maximum) && node("small", {class: "bad"}, "تعداد محصول یا موجودی تغییر کرده است."),
    ));
  }
  const termsUrl = safeUrl(settings.termsUrl);
  const checkoutText = state.training ? settings.labels.checkout + " آزمایشی" : "پرداخت با استارز";
  const submit = button(state.checkoutBusy ? "در حال ثبت…" : checkoutText, checkout, "primary block", {
    disabled: unavailable || state.checkoutBusy || (!state.training && (!termsUrl || state.acceptedTermsUrl !== termsUrl)),
  });
  const consent = !state.training && termsUrl && node("div", {class: "stack compact"},
    href("شرایط خرید", termsUrl, "ghost"),
    node("label", {class: "row"},
      input({type: "checkbox", checked: state.acceptedTermsUrl === termsUrl, disabled: state.checkoutBusy,
        onchange: event => {
          state.acceptedTermsUrl = event.target.checked ? termsUrl : "";
          submit.disabled = unavailable || state.checkoutBusy || !state.acceptedTermsUrl;
        }}),
      "شرایط خرید را خواندم و می‌پذیرم."),
  );
  content.append(node("div", {class: "panel stack"},
    node("div", {class: "row between"}, node("strong", {}, "جمع سفارش"), node("strong", {class: "price"}, price(total))),
    state.training && node("p", {class: "muted"}, "این سفارش آزمایشی است و مبلغی پرداخت نمی‌شود."),
    consent, submit,
  ));
  renderBuyerPage(content);
}

function openInvoice(url) {
  go("orders");
  if (!telegram?.openInvoice) {
    notify("تلگرام را به‌روز کن و از سفارش‌ها پرداخت را ادامه بده.");
    return;
  }
  telegram.openInvoice(url, status => {
    if (status === "paid" || status === "pending") notify("وضعیت پرداخت از تلگرام در حال بررسی است.");
    if (status === "cancelled" || status === "failed") notify("می‌توانی پرداخت را از سفارش‌ها ادامه بدهی.");
    if (state.page === "orders") showOrders();
  });
}

async function checkout() {
  if (state.checkoutBusy || state.cart.length === 0) return;
  state.checkoutBusy = true;
  showCart();
  try {
    const {invoiceUrl} = await api("/api/orders", {
      method: "POST",
      body: {idempotencyKey: state.checkoutKey, items: state.cart, acceptedTermsUrl: state.acceptedTermsUrl},
    });
    updateCart([]);
    if (invoiceUrl) openInvoice(invoiceUrl);
    else {
      notify(state.training ? "سفارش ثبت شد." : "وضعیت سفارش را بررسی کن.");
      go("orders");
    }
    await updateCatalog();
  } catch (error) {
    notify(error.message);
  } finally {
    state.checkoutBusy = false;
    if (state.page === "cart") showCart();
  }
}

function invoiceActions(order) {
  if (!order.payable) return null;
  const change = async (action) => {
    pay.disabled = true;
    cancel.disabled = true;
    try {
      const result = await api("/api/orders/" + encodeURIComponent(order.id) + "/" + action, {method: "POST"});
      if (result.invoiceUrl) openInvoice(result.invoiceUrl);
      else {
        await updateCatalog();
        if (state.page === "orders") await showOrders();
      }
    } catch (error) {
      notify(error.message);
    } finally {
      pay.disabled = false;
      cancel.disabled = false;
    }
  };
  const pay = button("ادامهٔ پرداخت", () => change("invoice"), "primary");
  const cancel = button("لغو فاکتور", () => change("cancel"), "ghost");
  return node("div", {class: "row wrap"}, pay, cancel);
}

async function showOrders() {
  const ordersContent = node("div", {class: "stack"},
    node("p", {class: "loading", role: "status"}, "در حال دریافت سفارش‌ها…"),
  );
  const container = node("div", {class: "stack narrow"},
    node("h1", {}, state.catalog.settings.labels.orders), ordersContent,
  );
  renderBuyerPage(container);
  try {
    const {orders} = await api("/api/orders");
    if (!container.isConnected) return;
    ordersContent.replaceChildren(button("به‌روزرسانی سفارش‌ها", () => showOrders(), "ghost"));
    if (orders.length) ordersContent.append(...orders.map(order => orderCard(order, order.mode ? order.mode === "training" : state.training, invoiceActions(order))));
    else ordersContent.append(
      empty("هنوز سفارشی ثبت نشده", "سفارش‌های این فروشگاه اینجا دیده می‌شوند.", button("مشاهدهٔ محصولات", () => go("shop"), "primary")),
    );
  } catch (error) {
    if (!container.isConnected) return;
    ordersContent.replaceChildren(empty("سفارش‌ها دریافت نشد", error.message, button("تلاش دوباره", showOrders, "primary")));
  }
}

function showSetup() {
  const code = input({type: "password", autocomplete: "off", required: true, dir: "ltr", minlength: 16});
  const remote = !!telegram?.initData;
  const label = remote ? "فعال‌سازی دسترسی مدیریت" : "اتصال ربات به فروشگاه";
  const submit = node("button", {type: "submit", class: "button primary block"}, label);
  const result = node("p", {class: "muted", role: "status"});
  const form = node("form", {class: "panel stack", onsubmit: async event => {
    event.preventDefault();
    submit.disabled = true;
    result.textContent = "در حال بررسی…";
    try {
      const response = await api("/api/setup/" + (remote ? "claim" : "connect"), {method: "POST", body: {code: code.value}});
      code.value = "";
      if (remote) {
        result.textContent = "دسترسی مدیریت فعال شد.";
        state.owner = true;
        state.hasOwner = true;
        await loadStore();
        go("studio");
      } else {
        result.textContent = "ربات وصل شد. در تلگرام /start را بزنید، فروشگاه را باز کنید و روی «راه‌اندازی مدیریت» بزنید.";
        const url = safeUrl(response.botUrl) || (/^[\w]{5,32}$/.test(response.username ?? "") ? "https://t.me/" + response.username : "");
        if (url) form.append(href("باز کردن ربات در تلگرام", url, "primary"));
        submit.hidden = true;
        code.disabled = true;
      }
    } catch (error) {
      result.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  }},
  node("h1", {}, label),
  node("p", {class: "muted"}, "رمزی که در تنظیمات خصوصی Cloudflare گذاشتید را وارد کنید."),
  field("رمز راه‌اندازی", code), submit, result);
  screen.replaceChildren(node("div", {class: "narrow"}, form));
}

async function loadStore() {
  const [catalog, me] = await Promise.all([api("/api/catalog"), api("/api/me")]);
  state.catalog = catalog;
  state.owner = me.owner;
  state.hasOwner = me.hasOwner ?? me.owner;
  state.training = me.mode !== "live";
  cartKey = "rr-shop-cart-v1-" + (me.profile?.id ?? "browser");
  const savedCart = readStorage(cartKey, {items: [], checkoutKey: id()});
  state.cart = savedCart.items;
  state.checkoutKey = savedCart.checkoutKey;
}

async function start() {
  try {
    if (state.page === "setup") {
      state.owner = false;
      render();
      return;
    }
    await loadStore();
    render();
  } catch (error) {
    renderHeader();
    screen.setAttribute("aria-busy", "false");
    screen.replaceChildren(empty("فروشگاه باز نشد", error.message, button("تلاش دوباره", start, "primary")));
  }
}

telegram?.ready();
telegram?.expand();
telegram?.BackButton?.onClick(() => {
  if (state.page.startsWith("page:")) go("pages");
  else if (state.page === "detail" || state.page === "studio") go("shop");
});
start();
