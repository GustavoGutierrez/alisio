---
name: alisio-website
description: "Build, check and deploy the Alisio website (landing page + EN/ES documentation, VitePress) in apps/website to Cloudflare Workers at alisioair.com. Deploys run from a maintainer's machine, not from GitHub Actions. Use whenever the user asks to publish, deploy, upload or update the website, docs site, landing page or alisioair.com (publicar/desplegar/subir el sitio, la web, la docs o la landing), or to change how the site is built or hosted."
---

# Alisio website: build and deploy

The website is the landing page and the English/Spanish documentation. It lives in `apps/website`
(workspace package `@alisio/website`), is built with VitePress and is served by Cloudflare Workers
static assets at <https://alisioair.com>. Run every command from the repository root (`<REPO>`).

## Golden rules

1. **Deploys are local.** The owner deploys from their own machine. The `Website` GitHub workflow
   only builds and checks the site; it never deploys. Do not add a deploy step to CI unless the
   owner asks for it.
2. **No account data in the repository.** Never commit the Cloudflare account ID, zone ID, API
   tokens, `.env` files or machine paths. Wrangler reads `CLOUDFLARE_ACCOUNT_ID` and, optionally,
   `CLOUDFLARE_API_TOKEN` from the environment or from the untracked `apps/website/.env`
   (template: `apps/website/.env.example`, which must stay without values). `.gitignore` covers
   `.env*`, `.wrangler/`, `.dev.vars*` and `.cloudflare/`.
3. **Never ask for or print credentials in chat.** Sign-in happens in the browser
   (`wrangler login`) or the operator writes the token into `apps/website/.env` themselves.
4. **Deploy only when asked.** A deploy publishes immediately to the public domain.

## Layout

| Path | What it is |
|---|---|
| `apps/website/*.md`, `apps/website/es/*.md` | English and Spanish pages (keep them in parity) |
| `apps/website/assets/` | Images and screenshots used by the pages |
| `apps/website/.vitepress/config.ts` | VitePress config (`base: "/"`, sitemap on alisioair.com) |
| `apps/website/.vitepress/theme/` | Custom theme, landing components and styles |
| `apps/website/wrangler.jsonc` | Cloudflare Worker `alisio-website`: static assets from `.vitepress/dist`, custom domain `alisioair.com` |
| `scripts/docs-check.ts` | Link, anchor, image and EN/ES parity checks run before every build |
| `.github/workflows/website.yml` | `Website` workflow: build and check only |

## Commands (root `package.json`)

| Command | Does |
|---|---|
| `pnpm website:dev` | Local dev server with hot reload |
| `pnpm website:check` | Links, anchors, images and EN/ES parity |
| `pnpm website:build` | `website:check` + production build into `apps/website/.vitepress/dist` |
| `pnpm website:preview` | Build, then serve it locally with the Workers runtime (`wrangler dev`) |
| `pnpm website:deploy:dry-run` | Build and validate the upload without publishing |
| `pnpm website:deploy` | Build and publish to Cloudflare (`wrangler deploy`) |

## First-time setup on a machine

```sh
cd <REPO>
pnpm install
pnpm --filter @alisio/website exec wrangler login        # browser OAuth, run by the operator
cp apps/website/.env.example apps/website/.env           # operator fills CLOUDFLARE_ACCOUNT_ID
```

`wrangler login` is interactive: ask the operator to run it themselves (in Claude Code, by typing
`! <command>`). With an API token instead of OAuth, the operator writes `CLOUDFLARE_API_TOKEN` in
`apps/website/.env`; it needs "Workers Scripts: Edit" on the account and "Workers Routes: Edit" and
"DNS: Edit" on the `alisioair.com` zone.

## Deploy flow

```sh
cd <REPO>
git status --short                     # know what is being published (local files are deployed as-is)
pnpm website:deploy:dry-run            # must end with "--dry-run: exiting now."
pnpm website:deploy                    # prints "alisioair.com (custom domain)" and a Version ID
```

Verify the live site; do not assume:

```sh
for u in / /es /installation /assets/favicon.png /no-such-page; do
  printf "%s " "$u"; curl -s -o /dev/null -w "%{http_code}\n" "https://alisioair.com$u"
done
# Expect 200 for pages and assets, 404 for the missing page. /es/ answers 307 to /es (trailing
# slashes are dropped by html_handling).
pnpm --filter @alisio/website exec wrangler deployments list
```

Deploy what is committed when possible: commit first, then deploy, so the live site matches a
known revision. Mention the Version ID in your report.

## Rollback

```sh
pnpm --filter @alisio/website exec wrangler deployments list
pnpm --filter @alisio/website exec wrangler rollback <VERSION_ID>
```

Rollback only changes the served version; it does not change the repository.

## Before changing site content

- Load `alisio-docs-screenshots` for Web UI screenshots and `alisio-coding-standards` for EN/ES
  parity rules. Spanish pages address the reader as "tú" and say "complementos", never "plugins".
- Run `pnpm website:build` and `pnpm exec vitest run tests/docs-version.test.ts tests/docs-check.test.ts`.
- Published screenshots must not show personal data or local machine paths.

## Common errors

| Error | Fix |
|---|---|
| `Not logged in` / authentication error | Operator runs `wrangler login` or sets the token in `apps/website/.env` |
| `More than one account available` | Set `CLOUDFLARE_ACCOUNT_ID` in `apps/website/.env` |
| Custom domain error about the zone | The `alisioair.com` zone must be active in the same Cloudflare account (nameservers on Cloudflare) |
| Page 404 after a rename | Internal links use site paths (`/page`, `/es/page`); run `pnpm website:check` |
| Assets 404 with a `/alisio/` prefix | `base` must stay `/` in `.vitepress/config.ts` |
