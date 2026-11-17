export const mediaPath = /^\/api\/media\/([a-f0-9]{64})$/;
export const maxImageBytes = 450_000;

export function catalogMedia(catalog) {
  const {logo, bannerImage} = catalog.settings;
  return [...new Set([logo, bannerImage, ...catalog.products.map(product => product.image)]
    .filter(path => mediaPath.test(path)))];
}
