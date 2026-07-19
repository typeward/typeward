import { describeIpcError } from "~/lib/errors";
import { useNavigate } from "@solidjs/router";
import {
  AlertTriangle,
  ArrowRight,
  ArrowLeft,
  BadgeCheck,
  Check,
  Cloud,
  Cpu,
  Loader2,
  Mail,
  Package,
  RefreshCw,
  Shield,
  Sigma,
} from "lucide-solid";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Component, JSX } from "solid-js";
import { For, Match, Show, Switch as SolidSwitch, createMemo, createSignal, onMount } from "solid-js";
import { SignInForm } from "~/components/account/SignInForm";
import { AmbientBackdrop } from "~/components/layout/AmbientBackdrop";
import { Button } from "~/components/primitives/Button";
import { setRequestProDialog } from "~/commands/palette-store";
import {
  PRO_DISCOVERY_ENABLED,
  PRO_FEATURES,
  PRO_PRICING_LINE,
} from "~/config/pro";
import { supabaseEnabled } from "~/integrations/supabase/client";
import {
  supabaseSession,
  supabaseSessionReady,
  supabaseUser,
} from "~/integrations/supabase/session";
import { dismissBootSplash } from "~/lib/boot-splash";
import * as ipc from "~/ipc";
import {
  setCompileEngine,
  setOnboarded,
  syncSettingsEnabled,
} from "~/stores/settings-store";

// The Rust detector also probes pandoc (unused since Markdown-as-project was
// dropped) and typst (Pro — its setup lives behind the gate, not in the free
// first run). Only the LaTeX chain matters here.
const RELEVANT_ENGINES = (engines: ipc.EngineProbe["engines"]) =>
  engines.filter((e) => e.name !== "pandoc" && e.name !== "typst");

type StepId = "welcome" | "engines" | "account" | "plan";
// The account step ships in both flag states — it pitches the FREE account
// behind settings sync, not Pro. The closing plan-awareness step ships with
// the rest of the Pro discovery layer (skipped during the free-only beta)
// and returns AFTER the account step when the flag flips. Exported so the
// flag-state tests can pin both compositions.
export const STEP_ORDER: StepId[] = PRO_DISCOVERY_ENABLED
  ? ["welcome", "engines", "account", "plan"]
  : ["welcome", "engines", "account"];

