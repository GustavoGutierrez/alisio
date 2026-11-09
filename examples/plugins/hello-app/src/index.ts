import { definePlugin } from "@alisio/sdk";

/**
 * A page of plain HTML. Inline scripts carry the nonce marker the host replaces per request; the
 * frame has no network access, so every call goes through the host over the transferred port.
 */
const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hello app</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0; padding: 32px; max-width: 560px; }
  h1 { margin: 0 0 8px; font-size: 24px; }
  #form { display: flex; gap: 8px; margin: 16px 0; }
  input { flex: 1; padding: 8px 10px; font: inherit; }
  button { padding: 8px 14px; font: inherit; cursor: pointer; }
  #out { min-height: 1.5em; font-size: 18px; }
  small { opacity: 0.7; }
</style>
</head>
<body>
<h1 id="title">Hello app</h1>
<p id="lead">A small app with one action, running next to the projects panel.</p>
<div id="form">
  <input id="name" autocomplete="off" aria-labelledby="title">
  <button id="go" type="button">Greet</button>
</div>
<p id="out" role="status"></p>
<small id="meta"></small>
<script nonce="__ALISIO_NONCE__">
const text = {
  en: { title: "Hello app", lead: "A small app with one action, running next to the projects panel.", go: "Greet", placeholder: "Your name", failed: "The action failed" },
  es: { title: "Aplicación de ejemplo", lead: "Una aplicación pequeña con una acción, junto al panel de proyectos.", go: "Saludar", placeholder: "Tu nombre", failed: "La acción falló" },
};
let port;
let locale = "en";
let seq = 0;
const pending = new Map();
const $ = (id) => document.getElementById(id);
function render() {
  const t = text[locale] || text.en;
  document.documentElement.lang = locale;
  $("title").textContent = t.title;
  $("lead").textContent = t.lead;
  $("go").textContent = t.go;
  $("name").placeholder = t.placeholder;
}
function call(action, input) {
  return new Promise((resolve, reject) => {
    const id = String(++seq);
    pending.set(id, { resolve, reject });
    port.postMessage({ type: "request", id, action, input });
  });
}
window.addEventListener("message", (event) => {
  // Accept only the first channel, and only from the host window.
  if (port || event.source !== window.parent || event.data?.type !== "alisio.app.connect") return;
  port = event.ports[0];
  locale = event.data.locale === "es" ? "es" : "en";
  render();
  port.onmessage = ({ data }) => {
    if (data.type === "locale") { locale = data.locale === "es" ? "es" : "en"; render(); }
    else if (data.type === "response") {
      const waiting = pending.get(data.id);
      pending.delete(data.id);
      if (!waiting) return;
      if ("error" in data) waiting.reject(new Error(data.error));
      else waiting.resolve(data.result);
    }
  };
});
// No <form>: the frame sandbox does not allow form submission.
async function greet() {
  if (!port) return;
  try {
    const result = await call("greet", { name: $("name").value });
    $("out").textContent = (locale === "es" ? "¡Hola, " : "Hello, ") + result.name + "!";
    $("meta").textContent = new Date(result.at).toLocaleTimeString();
  } catch (error) {
    $("out").textContent = (text[locale] || text.en).failed + " (" + error.message + ")";
  }
}
$("go").addEventListener("click", greet);
$("name").addEventListener("keydown", (event) => { if (event.key === "Enter") greet(); });
render();
</script>
</body>
</html>`;

export default definePlugin({
  id: "example.hello-app",
  version: "0.1.0",
  apiVersion: 1,
  name: "Hello app",
  description: "A small full-page app with one action.",
  setup(api) {
    // `api.apps` is absent on hosts that predate plugin apps: say so instead of failing silently.
    if (!api.apps) throw new Error("hello-app needs an Alisio host with plugin apps support");
    api.apps.register({
      id: "hello",
      label: { en: "Hello app", es: "Aplicación de ejemplo" },
      html: () => HTML,
      actions: {
        greet: {
          effect: "read",
          inputSchema: {
            type: "object",
            properties: { name: { type: "string", maxLength: 80 } },
            additionalProperties: false,
          },
          handler(input) {
            const name = String((input as { name?: string }).name ?? "").trim() || "world";
            return { name, at: Date.now() };
          },
        },
      },
    });
  },
});
