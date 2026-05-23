/**
 * Integrations settings panel.
 *
 * Phase 1 ships the References card only — Cloud / Git / AI / Grammar /
 * Templates cards land alongside their respective phases. The shape of
 * this file is set up to host them all in one panel rather than
 * sub-routing, so users can scroll one page to see what's wired up.
 */

import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  Check,
  ExternalLink,
  FileText,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-solid";
import type { Component, JSX } from "solid-js";
import { Show, createResource, createSignal, For } from "solid-js";

import { Button } from "~/components/primitives/Button";
import { Switch } from "~/components/forms/Switch";
import {
  deleteCredential,
  setCredential,
} from "~/integrations/auth/credentials";
import { httpRequest } from "~/integrations/http";
import {
  connectMendeley,
  disconnectMendeley,
} from "~/integrations/references/mendeley";
import { probeBetterBibTex } from "~/integrations/references/zotero";
import {
  connectGithub,
  disconnectGithub,
  hasGithubCredential,
} from "~/integrations/vcs/github";
import {
  connectDropbox,
  disconnectDropbox,
} from "~/integrations/cloud/dropbox";
import {
  connectOneDrive,
  disconnectOneDrive,
} from "~/integrations/cloud/onedrive";
import {
  connectGoogleDrive,
  disconnectGoogleDrive,
} from "~/integrations/cloud/gdrive";
import { detectICloudDrive } from "~/integrations/cloud/icloud";
import { integrationsSettings, setIntegrationsSettings } from "~/stores/settings-store";

export const IntegrationsPanel: Component = () => {
  return (
    <div class="flex flex-col gap-3">
      <ReferencesCard />
      <CloudStorageCard />
      <VcsCard />
      <AiCard />
      <GrammarCard />
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
      <ZoteroWebRow />
      <MendeleyRow />
      <JabRefRow />
    </Card>
  );
};