const OnboardingScreen: Component = () => {
  const navigate = useNavigate();
  const [step, setStep] = createSignal<StepId>("welcome");
  const [probe, setProbe] = createSignal<ipc.EngineProbe | null>(null);
  const [probing, setProbing] = createSignal(false);
  const [probeError, setProbeError] = createSignal<string | null>(null);

  const stepIndex = createMemo(() => STEP_ORDER.indexOf(step()));

  onMount(() => dismissBootSplash());

  const goNext = () => {
    const i = stepIndex();
    if (i < STEP_ORDER.length - 1) setStep(STEP_ORDER[i + 1]);
    else finish();
  };

  const goBack = () => {
    const i = stepIndex();
    if (i > 0) setStep(STEP_ORDER[i - 1]);
  };

  const runProbe = async () => {
    setProbing(true);
    setProbeError(null);
    try {
      const result = await ipc.detectTex();
      setProbe(result);
    } catch (e) {
      setProbeError(describeIpcError(e));
    } finally {
      setProbing(false);
    }
  };

  const finish = (path = "/projects") => {
    void (async () => {
      // The engine probe normally runs on step 2 — but the welcome step's
      // skip button calls finish() directly, and defaulting to Tectonic on a
      // machine with a full TeX Live install would be wrong. Probe first.
      let p = probe();
      if (!p) {
        try {
          p = await ipc.detectTex();
        } catch {
          // Detection unavailable — fall back to the bundled engine.
        }
      }
      setCompileEngine(p?.anyLatexAvailable ? "system-tex" : "tectonic");
      setOnboarded(true);
      navigate(path);
    })();
  };

  return (
    <div class="no-emoji relative h-full w-full overflow-hidden bg-bg-base">
      <AmbientBackdrop />
      <div class="relative z-10 flex h-full items-center justify-center p-8">
        <div
          class="flex w-[760px] max-w-full max-h-full flex-col overflow-hidden rounded-[18px]"
          style={{
            background: "var(--color-popover-bg)",
            border: "1px solid var(--color-glass-stroke)",
            "backdrop-filter": "blur(28px) saturate(140%)",
            "-webkit-backdrop-filter": "blur(28px) saturate(140%)",
            "box-shadow": "var(--shadow-glass-inset), var(--shadow-glass-drop)",
          }}
        >
          <StepBar step={stepIndex()} />
          <div class="relative min-h-0 flex-1 overflow-y-auto scroll">
            <SolidSwitch>
              <Match when={step() === "welcome"}>
                <WelcomePane />
              </Match>
              <Match when={step() === "engines"}>
                <EnginesPane
                  probe={probe()}
                  probing={probing()}
                  error={probeError()}
                  onProbe={() => void runProbe()}
                  onMount={() => {
                    if (!probe() && !probing()) void runProbe();
                  }}
                />
              </Match>
              <Match when={step() === "account"}>
                <AccountPane />
              </Match>
              <Match when={step() === "plan"}>
                <PlanPane />
              </Match>
            </SolidSwitch>
          </div>
          <Footer
            step={step()}
            stepIndex={stepIndex()}
            probe={probe()}
            onBack={goBack}
            onNext={goNext}
            onFinish={() => finish()}
          />
        </div>
      </div>
    </div>
  );
};

export default OnboardingScreen;

// =================================================================
// Stepper bar (top of modal)
// =================================================================

const StepBar: Component<{ step: number }> = (props) => (
  <div class="flex h-[56px] flex-shrink-0 items-center border-b border-glass-stroke px-[22px]">
    <div
      class="flex h-6 w-6 items-center justify-center rounded-[7px] text-xs font-bold"
      style={{
        background: "linear-gradient(135deg, var(--color-accent-2) 0%, var(--color-accent-1) 100%)",
        color: "var(--color-accent-fg)",
      }}
    >
      τ
    </div>
    <span class="ml-2.5 text-base font-semibold tracking-tight text-fg-1">
      Typeward
    </span>
    <span class="mono ml-2.5 text-xs text-fg-3">· first run · v{__APP_VERSION__}</span>
    <div class="ml-auto flex items-center gap-1.5">
      <For each={STEP_ORDER}>
        {(_, i) => {
          const done = () => i() < props.step;
          const cur = () => i() === props.step;
          return (
            <>
              <div
                class="rounded transition-all"
                style={{
                  width: cur() ? "20px" : "8px",
                  height: "8px",
                  background: cur()
                    ? "linear-gradient(90deg, var(--color-accent-1), var(--color-accent-2))"
                    : done()
                      ? "var(--color-accent-2)"
                      : "var(--color-control-stroke)",
                }}
              />
              <Show when={i() < STEP_ORDER.length - 1}>
                <div class="h-px w-[14px]" style={{ background: "var(--color-control-stroke)" }} />
              </Show>
            </>
          );
        }}
      </For>
      <span class="mono ml-2 text-xs text-fg-3">
        {props.step + 1}/{STEP_ORDER.length}
      </span>
    </div>
  </div>
);

// =================================================================
// Footer (next/back/finish)
// =================================================================

// The plan step's two actions are deliberately equal-weight: finishing on
// Free and reading about Pro are both fine outcomes — no preselected upsell.
// The account step's "Skip for now" shares the same quiet weight so skipping
// never feels like the wrong choice.
const EQUAL_BTN =
  "flex h-[38px] items-center gap-2 rounded-[10px] border border-glass-stroke px-[18px] text-base font-medium text-fg-1 hover:bg-[var(--color-control-fill)]";

