import assert from "node:assert/strict";
import test from "node:test";

import { COMPONENTS_SCRIPT } from "../../dist/web/assets/client/components.js";

function createDocument() {
  return {
    createElement(tagName) {
      return {
        tagName,
        className: "",
        textContent: "",
        childNodes: [],
        dataset: {},
        append(...children) {
          this.childNodes.push(...children.filter((child) => child !== null && child !== undefined));
        },
        setAttribute() {},
        addEventListener() {},
        classList: {
          add() {},
          toggle() { return false; }
        }
      };
    }
  };
}

function loadRunCard() {
  const document = createDocument();
  const source = COMPONENTS_SCRIPT
    .replace('import { node } from "/assets/js/dom.js";', "const node = nodeFactory;")
    .replace(
      'import { formatDateTime, relativeTime } from "/assets/js/format.js";',
      "const formatDateTime = formatDateTimeFactory; const relativeTime = relativeTimeFactory;"
    )
    .replace(
      'import { escapeHtml, inlineMarkdown, renderMarkdown } from "/assets/js/markdown.js";',
      "const escapeHtml = escapeHtmlFactory; const inlineMarkdown = inlineMarkdownFactory; const renderMarkdown = renderMarkdownFactory;"
    )
    .replace(/^export /gm, "");
  const build = new Function(
    "document",
    "nodeFactory",
    "formatDateTimeFactory",
    "relativeTimeFactory",
    "escapeHtmlFactory",
    "inlineMarkdownFactory",
    "renderMarkdownFactory",
    source + "\nreturn runCard;"
  );
  return build(
    document,
    (tagName, className, textContent) => {
      const element = document.createElement(tagName);
      if (className) element.className = className;
      if (textContent !== undefined && textContent !== null) element.textContent = String(textContent);
      return element;
    },
    (value) => String(value),
    () => "",
    (value) => String(value),
    (value) => String(value),
    (value) => String(value)
  );
}

function textContent(element) {
  return String(element.textContent ?? "")
    + element.childNodes.map((child) => textContent(child)).join("");
}

function runFixture(overrides = {}) {
  return {
    id: "run-1",
    roleName: "worker",
    status: "active",
    mode: "resume",
    updatedAt: "2026-08-07T00:00:00.000Z",
    ...overrides
  };
}

function translate(key) {
  return {
    "mode.resume": "Resume",
    "delivery.delivered": "Delivered",
    "delivery.pushed": "Pushed · awaiting provider acceptance",
    "delivery.pending": "Awaiting delivery"
  }[key] ?? key;
}

test("web run cards distinguish pushed transport from provider acceptance", () => {
  const runCard = loadRunCard();
  const pushed = textContent(runCard(
    runFixture({ pushedAt: "2026-08-07T00:00:01.000Z" }),
    translate,
    "en-US"
  ));
  assert.match(pushed, /Pushed · awaiting provider acceptance/);
  assert.doesNotMatch(pushed, /Awaiting delivery/);

  const delivered = textContent(runCard(
    runFixture({
      pushedAt: "2026-08-07T00:00:01.000Z",
      deliveredAt: "2026-08-07T00:00:02.000Z"
    }),
    translate,
    "en-US"
  ));
  assert.match(delivered, /Delivered/);
  assert.doesNotMatch(delivered, /Pushed · awaiting provider acceptance/);

  const queued = textContent(runCard(runFixture(), translate, "en-US"));
  assert.match(queued, /Awaiting delivery/);
});
