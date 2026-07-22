# Deploy — E-ZONE Staffing

Two independent deploy paths. They are **not** connected — a change can touch one,
the other, or both.

| Layer | What runs it | Trigger |
| --- | --- | --- |
| **Node/Express + frontend** (`server.js`, `public/**`) | Railway | Railway auto-deploys the connected branch (`main`, per `EZONE-ECOSYSTEM-STATUS.md`). |
| **Apps Script backend** (`apps-script/**`) | GitHub Actions → clasp | Push to `main` that touches `apps-script/**` (see below). |

> ⚠️ The Railway-connected branch is **not** stored in the repo and has been
> silently switched before across the ecosystem. This workflow triggers on
> **`main`** because that is Staffing's deployed branch per the ground-truth table
> in `EZONE-ECOSYSTEM-STATUS.md`. If Railway ever shows a different branch for
> Staffing, update the `branches:` list in the deploy workflow to match.

---

## Automatic Apps Script deployment (clasp in CI)

**Workflow:** [`.github/workflows/deploy-apps-script.yml`](.github/workflows/deploy-apps-script.yml)

### What it does

On every push to **`main`** that changes `apps-script/**` (or `.clasp.json` / the
workflow itself), CI:

1. Installs `@google/clasp` (pinned to `3.3.0`).
2. Writes `~/.clasprc.json` from the **`CLASPRC_JSON`** secret (OAuth tokens).
3. `clasp push -f` — uploads `apps-script/Code.gs` + `apps-script/appsscript.json`
   to the Apps Script project (Script ID lives in [`.clasp.json`](.clasp.json)).
4. `clasp deploy -i <DEPLOYMENT_ID>` — publishes a **new version of the existing
   deployment**. Because the deployment ID is reused, **the `/exec` URL never
   changes**, so Railway's `APPS_SCRIPT_URL` (and any sibling consumers) keep
   working.

This is the CI equivalent of the long-standing manual rule from
`EZONE-ECOSYSTEM-STATUS.md`:

> Deploy a **NEW VERSION of the EXISTING deployment** — never a new deployment
> (a new deployment changes the URL and breaks consumers).

The workflow **fails loudly and early** (before touching the live deployment) if
either secret is missing or if `CLASPRC_JSON` is not valid JSON. It also requires
clasp's `Deployed …@<version>` confirmation on the redeploy step and fails if it is
absent — so a rejected deployment ID can never pass as a green no-op.

### ⚠️ After this PR merges, CI will fail until you add two secrets

The workflow cannot authenticate to Google without them. Add both, then re-run the
failed job (or push any `apps-script/**` change / use **Run workflow**).

---

## One-time setup

### 1. `CLASPRC_JSON` — the clasp OAuth credentials

On your own machine (one time), log clasp into the Google account that **owns the
Apps Script project**:

```bash
npm install -g @google/clasp@3.3.0
clasp login
```

> **Version alignment matters.** CI installs **clasp `3.3.0`**, and clasp 3.x's
> `~/.clasprc.json` is a different (per-user-keyed) format than clasp 2.x. Log in
> with a **3.x** clasp so the credential file CI writes is one CI can read. If you
> ever see `Error retrieving access token: Cannot read properties of undefined
> (reading 'access_token')` in the deploy log, it means the secret was produced by
> a mismatched clasp major — re-login with `@google/clasp@3.3.0` and re-copy.

`clasp login` opens a browser, you approve, and it writes your OAuth tokens to
**`~/.clasprc.json`**. Copy that file's **entire contents** into the secret:

```bash
cat ~/.clasprc.json      # macOS/Linux
# then copy the whole JSON blob
```

On **Windows (PowerShell)**: `Get-Content "$HOME\.clasprc.json" -Raw | Set-Clipboard`.

> The account you `clasp login` with must have **edit** access to the Script ID in
> `.clasp.json`. If you can open the project in the Apps Script editor and deploy
> it manually, you have the right account.

### 2. `DEPLOYMENT_ID` — the existing Web App deployment

The deployment ID is the **`AKfyc…` segment of the live `/exec` URL**
(`https://script.google.com/macros/s/`**`AKfyc…`**`/exec`) — the URL Railway serves
as `APPS_SCRIPT_URL`. To find it:

- **From Railway:** project → Variables → copy the value of `APPS_SCRIPT_URL`; the
  long segment between `/macros/s/` and `/exec` is the deployment ID, **or**
- **From the Apps Script editor:** **Deploy → Manage deployments** → the active Web
  App deployment → copy its **Deployment ID** (starts with `AKfyc…`).

