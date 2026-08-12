// Stages a fresh, artifact-free work copy of a corpus variant for rival
// benchmark runs (sources only, identical bytes every run, never touching
// the user's Typeward library).

import { cpSync, existsSync, rmSync } from "node:fs";

const SOURCE_RE = /\.(tex|bib)$/;

export function stageWork(corpusDir, workDir) {
  if (!existsSync(`${corpusDir}/main.tex`)) {
    throw new Error(`corpus missing at ${corpusDir} — run bench/generate.mjs for it first`);
  }
  rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  cpSync(corpusDir, workDir, {
    recursive: true,
    filter: (src) => {
      const s = src.replaceAll("\\", "/");
      if (/\/\.typeward(\/|$)/.test(s)) return false;
      return SOURCE_RE.test(s) || !/\.[^/]*$/.test(s.split("/").pop());
    },
  });
}
