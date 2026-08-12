// Fetches the two public reference documents the Phase 0 baseline uses so
// benchmark numbers are third-party reproducible (docs/plans/
// 2026-08-03-long-document-performance.md):
//
//   lshort  — "The Not So Short Introduction to LaTeX" (CTAN info/lshort),
//             ~300 pages, root src/lshort.tex
//   memoir  — the memoir class manual (CTAN macros/latex/contrib/memoir,
//             doc-src/memman.tex), ~600 pages, heavy on index + cross-refs
//
// CTAN serves current versions (no pinned snapshots) — that suits the plan's
// "rival numbers older than six months are expired" rule; the script prints
// the resolved version + zip hash so a run is attributable.
//
//   node bench/fetch-ctan.mjs          # -> bench/third-party/<doc>/
//
// Each extracted document gets a .typeward/project.json so it opens directly
// as a Typeward project for the UI-level baseline legs.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const outRoot = join(dirname(fileURLToPath(import.meta.url)), "third-party");

async function download(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const sha = createHash("sha256").update(buf).digest("hex");
  console.log(`fetched ${url} (${(buf.length / 1e6).toFixed(1)} MB, sha256=${sha.slice(0, 16)}...)`);
  return buf;
}

/** Minimal central-directory zip reader: stored + deflate entries only. */
function readZip(buf) {
  // EOCD: scan backwards for PK\x05\x06 within the max comment span.
  let eocd = -1;
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip: no end-of-central-directory record");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  // Zip64 sentinels — bail loudly instead of silently truncating the listing.
  if (count === 0xffff || off === 0xffffffff) throw new Error("zip: zip64 archives are not supported");
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("zip: bad central directory entry");
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    entries.push({ name, method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries.map((e) => ({
    name: e.name,
    read() {
      const lo = e.localOff;
      if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error("zip: bad local header");
      const nameLen = buf.readUInt16LE(lo + 26);
      const extraLen = buf.readUInt16LE(lo + 28);
      const data = buf.subarray(lo + 30 + nameLen + extraLen, lo + 30 + nameLen + extraLen + e.compSize);
      if (e.method === 0) return Buffer.from(data);
      if (e.method === 8) return inflateRawSync(data);
      throw new Error(`zip: unsupported compression method ${e.method} for ${e.name}`);
    },
  }));
}

function safeRel(name) {
  const norm = name.replaceAll("\\", "/");
  if (norm.startsWith("/") || /^[a-zA-Z]:/.test(norm) || norm.split("/").includes("..")) {
    throw new Error(`zip: refusing unsafe entry path ${name}`);
  }
  return norm;
}

function writeProjectJson(root, name, rootFile) {
  mkdirSync(join(root, ".typeward"), { recursive: true });
  writeFileSync(
    join(root, ".typeward", "project.json"),
    JSON.stringify({ rootPath: "", rootFile, format: "latex", name }, null, 2) + "\n",
  );
}

mkdirSync(outRoot, { recursive: true });

// --- lshort: zip wraps a .src.tar.gz; system tar handles it everywhere ------
{
  const zip = readZip(await download("https://mirrors.ctan.org/info/lshort/english.zip"));
  const src = zip.find((e) => /lshort-.*\.src\.tar\.gz$/.test(e.name));
  if (!src) throw new Error("lshort: no .src.tar.gz in english.zip");
  writeFileSync(join(outRoot, "lshort-src.tar.gz"), src.read());
  for (const d of readdirSync(outRoot)) {
    if (/^lshort-[\d.]+$/.test(d)) rmSync(join(outRoot, d), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  // Relative path on purpose: GNU tar reads "C:\..." as a remote host.
  const tar = spawnSync("tar", ["-xzf", "lshort-src.tar.gz"], { cwd: outRoot, encoding: "utf8" });
  try {
    if (tar.error) throw new Error(`tar failed to spawn: ${tar.error.message}`);
    if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
  } finally {
    rmSync(join(outRoot, "lshort-src.tar.gz"), { force: true });
  }
  const dir = readdirSync(outRoot).find((d) => /^lshort-[\d.]+$/.test(d));
  if (!dir) throw new Error("lshort: extracted directory not found");
  writeProjectJson(join(outRoot, dir), `lshort (${dir})`, "src/lshort.tex");
  console.log(`lshort -> bench/third-party/${dir} (root src/lshort.tex)`);
}

// --- memoir manual: extract doc-src/ as the project root --------------------
{
  const zip = readZip(await download("https://mirrors.ctan.org/macros/latex/contrib/memoir.zip"));
  const dest = join(outRoot, "memoir-manual");
  rmSync(dest, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  let files = 0;
  for (const e of zip) {
    const rel = safeRel(e.name);
    if (!rel.startsWith("memoir/doc-src/") || rel.endsWith("/")) continue;
    const target = join(dest, rel.slice("memoir/doc-src/".length));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, e.read());
    files++;
  }
  if (files === 0) throw new Error("memoir: no doc-src/ entries found");
  writeProjectJson(dest, "memoir manual", "memman.tex");
  // memman's indexes need its shipped styles (upstream's Makeidxglo recipe:
  // memman.idx via memman.ist, lines.idx plain, glossary via memman.gst) —
  // default makeindex output makes TeX choke on raw # and & in memman.ind.
  writeFileSync(
    join(dest, "latexmkrc"),
    [
      `$makeindex = 'internal bench_makeindex %S %D';`,
      `sub bench_makeindex {`,
      `  my ($src, $dst) = @_;`,
      `  if ($src =~ /memman/) { return system 'makeindex', '-s', 'memman.ist', '-o', $dst, $src; }`,
      `  return system 'makeindex', '-o', $dst, $src;`,
      `}`,
      `add_cus_dep('glo', 'gls', 0, 'bench_makeglossary');`,
      `sub bench_makeglossary {`,
      `  return system 'makeindex', '-s', 'memman.gst', '-o', "$_[0].gls", "$_[0].glo";`,
      `}`,
      ``,
    ].join("\n"),
  );
  // memman.tex hard-errors unless trims-example.pdf exists (its own line 189
  // says to build it first) — do that here while a TeX distro is at hand.
  const probe = spawnSync("pdflatex", ["--version"], { encoding: "utf8" });
  if (!probe.error) {
    const prep = spawnSync("pdflatex", ["-interaction=nonstopmode", "trims-example.tex"], {
      cwd: dest,
      encoding: "utf8",
      timeout: 5 * 60 * 1000,
    });
    for (const junk of ["trims-example.aux", "trims-example.log"]) rmSync(join(dest, junk), { force: true });
    if (prep.status !== 0) console.warn("memoir: trims-example.tex prep failed — memman will not build until it exists");
  } else {
    console.warn("memoir: pdflatex not on PATH — run pdflatex on trims-example.tex before benchmarking memman");
  }
  console.log(`memoir manual -> bench/third-party/memoir-manual (root memman.tex, ${files} files)`);
}
