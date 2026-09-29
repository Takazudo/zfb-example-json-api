import { defineConfig } from "@takazudo/zfb/config";

export default defineConfig({
  adapter: "@takazudo/zfb-adapter-cloudflare",
  outDir: "dist",
  publicDir: "public",
  wind: {
    spec: 1,
    reset: "owned-v1",
    // Authored classes that wind would otherwise validate as utilities:
    // `item-card__meta` (BEM `__` is ZW001 — Takazudo/zudo-front-builder#3365) and
    // `text-link` (the `text-` utility root makes it ZW006 "unknown token link").
    authoredClasses: { "item-card__meta": true, "text-link": true },
  },
});
