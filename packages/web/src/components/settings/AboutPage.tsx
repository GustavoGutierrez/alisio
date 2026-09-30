import { t } from "../../i18n/index.ts";
import { Icon } from "../icons.tsx";
import styles from "./settings.module.css";
import { PageIntro } from "./shared.tsx";

const REPOSITORY = "https://github.com/GustavoGutierrez/alisio";

export function AboutPage() {
  return (
    <section class={styles.about}>
      <PageIntro title={t("settings.about")} />
      <img
        class={styles.aboutLogo}
        src="/alisio-wordmark.png"
        alt="Alisio"
        width={320}
        height={150}
      />
      <p class={styles.aboutDescription}>{t("about.description")}</p>
      <p class={styles.aboutAttribution}>Gustavo Gutiérrez · Bogotá, Colombia</p>
      <a
        class={styles.aboutLink}
        href={REPOSITORY}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t("about.repositoryLabel")}
      >
        <Icon name="github" size={19} />
        {t("about.repository")}
      </a>
    </section>
  );
}