const Footer: Component<{
  step: StepId;
  stepIndex: number;
  probe: ipc.EngineProbe | null;
  onBack: () => void;
  onNext: () => void;
  onFinish: () => void;
}> = (props) => {
  const leftText = createMemo<JSX.Element>(() => {
    switch (props.step) {
      case "welcome":
        return (
          <span class="flex items-center gap-1.5">
            <Shield size={12} class="text-fg-2" />
            Local-first · your files stay on this machine
          </span>
        );
      case "engines": {
        const probe = props.probe;
        if (!probe) return <span>Scanning your PATH…</span>;
        const engines = RELEVANT_ENGINES(probe.engines);
        const ready = engines.filter((e) => e.installed).length;
        return <span>{ready} ready · {engines.length - ready} missing</span>;
      }
      case "account":
        return <span>Optional — you can sign in any time in Settings → Account</span>;
      case "plan":
        // The "Already have an account? Sign in" escape hatch that lived here
        // is superseded by the account step one step back.
        return undefined;
    }
  });

  return (
    <div
      class="flex h-[64px] flex-shrink-0 items-center border-t border-glass-stroke px-[22px]"
      style={{ background: "var(--color-overlay-dim)" }}
    >
      <div class="text-sm text-fg-2">{leftText()}</div>
      <div class="ml-auto flex items-center gap-2">
        <Show when={props.stepIndex > 0}>
          <button
            type="button"
            onClick={props.onBack}
            class="flex h-8 items-center gap-1.5 rounded-lg border border-glass-stroke px-3.5 text-sm text-fg-2 hover:bg-[var(--color-control-fill)]"
          >
            <ArrowLeft size={12} />
            Back
          </button>
        </Show>
        <Show when={props.step === "welcome"}>
          <button
            type="button"
            onClick={props.onFinish}
            class="h-8 rounded-lg border border-glass-stroke px-3.5 text-sm text-fg-2 hover:bg-[var(--color-control-fill)]"
          >
            Skip setup
          </button>
        </Show>
        <SolidSwitch
          fallback={
            <Button
              variant="primary"
              size="lg"
              class="glow-accent font-semibold"
              onClick={props.onNext}
              trailingIcon={<ArrowRight size={12} stroke-width={2.2} />}
            >
              Continue
            </Button>
          }
        >
          {/* Signed out, the pane's Sign in button is the primary action —
              the footer only offers the skip, which advances all the same.
              Signing in swaps this for the regular Continue. */}
          <Match when={props.step === "account" && !supabaseSession()}>
            <button type="button" onClick={props.onNext} class={EQUAL_BTN}>
              Skip for now
              <ArrowRight size={12} stroke-width={2.2} />
            </button>
          </Match>
          <Match when={props.step === "plan"}>
            <button
              type="button"
              onClick={() => setRequestProDialog(true)}
              class={EQUAL_BTN}
            >
              See what's in Pro
            </button>
            <button type="button" onClick={props.onFinish} class={EQUAL_BTN}>
              Get started
              <ArrowRight size={12} stroke-width={2.2} />
            </button>
          </Match>
        </SolidSwitch>
      </div>
    </div>
  );
};

// =================================================================
// Step 1 — Welcome
// =================================================================

const GLYPHS: Array<{ t: string; x: string; y: number; s: number; rot: number; op: number; weight?: number }> = [
  { t: "τ", x: "18%", y: 6, s: 54, rot: -8, op: 0.85 },
  { t: "∫", x: "31%", y: 30, s: 78, rot: 6, op: 0.9 },
  { t: "∑", x: "46%", y: 0, s: 96, rot: 0, op: 1, weight: 600 },
  { t: "∂", x: "62%", y: 32, s: 64, rot: -6, op: 0.85 },
  { t: "¶", x: "76%", y: 14, s: 48, rot: 10, op: 0.8 },
];

