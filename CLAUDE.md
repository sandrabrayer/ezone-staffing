Never merge PRs, never push to main, never dispatch deploy workflows. Open the PR and stop — Sandra merges manually.

# ezone-staffing — notes for Claude sessions

- The deployed branch is `main`. Work on your own branch and open ONE PR with base `main`.
- `npm test` (`node --test tests/*.test.js`) must be green before you push.
- Changes to `apps-script/Code.gs` go in their own commit, so the Apps Script
  deploy can be read and reverted on its own.
- Every change is recorded in `CHANGELOG.md`.
