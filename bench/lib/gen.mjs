// Deterministic corpus generation for the long-document benchmarks
// (docs/plans/2026-08-03-long-document-performance.md, Phase 0).
//
// Everything is derived from a seeded PRNG — same seed, same bytes, so corpus
// content hashes are assertable in CI. No wall clock, no Math.random.

import { deflateSync } from "node:zlib";

/* ------------------------------------------------------------------ */
/* PRNG + prose                                                        */
/* ------------------------------------------------------------------ */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ASCII-only, nothing that needs TeX escaping.
const WORDS = (
  "analysis approach argument assumption asymptotic average basis bound " +
  "boundary calculation candidate case category class coefficient comparison " +
  "component composition computation concept condition configuration " +
  "consequence constant constraint construction context convergence corollary " +
  "correspondence criterion decomposition definition density derivation " +
  "description dimension distribution domain effect element equation error " +
  "estimate evaluation evidence example existence expansion experiment " +
  "expression extension factor family feature form formulation framework " +
  "function generalization hypothesis identity implication improvement " +
  "inequality instance integral interaction interpretation interval invariant " +
  "iteration kernel lemma limit magnitude mapping matrix measure mechanism " +
  "method metric model motivation norm notation notion object observation " +
  "operator order outcome parameter partition pattern perspective phase " +
  "polynomial population practice precision prediction principle problem " +
  "procedure process product proof property proposition quantity question " +
  "range ratio reduction reference refinement region relation remainder " +
  "representation residual resolution response restriction result sample " +
  "scheme sequence series setting significance simulation solution space " +
  "spectrum stability statement strategy structure subset substitution sum " +
  "support surface symmetry system technique term theorem theory threshold " +
  "transformation transition treatment uncertainty validity value variable " +
  "variance variation vector"
).split(" ");

// Single-word prefixes (determiners and adjectives mixed) — one is prepended
// to ~12% of words. Kept as the exact historical draw pool so corpus bytes
// stay stable.
const CONNECTIVES = [
  "the", "a", "this", "each", "every", "some", "the", "given", "the",
  "resulting", "the", "corresponding", "an", "auxiliary", "the", "underlying",
  "the", "associated", "a", "suitable", "the", "standard",
];

