import { useEffect, useRef, useState } from "preact/hooks";
import { locale, t } from "../../i18n/index.ts";
import { api, mobileSidebar } from "../../store/app.ts";
import { narrowScreen } from "../../store/layout.ts";
import { activeAppKey, appCatalog, appInstances, closeApp } from "../../store/plugin-apps.ts";
import { type AppInstance, appLabel } from "../../store/plugin-apps-model.ts";
import { Icon } from "../icons.tsx";
import { type AppBridge, createAppBridge, type PortLike } from "./bridge.ts";
import styles from "./plugin-apps.module.css";

/** Host chrome plus one sandboxed frame. Kept mounted (hidden) while the chat is shown. */
function AppPage({ instance }: { instance: AppInstance }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const bridge = useRef<AppBridge | undefined>(undefined);
  const visible = activeAppKey.value === instance.key;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const [gone, setGone] = useState(false);
  const loaded = appCatalog.value?.workspace === instance.workspace ? appCatalog.value : undefined;
  const info = loaded?.apps.find(
    (app) => app.plugin === instance.plugin && app.id === instance.app,
  );
  // The catalog (refreshed every 15 s) no longer lists the app: its plugin was disabled or removed.
  const unavailable = gone || (!!loaded && !info);
  const label = info ? appLabel(info, locale.value) : instance.app;

  useEffect(() => {
    if (info) setGone(false);
  }, [info]);
  useEffect(() => {
    bridge.current?.setLocale(locale.value);
  }, [locale.value]);
  useEffect(() => {
    bridge.current?.setVisible(visible);
  }, [visible]);
  useEffect(() => () => bridge.current?.close(), []);

  const connect = () => {
    const target = frame.current?.contentWindow;
    if (!target) return;
    bridge.current?.close();
    const channel = new MessageChannel();
    bridge.current = createAppBridge({
      port: channel.port1 as unknown as PortLike,
      onNotFound: () => setGone(true),
      run: (action, input, options) =>
        api.runPluginAppAction(
          instance.sessionId,
          instance.plugin,
          instance.app,
          action,
          input,
          options,
        ),
    });
    // The sandboxed frame has an opaque origin, so the target origin can only be "*".
    target.postMessage(
      { type: "alisio.app.connect", locale: locale.value, visible: visibleRef.current },
      "*",
      [channel.port2],
    );
  };

  return (
    <section
      class={styles.page}
      hidden={!visible}
      inert={!visible}
      aria-label={label}
      data-plugin-app={instance.key}
    >
      <div class={styles.bar}>
        {narrowScreen.value ? (
          <button
            type="button"
            class={styles.barButton}
            onClick={() => {
              mobileSidebar.value = true;
            }}
          >
            <Icon name="menu" size={16} />
            {t("sidebar.workspaces")}
          </button>
        ) : null}
        <button type="button" class={styles.barButton} onClick={closeApp}>
          {t("apps.back")}
        </button>
        <span class={styles.title}>{label}</span>
      </div>
      {unavailable ? (
        <p class={styles.unavailable} role="alert">
          {t("apps.unavailable")}
        </p>
      ) : (
        <iframe
          ref={frame}
          class={styles.frame}
          title={label}
          sandbox="allow-scripts allow-downloads allow-modals allow-popups"
          src={api.pluginAppFrameUrl(instance.sessionId, instance.plugin, instance.app)}
          onLoad={connect}
        />
      )}
    </section>
  );
}

export function PluginAppOutlet() {
  return (
    <>
      {appInstances.value.map((instance) => (
        <AppPage key={instance.key} instance={instance} />
      ))}
    </>
  );
}
