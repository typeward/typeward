import { useNavigate } from "@solidjs/router";
import {
  AlertTriangle,
  ArrowRight,
  ArrowLeft,
  Check,
  Cpu,
  Download,
  Loader2,
  Package,
  RefreshCw,
  Shield,
  Sigma,
} from "lucide-solid";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Component } from "solid-js";
import { For, Match, Show, Switch as SolidSwitch, createMemo, createSignal, onMount } from "solid-js";
import { AmbientBackdrop } from "~/components/layout/AmbientBackdrop";
import * as ipc from "~/ipc";
import { setCompileEngine, setOnboarded } from "~/stores/settings-store";

// Pandoc is probed by the Rust detector but unused since Markdown-as-project
// was dropped — don't show it or count it as "missing".
const RELEVANT_ENGINES = (engines: ipc.EngineProbe["engines"]) =>
  engines.filter((e) => e.name !== "pandoc");

type StepId = "welcome" | "formats" | "engines" | "install";
const STEP_ORDER: StepId[] = ["welcome", "formats", "engines", "install"];

// Format options shown on Step 2.
interface FormatOption {
  id: "latex" | "typst";
  name: string;
  glyph: string;
  desc: string;
  color: string;
  size: string;
  engine: string;
  recommended?: boolean;
}

const FORMATS: FormatOption[] = [
  {
    id: "latex",
    name: "LaTeX",
    glyph: "τ",
    desc: "Mathematical typesetting · papers, theses",
    color: "var(--format-latex)",
    size: "4.2 GB",
    engine: "TeX Live · pdflatex / xelatex / lualatex",
    recommended: true,
  },
  {
    id: "typst",
    name: "Typst",
    glyph: "§",
    desc: "Modern compile-fast alternative to LaTeX",
    color: "var(--format-typst)",
    size: "62 MB",
    engine: "typst CLI · v0.13",
    recommended: true,
  },
];

