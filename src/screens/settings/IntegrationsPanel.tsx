/**
 * Integrations settings panel.
 *
 * Phase 1 ships the References card only — Cloud / Git / AI / Grammar /
 * Templates cards land alongside their respective phases. The shape of
 * this file is set up to host them all in one panel rather than
 * sub-routing, so users can scroll one page to see what's wired up.
 */

import {
  Check,
  ExternalLink,
  RefreshCw,
  X,
} from "lucide-solid";
import type { Component, JSX } from "solid-js";
import { Show, createResource, createSignal, For } from "solid-js";

import { FeatureGate } from "~/components/entitlement/FeatureGate";
import { Button } from "~/components/primitives/Button";
import { Switch } from "~/components/forms/Switch";
import { assertEntitlement } from "~/integrations/entitlements";
import type { EntitlementKey } from "~/integrations/types";
import {
  credentialExists,
  deleteCredential,
  setCredential,
} from "~/integrations/auth/credentials";
import { httpRequest } from "~/integrations/http";
import { createOllamaProvider } from "~/integrations/ai/ollama";
import {
  connectMendeley,
  disconnectMendeley,
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

export type IntegrationsSection = "references" | "cloud" | "vcs" | "ai" | "grammar";

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
    <Card
      title="References"
      subtitle="Connect a reference manager to autocomplete \\cite{…} keys and append the aggregated library to the project's .bib."
    >
      <BetterBibTexRow />
      <FeatureGate feature="integrations.references.zotero.web">
        <ZoteroWebRow />
      </FeatureGate>
      <FeatureGate feature="integrations.references.mendeley">
        <MendeleyRow />
      </FeatureGate>
    </Card>
  );
};

