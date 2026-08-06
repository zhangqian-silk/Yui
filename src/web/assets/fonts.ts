// Self-hosted font faces. Binaries live in src/web/assets/fonts and are served
// from /assets/fonts/*.woff2 (see assetManifest.ts). Inter carries body and
// display type; JetBrains Mono is reserved for IDs, paths, and code so the UI
// keeps a real typographic voice without any external CDN dependency.
export const FONT_FACE_STYLES = `
@font-face{font-family:"Inter";font-style:normal;font-weight:400;font-display:swap;src:url("/assets/fonts/inter-400.woff2") format("woff2")}
@font-face{font-family:"Inter";font-style:normal;font-weight:500;font-display:swap;src:url("/assets/fonts/inter-500.woff2") format("woff2")}
@font-face{font-family:"Inter";font-style:normal;font-weight:600;font-display:swap;src:url("/assets/fonts/inter-600.woff2") format("woff2")}
@font-face{font-family:"Inter";font-style:normal;font-weight:700;font-display:swap;src:url("/assets/fonts/inter-700.woff2") format("woff2")}
@font-face{font-family:"JetBrains Mono";font-style:normal;font-weight:400;font-display:swap;src:url("/assets/fonts/jetbrains-mono-400.woff2") format("woff2")}
@font-face{font-family:"JetBrains Mono";font-style:normal;font-weight:500;font-display:swap;src:url("/assets/fonts/jetbrains-mono-500.woff2") format("woff2")}
`;
