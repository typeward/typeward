import {
  BookMarked,
  ChevronRight,
  FileText,
  FlaskConical,
  GitBranch,
  Globe,
  GraduationCap,
  PenTool,
  Play,
  Send,
  Sparkles,
  Upload,
} from "lucide-solid";
import type { Component, JSX } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { projects } from "~/stores/projects-store";

/**
 * Full-width hero panel above the Projects toolbar — restored from the
 * original design after a brief stint as the smaller Compose / Recent
 * widget cards. Two columns: prompt + template strip on the left, weekly
 * activity + pinned action on the right.
 *
 * The Compose flow itself is a stub for now (prompt text is illustrative,
 * the Compose button just opens the New-project dialog). The AI-driven
 * compose pipeline lands alongside the AI provider config in a follow-up.
 */

interface Template {
  id: string;
  label: string;
  sub: string;
  icon: Component<{ size?: number; class?: string }>;
  tint: string;
}

const TEMPLATES: Template[] = [
  { id: "icml", label: "ICML", sub: "two-column · 8pt", icon: GraduationCap, tint: "#A78BFA" },
  { id: "neurips", label: "NeurIPS", sub: "two-column · 10pt", icon: FlaskConical, tint: "#67E8F9" },
  { id: "thesis", label: "Thesis", sub: "monograph · 11pt", icon: BookMarked, tint: "#FBBF24" },
  { id: "arxiv", label: "arXiv", sub: "single column · 11pt", icon: Globe, tint: "#34D399" },
  { id: "letter", label: "Letter", sub: "a4 · 12pt", icon: PenTool, tint: "#F472B6" },
  { id: "blank", label: "Blank", sub: "article · 11pt", icon: FileText, tint: "#9CA3AF" },
];

