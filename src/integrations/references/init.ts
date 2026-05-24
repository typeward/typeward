/**
 * Reference-provider lifecycle. Read settings → register the appropriate
 * `CitationProvider`s; re-run when settings change so toggling a
 * provider in the UI lights it up immediately.
 *
 * Mounted from the app root once via `initReferenceProviders()`. There's
 * no teardown counterpart — providers self-clean when the effect
 * unregisters their previous instance before registering the new one.
 */

import { createEffect, createRoot } from "solid-js";

import { hasEntitlement } from "~/integrations/entitlements";
import { integrationsSettings } from "~/stores/settings-store";

import { createBetterBibTexProvider } from "./zotero/better-bibtex";
import { createZoteroWebProvider } from "./zotero/web";
import { createMendeleyProvider } from "./mendeley";
import { createJabRefProvider } from "./jabref";
import {
  registerCitationProvider,
  unregisterCitationProvider,
} from "./registry";

const PROVIDER_IDS = {
  betterBibTex: "zotero-better-bibtex",
  zoteroWeb: (userId: string) => `zotero-web:${userId}`,
  mendeley: (profileId: string) => `mendeley:${profileId}`,
  jabref: (paths: string[]) => `jabref:${paths.join("|") || "empty"}`,
} as const;

export function initReferenceProviders(): void {
  createRoot(() => {
    const known = new Set<string>();

    createEffect(() => {
      const refs = integrationsSettings().references;
      const desired = new Set<string>();

      if (refs.betterBibTex.enabled) {
        desired.add(PROVIDER_IDS.betterBibTex);
        registerCitationProvider(
          createBetterBibTexProvider({ libraryId: refs.betterBibTex.libraryId }),
        );
      }

      if (
        refs.zoteroWeb.userId &&
        hasEntitlement("integrations.references.zotero.web")
      ) {
        const id = PROVIDER_IDS.zoteroWeb(refs.zoteroWeb.userId);
        desired.add(id);
        registerCitationProvider(createZoteroWebProvider({ userId: refs.zoteroWeb.userId }));
      }

      if (
        refs.mendeley.profileId &&
        refs.mendeley.displayName &&
        hasEntitlement("integrations.references.mendeley")
      ) {
        const id = PROVIDER_IDS.mendeley(refs.mendeley.profileId);
        desired.add(id);
        registerCitationProvider(
          createMendeleyProvider({
            profileId: refs.mendeley.profileId,
            displayName: refs.mendeley.displayName,
          }),
        );
      }

      if (refs.jabref.paths.length > 0) {
        const id = PROVIDER_IDS.jabref(refs.jabref.paths);
        desired.add(id);
        registerCitationProvider(createJabRefProvider({ paths: refs.jabref.paths }));
      }

      for (const prev of known) {
        if (!desired.has(prev)) unregisterCitationProvider(prev);
      }
      known.clear();
      for (const id of desired) known.add(id);
    });
  });
}
