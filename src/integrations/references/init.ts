/**
 * Reference-provider lifecycle. Read settings → register the appropriate
 * `CitationProvider`s; re-run when settings change so toggling a
 * provider in the UI lights it up immediately.
 *
 * Mounted from the app root once via `initReferenceProviders()`. There's
 * no teardown counterpart — providers self-clean when the effect
 * unregisters their previous instance before registering the new one.
 */

import { createEffect, createMemo, createRoot, untrack } from "solid-js";

import { hasEntitlement } from "~/integrations/entitlements";
import { integrationsSettings } from "~/stores/settings-store";
import { project } from "~/stores/editor-store";
import { recordError } from "~/lib/telemetry";

import { refreshLibraryBib } from "./aggregator";
import { createBetterBibTexProvider } from "./zotero/better-bibtex";
import { createZoteroWebProvider } from "./zotero/web";
import { createMendeleyProvider } from "./mendeley";
import {
  registerCitationProvider,
  unregisterCitationProvider,
} from "./registry";

const PROVIDER_IDS = {
  betterBibTex: "zotero-better-bibtex",
  zoteroWeb: (userId: string) => `zotero-web:${userId}`,
  mendeley: (profileId: string) => `mendeley:${profileId}`,
} as const;

/**
 * The reference-relevant slice, already gated by entitlement. Only the fields
 * below decide which providers exist — everything else in the coarse
 * `integrationsSettings` signal (AI model picks, grammar toggles, recent
 * template ids) is irrelevant here.
 */
interface RefsPlan {
  betterBibTex: boolean;
  zoteroWebUserId?: string;
  mendeley?: { profileId: string; displayName: string };
}

export function initReferenceProviders(): void {
  createRoot(() => {
    const known = new Set<string>();

    // A structural-equals memo so an unrelated `integrationsSettings` write does
    // not re-instantiate providers (which would drop their 60s TTL caches and
    // re-probe Zotero/Mendeley over the network). The downstream effect fires
    // only when the reference config or its entitlement actually changes.
    const plan = createMemo(
      (): RefsPlan => {
        const refs = integrationsSettings().references;
        return {
          betterBibTex:
            refs.betterBibTex.enabled &&
            hasEntitlement("integrations.references.zotero.local"),
          zoteroWebUserId:
            refs.zoteroWeb.userId &&
            hasEntitlement("integrations.references.zotero.web")
              ? refs.zoteroWeb.userId
              : undefined,
          mendeley:
            refs.mendeley.profileId &&
            refs.mendeley.displayName &&
            hasEntitlement("integrations.references.mendeley")
              ? {
                  profileId: refs.mendeley.profileId,
                  displayName: refs.mendeley.displayName,
                }
              : undefined,
        };
      },
      undefined,
      { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
    );

    createEffect(() => {
      const p = plan();
      const desired = new Set<string>();

      if (p.betterBibTex) {
        desired.add(PROVIDER_IDS.betterBibTex);
        registerCitationProvider(createBetterBibTexProvider());
      }

      if (p.zoteroWebUserId) {
        const id = PROVIDER_IDS.zoteroWeb(p.zoteroWebUserId);
        desired.add(id);
        registerCitationProvider(createZoteroWebProvider({ userId: p.zoteroWebUserId }));
      }

      if (p.mendeley) {
        const id = PROVIDER_IDS.mendeley(p.mendeley.profileId);
        desired.add(id);
        registerCitationProvider(createMendeleyProvider(p.mendeley));
      }

      for (const prev of known) {
        if (!desired.has(prev)) unregisterCitationProvider(prev);
      }
      known.clear();
      for (const id of desired) known.add(id);
    });

    // When the provider plan changes while a project is open, rewrite
    // library.bib so stale keys (e.g. a just-disabled Zotero) stop resolving.
    // Skip the first run so opening the app doesn't force a cold network export.
    let first = true;
    createEffect(() => {
      plan();
      if (first) {
        first = false;
        return;
      }
      const proj = untrack(project);
      if (proj)
        void refreshLibraryBib(proj).catch((e) =>
          recordError("references-refresh", "post-toggle refresh failed", e),
        );
    });
  });
}