Reusing this ID is what keeps the URL stable. **Do not** create a new deployment.

> **Paste exactly the `AKfyc…` ID — nothing else.** If clasp reports
> `Invalid deployment ID`, the secret is wrong: it's usually the `/exec` URL, the
> Script ID, or has stray quotes/whitespace. To list the real IDs, run
> `clasp list-deployments` locally (or read the deploy job's failure output — the
> workflow prints the deployment list when the ID is rejected). Pick the AKfyc… id
> of the Web App deployment whose `@<version>` is your live one.
>
> Note: clasp 3.x can print `Invalid deployment ID` and still exit 0. The workflow
> guards against this — it requires clasp's `Deployed …@<version>` confirmation and
> fails loudly otherwise, so a rejected ID can never pass as a green (no-op) deploy.

### 3. Add both as GitHub repository secrets

**Settings → Secrets and variables → Actions → New repository secret** (or, with the
GitHub CLI, `gh secret set NAME`):

| Secret name | Value |
| --- | --- |
| `CLASPRC_JSON` | full contents of `~/.clasprc.json` |
| `DEPLOYMENT_ID` | the `AKfyc…` deployment ID |

That's it. The next push to `main` touching `apps-script/**` deploys automatically
(or trigger it now from the Actions tab → **Deploy Apps Script** → **Run workflow**).

---

## Refreshing the token (when CI auth starts failing)

clasp OAuth tokens can expire or be revoked. When the deploy job fails at the
`clasp push`/`clasp deploy` step with an auth error, refresh the secret:

```bash
clasp login          # re-authenticate in the browser
cat ~/.clasprc.json  # copy the fresh contents
```

Update the **`CLASPRC_JSON`** secret with the new contents, then re-run the failed
job. Nothing else changes — the Script ID and `DEPLOYMENT_ID` stay the same.

---

## Security notes

- Credentials live **only** in GitHub Secrets (`CLASPRC_JSON`, `DEPLOYMENT_ID`).
  They are never committed and never printed by the workflow.
- `~/.clasprc.json` and `.clasprc.json` are in [`.gitignore`](.gitignore); the
  workflow also `rm`s the runner's copy at the end of the job (`if: always()`).
- The Script ID in `.clasp.json` is **not** a secret — it is only an identifier and
  is useless without the OAuth token.
- Never paste token contents into `Code.gs`, the README, a changelog, a commit
  message, or a PR — secrets belong only in the GitHub Secrets store.

---

## The committed `appsscript.json` is the source of truth

`clasp push -f` **overwrites** the project's manifest with
[`apps-script/appsscript.json`](apps-script/appsscript.json). The committed file
therefore *is* the live Web App configuration:

```json
"webapp": { "executeAs": "USER_DEPLOYING", "access": "ANYONE_ANONYMOUS" }
```

- `executeAs: USER_DEPLOYING` = "Execute as: **Me**".
- `access: ANYONE_ANONYMOUS` = "**Anyone**" (anonymous, no Google sign-in) — this is
  required because the Express proxy calls the `/exec` URL server-to-server with no
  Google auth (it authenticates via `SHARED_SECRET`).

> **Before the first CI deploy**, confirm this matches the project's current
> settings (Apps Script editor → Deploy → Manage deployments → the Web App). If the
> live project differs, run `clasp pull` locally and commit the real manifest first
> — otherwise the first push silently rewrites the deployment's access/timezone.
> Flipping access off "Anyone" is a known way to break every consumer (they'd get
> Google's HTML sign-in page → "Non-JSON from Apps Script").

---

## Manual fallback (if CI is unavailable)

> ⛔ **Emergency use only — not the routine path.** As of the July 2026 clasp CI
> rollout (verified 22/07/2026, ecosystem-wide), Apps Script deploys are
> **automatic** on every merge to the deployed branch. Reach for this manual
> `clasp` fallback only when CI itself is down. The old **copy-paste-into-the-
> Apps-Script-editor** procedure is **OBSOLETE** — do not hand-paste `Code.gs`;
> it is the ecosystem's most error-prone operation (accidental "New deployment"
> changes the `/exec` URL and breaks every consumer). See
> `EZONE-ECOSYSTEM-STATUS.md` → "Apps Script deployment".

```bash
npm install -g @google/clasp@3.3.0
clasp login
clasp push -f
clasp deploy -i <DEPLOYMENT_ID> -d "manual deploy"   # `deploy` is a 3.x alias of `create-deployment`
```

Run from the repo root (where `.clasp.json` lives). Same effect as CI: new version
of the existing deployment, same `/exec` URL.
