/**
 * Integrations settings panel.
 *
 * Phase 1 ships the References card only — Cloud / Git / AI / Grammar /
 * Templates cards land alongside their respective phases. The shape of
 * this file is set up to host them all in one panel rather than
 * sub-routing, so users can scroll one page to see what's wired up.
 */

import { describeIpcError } from "~/lib/errors";
import {
  Check,
  ExternalLink,
  RefreshCw,
  X,
} from "lucide-solid";
import type { Component, JSX } from "solid-js";
import { Show, createResource, createSignal, For } from "solid-js";

import { FeatureGate } from "~/components/entitlement/FeatureGate";
import { errorText, notifyError } from "~/components/feedback/Toaster";
import { Button } from "~/components/primitives/Button";
import { Switch } from "~/components/forms/Switch";
import { TextField } from "~/components/forms/TextField";
import { assertEntitlement, hasEntitlement } from "~/integrations/entitlements";
import type { EntitlementKey } from "~/integrations/types";
import {
  credentialExists,
  deleteCredential,
  setCredential,
} from "~/integrations/auth/credentials";
import { httpRequest } from "~/integrations/http";
import { createOllamaProvider } from "~/integrations/ai/ollama";
import {
  type AiProviderId,
  getProvider,
  hasAnyAiEntitlement,
} from "~/integrations/ai/registry";
import {
  connectMendeley,
  disconnectMendeley,
  hasMendeleyClientSecret,
  setMendeleyClientSecret,
} from "~/integrations/references/mendeley";
import { probeBetterBibTex, probeZoteroLocalApi } from "~/integrations/references/zotero";
import {
  connectGithub,
  disconnectGithub,
  hasGithubCredential,
} from "~/integrations/vcs/github";
import {
  connectDropbox,
  disconnectDropbox,
} from "~/integrations/cloud/dropbox";
import { connectWebdav, disconnectWebdav } from "~/integrations/cloud/webdav";
import { integrationsSettings, setIntegrationsSettings } from "~/stores/settings-store";
import { openUrl } from "@tauri-apps/plugin-opener";
import { notifySuccess } from "~/lib/toast";
import * as ipc from "~/ipc";

export type IntegrationsSection = "references" | "cloud" | "vcs" | "ai" | "grammar";

/**
 * Category-level entitlement checks. Every integration is Pro (repricing
 * 2026-07-08). SettingsScreen imports these to decide per category whether
 * to render the cards or the quiet locked state (nav row + Pro chip +
 * ProLockedPanel — discovery amendment 2026-07-08; the cards themselves
 * never render on a locked tier). Reactive inside tracking scopes.
 */
export const referencesEntitled = (): boolean =>
  hasEntitlement("integrations.references.zotero.local") ||
  hasEntitlement("integrations.references.zotero.web") ||
  hasEntitlement("integrations.references.mendeley");
export const cloudEntitled = (): boolean =>
  hasEntitlement("integrations.cloud.dropbox") ||
  hasEntitlement("integrations.cloud.webdav");
export const vcsEntitled = (): boolean =>
  hasEntitlement("integrations.vcs.git") || hasEntitlement("integrations.vcs.github");
export const aiEntitled = (): boolean => hasAnyAiEntitlement();
export const grammarEntitled = (): boolean =>
  hasEntitlement("integrations.grammar.harper");

/**
 * One card per integration category. The Settings nav exposes each as its
 * own subcategory under "Integrations"; without `section` (legacy/all)
 * every card stacks like the original single panel.
 */
export const IntegrationsPanel: Component<{ section?: IntegrationsSection }> = (
  props,
) => {
  return (
    <div class="flex flex-col gap-3">
      <Show when={!props.section || props.section === "references"}>
        <ReferencesCard />
      </Show>
      <Show when={!props.section || props.section === "cloud"}>
        <CloudStorageCard />
      </Show>
      <Show when={!props.section || props.section === "vcs"}>
        <VcsCard />
      </Show>
      <Show when={!props.section || props.section === "ai"}>
        <AiCard />
      </Show>
      <Show when={!props.section || props.section === "grammar"}>
        <GrammarCard />
      </Show>
    </div>
  );
};

// =================================================================
// References card
// =================================================================

const ReferencesCard: Component = () => {
  return (
    <Show when={referencesEntitled()}>
      <Card
        title="References"
        subtitle="Connect a reference manager to autocomplete \\cite{…} keys and append the aggregated library to the project's .bib."
      >
        <FeatureGate feature="integrations.references.zotero.local">
          <BetterBibTexRow />
        </FeatureGate>
        <FeatureGate feature="integrations.references.zotero.web">
          <ZoteroWebRow />
        </FeatureGate>
        <FeatureGate feature="integrations.references.mendeley">
          <MendeleyRow />
        </FeatureGate>
      </Card>
    </Show>
  );
};

const BetterBibTexRow: Component = () => {
  // "Ready" if either local path answers — Better BibTeX or plain
  // Zotero 7's built-in API. `bbt` only affects the explanatory hint now;
  // libraries are auto-discovered either way.
  const [probe, { refetch }] = createResource(async () => {
    const bbt = await probeBetterBibTex();
    if (bbt) return { reachable: true, bbt: true };
    return { reachable: await probeZoteroLocalApi(), bbt: false };
  });
  const settings = () => integrationsSettings().references.betterBibTex;

  const toggle = (enabled: boolean) => {
    setIntegrationsSettings({
      ...integrationsSettings(),
      references: {
        ...integrationsSettings().references,
        betterBibTex: { ...settings(), enabled },
      },
    });
  };

  return (
    <ProviderRow
      name="Zotero (local)"
      hint="Talks to the Zotero app on this machine — no login. Works with plain Zotero 7 (enable 'Allow other applications…' under Settings → Advanced); the Better BibTeX plugin is optional and adds nicer citation keys. Your libraries (personal + groups) are discovered automatically."
      status={
        probe() === undefined
          ? "checking"
          : probe()!.reachable
            ? "ready"
            : "unreachable"
      }
      controls={
        <div class="flex items-center gap-1.5">
          <Show when={probe() && !probe()!.reachable}>
            <Button
              variant="ghost"
              size="sm"
              class="h-8"
              onClick={() => void refetch()}
            >
              Re-check
            </Button>
          </Show>
          <Switch
            checked={settings().enabled}
            onChange={(checked) => toggle(checked)}
            disabled={!settings().enabled && !probe()?.reachable}
          />
        </div>
      }
    >
      <Show when={settings().enabled && probe()?.reachable && !probe()?.bbt}>
        <div class="mt-3 text-sm text-fg-3">
          Using Zotero's built-in API. Install Better BibTeX for stable,
          human-readable citation keys.
        </div>
      </Show>
    </ProviderRow>
  );
};