const BetterBibTexRow: Component = () => {
  // "Ready" if either local path answers — Better BibTeX or plain
  // Zotero 7's built-in API. `bbt` only affects the explanatory hint now;
  // libraries are auto-discovered either way.
  const [probe] = createResource(async () => {
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
        <Switch
          checked={settings().enabled}
          onChange={(checked) => toggle(checked)}
          disabled={!probe()?.reachable}
        />
      }
    >
      <Show when={settings().enabled && probe()?.reachable && !probe()?.bbt}>
        <div class="mt-3 text-[12px] text-fg-3">
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
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    const userId = settings().userId;
    if (!userId) return;
    await deleteCredential({ service: "zotero-web", account: userId });
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
              class="lift flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12px] text-fg-2 hover:text-fg-1 hover:bg-[var(--color-control-fill)]"
            >
              Get key
              <ExternalLink class="ui-icon-sm" />
            </a>
          }
        >
          <Button variant="ghost" size="sm" onClick={handleDisconnect}>
            Disconnect
          </Button>
        </Show>
      }
    >
      <Show when={!isConnected()}>
        <div class="mt-3 flex flex-col gap-2">
          <div class="flex gap-2">
            <input
              type="text"
              placeholder="User id (numeric)"
              value={userIdInput()}
              onInput={(e) => setUserIdInput(e.currentTarget.value)}
              class="glass-inset h-8 flex-1 rounded-md px-2.5 text-[12px] text-fg-1 placeholder:text-fg-3 outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent-1)]"
            />
            <input
              type="password"
              placeholder="API key"
              value={apiKeyInput()}
              onInput={(e) => setApiKeyInput(e.currentTarget.value)}
              class="glass-inset h-8 flex-[2] rounded-md px-2.5 font-mono text-[12px] text-fg-1 placeholder:text-fg-3 outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent-1)]"
            />
            <Button variant="primary" size="sm" onClick={handleConnect} disabled={busy()}>
              {busy() ? "Testing…" : "Connect"}
            </Button>
          </div>
          <Show when={error()}>
            <div class="text-[11px] text-[var(--color-err)]">{error()}</div>
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
  const isConnected = () => Boolean(settings().profileId);

  const handleConnect = async () => {
    setError(null);
    setBusy(true);
    try {
      assertEntitlement("integrations.references.mendeley");
      const account = await connectMendeley();
      setIntegrationsSettings({
        ...integrationsSettings(),
        references: {
          ...integrationsSettings().references,
          mendeley: { profileId: account.profileId, displayName: account.displayName },
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    const profileId = settings().profileId;
    if (!profileId) return;
    await disconnectMendeley(profileId);
    setIntegrationsSettings({
      ...integrationsSettings(),
      references: {
        ...integrationsSettings().references,
        mendeley: {},
      },
    });
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
            <Button variant="primary" size="sm" onClick={handleConnect} disabled={busy()}>
              {busy() ? "Connecting…" : "Sign in"}
            </Button>
          }
        >
          <Button variant="ghost" size="sm" onClick={handleDisconnect}>
            Disconnect
          </Button>
        </Show>
      }
    >
      <Show when={error()}>
        <div class="mt-3 text-[11px] text-[var(--color-err)]">{error()}</div>
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
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    const current = account();
    if (!current) return;
    await props.provider.disconnect(current.accountId);
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
            <Button variant="primary" size="sm" onClick={handleConnect} disabled={busy()}>
              {busy() ? "Connecting…" : "Sign in"}
            </Button>
          }
        >
          <Button variant="ghost" size="sm" onClick={handleDisconnect}>
            Disconnect
          </Button>
        </Show>
      }
    >
      <Show when={error()}>
        <div class="mt-3 text-[11px] text-[var(--color-err)]">{error()}</div>
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

const WEBDAV_INPUT =
  "glass-inset h-8 rounded-md px-2.5 text-[12px] text-fg-1 placeholder:text-fg-3 outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent-1)]";

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
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async (accountId: string) => {
    await disconnectWebdav(accountId);
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
              <div class="flex items-center justify-between gap-2 text-[12px] text-fg-2">
                <span class="truncate">{acc.label ?? acc.accountId}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleDisconnect(acc.accountId)}
                >
                  Disconnect
                </Button>
              </div>
            )}
          </For>
          <Show when={adding()}>
            <div class="flex flex-col gap-2">
              <input
                type="text"
                placeholder="https://cloud.example.com/remote.php/dav/files/you/"
                value={url()}
                onInput={(e) => setUrl(e.currentTarget.value)}
                class={WEBDAV_INPUT}
              />
              <div class="flex gap-2">
                <input
                  type="text"
                  placeholder="Username"
                  value={username()}
                  onInput={(e) => setUsername(e.currentTarget.value)}
                  class={`${WEBDAV_INPUT} flex-1`}
                />
                <input
                  type="password"
                  placeholder="App password"
                  value={password()}
                  onInput={(e) => setPassword(e.currentTarget.value)}
                  class={`${WEBDAV_INPUT} flex-[2] font-mono`}
                />
              </div>
              <label class="flex items-center gap-2 text-[11px] text-fg-2">
                <input
                  type="checkbox"
                  checked={allowPrivate()}
                  onInput={(e) => setAllowPrivate(e.currentTarget.checked)}
                />
                Allow a private / LAN server (10.x, 172.16.x, 192.168.x). Loopback and
                cloud-metadata addresses stay blocked.
              </label>
              <div>
                <Button variant="primary" size="sm" onClick={handleAdd} disabled={busy()}>
                  {busy() ? "Connecting…" : "Connect"}
                </Button>
              </div>
              <Show when={error()}>
                <div class="text-[11px] text-[var(--color-err)]">{error()}</div>
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
    <Card
      title="Git & GitHub"
      subtitle="Commit / push / pull from inside the editor. Clone repos as new projects. Set your author identity here so commits go through with the right name and email."
    >
      <AuthorIdentityRow />
      <GithubAccountRow />
    </Card>
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
      controls={<span class="text-[11px] text-fg-3 italic">Saved in settings.json</span>}
    >
      <div class="mt-3 flex flex-col gap-2">
        <div class="flex gap-2">
          <input
            type="text"
            placeholder="Name"
            value={git().authorName ?? ""}
            onInput={(e) => update({ authorName: e.currentTarget.value || undefined })}
            class="glass-inset h-8 flex-1 rounded-md px-2.5 text-[12px] text-fg-1 placeholder:text-fg-3 outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent-1)]"
          />
          <input
            type="email"
            placeholder="you@example.com"
            value={git().authorEmail ?? ""}
            onInput={(e) => update({ authorEmail: e.currentTarget.value || undefined })}
            class="glass-inset h-8 flex-1 rounded-md px-2.5 text-[12px] text-fg-1 placeholder:text-fg-3 outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent-1)]"
          />
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
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    const login = accountId();
    if (!login) return;
    await disconnectGithub(login);
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
            <Button variant="primary" size="sm" onClick={handleConnect} disabled={busy()}>
              {busy() ? "Waiting…" : "Sign in"}
            </Button>
          }
        >
          <Button variant="ghost" size="sm" onClick={handleDisconnect}>
            Disconnect
          </Button>
        </Show>
      }
    >
      <Show when={userCode()}>
        <div class="mt-3 flex items-center gap-3 rounded-md bg-[var(--color-control-fill)] px-3 py-2">
          <span class="text-[11px] text-fg-3">User code:</span>
          <span class="mono select-all text-[16px] font-semibold tracking-[0.25em] text-fg-1">
            {userCode()}
          </span>
          <span class="text-[11px] text-fg-3">— your browser should open with this prefilled.</span>
        </div>
      </Show>
      <Show when={error()}>
        <div class="mt-3 text-[11px] text-[var(--color-err)]">{error()}</div>
      </Show>
    </ProviderRow>
  );
};

