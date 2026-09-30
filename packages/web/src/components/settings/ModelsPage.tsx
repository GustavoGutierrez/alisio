/**
 * Settings → Models: provider profiles, their credentials and the workspace's active provider
 * (RF-15). Credential inputs are write-only: the page sends a value once, clears the field and
 * only ever shows `configured`, the source and a masked tail. Activating a profile switches the
 * provider of this workspace's application (refused with 409 while it has runs, P-01).
 */
import type {
  CredentialStatus,
  ProviderConfigurationValue,
  ProviderModelsInfo,
  ProviderProfileInfo,
  ProvidersOverview,
  ProviderTypeInfo,
} from "@alisio/sdk";
import { Fragment } from "preact";
import { useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import { api, showToast } from "../../store/app.ts";
import { Icon } from "../icons.tsx";
import styles from "./settings.module.css";
import { errorMessage, PageIntro, Pill, Status, settingsWorkspace, useLoad } from "./shared.tsx";

const CREDENTIAL_LABEL: Record<string, string> = { apiKey: "API key", bearerToken: "Bearer token" };

function credentialText(status: CredentialStatus): string {
  if (!status.configured) return t("models.credential.missing");
  if (status.source === "env") return t("models.credential.env");
  return status.tail
    ? t("models.credential.storedTail", { tail: status.tail })
    : t("models.credential.stored");
}

function CredentialRow(props: {
  profile: string;
  field: string;
  status: CredentialStatus;
  onChange: (status: CredentialStatus) => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const label = CREDENTIAL_LABEL[props.field] ?? props.field;
  const id = `cred-${props.profile}-${props.field}`;
  const save = async () => {
    const secret = value.trim();
    if (!secret) return;
    setBusy(true);
    try {
      const status = await api.setCredentials(props.profile, { [props.field]: secret });
      props.onChange({ ...status, source: "file" });
      setValue("");
      showToast(t("models.credential.saved"));
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api.deleteCredentials(props.profile);
      props.onChange({ configured: false });
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class={styles.credential}>
      <label for={id} class={styles.settingLabel}>
        <span>{label}</span>
        <span class={styles.meta} data-configured={props.status.configured}>
          {credentialText(props.status)}
        </span>
      </label>
      <form
        class={styles.credentialForm}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <input
          id={id}
          class={styles.input}
          type="password"
          autocomplete="off"
          spellcheck={false}
          placeholder={
            props.status.configured ? t("models.credential.replace") : t("models.credential.enter")
          }
          value={value}
          disabled={busy}
          onInput={(event) => setValue((event.target as HTMLInputElement).value)}
        />
        <button type="submit" class={styles.primary} disabled={busy || !value.trim()}>
          {t("models.credential.save")}
        </button>
        {props.status.configured && props.status.source === "file" ? (
          <button
            type="button"
            class={styles.secondary}
            disabled={busy}
            onClick={() => void remove()}
          >
            {t("models.credential.remove")}
          </button>
        ) : null}
      </form>
    </div>
  );
}

function ProfileForm(props: {
  types: ProviderTypeInfo[];
  initial?: ProviderProfileInfo;
  onSaved: (profile: ProviderProfileInfo) => void;
  onCancel: () => void;
  workspace: string;
}) {
  const [name, setName] = useState(props.initial?.name ?? "");
  const [provider, setProvider] = useState(props.initial?.provider ?? props.types[0]?.id ?? "");
  const [model, setModel] = useState(props.initial?.model ?? "");
  const [values, setValues] = useState<Record<string, ProviderConfigurationValue>>(
    props.initial?.values ?? {},
  );
  const [busy, setBusy] = useState(false);
  const type = props.types.find((x) => x.id === provider);
  const fields = (type?.fields ?? []).filter((f) => f.kind !== "secret");
  const valueOf = (key: string, fallback?: ProviderConfigurationValue) => values[key] ?? fallback;
  const submit = async () => {
    setBusy(true);
    try {
      const body: Record<string, ProviderConfigurationValue> = {};
      for (const field of fields) {
        const value = valueOf(field.key, field.defaultValue);
        if (value !== undefined && value !== "") body[field.key] = value;
      }
      props.onSaved(
        await api.saveProfile(props.workspace, name.trim(), { provider, values: body, model }),
      );
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      class={styles.profileForm}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label class={styles.formRow}>
        <span>{t("models.form.name")}</span>
        <input
          class={styles.input}
          required
          pattern="[A-Za-z0-9][A-Za-z0-9._\-]{0,63}"
          disabled={!!props.initial}
          value={name}
          onInput={(event) => setName((event.target as HTMLInputElement).value)}
        />
      </label>
      <label class={styles.formRow}>
        <span>{t("models.form.type")}</span>
        <select
          class={styles.input}
          value={provider}
          onChange={(event) => setProvider((event.target as HTMLSelectElement).value)}
        >
          {props.types.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      </label>
      {fields.map((field) => (
        <label key={field.key} class={styles.formRow} title={field.description}>
          <span>{field.label}</span>
          {field.kind === "select" ? (
            <select
              class={styles.input}
              value={String(valueOf(field.key, field.defaultValue) ?? "")}
              onChange={(event) =>
                setValues({ ...values, [field.key]: (event.target as HTMLSelectElement).value })
              }
            >
              {(field.options ?? []).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : field.kind === "boolean" ? (
            <input
              type="checkbox"
              checked={valueOf(field.key, field.defaultValue) === true}
              onChange={(event) =>
                setValues({ ...values, [field.key]: (event.target as HTMLInputElement).checked })
              }
            />
          ) : (
            <input
              class={styles.input}
              type={field.kind === "url" ? "url" : "text"}
              required={field.required}
              value={String(valueOf(field.key, field.defaultValue) ?? "")}
              onInput={(event) =>
                setValues({ ...values, [field.key]: (event.target as HTMLInputElement).value })
              }
            />
          )}
        </label>
      ))}
      <label class={styles.formRow}>
        <span>{t("models.form.model")}</span>
        <input
          class={styles.input}
          required
          value={model}
          onInput={(event) => setModel((event.target as HTMLInputElement).value)}
        />
      </label>
      <p class={styles.note}>{t("models.form.secretsNote")}</p>
      <div class={styles.actions}>
        <button type="button" class={styles.secondary} onClick={props.onCancel}>
          {t("common.cancel")}
        </button>
        <button type="submit" class={styles.primary} disabled={busy}>
          {t("models.form.save")}
        </button>
      </div>
    </form>
  );
}

function ProfileCard(props: {
  profile: ProviderProfileInfo;
  overview: ProvidersOverview;
  catalog?: ProviderModelsInfo;
  workspace: string;
  onChange: (profile: ProviderProfileInfo) => void;
  onActivated: () => void;
}) {
  const { profile, overview } = props;
  const [editing, setEditing] = useState(false);
  const [model, setModel] = useState(profile.model);
  const [busy, setBusy] = useState(false);
  const type = overview.types.find((x) => x.id === profile.provider);
  const current = overview.current?.profile === profile.name;
  const activate = async () => {
    setBusy(true);
    try {
      const { changed } = await api.activateProvider(props.workspace, profile.name, model);
      showToast(changed ? t("models.activated", { name: profile.name }) : t("models.unchanged"));
      props.onActivated();
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const models = props.catalog?.models ?? [];
  return (
    <li class={styles.row} data-current={current}>
      <div class={styles.rowMain}>
        <div class={styles.rowTitle}>
          <span class={styles.cardName}>{profile.name}</span>
          <Pill tone="off">{type?.name ?? profile.provider}</Pill>
          {profile.active ? <Pill tone="ok">{t("models.activeGlobal")}</Pill> : null}
          {current ? <Pill tone="ok">{t("models.current")}</Pill> : null}
          <button
            type="button"
            class={styles.linkButton}
            aria-expanded={editing}
            onClick={() => setEditing(!editing)}
          >
            <Icon name="edit" size={14} />
            {t("models.edit")}
          </button>
        </div>
        {editing ? (
          <ProfileForm
            types={overview.types}
            initial={profile}
            workspace={props.workspace}
            onCancel={() => setEditing(false)}
            onSaved={(next) => {
              setEditing(false);
              props.onChange(next);
            }}
          />
        ) : (
          <dl class={styles.facts}>
            <dt>{t("models.form.model")}</dt>
            <dd>{profile.model}</dd>
            {Object.entries(profile.values).map(([key, value]) => (
              <Fragment key={key}>
                <dt>{type?.fields.find((f) => f.key === key)?.label ?? key}</dt>
                <dd>{String(value)}</dd>
              </Fragment>
            ))}
          </dl>
        )}
        {Object.entries(profile.credentials).map(([field, status]) => (
          <CredentialRow
            key={field}
            profile={profile.name}
            field={field}
            status={status}
            onChange={(next) =>
              props.onChange({ ...profile, credentials: { ...profile.credentials, [field]: next } })
            }
          />
        ))}
        <form
          class={styles.credentialForm}
          onSubmit={(event) => {
            event.preventDefault();
            void activate();
          }}
        >
          {models.length ? (
            <select
              class={styles.input}
              aria-label={t("models.form.model")}
              value={model}
              onChange={(event) => setModel((event.target as HTMLSelectElement).value)}
            >
              {models.some((m) => m.id === model) ? null : <option value={model}>{model}</option>}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name ?? m.id}
                </option>
              ))}
            </select>
          ) : (
            <input
              class={styles.input}
              aria-label={t("models.form.model")}
              value={model}
              onInput={(event) => setModel((event.target as HTMLInputElement).value)}
            />
          )}
          <button type="submit" class={styles.secondary} disabled={busy || !model.trim()}>
            {t("models.activate")}
          </button>
          {props.catalog?.unavailable ? (
            <span class={styles.meta}>{t("composer.modelsUnavailable")}</span>
          ) : null}
        </form>
      </div>
    </li>
  );
}

export function ModelsPage() {
  const workspace = settingsWorkspace();
  const [adding, setAdding] = useState(false);
  const overview = useLoad(
    workspace ? () => api.providers(workspace.id) : undefined,
    [workspace?.id],
    ["models"],
  );
  const catalogs = useLoad(
    workspace ? () => api.providerModels(workspace.id).catch(() => []) : undefined,
    [workspace?.id],
    ["models"],
  );
  const data = overview.data;
  const upsert = (profile: ProviderProfileInfo) => {
    if (!data) return;
    const exists = data.profiles.some((p) => p.name === profile.name);
    overview.set({
      ...data,
      profiles: exists
        ? data.profiles.map((p) => (p.name === profile.name ? profile : p))
        : [...data.profiles, profile],
    });
  };
  return (
    <>
      <PageIntro title={t("settings.models")} body={t("models.lead")} workspace={workspace?.path} />
      {data?.current ? (
        <p class={styles.banner} data-tone="ok">
          {t("models.running", {
            provider: data.current.provider,
            model: data.current.model,
            profile: data.current.profile ?? "—",
          })}
        </p>
      ) : null}
      <Status
        loading={overview.loading && !data}
        error={overview.error}
        empty={
          !workspace
            ? "settings.noWorkspace"
            : data && !data.profiles.length
              ? "models.none"
              : undefined
        }
      />
      <ul class={styles.rows}>
        {(data?.profiles ?? []).map((profile) => (
          <ProfileCard
            key={profile.name}
            profile={profile}
            overview={data as ProvidersOverview}
            catalog={catalogs.data?.find((c) => c.profile === profile.name)}
            workspace={workspace?.id ?? ""}
            onChange={upsert}
            onActivated={() => overview.reload()}
          />
        ))}
      </ul>
      {workspace && data?.types.length ? (
        adding ? (
          <ProfileForm
            types={data.types}
            workspace={workspace.id}
            onCancel={() => setAdding(false)}
            onSaved={(profile) => {
              setAdding(false);
              upsert(profile);
            }}
          />
        ) : (
          <button
            type="button"
            class={`${styles.secondary} ${styles.addButton}`}
            onClick={() => setAdding(true)}
          >
            {t("models.add")}
          </button>
        )
      ) : null}
    </>
  );
}