const FORMAT_PILLS = [
  { icon: Sigma, label: "LaTeX", pro: false },
  { icon: Package, label: "Typst", pro: true },
];

const WelcomePane: Component = () => (
  <div class="relative px-[22px] pb-9 pt-[42px] text-center" style={{ "min-height": "380px" }}>
    {/* Glyph collage */}
    <div
      class="relative mx-auto flex items-center justify-center"
      style={{ height: "140px", "margin-bottom": "24px", "font-family": "'Times New Roman', serif" }}
    >
      <For each={GLYPHS}>
        {(g, i) => (
          <span
            class="absolute italic"
            style={{
              left: g.x,
              top: `${g.y}px`,
              "font-size": `${g.s}px`,
              color:
                i() === 0 || i() === 4
                  ? "var(--color-accent-1)"
                  : i() === 2
                    ? "var(--color-fg-1)"
                    : "var(--color-accent-2)",
              opacity: g.op,
              transform: `rotate(${g.rot}deg)`,
              "font-weight": g.weight ?? 400,
              "text-shadow":
                i() === 2
                  ? "0 0 30px color-mix(in srgb, var(--color-fg-1) 45%, transparent)"
                  : "0 0 30px color-mix(in srgb, var(--color-accent-1) 45%, transparent)",
            }}
          >
            {g.t}
          </span>
        )}
      </For>
    </div>

    <h1
      class="m-0 mb-2.5 text-[30px] font-semibold tracking-tight text-fg-1"
      style={{ "text-wrap": "balance" }}
    >
      Welcome to <span class="accent-text">Typeward</span>
    </h1>
    <p
      class="mx-auto m-0 max-w-[460px] text-base leading-[1.55] text-fg-2"
      style={{ "text-wrap": "pretty" }}
    >
      A calm, local-first LaTeX editor. We'll check your TeX setup and get you
      writing in under a minute — no account needed.
    </p>

    <div class="mt-7 flex justify-center gap-2.5">
      {/* Pro-format pills are discovery surfaces — free-only beta shows
          only what the free tier can actually use. */}
      <For each={FORMAT_PILLS.filter((b) => PRO_DISCOVERY_ENABLED || !b.pro)}>
        {(b) => (
          <div
            class="flex h-7 items-center gap-1.5 rounded-[14px] px-2.5 text-sm text-fg-2"
            style={{
              background: "var(--color-control-fill)",
              border: "1px solid var(--color-control-stroke)",
            }}
          >
            <b.icon size={12} style={{ color: "var(--color-accent-2)" }} />
            {b.label}
            <Show when={b.pro}>
              <span class="mono text-[10px] uppercase tracking-wider text-fg-3">
                Pro
              </span>
            </Show>
          </div>
        )}
      </For>
    </div>
  </div>
);

// =================================================================
// Step 2 — Engine detection
// =================================================================

const ENGINE_META: Record<string, { glyph: string; color: string; label: string; sub: string }> = {
  pdflatex: { glyph: "τ", color: "var(--format-latex)", label: "pdfLaTeX", sub: "Used for LaTeX" },
  xelatex: { glyph: "τ", color: "var(--format-latex)", label: "XeLaTeX", sub: "Unicode-aware LaTeX" },
  lualatex: { glyph: "τ", color: "var(--format-latex)", label: "LuaLaTeX", sub: "LaTeX with Lua scripting" },
  latexmk: { glyph: "λ", color: "var(--format-latex)", label: "latexmk", sub: "Build manager for LaTeX" },
  tectonic: { glyph: "T", color: "var(--color-accent-2)", label: "Tectonic", sub: "Bundled with Typeward" },
};

