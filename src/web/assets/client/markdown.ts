export const MARKDOWN_SCRIPT = `
// Minimal, safe Markdown renderer.
//
// Agent-authored prose (focus, outcomes, reviews, messages) arrives as plain
// text with informal Markdown. Rendering structure (headings, lists, code)
// turns walls of text into scannable blocks.
//
// Safety rule: every byte of user text is HTML-escaped BEFORE any tag is
// introduced; the transforms below only ever add our own elements. Links are
// limited to http(s) URLs taken from already-escaped text, so no attribute
// breakout is possible.
export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Inline spans: code, bold, auto-links. Expects HTML-escaped input.
export function inlineMarkdown(escaped) {
  const codes = [];
  let out = escaped.replace(/\`([^\`\\n]+)\`/g, function (_match, code) {
    codes.push(code);
    return "\\u0000" + (codes.length - 1) + "\\u0000";
  });
  out = out.replace(/\\*\\*([^*\\n]+)\\*\\*/g, "<strong>$1</strong>");
  out = out.replace(/(https?:\\/\\/[^\\s<]+)/g, function (url) {
    return '<a href="' + url + '" target="_blank" rel="noreferrer">' + url + "</a>";
  });
  out = out.replace(/\\u0000(\\d+)\\u0000/g, function (_match, index) {
    return "<code>" + codes[Number(index)] + "</code>";
  });
  return out;
}

// Block structure: fenced code, ATX headings, unordered / ordered lists,
// paragraphs with soft line breaks.
export function renderMarkdown(text) {
  const lines = String(text).replace(/\\u0000/g, "").replace(/\\r\\n?/g, "\\n").split("\\n");
  const html = [];
  let paragraph = [];
  let list = null;
  let code = null;
  function flushParagraph() {
    if (!paragraph.length) return;
    html.push("<p>" + paragraph.map(inlineMarkdown).join("<br>") + "</p>");
    paragraph = [];
  }
  function flushList() {
    if (!list) return;
    html.push("<" + list.type + ">" + list.items.map(function (item) {
      return "<li>" + inlineMarkdown(item) + "</li>";
    }).join("") + "</" + list.type + ">");
    list = null;
  }
  lines.forEach(function (line) {
    if (code !== null) {
      if (/^\\s*\`\`\`/.test(line)) {
        html.push("<pre><code>" + code.join("\\n") + "</code></pre>");
        code = null;
      } else {
        code.push(line);
      }
      return;
    }
    if (/^\\s*\`\`\`/.test(line)) {
      flushParagraph();
      flushList();
      code = [];
      return;
    }
    const heading = line.match(/^\\s{0,3}(#{1,4})\\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(heading[1].length + 3, 6);
      html.push("<h" + level + ">" + inlineMarkdown(escapeHtml(heading[2].trim())) + "</h" + level + ">");
      return;
    }
    const unordered = line.match(/^\\s*[-*•]\\s+(.*)$/);
    if (unordered) {
      flushParagraph();
      if (!list || list.type !== "ul") {
        flushList();
        list = { type: "ul", items: [] };
      }
      list.items.push(escapeHtml(unordered[1]));
      return;
    }
    const ordered = line.match(/^\\s*\\d+[.)]\\s+(.*)$/);
    if (ordered) {
      flushParagraph();
      if (!list || list.type !== "ol") {
        flushList();
        list = { type: "ol", items: [] };
      }
      list.items.push(escapeHtml(ordered[1]));
      return;
    }
    if (/^\\s*$/.test(line)) {
      flushParagraph();
      flushList();
      return;
    }
    flushList();
    paragraph.push(escapeHtml(line));
  });
  flushParagraph();
  flushList();
  if (code !== null) html.push("<pre><code>" + code.join("\\n") + "</code></pre>");
  return html.join("");
}
`;
