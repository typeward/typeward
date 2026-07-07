import { describe, expect, it } from "vitest";
import type { SystemInfo } from "~/ipc";
import { buildBugReportUrl, formatSystemInfo } from "./bug-report";

const INFO: SystemInfo = {
  appVersion: "0.0.1",
  os: "Windows",
  osVersion: "11",
  arch: "x86_64",
  compileEngine: "system-tex",
  tools: [
    { name: "latexmk", found: true },
    { name: "typst", found: false },
  ],
};

describe("formatSystemInfo", () => {
  it("renders version, OS, engine, and found/not-found tool probes", () => {
    const out = formatSystemInfo(INFO);
    expect(out).toContain("Typeward 0.0.1");
    expect(out).toContain("OS: Windows 11 (x86_64)");
    expect(out).toContain("Compile engine: system-tex");
    expect(out).toContain("latexmk: found");
    expect(out).toContain("typst: not found");
    // Booleans only — a resolved path in here would leak the username.
    expect(out).not.toMatch(/[A-Za-z]:\\|\/usr\/|\/home\//);
  });
});

describe("buildBugReportUrl", () => {
  it("prefills title and body with the system block", () => {
    const url = new URL(buildBugReportUrl(INFO));
    expect(url.origin + url.pathname).toBe(
      "https://github.com/typeward/app/issues/new",
    );
    expect(url.searchParams.get("title")).toBe(
      "Bug report (Typeward 0.0.1, Windows)",
    );
    const body = url.searchParams.get("body") ?? "";
    expect(body).toContain("## System");
    expect(body).toContain("Typeward 0.0.1");
    expect(body).toContain("latexmk: found");
  });

  it("still opens a usable form when system info is unavailable", () => {
    const url = new URL(buildBugReportUrl(null));
    expect(url.searchParams.get("title")).toBe("Bug report");
    expect(url.searchParams.get("body")).toContain("## What happened");
  });
});
