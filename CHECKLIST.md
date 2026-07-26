# Release verification checklist

Manual per-platform checks before publishing a release. Automated gates (`tsc`,
`clippy -D warnings`, `vitest`, `cargo test`, `check:bundle`, `cargo audit`,
`npm audit`) run in CI — this file covers what only a human on real hardware can
confirm. Items tagged **[audit]** verify a fix from this remediation pass.

## All platforms (per OS: Windows, macOS, Linux X11, Linux Wayland, + a tablet if targeted)

- [ ] App launches; no white/flash before first paint; boot splash matches the persisted theme.
- [ ] **[audit TW-S3-02]** With OS "reduce motion" on, the boot spinner does not spin.
- [ ] Open a project, edit, compile (each engine: system-TeX, Tectonic sidecar), PDF renders.
- [ ] SyncTeX forward (Mod+J) and inverse (double-click PDF) still resolve.
- [ ] **[audit TW-S2-03]** A `.md` file with a local `![](./fig.png)` shows the image in
      preview; a LaTeX `\includegraphics` figure renders in the visual editor. *(Currently
      expected BROKEN until the asset-protocol fix lands — this is the check that proves it.)*
- [ ] **[audit TW-S1-02]** Force-quit mid-edit, reopen → RecoveryDialog → "Restore"; the
      editor shows the RECOVERED text (not the pre-crash on-disk text), tab is dirty.
- [ ] **[audit TW-S2-10]** Open the AI pane, switch projects via the switcher (pane stays
      open) → project B's saved conversations load (list is not empty/stale).
- [ ] **[audit TW-S3-11]** File tree → right-click → Copy path puts the path on the clipboard
      (esp. Linux/WebKitGTK).
- [ ] **[audit TW-S3-29]** Trigger one export; only that row shows the spinner, not all five.
- [ ] Grammar (Harper), references, cloud sync, git, AI streaming each smoke-tested if enabled.
- [ ] **[audit TW-S2-05]** With "Share crash reports" ON, trigger `dev.sentryTest`; confirm in
      Sentry the event carries no absolute home paths (username scrubbed to `~`).
- [ ] Quit with unsaved changes → dirty-close confirm appears.

## Windows

- [ ] NSIS installer installs per-user and per-machine; upgrade over a prior version; uninstall
      leaves no orphaned app data unexpectedly.
- [ ] `.tex` / `.typ` / `.bib` file association opens the app with the file.
- [ ] SmartScreen behavior as expected for the signing state (signed = no warning).
- [ ] **[audit]** ARM64 dev build: Tectonic sidecar (emulated x64) runs (`--version`).
- [ ] Long paths (>260 chars) under the projects root open/compile.

## macOS

- [ ] **[audit TW-S2-02/07]** BOTH Apple Silicon AND Intel: app runs. *(Intel leg does not
      exist yet — this check gates that follow-up.)*
- [ ] DMG mounts; drag-install; Gatekeeper accepts a signed+notarized build (or right-click→Open
      for the unsigned beta).
- [ ] `app.tar.gz` updater bundle relaunches into the new version (once the updater is live).
- [ ] Cmd (not Ctrl) accelerators work; file associations; `open`-with argv handled.

## Linux

- [ ] deb, rpm, AppImage each install/run on a matching distro.
- [ ] `.desktop` entry + icon appear in the launcher; MIME associations for `.tex`/`.typ`/`.bib`.
- [ ] Runs under BOTH X11 and Wayland (window decorations, drag regions, HiDPI/fractional scaling).
- [ ] Secret Service (keyring) available — sign-ins persist; without it, credential errors are graceful.
- [ ] **[audit TW-S2-03]** WebKitGTK image loading (the figures check above is most likely to fail here).

## Updater (only once a signing keypair exists — dormant today)

- [ ] `latest.json` lists each signed platform bundle; signature verifies.
- [ ] Auto-check finds a newer version, dialog shows notes, "Install and relaunch" works.
- [ ] **[audit TW-S3-17]** Relaunch does NOT silently drop unsaved buffers (flush-on-update).
- [ ] **[audit TW-S3-18]** A prerelease tag does NOT auto-offer itself to stable-channel users.

## Data safety

- [ ] **[audit TW-S2-09]** Corrupt `settings.json` by hand → launch → app boots with defaults
      AND `settings.json.corrupt` backup exists (settings not silently destroyed).
- [ ] **[audit TW-S2-01]** Cloud sync survives a mid-sync kill: cursor/sync-state are intact
      (no wedged/permanently-erroring sync) on relaunch.