const ZoteroWebRow: Component = () => {
  const settings = () => integrationsSettings().references.zoteroWeb;
  const [userIdInput, setUserIdInput] = createSignal(settings().userId ?? "");
  const [apiKeyInput, setApiKeyInput] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const isConnected = () => Boolean(settings().userId);

  const handleConnect = async () => {
    setError(null);
    const userId = userIdInput().trim();
    const apiKey = apiKeyInput().trim();
    if (!userId || !apiKey) {
      setError("Both the user id and API key are required.");
      return;
    }

    setBusy(true);
    try {
      assertEntitlement("integrations.references.zotero.web");
      // Stash the key first so the probe call uses it via the keyring.
      await setCredential({ service: "zotero-web", account: userId }, apiKey);
      const probe = await httpRequest({
        method: "GET",
        url: `https://api.zotero.org/users/${encodeURIComponent(userId)}/items?limit=1&format=keys`,
        authRef: {
          service: "zotero-web",
          account: userId,
          header: "Authorization",
          prefix: "Bearer ",
        },
      });
      if (probe.status < 200 || probe.status >= 300) {
        await deleteCredential({ service: "zotero-web", account: userId });
        throw new Error(`Zotero rejected the credentials (status ${probe.status}).`);
      }

      setIntegrationsSettings({
        ...integrationsSettings(),
        references: {
          ...integrationsSettings().references,
          zoteroWeb: { userId },
        },
      });
      setApiKeyInput("");
    } catch (err) {
      setError(describeIpcError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    const userId = settings().userId;
    if (!userId) return;
    try {
      await deleteCredential({ service: "zotero-web", account: userId });
    } catch (e) {
      notifyError("Couldn't disconnect Zotero", errorText(e));
      return;
    }
    setIntegrationsSettings({
      ...integrationsSettings(),
      references: {
        ...integrationsSettings().references,
        zoteroWeb: {},
      },
    });
    setUserIdInput("");
  };

  return (
    <ProviderRow
      name="Zotero Web API"
      hint={
        isConnected()
          ? `Connected as user ${settings().userId}.`
          : "Create a read-only key at zotero.org/settings/keys, then paste it along with your numeric user id."
      }
      status={isConnected() ? "ready" : "unconfigured"}
      controls={
        <Show
          when={isConnected()}
          fallback={
            <a
              href="https://www.zotero.org/settings/keys"
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => {
                // wry swallows new-window requests — route to the system
                // browser via the opener plugin instead.
                e.preventDefault();
                void openUrl("https://www.zotero.org/settings/keys");
              }}
              class="lift flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-fg-2 hover:text-fg-1 hover:bg-[var(--color-control-fill)]"
            >
              Get key
              <ExternalLink class="ui-icon-sm" />
            </a>
          }
        >
          <Button variant="ghost" size="sm" class="h-8" onClick={handleDisconnect}>
            Disconnect
          </Button>
        </Show>
      }
    >
      <Show when={!isConnected()}>
        <div class="mt-3 flex flex-col gap-2">
          <div class="flex items-end gap-2">
            <div class="min-w-0 flex-1">
              <TextField
                label="User id"
                size="sm"
                type="text"
                placeholder="e.g. 1234567"
                value={userIdInput()}
                onInput={(e) => setUserIdInput(e.currentTarget.value)}
              />
            </div>
            <div class="min-w-0 flex-[2]">
              <TextField
                label="API key"
                size="sm"
                mono
                type="password"
                value={apiKeyInput()}
                onInput={(e) => setApiKeyInput(e.currentTarget.value)}
              />
            </div>
            <Button variant="primary" size="sm" class="h-8" onClick={handleConnect} disabled={busy()}>
              {busy() ? "Testing…" : "Connect"}
            </Button>
          </div>
          <Show when={error()}>
            <div class="select-text text-xs text-[var(--color-err)]">{error()}</div>
          </Show>
        </div>
      </Show>
    </ProviderRow>
  );
};

const MendeleyRow: Component = () => {
  const settings = () => integrationsSettings().references.mendeley;
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [secretInput, setSecretInput] = createSignal("");
  const [secretSaved, { refetch: refetchSecret }] = createResource(
    hasMendeleyClientSecret,
    { initialValue: false },
  );
  const [redirectInput, setRedirectInput] = createSignal(
    settings().redirectUri ?? "http://localhost:5000/callback",
  );
  const isConnected = () => Boolean(settings().profileId);

  const persistMendeley = (
    extra: { profileId?: string; displayName?: string } = {},
  ) => {
    setIntegrationsSettings({
      ...integrationsSettings(),
      references: {
        ...integrationsSettings().references,
        mendeley: { ...extra, redirectUri: redirectInput().trim() },
      },
    });
  };

  const handleSaveSecret = async () => {
    const value = secretInput().trim();
    if (!value) return;
    setError(null);
    try {
      await setMendeleyClientSecret(value);
      setSecretInput("");
      await refetchSecret();
    } catch (err) {
      setError(describeIpcError(err));
    }
  };

  const handleConnect = async () => {
    setError(null);
    setBusy(true);
    try {
      assertEntitlement("integrations.references.mendeley");
      persistMendeley(); // keep the redirect URL even if sign-in fails
      const account = await connectMendeley(redirectInput().trim());
      persistMendeley({
        profileId: account.profileId,
        displayName: account.displayName,
      });
    } catch (err) {
      setError(describeIpcError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    const profileId = settings().profileId;
    if (!profileId) return;
    try {
      await disconnectMendeley(profileId);
    } catch (e) {
      notifyError("Couldn't disconnect Mendeley", errorText(e));
      return;
    }
    persistMendeley(); // drop the account but keep the redirect URL for reconnect
  };

  return (
    <ProviderRow
      name="Mendeley"
      hint={
        isConnected()
          ? `Connected as ${settings().displayName}.`
          : "Mendeley Desktop was discontinued in 2022 and the API is in maintenance mode. Use Zotero for new workflows; this exists for migration."
      }
      status={isConnected() ? "ready" : "unconfigured"}
      controls={
        <Show
          when={isConnected()}
          fallback={
            <Button
              variant="primary"
              size="sm"
              class="h-8"
              onClick={handleConnect}
              disabled={busy() || !secretSaved()}
            >
              {busy() ? "Connecting…" : "Sign in"}
            </Button>
          }
        >
          <Button variant="ghost" size="sm" class="h-8" onClick={handleDisconnect}>
            Disconnect
          </Button>
        </Show>
      }
    >
      <Show when={!isConnected()}>
        <div class="mt-3 flex flex-col gap-2">
          <div class="text-xs text-fg-3">
            Mendeley is a confidential OAuth client. The Redirect URL below must match the
            one registered in your app at dev.mendeley.com{" "}
            <strong>character-for-character</strong> (host, port, path, and any trailing
            slash). Set both to the same value — e.g.{" "}
            <span class="mono">http://localhost:5000/callback</span> — then paste the app
            secret (stored in your OS keyring).
          </div>
          <TextField
            label="Redirect URL"
            size="sm"
            mono
            type="text"
            placeholder="e.g. http://localhost:5000/callback"
            value={redirectInput()}
            onInput={(e) => setRedirectInput(e.currentTarget.value)}
            onChange={() => persistMendeley()}
          />
          <div class="text-xs text-fg-3">
            App will send:{" "}
            <span class="mono select-text text-fg-2">
              {redirectInput().trim() || "http://localhost:5000/callback"}
            </span>
            {" "}— this is what Mendeley must have registered.
          </div>
          <div class="flex items-end gap-2">
            <div class="min-w-0 flex-1">
              <TextField
                label="Client secret"
                size="sm"
                mono
                type="password"
                placeholder={secretSaved() ? "Saved — paste to replace" : ""}
                value={secretInput()}
                onInput={(e) => setSecretInput(e.currentTarget.value)}
              />
            </div>
            <Button
              variant="secondary"
              size="sm"
              class="h-8"
              onClick={handleSaveSecret}
              disabled={!secretInput().trim()}
            >
              {secretSaved() ? "Update" : "Save secret"}
            </Button>
          </div>
        </div>
      </Show>
      <Show when={error()}>
        <div class="mt-3 select-text text-xs text-[var(--color-err)]">{error()}</div>
      </Show>
    </ProviderRow>
  );
};

// =================================================================
// Cloud storage card
// =================================================================

const CLOUD_PROVIDERS = [
  {
    id: "dropbox" as const,
    name: "Dropbox",
    feature: "integrations.cloud.dropbox" as const,
    hint: "Hybrid sync — your project lives in a local cache that polls Dropbox via longpoll cursor. Conflicts surface as `.conflict-*` files.",
    connect: connectDropbox,
    disconnect: disconnectDropbox,
  },
];

const CloudStorageCard: Component = () => {
  return (
    <Show when={cloudEntitled()}>
      <Card
        title="Cloud storage"
        subtitle="Open a project from your cloud root. Files stay local-first; the engine polls for remote changes and pushes on autosave."
      >
        <For each={CLOUD_PROVIDERS}>
          {(provider) => (
            <FeatureGate feature={provider.feature}>
              <CloudProviderRow provider={provider} />
            </FeatureGate>
          )}
        </For>
        <FeatureGate feature="integrations.cloud.webdav">
          <WebdavRow />
        </FeatureGate>
      </Card>
    </Show>
  );
};

interface CloudProviderConfig {
  id: "dropbox";
  name: string;
  feature: EntitlementKey;
  hint: string;
  connect: () => Promise<{ accountId: string; email: string; displayName: string }>;
  disconnect: (accountId: string) => Promise<void>;
}

const CloudProviderRow: Component<{ provider: CloudProviderConfig }> = (props) => {
  const account = () =>
    integrationsSettings().cloud.accounts.find((a) => a.provider === props.provider.id);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const handleConnect = async () => {
    setError(null);
    setBusy(true);
    try {
      assertEntitlement(props.provider.feature);
      const acc = await props.provider.connect();
      setIntegrationsSettings({
        ...integrationsSettings(),
        cloud: {
          accounts: [
            ...integrationsSettings().cloud.accounts.filter(
              (a) => a.provider !== props.provider.id,
            ),
            { provider: props.provider.id, accountId: acc.accountId, label: acc.displayName },
          ],
        },
      });
    } catch (err) {
      setError(describeIpcError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    const current = account();
    if (!current) return;
    try {
      await props.provider.disconnect(current.accountId);
    } catch (e) {
      notifyError(`Couldn't disconnect ${props.provider.name}`, errorText(e));
      return;
    }
    setIntegrationsSettings({
      ...integrationsSettings(),
      cloud: {
        accounts: integrationsSettings().cloud.accounts.filter(
          (a) => a.provider !== props.provider.id,
        ),
      },
    });
  };

  return (
    <ProviderRow
      name={props.provider.name}
      hint={account() ? `Connected as ${account()!.label}.` : props.provider.hint}
      status={account() ? "ready" : "unconfigured"}
      controls={
        <Show
          when={account()}
          fallback={
            <Button variant="primary" size="sm" class="h-8" onClick={handleConnect} disabled={busy()}>
              {busy() ? "Connecting…" : "Sign in"}
            </Button>
          }
        >
          <Button variant="ghost" size="sm" class="h-8" onClick={handleDisconnect}>
            Disconnect
          </Button>
        </Show>
      }
    >
      <Show when={error()}>
        <div class="mt-3 select-text text-xs text-[var(--color-err)]">{error()}</div>
      </Show>
    </ProviderRow>
  );
};

/** Forgiving normalization so users can paste a bare host. Rust validates +
 * screens the host; here we only ensure a parseable https URL. */
function normalizeWebdavUrl(raw: string): string {
  let s = raw.trim();
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  if (!s.endsWith("/")) s = `${s}/`;
  return s;
}

const WebdavRow: Component = () => {
  const accounts = () =>
    integrationsSettings().cloud.accounts.filter((a) => a.provider === "webdav");
  const [adding, setAdding] = createSignal(false);
  const [url, setUrl] = createSignal("");
  const [username, setUsername] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [allowPrivate, setAllowPrivate] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const handleAdd = async () => {
    setError(null);
    const user = username().trim();
    if (!url().trim() || !user || !password()) {
      setError("Server URL, username, and app password are all required.");
      return;
    }
    setBusy(true);
    try {
      assertEntitlement("integrations.cloud.webdav");
      const connected = await connectWebdav({
        url: normalizeWebdavUrl(url()),
        username: user,
        password: password(),
        allowPrivateHost: allowPrivate(),
      });
      setIntegrationsSettings({
        ...integrationsSettings(),
        cloud: {
          accounts: [
            ...integrationsSettings().cloud.accounts.filter(
              (a) => !(a.provider === "webdav" && a.accountId === connected.accountId),
            ),
            {
              provider: "webdav",
              accountId: connected.accountId,
              label: connected.label,
              baseUrl: connected.baseUrl,
              username: connected.username,
              allowPrivateHost: connected.allowPrivateHost,
            },
          ],
        },
      });
      setUrl("");
      setUsername("");
      setPassword("");
      setAllowPrivate(false);
      setAdding(false);
    } catch (err) {
      setError(describeIpcError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async (accountId: string) => {
    try {
      await disconnectWebdav(accountId);
    } catch (e) {
      notifyError("Couldn't disconnect WebDAV", errorText(e));
      return;
    }
    setIntegrationsSettings({
      ...integrationsSettings(),
      cloud: {
        accounts: integrationsSettings().cloud.accounts.filter(
          (a) => !(a.provider === "webdav" && a.accountId === accountId),
        ),
      },
    });
  };

  return (
    <ProviderRow
      name="WebDAV"
      hint="Self-hosted or hosted WebDAV — Nextcloud, ownCloud, Fastmail, mailbox.org, a NAS. Use an app password (not your account password); it's required when 2FA is on. Files sync into a local cache, like Dropbox."
      status={accounts().length > 0 ? "ready" : "unconfigured"}
      controls={
        <Button
          variant={adding() ? "ghost" : "primary"}
          size="sm"
          class="h-8"
          onClick={() => setAdding(!adding())}
        >
          {adding() ? "Cancel" : "Add server"}
        </Button>
      }
    >
      <Show when={accounts().length > 0 || adding()}>
        <div class="mt-3 flex flex-col gap-2">
          <For each={accounts()}>
            {(acc) => (
              <div class="flex items-center justify-between gap-2 text-sm text-fg-2">
                <span class="truncate">{acc.label ?? acc.accountId}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  class="h-8"
                  onClick={() => void handleDisconnect(acc.accountId)}
                >
                  Disconnect
                </Button>
              </div>
            )}
          </For>
          <Show when={adding()}>
            <div class="flex flex-col gap-2">
              <TextField
                label="Server URL"
                size="sm"
                type="text"
                placeholder="e.g. https://cloud.example.com/remote.php/dav/files/you/"
                value={url()}
                onInput={(e) => setUrl(e.currentTarget.value)}
              />
              <div class="flex gap-2">
                <div class="min-w-0 flex-1">
                  <TextField
                    label="Username"
                    size="sm"
                    type="text"
                    value={username()}
                    onInput={(e) => setUsername(e.currentTarget.value)}
                  />
                </div>
                <div class="min-w-0 flex-[2]">
                  <TextField
                    label="App password"
                    size="sm"
                    mono
                    type="password"
                    value={password()}
                    onInput={(e) => setPassword(e.currentTarget.value)}
                  />
                </div>
              </div>
              <label class="flex items-center gap-2 text-xs text-fg-2">
                <input
                  type="checkbox"
                  checked={allowPrivate()}
                  onInput={(e) => setAllowPrivate(e.currentTarget.checked)}
                  class="h-3 w-3 rounded accent-[var(--color-accent-1)]"
                />
                Allow a private / LAN server (10.x, 172.16.x, 192.168.x). Loopback and
                cloud-metadata addresses stay blocked.
              </label>
              <div>
                <Button variant="primary" size="sm" class="h-8" onClick={handleAdd} disabled={busy()}>
                  {busy() ? "Connecting…" : "Connect"}
                </Button>
              </div>
              <Show when={error()}>
                <div class="select-text text-xs text-[var(--color-err)]">{error()}</div>
              </Show>
            </div>
          </Show>
        </div>
      </Show>
    </ProviderRow>
  );
};

// =================================================================
// Git & GitHub card
// =================================================================

const VcsCard: Component = () => {
  return (
    <Show when={vcsEntitled()}>
      <Card
        title="Git & GitHub"
        subtitle="Commit / push / pull from inside the editor. Clone repos as new projects. Set your author identity here so commits go through with the right name and email."
      >
        <FeatureGate feature="integrations.vcs.git">
          <AuthorIdentityRow />
        </FeatureGate>
        <FeatureGate feature="integrations.vcs.github">
          <GithubAccountRow />
        </FeatureGate>
      </Card>
    </Show>
  );
};

const AuthorIdentityRow: Component = () => {
  const git = () => integrationsSettings().vcs.git;

  const update = (patch: { authorName?: string; authorEmail?: string }) => {
    setIntegrationsSettings({
      ...integrationsSettings(),
      vcs: {
        ...integrationsSettings().vcs,
        git: { ...git(), ...patch },
      },
    });
  };

  return (
    <ProviderRow
      name="Author identity"
      hint="Falls back to your system gitconfig when blank. Required for commits — git will refuse to commit without a signature."
      status={git().authorName && git().authorEmail ? "ready" : "unconfigured"}
      controls={<span class="text-xs text-fg-3 italic">Saved in settings.json</span>}
    >
      <div class="mt-3 flex flex-col gap-2">
        <div class="flex gap-2">
          <div class="min-w-0 flex-1">
            <TextField
              label="Name"
              size="sm"
              type="text"
              value={git().authorName ?? ""}
              onInput={(e) => update({ authorName: e.currentTarget.value || undefined })}
            />
          </div>
          <div class="min-w-0 flex-1">
            <TextField
              label="Email"
              size="sm"
              type="email"
              placeholder="e.g. you@example.com"
              value={git().authorEmail ?? ""}
              onInput={(e) => update({ authorEmail: e.currentTarget.value || undefined })}
            />
          </div>
        </div>
      </div>
    </ProviderRow>
  );
};

const GithubAccountRow: Component = () => {
  const accountId = () => integrationsSettings().vcs.github.accountId;
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [userCode, setUserCode] = createSignal<string | null>(null);

  const [hasCred] = createResource(accountId, async (login) => {
    if (!login) return false;
    return await hasGithubCredential();
  });

  const handleConnect = async () => {
    setError(null);
    setUserCode(null);
    setBusy(true);
    try {
      const account = await connectGithub((code) => setUserCode(code));
      setIntegrationsSettings({
        ...integrationsSettings(),
        vcs: {
          ...integrationsSettings().vcs,
          github: { accountId: account.login },
        },
      });
      setUserCode(null);
    } catch (err) {
      setError(describeIpcError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    const login = accountId();
    if (!login) return;
    try {
      await disconnectGithub(login);
    } catch (e) {
      notifyError("Couldn't disconnect GitHub", errorText(e));
      return;
    }
    setIntegrationsSettings({
      ...integrationsSettings(),
      vcs: {
        ...integrationsSettings().vcs,
        github: {},
      },
    });
  };

  return (
    <ProviderRow
      name="GitHub"
      hint={
        accountId()
          ? `Connected as ${accountId()}. The token is stored in the OS keyring under git.github.com so libgit2 picks it up on push / pull.`
          : "Sign in via GitHub's device flow — works on desktop and tablet, no loopback callback needed."
      }
      status={accountId() && hasCred() ? "ready" : "unconfigured"}
      controls={
        <Show
          when={accountId()}
          fallback={
            <Button variant="primary" size="sm" class="h-8" onClick={handleConnect} disabled={busy()}>
              {busy() ? "Waiting…" : "Sign in"}
            </Button>
          }
        >
          <Button variant="ghost" size="sm" class="h-8" onClick={handleDisconnect}>
            Disconnect
          </Button>
        </Show>
      }
    >
      <Show when={userCode()}>
        <div class="mt-3 flex items-center gap-3 rounded-md bg-[var(--color-control-fill)] px-3 py-2">
          <span class="text-xs text-fg-3">User code:</span>
          <span class="mono select-all text-lg font-semibold tracking-[0.25em] text-fg-1">
            {userCode()}
          </span>
          <span class="text-xs text-fg-3">— your browser should open with this prefilled.</span>
        </div>
      </Show>
      <Show when={error()}>
        <div class="mt-3 select-text text-xs text-[var(--color-err)]">{error()}</div>
      </Show>
    </ProviderRow>
  );
};

// =================================================================
// AI card
// =================================================================

interface AiKnownProvider {
  id: AiProviderId;
  name: string;
  feature: EntitlementKey;
  hint: string;
  /** Keyring service for the API key. Ollama has no auth. */
  keyringService?: string;
  /** URL to drop the user at when they need a key. */
  keyUrl?: string;
}

// Keyed by AiProviderId so a new provider added to the registry union is a
// compile error here until its settings card is described — the two used to
// drift silently (the card just wouldn't render).
const AI_PROVIDERS: Record<AiProviderId, AiKnownProvider> = {
  anthropic: {
    id: "anthropic",
    name: "Claude (Anthropic)",
    feature: "integrations.ai.anthropic",
    hint: "Paste a key from console.anthropic.com → API Keys. Streaming via the Messages API; the key never leaves the keyring.",
    keyringService: "anthropic",
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  openai: {
    id: "openai",
    name: "ChatGPT (OpenAI)",
    feature: "integrations.ai.openai",
    hint: "Paste a key from platform.openai.com → API keys. Chat Completions endpoint with bearer auth.",
    keyringService: "openai",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  gemini: {
    id: "gemini",
    name: "Gemini (Google)",
    feature: "integrations.ai.gemini",
    hint: "Paste an API key from aistudio.google.com. The key attaches as a request header inside the Rust layer; it never leaves the keyring on the frontend side.",
    keyringService: "gemini",
    keyUrl: "https://aistudio.google.com/apikey",
  },
  ollama: {
    id: "ollama",
    name: "Ollama (local)",
    feature: "integrations.ai.ollama",
    hint: "Local models via the Ollama app — auto-detected, nothing to configure. Install from ollama.com, pull a model, and it shows up here.",
  },
};

const AI_PROVIDER_LIST: AiKnownProvider[] = Object.values(AI_PROVIDERS);

const AiCard: Component = () => {
  const ai = () => integrationsSettings().ai;

  const setActive = (id: string | undefined) => {
    setIntegrationsSettings({
      ...integrationsSettings(),
      ai: { ...ai(), activeProvider: id },
    });
  };

  const setEnabled = (enabled: boolean) => {
    setIntegrationsSettings({
      ...integrationsSettings(),
      ai: { ...ai(), enabled },
    });
  };

  return (
    <Show when={aiEntitled()}>
      <Card
        title="AI"
        subtitle="Optional assistant chat in the editor, routed through the provider you pick. Turn it off to hide every AI surface — no provider runs, nothing leaves the machine."
      >
        <ProviderRow
          name="AI assistant"
          hint="Master switch. Off removes the chat panel and its toolbar button from the editor and deactivates the provider below."
          status={ai().enabled ? "ready" : "unconfigured"}
          controls={<Switch checked={ai().enabled} onChange={setEnabled} />}
        />
        <Show when={ai().enabled}>
          <For each={AI_PROVIDER_LIST}>
            {(p) => (
              <FeatureGate feature={p.feature}>
                <AiProviderRow provider={p} onActivate={setActive} />
              </FeatureGate>
            )}
          </For>
        </Show>
      </Card>
    </Show>
  );
};

const AiProviderRow: Component<{
  provider: AiKnownProvider;
  onActivate: (id: string | undefined) => void;
}> = (props) => {
  const ai = () => integrationsSettings().ai;
  const [apiKeyInput, setApiKeyInput] = createSignal("");
  const [baseUrlInput, setBaseUrlInput] = createSignal(ai().ollamaBaseUrl ?? "");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const [hasKey, { refetch: refetchKey }] = createResource(
    () => props.provider.keyringService,
    async (service) => {
      if (!service) return true; // Ollama: no key needed.
      return credentialExists({ service, account: "default" });
    },
  );

  // Ollama is zero-config: probe the daemon (settings override or the
  // default localhost:11434) and list its models, instead of pretending
  // it's "ready" while nothing is running.
  const [ollamaProbe, { refetch: refetchOllama }] = createResource(
    () => (props.provider.id === "ollama" ? (ai().ollamaBaseUrl ?? "") : null),
    async (base) => {
      if (base === null) return null;
      const provider = createOllamaProvider(base || undefined);
      try {
        const models = await provider.models();
        return { ok: true as const, models: models.map((m) => m.id) };
      } catch {
        return { ok: false as const, models: [] as string[] };
      }
    },
  );

  const isActive = () => ai().activeProvider === props.provider.id;

  const status = (): ProviderStatus => {
    if (props.provider.id === "ollama") {
      const probe = ollamaProbe();
      if (probe === undefined || probe === null) return "checking";
      return probe.ok ? "ready" : "unreachable";
    }
    return hasKey() ? "ready" : "unconfigured";
  };

  const saveKey = async () => {
    setError(null);
    const service = props.provider.keyringService;
    if (!service) return;
    const value = apiKeyInput().trim();
    if (!value) {
      setError("Paste a key first.");
      return;
    }
    setBusy(true);
    try {
      assertEntitlement(props.provider.feature);
      // Probe the key by hitting the provider's /models endpoint
      // through Rust so the bearer never crosses the IPC the wrong way.
      const { setCredential, deleteCredential } = await import(
        "~/integrations/auth/credentials"
      );
      await setCredential({ service, account: "default" }, value);
      const probe = await probeProvider(props.provider.id);
      if (!probe.ok) {
        await deleteCredential({ service, account: "default" });
        throw new Error(probe.message);
      }
      setApiKeyInput("");
      await refetchKey();
    } catch (err) {
      setError(describeIpcError(err));
    } finally {
      setBusy(false);
    }
  };

  const removeKey = async () => {
    const service = props.provider.keyringService;
    if (!service) return;
    try {
      const { deleteCredential } = await import("~/integrations/auth/credentials");
      await deleteCredential({ service, account: "default" });
    } catch (e) {
      notifyError("Couldn't remove API key", errorText(e));
      return;
    }
    if (ai().activeProvider === props.provider.id) {
      props.onActivate(undefined);
    }
    await refetchKey();
  };

  const persistOllamaBaseUrl = () => {
    setIntegrationsSettings({
      ...integrationsSettings(),
      ai: { ...ai(), ollamaBaseUrl: baseUrlInput().trim() || undefined },
    });
  };

  return (
    <ProviderRow
      name={props.provider.name}
      hint={props.provider.hint}
      status={status()}
      controls={
        <div class="flex items-center gap-1.5">
          <Show when={status() === "ready"}>
            <Button
              variant={isActive() ? "secondary" : "ghost"}
              size="sm"
              class="h-8"
              onClick={() => {
                if (!isActive()) assertEntitlement(props.provider.feature);
                props.onActivate(isActive() ? undefined : props.provider.id);
              }}
            >
              {isActive() ? "Active" : "Use this"}
            </Button>
          </Show>
          <Show when={props.provider.keyUrl && !hasKey()}>
            <a
              href={props.provider.keyUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => {
                e.preventDefault();
                if (props.provider.keyUrl) void openUrl(props.provider.keyUrl);
              }}
              class="lift flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-fg-2 hover:text-fg-1 hover:bg-[var(--color-control-fill)]"
            >
              Get key
              <ExternalLink class="ui-icon-sm" />
            </a>
          </Show>
        </div>
      }
    >
      <Show when={props.provider.keyringService && !hasKey()}>
        <div class="mt-3 flex items-end gap-2">
          <div class="min-w-0 flex-1">
            <TextField
              label="API key"
              size="sm"
              mono
              type="password"
              value={apiKeyInput()}
              onInput={(e) => setApiKeyInput(e.currentTarget.value)}
            />
          </div>
          <Button variant="primary" size="sm" class="h-8" onClick={saveKey} disabled={busy()}>
            {busy() ? "Testing…" : "Save"}
          </Button>
        </div>
      </Show>
      <Show when={props.provider.keyringService && hasKey()}>
        <div class="mt-3 text-xs text-fg-3">
          Key stored in keyring as <span class="mono">{props.provider.keyringService}</span>.
          <button
            type="button"
            onClick={removeKey}
            class="ml-2 text-[var(--color-err)] hover:underline"
          >
            Remove
          </button>
        </div>
      </Show>
      <Show when={props.provider.id === "ollama"}>
        <Show
          when={ollamaProbe()?.ok}
          fallback={
            <div class="mt-3 flex flex-col gap-2 text-sm text-fg-2">
              <Show when={ollamaProbe() && !ollamaProbe()!.ok}>
                <div class="text-fg-3">
                  Ollama isn't running. Install it from{" "}
                  <span class="mono text-fg-2">ollama.com</span>, pull a model
                  (e.g. <span class="mono text-fg-2">ollama pull gemma3</span>),
                  and it's detected automatically — no setup needed.
                </div>
                {/* Only useful when the daemon runs somewhere non-default. */}
                <div class="flex items-end gap-2">
                  <div class="min-w-0 flex-1">
                    <TextField
                      label="Custom URL (optional)"
                      size="sm"
                      mono
                      type="text"
                      value={baseUrlInput()}
                      onInput={(e) => setBaseUrlInput(e.currentTarget.value)}
                      onBlur={persistOllamaBaseUrl}
                      placeholder="e.g. http://localhost:11434"
                    />
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void refetchOllama()}
                  >
                    Re-check
                  </Button>
                </div>
              </Show>
            </div>
          }
        >
          <div class="mt-3 flex items-center gap-2 text-sm text-fg-3">
            <span>
              Detected
              <Show when={ai().ollamaBaseUrl}>
                {" "}at <span class="mono">{ai().ollamaBaseUrl}</span>
              </Show>
              {" "}·{" "}
              <span class="text-fg-2">
                {ollamaProbe()!.models.length} model
                {ollamaProbe()!.models.length === 1 ? "" : "s"}
              </span>
              <Show when={ollamaProbe()!.models.length > 0}>
                {" "}
                <span class="mono">
                  ({ollamaProbe()!.models.slice(0, 3).join(", ")}
                  {ollamaProbe()!.models.length > 3 ? ", …" : ""})
                </span>
              </Show>
            </span>
            <Button
              variant="ghost"
              size="sm"
              class="ml-auto"
              aria-label="Refresh models"
              onClick={() => void refetchOllama()}
            >
              <RefreshCw class="ui-icon-sm" />
            </Button>
          </div>
        </Show>
      </Show>
      <Show when={error()}>
        <div class="mt-3 select-text text-xs text-[var(--color-err)]">{error()}</div>
      </Show>
    </ProviderRow>
  );
};

async function probeProvider(
  id: AiProviderId,
): Promise<{ ok: true } | { ok: false; message: string }> {
  // Delegate to the provider module's own status() rather than restating each
  // provider's endpoint/header/authRef here — the provider is the single source
  // of truth for its API surface, so a version bump lands in one place.
  try {
    const status = await getProvider(id).status();
    if (status === "ready") return { ok: true };
    const name = AI_PROVIDERS[id].name;
    return { ok: false, message: `${name} rejected the key or is unreachable (status: ${status}).` };
  } catch (err) {
    return { ok: false, message: describeIpcError(err) };
  }
}

// =================================================================
// Grammar card
// =================================================================

const DIALECT_LABELS: Record<ipc.GrammarDialect, string> = {
  "en-US": "American",
  "en-GB": "British",
  "en-CA": "Canadian",
  "en-AU": "Australian",
  "en-IN": "Indian",
};

const GrammarCard: Component = () => {
  const grammar = () => integrationsSettings().grammar;

  const toggle = (enabled: boolean) => {
    setIntegrationsSettings({
      ...integrationsSettings(),
      grammar: { ...grammar(), enabled },
    });
  };

  const setDialect = (language: string) => {
    setIntegrationsSettings({
      ...integrationsSettings(),
      grammar: { ...grammar(), language },
    });
  };

  const [words, { refetch: refetchWords }] = createResource(async () => {
    try {
      return await ipc.grammarListWords();
    } catch {
      return [] as string[];
    }
  });
  const [managing, setManaging] = createSignal(false);
  const [clearing, setClearing] = createSignal(false);

  const removeWord = async (word: string) => {
    try {
      await ipc.grammarRemoveWord(word);
      await refetchWords();
    } catch (e) {
      notifyError("Couldn't remove word", errorText(e));
    }
  };

  const resetIgnored = async () => {
    setClearing(true);
    try {
      await ipc.grammarClearIgnored();
      notifySuccess("Ignored lints cleared", "Previously dismissed suggestions will show again.");
    } catch (e) {
      notifyError("Couldn't reset ignored lints", errorText(e));
    } finally {
      setClearing(false);
    }
  };

  return (
    <FeatureGate feature="integrations.grammar.harper">
    <Card
      title="Grammar"
      subtitle="Local Harper grammar + spell check. Runs in-process via the Rust crate — zero network, all on-device. LaTeX commands and Typst code are skipped automatically; diagnostics surface as squiggles with one-click fixes."
    >
      <ProviderRow
        name="Harper"
        hint="Rust-native English grammar engine. Underlines spelling, grammar, and style issues with quick-fix suggestions."
        status={grammar().enabled ? "ready" : "unconfigured"}
        controls={<Switch checked={grammar().enabled} onChange={toggle} />}
      >
        <Show when={grammar().enabled}>
          <div class="mt-4 flex flex-col gap-3">
            <div class="flex items-center justify-between gap-4">
              <div class="min-w-0">
                <div class="text-sm font-medium text-fg-1">English dialect</div>
                <div class="text-xs text-fg-3">
                  Spelling and usage rules follow the selected variety.
                </div>
              </div>
              <select
                value={grammar().language ?? "en-US"}
                onChange={(e) => setDialect(e.currentTarget.value)}
                class="glass-inset h-8 rounded-md px-2.5 text-sm text-fg-1 outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent-1)]"
              >
                <For each={ipc.GRAMMAR_DIALECTS}>
                  {(d) => (
                    <option value={d}>
                      {DIALECT_LABELS[d]} ({d})
                    </option>
                  )}
                </For>
              </select>
            </div>

            <div class="flex items-center justify-between gap-4">
              <div class="min-w-0">
                <div class="text-sm font-medium text-fg-1">
                  Personal dictionary: {words()?.length ?? 0}{" "}
                  {(words()?.length ?? 0) === 1 ? "word" : "words"}
                </div>
                <div class="text-xs text-fg-3">
                  Words you added via "Add to dictionary" are never flagged.
                </div>
              </div>
              <Button
                variant="secondary"
                size="sm"
                class="h-8"
                onClick={() => setManaging((v) => !v)}
              >
                {managing() ? "Done" : "Manage"}
              </Button>
            </div>

            <Show when={managing()}>
              <div class="glass-inset rounded-md p-1">
                <Show
                  when={(words()?.length ?? 0) > 0}
                  fallback={
                    <div class="px-2 py-3 text-center text-xs text-fg-3">
                      No custom words yet.
                    </div>
                  }
                >
                  <div class="max-h-48 overflow-y-auto">
                    <For each={words()}>
                      {(word) => (
                        <div class="flex items-center justify-between gap-2 rounded px-2 py-1.5 hover:bg-[var(--color-control-fill)]">
                          <span class="mono truncate text-sm text-fg-1">{word}</span>
                          <button
                            type="button"
                            aria-label={`Remove ${word}`}
                            class="lift flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-fg-3 hover:text-[var(--color-err)]"
                            onClick={() => void removeWord(word)}
                          >
                            <X class="ui-icon-sm" />
                          </button>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </Show>

            <div class="flex items-center justify-between gap-4">
              <div class="min-w-0">
                <div class="text-sm font-medium text-fg-1">Ignored suggestions</div>
                <div class="text-xs text-fg-3">
                  Restore every lint you dismissed with "Ignore".
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                class="h-8"
                onClick={() => void resetIgnored()}
                disabled={clearing()}
              >
                Reset ignored lints
              </Button>
            </div>
          </div>
        </Show>
      </ProviderRow>
    </Card>
    </FeatureGate>
  );
};

// =================================================================
// Shared layout
// =================================================================

type ProviderStatus = "ready" | "unconfigured" | "unreachable" | "checking" | "error";

const STATUS_TEXT: Record<ProviderStatus, string> = {
  ready: "Ready",
  unconfigured: "Not configured",
  unreachable: "Not reachable",
  checking: "Checking…",
  error: "Error",
};

const STATUS_BG: Record<ProviderStatus, string> = {
  ready: "color-mix(in srgb, var(--color-ok) 18%, transparent)",
  unconfigured: "var(--color-control-fill)",
  unreachable: "color-mix(in srgb, var(--color-err) 18%, transparent)",
  checking: "var(--color-control-fill)",
  error: "color-mix(in srgb, var(--color-err) 18%, transparent)",
};

const STATUS_FG: Record<ProviderStatus, string> = {
  ready: "color-mix(in srgb, var(--color-ok) 65%, var(--color-fg-1))",
  unconfigured: "var(--color-fg-3)",
  unreachable: "color-mix(in srgb, var(--color-err) 65%, var(--color-fg-1))",
  checking: "var(--color-fg-3)",
  error: "color-mix(in srgb, var(--color-err) 65%, var(--color-fg-1))",
};

const ProviderRow: Component<{
  name: string;
  hint: string;
  status: ProviderStatus;
  controls: JSX.Element;
  children?: JSX.Element;
}> = (props) => (
  <div class="border-t border-glass-stroke px-5 py-4 first:border-t-0">
    <div class="flex items-start gap-4">
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <span class="text-base font-medium text-fg-1">{props.name}</span>
          <span
            class="mono inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider"
            style={{ background: STATUS_BG[props.status], color: STATUS_FG[props.status] }}
          >
            <Show when={props.status === "ready"}>
              <Check class="ui-icon-sm" />
            </Show>
            <Show when={props.status === "unreachable" || props.status === "error"}>
              <X class="ui-icon-sm" />
            </Show>
            <Show when={props.status === "checking"}>
              <RefreshCw class="ui-icon-sm animate-spin" />
            </Show>
            {STATUS_TEXT[props.status]}
          </span>
        </div>
        <div class="mt-0.5 text-sm leading-relaxed text-fg-3">{props.hint}</div>
      </div>
      <div class="flex-shrink-0">{props.controls}</div>
    </div>
    {props.children}
  </div>
);

// Local Card kept inline so this panel doesn't depend on
// SettingsScreen's internal primitives (those aren't exported).

const Card: Component<{
  title: string;
  subtitle?: string;
  children: JSX.Element;
}> = (props) => (
  <div class="glass overflow-hidden rounded-xl">
    <div class="border-b border-glass-stroke px-5 py-4">
      <div class="text-base font-semibold tracking-tight text-fg-1">{props.title}</div>
      <Show when={props.subtitle}>
        <div class="mt-0.5 text-sm leading-relaxed text-fg-2">{props.subtitle}</div>
      </Show>
    </div>
    <div>{props.children}</div>
  </div>
);
