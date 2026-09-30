import { render } from "preact";
import { App } from "./app.tsx";
import { locale } from "./i18n/index.ts";
import { init } from "./store/app.ts";
import { applyTheme, watchSystemTheme } from "./store/prefs.ts";
import "./styles/base.css";

applyTheme();
watchSystemTheme();
document.documentElement.lang = locale.value;
const root = document.getElementById("app");
if (root) render(<App />, root);
void init();
