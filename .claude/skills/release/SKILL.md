---
name: release
description: Typeward's desktop release pipeline: cutting a version with npm run release, the tag-push CI flow that publishes to the public typeward/releases repo, enforced updater and code signing plus its two dormancy switches, latest.json assembly, and the secrets runbook. Use when cutting a release, editing release.yml, or touching updater or signing config.
---

# Release & updates

Desktop ships as direct-download installers plus a Tauri auto-updater feed. **Everything here is DORMANT** until an updater keypair exists (`_plans/40-distribution-signing-updates.md` — root-credential class: lose the key and every installed app goes orphan; the user generates + custodies it). A keyless `npm run tauri build` and this whole pipeline keep working meanwhile.

**Cutting a release**
1. `npm run release -- <x.y.z>` (`scripts/bump-version.mjs`) — writes the one version into `package.json` (+ `package-lock.json` via `npm version`), `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, refreshes `Cargo.lock` (`cargo update -p typeward --offline` — cheapest correct move: only the root package version changed, no network), then commits `chore(release): vX.Y.Z` and tags `vX.Y.Z`. Refuses on a dirty tree; `--dry-run` prints the plan and writes nothing. **Does NOT push.**
2. `git push && git push origin vX.Y.Z` — the tag push triggers `.github/workflows/release.yml` (also `workflow_dispatch` with a `tag` input for re-runs).
3. The workflow builds the matrix (macOS-arm64 / Windows-x64 / Linux-x64) via `tauri-action`, runs `git-cliff` (`cliff.toml`) for the notes, and publishes a **DRAFT** GitHub Release on the PUBLIC **`typeward/releases`** repo — assets on the *private* app repo aren't anonymously downloadable, which would break both the updater and the download page.
4. A human smoke-tests one installer per OS on the draft, then hits **Publish**. Publishing materializes the tag on `typeward/releases`, so `releases/latest/download/...` (updater endpoint + stable download links) goes live with no site redeploy.

**Signing is ENFORCED (2026-07-13).** release.yml FAILS a release build whose OS-required signing inputs are missing — updater key on every leg, `APPLE_*` on macOS, `AZURE_*` **and** a `bundle.windows.signCommand` on Windows (the env passthrough alone signs nothing). Shipping the deliberately-unsigned beta needs an explicit opt-in, so unsigned can never be the accidental default: the `allow_unsigned` workflow_dispatch input, or the `ALLOW_UNSIGNED_RELEASE` repository variable (which also covers tag pushes). Either one downgrades the failure to a loud `::warning` and stamps an "Unsigned build" section into the release notes. **Every** published asset — signed or not — gets a `SHA256SUMS` file and a GitHub build-provenance attestation (`gh attestation verify`), and the notes carry the verification commands; the download/docs pages point at them.

**Dormancy — two independent switches, both off in the checked-in tree:**
- *Build-time:* `bundle.createUpdaterArtifacts` stays `false`; release.yml flips it on via a `--config` overlay ONLY when `TAURI_SIGNING_PRIVATE_KEY` is present. No key → plain installers, no `.sig`, no `latest.json`, no signing path touched (and, now, no release at all unless the unsigned escape hatch is set).
- *Runtime:* `plugins.updater.pubkey` is `""`; `vite.config.ts` reads it into the `__UPDATER_CONFIGURED__` build constant, so `src/lib/updater.ts` never even imports the plugin while dormant (auto-check no-ops; a manual check toasts "updates aren't configured yet"). Pasting the real pubkey into `tauri.conf.json` + adding the CI secrets turns both live.

**Updater UX** (`src/lib/updater.ts`, `src/components/updates/UpdateDialog.tsx`, Settings → About): a delayed (~10s post-paint) boot check runs only when `updates.checkAutomatically` (persisted setting, default on) AND configured; a found update raises a NON-modal dialog (palette-store `requestUpdateDialog` signal, same pattern as ProDialog) — version + plain-text release notes + "Install and relaunch" (`downloadAndInstall` → `tauri-plugin-process` relaunch). The check is a plain HTTPS GET to GitHub, no identifiers (stated in the toggle copy + privacy policy). The plugin JS is dynamic-imported so it stays off the 34 KB boot budget.

**`latest.json`** is hand-assembled by `scripts/build-latest-json.mjs` from the `.sig` files (more transparent than tauri-action's cross-repo generation): each signed bundle maps to its Tauri platform key with the URL pointed at the `typeward/releases` download path. No sigs → no manifest written.

**Windows: NSIS only** — `bundle.targets` is an explicit list dropping `msi` (the updater prefers NSIS in `latest.json`; MSI/WiX carries downgrade + UI-mode limits). Enterprise MSI is a later request-driven add. macOS keeps `dmg`+`app.tar.gz`; Linux keeps `deb`/`appimage`/`rpm`.

**Secrets / manual steps (runbook).** The signing secrets are REQUIRED for a release (see above) unless the unsigned escape hatch is set on purpose; the rest are optional:
- **Create the PUBLIC `typeward/releases` repo** (manual prerequisite, doesn't exist yet) + a **`RELEASES_REPO_TOKEN`** PAT with write access to it. Missing → assets upload as a workflow artifact + a loud `::error` naming the manual attach step (the build jobs still succeed).
- **`TAURI_SIGNING_PRIVATE_KEY`** / **`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`** — updater keypair (`npm run tauri signer generate`; custody per plan 40). Paste the matching pubkey into `tauri.conf.json`. **Missing → the release fails** unless `allow_unsigned` / `ALLOW_UNSIGNED_RELEASE` is set.
- macOS: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`.
- Windows (future, once `bundle.windows.signCommand` is wired): `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` (passed through env already).
