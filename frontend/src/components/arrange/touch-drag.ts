/**
 * Touch drag-intent detection for the Arrange page.
 *
 * On touch devices the Contact Sheet scrolls vertically and the Film
 * Strip pans horizontally — a plain swipe over a card/frame MUST stay
 * a native scroll. Dragging therefore requires intent: hold the finger
 * still for LONG_PRESS_MS (within TOUCH_SLOP_PX), then the gesture is
 * promoted to a drag. This mirrors how the editor separates the two
 * gesture families.
 *
 * Mouse gestures don't go through this — they keep the immediate
 * small-threshold arming (a mouse can't "scroll by swiping").
 */

export const LONG_PRESS_MS = 350;
export const TOUCH_SLOP_PX = 8;

export class TouchLongPressArmer {
  private readonly longPressMs: number;
  private readonly slopPx: number;
  private readonly onStart: (x: number, y: number) => void;
  private armed: {
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
  } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: {
    onStart: (x: number, y: number) => void;
    longPressMs?: number;
    slopPx?: number;
  }) {
    this.onStart = opts.onStart;
    this.longPressMs = opts.longPressMs ?? LONG_PRESS_MS;
    this.slopPx = opts.slopPx ?? TOUCH_SLOP_PX;
  }

  /** True while a press is waiting for its long-press timer. */
  get isArmed(): boolean {
    return this.armed !== null;
  }

  /** Pointer went down — start (or restart) the long-press countdown. */
  down(pointerId: number, x: number, y: number): void {
    this.cancel();
    this.armed = { pointerId, startX: x, startY: y, lastX: x, lastY: y };
    this.timer = setTimeout(() => {
      this.timer = null;
      const a = this.armed;
      this.armed = null;
      if (a) this.onStart(a.lastX, a.lastY);
    }, this.longPressMs);
  }

  /** Pointer moved. Beyond the slop → the gesture is a swipe/scroll,
   *  not a press: disarm. Within the slop → track the position so
   *  onStart reports where the finger actually is. */
  move(pointerId: number, x: number, y: number): void {
    const a = this.armed;
    if (!a || a.pointerId !== pointerId) return;
    a.lastX = x;
    a.lastY = y;
    const dx = x - a.startX;
    const dy = y - a.startY;
    if (dx * dx + dy * dy > this.slopPx * this.slopPx) this.cancel();
  }

  /** Pointer lifted / gesture taken over by the browser — disarm. */
  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.armed = null;
  }
}
