let dismissed = false;

/**
 * Remove the pre-bundle boot splash (`index.html` `#boot-splash`) once the
 * first real screen has painted. Removing it eagerly in `index.tsx` left a
 * blank gap between the splash and the lazy first screen resolving; keeping it
 * on top until a screen calls this makes cold launch a continuous splash.
 * Idempotent; fades out for a soft handoff.
 */
export function dismissBootSplash(): void {
  if (dismissed) return;
  dismissed = true;
  const el = document.getElementById("boot-splash");
  if (!el) return;
  el.style.transition = "opacity 180ms ease";
  el.style.opacity = "0";
  const drop = () => el.remove();
  el.addEventListener("transitionend", drop, { once: true });
  // Fallback in case transitionend doesn't fire (element already detached, etc).
  window.setTimeout(drop, 280);
}
