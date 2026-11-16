import {defaults, safeUrl} from "./model.js";

const faNumber = new Intl.NumberFormat("fa-IR");
const faDate = new Intl.DateTimeFormat("fa-IR", {dateStyle: "medium", timeStyle: "short"});
const fonts = {
  system: 'system-ui, "B Nazanin", Tahoma, sans-serif',
  tahoma: 'Tahoma, system-ui, sans-serif',
  serif: '"B Nazanin", Georgia, serif',
};

export const fmt = value => faNumber.format(value);
export const price = value => fmt(value) + " استارز";
export const formatDate = value => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : faDate.format(date);
};

export function node(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (name.startsWith("on")) {
      element.addEventListener(name.slice(2), value);
    } else if (name === "value") {
      element.value = value;
    } else if (name === "checked") {
      element.checked = value;
    } else if (name === "class") {
      element.className = value;
    } else {
      element.setAttribute(name, value === true ? "" : value);
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child != null && child !== false) element.append(child);
  }
  return element;
}

export function button(label, onclick, style = "", extra = {}) {
  return node("button", {type: "button", class: "button " + style, onclick, ...extra}, label);
}

export function href(label, url, style = "") {
  return node("a", {
    href: safeUrl(url),
    target: "_blank",
    rel: "noopener noreferrer",
    class: "button " + style,
  }, label);
}

export function input(options = {}) {
  return node("input", options);
}

export function field(label, control, style = "") {
  return node("label", {class: "field " + style}, node("span", {class: "field-title"}, label), control);
}

export function select(options, value, attributes = {}) {
  const control = node("select", attributes, options.map(([key, title]) => node("option", {value: key}, title)));
  control.value = value;
  return control;
}

export function picture(image, style, alt = "", lazy = true) {
  const url = safeUrl(image, true);
  const fallback = () => node("div", {class: style + " picture-fallback", "aria-hidden": "true"}, "◇");
  if (!url) return fallback();
  const img = node("img", {class: style, src: url, alt, decoding: "async", loading: lazy ? "lazy" : "eager",
    referrerpolicy: "no-referrer"});
  img.addEventListener("error", () => img.replaceWith(fallback()), {once: true});
  return img;
}

function accentForeground(hex) {
  const channel = index => {
    const value = parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  };
  const luminance = .2126 * channel(1) + .7152 * channel(3) + .0722 * channel(5);
  return luminance > .179 ? "#000000" : "#ffffff";
}

export function setTheme(target, settings) {
  const colors = {background: "background", panel: "surface", text: "text", accent: "primary", highlight: "accent"};
  for (const [css, setting] of Object.entries(colors)) {
    const value = settings[setting];
    target.style.setProperty("--" + css, /^#[\da-f]{6}$/i.test(value) ? value : defaults.settings[setting]);
  }
  const accent = target.style.getPropertyValue("--accent");
  const background = target.style.getPropertyValue("--background");
  target.style.setProperty("--accent-text", accentForeground(accent));
  const dark = accentForeground(background) === "#ffffff";
  target.style.colorScheme = dark ? "dark" : "light";
  target.style.setProperty("--line", dark ? "#ffffff23" : "#00000025");
  target.style.setProperty("--muted", dark ? "#c7c4cc" : "#45434c");
  target.style.setProperty("--good", dark ? "#6de3a0" : "#195d3a");
  target.style.setProperty("--bad", dark ? "#ff9b9b" : "#98192a");
  target.style.setProperty("--panel-raised", "color-mix(in srgb, var(--panel) 90%, " + (dark ? "white" : "black") + ")");
  target.style.setProperty("--radius", `${Math.max(4, Math.min(Number(settings.radius) || 18, 36))}px`);
  target.style.setProperty("--font", fonts[settings.font] ?? fonts.system);
}

export function empty(title, message, action) {
  return node("div", {class: "empty panel stack"},
    node("h2", {}, title),
    node("p", {}, message),
    action && node("div", {}, action),
  );
}

export const orderStatuses = {
  pending_payment: "در انتظار پرداخت",
  placed: "ثبت شد",
  paid: "پرداخت شد",
  delivered: "تحویل شد",
  cancelled: "لغو شد",
  refunded: "بازپرداخت شد",
};

function deliveryControls(entry) {
  const feedback = node("small", {class: "muted", role: "status"});
  const copy = button("کپی", async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error();
      await navigator.clipboard.writeText(entry.value);
      feedback.textContent = "کپی شد.";
    } catch {
      feedback.textContent = "برای کپی، مقدار بالا را نگه دارید و «کپی» را بزنید.";
    }
  }, "subtle", {"aria-label": "کپی " + entry.label});
  return node("div", {class: "stack compact"},
    node("strong", {}, entry.label),
    node("code", {class: "verbatim", dir: "ltr"}, entry.value),
    node("div", {class: "row wrap"}, copy, safeUrl(entry.value) && href("باز کردن لینک", entry.value, "subtle")),
    feedback,
  );
}

export function orderCard(order, training, action) {
  const current = order.status === "pending_payment" && order.payable === false
    ? "در حال بررسی پرداخت"
    : orderStatuses[order.status] ?? order.status;
  const finished = order.status === "delivered";
  const paid = finished || order.status === "paid";
  const settled = paid || order.status === "placed";
  return node("article", {class: "panel stack"},
    node("div", {class: "row between wrap"},
      node("h3", {}, "سفارش ", node("code", {}, order.id)),
      node("small", {class: "order-state " + (finished ? "good" : "")}, current),
    ),
    node("small", {class: "muted"}, formatDate(order.createdAt)),
    (order.items ?? []).map(item => node("div", {class: "row between wrap order-line"},
      node("div", {class: "grow"},
        node("strong", {}, item.name),
        node("p", {class: "muted"}, item.variant, " · ", fmt(item.quantity), " عدد"),
        ...Object.entries(item.fields ?? {}).filter(([, value]) => value).map(([, value]) =>
          node("small", {class: "muted"}, String(value), " "))),
      node("strong", {class: "price nowrap"}, price(item.price * item.quantity)),
    )),
    node("div", {class: "order-timeline", "aria-label": "پیشرفت سفارش"},
      node("span", {class: "done"}, "ثبت سفارش"),
      node("span", {class: (training ? settled : paid) ? "done" : ""}, training ? "ثبت آزمایشی" : "پرداخت"),
      node("span", {class: finished ? "done" : ""}, "تحویل"),
    ),
    finished && order.delivery?.length && node("details", {class: "panel"},
      node("summary", {}, training ? "نمایش تحویل آزمایشی" : "نمایش اطلاعات تحویل"),
      node("div", {class: "stack compact"},
        order.delivery.map(deliveryControls)),
    ),
    action,
  );
}
