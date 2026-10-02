import { render } from "preact";
import { App } from "./app.tsx";
import { loadLocale, locale } from "./i18n/index.ts";
import { init } from "./store/app.ts";
import { applyTheme, watchSystemTheme } from "./store/prefs.ts";
import "./styles/base.css";

applyTheme();
watchSystemTheme();
document.documentElement.lang = locale.value;
const root = document.getElementById("app");
// The stored language loads before the first render (English is already there).
void loadLocale(locale.value)
  .catch(() => {})
  .then(() => {
    if (root) render(<App />, root);
    void init();
  });
