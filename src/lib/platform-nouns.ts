/**
 * Platform-native names for OS surfaces the UI points users at — copy that
 * names the wrong app ("Explorer" on a Mac) reads as broken. The single home
 * for navigator.platform sniffing.
 */

function platform(): string {
  return typeof navigator !== "undefined" ? navigator.platform.toLowerCase() : "";
}

export function fileManagerLabel(): string {
  const p = platform();
  if (p.includes("mac")) return "Reveal in Finder";
  if (p.includes("win")) return "Show in Explorer";
  return "Show in file manager";
}

export function trashLabel(): string {
  const p = platform();
  if (p.includes("win")) return "Recycle Bin";
  if (p.includes("mac")) return "Trash";
  return "system trash";
}
