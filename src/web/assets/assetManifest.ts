import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { APP_SCRIPT } from "./client/app.js";
import { I18N_SCRIPT } from "./client/i18n.js";
import { THEME_SCRIPT } from "./client/theme.js";
import { VIEW_SCRIPT } from "./client/view.js";
import { DASHBOARD_HTML } from "./shell.js";
import { FONT_FACE_STYLES } from "./fonts.js";
import { FONT_WOFF2_BASE64 } from "./fontData.js";
import {
  COMPONENT_STYLES,
  LAYOUT_STYLES,
  RESPONSIVE_STYLES,
  TOKEN_STYLES
} from "./styles.js";

export type WebAsset = Readonly<{
  contentType: string;
  body: string;
  encoding?: "utf-8" | "base64";
}>;

const require = createRequire(import.meta.url);

export const WEB_ASSETS: Readonly<Record<string, WebAsset>> = Object.freeze({
  "/assets/css/tokens.css": { contentType: "text/css; charset=utf-8", body: TOKEN_STYLES },
  "/assets/css/fonts.css": { contentType: "text/css; charset=utf-8", body: FONT_FACE_STYLES },
  "/assets/css/layout.css": { contentType: "text/css; charset=utf-8", body: LAYOUT_STYLES },
  "/assets/css/components.css": { contentType: "text/css; charset=utf-8", body: COMPONENT_STYLES },
  "/assets/css/responsive.css": { contentType: "text/css; charset=utf-8", body: RESPONSIVE_STYLES },
  "/assets/js/i18n.js": { contentType: "text/javascript; charset=utf-8", body: I18N_SCRIPT },
  "/assets/js/theme.js": { contentType: "text/javascript; charset=utf-8", body: THEME_SCRIPT },
  "/assets/js/view.js": { contentType: "text/javascript; charset=utf-8", body: VIEW_SCRIPT },
  "/assets/app.js": { contentType: "text/javascript; charset=utf-8", body: APP_SCRIPT },
  ...fontAssets(),
  "/assets/vendor/xterm.mjs": vendorAsset(
    "@xterm/xterm/lib/xterm.mjs",
    "text/javascript; charset=utf-8"
  ),
  "/assets/vendor/addon-fit.mjs": vendorAsset(
    "@xterm/addon-fit/lib/addon-fit.mjs",
    "text/javascript; charset=utf-8"
  ),
  "/assets/vendor/xterm.css": vendorAsset(
    "@xterm/xterm/css/xterm.css",
    "text/css; charset=utf-8"
  )
});

export { DASHBOARD_HTML };

export function findWebAsset(pathname: string): WebAsset | null {
  return WEB_ASSETS[pathname] ?? null;
}

function vendorAsset(specifier: string, contentType: string): WebAsset {
  return {
    contentType,
    body: readFileSync(require.resolve(specifier), "utf8")
  };
}

function fontAssets(): Record<string, WebAsset> {
  const entries: Record<string, WebAsset> = {};
  for (const [key, base64] of Object.entries(FONT_WOFF2_BASE64)) {
    entries[`/assets/fonts/${key}.woff2`] = {
      contentType: "font/woff2",
      encoding: "base64",
      body: base64
    };
  }
  return entries;
}
