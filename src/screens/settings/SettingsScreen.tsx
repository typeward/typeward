import { describeIpcError } from "~/lib/errors";
import { useNavigate } from "@solidjs/router";
import {
  Activity,
  ArrowLeft,
  BookMarked,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Folder,
  GitBranch,
  Info,
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
import { Switch as KSwitch } from "@kobalte/core/switch";
import type { Component, JSX } from "solid-js";
import { For, Show, createEffect, createResource, createSignal, onCleanup } from "solid-js";
import { FeatureGate } from "~/components/entitlement/FeatureGate";
import { ProChip, ProLockedPanel } from "~/components/entitlement/ProChip";
import { setRequestProDialog } from "~/commands/palette-store";
import { PRO_DISCOVERY_ENABLED } from "~/config/pro";
import { errorText, notifyError } from "~/components/feedback/Toaster";
import { AmbientBackdrop } from "~/components/layout/AmbientBackdrop";
import { TopBar } from "~/components/layout/TopBar";
import { Slider } from "~/components/forms/Slider";
import { Switch, SwitchControl } from "~/components/forms/Switch";
import { TextField } from "~/components/forms/TextField";
import { Button } from "~/components/primitives/Button";
import { KbdHint } from "~/components/primitives/KbdHint";
import { SoonBadge } from "~/components/primitives/SoonBadge";
import { commands } from "~/commands/registry";
import * as ipc from "~/ipc";
import { installDismiss } from "~/lib/dismiss";
import { handleListboxKeydown, useListboxOpenFocus } from "~/lib/listbox-nav";
import { currentTier } from "~/integrations/entitlements";
import { signOut, supabaseUser } from "~/integrations/supabase/session";
import { AccountSection } from "./AccountSection";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import {
  IntegrationsPanel,
  aiEntitled,
  cloudEntitled,
  grammarEntitled,
  referencesEntitled,
  vcsEntitled,
} from "./IntegrationsPanel";
import {
  type CompileEngine,
  type EditorSettings,
  type LineHeightMode,
  buildSettings,
  compileEngine,
  editorSettings,
  feedbackPromptsEnabled,
  historyMaxVersions,
  integrationsSettings,
  projectsRoot,
  latchDensityChoice,
  setCompileEngine,
  setEditorSettings,
  setFeedbackPromptsEnabled,
  setHistoryMaxVersions,
  setIntegrationsSettings,
  setProjectsRoot,
  setShareCrashReports,
  setUiScale,
  setUpdatesCheckAutomatically,
  shareCrashReports,
  uiScale,
  updatesCheckAutomatically,
} from "~/stores/settings-store";
import { checkForUpdates } from "~/lib/updater";
import {
  previousRoute,
  setPreviousRoute,
  setSettingsSectionIntent,
  settingsSectionIntent,
} from "~/stores/nav-store";
import {
  ACCENTS,
  type Accent,
  THEMES,
  THEME_ROSTER,
  type Theme,
  accent,
  setAccent,
  setTheme,
  theme,
  themeSetting,
} from "~/themes/theme-store";
import {
  type Density,
  DENSITIES,
  accentGradient,
  activeCustomTheme,
  ambientLights,
  animations,
  customThemesEnabled,
  density,
  glowEffects,
  setAccentGradient,
  setActiveCustomTheme,
  setAmbientLights,
  setAnimations,
  setCustomThemesEnabled,
  setDensity,
  setGlowEffects,
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
import { isTabletViewport, touchAffordances } from "~/stores/viewport-store";

type SectionId =
  | "account"
  | "notifications"
  | "security"
  | "diagnostics"
  | "about"
  | "editor"
  | "appearance"
  | "shortcuts"
  | "projects-files"
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
  /** While Pro discovery is on, the row stays visible when locked (discovery
   *  amendment 2026-07-08) with a quiet Pro chip and its panel renders a
   *  locked state instead of the cards. While it's off (free-only beta),
   *  locked rows hide entirely — the pre-amendment behavior. */
  locked?: () => boolean;
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
      // The "Notifications" row is unlisted while delivery doesn't exist —
      // the panel was a fully inert preview. NotificationsPanel stays in this
      // file so the row can return with the real feature.
      { id: "security", label: "Security", icon: Shield },
      { id: "diagnostics", label: "Diagnostics", icon: Activity },
      { id: "about", label: "About", icon: Info },
    ],
  },
  {
    label: "General",
    items: [
      { id: "editor", label: "Editor", icon: Type },
      { id: "appearance", label: "Appearance", icon: Palette },
      { id: "shortcuts", label: "Keyboard", icon: Keyboard },
      { id: "projects-files", label: "Projects & files", icon: Folder },
    ],
  },
  {
    label: "Integrations",
    items: [
      { id: "int-references", label: "References", icon: BookMarked, locked: () => !referencesEntitled() },
      { id: "int-cloud", label: "Cloud storage", icon: Cloud, locked: () => !cloudEntitled() },
      { id: "int-vcs", label: "Git & GitHub", icon: GitBranch, locked: () => !vcsEntitled() },
      { id: "int-ai", label: "AI providers", icon: Sparkles, locked: () => !aiEntitled() },
      { id: "int-grammar", label: "Grammar", icon: SpellCheck, locked: () => !grammarEntitled() },
    ],
  },
];

const SECTION_IDS: ReadonlySet<string> = new Set(
  NAV.flatMap((g) => g.items.map((i) => i.id)),
);

// Static search index for the sidebar filter: each section's nav label plus a
// hand-maintained keyword list covering the settings that live inside it.
// Substring match only — no content-level highlighting.
const SECTION_KEYWORDS: Record<SectionId, string[]> = {
  account: ["plan", "subscription", "pro", "sign in", "email", "billing", "sync settings"],
  notifications: ["email", "push", "quiet hours"],
  security: ["privacy", "crash reports", "telemetry", "sentry", "feedback", "two-factor", "2fa", "reset", "danger"],
  diagnostics: ["telemetry", "log", "errors", "report", "bug", "crash"],
  about: ["version", "updates", "release", "check for updates"],
  editor: [
    "engine", "compile", "latexmk", "tectonic", "autosave", "history", "versions",
    "font", "wrap", "line height", "tab size", "line numbers", "autocomplete",
    "brackets", "vim", "grammar", "spell", "pdf", "zoom", "invert",
  ],
  appearance: [
    "theme", "dark", "light", "system", "accent", "color", "gradient", "glow",
    "density", "scale", "zoom", "animations", "ambient", "custom theme",
  ],
  shortcuts: ["keyboard", "keybinding", "hotkey", "binding"],
  "projects-files": [
    "storage", "projects folder", "path", "location", "spaces", "tags",
    "word count", "notifications panel", "workspace",
  ],
  "int-references": ["zotero", "mendeley", "bibtex", "citations", "bibliography", "doi", "arxiv"],
  "int-cloud": ["dropbox", "webdav", "nextcloud", "owncloud", "sync", "cloud storage"],
  "int-vcs": ["git", "github", "overleaf", "commit", "clone", "version control", "repository"],
  "int-ai": ["ai", "claude", "anthropic", "openai", "chatgpt", "gemini", "ollama", "chat", "models"],
  "int-grammar": ["harper", "grammar", "spelling", "spell check", "dictionary"],
};

