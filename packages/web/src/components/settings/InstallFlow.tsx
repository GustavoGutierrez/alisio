import { useState } from "preact/hooks";
import { showToast } from "../../store/app.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import type { InstallTarget } from "./catalog-model.ts";
import { cs } from "./catalog-strings.ts";
import {
  announceInstall,
  failureText,
  installPackage,
  sessionPrefs,
  working,
} from "./plugin-ops.ts";
import styles from "./settings.module.css";

const TITLE = {
  install: "install.title",
  update: "install.updateTitle",
  reinstall: "install.reinstallTitle",
  downgrade: "install.downgradeTitle",
} as const;

/**
 * Click-to-install with the security confirm: `ask(target)` shows the warning (unless the user
 * chose "don't ask again" this session; a downgrade always asks), then installs, toasts and calls
 * `onChanged`. Returns the dialog to render.
 */
export function useInstallFlow(onChanged: () => void) {
  const [pending, setPending] = useState<InstallTarget | undefined>();
  const [skip, setSkip] = useState(false);

  const run = async (target: InstallTarget) => {
    working.value = target.package;
    try {
      announceInstall(target.name, await installPackage(target.package, target.version));
      onChanged();
    } catch (error) {
      showToast(failureText("install.failed", target.name, error));
    } finally {
      working.value = undefined;
    }
  };

  const ask = (target: InstallTarget) => {
    if (working.value !== undefined) return;
    if (target.mode !== "downgrade" && sessionPrefs.skipInstallWarning) void run(target);
    else {
      setSkip(false);
      setPending(target);
    }
  };

  const dialog = pending ? (
    <ConfirmDialog
      title={cs(TITLE[pending.mode], { name: pending.name })}
      confirmLabel={cs("install.confirm")}
      cancelLabel={cs("install.cancel")}
      checkbox={
        pending.mode === "downgrade"
          ? undefined
          : { label: cs("install.skip"), checked: skip, onChange: setSkip }
      }
      onCancel={() => setPending(undefined)}
      onConfirm={() => {
        const target = pending;
        if (skip) sessionPrefs.skipInstallWarning = true;
        setPending(undefined);
        void run(target);
      }}
    >
      <p>{cs("install.warning")}</p>
      <p>
        <code>{cs("install.package", { package: pending.package, version: pending.version })}</code>
      </p>
      {pending.installedVersion && pending.mode !== "install" ? (
        <p>{cs("install.replaces", { from: pending.installedVersion, to: pending.version })}</p>
      ) : null}
      {pending.mode === "downgrade" && pending.installedVersion ? (
        <p class={styles.diagnostic}>
          {cs("install.downgradeWarning", { from: pending.installedVersion, to: pending.version })}
        </p>
      ) : null}
    </ConfirmDialog>
  ) : null;

  return { ask, dialog };
}