// =================================================================
// AI card
// =================================================================

interface AiKnownProvider {
  id: "anthropic" | "openai" | "gemini" | "ollama";
  name: string;
  feature: EntitlementKey;
  hint: string;
  /** Keyring service for the API key. Ollama has no auth. */
  keyringService?: string;
  /** URL to drop the user at when they need a key. */
  keyUrl?: string;
}

const AI_PROVIDERS: AiKnownProvider[] = [
  {
    id: "anthropic",
    name: "Claude (Anthropic)",
    feature: "integrations.ai.anthropic",
    hint: "Paste a key from console.anthropic.com → API Keys. Streaming via the Messages API; the key never leaves the keyring.",
    keyringService: "anthropic",
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "openai",
    name: "ChatGPT (OpenAI)",
    feature: "integrations.ai.openai",
    hint: "Paste a key from platform.openai.com → API keys. Chat Completions endpoint with bearer auth.",
    keyringService: "openai",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "gemini",
    name: "Gemini (Google)",
    feature: "integrations.ai.gemini",
    hint: "Paste an API key from aistudio.google.com. The key goes in the URL query, so the IPC briefly holds it before the wire — same compromise as Mendeley/Dropbox during OAuth.",
    keyringService: "gemini",
    keyUrl: "https://aistudio.google.com/apikey",
  },
  {
    id: "ollama",
    name: "Ollama (local)",
    feature: "integrations.ai.ollama",
    hint: "Local models via the Ollama app — auto-detected, nothing to configure. Install from ollama.com, pull a model, and it shows up here.",
  },
];

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
        <For each={AI_PROVIDERS}>
          {(p) => (
            <FeatureGate feature={p.feature}>
              <AiProviderRow provider={p} onActivate={setActive} />
            </FeatureGate>
          )}
        </For>
      </Show>
    </Card>
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
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const removeKey = async () => {
    const service = props.provider.keyringService;
    if (!service) return;
    const { deleteCredential } = await import("~/integrations/auth/credentials");
    await deleteCredential({ service, account: "default" });
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
              class="lift flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12px] text-fg-2 hover:text-fg-1 hover:bg-[var(--color-control-fill)]"
            >
              Get key
              <ExternalLink class="ui-icon-sm" />
            </a>
          </Show>
        </div>
      }
    >
      <Show when={props.provider.keyringService && !hasKey()}>
        <div class="mt-3 flex gap-2">
          <input
            type="password"
            placeholder="API key"
            value={apiKeyInput()}
            onInput={(e) => setApiKeyInput(e.currentTarget.value)}
            class="glass-inset h-8 flex-1 rounded-md px-2.5 font-mono text-[12px] text-fg-1 placeholder:text-fg-3 outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent-1)]"
          />
          <Button variant="primary" size="sm" onClick={saveKey} disabled={busy()}>
            {busy() ? "Testing…" : "Save"}
          </Button>
        </div>
      </Show>
      <Show when={props.provider.keyringService && hasKey()}>
        <div class="mt-3 text-[11px] text-fg-3">
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
            <div class="mt-3 flex flex-col gap-2 text-[12px] text-fg-2">
              <Show when={ollamaProbe() && !ollamaProbe()!.ok}>
                <div class="text-fg-3">
                  Ollama isn't running. Install it from{" "}
                  <span class="mono text-fg-2">ollama.com</span>, pull a model
                  (e.g. <span class="mono text-fg-2">ollama pull gemma3</span>),
                  and it's detected automatically — no setup needed.
                  <button
                    type="button"
                    onClick={() => void refetchOllama()}
                    class="ml-2 text-[var(--color-accent-1)] hover:underline"
                  >
                    Re-check
                  </button>
                </div>
                {/* Only useful when the daemon runs somewhere non-default. */}
                <div class="flex items-center gap-2">
                  <span class="text-fg-3">Custom URL (optional)</span>
                  <input
                    type="text"
                    value={baseUrlInput()}
                    onInput={(e) => setBaseUrlInput(e.currentTarget.value)}
                    onBlur={persistOllamaBaseUrl}
                    placeholder="http://localhost:11434"
                    class="glass-inset h-7 flex-1 rounded-md px-2.5 font-mono text-fg-1 placeholder:text-fg-3 outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent-1)]"
                  />
                </div>
              </Show>
            </div>
          }
        >
          <div class="mt-3 flex items-center gap-2 text-[12px] text-fg-3">
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
            <button
              type="button"
              onClick={() => void refetchOllama()}
              class="ml-auto text-[var(--color-accent-1)] hover:underline"
            >
              Refresh
            </button>
          </div>
        </Show>
      </Show>
      <Show when={error()}>
        <div class="mt-3 text-[11px] text-[var(--color-err)]">{error()}</div>
      </Show>
    </ProviderRow>
  );
};

