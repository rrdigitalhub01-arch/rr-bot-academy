export const shopPages = [
  ["shop", "فروشگاه"], ["detail", "جزئیات همهٔ محصولات"], ["cart", "سبد خرید"], ["orders", "سفارش‌ها"],
];
export const maxPages = 16;
export const maxPageButtons = 200;
export const maxButtonsPerPage = 8;

export function pageChoices(pages, products) {
  return [
    ...shopPages, ...pages.map(page => ["page:" + page.id, page.title || "صفحهٔ جدید"]),
    ...products.map(product => ["product:" + product.id, product.name || "محصول جدید"]),
  ];
}

export function cleanPages(input, products, safeUrl) {
  const pages = input.pages ?? [];
  const pageButtons = input.pageButtons ?? [];
  if (!Array.isArray(pages) || pages.length > maxPages || !Array.isArray(pageButtons) || pageButtons.length > maxPageButtons) {
    throw new Error("تعداد صفحه‌ها یا گزینه‌های فروشگاه بیش از حد مجاز است.");
  }
  const text = (value, max, required) => {
    if (typeof value !== "string" || value.trim().length > max || (required && !value.trim())) {
      throw new Error("عنوان و متن صفحه‌ها و گزینه‌ها را بررسی کن.");
    }
    return value.trim();
  };
  const ids = new Set();
  const normalizedPages = pages.map(page => {
    if (!page || typeof page.id !== "string" || !/^[\w-]{1,80}$/.test(page.id) || ids.has(page.id)) {
      throw new Error("شناسهٔ صفحه معتبر نیست.");
    }
    ids.add(page.id);
    return {id: page.id, title: text(page.title, 70, true), text: text(page.text, 2500)};
  });
  const choices = new Set(pageChoices(normalizedPages, products).map(([key]) => key));
  const counts = new Map();
  const buttons = pageButtons.map(button => {
    if (!button || !choices.has(button.page)) throw new Error("صفحهٔ گزینه را مشخص کن.");
    const count = (counts.get(button.page) ?? 0) + 1;
    if (count > maxButtonsPerPage) throw new Error("به هر صفحه حداکثر ۸ گزینه می‌توان اضافه کرد.");
    counts.set(button.page, count);
    const target = choices.has(button.target) && button.target !== "detail" ? button.target :
      safeUrl(text(button.target, 640, true));
    if (!target) throw new Error("مقصد هر گزینه یا لینک HTTPS آن را مشخص کن.");
    return {page: button.page, label: text(button.label, 42, true), target};
  });
  return {pages: normalizedPages, pageButtons: buttons};
}
