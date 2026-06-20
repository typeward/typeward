import { useNavigate } from "@solidjs/router";
import {
  ArrowLeft,
  Bell,
  BookMarked,
  Check,
  ChevronDown,
  Cloud,
  GitBranch,
  Keyboard,
  Key,
  LogOut,
  Palette,
  Shield,
  Sparkles,
  SpellCheck,
  Trash2,
  Type,
} from "lucide-solid";
import type { Component, JSX } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { AmbientBackdrop } from "~/components/layout/AmbientBackdrop";
import { TopBar } from "~/components/layout/TopBar";
import { Switch } from "~/components/forms/Switch";
import { KbdHint } from "~/components/primitives/KbdHint";
import { commands } from "~/commands/registry";
import * as ipc from "~/ipc";
import { installDismiss } from "~/lib/dismiss";
import { currentTier } from "~/integrations/entitlements";
import { signOut, supabaseUser } from "~/integrations/supabase/session";
import { AccountSection } from "./AccountSection";
import { IntegrationsPanel } from "./IntegrationsPanel";
import {
  type CompileEngine,
  type EditorSettings,
  compileEngine,
  editorSettings,
  integrationsSettings,
  setCompileEngine,
  setEditorSettings,
  setIntegrationsSettings,
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
  activeCustomTheme,
  ambientLights,
  animations,
  customThemesEnabled,
  density,
  setActiveCustomTheme,
  setAmbientLights,
  setAnimations,
  setCustomThemesEnabled,
  setDensity,
} from "~/stores/ui-store";
import {
  customThemeWarnings,
  customThemes,
  reloadCustomThemes,
} from "~/themes/custom-themes";
import {
  enableSpaces,
  enableTags,
  notificationsPanelDefault,
  projectCardWords,
  setEnableSpaces,
  setEnableTags,
  setNotificationsPanelDefault,
  setProjectCardWords,
} from "~/stores/workspace-store";
import { isTauriMobile } from "~/lib/platform";

type SectionId =
  | "account"
  | "notifications"
  | "security"
  | "editor"
  | "appearance"
  | "shortcuts"
  | "int-references"
  | "int-cloud"
  | "int-vcs"
  | "int-ai"
  | "int-grammar";

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

