/// <reference types="node" />
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Capability-scope regression guard.
 *
 * The Tauri capability files are the app's privilege boundary, and widening one
 * is silent: nothing fails to compile, no test breaks, and the extra authority
 * only shows up in an audit. The failure modes this pins are the ones the
 * security invariants in CLAUDE.md were written against:
 *
 *   - a filesystem grant broadening back to `$DOCUMENT/**` (or wider), undoing
 *     the projects-subtree scoping;
 *   - the detached preview window — which renders attacker-supplied PDF content
 *     — gaining anything beyond a read-only PDF read;
 *   - a wildcard creeping into the opener URL allowlist, which would turn
 *     `openUrl` into an arbitrary-browser-navigation primitive;
 *   - shell/process execution being handed to the renderer.
 *
 * These assertions are deliberately about *shape*, not an exact snapshot: an
 * intentional narrow grant should not have to update this file, but a broad one
 * must.
 */

const here = dirname(fileURLToPath(import.meta.url));
const capabilitiesDir = join(here, "..", "..", "src-tauri", "capabilities");

type Permission = string | { identifier: string; allow?: { path?: string; url?: string }[] };
interface Capability {
  identifier: string;
  windows?: string[];
  permissions: Permission[];
}

function readCapability(name: string): Capability {
  return JSON.parse(readFileSync(join(capabilitiesDir, `${name}.json`), "utf8")) as Capability;
}

const identifierOf = (p: Permission): string =>
  typeof p === "string" ? p : p.identifier;

const scopedPaths = (cap: Capability): string[] =>
  cap.permissions.flatMap((p) =>
    typeof p === "string" ? [] : (p.allow ?? []).flatMap((a) => (a.path ? [a.path] : [])),
  );

describe("capability scopes stay narrow", () => {
  const def = readCapability("default");
  const preview = readCapability("preview");
  const desktop = readCapability("desktop");

  it("applies the default capability only to the main window", () => {
    expect(def.windows).toEqual(["main"]);
  });

  // The static fs grant was narrowed from Documents-wide to the projects
  // subtree; the configured root is added to the *runtime* scope in Rust
  // instead. A `$DOCUMENT/**` entry here would hand a compromised webview the
  // user's whole Documents folder again.
  it("never grants filesystem access above the projects root", () => {
    for (const path of scopedPaths(def)) {
      expect(
        path.startsWith("$DOCUMENT/Typeward/") || path.startsWith("$RESOURCE/"),
        `overly broad fs scope: ${path}`,
      ).toBe(true);
    }
  });

  it("gives the preview window a read-only PDF scope and nothing else", () => {
    expect(preview.windows).toEqual(["preview"]);
    const ids = preview.permissions.map(identifierOf);
    // No writes, no directory listing, no dialogs, no text reads.
    for (const id of ids) {
      expect(
        /^(core:|fs:allow-read-file$)/.test(id),
        `preview window must not hold ${id}`,
      ).toBe(true);
    }
    for (const path of scopedPaths(preview)) {
      expect(path.endsWith(".pdf"), `preview fs scope must be PDFs only: ${path}`).toBe(true);
    }
  });

  it("keeps shell and process execution away from every renderer", () => {
    // The Tectonic sidecar is spawned from Rust, which does not consult the
    // capability scope — so a `shell:` grant here would be authority handed to
    // the webview that no code needs. `process:allow-restart` is the updater's
    // post-install relaunch and is not execution of arbitrary programs.
    for (const cap of [def, preview, desktop]) {
      for (const id of cap.permissions.map(identifierOf)) {
        expect(id.startsWith("shell:"), `${cap.identifier} must not grant ${id}`).toBe(false);
        expect(
          id.startsWith("process:") && id !== "process:allow-restart",
          `${cap.identifier} must not grant ${id}`,
        ).toBe(false);
      }
    }
  });

  it("allows opening only exact, pinned https URLs", () => {
    const opener = def.permissions.find(
      (p) => typeof p !== "string" && p.identifier === "opener:allow-open-url",
    );
    expect(opener, "opener:allow-open-url entry missing").toBeDefined();
    const urls = (opener as { allow?: { url?: string }[] }).allow ?? [];
    expect(urls.length).toBeGreaterThan(0);
    for (const { url } of urls) {
      expect(url, "opener entry without a url").toBeDefined();
      // Exact origins only: a scheme-relative or wildcard-host entry would let
      // an injected renderer navigate the user's browser anywhere.
      expect(url!.startsWith("https://"), `opener url must be https: ${url}`).toBe(true);
      expect(/^https:\/\/\*/.test(url!), `wildcard host in opener url: ${url}`).toBe(false);
      const host = url!.slice("https://".length).split("/")[0];
      expect(host.includes("*"), `wildcard host in opener url: ${url}`).toBe(false);
    }
  });
});
