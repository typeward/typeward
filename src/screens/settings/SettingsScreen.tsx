import { useNavigate } from "@solidjs/router";
import {
  ArrowLeft,
  Bell,
  Check,
  CheckCircle,
  ChevronDown,
  CreditCard,
  ExternalLink,
  Globe,
  Keyboard,
  Key,
  LogOut,
  Palette,
  Plug,
  Search,
  Shield,
  Sparkles,
  Trash2,
  Type,
  User,
  Users,
} from "lucide-solid";
import type { Component, JSX } from "solid-js";
import { For, Show, createSignal, onMount } from "solid-js";
import { AmbientBackdrop } from "~/components/layout/AmbientBackdrop";
import { TopBar } from "~/components/layout/TopBar";
import { Switch } from "~/components/forms/Switch";
import { IntegrationsPanel } from "./IntegrationsPanel";
import {
  type CompileEngine,
  type EditorSettings,
  compileEngine,
  editorSettings,
  setCompileEngine,
  setEditorSettings,
} from "~/stores/settings-store";
import { previousRoute, setPreviousRoute } from "~/stores/nav-store";
import {
  ACCENTS,
  type Accent,
  THEMES,
  type Theme,
  accent,
  setAccent,
  setTheme,
  theme,
} from "~/themes/theme-store";
import {
  type Density,
  DENSITIES,
  ambientLights,
  animations,
  customThemesEnabled,
  density,
  setAmbientLights,
  setAnimations,
  setCustomThemesEnabled,
  setDensity,
} from "~/stores/ui-store";
import {
  enableSpaces,
  enableTags,
  notificationsPanelDefault,
  setEnableSpaces,
  setEnableTags,
  setNotificationsPanelDefault,
} from "~/stores/workspace-store";
import { isTabletViewport } from "~/stores/viewport-store";

type SectionId =
  | "profile"
  | "account"
  | "notifications"
  | "security"
  | "editor"
  | "appearance"
  | "shortcuts"
  | "language"
  | "team"
  | "integrations"
  | "billing"
  | "usage";