const EnginesPane: Component<{
  probe: ipc.EngineProbe | null;
  probing: boolean;
  error: string | null;
  onProbe: () => void;
  onMount: () => void;
}> = (props) => {
  onMount(() => props.onMount());
  return (
    <div class="px-[22px] py-6">
      <div class="mb-[18px] flex items-start gap-3.5">
        <div
          class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[9px]"
          style={{
            background:
              "linear-gradient(135deg, color-mix(in srgb, var(--color-accent-1) 20%, transparent), color-mix(in srgb, var(--color-accent-2) 13%, transparent))",
            border: "1px solid color-mix(in srgb, var(--color-accent-1) 20%, transparent)",
          }}
        >
          <Cpu size={16} style={{ color: "var(--color-accent-1)" }} />
        </div>
        <div class="flex-1">
          <h2 class="m-0 mb-1 text-[18px] font-semibold tracking-tight text-fg-1">
            Checking your TeX setup
          </h2>
          <p class="m-0 text-sm text-fg-2">
            Typeward compiles with your system TeX when you have one, or its
            bundled Tectonic engine — zero install either way.
          </p>
        </div>
        <button
          type="button"
          onClick={() => props.onProbe()}
          disabled={props.probing}
          class="flex h-7 items-center gap-1.5 rounded-[7px] px-2.5 text-xs text-fg-2 hover:bg-[var(--color-control-fill-hover)]"
          style={{
            background: "var(--color-control-fill)",
            border: "1px solid var(--color-control-stroke)",
          }}
        >
          <RefreshCw size={10} class={props.probing ? "animate-spin" : ""} />
          Re-scan
        </button>
      </div>

      <Show when={props.probing && !props.probe}>
        <div class="flex h-32 items-center justify-center gap-2 text-sm text-fg-2">
          <Loader2 size={14} class="animate-spin" />
          Scanning…
        </div>
      </Show>

      <Show when={props.error}>
        <div
          class="select-text rounded-md p-3 text-sm"
          style={{
            background: "color-mix(in srgb, var(--color-err) 6%, transparent)",
            border: "1px solid color-mix(in srgb, var(--color-err) 18%, transparent)",
            color: "var(--color-err)",
          }}
        >
          {props.error}
        </div>
      </Show>

      <Show when={props.probe}>
        <div class="flex flex-col gap-2">
          <For each={RELEVANT_ENGINES(props.probe!.engines)}>
            {(e) => {
              const meta = ENGINE_META[e.name] ?? {
                glyph: e.name[0]?.toUpperCase() ?? "?",
                color: "var(--color-fg-3)",
                label: e.name,
                sub: "",
              };
              const ok = e.installed;
              return (
                <div
                  class="relative flex items-center gap-3 rounded-[11px] py-3 pl-[14px] pr-3.5"
                  style={{
                    background: "var(--color-glass-soft-fill)",
                    border: "1px solid var(--color-glass-stroke)",
                    "border-left": `2px solid ${ok ? "var(--color-ok)" : "var(--color-accent-1)"}`,
                  }}
                >
                  <div
                    class="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg italic font-semibold"
                    style={{
                      background: `linear-gradient(135deg, color-mix(in srgb, ${meta.color} 20%, transparent), color-mix(in srgb, ${meta.color} 7%, transparent))`,
                      border: `1px solid color-mix(in srgb, ${meta.color} 20%, transparent)`,
                      "font-family": "'Times New Roman', serif",
                      "font-size": "17px",
                      color: meta.color,
                    }}
                  >
                    {meta.glyph}
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-baseline gap-2">
                      <span class="text-base font-semibold text-fg-1">{meta.label}</span>
                      <span class="text-xs text-fg-3">{meta.sub}</span>
                    </div>
                    <div
                      class="mono mt-0.5 truncate text-xs"
                      style={{ color: ok ? "var(--color-fg-2)" : "var(--color-err)" }}
                    >
                      {ok ? (e.version ?? e.path ?? "found") : `${e.name} not on PATH`}
                    </div>
                  </div>
                  <Show
                    when={ok}
                    fallback={
                      <span class="text-xs text-fg-3">
                        Install it, then Re-scan
                      </span>
                    }
                  >
                    <div
                      class="flex items-center gap-1.5 rounded-[14px] px-2.5 py-1 text-xs font-medium"
                      style={{
                        background: "color-mix(in srgb, var(--color-ok) 12%, transparent)",
                        color: "var(--color-ok)",
                      }}
                    >
                      <Check size={12} stroke-width={2.5} />
                      Ready
                    </div>
                  </Show>
                </div>
              );
            }}
          </For>
        </div>

        <Show when={!props.probe!.anyLatexAvailable}>
          <div
            class="mt-3 flex items-start gap-2.5 rounded-[9px] px-3 py-2.5"
            style={{
              background: "color-mix(in srgb, var(--color-warn) 8%, transparent)",
              border: "1px solid color-mix(in srgb, var(--color-warn) 25%, transparent)",
            }}
          >
            <AlertTriangle size={14} class="mt-0.5" style={{ color: "var(--color-warn)" }} />
            <div class="text-sm text-fg-2">
              <span class="font-semibold text-fg-1">No system TeX detected — </span>
              that's fine: Typeward's bundled Tectonic engine compiles LaTeX
              with nothing to install. Prefer a full TeX Live? Get it from{" "}
              <button
                type="button"
                onClick={() => void openUrl("https://tug.org/texlive/")}
                class="mono underline underline-offset-2"
                style={{ color: "var(--color-warn)" }}
              >
                tug.org
              </button>
              . Either choice can be changed later in Settings → Editor.
            </div>
          </div>
        </Show>
      </Show>
    </div>
  );
};

