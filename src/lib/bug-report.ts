import { BUG_REPORT_ISSUE_URL } from "~/config/feedback";
import type { SystemInfo } from "~/ipc";

/**
 * Plain-text system block shown in the Diagnostics header (with a copy
 * button) and embedded in the bug-report issue body. Booleans only for the
 * tool probes — never paths.
 */
export function formatSystemInfo(info: SystemInfo): string {
  const tools = info.tools
    .map((t) => `${t.name}: ${t.found ? "found" : "not found"}`)
    .join("\n");
  return [
    `Typeward ${info.appVersion}`,
    `OS: ${info.os} ${info.osVersion} (${info.arch})`,
    `Compile engine: ${info.compileEngine}`,
    tools,
  ].join("\n");
}

/** GitHub new-issue URL prefilled with title + system info. Pure for tests. */
export function buildBugReportUrl(info: SystemInfo | null): string {
  const title = info
    ? `Bug report (Typeward ${info.appVersion}, ${info.os})`
    : "Bug report";
  const body = info
    ? `## What happened\n\n(describe the bug here)\n\n## System\n\n\`\`\`\n${formatSystemInfo(info)}\n\`\`\`\n`
    : "## What happened\n\n(describe the bug here)\n";
  const params = new URLSearchParams({ title, body });
  return `${BUG_REPORT_ISSUE_URL}?${params.toString()}`;
}

/**
 * Open the browser at a prefilled GitHub issue. System info is best-effort —
 * a failed probe still opens the form, just without the prefill.
 */
export async function openBugReport(): Promise<void> {
  const [{ openUrl }, ipc] = await Promise.all([
    import("@tauri-apps/plugin-opener"),
    import("~/ipc"),
  ]);
  let info: SystemInfo | null = null;
  try {
    info = await ipc.collectSystemInfo();
  } catch {
    // Non-Tauri context or probe failure — open the bare form.
  }
  await openUrl(buildBugReportUrl(info));
}