/** The active section's content — the same panel chain feeds the desktop
 *  two-pane layout and level 2 of the tablet drill-down. */
const SectionPanel: Component<{ id: SectionId }> = (props) => (
  <>
    <Show when={props.id === "appearance"}>
      <AppearancePanel />
    </Show>
    <Show when={props.id === "editor"}>
      <EditorPanel />
    </Show>
    <Show when={props.id === "projects-files"}>
      <ProjectsFilesPanel />
    </Show>
    {/* Unreachable while the Notifications nav row is unlisted; the
        panel stays wired for the feature's return. */}
    <Show when={props.id === "notifications"}>
      <NotificationsPanel />
    </Show>
    <Show when={props.id === "security"}>
      <SecurityPanel />
    </Show>
    <Show when={props.id === "diagnostics"}>
      <DiagnosticsPanel />
    </Show>
    <Show when={props.id === "about"}>
      <AboutPanel />
    </Show>
    {/* Locked integration sections render a quiet Pro state instead
        of their cards; entitled users see everything as before. */}
    <Show when={props.id === "int-references"}>
      <Show when={referencesEntitled()} fallback={<ProLockedPanel class="py-16" />}>
        <IntegrationsPanel section="references" />
      </Show>
    </Show>
    <Show when={props.id === "int-cloud"}>
      <Show when={cloudEntitled()} fallback={<ProLockedPanel class="py-16" />}>
        <IntegrationsPanel section="cloud" />
      </Show>
    </Show>
    <Show when={props.id === "int-vcs"}>
      <Show when={vcsEntitled()} fallback={<ProLockedPanel class="py-16" />}>
        <IntegrationsPanel section="vcs" />
      </Show>
    </Show>
    <Show when={props.id === "int-ai"}>
      <Show when={aiEntitled()} fallback={<ProLockedPanel class="py-16" />}>
        <IntegrationsPanel section="ai" />
      </Show>
    </Show>
    <Show when={props.id === "int-grammar"}>
      <Show when={grammarEntitled()} fallback={<ProLockedPanel class="py-16" />}>
        <IntegrationsPanel section="grammar" />
      </Show>
    </Show>
    <Show when={props.id === "account"}>
      <AccountSection />
    </Show>
    <Show when={props.id === "shortcuts"}>
      <ShortcutsPanel />
    </Show>
  </>
);