// Placeholder sections (Profile, Team, Language, Billing, Usage) were
// removed from the nav entirely — they come back when their features do.
const NAV: NavGroup[] = [
  {
    label: "Account",
    items: [
      { id: "account", label: "Account & plan", icon: Key },
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
    ],
  },
  {
    label: "Integrations",
    items: [
      { id: "int-references", label: "References", icon: BookMarked },
      { id: "int-cloud", label: "Cloud storage", icon: Cloud },
      { id: "int-vcs", label: "Git & GitHub", icon: GitBranch },
      { id: "int-ai", label: "AI providers", icon: Sparkles },
      { id: "int-grammar", label: "Grammar", icon: SpellCheck },
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
    if (prev?.startsWith("/editor")) return "Editor";
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
        </div>

        <div class="flex min-h-0 flex-1 gap-2 p-2">
          {/* Sidebar */}
          <div
            class="glass flex flex-col overflow-hidden rounded-xl"
            style={{ width: "236px", height: "100%" }}
          >
            <div class="flex-1 space-y-3.5 overflow-auto scroll p-2 pt-3">
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
                              <span class="mono ml-auto rounded-full accent-grad px-1.5 py-0.5 text-[length:var(--ui-font-xs)] font-semibold">
                                {item.badge}
                              </span>
                            </Show>
                            <Show when={item.id === "account"}>
                              <span class="mono ml-auto rounded-full accent-grad px-1.5 py-0.5 text-[length:var(--ui-font-xs)] font-semibold capitalize">
                                {currentTier()}
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
            <Show when={supabaseUser()}>
              <div class="border-t border-glass-stroke p-3">
                <button
                  type="button"
                  onClick={() => void signOut()}
                  class="lift glass-soft flex h-8 w-full items-center justify-center gap-1.5 rounded-md text-[11px] hover:bg-[var(--color-control-fill-hover)]"
                  style={{ color: "var(--color-err)" }}
                >
                  <LogOut size={12} style={{ opacity: 0.8 }} />
                  <span>Sign out</span>
                </button>
              </div>
            </Show>
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
              <Show when={active() === "int-references"}>
                <IntegrationsPanel section="references" />
              </Show>
              <Show when={active() === "int-cloud"}>
                <IntegrationsPanel section="cloud" />
              </Show>
              <Show when={active() === "int-vcs"}>
                <IntegrationsPanel section="vcs" />
              </Show>
              <Show when={active() === "int-ai"}>
                <IntegrationsPanel section="ai" />
              </Show>
              <Show when={active() === "int-grammar"}>
                <IntegrationsPanel section="grammar" />
              </Show>
              <Show when={active() === "account"}>
                <AccountSection />
              </Show>
              <Show when={active() === "shortcuts"}>
                <ShortcutsPanel />
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
  <div class="flex items-center gap-4 border-t border-glass-stroke px-5 py-3.5 first:border-t-0">
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

/** House pattern for visible-but-unbuilt controls (matches ExportMenu). */
const SoonPill: Component = () => (
  <span
    class="mono rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-wider"
    style={{ background: "var(--color-control-fill)", color: "var(--color-fg-3)" }}
  >
    soon
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
  daylight: {
    id: "daylight",
    name: "Daylight",
    vibe:
      "radial-gradient(circle at 75% 20%, #F0E7CF, transparent 60%), radial-gradient(circle at 25% 80%, #ECDFC2, transparent 60%), #F8F4EA",
    dark: false,
  },
  lamplight: {
    id: "lamplight",
    name: "Lamplight",
    vibe:
      "radial-gradient(circle at 75% 15%, #C2691E, transparent 55%), radial-gradient(circle at 60% 45%, rgba(232,163,77,0.45), transparent 60%), #0D0C0A",
    dark: true,
  },
  aurora: {
    id: "aurora",
    name: "Aurora",
    vibe:
      "radial-gradient(circle at 20% 30%, #4C1D95, transparent 60%), radial-gradient(circle at 80% 70%, #155E75, transparent 60%), #0A0B0F",
    dark: true,
  },
  paper: { id: "paper", name: "Paper", vibe: "#FAF9F6", dark: false },
};

interface AccentMeta {
  id: Accent;
  label: string;
  a: string;
  b: string;
}

// Each theme's native accent pair — used to preview the "Theme default"
// accent chip. Live var(--color-accent-*) would mirror whatever accent is
// currently active instead of what reverting restores. Keep in sync with
// the theme CSS files.
const THEME_NATIVE_ACCENT: Record<Theme, [string, string]> = {
  daylight: ["#101210", "#3A352B"],
  lamplight: ["#E8A34D", "#C2691E"],
  aurora: ["#8E61F6", "#22D3EE"],
  paper: ["#7C3AED", "#07809D"],
};

const ACCENT_META: Record<Accent, AccentMeta> = {
  // "violet-cyan" is the stored id for "no data-accent" — i.e. the active
  // theme's native accent. Its swatch resolves through THEME_NATIVE_ACCENT
  // at render time.
  "violet-cyan": { id: "violet-cyan", label: "Theme default", a: "", b: "" },
  "amber-rose": { id: "amber-rose", label: "Ember", a: "#F43F5E", b: "#F59E0B" },
  "emerald-teal": { id: "emerald-teal", label: "Tide", a: "#10B981", b: "#14B8A6" },
  "indigo-pink": { id: "indigo-pink", label: "Orchid", a: "#6C6FF2", b: "#EC4899" },
};

// A custom theme only takes over once the switch is on AND a theme is
// picked — until then the built-in pickers keep working.
const customThemeActive = (): boolean =>
  customThemesEnabled() &&
  Boolean(activeCustomTheme()) &&
  customThemes().some((t) => t.id === activeCustomTheme());

const AppearancePanel: Component = () => {
  return (
    <div class="space-y-3">
      <Card
        title="Theme"
        subtitle="Built-in themes. Disabled while a custom theme is active."
      >
        <div
          class="grid grid-cols-4 gap-3 p-5"
          style={
            customThemeActive()
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
            customThemeActive()
              ? { opacity: "0.4", "pointer-events": "none" }
              : undefined
          }
        >
          <For each={ACCENTS}>
            {(a) => {
              const meta = ACCENT_META[a];
              const active = () => accent() === a;
              const stops = (): [string, string] =>
                meta.a ? [meta.a, meta.b] : THEME_NATIVE_ACCENT[theme()];
              return (
                <button
                  type="button"
                  onClick={() => setAccent(a)}
                  class="lift relative rounded-lg"
                  style={{
                    padding: "2px",
                    background: active()
                      ? "linear-gradient(135deg,var(--color-accent-1),var(--color-accent-2))"
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
                        background: `linear-gradient(135deg, ${stops()[0]}, ${stops()[1]})`,
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

      <CustomThemesCard />

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
                        ? "accent-grad font-semibold"
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
          hint="Preview with sample data — real spaces aren't built yet."
        >
          <Switch checked={enableSpaces()} onChange={setEnableSpaces} />
        </Row>
        <Row
          label="Enable Tags"
          hint="Preview with sample data — real tags aren't built yet."
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
        <Row
          label="Word count on project cards"
          hint="Show an approximate word count on each card. Reads each project's root file when the library loads."
        >
          <Switch
            checked={projectCardWords()}
            onChange={setProjectCardWords}
          />
        </Row>
      </Card>
    </div>
  );
};

/**
 * User-authored JSON themes from `<app_data>/themes/`. The card is the whole
 * authoring loop: create the sample, open the folder, edit, reload — the
 * active theme re-skins live without restarting.
 */
const CustomThemesCard: Component = () => {
  const [busy, setBusy] = createSignal(false);
  const [note, setNote] = createSignal<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      setNote(String(e));
    } finally {
      setBusy(false);
    }
  };

  const createSample = () =>
    run(async () => {
      const path = await ipc.customThemeWriteSample();
      await reloadCustomThemes();
      setNote(`Sample written to ${path}`);
    });

  const missingActive = () =>
    customThemesEnabled() &&
    Boolean(activeCustomTheme()) &&
    !customThemes().some((t) => t.id === activeCustomTheme());

  return (
    <Card
      title="Custom themes"
      subtitle="JSON theme files layered over a built-in base. Edit a file, hit Reload, and the app re-skins live — see the sample for the full token vocabulary."
    >
      <Row
        label="Enable custom themes"
        hint="While a custom theme is active the built-in theme and accent pickers above are bypassed."
      >
        <Switch checked={customThemesEnabled()} onChange={setCustomThemesEnabled} />
      </Row>
      <Show when={customThemesEnabled()}>
        <div class="border-t border-glass-stroke px-5 py-4">
          <Show
            when={customThemes().length > 0}
            fallback={
              <div class="text-[12px] leading-relaxed text-fg-3">
                No theme files yet. Create the sample to get a working file you
                can copy and recolor — each file needs a <span class="mono">name</span>,
                a <span class="mono">base</span> (daylight, lamplight, aurora, or
                paper), and a <span class="mono">tokens</span> map.
              </div>
            }
          >
            <div class="grid grid-cols-4 gap-3">
              <For each={customThemes()}>
                {(t) => {
                  const active = () => activeCustomTheme() === t.id;
                  const swatchBg = () => t.tokens["--color-bg-base"] ?? THEME_META[t.base as Theme]?.vibe ?? "#222";
                  const swatchAccent = () => t.tokens["--color-accent-1"] ?? "#888";
                  return (
                    <button
                      type="button"
                      onClick={() => setActiveCustomTheme(active() ? null : t.id)}
                      class="lift relative overflow-hidden rounded-xl text-left"
                      style={{
                        height: "72px",
                        border: active() ? "none" : "1px solid var(--color-glass-stroke)",
                        "box-shadow": active()
                          ? "0 0 0 1.5px var(--color-accent-1)"
                          : undefined,
                        background: swatchBg(),
                      }}
                    >
                      <div class="absolute inset-x-2 bottom-2 flex items-center gap-1.5 rounded-md px-2 py-1"
                        style={{ background: "rgba(0,0,0,0.35)", "backdrop-filter": "blur(4px)" }}
                      >
                        <span class="h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ background: swatchAccent() }} />
                        <span class="truncate text-[11px] font-medium text-white">{t.name}</span>
                        <span class="mono ml-auto text-[9px] uppercase text-white/60">{t.base}</span>
                        <Show when={active()}>
                          <Check size={10} stroke-width={3} class="text-white" />
                        </Show>
                      </div>
                    </button>
                  );
                }}
              </For>
            </div>
          </Show>
          <Show when={missingActive()}>
            <div class="mt-3 text-[11px]" style={{ color: "var(--color-warn)" }}>
              The previously active theme "{activeCustomTheme()}" wasn't found —
              its file may have been renamed or removed. The base theme is shown
              until you pick another.
            </div>
          </Show>
          <Show when={customThemeWarnings().length > 0}>
            <div class="mt-3 flex flex-col gap-1">
              <For each={customThemeWarnings()}>
                {(w) => (
                  <div class="text-[11px]" style={{ color: "var(--color-warn)" }}>
                    {w}
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
        <Row
          label="Theme files"
          hint="One .json per theme in the app's themes folder. The file name becomes the theme id."
        >
          <div class="flex items-center gap-1.5">
            <button
              type="button"
              disabled={busy()}
              onClick={() => void run(() => ipc.customThemesOpenDir())}
              class="lift glass-soft h-8 rounded-md px-2.5 text-[12px] text-fg-2 hover:bg-[var(--color-control-fill)] disabled:opacity-50"
            >
              Open folder
            </button>
            <button
              type="button"
              disabled={busy()}
              onClick={() => void createSample()}
              class="lift glass-soft h-8 rounded-md px-2.5 text-[12px] text-fg-2 hover:bg-[var(--color-control-fill)] disabled:opacity-50"
            >
              Create sample
            </button>
            <button
              type="button"
              disabled={busy()}
              onClick={() => void run(() => reloadCustomThemes())}
              class="lift glass-soft h-8 rounded-md px-2.5 text-[12px] text-fg-2 hover:bg-[var(--color-control-fill)] disabled:opacity-50"
            >
              Reload
            </button>
          </div>
        </Row>
        <Show when={note()}>
          <div class="mono border-t border-glass-stroke px-5 py-2.5 text-[11px] text-fg-3">
            {note()}
          </div>
        </Show>
      </Show>
    </Card>
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
        ? "0 0 0 1.5px var(--color-accent-1), 0 6px 18px color-mix(in srgb, var(--color-accent-1) 22%, transparent)"
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
  "texlive-wasm": "TeX Live (WASM)",
};

const EditorPanel: Component = () => {
  const update = <K extends keyof EditorSettings>(key: K, value: EditorSettings[K]) => {
    setEditorSettings({ ...editorSettings(), [key]: value });
  };

  return (
    <div class="space-y-3">
      <Card
        title="Compilation"
        subtitle="How your project compiles to PDF when you write."
      >
        <Show when={!isTauriMobile()}>
          <Row
            label="Default engine"
            hint="System TeX uses your local install; Tectonic is a self-contained Rust binary."
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
        <Row
          label="Auto-compile on save"
          hint="Recompile automatically after each save (Mod+S)."
        >
          <Switch
            checked={editorSettings().autoCompile}
            onChange={(v) => update("autoCompile", v)}
          />
        </Row>
        <Row
          label="Stop on first error"
          hint="Halt latexmk/pdflatex at the first error. Off = push through and collect every diagnostic in one pass (Tectonic always halts)."
        >
          <Switch
            checked={editorSettings().stopOnFirstError}
            onChange={(v) => update("stopOnFirstError", v)}
          />
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
        <Row label="Vim mode" hint="Modal editing bindings in the source pane.">
          <Switch
            checked={editorSettings().vimMode}
            onChange={(v) => update("vimMode", v)}
          />
        </Row>
        <Row
          label="Spell & grammar check"
          hint="Powered by Harper — configure it under Settings → Integrations → Grammar."
        >
          <Switch
            checked={integrationsSettings().grammar.enabled}
            onChange={(v) =>
              setIntegrationsSettings((prev) => ({
                ...prev,
                grammar: { ...prev.grammar, enabled: v },
              }))
            }
          />
        </Row>
      </Card>
    </div>
  );
};

const SelectStub: Component<{
  value: string;
  options: Array<{ value: string | number; label: string }>;
  onChange: (v: string | number) => void;
}> = (props) => {
  const [open, setOpen] = createSignal(false);
  let rootRef: HTMLDivElement | undefined;
  installDismiss(() => rootRef, open, () => setOpen(false));
  return (
    <div class="relative" ref={rootRef}>
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
          style={{ background: "var(--color-popover-bg)" }}
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
        subtitle="Preview only — notification delivery isn't built yet, so these controls are disabled."
        action={<SoonPill />}
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
              class="grid items-center gap-4 border-t border-glass-stroke px-5 py-3"
              style={{ "grid-template-columns": "1fr 64px 64px 64px" }}
            >
              <div>
                <div class="text-[13px] font-medium text-fg-1">{p.label}</div>
                <Show when={p.hint}>
                  <div class="mt-0.5 text-[11px] text-fg-3">{p.hint}</div>
                </Show>
              </div>
              <div class="flex justify-center">
                <Switch checked={p.inApp} onChange={() => {}} disabled />
              </div>
              <div class="flex justify-center">
                <Switch checked={p.email} onChange={() => {}} disabled />
              </div>
              <div class="flex justify-center">
                <Switch checked={p.push} onChange={() => {}} disabled />
              </div>
            </div>
          )}
        </For>
      </Card>
      <Card
        title="Quiet hours"
        subtitle="Pause email and push outside writing time. Disabled until delivery exists."
        action={<SoonPill />}
      >
        <Row label="Quiet hours">
          <Switch checked={false} onChange={() => {}} disabled />
        </Row>
      </Card>
    </div>
  );
};

// =================================================================
// Keyboard shortcuts — read live from the CommandRegistry
// =================================================================

const ShortcutsPanel: Component = () => {
  const bound = () =>
    commands()
      .filter((c) => c.shortcut)
      .slice()
      .sort((a, b) => a.title.localeCompare(b.title));
  return (
    <Card
      title="Keyboard shortcuts"
      subtitle="Bindings come from the command registry — format-specific commands appear while a matching project is open. Remapping isn't supported yet."
    >
      <For each={bound()}>
        {(c) => (
          <Row label={c.title} hint={c.subtitle}>
            <KbdHint shortcut={c.shortcut!} size="md" />
          </Row>
        )}
      </For>
      <Row
        label="Jump to source"
        hint="Double-click (or Shift+click) anywhere on the PDF preview to jump the editor to that line."
      >
        <KbdHint shortcut="Shift" size="md" />
      </Row>
    </Card>
  );
};

// =================================================================
// Security panel
// =================================================================

const resetAppData = async (): Promise<void> => {
  let proceed = false;
  try {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    proceed = await ask(
      "Reset Typeward to its defaults? Settings, theme preferences, and local UI state are cleared; project files on disk are untouched. The app reloads afterwards.",
      {
        title: "Reset local app data",
        kind: "warning",
        okLabel: "Reset and reload",
        cancelLabel: "Cancel",
      },
    );
  } catch {
    proceed = window.confirm("Reset Typeward to its defaults and reload?");
  }
  if (!proceed) return;
  try {
    await ipc.resetSettings();
  } catch {
    // settings.json may not exist yet — the reload boots on defaults anyway.
  }
  try {
    localStorage.clear();
  } catch {
    /* storage unavailable */
  }
  window.location.reload();
};

const SecurityPanel: Component = () => {
  return (
    <div class="space-y-3">
      <Card
        title="Two-factor authentication"
        subtitle="Add a second factor to protect your account."
        action={
          <Pill
            bg="var(--color-control-fill)"
            color="var(--color-fg-3)"
          >
            Coming soon
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
            style={{ background: "color-mix(in srgb, var(--color-err) 10%, transparent)" }}
          >
            <Trash2 size={14} style={{ color: "var(--color-err)" }} />
          </div>
          <div class="flex-1">
            <div class="text-[13px] font-medium" style={{ color: "var(--color-err)" }}>
              Reset local app data
            </div>
            <div class="mt-0.5 text-[11px] text-fg-2">
              Restores default settings and clears local UI state. Your project
              files on disk are untouched; the app reloads afterwards.
            </div>
          </div>
          <button
            type="button"
            onClick={() => void resetAppData()}
            class="lift h-8 rounded-md px-3 text-[12px] font-medium"
            style={{
              background: "color-mix(in srgb, var(--color-err) 12%, transparent)",
              color: "var(--color-err)",
              border: "1px solid color-mix(in srgb, var(--color-err) 25%, transparent)",
            }}
          >
            Reset
          </button>
        </div>
      </Card>
    </div>
  );
};