async function probeProvider(
  id: "anthropic" | "openai" | "gemini" | "ollama",
): Promise<{ ok: true } | { ok: false; message: string }> {
  // Cheap probe per provider: a single auth'd request that fails fast
  // if the key is wrong. Each provider's models endpoint is the lowest
  // surface.
  try {
    switch (id) {
      case "anthropic": {
        const res = await httpRequest({
          method: "GET",
          url: "https://api.anthropic.com/v1/models?limit=1",
          headers: { "anthropic-version": "2023-06-01" },
          authRef: { service: "anthropic", account: "default", header: "x-api-key", prefix: "" },
        });
        return res.status >= 200 && res.status < 300
          ? { ok: true }
          : { ok: false, message: `Anthropic rejected the key (status ${res.status}).` };
      }
      case "openai": {
        const res = await httpRequest({
          method: "GET",
          url: "https://api.openai.com/v1/models",
          authRef: { service: "openai", account: "default", header: "Authorization", prefix: "Bearer " },
        });
        return res.status >= 200 && res.status < 300
          ? { ok: true }
          : { ok: false, message: `OpenAI rejected the key (status ${res.status}).` };
      }
      case "gemini": {
        const res = await httpRequest({
          method: "GET",
          url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
          authRef: { service: "gemini", account: "default", header: "x-goog-api-key", prefix: "" },
        });
        return res.status >= 200 && res.status < 300
          ? { ok: true }
          : { ok: false, message: `Gemini rejected the key (status ${res.status}).` };
      }
      case "ollama":
        return { ok: true };
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// =================================================================
// Grammar card
// =================================================================

const GrammarCard: Component = () => {
  const grammar = () => integrationsSettings().grammar;

  const toggle = (enabled: boolean) => {
    setIntegrationsSettings({
      ...integrationsSettings(),
      grammar: { ...grammar(), enabled },
    });
  };

  return (
    <Card
      title="Grammar"
      subtitle="Local Harper grammar lint. Runs in-process via the Rust crate — zero network, all on-device. Diagnostics surface as squiggles in the editor with one-click apply for suggested replacements."
    >
      <ProviderRow
        name="Harper (American English)"
        hint="Phase 5 ships en-US only. Additional dialects land as Harper's dictionary set grows."
        status={grammar().enabled ? "ready" : "unconfigured"}
        controls={<Switch checked={grammar().enabled} onChange={toggle} />}
      />
    </Card>
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
  ready: "color-mix(in srgb, var(--color-ok) 14%, transparent)",
  unconfigured: "var(--color-control-fill)",
  unreachable: "color-mix(in srgb, var(--color-err) 14%, transparent)",
  checking: "var(--color-control-fill)",
  error: "color-mix(in srgb, var(--color-err) 14%, transparent)",
};

const STATUS_FG: Record<ProviderStatus, string> = {
  ready: "var(--color-ok)",
  unconfigured: "var(--color-fg-3)",
  unreachable: "var(--color-err)",
  checking: "var(--color-fg-3)",
  error: "var(--color-err)",
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
          <span class="text-[13px] font-medium text-fg-1">{props.name}</span>
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
        <div class="mt-0.5 text-[12px] leading-relaxed text-fg-3">{props.hint}</div>
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
      <div class="text-[14px] font-semibold tracking-tight text-fg-1">{props.title}</div>
      <Show when={props.subtitle}>
        <div class="mt-0.5 text-[12px] leading-relaxed text-fg-2">{props.subtitle}</div>
      </Show>
    </div>
    <div>{props.children}</div>
  </div>
);
