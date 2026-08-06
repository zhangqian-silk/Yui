/*
 * DESIGN TOKEN CONTRACT
 * ---------------------
 * Layout is fully decoupled from themes. Geometry, type, metrics, and motion
 * live once in the theme-independent :root block below and are shared by every
 * theme. A [data-theme="..."] block defines ONLY color / surface / effect
 * tokens, so switching (or adding) a theme can never change layout, sizing, or
 * position. Layout / component / responsive styles reference these variables
 * only — never hardcode a color outside a theme block.
 *
 * To add a theme: copy a color block, rename the selector, retune the color
 * values, then register the name in client/theme.ts (THEMES) and add an
 * <option> in shell.ts. Do NOT put layout tokens in a theme block; if a future
 * theme genuinely needs to affect layout, revisit this contract deliberately.
 *
 * Theme-independent (:root, shared by all themes)
 *   Geometry   --radius --radius-lg --radius-pill
 *   Type       --font-mono --font-display --font-body
 *   Metrics    --page-space --sidebar-w --terminal-w
 *   Motion     --motion-fast --motion-slow --ease
 *
 * Per-theme ([data-theme="..."], color only)
 *   Surfaces   --bg --bg-1 --bg-2 --bg-3            (page → elevated layers)
 *   Lines      --border --border-strong
 *   Text       --text --muted --faint
 *   Accent     --accent --accent-2 --on-accent --accent-soft --accent-line
 *   Semantic   --active/--success/--warning/--danger (+ matching --*-soft)
 *   Effects    --glow --shadow-card --shadow-pop --ambient
 */
export const TOKEN_STYLES = `
/* Theme-independent layout tokens — shared by every theme (see contract above).
   Never move these into a [data-theme] block. */
:root{
  --radius:10px;--radius-lg:16px;--radius-pill:999px;
  --font-mono:"JetBrains Mono","SFMono-Regular",Consolas,monospace;
  --font-display:"Inter",system-ui,-apple-system,"Segoe UI",sans-serif;
  --font-body:"Inter",system-ui,-apple-system,"Segoe UI",sans-serif;
  --page-space:clamp(18px,2.6vw,40px);--sidebar-w:clamp(232px,18vw,288px);--terminal-w:clamp(420px,34vw,640px);
  --motion-fast:150ms;--motion-slow:320ms;--ease:cubic-bezier(.16,.84,.44,1);
}
:root,[data-theme="control-room"]{
  color-scheme:dark;
  --bg:#080b11;--bg-1:#0c111a;--bg-2:#111826;--bg-3:#182132;
  --border:#1e2836;--border-strong:#2f3d50;
  --text:#e8eef6;--muted:#8b99ad;--faint:#5a6779;
  --accent:#49d6ff;--accent-2:#a78bfa;--on-accent:#05121b;
  --accent-soft:rgba(73,214,255,.1);--accent-line:rgba(73,214,255,.34);
  --active:#49d6ff;--active-soft:rgba(73,214,255,.12);
  --success:#43d98d;--success-soft:rgba(67,217,141,.12);
  --warning:#ffca6b;--warning-soft:rgba(255,202,107,.12);
  --danger:#ff6b81;--danger-soft:rgba(255,107,129,.12);
  --glow:0 0 18px rgba(73,214,255,.45);
  --shadow-card:0 1px 2px rgba(0,0,0,.32),0 4px 12px rgba(0,0,0,.18);
  --shadow-pop:0 18px 48px rgba(0,0,0,.5);
  --ambient:
    radial-gradient(1000px 560px at 8% -12%,rgba(73,214,255,.12),transparent 58%),
    radial-gradient(900px 520px at 104% -6%,rgba(167,139,250,.12),transparent 55%),
    linear-gradient(rgba(255,255,255,.022) 1px,transparent 1px) 0 0/100% 44px,
    linear-gradient(90deg,rgba(255,255,255,.022) 1px,transparent 1px) 0 0/44px 100%;
}
[data-theme="atlas"]{
  color-scheme:dark;
  --bg:#051221;--bg-1:#081a2c;--bg-2:#0c2436;--bg-3:#122d44;
  --border:#153349;--border-strong:#2a4a63;
  --text:#e6f2fb;--muted:#8ba9c2;--faint:#567184;
  --accent:#38e1d4;--accent-2:#7cabf2;--on-accent:#04131d;
  --accent-soft:rgba(56,225,212,.1);--accent-line:rgba(56,225,212,.32);
  --active:#38e1d4;--active-soft:rgba(56,225,212,.12);
  --success:#49db9e;--success-soft:rgba(73,219,158,.12);
  --warning:#ffc86b;--warning-soft:rgba(255,200,107,.12);
  --danger:#ff7a8f;--danger-soft:rgba(255,122,143,.12);
  --glow:0 0 18px rgba(56,225,212,.4);
  --shadow-card:0 1px 2px rgba(0,0,0,.32),0 4px 12px rgba(0,0,0,.18);
  --shadow-pop:0 18px 48px rgba(0,0,0,.5);
  --ambient:
    radial-gradient(1000px 560px at 10% -14%,rgba(56,225,212,.11),transparent 58%),
    radial-gradient(900px 520px at 106% -6%,rgba(124,171,242,.1),transparent 55%),
    linear-gradient(rgba(230,242,251,.018) 1px,transparent 1px) 0 0/100% 44px,
    linear-gradient(90deg,rgba(230,242,251,.018) 1px,transparent 1px) 0 0/44px 100%;
}
[data-theme="paper"]{
  color-scheme:light;
  --bg:#e9eef6;--bg-1:#f2f6fc;--bg-2:#ffffff;--bg-3:#f7fafe;
  --border:#d4deec;--border-strong:#b2c0d6;
  --text:#132030;--muted:#54637a;--faint:#8493a8;
  --accent:#2563eb;--accent-2:#7c3aed;--on-accent:#ffffff;
  --accent-soft:rgba(37,99,235,.08);--accent-line:rgba(37,99,235,.3);
  --active:#2563eb;--active-soft:rgba(37,99,235,.1);
  --success:#0f9d68;--success-soft:rgba(15,157,104,.1);
  --warning:#b26a00;--warning-soft:rgba(178,106,0,.1);
  --danger:#d33a52;--danger-soft:rgba(211,58,82,.1);
  --glow:0 0 16px rgba(37,99,235,.28);
  --shadow-card:0 1px 2px rgba(24,45,78,.05),0 4px 14px rgba(24,45,78,.07);
  --shadow-pop:0 18px 44px rgba(24,45,78,.18);
  --ambient:
    radial-gradient(1000px 560px at 8% -12%,rgba(37,99,235,.09),transparent 58%),
    radial-gradient(900px 520px at 104% -6%,rgba(124,58,237,.08),transparent 55%),
    linear-gradient(rgba(24,45,78,.03) 1px,transparent 1px) 0 0/100% 44px,
    linear-gradient(90deg,rgba(24,45,78,.03) 1px,transparent 1px) 0 0/44px 100%;
}
`;
