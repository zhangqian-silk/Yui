export const DOM_SCRIPT = `
// Tiny DOM factory shared by every client module. Kept dependency-free so it
// can be imported by components and views alike.
export function node(tagName, className, textContent) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (textContent !== undefined && textContent !== null) element.textContent = String(textContent);
  return element;
}

export function clear(element) {
  element.replaceChildren();
}
`;
