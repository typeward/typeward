import { afterEach, describe, expect, it } from "vitest";

import type { Project } from "~/adapters/types";
import { resetEntitlementSource } from "~/integrations/entitlements";

import { TypstAdapter } from "./TypstAdapter";

afterEach(() => {
  resetEntitlementSource();
});

describe("TypstAdapter compile entitlement gate", () => {
  it("rejects with an actionable message on the free tier", async () => {
    const project = {
      rootPath: "/p",
      rootFile: "main.typ",
      format: "typst",
      name: "p",
    } as Project;
    await expect(TypstAdapter.compile(project)).rejects.toThrow(
      "Typst support requires Typeward Pro.",
    );
  });
});
