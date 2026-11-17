import {maxImageBytes, mediaPath} from "./media.js";
import {safeUrl} from "./model.js";
import {button, field, input, node, picture} from "./ui.js";

async function resizePhoto(file, maxEdge) {
  if (file.size > 25_000_000) throw new Error("عکسی با حجم کمتر از ۲۵ مگابایت انتخاب کن.");
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    image.src = url;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw new Error();
  } catch {
    throw new Error("این عکس باز نشد. یک عکس JPG، PNG یا WebP انتخاب کن.");
  } finally {
    URL.revokeObjectURL(url);
  }
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("آماده‌سازی تصویر در این مرورگر ممکن نیست.");
  let scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
  for (let attempt = 0; attempt < 7; attempt++) {
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const type = file.type === "image/jpeg" ? "image/jpeg" : "image/webp";
    const blob = await new Promise(resolve => canvas.toBlob(resolve, type, 0.88));
    if (blob?.size > 0 && blob.size <= maxImageBytes) {
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
      const hash = Array.from(digest, value => value.toString(16).padStart(2, "0")).join("");
      const preview = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener("load", () => resolve(reader.result), {once: true});
        reader.addEventListener("error", () => reject(new Error("پیش‌نمایش عکس آماده نشد.")), {once: true});
        reader.readAsDataURL(blob);
      });
      return {path: "/api/media/" + hash, blob, preview};
    }
    scale *= 0.74;
  }
  throw new Error("حجم تصویر زیاد است. یک عکس کوچک‌تر انتخاب کن.");
}

export function photoField({title, value, change, maxEdge, kind, stage, pendingPreview, busy}) {
  let current = value;
  let request = 0;
  const status = node("small", {class: "muted", role: "status"});
  const sample = node("div", {class: "image-sample " + kind});
  const link = input({dir: "ltr", type: "url", value: /^https:\/\//i.test(value) ? value : "", maxlength: 640});
  function draw() {
    sample.hidden = !safeUrl(current, true);
    sample.replaceChildren(picture(current, "image-sample-picture", title, false, pendingPreview(current)));
    clear.hidden = !current;
  }
  const clear = button("برداشتن عکس", () => {
    request++;
    current = "";
    link.value = "";
    change(current);
    status.textContent = "";
    draw();
  }, "ghost");
  const file = input({type: "file", accept: "image/*", class: "file-input", onchange: async event => {
    const chosen = event.target.files[0];
    event.target.value = "";
    if (!chosen) return;
    const selection = ++request;
    busy(1);
    status.textContent = "در حال آماده‌سازی عکس…";
    try {
      const result = await resizePhoto(chosen, maxEdge);
      if (request !== selection || !file.isConnected) return;
      stage(result);
      current = result.path;
      link.value = "";
      change(current);
      status.textContent = "عکس آماده است. برای اعمال، ذخیرهٔ تنظیمات را بزن.";
      draw();
    } catch (error) {
      if (request === selection && file.isConnected) status.textContent = error.message;
    } finally {
      busy(-1);
    }
  }});
  link.addEventListener("input", () => {
    const url = safeUrl(link.value.trim());
    if (link.value && !url) {
      status.textContent = "برای استفاده از لینک، نشانی کامل تصویر را با https:// وارد کن.";
      return;
    }
    if (!url && (!current || mediaPath.test(current) || !/^https:\/\//i.test(current))) return;
    request++;
    current = url;
    change(current);
    status.textContent = "";
    draw();
  });
  draw();
  return node("fieldset", {class: "image-editor stack compact wide"},
    node("legend", {}, title), sample,
    node("div", {class: "row wrap"},
      node("label", {class: "button subtle file-button"}, file, "انتخاب عکس"),
      clear,
    ),
    status,
    node("details", {},
      node("summary", {}, "لینک مستقیم تصویر (اختیاری)"),
      field("نشانی تصویر", link),
    ),
  );
}
