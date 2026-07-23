export const THEME_SCRIPT = `
export const THEMES = Object.freeze(["control-room", "paper"]);

function preferredTheme() {
  const saved = localStorage.getItem("yui.theme");
  return THEMES.includes(saved) ? saved : "control-room";
}

export function createThemeController(select) {
  let theme = preferredTheme();

  function apply(nextTheme, persist) {
    if (!THEMES.includes(nextTheme)) return;
    theme = nextTheme;
    document.documentElement.dataset.theme = theme;
    if (select) select.value = theme;
    if (persist) localStorage.setItem("yui.theme", theme);
  }

  if (select) {
    select.addEventListener("change", function () { apply(select.value, true); });
  }
  apply(theme, false);
  return {
    getTheme: function () { return theme; },
    setTheme: function (nextTheme) { apply(nextTheme, true); }
  };
}
`;