const BetterBibTexRow: Component = () => {
  const [probe] = createResource(async () => probeBetterBibTex());
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

  const setLibraryId = (value: string) => {
    const id = Number.parseInt(value, 10);
    if (!Number.isFinite(id) || id < 1) return;
    setIntegrationsSettings({
      ...integrationsSettings(),
      references: {
        ...integrationsSettings().references,
        betterBibTex: { ...settings(), libraryId: id },
      },
    });
  };

  return (
    <ProviderRow
      name="Zotero (Better BibTeX)"
      hint="Local-only HTTP via the Better BibTeX Zotero plugin. No login needed; Zotero just has to be running with the plugin installed."
      status={probe() === undefined ? "checking" : probe() ? "ready" : "unreachable"}
      controls={
        <Switch
          checked={settings().enabled}
          onChange={(checked) => toggle(checked)}
          disabled={!probe()}
        />
      }
    >
      <Show when={settings().enabled && probe()}>
        <div class="mt-3 flex items-center gap-2 text-[12px] text-fg-2">
          <span>Library id</span>
          <input
            type="number"
            min={1}
            value={settings().libraryId}
            onInput={(e) => setLibraryId(e.currentTarget.value)}
            class="glass-inset h-7 w-20 rounded-md px-2 font-mono text-fg-1 outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent-1)]"
          />
          <span class="text-fg-3">1 = personal library; group libraries use higher ids.</span>
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
          : "Mendeley Desktop was discontinued in 2022 and the API is in maintenance mode. Use Zotero or JabRef for new workflows; this exists for migration."
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

const JabRefRow: Component = () => {
  const settings = () => integrationsSettings().references.jabref;

  const addPath = async () => {
    const picked = await openFileDialog({
      title: "Pick a .bib file",
      filters: [{ name: "BibTeX", extensions: ["bib"] }],
      multiple: false,
    });
    if (!picked || typeof picked !== "string") return;
    if (settings().paths.includes(picked)) return;

    setIntegrationsSettings({
      ...integrationsSettings(),
      references: {
        ...integrationsSettings().references,
        jabref: { paths: [...settings().paths, picked] },
      },
    });
  };

  const removePath = (path: string) => {
    setIntegrationsSettings({
      ...integrationsSettings(),
      references: {
        ...integrationsSettings().references,
        jabref: { paths: settings().paths.filter((p) => p !== path) },
      },
    });
  };

  return (
    <ProviderRow
      name="JabRef (.bib files)"
      hint="Add one or more .bib files. They're read locally and merged into the project library on refresh — works without any external service."
      status={settings().paths.length > 0 ? "ready" : "unconfigured"}
      controls={
        <Button variant="ghost" size="sm" onClick={addPath} leadingIcon={<Plus class="ui-icon-sm" />}>
          Add file
        </Button>
      }
    >
      <Show when={settings().paths.length > 0}>
        <div class="mt-3 flex flex-col gap-1">
          <For each={settings().paths}>
            {(path) => (
              <div class="glass-inset flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px]">
                <FileText class="ui-icon-sm text-fg-3" />
                <span class="truncate font-mono text-fg-1">{path}</span>
                <button
                  type="button"
                  onClick={() => removePath(path)}
                  class="ml-auto text-fg-3 hover:text-[var(--color-err)]"
                  aria-label={`Remove ${path}`}
                >
                  <Trash2 class="ui-icon-sm" />
                </button>
              </div>
            )}
          </For>
        </div>
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
    hint: "Hybrid sync — your project lives in a local cache that polls Dropbox via longpoll cursor. Conflicts surface as `.conflict-*` files.",
    connect: connectDropbox,
    disconnect: disconnectDropbox,
  },
  {
    id: "onedrive" as const,
    name: "OneDrive",
    hint: "Microsoft Graph with delta polling every 60s. `Files.ReadWrite` + `offline_access` scopes — broad enough to open any folder, narrow enough to keep tokens minimal.",
    connect: connectOneDrive,
    disconnect: disconnectOneDrive,
  },
  {
    id: "gdrive" as const,
    name: "Google Drive",
    hint: "`drive.file` scope — Typeward only sees files it created or you opened with it. Picking an arbitrary existing folder isn't possible under this scope; create a new project to start.",
    connect: connectGoogleDrive,
    disconnect: disconnectGoogleDrive,
  },
];

const CloudStorageCard: Component = () => {
  return (
    <Card
      title="Cloud storage"
      subtitle="Open a project from your cloud root. Files stay local-first; the engine polls for remote changes and pushes on autosave. iCloud Drive uses the OS sync on macOS — no API call needed."
    >
      <For each={CLOUD_PROVIDERS}>
        {(provider) => <CloudProviderRow provider={provider} />}
      </For>
      <ICloudRow />
    </Card>
  );
};

interface CloudProviderConfig {
  id: "dropbox" | "onedrive" | "gdrive";
  name: string;
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

const ICloudRow: Component = () => {
  const [info] = createResource(detectICloudDrive);

  const status = (): ProviderStatus => {
    const v = info();
    if (!v) return "checking";
    return v.available ? "ready" : "unreachable";
  };

  return (
    <ProviderRow
      name="iCloud Drive"
      hint={
        info()?.available
          ? "Available — open or save a project inside ~/Library/Mobile Documents/com~apple~CloudDocs and macOS keeps it in sync."
          : (info()?.reason ?? "Apple platforms only.")
      }
      status={status()}
      controls={
        <span class="text-[11px] text-fg-3 italic">No sign-in needed</span>
      }
    />
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
    hint: "Paste a key from console.anthropic.com → API Keys. Streaming via the Messages API; the key never leaves the keyring.",
    keyringService: "anthropic",
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "openai",
    name: "ChatGPT (OpenAI)",
    hint: "Paste a key from platform.openai.com → API keys. Chat Completions endpoint with bearer auth.",
    keyringService: "openai",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "gemini",
    name: "Gemini (Google)",
    hint: "Paste an API key from aistudio.google.com. The key goes in the URL query, so the IPC briefly holds it before the wire — same compromise as Mendeley/Dropbox during OAuth.",
    keyringService: "gemini",
    keyUrl: "https://aistudio.google.com/apikey",
  },
  {
    id: "ollama",
    name: "Ollama (local)",
    hint: "Runs against a local `ollama serve` daemon. No key — just point at the right base URL if you've moved it off the default port.",
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

  return (
    <Card
      title="AI providers"
      subtitle="Claude, ChatGPT, Gemini, and a local Ollama daemon. Pick one as the active provider; the editor's AI panel routes through it."
    >
      <For each={AI_PROVIDERS}>{(p) => <AiProviderRow provider={p} onActivate={setActive} />}</For>
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
      const { getCredential } = await import("~/integrations/auth/credentials");
      return (await getCredential({ service, account: "default" })) !== null;
    },
  );

  const isActive = () => ai().activeProvider === props.provider.id;

  const status = (): ProviderStatus => {
    if (props.provider.id === "ollama") return "ready";
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
              onClick={() => props.onActivate(isActive() ? undefined : props.provider.id)}
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
        <div class="mt-3 flex items-center gap-2 text-[12px] text-fg-2">
          <span>Base URL</span>
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
        const { getCredential } = await import("~/integrations/auth/credentials");
        const key = await getCredential({ service: "gemini", account: "default" });
        if (!key) return { ok: false, message: "Key not stored." };
        const res = await httpRequest({
          method: "GET",
          url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=1`,
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
  ready: "rgba(34, 197, 94, 0.16)",
  unconfigured: "var(--color-control-fill)",
  unreachable: "rgba(248, 113, 113, 0.16)",
  checking: "var(--color-control-fill)",
  error: "rgba(248, 113, 113, 0.16)",
};

const STATUS_FG: Record<ProviderStatus, string> = {
  ready: "rgb(74, 222, 128)",
  unconfigured: "var(--color-fg-3)",
  unreachable: "rgb(248, 113, 113)",
  checking: "var(--color-fg-3)",
  error: "rgb(248, 113, 113)",
};

const ProviderRow: Component<{
  name: string;
  hint: string;
  status: ProviderStatus;
  controls: JSX.Element;
  children?: JSX.Element;
}> = (props) => (
  <div class="border-t border-white/[0.04] px-5 py-4 first:border-t-0">
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