const SettingsScreen: Component = () => {
  const navigate = useNavigate();
  const [active, setActive] = createSignal<SectionId>("appearance");
  const [navQuery, setNavQuery] = createSignal("");

  const matchesQuery = (item: NavItem): boolean => {
    const q = navQuery().trim().toLowerCase();
    if (!q) return true;
    return (
      item.label.toLowerCase().includes(q) ||
      SECTION_KEYWORDS[item.id].some((k) => k.includes(q))
    );
  };

  // Tablet drill-down (§15-C): below the tablet breakpoint the screen shows
  // one level at a time — the grouped nav list (level 1) or a single section
  // behind a back header (level 2). Desktop keeps the two-pane layout, where
  // `drilled` is simply never read.
  const [drilled, setDrilled] = createSignal(false);
  let navListEl: HTMLDivElement | undefined;
  let savedNavScroll = 0;
  const drillIn = (id: SectionId) => {
    savedNavScroll = navListEl?.scrollTop ?? 0;
    setActive(id);
    setDrilled(true);
  };
  const backToNav = () => {
    setDrilled(false);
    // Solid renders synchronously, so the remounted list can take its
    // scroll offset back right away.
    if (navListEl) navListEl.scrollTop = savedNavScroll;
  };
  const activeLabel = () =>
    NAV.flatMap((g) => g.items).find((i) => i.id === active())?.label ?? "Settings";

  // Escape backs out of level 2 — deliberately deferential to overlays:
  // Kobalte layers and the listbox popups preventDefault the key when they
  // consume it, and installDismiss popovers stop it before window entirely.
  const onEscapeKeydown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if (!isTabletViewport() || !drilled()) return;
    e.preventDefault();
    backToNav();
  };
  window.addEventListener("keydown", onEscapeKeydown);
  onCleanup(() => window.removeEventListener("keydown", onEscapeKeydown));

  // One-shot deep link (e.g. onboarding's "Sign in" → Account). With Pro
  // discovery on, locked integration rows don't hide, so no visibility
  // bounce is needed there. On tablet the deep link lands directly on the
  // section (level 2), not on the nav list.
  const intent = settingsSectionIntent();
  if (intent) {
    setSettingsSectionIntent(null);
    if (SECTION_IDS.has(intent)) {
      setActive(intent as SectionId);
      setDrilled(true);
    }
  }

  // While Pro discovery is off, locked integration rows hide from the nav —
  // and a group they empty out hides with them. The sidebar filter narrows
  // the same list; a group with no matches hides through the same length gate.
  const visibleItems = (g: NavGroup) =>
    g.items.filter(
      (item) => (PRO_DISCOVERY_ENABLED || !item.locked?.()) && matchesQuery(item),
    );

  // A locked section can vanish from the nav underneath the user (e.g.
  // sign-out while an integrations panel is open); bounce off the now-blank
  // panel instead of stranding them on it.
  createEffect(() => {
    if (PRO_DISCOVERY_ENABLED) return;
    const item = NAV.flatMap((g) => g.items).find((i) => i.id === active());
    if (item?.locked?.()) {
      setActive("appearance");
      // On tablet, bounce all the way back to the nav list rather than
      // teleporting the user into a section they never opened.
      setDrilled(false);
    }
  });

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
  const handleSignOut = async () => {
    try {
      await signOut();
    } catch (e) {
      notifyError("Couldn't sign out", errorText(e));
    }
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
            class="lift flex h-7 items-center gap-1.5 rounded-md px-2 text-sm text-fg-2 hover:bg-[var(--color-control-fill)]"
          >
            <ArrowLeft size={12} style={{ opacity: 0.6 }} />
            <span>{backLabel()}</span>
          </button>
          <span class="text-fg-4">/</span>
          <span class="text-sm font-medium text-fg-1">Settings</span>
          <div class="flex-1" />
        </div>

        {/* Desktop: the two-pane layout, unchanged. */}
        <Show when={!isTabletViewport()}>
          <div class="flex min-h-0 flex-1 gap-2 p-2">
            {/* Sidebar */}
            <div
              class="glass flex flex-col overflow-hidden rounded-xl"
              style={{ width: "240px", height: "100%" }}
            >
              <div class="p-2 pb-0">
                <TextField
                  label="Filter settings"
                  hideLabel
                  size="sm"
                  type="text"
                  placeholder="Search settings"
                  value={navQuery()}
                  onInput={(e) => setNavQuery(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && navQuery()) {
                      e.stopPropagation();
                      setNavQuery("");
                    }
                  }}
                />
              </div>
              <div class="flex-1 space-y-3.5 overflow-auto scroll p-2 pt-3">
                <For each={NAV}>
                  {(g) => (
                    <Show when={visibleItems(g).length > 0}>
                      <div>
                        <div class="label-xs mb-1.5 px-2 text-fg-3">{g.label}</div>
                        <For each={visibleItems(g)}>
                          {(item) => {
                            const isActive = () => active() === item.id;
                            return (
                              <button
                                type="button"
                                onClick={() => setActive(item.id)}
                                class={`lift relative flex w-full items-center gap-2 rounded-md px-2 text-base ${
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
                                  <span class="mono ml-auto rounded-full accent-grad px-1.5 py-0.5 text-xs font-semibold">
                                    {item.badge}
                                  </span>
                                </Show>
                                <Show when={item.locked?.()}>
                                  <span class="ml-auto">
                                    <ProChip />
                                  </span>
                                </Show>
                                <Show when={item.id === "account"}>
                                  <span class="mono ml-auto rounded-full accent-grad px-1.5 py-0.5 text-xs font-semibold capitalize">
                                    {currentTier()}
                                  </span>
                                </Show>
                              </button>
                            );
                          }}
                        </For>
                      </div>
                    </Show>
                  )}
                </For>
              </div>
              <Show when={supabaseUser()}>
                <div class="border-t border-glass-stroke p-3">
                  <Button
                    variant="ghost"
                    size="sm"
                    class="h-8 w-full"
                    leadingIcon={<LogOut class="ui-icon-sm" />}
                    onClick={() => void handleSignOut()}
                  >
                    Sign out
                  </Button>
                </div>
              </Show>
            </div>

            {/* Main panel */}
            <div class="flex min-w-0 flex-1 flex-col">
              <div class="scroll mx-auto flex w-full max-w-[820px] flex-1 flex-col gap-3 overflow-auto px-2 pb-4">
                <SectionPanel id={active()} />
              </div>
            </div>
          </div>
        </Show>

        {/* Tablet drill-down (§15-C): one level at a time. Level 1 is the
            search field + the grouped nav as a full-width list; tapping a
            section drills to level 2 — the same panel components behind a
            back header. */}
        <Show when={isTabletViewport()}>
          <div class="flex min-h-0 flex-1 flex-col p-2">
            <Show
              when={drilled()}
              fallback={
                <div class="glass mx-auto flex h-full w-full max-w-[820px] flex-col overflow-hidden rounded-xl">
                  <div class="p-2 pb-0">
                    <TextField
                      label="Filter settings"
                      hideLabel
                      size="sm"
                      type="text"
                      placeholder="Search settings"
                      value={navQuery()}
                      onInput={(e) => setNavQuery(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape" && navQuery()) {
                          e.stopPropagation();
                          setNavQuery("");
                        }
                      }}
                    />
                  </div>
                  <div
                    ref={navListEl}
                    class="flex-1 space-y-3.5 overflow-auto scroll p-2 pt-3"
                  >
                    <For each={NAV}>
                      {(g) => (
                        <Show when={visibleItems(g).length > 0}>
                          <div>
                            <div class="label-xs mb-1.5 px-2 text-fg-3">{g.label}</div>
                            <For each={visibleItems(g)}>
                              {(item) => (
                                <button
                                  type="button"
                                  onClick={() => drillIn(item.id)}
                                  class="lift relative flex w-full items-center gap-2 rounded-md px-2 text-base text-fg-2 hover:bg-[var(--color-control-fill)]"
                                  style={{
                                    "min-height": touchAffordances()
                                      ? "44px"
                                      : "var(--ui-row)",
                                  }}
                                >
                                  <item.icon class="ui-icon-menu" />
                                  <span>{item.label}</span>
                                  <span class="ml-auto flex items-center gap-2">
                                    <Show when={item.badge}>
                                      <span class="mono rounded-full accent-grad px-1.5 py-0.5 text-xs font-semibold">
                                        {item.badge}
                                      </span>
                                    </Show>
                                    <Show when={item.locked?.()}>
                                      <ProChip />
                                    </Show>
                                    <Show when={item.id === "account"}>
                                      <span class="mono rounded-full accent-grad px-1.5 py-0.5 text-xs font-semibold capitalize">
                                        {currentTier()}
                                      </span>
                                    </Show>
                                    <ChevronRight size={14} style={{ opacity: 0.5 }} />
                                  </span>
                                </button>
                              )}
                            </For>
                          </div>
                        </Show>
                      )}
                    </For>
                  </div>
                  <Show when={supabaseUser()}>
                    <div class="border-t border-glass-stroke p-3">
                      <Button
                        variant="ghost"
                        size="sm"
                        class="h-8 w-full"
                        leadingIcon={<LogOut class="ui-icon-sm" />}
                        onClick={() => void handleSignOut()}
                      >
                        Sign out
                      </Button>
                    </div>
                  </Show>
                </div>
              }
            >
              <div class="flex min-h-0 flex-1 flex-col">
                <div class="mx-auto flex w-full max-w-[820px] flex-shrink-0 items-center gap-2 px-2 pb-2">
                  <button
                    type="button"
                    onClick={backToNav}
                    class="lift flex items-center gap-1 rounded-md px-2 text-sm text-fg-2 hover:bg-[var(--color-control-fill)]"
                    style={{
                      "min-height": touchAffordances() ? "44px" : "var(--ui-row)",
                    }}
                  >
                    <ChevronLeft size={14} style={{ opacity: 0.6 }} />
                    <span>Settings</span>
                  </button>
                  <span class="text-base font-semibold tracking-tight text-fg-1">
                    {activeLabel()}
                  </span>
                </div>
                <div class="scroll mx-auto flex w-full max-w-[820px] flex-1 flex-col gap-3 overflow-auto px-2 pb-4">
                  <SectionPanel id={active()} />
                </div>
              </div>
            </Show>
          </div>
        </Show>
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
        <div class="text-base font-semibold tracking-tight text-fg-1">
          {props.title}
        </div>
        <Show when={props.subtitle}>
          <div class="mt-0.5 text-sm leading-relaxed text-fg-2">
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
      <div class="text-base font-medium text-fg-1">{props.label}</div>
      <Show when={props.hint}>
        <div class="mt-0.5 text-xs leading-relaxed text-fg-3">{props.hint}</div>
      </Show>
    </div>
    <div class="flex-shrink-0">{props.children}</div>
  </div>
);

/** Row hosting a single Switch, rendered as one Kobalte switch root so the
 *  visible text IS the control's label (name + description for screen
 *  readers, and the block-level label makes the whole label line a click
 *  target). Same chrome as Row — keep the two visually in lockstep. */
const ToggleRow: Component<{
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}> = (props) => (
  <KSwitch
    checked={props.checked}
    onChange={props.onChange}
    disabled={props.disabled}
    class="flex items-center gap-4 border-t border-glass-stroke px-5 py-3.5 first:border-t-0"
  >
    <KSwitch.Input class="peer sr-only" />
    <div class="min-w-0 flex-1">
      <KSwitch.Label class="block text-base font-medium text-fg-1">
        {props.label}
      </KSwitch.Label>
      <Show when={props.hint}>
        <KSwitch.Description class="mt-0.5 text-xs leading-relaxed text-fg-3">
          {props.hint}
        </KSwitch.Description>
      </Show>
    </div>
    <SwitchControl />
  </KSwitch>
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

// Preview swatch backgrounds only. `name` and `dark` derive from THEME_ROSTER
// (theme-store) so the light/dark truth and labels have a single source.
const THEME_VIBE: Record<Theme, string> = {
  light: "#FFFFFF",
  dark: "#1E1E1E",
  daylight:
    "radial-gradient(circle at 75% 20%, #F0E7CF, transparent 60%), radial-gradient(circle at 25% 80%, #ECDFC2, transparent 60%), #F8F4EA",
  lamplight:
    "radial-gradient(circle at 75% 15%, #C2691E, transparent 55%), radial-gradient(circle at 60% 45%, rgba(232,163,77,0.45), transparent 60%), #0D0C0A",
  aurora:
    "radial-gradient(circle at 20% 30%, #4C1D95, transparent 60%), radial-gradient(circle at 80% 70%, #155E75, transparent 60%), #0A0B0F",
  paper: "#FAF9F6",
};

const THEME_META: Record<Theme, ThemeMeta> = Object.fromEntries(
  THEMES.map((t) => [
    t,
    {
      id: t,
      name: THEME_ROSTER[t].label,
      vibe: THEME_VIBE[t],
      dark: THEME_ROSTER[t].dark,
    },
  ]),
) as Record<Theme, ThemeMeta>;

// Picker sections: plain "Basic" (Light/Dark) then the stylized "Styled" set.
const THEME_GROUPS: { label: string; themes: Theme[] }[] = [
  { label: "Basic", themes: THEMES.filter((t) => THEME_ROSTER[t].category === "basic") },
  { label: "Styled", themes: THEMES.filter((t) => THEME_ROSTER[t].category === "styled") },
];

interface AccentMeta {
  id: Accent;
  label: string;
}

// Preview swatch colors are read straight off the CSS tokens via a detached
// probe element, so they can never drift from the themes. The [data-theme] /
// [data-accent] rules set the vars on the probe directly: a theme alone
// resolves that theme's NATIVE accent (no data-accent), while accent probes
// also carry the active theme so the light-theme deepened palettes (compound
// [data-theme][data-accent] rules) resolve. Cached — theme CSS is static.
const _accentProbeCache = new Map<string, [string, string]>();
function probeAccentPair(
  attrs: Partial<Record<"data-theme" | "data-accent", string>>,
): [string, string] {
  const key = `${attrs["data-theme"] ?? ""}|${attrs["data-accent"] ?? ""}`;
  const hit = _accentProbeCache.get(key);
  if (hit) return hit;
  const el = document.createElement("span");
  el.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
  for (const [attr, value] of Object.entries(attrs)) {
    if (value) el.setAttribute(attr, value);
  }
  document.body.appendChild(el);
  const cs = getComputedStyle(el);
  const pair: [string, string] = [
    cs.getPropertyValue("--color-accent-1").trim(),
    cs.getPropertyValue("--color-accent-2").trim(),
  ];
  el.remove();
  if (pair[0]) _accentProbeCache.set(key, pair);
  return pair;
}
const themeNativeAccent = (t: Theme): [string, string] =>
  probeAccentPair({ "data-theme": t });
const accentPalette = (a: Accent): [string, string] =>
  probeAccentPair({ "data-theme": theme(), "data-accent": a });

const ACCENT_META: Record<Accent, AccentMeta> = {
  // "violet-cyan" is the stored id for "no data-accent" — the active theme's
  // native accent. Swatch colors for every entry are read from the CSS tokens
  // at render time (see probeAccentPair), so nothing here can drift.
  "violet-cyan": { id: "violet-cyan", label: "Theme default" },
  "amber-rose": { id: "amber-rose", label: "Ember" },
  "emerald-teal": { id: "emerald-teal", label: "Tide" },
  "indigo-pink": { id: "indigo-pink", label: "Orchid" },
};

// A custom theme only takes over once the switch is on AND a theme is
// picked — until then the built-in pickers keep working.
const customThemeActive = (): boolean =>
  customThemesEnabled() &&
  Boolean(activeCustomTheme()) &&
  customThemes().some((t) => t.id === activeCustomTheme());

// APG radio-group keyboard convention for the appearance pickers (theme tiles,
// accent chips, density segments, custom-theme tiles): arrows move focus AND
// select — selection follows focus, like native radios — with a roving
// tabindex on the options. Same shape as lib/tablist-nav's tablist helper, but
// each option carries its own click handler, so selecting delegates to
// `.click()` and disabled options drop out of the cycle.
function handleRadiogroupKeydown(
  e: KeyboardEvent & { currentTarget: HTMLElement },
): void {
  let delta: -1 | 0 | 1;
  if (e.key === "ArrowLeft" || e.key === "ArrowUp") delta = -1;
  else if (e.key === "ArrowRight" || e.key === "ArrowDown") delta = 1;
  else if (e.key === "Home" || e.key === "End") delta = 0;
  else return;
  const radios = Array.from(
    e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
  ).filter((r) => !r.disabled);
  if (radios.length === 0) return;
  e.preventDefault();
  let next: number;
  if (e.key === "Home") next = 0;
  else if (e.key === "End") next = radios.length - 1;
  else {
    let current = radios.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0)
      current = radios.findIndex(
        (r) => r.getAttribute("aria-checked") === "true",
      );
    if (current < 0) current = 0;
    next = (current + delta + radios.length) % radios.length;
  }
  radios[next]!.focus();
  // Skip the synthetic click when the target is already checked: the
  // custom-theme tiles are click-toggles, so re-clicking the active one would
  // DEACTIVATE it — with a single custom theme installed, every arrow key
  // wraps back to it. (No-op guard for the plain set-value groups.)
  if (radios[next]!.getAttribute("aria-checked") !== "true") {
    radios[next]!.click();
  }
}

// One line of live text inside the dimmed Theme/Accent cards so keyboard and
// AT users learn WHY the pickers are inert, not just that they look faded.
const CustomThemeOverrideNote: Component = () => (
  <div class="px-5 pt-4 text-xs leading-relaxed text-fg-3">
    Managed by your custom theme — turn it off in Custom themes below to
    change these.
  </div>
);

const AppearancePanel: Component = () => {
  return (
    <div class="space-y-3">
      <Card
        title="Theme"
        subtitle="Built-in themes. Disabled while a custom theme is active."
      >
        <Show when={customThemeActive()}>
          <CustomThemeOverrideNote />
        </Show>
        <div
          role="radiogroup"
          aria-label="Theme"
          onKeyDown={handleRadiogroupKeydown}
          class="space-y-4 p-5"
          style={
            customThemeActive()
              ? { opacity: "0.4", "pointer-events": "none" }
              : undefined
          }
        >
          <For each={THEME_GROUPS}>
            {(group) => (
              <div class="space-y-2">
                <div class="label-xs text-fg-3">{group.label}</div>
                <div class="grid grid-cols-4 gap-3">
                  <Show when={group.label === "Styled"}>
                    <SystemThemeTile
                      active={themeSetting() === "system"}
                      disabled={customThemeActive()}
                      onClick={() => setTheme("system")}
                    />
                  </Show>
                  <For each={group.themes}>
                    {(t) => (
                      <ThemeTile
                        meta={THEME_META[t]}
                        active={themeSetting() === t}
                        disabled={customThemeActive()}
                        onClick={() => setTheme(t)}
                      />
                    )}
                  </For>
                </div>
              </div>
            )}
          </For>
        </div>
      </Card>

      <Card
        title="Accent"
        subtitle="The signature gradient on buttons, active items, and highlights."
      >
        <Show when={customThemeActive()}>
          <CustomThemeOverrideNote />
        </Show>
        <div
          role="radiogroup"
          aria-label="Accent"
          onKeyDown={handleRadiogroupKeydown}
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
                a === "violet-cyan" ? themeNativeAccent(theme()) : accentPalette(a);
              return (
                <button
                  type="button"
                  role="radio"
                  aria-checked={active()}
                  tabindex={active() ? 0 : -1}
                  disabled={customThemeActive()}
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
                    <span class="text-sm font-medium text-fg-1">
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
        <ToggleRow
          label="Gradient"
          hint="Blend both accent stops across buttons, active items, and highlights. Off uses the solid accent color."
          checked={accentGradient()}
          onChange={setAccentGradient}
        />
        <Show when={THEME_ROSTER[theme()].category === "styled"}>
          <ToggleRow
            label="Glow"
            hint="Soft accent glow behind primary buttons and card hovers."
            checked={glowEffects()}
            onChange={setGlowEffects}
          />
        </Show>
      </Card>

      <CustomThemesCard />

      <Card title="Density & motion">
        <Row label="UI density" hint="Affects padding and row heights across the app.">
          <div
            role="radiogroup"
            aria-label="UI density"
            onKeyDown={handleRadiogroupKeydown}
            class="glass-inset flex items-center gap-1 rounded-md p-0.5"
          >
            <For each={DENSITIES}>
              {(d) => {
                const active = () => density() === d;
                return (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={active()}
                    tabindex={active() ? 0 : -1}
                    onClick={() => {
                      setDensity(d as Density);
                      // An explicit pick (any value, incl. cozy) opts this
                      // device out of the coarse-pointer auto-default.
                      latchDensityChoice();
                    }}
                    class={`h-7 rounded px-3 text-xs capitalize ${
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
        <div class="border-t border-glass-stroke px-5 py-4">
          <Slider
            label="Interface scale"
            value={uiScale()}
            onChange={setUiScale}
            min={90}
            max={150}
            step={5}
            unit="%"
          />
          <div class="mt-1.5 text-xs leading-relaxed text-fg-3">
            Scales text and controls together. Ctrl/Cmd +/- zooms the whole
            window.
          </div>
        </div>
        <ToggleRow
          label="Animations"
          hint="Toggles transitions, easings, and ambient motion across the app."
          checked={animations()}
          onChange={setAnimations}
        />
        <ToggleRow
          label="Ambient lights"
          hint="Soft radial blobs behind the glass surfaces. Disable for a flat, distraction-free backdrop."
          checked={ambientLights()}
          onChange={setAmbientLights}
        />
      </Card>

    </div>
  );
};

// =================================================================
// Projects & files — storage location + projects-screen options
// =================================================================

/** Middle-ellipsis for long absolute paths so the drive/home prefix and the
 *  leaf folder both stay readable. */
const truncatePathMiddle = (path: string, max = 46): string => {
  if (path.length <= max) return path;
  const head = Math.ceil((max - 1) * 0.4);
  const tail = max - 1 - head;
  return `${path.slice(0, head)}…${path.slice(path.length - tail)}`;
};

const ProjectsFilesPanel: Component = () => {
  const changeProjectsRoot = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      directory: true,
      defaultPath: projectsRoot() || undefined,
      title: "Choose the projects folder",
    });
    if (typeof picked !== "string" || picked.length === 0 || picked === projectsRoot()) {
      return;
    }
    try {
      // Pre-flight through save_settings: the Rust boundary validates the new
      // root (absolute path under Documents) and widens the fs runtime scope.
      // Committing the signal first would leave the store's reactive save
      // retry-looping on a rejected path, so the signal only moves on success.
      await ipc.saveSettings({ ...buildSettings(), projectsRoot: picked });
      setProjectsRoot(picked);
    } catch (e) {
      notifyError("Couldn't change the projects folder", describeIpcError(e));
    }
  };

  return (
    <div class="space-y-3">
      <Card title="Storage" subtitle="Where Typeward keeps your work on this machine.">
        <Row
          label="Projects folder"
          hint="New projects are created here. Existing projects stay where they are."
        >
          <div class="flex items-center gap-2">
            <span
              class="mono select-text text-xs text-fg-2"
              title={projectsRoot() || undefined}
            >
              {projectsRoot() ? truncatePathMiddle(projectsRoot()) : "…"}
            </span>
            <Button
              variant="secondary"
              size="sm"
              class="h-8"
              onClick={() => void changeProjectsRoot()}
            >
              Change…
            </Button>
          </div>
        </Row>
      </Card>

      <Card title="Projects screen">
        <ToggleRow
          label="Enable Spaces"
          hint="Show the Spaces grouping in the projects sidebar."
          checked={enableSpaces()}
          onChange={setEnableSpaces}
        />
        <ToggleRow
          label="Enable Tags"
          hint="Show the Tags list in the projects sidebar."
          checked={enableTags()}
          onChange={setEnableTags}
        />
        <ToggleRow
          label="Notifications panel default"
          hint="Show the right-side notifications drawer on every projects-screen visit."
          checked={notificationsPanelDefault()}
          onChange={setNotificationsPanelDefault}
        />
        <ToggleRow
          label="Word count on project cards"
          hint="Show an approximate word count on each card. Reads each project's root file when the library loads."
          checked={projectCardWords()}
          onChange={setProjectCardWords}
        />
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
      setNote(describeIpcError(e));
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

  // Unlike the other appearance radiogroups this one can have nothing checked
  // (custom themes are toggleable off) — the roving tabindex then falls back
  // to the first tile so the group stays reachable by Tab.
  const anyTileChecked = () =>
    customThemes().some((t) => t.id === activeCustomTheme());

  return (
    <Card
      title="Custom themes"
      subtitle="JSON theme files layered over a built-in base. Edit a file, hit Reload, and the app re-skins live — see the sample for the full token vocabulary."
    >
      <ToggleRow
        label="Enable custom themes"
        hint="While a custom theme is active the built-in theme and accent pickers above are bypassed."
        checked={customThemesEnabled()}
        onChange={setCustomThemesEnabled}
      />
      <Show when={customThemesEnabled()}>
        <div class="border-t border-glass-stroke px-5 py-4">
          <Show
            when={customThemes().length > 0}
            fallback={
              <div class="text-sm leading-relaxed text-fg-3">
                No theme files yet. Create the sample to get a working file you
                can copy and recolor — each file needs a <span class="mono">name</span>,
                a <span class="mono">base</span> (daylight, lamplight, aurora, or
                paper), and a <span class="mono">tokens</span> map.
              </div>
            }
          >
            <div
              role="radiogroup"
              aria-label="Custom theme"
              onKeyDown={handleRadiogroupKeydown}
              class="grid grid-cols-4 gap-3"
            >
              <For each={customThemes()}>
                {(t, i) => {
                  const active = () => activeCustomTheme() === t.id;
                  const swatchBg = () => t.tokens["--color-bg-base"] ?? THEME_META[t.base as Theme]?.vibe ?? "#222";
                  const swatchAccent = () => t.tokens["--color-accent-1"] ?? "#888";
                  return (
                    <button
                      type="button"
                      role="radio"
                      aria-checked={active()}
                      tabindex={
                        active() || (!anyTileChecked() && i() === 0) ? 0 : -1
                      }
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
                        <span class="truncate text-xs font-medium text-white">{t.name}</span>
                        <span class="mono ml-auto text-[10px] uppercase text-white/60">{t.base}</span>
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
            <div class="mt-3 text-xs" style={{ color: "var(--color-warn)" }}>
              The previously active theme "{activeCustomTheme()}" wasn't found —
              its file may have been renamed or removed. The base theme is shown
              until you pick another.
            </div>
          </Show>
          <Show when={customThemeWarnings().length > 0}>
            <div class="mt-3 flex flex-col gap-1">
              <For each={customThemeWarnings()}>
                {(w) => (
                  <div class="select-text text-xs" style={{ color: "var(--color-warn)" }}>
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
            <Button
              variant="secondary"
              size="sm"
              class="h-8"
              disabled={busy()}
              onClick={() => void run(() => ipc.customThemesOpenDir())}
            >
              Open folder
            </Button>
            <Button
              variant="secondary"
              size="sm"
              class="h-8"
              disabled={busy()}
              onClick={() => void createSample()}
            >
              Create sample
            </Button>
            <Button
              variant="secondary"
              size="sm"
              class="h-8"
              disabled={busy()}
              onClick={() => void run(() => reloadCustomThemes())}
            >
              Reload
            </Button>
          </div>
        </Row>
        <Show when={note()}>
          <div class="mono select-text border-t border-glass-stroke px-5 py-2.5 text-xs text-fg-3">
            {note()}
          </div>
        </Show>
      </Show>
    </Card>
  );
};

/** The "follow the OS" option — a diagonal split previewing both themes it
 * resolves to (Daylight when the OS is light, Lamplight when dark). Same
 * chrome as ThemeTile; the label styling uses the dark half's treatment
 * because the bottom edge sits mostly on the Lamplight triangle. */
const SystemThemeTile: Component<{
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}> = (props) => (
  <button
    type="button"
    role="radio"
    aria-checked={props.active}
    tabindex={props.active ? 0 : -1}
    disabled={props.disabled}
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
    <div
      class="absolute inset-0"
      style={{
        background: THEME_VIBE.daylight,
        "clip-path": "polygon(0 0, 100% 0, 0 100%)",
      }}
    />
    <div
      class="absolute inset-0"
      style={{
        background: THEME_VIBE.lamplight,
        "clip-path": "polygon(100% 0, 100% 100%, 0 100%)",
      }}
    />
    <div class="absolute bottom-1.5 left-2 right-2 flex items-center justify-between">
      <span
        class="text-xs font-semibold"
        style={{ color: "#E6E8EC", "text-shadow": "0 1px 2px rgba(0,0,0,0.6)" }}
      >
        System
      </span>
      <Show when={props.active}>
        <div class="flex h-4 w-4 items-center justify-center rounded-full accent-grad">
          <Check size={10} stroke-width={3} />
        </div>
      </Show>
    </div>
  </button>
);

const ThemeTile: Component<{
  meta: ThemeMeta;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}> = (props) => (
  <button
    type="button"
    role="radio"
    aria-checked={props.active}
    tabindex={props.active ? 0 : -1}
    disabled={props.disabled}
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
        class="text-xs font-semibold"
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

interface EngineStatus {
  text: string;
  tone: "ok" | "warn" | "err";
}

const ENGINE_STATUS_COLOR: Record<EngineStatus["tone"], string> = {
  ok: "var(--color-ok)",
  warn: "var(--color-warn)",
  err: "var(--color-err)",
};

/** Short "4.86a"-style version out of a full `--version` banner line. */
const shortToolVersion = (raw: string | null): string | null =>
  raw?.match(/\d+(?:\.\d+)+[a-z]?/i)?.[0] ?? null;

/** One status line for the selected engine from the detect_tex probe. Red only
 *  when the SELECTED engine cannot work; degraded-but-working states warn. */
const engineStatusFor = (
  probe: ipc.EngineProbe | null,
  engine: CompileEngine,
): EngineStatus | null => {
  if (!probe) return null;
  const installed = (name: string) =>
    probe.engines.find((e) => e.name === name && e.installed);
  if (engine === "tectonic") {
    const tectonic = installed("tectonic");
    if (tectonic) {
      const v = shortToolVersion(tectonic.version);
      return { text: `tectonic${v ? ` ${v}` : ""} found`, tone: "ok" };
    }
    // The sidecar is tried before PATH, so a missing PATH binary isn't fatal.
    return {
      text: "tectonic isn't on PATH — the bundled engine is used when this build ships it",
      tone: "warn",
    };
  }
  if (engine !== "system-tex") return null;
  const latexmk = installed("latexmk");
  if (latexmk && probe.anyLatexAvailable) {
    const v = shortToolVersion(latexmk.version);
    return {
      text: `latexmk${v ? ` ${v}` : ""}${installed("pdflatex") ? " · pdflatex found" : ""}`,
      tone: "ok",
    };
  }
  if (probe.anyLatexAvailable) {
    return {
      text: "pdflatex only — latexmk missing, compiling calls pdflatex directly",
      tone: "warn",
    };
  }
  if (latexmk) {
    return {
      text: "latexmk found but no TeX engine — install a TeX distribution or switch to Tectonic",
      tone: "err",
    };
  }
  return {
    text: "No TeX installation detected — the Tectonic engine runs without one",
    tone: "err",
  };
};

const EditorPanel: Component = () => {
  const update = <K extends keyof EditorSettings>(key: K, value: EditorSettings[K]) => {
    setEditorSettings({ ...editorSettings(), [key]: value });
  };

  // Mirror of the Ollama probe pattern: surface whether the selected engine
  // can actually run, right under the picker instead of only at compile time.
  const [texProbe, { refetch: refetchTexProbe }] = createResource(
    () => !isTauriMobile(),
    async (enabled) => (enabled ? await ipc.detectTex().catch(() => null) : null),
  );
  const engineStatus = () => engineStatusFor(texProbe() ?? null, compileEngine());

  // The WASM engine's assets are downloaded per-host/CI, never checked in — so
  // a build can ship without them. Say so here instead of only at compile time.
  const [wasmAssets] = createResource(
    () => compileEngine() === "texlive-wasm",
    async (active) => {
      if (!active) return null;
      const { texliveWasmUnavailableReason } = await import(
        "~/providers/compile/texlive-wasm-assets"
      );
      return await texliveWasmUnavailableReason();
    },
  );

  return (
    <div class="space-y-3">
      <Card
        title="Compilation"
        subtitle="How your project compiles to PDF when you write."
      >
        <Show when={!isTauriMobile()}>
          <Row
            label="Default engine"
            hint="Default for projects without their own build settings (set those in the editor's build menu). System TeX uses your local install; Tectonic is self-contained."
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
          <div class="flex items-center gap-2 border-t border-glass-stroke px-5 py-2.5">
            <Show
              when={engineStatus()}
              fallback={
                <span class="text-xs text-fg-3">
                  {texProbe.loading ? "Checking installed TeX tools…" : "TeX detection unavailable"}
                </span>
              }
            >
              <Show when={engineStatus()!.tone === "ok"}>
                <Check
                  size={12}
                  stroke-width={3}
                  style={{ color: "var(--color-ok)" }}
                />
              </Show>
              <span
                class={`select-text text-xs ${engineStatus()!.tone === "ok" ? "text-fg-2" : ""}`}
                style={
                  engineStatus()!.tone === "ok"
                    ? undefined
                    : { color: ENGINE_STATUS_COLOR[engineStatus()!.tone] }
                }
              >
                {engineStatus()!.text}
              </span>
            </Show>
            <Button
              variant="ghost"
              size="sm"
              class="ml-auto h-7"
              disabled={texProbe.loading}
              onClick={() => void refetchTexProbe()}
            >
              Re-check
            </Button>
          </div>
        </Show>
        <Show when={compileEngine() === "texlive-wasm"}>
          <Row
            label="TeX Live (WASM) engine"
            hint="Compiles LaTeX on-device. Its engine and TeX tree assets are downloaded when the app is built."
          >
            <Show
              when={wasmAssets.loading || wasmAssets() !== null}
              fallback={<span class="text-sm text-fg-2">Installed</span>}
            >
              <span
                class="select-text text-right text-xs"
                style={{ color: wasmAssets.loading ? undefined : "var(--color-err)" }}
              >
                {wasmAssets.loading ? "Checking…" : wasmAssets()}
              </span>
            </Show>
          </Row>
        </Show>
        <ToggleRow
          label="Auto-compile on save"
          hint="Recompile automatically after each save (Mod+S)."
          checked={editorSettings().autoCompile}
          onChange={(v) => update("autoCompile", v)}
        />
        <ToggleRow
          label="Stop on first error"
          hint="Halt latexmk/pdflatex at the first error. Off = push through and collect every diagnostic in one pass (Tectonic always halts)."
          checked={editorSettings().stopOnFirstError}
          onChange={(v) => update("stopOnFirstError", v)}
        />
        <ToggleRow
          label="Autosave"
          hint="Write changes to disk automatically after an idle pause."
          checked={editorSettings().autosaveEnabled}
          onChange={(v) => update("autosaveEnabled", v)}
        />
        <Row
          label="Autosave delay"
          hint="Idle time before changes are saved (crash-recovery snapshot when autosave is off)."
        >
          <SelectStub
            value={`${editorSettings().autosaveDelayMs} ms`}
            options={[300, 500, 1000, 2000].map((n) => ({
              value: n,
              label: `${n} ms`,
            }))}
            onChange={(v) => update("autosaveDelayMs", Number(v))}
          />
        </Row>
      </Card>

      <Card
        title="File history"
        subtitle="Every save keeps a local version of the file (at most one per five minutes), restorable from the editor's History tab. Free, on this device only."
      >
        <div class="px-5 py-4">
          <Slider
            label="Versions kept per file"
            value={historyMaxVersions()}
            onChange={setHistoryMaxVersions}
            min={10}
            max={200}
            step={5}
          />
        </div>
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
        <ToggleRow
          label="Soft wrap long lines"
          checked={editorSettings().lineWrap}
          onChange={(v) => update("lineWrap", v)}
        />
        <Row label="Line height">
          <SelectStub
            value={editorSettings().lineHeight}
            options={(["compact", "normal", "relaxed"] as const).map((m) => ({
              value: m,
              label: m,
            }))}
            onChange={(v) => update("lineHeight", v as LineHeightMode)}
          />
        </Row>
        <Row label="Tab size" hint="Indent width in spaces.">
          <SelectStub
            value={`${editorSettings().tabSize}`}
            options={[2, 4, 8].map((n) => ({ value: n, label: `${n}` }))}
            onChange={(v) => update("tabSize", Number(v))}
          />
        </Row>
        <ToggleRow
          label="Line numbers"
          checked={editorSettings().lineNumbers}
          onChange={(v) => update("lineNumbers", v)}
        />
        <ToggleRow
          label="Highlight active line"
          checked={editorSettings().highlightActiveLine}
          onChange={(v) => update("highlightActiveLine", v)}
        />
        <ToggleRow
          label="Autocomplete"
          hint="Built-in word/snippet completion. Language-server completion is unaffected."
          checked={editorSettings().autocomplete}
          onChange={(v) => update("autocomplete", v)}
        />
        <ToggleRow
          label="Bracket matching"
          hint="Highlight the matching bracket at the cursor."
          checked={editorSettings().bracketMatching}
          onChange={(v) => update("bracketMatching", v)}
        />
        <ToggleRow
          label="Auto-close brackets"
          hint="Insert the closing bracket/quote automatically."
          checked={editorSettings().autoCloseBrackets}
          onChange={(v) => update("autoCloseBrackets", v)}
        />
        <ToggleRow
          label="Vim mode"
          hint="Modal editing bindings in the source pane."
          checked={editorSettings().vimMode}
          onChange={(v) => update("vimMode", v)}
        />
        <ToggleRow
          label="Visual editing for LaTeX"
          hint="Edit .tex files as a formatted document — markup stays hidden (Mod+Shift+V)."
          checked={editorSettings().visualModeLatex}
          onChange={(v) => update("visualModeLatex", v)}
        />
        <FeatureGate
          feature="integrations.grammar.harper"
          // The locked row is a discovery surface — without the flag the row
          // vanishes entirely (FeatureGate's default locked-renders-nothing).
          fallback={
            PRO_DISCOVERY_ENABLED ? (
              <Row
                label="Spell & grammar check"
                hint="On-device grammar and spelling via Harper. Part of Typeward Pro."
              >
                <ProChip onClick={() => setRequestProDialog(true)} />
              </Row>
            ) : undefined
          }
        >
          <ToggleRow
            label="Spell & grammar check"
            hint="Powered by Harper — configure it under Settings → Integrations → Grammar."
            checked={integrationsSettings().grammar.enabled}
            onChange={(v) =>
              setIntegrationsSettings((prev) => ({
                ...prev,
                grammar: { ...prev.grammar, enabled: v },
              }))
            }
          />
        </FeatureGate>
      </Card>

      <Card title="PDF preview" subtitle="How the compiled output is displayed.">
        <Row label="Default zoom" hint="Zoom level the preview opens at.">
          <SelectStub
            value={`${editorSettings().pdfDefaultZoom}%`}
            options={[80, 90, 100, 110, 125, 150].map((n) => ({
              value: n,
              label: `${n}%`,
            }))}
            onChange={(v) => update("pdfDefaultZoom", Number(v))}
          />
        </Row>
        <ToggleRow
          label="Invert on dark themes"
          hint="Flip the white page to dark for night reading (only while a dark theme is active)."
          checked={editorSettings().pdfInvertDark}
          onChange={(v) => update("pdfInvertDark", v)}
        />
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
  useListboxOpenFocus(open, () => rootRef);
  return (
    <div class="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open()}
        class="glass-inset flex h-8 w-[180px] items-center gap-2 rounded-md px-2.5 text-sm text-fg-1 hover:bg-[var(--color-control-fill)]"
      >
        <span class="flex-1 text-left">{props.value}</span>
        <ChevronDown size={10} style={{ opacity: 0.5 }} />
      </button>
      <Show when={open()}>
        <div
          role="listbox"
          tabindex={-1}
          onKeyDown={(e) => handleListboxKeydown(e, rootRef, () => setOpen(false))}
          class="glass absolute right-0 z-20 mt-1 w-[180px] overflow-hidden rounded-md py-1"
          style={{ background: "var(--color-popover-bg)" }}
          onClick={(e) => e.stopPropagation()}
        >
          <For each={props.options}>
            {(o) => {
              const selected = () => o.label === props.value;
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={selected()}
                  tabindex={-1}
                  onClick={() => {
                    props.onChange(o.value);
                    setOpen(false);
                  }}
                  class={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-fg-1 ${
                    selected()
                      ? "bg-[var(--color-control-fill-hover)]"
                      : "hover:bg-[var(--color-control-fill)]"
                  }`}
                >
                  <span class="flex-1">{o.label}</span>
                  <Show when={selected()}>
                    <Check
                      size={10}
                      stroke-width={3}
                      style={{ color: "var(--color-accent-1)" }}
                    />
                  </Show>
                </button>
              );
            }}
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
        action={<SoonBadge />}
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
                <div class="text-base font-medium text-fg-1">{p.label}</div>
                <Show when={p.hint}>
                  <div class="mt-0.5 text-xs text-fg-3">{p.hint}</div>
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
        action={<SoonBadge />}
      >
        <ToggleRow
          label="Quiet hours"
          checked={false}
          onChange={() => {}}
          disabled
        />
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
        title="Privacy"
        subtitle="What leaves this machine. Everything is off by default."
      >
        <ToggleRow
          label="Share crash reports"
          hint="Send crash and error reports to Sentry to help fix bugs: enables in-app error reporting and an automatic scan for crashes from previous runs at launch. Off keeps diagnostics in the local log only (browse and report individual events under Diagnostics). Takes effect immediately."
          checked={shareCrashReports()}
          onChange={setShareCrashReports}
        />
      </Card>

      <Card
        title="Feedback"
        subtitle="Nothing is sent unless you press Send on the feedback card."
      >
        <ToggleRow
          label="Occasionally ask for feedback"
          hint="Every once in a while (at most once a month), show a small card asking how Typeward is working for you. You can always send feedback yourself via the command palette."
          checked={feedbackPromptsEnabled()}
          onChange={setFeedbackPromptsEnabled}
        />
      </Card>

      <Card
        title="Two-factor authentication"
        subtitle="Add a second factor to protect your account."
        action={<SoonBadge />}
      >
        <Row label="Authenticator app" hint="Configured once cloud auth lands.">
          <Button variant="secondary" size="sm" class="h-8" disabled>
            Reconfigure
          </Button>
        </Row>
        <Row label="Recovery codes" hint="One-time codes printed when 2FA is set up.">
          <Button variant="secondary" size="sm" class="h-8" disabled>
            View codes
          </Button>
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
            <div class="text-base font-medium" style={{ color: "var(--color-err)" }}>
              Reset local app data
            </div>
            <div class="mt-0.5 text-xs text-fg-2">
              Restores default settings and clears local UI state. Your project
              files on disk are untouched; the app reloads afterwards.
            </div>
          </div>
          <Button
            variant="danger"
            size="sm"
            class="h-8"
            onClick={() => void resetAppData()}
          >
            Reset
          </Button>
        </div>
      </Card>
    </div>
  );
};

// =================================================================
// About — version + updates
// =================================================================

const AboutPanel: Component = () => {
  const [info] = createResource(() => ipc.collectSystemInfo().catch(() => null));
  const [checking, setChecking] = createSignal(false);

  const check = async () => {
    if (checking()) return;
    setChecking(true);
    try {
      await checkForUpdates({ silent: false });
    } finally {
      setChecking(false);
    }
  };

  return (
    <div class="space-y-3">
      <Card
        title="About Typeward"
        subtitle="The installed build and how updates are handled."
      >
        <Row label="Version" hint="The version of Typeward you're running.">
          <span class="mono select-text text-sm text-fg-1">
            {info()?.appVersion ?? "…"}
          </span>
        </Row>
        <Show when={!isTauriMobile()}>
          <Row
            label="Check for updates"
            hint="Look for a newer release right now. This is a plain HTTPS request to GitHub — no identifiers are sent."
          >
            <Button
              variant="secondary"
              size="sm"
              class="h-8"
              disabled={checking()}
              onClick={() => void check()}
            >
              {checking() ? "Checking…" : "Check now"}
            </Button>
          </Row>
          <ToggleRow
            label="Check automatically"
            hint="Shortly after launch, look for a newer release and prompt you to install it. The check is a plain HTTPS GET to GitHub with no identifiers, and updates never install without your confirmation."
            checked={updatesCheckAutomatically()}
            onChange={setUpdatesCheckAutomatically}
          />
        </Show>
      </Card>
    </div>
  );
};

