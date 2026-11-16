import {cleanCatalog, defaults, id, safeUrl} from "./model.js";
import {button, empty, field, fmt, input, node, orderCard, picture, price, select, setTheme} from "./ui.js";

const tabs = [["appearance", "طراحی"], ["catalog", "محصولات"], ["orders", "سفارش‌های مدیریت"]];
const delivery = [["manual", "تحویل دستی"], ["code", "کد یا لینک یکتا"], ["gift", "ارسال گیفت"], ["link", "راهنما یا لینک رسمی"]];
const font = [["system", "فونت دستگاه"], ["tahoma", "تاهوما"], ["serif", "نازنین، در صورت نصب"]];
const labelNames = {
  shop: "تب فروشگاه", cart: "تب سبد خرید", orders: "تب سفارش‌ها", admin: "دکمهٔ مدیریت",
  enter: "دکمهٔ ورود از ربات", checkout: "دکمهٔ ثبت سفارش", support: "دکمهٔ پشتیبانی",
};
let lastTab = "appearance";

function formInput(label, value, change, attributes = {}, style = "") {
  return field(label, input({value: value ?? "", oninput: event => change(event.target.value), ...attributes}), style);
}

function textarea(label, value, change, style = "", maxlength = 800) {
  const control = node("textarea", {rows: 3, maxlength, oninput: event => change(event.target.value)});
  control.value = value ?? "";
  return field(label, control, style);
}

function check(label, initial, change) {
  return node("label", {class: "row"},
    input({type: "checkbox", checked: initial, onchange: event => change(event.target.checked)}), label);
}

function section(title, ...contents) {
  return node("section", {class: "panel stack"}, node("h3", {}, title), contents);
}