const OnboardingScreen: Component = () => {
  const navigate = useNavigate();
  const [step, setStep] = createSignal<StepId>("welcome");
  const [picked, setPicked] = createSignal<Set<FormatOption["id"]>>(
    new Set(["latex"]),
  );
  const [probe, setProbe] = createSignal<ipc.EngineProbe | null>(null);
  const [probing, setProbing] = createSignal(false);
  const [probeError, setProbeError] = createSignal<string | null>(null);

  const stepIndex = createMemo(() => STEP_ORDER.indexOf(step()));

  const goNext = () => {
    const i = stepIndex();
    if (i < STEP_ORDER.length - 1) setStep(STEP_ORDER[i + 1]);
    else finish();
  };

  const goBack = () => {
    const i = stepIndex();
    if (i > 0) setStep(STEP_ORDER[i - 1]);
  };

  const togglePick = (id: FormatOption["id"]) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runProbe = async () => {
    setProbing(true);
    setProbeError(null);
    try {
      const result = await ipc.detectTex();
      setProbe(result);
    } catch (e) {
      setProbeError(String(e));
    } finally {
      setProbing(false);
    }
  };

  const finish = () => {
    void (async () => {
      // The engine probe normally runs on step 3 — but the welcome step's
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
      navigate("/projects");
    })();
  };

  return (
    <div class="no-emoji relative h-full w-full overflow-hidden bg-bg-base">
      <AmbientBackdrop />
      <div class="relative z-10 flex h-full items-center justify-center p-8">
        <div
          class="flex w-[760px] max-w-full flex-col overflow-hidden rounded-[18px]"
          style={{
            background: "var(--color-popover-bg)",
            border: "1px solid var(--color-glass-stroke)",
            "backdrop-filter": "blur(28px) saturate(140%)",
            "-webkit-backdrop-filter": "blur(28px) saturate(140%)",
            "box-shadow": "var(--shadow-glass-inset), var(--shadow-glass-drop)",
          }}
        >
          <StepBar step={stepIndex()} />
          <div class="relative flex-1">
            <SolidSwitch>
              <Match when={step() === "welcome"}>
                <WelcomePane />
              </Match>
              <Match when={step() === "formats"}>
                <FormatsPane picked={picked()} onToggle={togglePick} />
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
              <Match when={step() === "install"}>
                <InstallPane picked={picked()} probe={probe()} />
              </Match>
            </SolidSwitch>
          </div>
          <Footer
            step={step()}
            stepIndex={stepIndex()}
            picked={picked()}
            probe={probe()}
            onBack={goBack}
            onNext={goNext}
            onFinish={finish}
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
      class="flex h-6 w-6 items-center justify-center rounded-[7px] text-[11px] font-bold"
      style={{
        background: "linear-gradient(135deg, var(--color-accent-2) 0%, var(--color-accent-1) 100%)",
        color: "var(--color-accent-fg)",
      }}
    >
      τ
    </div>
    <span class="ml-2.5 text-[13px] font-semibold tracking-tight text-fg-1">
      Typeward
    </span>
    <span class="mono ml-2.5 text-[11px] text-fg-3">· first run · v0.0.1</span>
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
      <span class="mono ml-2 text-[11px] text-fg-3">
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
  picked: Set<FormatOption["id"]>;
  probe: ipc.EngineProbe | null;
  onBack: () => void;
  onNext: () => void;
  onFinish: () => void;
}> = (props) => {
  const leftText = createMemo(() => {
    switch (props.step) {
      case "welcome":
        return (
          <span class="flex items-center gap-1.5">
            <Shield size={12} class="text-fg-2" />
            Local-first · your files stay on this machine
          </span>
        );
      case "formats":
        return (
          <span>
            {props.picked.size} of {FORMATS.length} selected · adjust later in
            Settings
          </span>
        );
      case "engines": {
        const probe = props.probe;
        if (!probe) return <span>Scanning your PATH…</span>;
        const engines = RELEVANT_ENGINES(probe.engines);
        const ready = engines.filter((e) => e.installed).length;
        return <span>{ready} ready · {engines.length - ready} missing</span>;
      }
      case "install":
        return <span>Engines can be changed anytime in Settings → Editor.</span>;
    }
  });

  const primaryLabel = createMemo(() => {
    if (props.step === "welcome") return "Get started";
    if (props.step === "install") return "Open Typeward";
    return "Continue";
  });

  return (
    <div
      class="flex h-[64px] flex-shrink-0 items-center border-t border-glass-stroke px-[22px]"
      style={{ background: "var(--color-overlay-dim)" }}
    >
      <div class="text-[12px] text-fg-2">{leftText()}</div>
      <div class="ml-auto flex items-center gap-2">
        <Show when={props.stepIndex > 0}>
          <button
            type="button"
            onClick={props.onBack}
            class="flex h-8 items-center gap-1.5 rounded-lg border border-glass-stroke px-3.5 text-[12px] text-fg-2 hover:bg-[var(--color-control-fill)]"
          >
            <ArrowLeft size={12} />
            Back
          </button>
        </Show>
        <Show when={props.step === "welcome"}>
          <button
            type="button"
            onClick={props.onFinish}
            class="h-8 rounded-lg border border-glass-stroke px-3.5 text-[12px] text-fg-2 hover:bg-[var(--color-control-fill)]"
          >
            Skip setup
          </button>
        </Show>
        <button
          type="button"
          onClick={props.step === "install" ? props.onFinish : props.onNext}
          class="glow-accent flex h-[38px] items-center gap-2 rounded-[10px] px-[18px] text-[13px] font-semibold accent-grad"
        >
          {primaryLabel()}
          <ArrowRight size={12} stroke-width={2.2} />
        </button>
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
      class="mx-auto m-0 max-w-[460px] text-[14px] leading-[1.55] text-fg-2"
      style={{ "text-wrap": "pretty" }}
    >
      A calm editor for the documents that matter. We'll set up the engines you
      need and get you writing in under two minutes.
    </p>

    <div class="mt-7 flex justify-center gap-2.5">
      <For each={FORMAT_PILLS}>
        {(b) => (
          <div
            class="flex h-7 items-center gap-1.5 rounded-[14px] px-2.5 text-[12px] text-fg-2"
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
// Step 2 — Formats
// =================================================================

const FormatsPane: Component<{
  picked: Set<FormatOption["id"]>;
  onToggle: (id: FormatOption["id"]) => void;
}> = (props) => (
  <div class="px-[22px] pt-7 pb-[22px]">
    <h2 class="m-0 mb-1.5 text-[20px] font-semibold tracking-tight text-fg-1">
      What do you write?
    </h2>
    <p class="m-0 mb-5 text-[13px] text-fg-2">
      Pick what you write — the next step checks your machine for the right
      engines. You can add more later.
    </p>

    <div class="grid grid-cols-2 gap-2.5">
      <For each={FORMATS}>
        {(f) => {
          const on = () => props.picked.has(f.id);
          return (
            <button
              type="button"
              onClick={() => props.onToggle(f.id)}
              class="relative cursor-pointer rounded-xl p-3.5 text-left transition-all"
              style={{
                background: on() ? "var(--color-control-fill)" : "var(--color-glass-soft-fill)",
                border: on()
                  ? "1px solid color-mix(in srgb, var(--color-accent-1) 45%, transparent)"
                  : "1px solid var(--color-control-stroke)",
                "box-shadow": on()
                  ? "0 0 0 1px color-mix(in srgb, var(--color-accent-1) 20%, transparent), 0 8px 24px color-mix(in srgb, var(--color-accent-1) 10%, transparent)"
                  : "none",
              }}
            >
              <Show when={f.recommended}>
                <div
                  class="absolute right-3 -top-[7px] rounded-md px-2 py-[2px] text-[10px] font-semibold uppercase tracking-[0.06em] accent-grad"
                >
                  Recommended
                </div>
              </Show>
              <div class="flex items-center gap-2.5">
                <div
                  class="flex h-[38px] w-[38px] items-center justify-center rounded-[9px] italic font-semibold"
                  style={{
                    background: `linear-gradient(135deg, color-mix(in srgb, ${f.color} 20%, transparent), color-mix(in srgb, ${f.color} 7%, transparent))`,
                    border: `1px solid color-mix(in srgb, ${f.color} 20%, transparent)`,
                    "font-family": "'Times New Roman', serif",
                    "font-size": "20px",
                    color: f.color,
                  }}
                >
                  {f.glyph}
                </div>
                <div class="min-w-0 flex-1">
                  <div class="text-[14px] font-semibold text-fg-1">{f.name}</div>
                  <div class="mt-px text-[11px] text-fg-2">{f.desc}</div>
                </div>
                <div
                  class="flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-full"
                  style={
                    on()
                      ? { background: "linear-gradient(135deg, var(--color-accent-1), var(--color-accent-2))" }
                      : {
                          border: "1.5px solid var(--color-control-stroke)",
                        }
                  }
                >
                  <Show when={on()}>
                    <Check size={10} stroke-width={3} style={{ color: "var(--color-accent-fg)" }} />
                  </Show>
                </div>
              </div>
              <div
                class="mono mt-2.5 flex items-center gap-2 border-t border-glass-stroke pt-2 text-[11px] text-fg-3"
              >
                <Package size={10} />
                <span class="flex-1 truncate">{f.engine}</span>
              </div>
            </button>
          );
        }}
      </For>
    </div>
  </div>
);

// =================================================================
// Step 3 — Engine detection
// =================================================================

const ENGINE_META: Record<string, { glyph: string; color: string; label: string; sub: string }> = {
  pdflatex: { glyph: "τ", color: "var(--format-latex)", label: "pdfLaTeX", sub: "Used for LaTeX" },
  xelatex: { glyph: "τ", color: "var(--format-latex)", label: "XeLaTeX", sub: "Unicode-aware LaTeX" },
  lualatex: { glyph: "τ", color: "var(--format-latex)", label: "LuaLaTeX", sub: "LaTeX with Lua scripting" },
  latexmk: { glyph: "λ", color: "var(--format-latex)", label: "latexmk", sub: "Build manager for LaTeX" },
  tectonic: { glyph: "T", color: "var(--color-accent-2)", label: "Tectonic", sub: "Lightweight TeX engine" },
  typst: { glyph: "§", color: "var(--format-typst)", label: "Typst", sub: "Modern typesetter" },
  pandoc: { glyph: "#", color: "var(--color-fg-3)", label: "Pandoc", sub: "Universal document converter" },
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
            Checking your system
          </h2>
          <p class="m-0 text-[12px] leading-[1.5] text-fg-2">
            We scanned for the engines your formats need. Here's what we found.
          </p>
        </div>
        <button
          type="button"
          onClick={() => props.onProbe()}
          disabled={props.probing}
          class="flex h-7 items-center gap-1.5 rounded-[7px] px-2.5 text-[11px] text-fg-2 hover:bg-[var(--color-control-fill-hover)]"
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
        <div class="flex h-32 items-center justify-center gap-2 text-[12px] text-fg-2">
          <Loader2 size={14} class="animate-spin" />
          Scanning…
        </div>
      </Show>

      <Show when={props.error}>
        <div
          class="rounded-md p-3 text-[12px]"
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
                      <span class="text-[13px] font-semibold text-fg-1">{meta.label}</span>
                      <span class="text-[11px] text-fg-3">{meta.sub}</span>
                    </div>
                    <div
                      class="mono mt-0.5 truncate text-[11px]"
                      style={{ color: ok ? "var(--color-fg-2)" : "var(--color-err)" }}
                    >
                      {ok ? (e.version ?? e.path ?? "found") : `${e.name} not on PATH`}
                    </div>
                  </div>
                  <Show
                    when={ok}
                    fallback={
                      <span class="text-[11px] text-fg-3">
                        Install it, then Re-scan
                      </span>
                    }
                  >
                    <div
                      class="flex items-center gap-1.5 rounded-[14px] px-2.5 py-1 text-[11px] font-medium"
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
            <div class="text-[12px] leading-[1.5] text-fg-2">
              <span class="font-semibold text-fg-1">No LaTeX engine detected — </span>
              You can install TeX Live from{" "}
              <button
                type="button"
                onClick={() => void openUrl("https://tug.org/texlive/")}
                class="mono underline underline-offset-2"
                style={{ color: "var(--color-warn)" }}
              >
                tug.org
              </button>
              , or use Typeward's bundled Tectonic engine. Either choice can be
              changed later in Settings.
            </div>
          </div>
        </Show>
      </Show>
    </div>
  );
};

// =================================================================
// Step 4 — Install
// =================================================================

const InstallPane: Component<{
  picked: Set<FormatOption["id"]>;
  probe: ipc.EngineProbe | null;
}> = (props) => {
  // No runtime installer exists — Tectonic ships bundled and Typst is a
  // user install detected on PATH. This pane is an honest summary of what
  // each picked format will use, not a fake progress screen.
  const items = createMemo(() => {
    const out: Array<{ id: string; name: string; sub: string; ready: boolean }> = [];
    if (props.picked.has("latex")) {
      const systemTex = props.probe?.anyLatexAvailable ?? false;
      out.push({
        id: "latex",
        name: "LaTeX",
        sub: systemTex
          ? "System TeX detected — Typeward will use it."
          : "No system TeX found — Typeward's bundled Tectonic engine will be used. Nothing to download.",
        ready: true,
      });
    }
    if (props.picked.has("typst")) {
      const typstReady =
        props.probe?.engines.some((e) => e.name === "typst" && e.installed) ?? false;
      out.push({
        id: "typst",
        name: "Typst",
        sub: typstReady
          ? "typst CLI detected on PATH — ready."
          : "Install the typst CLI from typst.app — Typeward detects it on PATH automatically.",
        ready: typstReady,
      });
    }
    return out;
  });

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
          <Download size={16} style={{ color: "var(--color-accent-1)" }} />
        </div>
        <div>
          <h2 class="m-0 mb-1 text-[18px] font-semibold tracking-tight text-fg-1">
            You're set
          </h2>
          <p class="m-0 text-[12px] leading-[1.5] text-fg-2">
            Here's what each format will compile with. Engines can be changed
            anytime in Settings → Editor.
          </p>
        </div>
      </div>

      <div class="flex flex-col gap-2">
        <For each={items()}>
          {(t) => (
            <div
              class="flex items-center gap-2.5 rounded-[11px] px-3.5 py-3"
              style={{
                background: "var(--color-glass-soft-fill)",
                border: "1px solid var(--color-glass-stroke)",
              }}
            >
              <div
                class="flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded-full"
                style={
                  t.ready
                    ? {
                        background: "color-mix(in srgb, var(--color-ok) 15%, transparent)",
                        border: "1px solid color-mix(in srgb, var(--color-ok) 40%, transparent)",
                      }
                    : {
                        background: "color-mix(in srgb, var(--color-warn) 12%, transparent)",
                        border: "1px solid color-mix(in srgb, var(--color-warn) 35%, transparent)",
                      }
                }
              >
                <Show
                  when={t.ready}
                  fallback={<AlertTriangle size={11} style={{ color: "var(--color-warn)" }} />}
                >
                  <Check size={12} stroke-width={2.5} style={{ color: "var(--color-ok)" }} />
                </Show>
              </div>
              <div class="min-w-0 flex-1">
                <span class="text-[13px] font-semibold text-fg-1">{t.name}</span>
                <div class="mt-0.5 text-[11px] text-fg-2">{t.sub}</div>
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  );
};
