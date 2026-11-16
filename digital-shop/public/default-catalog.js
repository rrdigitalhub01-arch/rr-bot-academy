export const defaultCatalog = {
  settings: {
    name: "فروشگاه آرآر",
    welcome: "به فروشگاه آرآر خوش اومدی!",
    bannerTitle: "گیفت‌های تلگرام",
    bannerText: "برای یک مناسبت خاص، یه انتخاب خاص.",
    bannerImage: "/assets/gift.webp",
    bannerProductId: "gift-box",
    logo: "",
    primary: "#f02242",
    background: "#101014",
    surface: "#19191e",
    text: "#f6f3ec",
    accent: "#d9b578",
    radius: 18,
    font: "system",
    labels: {
      shop: "فروشگاه", cart: "سبد خرید", orders: "سفارش‌ها", admin: "مدیریت",
      enter: "ورود به فروشگاه", checkout: "ثبت سفارش", support: "پشتیبانی",
    },
    supportUrl: "",
  },
  categories: [
    {id: "gift", name: "گیفت"},
    {id: "stars", name: "استارز"},
    {id: "vpn", name: "وی‌پی‌ان"},
  ],
  products: [
    {
      id: "gift-box", categoryId: "gift", name: "گیفت تلگرام", image: "/assets/gift.webp",
      description: "یک گیفت تلگرامی برای تمرین سفارش و تحویل. در اجرای آموزشی از گیفت ساختگی استفاده می‌شود.",
      active: true, delivery: "gift", link: "",
      variants: [{id: "classic", name: "گیفت کلاسیک", price: 50, stock: 10}],
      fields: [{id: "recipient", label: "نام گیرنده", type: "text", required: false, options: []}],
    },
    {
      id: "stars-guide", categoryId: "stars", name: "راهنمای استارز تلگرام", image: "/assets/stars.webp",
      description: "مسیرهای رسمی خرید و استفاده از استارز تلگرام را ببین.",
      active: true, delivery: "link", link: "https://telegram.org/tos/stars",
      variants: [], fields: [],
    },
    {
      id: "vpn-subscription", categoryId: "vpn", name: "اشتراک وی‌پی‌ان", image: "/assets/vpn.webp",
      description: "پلن سازگار با نیازت رو انتخاب کن. بعد از تحویل، لینک یا کد اشتراک داخل سفارش قابل دیدنه.",
      active: true, delivery: "code", link: "",
      variants: [
        {id: "one-month", name: "یک‌ماهه · یک دستگاه", price: 120, stock: 15},
        {id: "three-month", name: "سه‌ماهه · دو دستگاه", price: 290, stock: 8},
      ],
      fields: [],
    },
  ],
};