function download(catalog) {
  const bytes = new Blob([JSON.stringify(cleanCatalog(catalog), null, 2)], {type: "application/json"});
  const url = URL.createObjectURL(bytes);
  const anchor = node("a", {href: url, download: "shop.json"});
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function showStudio({screen, api, demo, training, notify, updateCatalog, rerender, go}) {
  const container = node("section", {class: "stack"},
    node("h1", {}, "مدیریت فروشگاه"),
    node("p", {class: "loading", role: "status"}, "در حال دریافت تنظیمات…"),
  );
  screen.replaceChildren(container);
  try {
    let draft = await api("/api/admin/catalog");
    if (!container.isConnected) return;
    let activeTab = lastTab;
    const edited = new Set();
    let lastCodes = null;
    const bar = node("div", {class: "chips", "aria-label": "بخش‌های مدیریت"});
    const body = node("div");
    const shell = node("div", {class: "studio"});
    const preview = node("aside", {class: "studio-preview stack", "aria-label": "پیش‌نمایش طرح"});

    function drawPreview() {
      const {settings, products} = draft;
      setTheme(preview, settings);
      const featured = products.find(product => product.id === settings.bannerProductId && product.active);
      preview.classList.toggle("is-preview", activeTab === "preview");
      preview.replaceChildren(
        node("div", {class: "row between"},
          node("h3", {}, "پیش‌نمایش"),
          node("small", {class: "muted"}, "نمای خریدار"),
        ),
        node("div", {class: "brand"},
          node("span", {class: "brand-mark"}, safeUrl(settings.logo, true) ?
            picture(settings.logo, "brand-logo", "", false) : settings.name.slice(0, 2)),
          node("strong", {class: "brand-name"}, settings.name),
        ),
        settings.welcome && node("p", {class: "muted"}, settings.welcome),
        (settings.bannerTitle || settings.bannerText || settings.bannerImage) && node("div", {class: "hero"},
          safeUrl(settings.bannerImage, true) && picture(settings.bannerImage, "hero-picture", "", false),
          node("div", {class: "hero-copy stack compact"},
            node("h2", {}, settings.bannerTitle),
            node("small", {}, settings.bannerText),
            featured && node("span", {class: "button primary"}, "مشاهدهٔ محصول"),
          ),
        ),
        node("div", {class: "chips"},
          draft.categories.slice(0, 4).map(category => node("span", {class: "chip"}, category.name)),
        ),
        node("div", {class: "cards"},
          products.filter(product => product.active).slice(0, 4).map(product => node("article", {class: "product"},
            picture(product.image, "product-picture"),
            node("div", {class: "product-copy"},
              node("strong", {class: "product-name"}, product.name),
              node("small", {class: "price"}, product.variants[0] ? price(product.variants[0].price) : "مشاهدهٔ راهنما"),
            ),
          )),
        ),
        node("div", {class: "row between wrap"},
          ...["shop", "cart", "orders"].map(key => node("small", {class: "muted"}, settings.labels[key])),
        ),
      );
    }

    async function saveDraft() {
      save.disabled = true;
      save.textContent = "در حال ذخیره…";
      try {
        draft = await api("/api/admin/catalog", {method: "PUT", body: cleanCatalog(draft)});
        await updateCatalog();
        notify("تنظیمات فروشگاه ذخیره شد.");
        rerender();
      } catch (error) {
        notify(error.message);
      } finally {
        save.disabled = false;
        save.textContent = "ذخیرهٔ تنظیمات";
      }
    }

    function drawAppearance() {
      const settings = draft.settings;
      const set = key => value => {
        settings[key] = value;
        drawPreview();
      };
      const colorFields = [
        ["primary", "دکمه‌های اصلی"], ["background", "پس‌زمینه"], ["surface", "کارت‌ها"],
        ["text", "متن"], ["accent", "قیمت و تأکید"],
      ];
      return node("div", {class: "stack"},
        section("هویت فروشگاه", node("div", {class: "form-grid"},
          formInput("نام فروشگاه", settings.name, set("name"), {maxlength: 64}, "wide"),
          textarea("پیام خوش‌آمد", settings.welcome, set("welcome"), "wide", 500),
          formInput("آدرس HTTPS لوگو", settings.logo, set("logo"), {dir: "ltr", inputmode: "url"}, "wide"),
          formInput("لینک HTTPS پشتیبانی", settings.supportUrl, set("supportUrl"), {dir: "ltr", inputmode: "url"}, "wide"),
        )),
        section("بنر", node("div", {class: "form-grid"},
          formInput("عنوان بنر", settings.bannerTitle, set("bannerTitle"), {maxlength: 80}, "wide"),
          textarea("متن بنر", settings.bannerText, set("bannerText"), "wide", 180),
          formInput("آدرس عکس بنر", settings.bannerImage, set("bannerImage"), {dir: "ltr", inputmode: "url"}, "wide"),
          field("محصول دکمهٔ بنر", select([["", "بدون دکمه"], ...draft.products.filter(product => product.active)
            .map(product => [product.id, product.name])], settings.bannerProductId ?? "", {
              onchange: event => set("bannerProductId")(event.target.value),
            }), "wide"),
        )),
        section("رنگ و فونت", node("div", {class: "form-grid"},
          colorFields.map(([key, label]) => formInput(label, settings[key], set(key), {type: "color"})),
          formInput("گردی گوشه (پیکسل)", settings.radius, value => set("radius")(Number(value)), {type: "number", min: 4, max: 36}),
          field("فونت", select(font, settings.font, {onchange: event => set("font")(event.target.value)}), "wide"),
        )),
        section("متن دکمه‌ها و منو", node("div", {class: "form-grid"},
          ...Object.entries(labelNames).map(([key, label]) => formInput(label, settings.labels[key], value => {
            settings.labels[key] = value;
            drawPreview();
          }, {maxlength: 32})),
        )),
      );
    }

    function reorderButtons(list, entry, label) {
      const index = list.indexOf(entry);
      return node("div", {class: "row"},
        [-1, 1].map(step => button(step < 0 ? "↑" : "↓", () => {
          [list[index], list[index + step]] = [list[index + step], list[index]];
          drawBody();
        }, "square ghost", {
          disabled: index + step < 0 || index + step >= list.length,
          "aria-label": (step < 0 ? "بالا بردن " : "پایین بردن ") + label,
        })),
      );
    }

    function drawCategory(category) {
      return node("div", {class: "row wrap"},
        formInput("نام دسته", category.name, value => { category.name = value; drawPreview(); }, {maxlength: 64}, "grow"),
        reorderButtons(draft.categories, category, category.name || "دسته"),
        button("حذف", () => {
          if (draft.products.some(product => product.categoryId === category.id)) {
            notify("ابتدا محصولات این دسته را به دستهٔ دیگری منتقل کنید.");
            return;
          }
          draft.categories = draft.categories.filter(entry => entry.id !== category.id);
          drawBody();
        }, "ghost danger", {"aria-label": "حذف دستهٔ " + category.name}),
      );
    }

    function drawVariant(product, variant, index) {
      return node("fieldset", {class: "panel form-grid"},
        node("legend", {}, "پلن ", fmt(index + 1)),
        formInput("نام پلن", variant.name, value => { variant.name = value; drawPreview(); }, {maxlength: 80}, "wide"),
        formInput("قیمت به استارز", variant.price, value => { variant.price = Number(value); drawPreview(); }, {type: "number", min: 1, max: 1000000}),
        formInput("موجودی (خالی یعنی نامحدود)", variant.stock, value => {
          variant.stock = value === "" ? null : Number(value);
        }, {type: "number", min: 0, max: 1000000}),
        button("حذف پلن", () => { product.variants = product.variants.filter(entry => entry.id !== variant.id); drawBody(); }, "danger ghost wide"),
      );
    }

    function drawCustomField(product, descriptor, index) {
      return node("fieldset", {class: "panel form-grid"},
        node("legend", {}, "فیلد ", fmt(index + 1)),
        formInput("عنوان فیلد", descriptor.label, value => { descriptor.label = value; }, {maxlength: 64}, "wide"),
        field("نوع ورودی", select([["text", "متن"], ["number", "عدد"], ["select", "انتخابی"]], descriptor.type, {
          onchange: event => { descriptor.type = event.target.value; drawBody(); },
        })),
        check("الزامی", descriptor.required, value => { descriptor.required = value; }),
        descriptor.type === "select" && textarea("گزینه‌ها، هر گزینه یک خط", descriptor.options.join("\n"), value => {
          descriptor.options = value.split("\n").map(option => option.trim()).filter(Boolean);
        }, "wide"),
        button("حذف فیلد", () => { product.fields = product.fields.filter(entry => entry.id !== descriptor.id); drawBody(); }, "danger ghost wide"),
      );
    }

    function drawCodes(product) {
      const variants = product.variants.map(variant => [variant.id, variant.name || "پلن جدید"]);
      const variant = select(variants, variants[0]?.[0]);
      const values = node("textarea", {rows: 3, maxlength: 30000, dir: "ltr", autocomplete: "off"});
      const message = node("p", {class: "muted", role: "status"});
      const summary = node("p", {class: "muted"});
      const updateCounts = async () => {
        try {
          lastCodes ??= await api("/api/admin/codes");
          const record = lastCodes.codes.find(record => record.productId === product.id && record.variantId === variant.value);
          summary.textContent = "آمادهٔ تحویل " + fmt(record?.available ?? 0) + " · تحویل‌شده " + fmt(record?.assigned ?? 0);
        } catch (error) {
          summary.textContent = error.message;
        }
      };
      variant.addEventListener("change", updateCounts);
      const add = button("افزودن به موجودی کد", async () => {
        const batch = values.value.split("\n").map(value => value.trim()).filter(Boolean);
        if (!variant.value || !batch.length) {
          message.textContent = "اول پلن را انتخاب کنید و حداقل یک کد وارد کنید.";
          return;
        }
        add.disabled = true;
        try {
          const result = await api("/api/admin/codes", {method: "POST", body: {productId: product.id, variantId: variant.value, values: batch}});
          values.value = "";
          message.textContent = fmt(result.added) + " کد اضافه شد.";
          lastCodes = null;
          await updateCounts();
        } catch (error) {
          message.textContent = error.message;
        } finally {
          add.disabled = false;
        }
      }, "subtle");
      const content = node("details", {class: "panel"},
        node("summary", {}, "موجودی خصوصی کد یا لینک"),
        node("div", {class: "stack compact"},
          node("small", {class: "muted"}, demo ? "برای تمرین از کدهای ساختگی استفاده کنید." : "اول پلن جدید را ذخیره کنید."),
          field("پلن", variant), summary,
          field("کد یا لینک (هر کدام در یک خط)", values),
          add, message,
        ),
      );
      content.addEventListener("toggle", () => { if (content.open) updateCounts(); });
      return content;
    }

    function drawProduct(product) {
      const summary = node("summary", {}, product.name || "محصول جدید");
      const set = key => value => {
        product[key] = value;
        if (key === "name") summary.textContent = value || "محصول جدید";
        drawPreview();
      };
      const details = node("details", {class: "panel", open: edited.has(product.id)}, summary,
        node("div", {class: "stack"},
          node("div", {class: "form-grid"},
            formInput("نام محصول", product.name, set("name"), {maxlength: 80}, "wide"),
            field("دسته", select(draft.categories.map(category => [category.id, category.name || "دستهٔ جدید"]), product.categoryId, {
              onchange: event => set("categoryId")(event.target.value),
            })),
            field("روش تحویل", select(delivery, product.delivery, {
              onchange: event => { product.delivery = event.target.value; drawBody(); },
            })),
            textarea("توضیح محصول", product.description, set("description"), "wide", 1500),
            formInput("آدرس عکس محصول", product.image, set("image"), {dir: "ltr", inputmode: "url"}, "wide"),
            check("نمایش در فروشگاه", product.active, set("active")),
          ),
          product.delivery === "link" ?
            formInput("لینک HTTPS رسمی", product.link, set("link"), {dir: "ltr", inputmode: "url"}) :
            node("div", {class: "stack"},
              ...product.variants.map((variant, index) => drawVariant(product, variant, index)),
              button("افزودن پلن", () => {
                product.variants.push({id: id(), name: "", price: 1, stock: null});
                drawBody();
              }, "subtle"),
              ...product.fields.map((descriptor, index) => drawCustomField(product, descriptor, index)),
              button("افزودن فیلد خریدار", () => {
                product.fields.push({id: id(), label: "", type: "text", options: [], required: false});
                drawBody();
              }, "subtle"),
              product.delivery === "code" && drawCodes(product),
            ),
          node("div", {class: "row between wrap"},
            reorderButtons(draft.products, product, product.name || "محصول"),
            button("حذف محصول", () => {
              if (!window.confirm("محصول از کاتالوگ حذف شود؟")) return;
              draft.products = draft.products.filter(entry => entry.id !== product.id);
              if (draft.settings.bannerProductId === product.id) draft.settings.bannerProductId = "";
              drawBody();
            }, "danger ghost"),
          ),
        ),
      );
      details.addEventListener("toggle", () => {
        if (details.open) edited.add(product.id);
        else edited.delete(product.id);
      });
      return details;
    }

    function drawCatalog() {
      return node("div", {class: "stack"},
        section("دسته‌ها", draft.categories.map(drawCategory),
          button("افزودن دسته", () => {
            draft.categories.push({id: id(), name: ""});
            drawBody();
            body.querySelectorAll(".panel input").item(draft.categories.length - 1)?.focus();
          }, "subtle")),
        section("محصولات", draft.products.map(drawProduct),
          button("افزودن محصول", () => {
            if (!draft.categories.length) { notify("اول یک دسته برای محصول بسازید."); return; }
            const product = {
              id: id(), categoryId: draft.categories[0].id, name: "", description: "", image: "",
              active: true, delivery: "manual", link: "",
              variants: [{id: id(), name: "پیش‌فرض", price: 1, stock: null}], fields: [],
            };
            draft.products.push(product);
            edited.add(product.id);
            drawBody();
            body.querySelector("details[open] input")?.focus();
          }, "primary")),
      );
    }

    function buildDelivery(order) {
      const label = input({value: training ? "کد آزمایشی" : "اطلاعات تحویل", required: true, maxlength: 120});
      const value = node("textarea", {rows: 2, maxlength: 600, dir: "auto", autocomplete: "off", required: true});
      value.value = training ? "RR-DEMO-" + order.id.slice(-6) : "";
      const submit = node("button", {type: "submit", class: "button primary"}, "تحویل " + (training ? "آزمایشی" : "سفارش"));
      const useCodes = order.items.every(item =>
        draft.products.find(product => product.id === item.productId)?.delivery === "code");
      const auto = useCodes ? button("تحویل خودکار از موجودی کد", () => send([]), "subtle") : null;
      async function send(delivery) {
        submit.disabled = true;
        if (auto) auto.disabled = true;
        try {
          await api(`/api/admin/orders/${encodeURIComponent(order.id)}/delivery`, {method: "POST", body: {delivery}});
          notify("تحویل سفارش ثبت شد.");
          if (activeTab === "orders") drawBody();
        } catch (error) {
          notify(error.message);
        } finally {
          submit.disabled = false;
          if (auto) auto.disabled = false;
        }
      }
      return node("details", {class: "panel"},
        node("summary", {}, "تحویل سفارش"),
        node("form", {class: "stack compact", onsubmit: event => {
          event.preventDefault();
          send([{label: label.value, value: value.value}]);
        }},
        auto, field("عنوان تحویل", label), field("کد، لینک یا توضیح تحویل", value), submit),
      );
    }

    async function drawOrders(ordersContainer) {
      try {
        const {orders} = await api("/api/admin/orders");
        if (!ordersContainer.isConnected) return;
        ordersContainer.replaceChildren(button("به‌روزرسانی سفارش‌ها", () => drawBody(), "ghost"));
        if (orders.length) {
          ordersContainer.append(...orders.map(order => orderCard(order, training,
            ["placed", "paid"].includes(order.status) ? buildDelivery(order) : null)));
        } else {
          ordersContainer.append(empty("سفارشی ثبت نشده", "یک سفارش از فروشگاه ثبت کنید تا اینجا نمایش داده شود."));
        }
      } catch (error) {
        if (!ordersContainer.isConnected) return;
        ordersContainer.replaceChildren(empty("سفارش‌ها دریافت نشد", error.message, button("تلاش دوباره", drawBody, "primary")));
      }
    }

    function chooseTab(key) {
      activeTab = key;
      if (key !== "preview") lastTab = key;
      drawBody();
    }

    function drawBody() {
      bar.replaceChildren(...[...tabs, ["preview", "پیش‌نمایش"]].map(([key, title]) =>
        node("button", {type: "button", class: "chip " + (key === "preview" ? "mobile-only" : ""),
          "aria-pressed": String(activeTab === key), onclick: () => chooseTab(key)}, title)));
      body.hidden = activeTab === "preview";
      if (activeTab === "appearance") body.replaceChildren(drawAppearance());
      if (activeTab === "catalog") body.replaceChildren(drawCatalog());
      if (activeTab === "orders") {
        const orders = node("div", {class: "stack"}, node("p", {class: "loading"}, "در حال دریافت سفارش‌ها…"));
        body.replaceChildren(orders);
        drawOrders(orders);
      }
      drawPreview();
    }

    const save = button("ذخیرهٔ تنظیمات", saveDraft, "primary");
    const upload = input({type: "file", accept: ".json,application/json", hidden: true, onchange: async event => {
      const file = event.target.files[0];
      if (!file) return;
      try {
        if (file.size > 1000000) throw new Error("اندازهٔ فایل تنظیمات بیشتر از یک مگابایت است.");
        draft = cleanCatalog(JSON.parse(await file.text()));
        drawBody();
        notify("تنظیمات وارد شد. برای اعمال، ذخیره را بزنید.");
      } catch (error) {
        notify(error instanceof SyntaxError ? "فایل JSON قابل خواندن نیست." : error.message);
      } finally {
        event.target.value = "";
      }
    }});
    const toolbar = node("div", {class: "row wrap"},
      save,
      button("دانلود تنظیمات", () => {
        try { download(draft); } catch (error) { notify(error.message); }
      }, "ghost"),
      button("وارد کردن تنظیمات", () => upload.click(), "ghost"),
      upload,
    );
    shell.append(body, preview);
    container.replaceChildren(
      node("div", {class: "stack compact"},
        node("h1", {}, "مدیریت فروشگاه"),
        demo && node("small", {class: "muted"}, "تغییرات آزمایشی روی همین مرورگر ذخیره می‌شوند."),
      ),
      toolbar, bar, shell,
    );
    drawBody();
  } catch (error) {
    if (!container.isConnected) return;
    container.replaceChildren(empty("پنل باز نشد", error.message, button("بازگشت به فروشگاه", () => go("shop"), "primary")));
  }
}