// =================================================================
// Step 3 — Account (free settings sync)
// =================================================================

const AccountPane: Component = () => (
  <div class="px-[22px] py-6">
    <div class="mb-[18px] flex items-start gap-3.5">
      <div
        class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[9px]"
        style={{
          background:
            "linear-gradient(135deg, color-mix(in srgb, var(--color-accent-1) 20%, transparent), color-mix(in srgb, var(--color-accent-2) 13%, transparent))",
          border: "1px solid color-mix(in srgb, var(--color-accent-1) 20%, transparent)",
        }}
      >
        <Cloud size={16} style={{ color: "var(--color-accent-1)" }} />
      </div>
      <div>
        <h2 class="m-0 mb-1 text-[18px] font-semibold tracking-tight text-fg-1">
          Take your settings anywhere
        </h2>
        <p class="m-0 text-sm text-fg-2">
          A free account syncs your preferences — theme, editor, workspace —
          across devices. The editor works fully without one.
        </p>
      </div>
    </div>

    <Show
      when={supabaseEnabled()}
      fallback={
        <div
          class="rounded-[11px] px-3.5 py-3 text-sm text-fg-2"
          style={{
            background: "var(--color-glass-soft-fill)",
            border: "1px solid var(--color-glass-stroke)",
          }}
        >
          Sign-in isn't configured for this build — skip ahead; everything
          else works without it.
        </div>
      }
    >
      <Show
        when={supabaseSessionReady()}
        fallback={
          <div class="flex h-24 items-center justify-center gap-2 text-sm text-fg-2">
            <Loader2 size={14} class="animate-spin" />
            Restoring session…
          </div>
        }
      >
        <Show when={supabaseSession()} fallback={<AccountSignedOut />}>
          <AccountSignedIn />
        </Show>
      </Show>
    </Show>
  </div>
);

const AccountSignedOut: Component = () => (
  <div
    class="rounded-[11px] px-3.5 py-3"
    style={{
      background: "var(--color-glass-soft-fill)",
      border: "1px solid var(--color-glass-stroke)",
    }}
  >
    <SignInForm />
  </div>
);

