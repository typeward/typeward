import { describeIpcError } from "~/lib/errors";
import { useNavigate } from "@solidjs/router";
import {
  AlertTriangle,
  ArrowRight,
  ArrowLeft,
  Check,
  Cpu,
  Loader2,
  Package,
  RefreshCw,
  Shield,
  Sigma,
} from "lucide-solid";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Component, JSX } from "solid-js";
import { For, Match, Show, Switch as SolidSwitch, createMemo, createSignal, onMount } from "solid-js";
import { AmbientBackdrop } from "~/components/layout/AmbientBackdrop";
import { BrandMark } from "~/components/primitives/BrandMark";
import { Button } from "~/components/primitives/Button";
import { dismissBootSplash } from "~/lib/boot-splash";
import * as ipc from "~/ipc";
import { setCompileEngine, setOnboarded } from "~/stores/settings-store";

// The Rust detector also probes pandoc, which no supported project format
// compiles through since Markdown-as-project was dropped. Everything else is
// an engine a project can actually build with, typst included.
const RELEVANT_ENGINES = (engines: ipc.EngineProbe["engines"]) =>
  engines.filter((e) => e.name !== "pandoc");

type StepId = "welcome" | "engines";
// Exported so a test can pin the composition.
export const STEP_ORDER: StepId[] = ["welcome", "engines"];

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
    <BrandMark size={24} class="flex-shrink-0" />
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
        return <span>{ready} ready · {engines.length - ready} not found</span>;
      }
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
        <Button
          variant="primary"
          size="lg"
          class="glow-accent font-semibold"
          onClick={props.onNext}
          trailingIcon={<ArrowRight size={12} stroke-width={2.2} />}
        >
          {props.stepIndex === STEP_ORDER.length - 1 ? "Get started" : "Continue"}
        </Button>
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
  { icon: Sigma, label: "LaTeX" },
  { icon: Package, label: "Typst" },
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
      writing in under a minute.
    </p>

    <div class="mt-7 flex justify-center gap-2.5">
      <For each={FORMAT_PILLS}>
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
          </div>
        )}
      </For>
    </div>
  </div>
);

// =================================================================
// Step 2 — Engine detection
// =================================================================

type EngineMeta = {
  glyph: string;
  color: string;
  label: string;
  sub: string;
  /** Set for engines no LaTeX project needs: absence is reported in muted text
   *  with a download link rather than as the red not-on-PATH state, since
   *  nothing about onboarding or compiling LaTeX depends on it. */
  optional?: { hint: string; url: string };
};

const ENGINE_META: Record<string, EngineMeta> = {
  pdflatex: { glyph: "τ", color: "var(--format-latex)", label: "pdfLaTeX", sub: "Used for LaTeX" },
  xelatex: { glyph: "τ", color: "var(--format-latex)", label: "XeLaTeX", sub: "Unicode-aware LaTeX" },
  lualatex: { glyph: "τ", color: "var(--format-latex)", label: "LuaLaTeX", sub: "LaTeX with Lua scripting" },
  latexmk: { glyph: "λ", color: "var(--format-latex)", label: "latexmk", sub: "Build manager for LaTeX" },
  tectonic: { glyph: "T", color: "var(--color-accent-2)", label: "Tectonic", sub: "Bundled with Typeward" },
  typst: {
    glyph: "t",
    color: "var(--format-typst)",
    label: "Typst",
    sub: "Only for Typst projects",
    optional: { hint: "Get it from typst.app", url: "https://typst.app/download" },
  },
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
            Checking your typesetting setup
          </h2>
          <p class="m-0 text-sm text-fg-2">
            {(props.probe?.tectonicBundled ?? true)
              ? "Typeward compiles LaTeX with your system TeX when you have one, or its bundled Tectonic engine; zero install either way. Typst is optional and compiles through its own CLI."
              : "Typeward compiles LaTeX with your system TeX. This build does not include the bundled Tectonic engine, so install a TeX distribution (or the tectonic CLI) if you don't have one yet. Typst is optional and compiles through its own CLI."}
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
              const meta: EngineMeta = ENGINE_META[e.name] ?? {
                glyph: e.name[0]?.toUpperCase() ?? "?",
                color: "var(--color-fg-3)",
                label: e.name,
                sub: "",
              };
              // ARM64 Windows/Linux builds ship without the Tectonic sidecar;
              // "Bundled with Typeward" would be a false promise there, and a
              // missing tectonic is optional (system TeX works), not an error.
              const tectonicUnbundled =
                e.name === "tectonic" && !props.probe!.tectonicBundled;
              const sub = tectonicUnbundled
                ? "Optional, not included in this build"
                : meta.sub;
              const ok = e.installed;
              const optional = tectonicUnbundled
                ? {
                    hint: "Get it from tectonic-typesetting.github.io",
                    url: "https://tectonic-typesetting.github.io/",
                  }
                : meta.optional;
              const missingTone = optional ? "var(--color-fg-3)" : "var(--color-err)";
              return (
                <div
                  class="relative flex items-center gap-3 rounded-[11px] py-3 pl-[14px] pr-3.5"
                  style={{
                    background: "var(--color-glass-soft-fill)",
                    border: "1px solid var(--color-glass-stroke)",
                    "border-left": `2px solid ${
                      ok
                        ? "var(--color-ok)"
                        : optional
                          ? "var(--color-control-stroke)"
                          : "var(--color-accent-1)"
                    }`,
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
                      <span class="text-xs text-fg-3">{sub}</span>
                    </div>
                    <div
                      class="mono mt-0.5 truncate text-xs"
                      style={{ color: ok ? "var(--color-fg-2)" : missingTone }}
                    >
                      {ok ? (e.version ?? e.path ?? "found") : `${e.name} not on PATH`}
                    </div>
                  </div>
                  <Show
                    when={ok}
                    fallback={
                      optional ? (
                        <button
                          type="button"
                          onClick={() => void openUrl(optional.url)}
                          class="flex-shrink-0 text-xs text-fg-3 underline underline-offset-2 hover:text-fg-2"
                        >
                          {optional.hint}
                        </button>
                      ) : (
                        <span class="text-xs text-fg-3">
                          Install it, then Re-scan
                        </span>
                      )
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
              <span class="font-semibold text-fg-1">No system TeX detected. </span>
              <Show
                when={props.probe!.tectonicBundled}
                fallback={
                  <>
                    This build does not include the Tectonic engine, so LaTeX
                    needs a TeX installation. Get TeX Live from{" "}
                    <button
                      type="button"
                      onClick={() => void openUrl("https://tug.org/texlive/")}
                      class="mono underline underline-offset-2"
                      style={{ color: "var(--color-warn)" }}
                    >
                      tug.org
                    </button>
                    , or install the tectonic CLI yourself. The engine can be
                    changed later in Settings → Editor.
                  </>
                }
              >
                That's fine: Typeward's bundled Tectonic engine compiles LaTeX
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
              </Show>
            </div>
          </div>
        </Show>
      </Show>
    </div>
  );
};

