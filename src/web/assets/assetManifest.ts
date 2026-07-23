import { APP_SCRIPT } from "./client/app.js";
import { I18N_SCRIPT } from "./client/i18n.js";
import { THEME_SCRIPT } from "./client/theme.js";
import { VIEW_SCRIPT } from "./client/view.js";
import { DASHBOARD_HTML } from "./shell.js";
import {
  COMPONENT_STYLES,
  LAYOUT_STYLES,
  RESPONSIVE_STYLES,
  TOKEN_STYLES
} from "./styles.js";

export type WebAsset = Readonly<{ contentType: string; body: string }>;

export const WEB_ASSETS: Readonly<Record<string, WebAsset>> = Object.freeze({
  "/assets/css/tokens.css": { contentType: "text/css; charset=utf-8", body: TOKEN_STYLES },
  "/assets/css/layout.css": { contentType: "text/css; charset=utf-8", body: LAYOUT_STYLES },
  "/assets/css/components.css": { contentType: "text/css; charset=utf-8", body: COMPONENT_STYLES },
  "/assets/css/responsive.css": { contentType: "text/css; charset=utf-8", body: RESPONSIVE_STYLES },
  "/assets/js/i18n.js": { contentType: "text/javascript; charset=utf-8", body: I18N_SCRIPT },
  "/assets/js/theme.js": { contentType: "text/javascript; charset=utf-8", body: THEME_SCRIPT },
  "/assets/js/view.js": { contentType: "text/javascript; charset=utf-8", body: VIEW_SCRIPT },
  "/assets/app.js": { contentType: "text/javascript; charset=utf-8", body: APP_SCRIPT }
});

export { DASHBOARD_HTML };

export function findWebAsset(pathname: string): WebAsset | null {
  return WEB_ASSETS[pathname] ?? null;
}