interface NavItem {
  id: SectionId;
  label: string;
  icon: Component<{ size?: number; class?: string }>;
  badge?: string;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV: NavGroup[] = [
  {
    label: "Account",
    items: [
      { id: "profile", label: "Profile", icon: User },
      { id: "account", label: "Account & login", icon: Key },
      { id: "notifications", label: "Notifications", icon: Bell },
      { id: "security", label: "Security", icon: Shield },
    ],
  },
  {
    label: "Workspace",
    items: [
      { id: "editor", label: "Editor", icon: Type },
      { id: "appearance", label: "Appearance", icon: Palette },
      { id: "shortcuts", label: "Keyboard", icon: Keyboard },
      { id: "language", label: "Language & region", icon: Globe },
    ],
  },
  {
    label: "Collaboration",
    items: [
      { id: "team", label: "Team & spaces", icon: Users },
      { id: "integrations", label: "Integrations", icon: Plug },
    ],
  },
  {
    label: "Plan",
    items: [
      { id: "billing", label: "Billing & plan", icon: CreditCard, badge: "Free" },
      { id: "usage", label: "Usage", icon: Sparkles },
    ],
  },
];

const SettingsScreen: Component = () => {
  const navigate = useNavigate();
  const [active, setActive] = createSignal<SectionId>("appearance");

  // Back-button label + target derived from `nav-store.previousRoute`. Falls
  // back to /projects when the user opened Settings via a fresh boot or deep
  // link.
  const backLabel = () => {
    const prev = previousRoute();
    if (prev === "/editor") return "Editor";
    return "Projects";
  };
  const goBack = () => {
    const prev = previousRoute();
    setPreviousRoute(null);
    navigate(prev ?? "/projects");
  };

  return (
    <div class="no-emoji relative h-full w-full overflow-hidden bg-bg-base">
      <AmbientBackdrop />

      <div class="relative z-10 flex h-full flex-col">
        <TopBar
          notifications={0}
          onOpenSettings={() => {
            /* already here */
          }}
        />

        {/* Breadcrumb bar */}
        <div class="flex h-11 flex-shrink-0 items-center gap-2 border-b border-glass-stroke px-3">
          <button
            type="button"
            onClick={goBack}
            class="lift flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-fg-2 hover:bg-[var(--color-control-fill)]"
          >
            <ArrowLeft size={12} style={{ opacity: 0.6 }} />
            <span>{backLabel()}</span>
          </button>
          <span class="text-fg-4">/</span>
          <span class="text-[12px] font-medium text-fg-1">Settings</span>
          <div class="flex-1" />
          <button
            type="button"
            class="lift glass-soft flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[11px] text-fg-2 hover:bg-[var(--color-control-fill)]"
          >
            <ExternalLink size={12} style={{ opacity: 0.7 }} />
            <span>Docs</span>
          </button>
        </div>

        <div class="flex min-h-0 flex-1 gap-2 p-2">
          {/* Sidebar */}
          <div
            class="glass flex flex-col overflow-hidden rounded-xl"
            style={{ width: "236px", height: "100%" }}
          >
            <div class="border-b border-glass-stroke p-3">
              <div class="glass-inset flex h-8 items-center gap-2 rounded-lg px-2.5 text-[12px] text-fg-3">
                <Search size={12} style={{ opacity: 0.6 }} />
                <span>Search settings…</span>
              </div>
            </div>
            <div class="flex-1 space-y-3.5 overflow-auto scroll p-2">
              <For each={NAV}>
                {(g) => (
                  <div>
                    <div class="label-xs mb-1.5 px-2 text-fg-3">{g.label}</div>
                    <For each={g.items}>
                      {(item) => {
                        const isActive = () => active() === item.id;
                        return (
                          <button
                            type="button"
                            onClick={() => setActive(item.id)}
                            class={`lift relative flex w-full items-center gap-2 rounded-md px-2 text-[length:var(--ui-font-base)] ${
                              isActive()
                                ? "side-active bg-[var(--color-selection-bg)] text-fg-1"
                                : "text-fg-2 hover:bg-[var(--color-control-fill)]"
                            }`}
                            style={{ height: "var(--ui-row)" }}
                          >
                            <item.icon class="ui-icon-menu" />
                            <span class={isActive() ? "font-medium" : ""}>
                              {item.label}
                            </span>
                            <Show when={item.badge}>
                              <span class="mono ml-auto rounded-full accent-grad px-1.5 py-0.5 text-[length:var(--ui-font-xs)] font-semibold text-white">
                                {item.badge}
                              </span>
                            </Show>
                          </button>
                        );
                      }}
                    </For>
                  </div>
                )}
              </For>
            </div>
            <div class="border-t border-glass-stroke p-3">
              <button
                type="button"
                class="lift glass-soft flex h-8 w-full items-center justify-center gap-1.5 rounded-md text-[11px] hover:bg-[var(--color-control-fill-hover)]"
                style={{ color: "var(--color-err)" }}
              >
                <LogOut size={12} style={{ opacity: 0.8 }} />
                <span>Sign out</span>
              </button>
            </div>
          </div>

          {/* Main panel */}
          <div class="flex min-w-0 flex-1 flex-col">
            <div class="scroll mx-auto flex w-full max-w-[820px] flex-1 flex-col gap-3 overflow-auto px-2 pb-4">
              <Show when={active() === "appearance"}>
                <AppearancePanel />
              </Show>
              <Show when={active() === "editor"}>
                <EditorPanel />
              </Show>
              <Show when={active() === "notifications"}>
                <NotificationsPanel />
              </Show>
              <Show when={active() === "security"}>
                <SecurityPanel />
              </Show>
              <Show when={active() === "integrations"}>
                <IntegrationsPanel />
              </Show>
              <Show
                when={
                  active() !== "appearance" &&
                  active() !== "editor" &&
                  active() !== "notifications" &&
                  active() !== "security" &&
                  active() !== "integrations"
                }
              >
                <PlaceholderPanel sectionId={active()} />
              </Show>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsScreen;

// =================================================================
// Reusable primitives — close to the design's Card/Row/Toggle/Select
// =================================================================

const Card: Component<{
  title: string;
  subtitle?: string;
  action?: JSX.Element;
  children: JSX.Element;
}> = (props) => (
  <div class="glass overflow-hidden rounded-xl">
    <div class="flex items-start justify-between border-b border-glass-stroke px-5 py-4">
      <div>
        <div class="text-[14px] font-semibold tracking-tight text-fg-1">
          {props.title}
        </div>
        <Show when={props.subtitle}>
          <div class="mt-0.5 text-[12px] leading-relaxed text-fg-2">
            {props.subtitle}
          </div>
        </Show>
      </div>
      {props.action}
    </div>
    <div>{props.children}</div>
  </div>
);

const Row: Component<{
  label: string;
  hint?: string;
  children: JSX.Element;
}> = (props) => (
  <div class="flex items-center gap-4 border-t border-white/[0.04] px-5 py-3.5 first:border-t-0">
    <div class="min-w-0 flex-1">
      <div class="text-[13px] font-medium text-fg-1">{props.label}</div>
      <Show when={props.hint}>
        <div class="mt-0.5 text-[11px] leading-relaxed text-fg-3">{props.hint}</div>
      </Show>
    </div>
    <div class="flex-shrink-0">{props.children}</div>
  </div>
);

const Pill: Component<{
  color: string;
  bg: string;
  children: JSX.Element;
  icon?: JSX.Element;
}> = (props) => (
  <span
    class="mono flex items-center gap-1 rounded-full px-2 py-1 text-[11px]"
    style={{ background: props.bg, color: props.color }}
  >
    {props.icon}
    <span>{props.children}</span>
  </span>
);

// =================================================================
// Appearance — themes + accents + density
// =================================================================

interface ThemeMeta {
  id: Theme;
  name: string;
  vibe: string;
  dark: boolean;
}

const THEME_META: Record<Theme, ThemeMeta> = {
  aurora: {
    id: "aurora",
    name: "Aurora",
    vibe:
      "radial-gradient(circle at 20% 30%, #4C1D95, transparent 60%), radial-gradient(circle at 80% 70%, #155E75, transparent 60%), #0A0B0F",
    dark: true,
  },
  obsidian: { id: "obsidian", name: "Obsidian", vibe: "#0A0B0F", dark: true },
  graphite: { id: "graphite", name: "Graphite", vibe: "#1F2937", dark: true },
  paper: { id: "paper", name: "Paper", vibe: "#FAF9F6", dark: false },
  catppuccin: {
    id: "catppuccin",
    name: "Catppuccin",
    vibe:
      "radial-gradient(circle at 25% 25%, #CBA6F7, transparent 50%), radial-gradient(circle at 75% 75%, #F5C2E7, transparent 50%), #1E1E2E",
    dark: true,
  },
  dracula: {
    id: "dracula",
    name: "Dracula",
    vibe:
      "radial-gradient(circle at 30% 30%, #FF79C6, transparent 55%), radial-gradient(circle at 75% 70%, #8BE9FD, transparent 55%), #282A36",
    dark: true,
  },
  gruvbox: {
    id: "gruvbox",
    name: "Gruvbox",
    vibe:
      "radial-gradient(circle at 25% 30%, #FE8019, transparent 55%), radial-gradient(circle at 75% 70%, #FABD2F, transparent 55%), #282828",
    dark: true,
  },
  mono: { id: "mono", name: "Mono", vibe: "#FAF9F6", dark: false },
  nord: {
    id: "nord",
    name: "Nord",
    vibe:
      "radial-gradient(circle at 30% 30%, #88C0D0, transparent 55%), radial-gradient(circle at 70% 70%, #5E81AC, transparent 55%), #2E3440",
    dark: true,
  },
  "solarized-light": {
    id: "solarized-light",
    name: "Solarized Light",
    vibe:
      "radial-gradient(circle at 30% 30%, #B58900, transparent 55%), radial-gradient(circle at 70% 70%, #268BD2, transparent 55%), #FDF6E3",
    dark: false,
  },
  "tokyo-night": {
    id: "tokyo-night",
    name: "Tokyo Night",
    vibe:
      "radial-gradient(circle at 25% 30%, #7AA2F7, transparent 55%), radial-gradient(circle at 75% 70%, #BB9AF7, transparent 55%), #1A1B26",
    dark: true,
  },
};

interface AccentMeta {
  id: Accent;
  label: string;
  a: string;
  b: string;
}

const ACCENT_META: Record<Accent, AccentMeta> = {
  "violet-cyan": { id: "violet-cyan", label: "Aurora", a: "#8B5CF6", b: "#22D3EE" },
  "amber-rose": { id: "amber-rose", label: "Ember", a: "#F43F5E", b: "#F59E0B" },
  "emerald-teal": { id: "emerald-teal", label: "Tide", a: "#10B981", b: "#14B8A6" },
  "indigo-pink": { id: "indigo-pink", label: "Orchid", a: "#6366F1", b: "#EC4899" },
};

const AppearancePanel: Component = () => {
  return (
    <div class="space-y-3">
      <Card
        title="Theme"
        subtitle="Built-in themes. Disabled while Custom themes are on."
      >
        <div
          class="grid grid-cols-4 gap-3 p-5"
          style={
            customThemesEnabled()
              ? { opacity: "0.4", "pointer-events": "none" }
              : undefined
          }
        >
          <For each={THEMES}>
            {(t) => <ThemeTile meta={THEME_META[t]} active={theme() === t} onClick={() => setTheme(t)} />}
          </For>
        </div>
      </Card>

      <Card
        title="Accent"
        subtitle="The signature gradient on buttons, active items, and highlights."
      >
        <div
          class="flex flex-wrap items-center gap-2 p-5"
          style={
            customThemesEnabled()
              ? { opacity: "0.4", "pointer-events": "none" }
              : undefined
          }
        >
          <For each={ACCENTS}>
            {(a) => {
              const meta = ACCENT_META[a];
              const active = () => accent() === a;
              return (
                <button
                  type="button"
                  onClick={() => setAccent(a)}
                  class="lift relative rounded-lg"
                  style={{
                    padding: "2px",
                    background: active()
                      ? "linear-gradient(135deg,#A78BFA,#67E8F9)"
                      : "transparent",
                  }}
                >
                  <div
                    class="flex items-center gap-2.5 rounded-md px-3 py-2"
                    style={{
                      background: "var(--color-glass-fill)",
                      border: active() ? "none" : "1px solid var(--color-glass-stroke)",
                    }}
                  >
                    <div
                      class="h-6 w-6 rounded-full"
                      style={{
                        background: `linear-gradient(135deg, ${meta.a}, ${meta.b})`,
                        "box-shadow": "inset 0 1px 0 rgba(255,255,255,0.2)",
                      }}
                    />
                    <span class="text-[12px] font-medium text-fg-1">
                      {meta.label}
                    </span>
                    <Show when={active()}>
                      <Check
                        size={10}
                        stroke-width={3}
                        style={{ color: "var(--color-accent-1)" }}
                      />
                    </Show>
                  </div>
                </button>
              );
            }}
          </For>
        </div>
      </Card>

      <Card
        title="Custom themes"
        subtitle="Drop JSON files into the themes folder and they show up here. See /design/themes.md for the schema."
      >
        <Row
          label="Enable custom themes"
          hint="When on, built-in theme + accent pickers are disabled and your custom themes take over."
        >
          <Switch
            checked={customThemesEnabled()}
            onChange={setCustomThemesEnabled}
          />
        </Row>
        <Show when={customThemesEnabled()}>
          <div class="px-5 pb-5">
            <div class="glass-inset rounded-md p-3 text-[length:var(--ui-font-sm)] text-fg-3">
              No custom themes discovered yet. The JSON-file watcher lands in a
              follow-up slice — once it does, themes from{" "}
              <span class="mono text-fg-2">&lt;app_data&gt;/typeward/themes/</span>{" "}
              show up below.
            </div>
          </div>
        </Show>
      </Card>

      <Card title="Density & motion">
        <Row label="UI density" hint="Affects padding and row heights across the app.">
          <div class="glass-inset flex items-center gap-1 rounded-md p-0.5">
            <For each={DENSITIES}>
              {(d) => {
                const active = () => density() === d;
                return (
                  <button
                    type="button"
                    onClick={() => setDensity(d as Density)}
                    class={`h-7 rounded px-3 text-[11px] capitalize ${
                      active()
                        ? "accent-grad font-semibold text-white"
                        : "text-fg-2 hover:bg-[var(--color-control-fill)]"
                    }`}
                  >
                    {d}
                  </button>
                );
              }}
            </For>
          </div>
        </Row>
        <Row
          label="Animations"
          hint="Toggles transitions, easings, and ambient motion across the app."
        >
          <Switch checked={animations()} onChange={setAnimations} />
        </Row>
        <Row
          label="Ambient lights"
          hint="Soft radial blobs behind the glass surfaces. Disable for a flat, distraction-free backdrop."
        >
          <Switch checked={ambientLights()} onChange={setAmbientLights} />
        </Row>
      </Card>

      <Card title="Workspace">
        <Row
          label="Enable Spaces"
          hint="Group projects into spaces in the Projects sidebar."
        >
          <Switch checked={enableSpaces()} onChange={setEnableSpaces} />
        </Row>
        <Row
          label="Enable Tags"
          hint="Surface tag list in the Projects sidebar."
        >
          <Switch checked={enableTags()} onChange={setEnableTags} />
        </Row>
        <Row
          label="Notifications panel default"
          hint="Show the right-side notifications drawer on every projects-screen visit."
        >
          <Switch
            checked={notificationsPanelDefault()}
            onChange={setNotificationsPanelDefault}
          />
        </Row>
      </Card>
    </div>
  );
};

const ThemeTile: Component<{
  meta: ThemeMeta;
  active: boolean;
  onClick: () => void;
}> = (props) => (
  <button
    type="button"
    onClick={props.onClick}
    class={"lift relative overflow-hidden rounded-xl"}
    style={{
      height: "104px",
      border: props.active ? "none" : "1px solid var(--color-glass-stroke)",
      "box-shadow": props.active
        ? "0 0 0 1.5px var(--color-accent-1), 0 6px 18px rgba(139,92,246,0.22)"
        : undefined,
    }}
  >
    <div class="absolute inset-0" style={{ background: props.meta.vibe }} />
    <div
      class="absolute inset-2 flex flex-col gap-1 rounded-md p-2"
      style={{
        background: props.meta.dark ? "rgba(10,11,15,0.55)" : "rgba(255,255,255,0.92)",
        "backdrop-filter": "blur(6px)",
      }}
    >
      <div
        class="h-1 rounded-full"
        style={{
          width: "33%",
          background: props.meta.dark ? "rgba(255,255,255,0.5)" : "rgba(0,0,0,0.4)",
        }}
      />
      <div
        class="h-1 rounded-full"
        style={{
          width: "66%",
          background: props.meta.dark ? "rgba(255,255,255,0.25)" : "rgba(0,0,0,0.2)",
        }}
      />
      <div
        class="h-1 rounded-full"
        style={{
          width: "50%",
          background: props.meta.dark ? "rgba(255,255,255,0.25)" : "rgba(0,0,0,0.2)",
        }}
      />
    </div>
    <div class="absolute bottom-1.5 left-2 right-2 flex items-center justify-between">
      <span
        class="text-[11px] font-semibold"
        style={{
          color: props.meta.dark ? "#E6E8EC" : "#1F2937",
          "text-shadow": props.meta.dark ? "0 1px 2px rgba(0,0,0,0.6)" : "none",
        }}
      >
        {props.meta.name}
      </span>
      <Show when={props.active}>
        <div class="flex h-4 w-4 items-center justify-center rounded-full accent-grad">
          <Check size={10} stroke-width={3} />
        </div>
      </Show>
    </div>
  </button>
);

// =================================================================
// Editor panel — fully wired to settings-store
// =================================================================

const ENGINE_LABEL: Record<CompileEngine, string> = {
  "system-tex": "System TeX",
  tectonic: "Tectonic",
  busytex: "busytex (WASM)",
};

const EditorPanel: Component = () => {
  const update = <K extends keyof EditorSettings>(key: K, value: EditorSettings[K]) => {
    setEditorSettings({ ...editorSettings(), [key]: value });
  };

  const [busytexAssetsState, setBusytexAssetsState] = createSignal<
    "unknown" | "installed" | "missing"
  >("unknown");

  onMount(() => {
    // HEAD-probe the busytex pipeline asset so the UI can tell users
    // whether they still need to run `npx texlyre-busytex download-assets`.
    void (async () => {
      try {
        const probe = await fetch("/core/busytex/busytex_pipeline.js", {
          method: "HEAD",
        });
        setBusytexAssetsState(probe.ok ? "installed" : "missing");
      } catch {
        setBusytexAssetsState("missing");
      }
    })();
  });

  return (
    <div class="space-y-3">
      <Card
        title="Compilation"
        subtitle="How your project compiles to PDF when you write."
      >
        <Show
          when={!isTabletViewport()}
          fallback={
            <Row
              label="Engine"
              hint="Tablet builds run TeX Live 2026 in a Web Worker via busytex — the only engine available without a native install."
            >
              <span class="mono text-[length:var(--ui-font-sm)] text-fg-1">
                busytex (WASM)
              </span>
            </Row>
          }
        >
          <Row
            label="Default engine"
            hint="System TeX uses your local install; Tectonic is a self-contained Rust binary. busytex is desktop-disabled (it's the tablet fallback)."
          >
            <SelectStub
              value={ENGINE_LABEL[compileEngine()]}
              options={[
                { value: "system-tex" as CompileEngine, label: "System TeX" },
                { value: "tectonic" as CompileEngine, label: "Tectonic" },
              ]}
              onChange={(v) => setCompileEngine(v as CompileEngine)}
            />
          </Row>
        </Show>
        <Show when={isTabletViewport() && compileEngine() === "busytex"}>
          <Row
            label="busytex assets"
            hint="One-time ~120MB download of WASM + TeX Live data. Lives under public/core/busytex/."
          >
            <BusytexAssetsBadge state={busytexAssetsState()} />
          </Row>
        </Show>
        <Row
          label="Auto-compile on save"
          hint="Recompile within 200ms of typing pause."
        >
          <Switch
            checked={editorSettings().autoCompile}
            onChange={(v) => update("autoCompile", v)}
          />
        </Row>
        <Row
          label="Stop on first error"
          hint="Halt the build at the first \\error rather than continuing."
        >
          <Switch checked={false} onChange={() => {}} />
        </Row>
      </Card>

      <Card title="Editing" subtitle="Behaviour of the source pane.">
        <Row label="Font size">
          <SelectStub
            value={`${editorSettings().fontSize} px`}
            options={[10, 11, 12, 13, 14, 15, 16, 18, 20].map((n) => ({
              value: n,
              label: `${n} px`,
            }))}
            onChange={(v) => update("fontSize", Number(v))}
          />
        </Row>
        <Row label="Soft wrap long lines">
          <Switch
            checked={editorSettings().lineWrap}
            onChange={(v) => update("lineWrap", v)}
          />
        </Row>
        <Row label="Vim mode">
          <Switch
            checked={editorSettings().vimMode}
            onChange={(v) => update("vimMode", v)}
          />
        </Row>
        <Row
          label="Spell-check"
          hint="Grammar & LaTeX-aware. Uses your interface language."
        >
          <Switch
            checked={editorSettings().spellCheck}
            onChange={(v) => update("spellCheck", v)}
          />
        </Row>
      </Card>
    </div>
  );
};

const BusytexAssetsBadge: Component<{
  state: "unknown" | "installed" | "missing";
}> = (props) => (
  <Show
    when={props.state !== "unknown"}
    fallback={
      <span class="mono rounded-full px-2.5 py-1 text-[11px] text-fg-3" style={{ background: "var(--color-control-fill)" }}>
        Checking…
      </span>
    }
  >
    <Show
      when={props.state === "installed"}
      fallback={
        <div class="flex flex-col items-end gap-1">
          <Pill
            color="#FDE68A"
            bg="rgba(245,158,11,0.12)"
            icon={<CheckCircle size={11} />}
          >
            Not installed
          </Pill>
          <code class="mono rounded px-2 py-1 text-[11px] text-fg-2" style={{ background: "var(--color-control-fill)" }}>
            npx texlyre-busytex download-assets ./public/core
          </code>
        </div>
      }
    >
      <Pill
        color="#A7F3D0"
        bg="rgba(16,185,129,0.12)"
        icon={<CheckCircle size={11} />}
      >
        Installed
      </Pill>
    </Show>
  </Show>
);

const SelectStub: Component<{
  value: string;
  options: Array<{ value: string | number; label: string }>;
  onChange: (v: string | number) => void;
}> = (props) => {
  const [open, setOpen] = createSignal(false);
  return (
    <div class="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        class="glass-inset flex h-8 w-[180px] items-center gap-2 rounded-md px-2.5 text-[12px] text-fg-1 hover:bg-[var(--color-control-fill)]"
      >
        <span class="flex-1 text-left">{props.value}</span>
        <ChevronDown size={10} style={{ opacity: 0.5 }} />
      </button>
      <Show when={open()}>
        <div
          class="glass absolute right-0 z-20 mt-1 w-[180px] overflow-hidden rounded-md py-1"
          style={{ background: "rgba(15,17,22,0.96)" }}
          onClick={(e) => e.stopPropagation()}
        >
          <For each={props.options}>
            {(o) => (
              <button
                type="button"
                onClick={() => {
                  props.onChange(o.value);
                  setOpen(false);
                }}
                class="flex w-full items-center px-3 py-1.5 text-left text-[12px] text-fg-1 hover:bg-[var(--color-control-fill)]"
              >
                {o.label}
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};

// =================================================================
// Notifications panel — grid layout from design
// =================================================================

const NotificationsPanel: Component = () => {
  const prefs = [
    { label: "@ mentions", hint: "Someone names you in a comment or review.", inApp: true, email: true, push: true },
    { label: "Comment replies", hint: "Replies to threads you participate in.", inApp: true, email: true, push: false },
    { label: "Review requested", hint: "A collaborator asks you to read a draft.", inApp: true, email: true, push: true },
    { label: "Compile failures", hint: "Background compile fails on a project you own.", inApp: true, email: false, push: false },
    { label: "Project shared with you", hint: "", inApp: true, email: true, push: false },
    { label: "Weekly writing summary", hint: "Sent every Sunday with stats and goals.", inApp: false, email: true, push: false },
  ];
  return (
    <div class="space-y-3">
      <Card
        title="Notifications"
        subtitle="Pick where each event reaches you. Quiet hours pause email and push."
      >
        <div
          class="label-xs grid items-center gap-4 px-5 pb-2 pt-3 uppercase tracking-wider text-fg-3"
          style={{ "grid-template-columns": "1fr 64px 64px 64px" }}
        >
          <div />
          <div class="text-center">In-app</div>
          <div class="text-center">Email</div>
          <div class="text-center">Push</div>
        </div>
        <For each={prefs}>
          {(p) => (
            <div
              class="grid items-center gap-4 border-t border-white/[0.04] px-5 py-3"
              style={{ "grid-template-columns": "1fr 64px 64px 64px" }}
            >
              <div>
                <div class="text-[13px] font-medium text-fg-1">{p.label}</div>
                <Show when={p.hint}>
                  <div class="mt-0.5 text-[11px] text-fg-3">{p.hint}</div>
                </Show>
              </div>
              <div class="flex justify-center">
                <Switch checked={p.inApp} onChange={() => {}} />
              </div>
              <div class="flex justify-center">
                <Switch checked={p.email} onChange={() => {}} />
              </div>
              <div class="flex justify-center">
                <Switch checked={p.push} onChange={() => {}} />
              </div>
            </div>
          )}
        </For>
      </Card>
      <Card
        title="Quiet hours"
        subtitle="Pause email and push outside writing time. In-app stays on."
      >
        <Row label="Quiet hours">
          <Switch checked={true} onChange={() => {}} />
        </Row>
        <Row label="From">
          <SelectStub
            value="22:00"
            options={[{ value: "22:00", label: "22:00" }]}
            onChange={() => {}}
          />
        </Row>
        <Row label="To">
          <SelectStub
            value="08:30"
            options={[{ value: "08:30", label: "08:30" }]}
            onChange={() => {}}
          />
        </Row>
      </Card>
    </div>
  );
};

// =================================================================
// Security panel
// =================================================================

const SecurityPanel: Component = () => {
  return (
    <div class="space-y-3">
      <Card
        title="Two-factor authentication"
        subtitle="Add a second factor to protect your account."
        action={
          <Pill
            bg="rgba(16,185,129,0.10)"
            color="#A7F3D0"
            icon={<CheckCircle size={12} />}
          >
            Cloud sync coming
          </Pill>
        }
      >
        <Row label="Authenticator app" hint="Configured once cloud auth lands.">
          <button
            type="button"
            class="lift glass-soft h-8 rounded-md px-3 text-[12px] text-fg-2 hover:bg-[var(--color-control-fill-hover)]"
            disabled
          >
            Reconfigure
          </button>
        </Row>
        <Row label="Recovery codes" hint="One-time codes printed when 2FA is set up.">
          <button
            type="button"
            class="lift glass-soft h-8 rounded-md px-3 text-[12px] text-fg-2 hover:bg-[var(--color-control-fill-hover)]"
            disabled
          >
            View codes
          </button>
        </Row>
      </Card>

      <Card title="Danger zone">
        <div class="flex items-center gap-4 px-5 py-4">
          <div
            class="flex h-9 w-9 items-center justify-center rounded-md"
            style={{ background: "rgba(244,63,94,0.10)" }}
          >
            <Trash2 size={14} style={{ color: "#FCA5A5" }} />
          </div>
          <div class="flex-1">
            <div class="text-[13px] font-medium" style={{ color: "#FECACA" }}>
              Reset local app data
            </div>
            <div class="mt-0.5 text-[11px] text-fg-2">
              Clears settings, theme prefs, and project list. Files on disk are
              untouched.
            </div>
          </div>
          <button
            type="button"
            class="lift h-8 rounded-md px-3 text-[12px] font-medium"
            style={{
              background: "rgba(244,63,94,0.12)",
              color: "#FCA5A5",
              border: "1px solid rgba(244,63,94,0.25)",
            }}
          >
            Reset
          </button>
        </div>
      </Card>
    </div>
  );
};

// =================================================================
// Placeholder for unimplemented sections
// =================================================================

const PlaceholderPanel: Component<{ sectionId: SectionId }> = (props) => {
  const flat = NAV.flatMap((g) => g.items);
  const item = () => flat.find((i) => i.id === props.sectionId)!;
  const Icon = () => {
    const IconComponent = item().icon;
    return <IconComponent size={20} />;
  };
  return (
    <Card
      title={item().label}
      subtitle="This pane lights up alongside Typeward's cloud sync layer (Phase 4)."
    >
      <div class="flex flex-col items-center gap-3 px-5 py-10 text-center">
        <div
          class="flex h-12 w-12 items-center justify-center rounded-xl"
          style={{ background: "rgba(139,92,246,0.10)" }}
        >
          <Icon />
        </div>
        <p class="max-w-[440px] text-[13px] leading-relaxed text-fg-3">
          Typeward is local-first for Phase 1. {item().label.toLowerCase()} settings
          arrive once accounts and cloud sync land.
        </p>
      </div>
    </Card>
  );
};
