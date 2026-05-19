import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/ipc", () => ({
  readProjectTextFile: vi.fn(async () => "\\documentclass{article}\\begin{document}Hi\\end{document}"),
  readProjectBinaryFile: vi.fn(async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
  writeProjectBinaryFile: vi.fn(async () => undefined),
  parseLatexLog: vi.fn(async () => []),
}));

describe("busytex-provider", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns an actionable error when assets are missing", async () => {
    // Simulate the asset HEAD probe failing — the most common first-run case.
    globalThis.fetch = vi.fn(
      async () => new Response(null, { status: 404 }),
    ) as unknown as typeof fetch;

    const { compileWithBusytex } = await import("./busytex-provider");
    const result = await compileWithBusytex({
      name: "demo",
      rootPath: "/tmp/demo",
      rootFile: "main.tex",
      format: "latex",
      experience: "text",
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toMatch(/busytex assets not found/);
    expect(result.diagnostics[0]?.message).toMatch(/npx texlyre-busytex download-assets/);
    expect(result.diagnostics[0]?.file).toBe("main.tex");
  });
});