export const ComposerHero: Component<{
  onCompose: () => void;
  onOpenProject?: (rootPath: string) => void;
}> = (props) => {
  const [tpl, setTpl] = createSignal<string>("icml");
  const pinned = () => projects()[0] ?? null;

  return (
    <div class="glass relative overflow-hidden rounded-2xl" style={{ padding: 0 }}>
      <div class="composer-glow absolute left-0 right-0 top-0 h-[1px] opacity-60" />

      <div class="flex gap-5 p-5">
        {/* Left: prompt + templates */}
        <div class="min-w-0 flex-1">
          <div class="mb-3 flex items-center gap-2">
            <div class="flex h-5 w-5 items-center justify-center rounded-md accent-grad">
              <Sparkles size={12} stroke-width={2.2} />
            </div>
            <span class="label-xs" style={{ color: "var(--color-accent-1)" }}>
              Compose
            </span>
            <span class="mono text-[length:var(--ui-font-xs)] text-fg-3">
              ·&nbsp;&nbsp;describe what you want to write, or pick a template
            </span>
          </div>

          <div class="glass-inset flex min-h-[112px] flex-col rounded-xl p-3">
            <div class="flex-1 text-[length:var(--ui-font-base)] leading-relaxed text-fg-1">
              A short paper on{" "}
              <span class="accent-text font-medium">
                log-Sobolev convergence rates
              </span>{" "}
              for non-convex Langevin dynamics, targeting NeurIPS — set up the
              abstract, theorem environment, and a bibliography seeded with my
              Zotero library
              <span class="caret" />
            </div>
            <div class="-mb-0.5 mt-3 flex items-center gap-1.5">
              <ComposerChip icon={<Upload class="ui-icon-sm" style={{ opacity: 0.7 }} />}>
                Attach
              </ComposerChip>
              <ComposerChip icon={<BookMarked class="ui-icon-sm" style={{ opacity: 0.7 }} />}>
                Zotero
              </ComposerChip>
              <ComposerChip icon={<GitBranch class="ui-icon-sm" style={{ opacity: 0.7 }} />}>
                Import repo
              </ComposerChip>
              <div class="ml-auto flex items-center gap-2">
                <div class="mono text-[length:var(--ui-font-xs)] text-fg-3">
                  142 / 2k
                </div>
                <button
                  type="button"
                  onClick={() => props.onCompose()}
                  class="lift glow-violet flex items-center gap-1.5 rounded-md accent-grad pl-2.5 pr-2 text-[length:var(--ui-font-sm)] font-semibold text-white"
                  style={{ height: "var(--ui-row-sm)" }}
                >
                  <span>Compose</span>
                  <Send size={11} stroke-width={2.2} />
                </button>
              </div>
            </div>
          </div>

          <div class="mt-4">
            <div class="mb-2 flex items-center justify-between">
              <span class="label-xs text-fg-3">Or start from</span>
              <button
                type="button"
                class="mono flex items-center gap-1 text-[length:var(--ui-font-xs)] text-fg-2 hover:text-fg-1"
              >
                browse all templates
                <ChevronRight size={10} style={{ opacity: 0.6 }} />
              </button>
            </div>
            <div class="grid grid-cols-6 gap-2">
              <For each={TEMPLATES}>
                {(t) => {
                  const active = () => tpl() === t.id;
                  return (
                    <button
                      type="button"
                      onClick={() => setTpl(t.id)}
                      class={`lift relative rounded-xl px-3 py-3 text-left ${
                        active()
                          ? "bg-[var(--color-selection-bg)]"
                          : "glass-soft hover:bg-[var(--color-control-fill)]"
                      }`}
                      style={
                        active()
                          ? {
                              "box-shadow":
                                "inset 0 0 0 1px rgba(139,92,246,0.45), 0 6px 18px rgba(139,92,246,0.18)",
                            }
                          : undefined
                      }
                    >
                      <div
                        class="mb-2 flex h-7 w-7 items-center justify-center rounded-lg"
                        style={{
                          background: active()
                            ? "rgba(139,92,246,0.16)"
                            : "var(--color-control-fill)",
                          color: t.tint,
                        }}
                      >
                        <t.icon size={14} />
                      </div>
                      <div class="text-[length:var(--ui-font-sm)] font-semibold text-fg-1">
                        {t.label}
                      </div>
                      <div class="mono mt-0.5 text-[length:var(--ui-font-xs)] text-fg-3">
                        {t.sub}
                      </div>
                      <Show when={active()}>
                        <div class="absolute right-2 top-2 h-2 w-2 rounded-full accent-grad" />
                      </Show>
                    </button>
                  );
                }}
              </For>
            </div>
          </div>
        </div>

        {/* Right: activity + pinned */}
        <div class="flex w-[228px] flex-shrink-0 flex-col gap-2">
          <div class="glass-soft rounded-xl p-3">
            <div class="flex items-center justify-between">
              <span class="label-xs text-fg-3">Activity</span>
              <span class="mono text-[length:var(--ui-font-xs)] text-fg-2">
                7d
              </span>
            </div>
            <div class="mt-1 flex items-baseline gap-1.5">
              <span class="text-[length:var(--ui-font-xl)] font-semibold tracking-tight text-fg-1">
                {projects().length}
              </span>
              <span class="mono text-[length:var(--ui-font-xs)] text-fg-3">
                projects
              </span>
            </div>
            <div class="mono text-[length:var(--ui-font-xs)] text-fg-3">
              total in library
            </div>
            <svg class="mt-2" width="200" height="32" viewBox="0 0 200 32">
              <defs>
                <linearGradient id="spk" x1="0" x2="1">
                  <stop offset="0" stop-color="var(--color-accent-1)" />
                  <stop offset="1" stop-color="var(--color-accent-2)" />
                </linearGradient>
                <linearGradient id="spkfill" x1="0" x2="0" y1="0" y2="1">
                  <stop
                    offset="0"
                    stop-color="var(--color-accent-1)"
                    stop-opacity="0.18"
                  />
                  <stop
                    offset="1"
                    stop-color="var(--color-accent-2)"
                    stop-opacity="0"
                  />
                </linearGradient>
              </defs>
              <path
                d="M0,28 L20,26 L40,27 L60,24 L80,25 L100,22 L120,23 L140,20 L160,21 L180,18 L200,19 L200,32 L0,32 Z"
                fill="url(#spkfill)"
              />
              <path
                d="M0,28 L20,26 L40,27 L60,24 L80,25 L100,22 L120,23 L140,20 L160,21 L180,18 L200,19"
                fill="none"
                stroke="url(#spk)"
                stroke-width="1.6"
              />
            </svg>
          </div>

          <div class="glass-soft rounded-xl p-3">
            <div class="label-xs mb-2 text-fg-3">Pinned action</div>
            <Show
              when={pinned()}
              fallback={
                <div class="text-[length:var(--ui-font-xs)] text-fg-3">
                  No projects yet — create one to pin.
                </div>
              }
            >
              <div class="flex items-center gap-2.5">
                <div class="thumb flex h-11 w-9 flex-shrink-0 flex-col gap-0.5 rounded p-1">
                  <div
                    class="doc-line darker"
                    style={{ height: "1.5px", width: "70%" }}
                  />
                  <div class="doc-line" style={{ height: "1px", width: "90%" }} />
                  <div class="doc-line" style={{ height: "1px", width: "85%" }} />
                  <div
                    class="doc-line dim"
                    style={{ height: "1px", width: "60%" }}
                  />
                  <div class="doc-line" style={{ height: "1px", width: "80%" }} />
                  <div
                    class="doc-line dim"
                    style={{ height: "1px", width: "45%" }}
                  />
                </div>
                <div class="min-w-0 flex-1">
                  <div class="truncate text-[length:var(--ui-font-sm)] font-medium text-fg-1">
                    {pinned()!.name}
                  </div>
                  <div class="mono text-[length:var(--ui-font-xs)] text-fg-3">
                    {pinned()!.rootFile}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => props.onOpenProject?.(pinned()!.rootPath)}
                class="lift mt-2 flex w-full items-center justify-center gap-1.5 rounded-md accent-grad text-[length:var(--ui-font-sm)] font-semibold text-white"
                style={{ height: "var(--ui-row-sm)" }}
              >
                <Play size={11} stroke-width={2.2} />
                <span>Open editor</span>
              </button>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
};

const ComposerChip: Component<{ icon: JSX.Element; children: JSX.Element }> = (
  props,
) => (
  <button
    type="button"
    class="lift glass-soft flex items-center gap-1.5 rounded-md px-2.5 text-[length:var(--ui-font-xs)] text-fg-2 hover:bg-[var(--color-control-fill-hover)]"
    style={{ height: "var(--ui-row-sm)" }}
  >
    {props.icon}
    <span>{props.children}</span>
  </button>
);
