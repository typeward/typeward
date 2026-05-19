/**
 * Horizontal swipe detector for tablet pane switching. Listens at the
 * shell root for pointer / touch sequences crossing a 70px threshold
 * with predominantly horizontal motion (ratio guard so vertical
 * scrolls in the editor / PDF don't get hijacked). Returns a cleanup
 * function — caller wires this up under an isTabletViewport gate.
 *
 * Pointer events unify mouse + touch on Tauri/webview; we listen for
 * the touch-class pointerType only so trackpad/mouse swipes on
 * desktop never trigger pane changes by accident.
 */

const THRESHOLD_PX = 70;
const HORIZONTAL_RATIO = 1.5;
const POINTER_KINDS = new Set(["touch", "pen"]);

export const installSwipeListener = (
  target: HTMLElement,
  onSwipe: (direction: 1 | -1) => void,
): (() => void) => {
  let startX = 0;
  let startY = 0;
  let pointerId: number | null = null;

  const onDown = (e: PointerEvent) => {
    if (pointerId !== null) return;
    if (!POINTER_KINDS.has(e.pointerType)) return;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
  };

  const onUp = (e: PointerEvent) => {
    if (pointerId === null || e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    pointerId = null;
    if (Math.abs(dx) < THRESHOLD_PX) return;
    if (Math.abs(dx) < Math.abs(dy) * HORIZONTAL_RATIO) return;
    onSwipe(dx < 0 ? 1 : -1);
  };

  const onCancel = () => {
    pointerId = null;
  };

  target.addEventListener("pointerdown", onDown, { passive: true });
  target.addEventListener("pointerup", onUp, { passive: true });
  target.addEventListener("pointercancel", onCancel, { passive: true });

  return () => {
    target.removeEventListener("pointerdown", onDown);
    target.removeEventListener("pointerup", onUp);
    target.removeEventListener("pointercancel", onCancel);
  };
};
