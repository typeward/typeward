import { describe, expect, it } from "vitest";

// @ts-expect-error - plain .mjs build script, no type declarations by design.
import { archOf, platformKeysFor } from "./build-latest-json.mjs";

/**
 * The manifest's platform keys are the contract between what CI publishes and
 * what an installed app asks for. The updater plugin resolves a download by
 * trying `{os}-{arch}-{installer}` and then `{os}-{arch}`, so a key that is
 * misspelled, missing, or mapped to the wrong architecture does not fail the
 * build: it silently strands one platform's users on their installed version,
 * or hands them another platform's bytes. These are the real filenames Tauri's
 * bundler produces for each release leg.
 */

const NAMES = {
  nsisX64: "Typeward_0.4.0_x64-setup.exe",
  nsisArm: "Typeward_0.4.0_arm64-setup.exe",
  appImageX64: "Typeward_0.4.0_amd64.AppImage",
  appImageArm: "Typeward_0.4.0_aarch64.AppImage",
  debX64: "Typeward_0.4.0_amd64.deb",
  debArm: "Typeward_0.4.0_arm64.deb",
  rpmX64: "Typeward-0.4.0-1.x86_64.rpm",
  rpmArm: "Typeward-0.4.0-1.aarch64.rpm",
  // release.yml renames the macOS updater bundle to carry the rust target
  // triple; Tauri itself names both legs identically after productName.
  macArm: "Typeward_aarch64-apple-darwin.app.tar.gz",
  macX64: "Typeward_x86_64-apple-darwin.app.tar.gz",
};

describe("archOf", () => {
  it("reads the arch token from every real bundle name", () => {
    expect(archOf(NAMES.nsisX64)).toBe("x86_64");
    expect(archOf(NAMES.nsisArm)).toBe("aarch64");
    expect(archOf(NAMES.appImageX64)).toBe("x86_64");
    expect(archOf(NAMES.appImageArm)).toBe("aarch64");
    expect(archOf(NAMES.debX64)).toBe("x86_64");
    expect(archOf(NAMES.debArm)).toBe("aarch64");
    expect(archOf(NAMES.rpmX64)).toBe("x86_64");
    expect(archOf(NAMES.rpmArm)).toBe("aarch64");
    expect(archOf(NAMES.macArm)).toBe("aarch64");
    expect(archOf(NAMES.macX64)).toBe("x86_64");
  });

  it("prefers the longest token so x86_64 never reads as i686", () => {
    expect(archOf("App_1.0.0_x86_64.rpm")).toBe("x86_64");
    expect(archOf("App_1.0.0_aarch64.deb")).toBe("aarch64");
  });

  it("returns null when no arch token is present", () => {
    expect(archOf("Typeward.app.tar.gz")).toBeNull();
    expect(archOf("notes.txt")).toBeNull();
  });
});

describe("platformKeysFor", () => {
  it("maps Windows NSIS to the installer key plus a generic fallback", () => {
    expect(platformKeysFor(NAMES.nsisX64)).toEqual([
      "windows-x86_64-nsis",
      "windows-x86_64",
    ]);
    expect(platformKeysFor(NAMES.nsisArm)).toEqual([
      "windows-aarch64-nsis",
      "windows-aarch64",
    ]);
  });

  it("maps macOS to the app key plus a generic fallback", () => {
    expect(platformKeysFor(NAMES.macArm)).toEqual([
      "darwin-aarch64-app",
      "darwin-aarch64",
    ]);
    expect(platformKeysFor(NAMES.macX64)).toEqual([
      "darwin-x86_64-app",
      "darwin-x86_64",
    ]);
  });

  it("keeps the two macOS legs on distinct keys", () => {
    // Tauri names both legs Typeward.app.tar.gz; without release.yml's rename
    // the flatten step collapses them and one arch silently gets the other's
    // binary. Distinct keys are what proves the rename survived.
    const arm = platformKeysFor(NAMES.macArm);
    const x64 = platformKeysFor(NAMES.macX64);
    expect(arm.some((k) => x64.includes(k))).toBe(false);
  });

  it("gives every Linux package its own key and NO generic linux key", () => {
    // A .deb install can only be updated by a .deb: the plugin dispatches on
    // the installed package type and rejects other formats after a full
    // download. A generic linux-<arch> key would route deb and rpm users to
    // the AppImage, so its absence is the load-bearing part of this mapping.
    expect(platformKeysFor(NAMES.appImageX64)).toEqual(["linux-x86_64-appimage"]);
    expect(platformKeysFor(NAMES.debX64)).toEqual(["linux-x86_64-deb"]);
    expect(platformKeysFor(NAMES.rpmX64)).toEqual(["linux-x86_64-rpm"]);
    expect(platformKeysFor(NAMES.appImageArm)).toEqual(["linux-aarch64-appimage"]);
    expect(platformKeysFor(NAMES.debArm)).toEqual(["linux-aarch64-deb"]);
    expect(platformKeysFor(NAMES.rpmArm)).toEqual(["linux-aarch64-rpm"]);

    for (const name of [NAMES.appImageX64, NAMES.debX64, NAMES.rpmX64]) {
      expect(platformKeysFor(name)).not.toContain("linux-x86_64");
    }
  });

  it("handles the v1-compatible AppImage tarball name", () => {
    expect(platformKeysFor("Typeward_0.4.0_amd64.AppImage.tar.gz")).toEqual([
      "linux-x86_64-appimage",
    ]);
  });

  it("ignores files that are not updater targets", () => {
    expect(platformKeysFor("Typeward_0.4.0_aarch64.dmg")).toEqual([]);
    expect(platformKeysFor("SHA256SUMS")).toEqual([]);
    expect(platformKeysFor("latest.json")).toEqual([]);
  });

  it("drops a Linux package with no readable arch rather than guessing", () => {
    expect(platformKeysFor("Typeward.AppImage")).toEqual([]);
    expect(platformKeysFor("Typeward.deb")).toEqual([]);
  });

  it("produces no key collisions across a full release matrix", () => {
    const all = Object.values(NAMES).flatMap((n) => platformKeysFor(n));
    expect(all.length).toBe(new Set(all).size);
  });
});
