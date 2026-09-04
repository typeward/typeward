/// <reference types="vite/client" />

// Injected by vite.config.ts `define`: true only once an updater pubkey is set
// in tauri.conf.json. Guards the dormant auto-updater (see src/lib/updater.ts).
declare const __UPDATER_CONFIGURED__: boolean;

// Injected by vite.config.ts `define`: package.json's version.
declare const __APP_VERSION__: string;