const AccountSignedIn: Component = () => (
  <div class="flex flex-col gap-2">
    <div
      class="rounded-[11px] px-3.5 py-3"
      style={{
        background: "var(--color-glass-soft-fill)",
        border: "1px solid var(--color-glass-stroke)",
      }}
    >
      <div class="flex items-center gap-2.5">
        <Mail size={14} class="flex-shrink-0 text-fg-3" />
        <span class="min-w-0 flex-1 truncate text-base font-semibold text-fg-1">
          {supabaseUser()?.email}
        </span>
        <div
          class="flex items-center gap-1.5 rounded-[14px] px-2.5 py-1 text-xs font-medium"
          style={{
            background: "color-mix(in srgb, var(--color-ok) 12%, transparent)",
            color: "var(--color-ok)",
          }}
        >
          <Check size={12} stroke-width={2.5} />
          Signed in
        </div>
      </div>
    </div>
    <Show
      when={syncSettingsEnabled()}
      fallback={
        <div class="text-xs text-fg-3">
          Settings sync is off for this device — turn it on any time in
          Settings → Account.
        </div>
      }
    >
      <div
        class="flex items-start gap-2.5 rounded-[9px] px-3 py-2.5"
        style={{
          background: "color-mix(in srgb, var(--color-ok) 8%, transparent)",
          border: "1px solid color-mix(in srgb, var(--color-ok) 25%, transparent)",
        }}
      >
        <RefreshCw size={14} class="mt-0.5" style={{ color: "var(--color-ok)" }} />
        <div class="text-sm text-fg-2">
          <span class="font-semibold text-fg-1">Settings sync is on — </span>
          your preferences follow this account to any device you sign in on.
        </div>
      </div>
    </Show>
  </div>
);

// =================================================================
// Step 4 — Plan awareness (Pro discovery layer only)
// =================================================================

const PlanPane: Component = () => (
  <div class="px-[22px] py-6">
    <div class="mb-[18px] flex items-start gap-3.5">
      <div
        class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[9px]"
        style={{
          background:
            "linear-gradient(135deg, color-mix(in srgb, var(--color-accent-1) 20%, transparent), color-mix(in srgb, var(--color-accent-2) 13%, transparent))",
          border: "1px solid color-mix(in srgb, var(--color-accent-1) 20%, transparent)",
        }}
      >
        <BadgeCheck size={16} style={{ color: "var(--color-accent-1)" }} />
      </div>
      <div>
        <h2 class="m-0 mb-1 text-[18px] font-semibold tracking-tight text-fg-1">
          You're ready to write
        </h2>
        <p class="m-0 text-sm text-fg-2">
          Typeward Free is the full LaTeX editor — no account needed.
        </p>
      </div>
    </div>

    <div class="flex flex-col gap-2">
      <div
        class="rounded-[11px] px-3.5 py-3"
        style={{
          background: "var(--color-glass-soft-fill)",
          border: "1px solid var(--color-glass-stroke)",
        }}
      >
        <div class="text-base font-semibold text-fg-1">Typeward Free</div>
        <div class="mt-0.5 text-xs leading-relaxed text-fg-2">
          Edit, compile, and preview LaTeX with SyncTeX; built-in templates,
          themes, autosave and recovery, PDF and source exports. Everything
          works offline.
        </div>
      </div>

      <div
        class="rounded-[11px] px-3.5 py-3"
        style={{
          background: "var(--color-glass-soft-fill)",
          border: "1px solid var(--color-glass-stroke)",
        }}
      >
        <div class="flex flex-wrap items-baseline gap-x-2">
          <span class="text-base font-semibold text-fg-1">Typeward Pro</span>
          <span class="text-xs text-fg-3">{PRO_PRICING_LINE}</span>
        </div>
        <div class="mt-0.5 text-xs leading-relaxed text-fg-2">
          {PRO_FEATURES.map((f) => f.label).join(" · ")}
        </div>
      </div>
    </div>
  </div>
);
