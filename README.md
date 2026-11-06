# SPH Web App Suite — AY 2026-27

Two single-page apps for the OHSU-PSU School of Public Health, sharing one Supabase backend.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Course scheduling app — deploy to GitHub Pages |
| `faculty.html` | Faculty directory / profile app — deploy to GitHub Pages |

Both apps read and write all data live via Supabase. There is no static data file and no build step — edit and deploy the HTML directly.

## Deployment (GitHub Pages)

1. Push `index.html` and `faculty.html` to the `main` branch of `fignewtonfood/sph-scheduling-app`
2. GitHub Pages serves from branch `main`, root `/`
3. Apps are live at:
   - `https://fignewtonfood.github.io/sph-scheduling-app/index.html`
   - `https://fignewtonfood.github.io/sph-scheduling-app/faculty.html`

**Deployment order:** run any pending SQL migrations in the Supabase SQL Editor *before* pushing HTML changes that write to new columns — an absent column fails the entire row save, not just the new field.

## Backend (Supabase)

Single Supabase Postgres project backs both apps.

- **Auth:** Magic-link sign-in (`supabase.auth.signInWithOtp`). New users are provisioned via `auth_allowlist` + a Before-User-Created hook. Users without an `app_access` row resolve to public/anonymous tier.
- **Access tiers:** public (anonymous), viewer (authenticated), PD, admin / faculty-admin — enforced via Row Level Security, gated by the `app_access` table.
- **Key tables:** `courses`, `offerings`, `instructor_meta`, `faculty`, `faculty_category`, `faculty_web_profile`, `faculty_education`, `faculty_research`, `faculty_award`, `app_access`, `app_lists`, `terms`, `auth_allowlist`, `change_log`, `faculty_change_log`
- **Key views:** `faculty_public`, `faculty_profile`, `faculty_ceph_public`, `faculty_directory` (anon-safe name lookup used by the scheduling app)
- **Audit/undo:** Both apps log changes to their respective `change_log` tables and support in-app undo and change reports.

## Admin Mode

1. Open either app and sign in via the emailed magic link
2. Admin/faculty-admin status is resolved from `app_access` (RLS: users can only read their own row)
3. Edits save directly to Supabase with optimistic UI and automatic revert on failure — no manual "save" or redeploy step

**Note:** the SMTP provider must have click-tracking disabled — link-rewriting breaks single-use magic links.

## Cross-linking

The scheduling app and faculty app cross-link to each other (e.g., an instructor name in a course offering links to their faculty profile, and vice versa).

## FTE rules

- FTE = Effective CR × 0.03
- Applies to: OHSU Primary, Staff, Other, NPS, OHSU Adjunct
- Effective CR = raw CR ÷ 2 for 2-instructor courses (2I flag)
- FTE-Exempt courses excluded from effective CR
- The schedule (`instructor_meta`) is the authoritative FTE record — the faculty spreadsheet's FTE fields are not used by the app

## SharePoint iframe

Embed via SharePoint's **Embed web part**:
```html

<iframe src="https://fignewtonfood.github.io/sph-scheduling-app/index.html" width="100%" height="800px" frameborder="0"></iframe>
```

`confirm()` dialogs are replaced with inline modal confirmations, so the apps are safe to embed in sandboxed iframes.


