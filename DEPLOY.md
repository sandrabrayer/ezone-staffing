# Deploying the Apps Script backend

The E-Zone Staffing app has two independently deployed halves:

| Half | What | How it deploys |
|---|---|---|
| **Express proxy** (`server.js`, `public/`, `lib/`) | The web app Moran uses | Railway, auto-deploys the **`main`** branch |
| **Apps Script backend** (`apps-script/Code.gs`) | The Google Sheets data layer behind the `/exec` URL | **This workflow** — `clasp push` + redeploy on every merge to `main` that touches `apps-script/**` |

Historically the Apps Script half was **copy-pasted by hand** into the editor —
the single most error-prone step in the whole ecosystem (see
`EZONE-ECOSYSTEM-STATUS.md` → "Known pitfalls": pasting `Code.gs`, then picking
"New deployment" instead of a new **version** of the existing one, changed the
`/exec` URL and broke every consumer). This workflow removes the hand-paste and
locks in the correct "new version of the **existing** deployment" behaviour.

---

## How it works

`.github/workflows/deploy-apps-script.yml`:

1. **Triggers** on `push` to `main` when any file under `apps-script/**` (or the
   workflow itself) changed.
2. Installs [`@google/clasp`](https://github.com/google/clasp) (pinned to 2.4.2).
3. Writes `~/.clasprc.json` from the **`CLASPRC_JSON`** secret (your Google OAuth
   token) and generates `.clasp.json` from the **`SCRIPT_ID`** variable.
4. `clasp push -f` — uploads `apps-script/` to the Google Apps Script project.
5. `clasp deploy -i <DEPLOYMENT_ID>` — publishes a **new version of the existing
   deployment**. Because the deployment ID is reused, **the `/exec` URL does not
   change**, so nothing downstream (Railway `APPS_SCRIPT_URL`, sibling apps) has
   to be touched.

A concurrency group serializes runs so two merges can't race to publish
versions of the same deployment. If any of the three required values is missing
the run **fails loudly** in its first step with a message pointing here.

---

## One-time setup

You must add **three** things under
**Settings → Secrets and variables → Actions** in the GitHub repo.

> ⚠️ Until all three exist, the workflow will fail on every merge that touches
> `apps-script/**` — that failure is expected and self-explanatory, not a bug.

| Name | Kind | Purpose |
|---|---|---|
| `CLASPRC_JSON` | **Secret** | Google OAuth token clasp uses to authenticate |
| `SCRIPT_ID` | **Variable** | Identifies the Apps Script *project* to push into |
| `DEPLOYMENT_ID` | **Variable** | Identifies the *existing deployment* to re-version |

`SCRIPT_ID` and `DEPLOYMENT_ID` are identifiers (they appear in URLs), not
secrets, so they live as **repository variables**. `CLASPRC_JSON` is a live
OAuth token — it is a **secret** and must never be committed or logged.

### 1. `CLASPRC_JSON` (secret) — the login token

On your own machine (one time):

```bash
npm install -g @google/clasp@2.4.2
clasp login          # opens a browser; approve with the Google account that owns the Script
cat ~/.clasprc.json  # <-- copy the entire JSON output
```

- Copy the **entire** contents of `~/.clasprc.json`.
- Repo → **Settings → Secrets and variables → Actions → Secrets → New repository
  secret** → name `CLASPRC_JSON`, paste the JSON, save.

> Use `clasp login` (global), **not** `clasp login --creds`, so the file lands at
> `~/.clasprc.json` in the format the workflow expects.

### 2. `SCRIPT_ID` (variable) — which project

Apps Script editor → **Project Settings** (⚙️) → **IDs** → copy **Script ID**.
(It's also the long token in the editor URL:
`https://script.google.com/…/projects/`**`<SCRIPT_ID>`**`/edit`.)

Repo → **Settings → Secrets and variables → Actions → Variables → New repository
variable** → name `SCRIPT_ID`, paste, save.

### 3. `DEPLOYMENT_ID` (variable) — which deployment to re-version

In the Apps Script editor: **Deploy → Manage deployments**. Open the **existing**
web-app deployment (the one whose `/exec` URL Railway's `APPS_SCRIPT_URL` already
points at — **do not create a new one**). Its **Deployment ID** is shown there
(format `AKfycb…`); copy it.

> Cross-check: the deployment you copy must be the one serving the live `/exec`
> URL. Re-versioning any other deployment would leave the live URL stale.

Repo → **Variables → New repository variable** → name `DEPLOYMENT_ID`, paste,
save.

---

## Refreshing the token

`CLASPRC_JSON` holds an OAuth refresh token. clasp refreshes the short-lived
access token automatically on each run, so it normally keeps working for a long
time. If a run ever fails auth (e.g. the refresh token was revoked, the Google
password changed, or 2FA was reset), refresh it:

```bash
clasp login          # re-authorize in the browser
cat ~/.clasprc.json  # copy the fresh JSON
```

Then update the **`CLASPRC_JSON`** secret with the new contents. Nothing else
changes — `SCRIPT_ID` and `DEPLOYMENT_ID` stay the same.

---

## Running it manually / locally

The workflow is the source of truth, but you can push from your machine too:

```bash
npm install -g @google/clasp@2.4.2
clasp login
cp .clasp.json.example .clasp.json     # then paste your Script ID into it
clasp push -f                          # upload apps-script/ to the project
clasp deploy -i <DEPLOYMENT_ID>        # re-version the EXISTING deployment
```

`.clasp.json` and `.clasprc.json` are **git-ignored** — never commit either.
Always `clasp deploy -i <DEPLOYMENT_ID>` (re-version); never run a bare
`clasp deploy`, which mints a **new** deployment and a new `/exec` URL.

## Rollback

Re-versioning is safe: a bad deploy is reverted from the Apps Script editor —
**Deploy → Manage deployments → the deployment → Version → pick the previous
version → Deploy**. The `/exec` URL is unchanged throughout.