const VERBS = (
  "admits captures characterizes constrains defines depends describes " +
  "determines dominates establishes exhibits extends follows generalizes " +
  "holds implies improves induces motivates preserves quantifies recovers " +
  "reduces refines relates requires satisfies simplifies suggests supports " +
  "yields"
).split(" ");

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function cap(w) {
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/**
 * One prose sentence, optionally decorated with inline markup / a citation /
 * a reference so the corpus exercises real editor paths, not plain text.
 * `inline` is {cite, ref, markup} of callback generators or null.
 */
function sentence(rng, inline) {
  const parts = [];
  const clauses = 1 + (rng() < 0.3 ? 1 : 0);
  for (let c = 0; c < clauses; c++) {
    const words = 6 + Math.floor(rng() * 7);
    for (let i = 0; i < words; i++) {
      let w = rng() < 0.18 ? pick(rng, VERBS) : pick(rng, WORDS);
      if (rng() < 0.12) w = `${pick(rng, CONNECTIVES)} ${w}`;
      if (inline && rng() < 0.02) w = `\\emph{${w}}`;
      else if (inline && rng() < 0.015) w = `\\textbf{${w}}`;
      parts.push(w);
    }
    if (c < clauses - 1) parts.push(parts.pop() + ",");
  }
  if (inline && inline.math && rng() < 0.08) {
    parts.push(`$${pick(rng, ["x_i", "\\alpha_k", "n \\ge 1", "f(x)", "\\lambda_j", "O(n \\log n)"])}$`);
  }
  let s = parts.join(" ");
  s = cap(s);
  if (inline && inline.cite && rng() < 0.21) s += `~\\cite{${inline.cite(rng)}}`;
  if (inline && inline.ref && rng() < 0.12) s += ` (see~\\ref{${inline.ref(rng)}})`;
  return s + ".";
}

function paragraph(rng, inline, sentences) {
  const n = sentences ?? 3 + Math.floor(rng() * 2);
  const out = [];
  for (let i = 0; i < n; i++) out.push(sentence(rng, inline));
  return out.join(" ");
}

/** Hard-wrap prose at `width` columns, breaking at spaces only. */
export function wrapText(text, width) {
  const out = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      if (line.length === 0) line = word;
      else if (line.length + 1 + word.length <= width) line += " " + word;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Bibliography                                                        */
/* ------------------------------------------------------------------ */

const SURNAMES = (
  "Abramov Bergstrom Castellanos Duran Eriksson Fontaine Grigoriev Hoffmann " +
  "Ivanova Jansen Kowalski Lindqvist Moreau Nakamura Olsen Petrova Quiroga " +
  "Rasmussen Sokolova Takahashi Ueda Vasquez Weber Xu Yamamoto Zieliski " +
  "Andersen Bianchi Costa Dubois"
).split(" ");

const GIVEN = (
  "Adele Boris Clara Dmitri Elena Farid Greta Hiroshi Ingrid Jonas Katarina " +
  "Lars Miriam Nadia Oskar Priya Quentin Rosa Stefan Tomas Ulrike Viktor " +
  "Wanda Xenia Yusuf Zofia"
).split(" ");

const JOURNALS = [
  "Journal of Computational Structures",
  "Annals of Applied Analysis",
  "Transactions on Numerical Methods",
  "Quarterly Review of Formal Systems",
  "International Journal of Measurement Theory",
  "Archive for Structural Inference",
  "Proceedings of Applied Topology",
  "Journal of Statistical Refinement",
  "Communications in Discrete Modelling",
  "Review of Iterative Computation",
];

function bibKey(i) {
  return `ref${String(i).padStart(5, "0")}`;
}

function procKey(i) {
  return `proc${String(i).padStart(3, "0")}`;
}

function titleWords(rng) {
  const n = 6 + Math.floor(rng() * 5);
  const w = [];
  for (let i = 0; i < n; i++) w.push(pick(rng, WORDS));
  return cap(w.join(" "));
}

function authors(rng) {
  const n = 1 + Math.floor(rng() * 3);
  const list = [];
  for (let i = 0; i < n; i++) {
    list.push(`${pick(rng, SURNAMES)}, ${pick(rng, GIVEN)}`);
  }
  return list.join(" and ");
}

/**
 * `entries` TOTAL entries: `proceedings` of them are @proceedings targets, a
 * deterministic 15% of the rest are @inproceedings carrying `crossref` to one
 * of those (the transitive-resolution case Phase 3's bib pruning must handle),
 * ~10% are @book, the remainder @article.
 */
export function generateBib({ entries, proceedings = 0, seed }) {
  const rng = mulberry32(seed);
  const out = [];
  for (let i = 1; i <= entries - proceedings; i++) {
    const kind = rng();
    const year = 1970 + Math.floor(rng() * 56);
    if (proceedings > 0 && kind < 0.15) {
      out.push(
        `@inproceedings{${bibKey(i)},`,
        `  author   = {${authors(rng)}},`,
        `  title    = {${titleWords(rng)}},`,
        `  crossref = {${procKey(1 + Math.floor(rng() * proceedings))}},`,
        `  pages    = {${1 + Math.floor(rng() * 400)}--${401 + Math.floor(rng() * 200)}},`,
        `}`,
        ``,
      );
    } else if (kind < 0.25) {
      out.push(
        `@book{${bibKey(i)},`,
        `  author    = {${authors(rng)}},`,
        `  title     = {${titleWords(rng)}},`,
        `  publisher = {${pick(rng, SURNAMES)} Press},`,
        `  year      = {${year}},`,
        `}`,
        ``,
      );
    } else {
      out.push(
        `@article{${bibKey(i)},`,
        `  author  = {${authors(rng)}},`,
        `  title   = {${titleWords(rng)}},`,
        `  journal = {${pick(rng, JOURNALS)}},`,
        `  year    = {${year}},`,
        `  volume  = {${1 + Math.floor(rng() * 80)}},`,
        `  number  = {${1 + Math.floor(rng() * 12)}},`,
        `  pages   = {${1 + Math.floor(rng() * 900)}--${901 + Math.floor(rng() * 99)}},`,
        `}`,
        ``,
      );
    }
  }
  // BibTeX resolves crossref only when the target appears LATER in the
  // database than every entry referencing it — proceedings go last.
  for (let p = 1; p <= proceedings; p++) {
    out.push(
      `@proceedings{${procKey(p)},`,
      `  title     = {Proceedings of the ${titleWords(rng)}},`,
      `  booktitle = {Proceedings of the ${titleWords(rng)}},`,
      `  year      = {${1980 + Math.floor(rng() * 45)}},`,
      `}`,
      ``,
    );
  }
  return out.join("\n");
}

/* ------------------------------------------------------------------ */
/* PNG figures                                                         */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * Deterministic truecolor PNG: gradient base with incompressible noise every
 * 8th row, so files land in the tens-of-KB range a real figure occupies
 * rather than deflating to nothing.
 */
export function generatePng({ width, height, seed }) {
  const rng = mulberry32(seed);
  const raw = Buffer.alloc(height * (1 + width * 3));
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    const noisy = y % 8 === 0;
    for (let x = 0; x < width; x++) {
      if (noisy) {
        raw[o++] = Math.floor(rng() * 256);
        raw[o++] = Math.floor(rng() * 256);
        raw[o++] = Math.floor(rng() * 256);
      } else {
        raw[o++] = (x * 255 / width) | 0;
        raw[o++] = (y * 255 / height) | 0;
        raw[o++] = ((x + y) * 127 / (width + height)) | 0;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ */
/* Book                                                                */
/* ------------------------------------------------------------------ */

function chapterName(i) {
  return `chapters/ch${String(i).padStart(3, "0")}`;
}

/**
 * Concentrated citation sampling: rng()^3.5 over the keyspace keeps the
 * distinct-cited set around a thousand on a 10k bibliography — a real thesis
 * cites a subset, and Phase 3's pruning payoff depends on that.
 */
function makeCiteSampler(bibEntries, proceedings) {
  const span = bibEntries - proceedings;
  return (rng) => bibKey(1 + Math.floor(Math.pow(rng(), 3.5) * span));
}

function makeRefSampler(chapters, sectionsPerChapter) {
  return (rng) => {
    const ch = 1 + Math.floor(rng() * chapters);
    if (rng() < 0.4) return `ch:${String(ch).padStart(3, "0")}`;
    return `sec:${String(ch).padStart(3, "0")}-${1 + Math.floor(rng() * sectionsPerChapter)}`;
  };
}

const EQUATION_BODIES = [
  (a, b) => `  f_{${a}}(x) = \\sum_{i=1}^{n} \\alpha_i x^{i} + \\beta_{${b}}`,
  (a, b) => `  \\Phi_{${a}}(t) = \\int_{0}^{t} g_{${b}}(s)\\, ds + \\varepsilon_{${a}}`,
  (a, b) => `  \\|u_{${a}} - u_{${b}}\\| \\le C \\, h^{p} \\log(1/h)`,
  (a, b) => `  \\mathbb{E}\\left[X_{${a}}\\right] = \\mu_{${b}} + \\sigma_{${b}}^{2} / n`,
  (a, b) => `  A_{${a}} = \\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}, \\quad \\det A_{${a}} \\ne ${b}`,
];

function chapterSource(ci, rng, opts) {
  const id = String(ci).padStart(3, "0");
  const inline = {
    cite: opts.cite,
    ref: opts.ref,
    math: true,
    markup: true,
  };
  const lines = [];
  lines.push(`\\chapter{${cap(titleWords(rng))}}`);
  lines.push(`\\label{ch:${id}}`);
  lines.push("");
  lines.push(...wrapText(paragraph(rng, inline), opts.wrap));
  lines.push("");
  lines.push(...wrapText(paragraph(rng, inline), opts.wrap));
  lines.push("");
  for (let s = 1; s <= opts.sectionsPerChapter; s++) {
    lines.push(`\\section{${cap(titleWords(rng))}}`);
    lines.push(`\\label{sec:${id}-${s}}`);
    lines.push("");
    for (let p = 0; p < opts.paragraphsPerSection; p++) {
      lines.push(...wrapText(paragraph(rng, inline), opts.wrap));
      lines.push("");
      if (p === 1 && s <= opts.equationsPerChapter) {
        lines.push(`\\begin{equation}\\label{eq:${id}-${s}}`);
        lines.push(pick(rng, EQUATION_BODIES)(ci, s));
        lines.push(`\\end{equation}`);
        lines.push("");
      }
    }
    if (s === 2) {
      lines.push(`\\begin{itemize}`);
      for (let b = 0; b < 4; b++) lines.push(`  \\item ${sentence(rng, inline)}`);
      lines.push(`\\end{itemize}`);
      lines.push("");
    }
    if (s === 3 && opts.tablesPerChapter > 0) {
      lines.push(`\\begin{table}[htbp]`);
      lines.push(`  \\centering`);
      lines.push(`  \\begin{tabular}{lrr}`);
      lines.push(`    Case & Estimate & Residual \\\\`);
      lines.push(`    \\hline`);
      for (let r = 0; r < 4; r++) {
        lines.push(
          `    ${pick(rng, WORDS)} & ${(rng() * 100).toFixed(2)} & ${(rng() * 1).toFixed(4)} \\\\`,
        );
      }
      lines.push(`  \\end{tabular}`);
      lines.push(`  \\caption{${cap(titleWords(rng))}.}`);
      lines.push(`  \\label{tab:${id}}`);
      lines.push(`\\end{table}`);
      lines.push("");
    }
    if (opts.figures && s <= 2) {
      const fig = 1 + Math.floor(rng() * opts.figureCount);
      lines.push(`\\begin{figure}[htbp]`);
      lines.push(`  \\centering`);
      lines.push(
        `  \\includegraphics[width=0.72\\textwidth]{figures/fig${String(fig).padStart(3, "0")}}`,
      );
      lines.push(`  \\caption{${cap(titleWords(rng))}.}`);
      lines.push(`  \\label{fig:${id}-${s}}`);
      lines.push(`\\end{figure}`);
      lines.push("");
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Full book corpus as Map<relPath, string|Buffer>. Defaults are calibrated
 * for ~800 output pages at 11pt book on a stock TeX distro.
 */
export function generateBook({
  chapters = 143,
  sectionsPerChapter = 4,
  paragraphsPerSection = 3,
  equationsPerChapter = 3,
  tablesPerChapter = 1,
  bibEntries = 10000,
  proceedings = 200,
  figures = false,
  figureCount = 150,
  biblatex = false,
  wrap = 78,
  seed = 20260803,
  name = "bench-book",
} = {}) {
  const files = new Map();
  const cite = makeCiteSampler(bibEntries, proceedings);
  const ref = makeRefSampler(chapters, sectionsPerChapter);
  const chOpts = {
    sectionsPerChapter,
    paragraphsPerSection,
    equationsPerChapter,
    tablesPerChapter,
    figures,
    figureCount,
    wrap,
    cite,
    ref,
  };

  for (let c = 1; c <= chapters; c++) {
    // Per-chapter seed: editing one chapter never shifts another's content.
    const rng = mulberry32(seed ^ (c * 0x9e3779b9));
    files.set(`${chapterName(c)}.tex`, chapterSource(c, rng, chOpts));
  }

  files.set("refs/references.bib", generateBib({ entries: bibEntries, proceedings, seed: seed ^ 0xb1b }));

  if (figures) {
    for (let f = 1; f <= figureCount; f++) {
      const w = 512 + ((f * 97) % 384);
      const h = 384 + ((f * 61) % 288);
      files.set(
        `figures/fig${String(f).padStart(3, "0")}.png`,
        generatePng({ width: w, height: h, seed: seed ^ (f * 0x85ebca6b) }),
      );
    }
  }

  const main = [];
  main.push(`\\documentclass[11pt]{book}`);
  main.push(`\\usepackage{graphicx}`);
  main.push(`\\usepackage{amsmath,amssymb}`);
  if (biblatex) {
    main.push(`\\usepackage[backend=biber,style=numeric]{biblatex}`);
    main.push(`\\addbibresource{refs/references.bib}`);
  }
  main.push(`\\usepackage[hidelinks]{hyperref}`);
  main.push(``);
  main.push(`\\title{${cap(titleWords(mulberry32(seed)))}}`);
  main.push(`\\author{Bench Corpus Generator}`);
  main.push(`\\date{2026}`);
  main.push(``);
  main.push(`\\begin{document}`);
  main.push(`\\frontmatter`);
  main.push(`\\maketitle`);
  main.push(`\\tableofcontents`);
  main.push(`\\mainmatter`);
  for (let c = 1; c <= chapters; c++) main.push(`\\include{${chapterName(c)}}`);
  main.push(`\\backmatter`);
  if (biblatex) {
    main.push(`\\printbibliography`);
  } else {
    main.push(`\\bibliographystyle{plain}`);
    main.push(`\\bibliography{refs/references}`);
  }
  main.push(`\\end{document}`);
  main.push(``);
  files.set("main.tex", main.join("\n"));

  files.set(
    ".typeward/project.json",
    JSON.stringify({ rootPath: "", rootFile: "main.tex", format: "latex", name }, null, 2) + "\n",
  );
  return files;
}

/* ------------------------------------------------------------------ */
/* Long single chapter                                                 */
/* ------------------------------------------------------------------ */

/**
 * Exactly `lines` lines of structurally valid LaTeX (balanced environments;
 * padding is comment lines). `wrap` tunes bytes-per-line: ~40 keeps a 30k-line
 * document under the visual editor's 1.5 MB size gate, ~60 is realistic
 * hand-wrapped prose for the on-disk 50k corpus.
 */
export function generateLongChapterText({ lines, seed = 20260803, wrap = 60 }) {
  const rng = mulberry32(seed);
  const inline = { cite: null, ref: null, math: true, markup: true };
  const out = [];
  out.push(`\\chapter{${cap(titleWords(rng))}}`);
  out.push(`\\label{ch:long}`);
  out.push("");
  let section = 0;
  let sinceSection = 0;
  let paragraphs = 0;
  // Environments stop 60 lines before target so trimming never lands inside.
  while (out.length < lines - 1) {
    const room = lines - 1 - out.length;
    if (sinceSection > 220 && room > 80) {
      section += 1;
      out.push(`\\section{${cap(titleWords(rng))}}`);
      out.push(`\\label{sec:long-${section}}`);
      out.push("");
      sinceSection = 0;
      continue;
    }
    if (paragraphs > 0 && paragraphs % 9 === 0 && room > 60) {
      out.push(`\\begin{equation}\\label{eq:long-${paragraphs}}`);
      out.push(pick(rng, EQUATION_BODIES)(section, paragraphs));
      out.push(`\\end{equation}`);
      out.push("");
      paragraphs += 1;
      sinceSection += 4;
      continue;
    }
    const para = wrapText(paragraph(rng, inline), wrap);
    // Whole paragraphs only: a truncated wrapped paragraph can cut an
    // \emph{...} or $...$ mid-construct and the file stops compiling
    // (seed-dependent). The shortfall is comment-padded below.
    if (para.length > room) break;
    out.push(...para);
    out.push("");
    paragraphs += 1;
    sinceSection += para.length + 1;
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  while (out.length < lines) out.push(`% padding line ${out.length + 1}`);
  return out.slice(0, lines).join("\n");
}

/** Small project wrapping one long chapter, openable as a Typeward project. */
export function generateLongChapterProject({ lines = 50000, seed = 20260803, name = "bench-chapter-50k" } = {}) {
  const files = new Map();
  files.set("chapters/ch001.tex", generateLongChapterText({ lines, seed, wrap: 60 }) + "\n");
  files.set("refs/references.bib", generateBib({ entries: 500, proceedings: 10, seed: seed ^ 0xb1b }));
  files.set(
    "main.tex",
    [
      `\\documentclass[11pt]{book}`,
      `\\usepackage{amsmath,amssymb}`,
      `\\usepackage[hidelinks]{hyperref}`,
      `\\begin{document}`,
      `\\include{chapters/ch001}`,
      `\\end{document}`,
      ``,
    ].join("\n"),
  );
  files.set(
    ".typeward/project.json",
    JSON.stringify({ rootPath: "", rootFile: "main.tex", format: "latex", name }, null, 2) + "\n",
  );
  return files;
}

/* ------------------------------------------------------------------ */
/* Variants                                                            */
/* ------------------------------------------------------------------ */

export const VARIANTS = ["book", "book-figures", "chapter-50k"];

export function buildVariant(variant, { seed = 20260803, biblatex = false } = {}) {
  switch (variant) {
    case "book":
      return generateBook({ seed, biblatex, name: biblatex ? "bench-book-biblatex" : "bench-book" });
    case "book-figures":
      return generateBook({
        seed,
        biblatex,
        figures: true,
        name: biblatex ? "bench-book-figures-biblatex" : "bench-book-figures",
      });
    case "chapter-50k":
      return generateLongChapterProject({ seed });
    default:
      throw new Error(`unknown variant: ${variant} (expected one of ${VARIANTS.join(", ")})`);
  }
}
