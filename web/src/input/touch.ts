// One-thumb input: tap, drag (orbit), pinch (zoom), hold. Pointer events only.
export interface TouchHandlers {
  onTap: (x: number, y: number) => void;
  onDrag: (dx: number, dy: number) => void;
  onPinch: (scale: number) => void;
  onHold: (x: number, y: number) => void;
  onHoldEnd?: () => void;
}

interface P { id: number; x: number; y: number; sx: number; sy: number; t: number }

export class TouchInput {
  private pointers = new Map<number, P>();
  private dragging = false;
  private held = false;
  private holdTimer = 0;
  private lastPinch = 0;
  private tapAllowed = false;
  private el: HTMLElement;
  private h: TouchHandlers;
  private active = true;
  get enabled(): boolean { return this.active; }
  set enabled(value: boolean) { this.active = value; if (!value) this.reset(); }
  constructor(el: HTMLElement, h: TouchHandlers) {
    this.el = el; this.h = h;
    el.addEventListener('pointerdown', this.down, { passive: false });
    el.addEventListener('pointermove', this.move, { passive: false });
    el.addEventListener('pointerup', this.up, { passive: false });
    el.addEventListener('pointercancel', this.cancel, { passive: false });
    el.addEventListener('lostpointercapture', this.cancel);
    el.addEventListener('pointerleave', (e) => { if (!el.hasPointerCapture(e.pointerId)) this.cancel(e); });
    window.addEventListener('blur', () => this.reset());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.reset(); });
    for (const ev of ['touchstart', 'touchmove', 'touchend', 'gesturestart', 'gesturechange', 'dblclick', 'contextmenu']) {
      el.addEventListener(ev, (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
    }
  }
  private down = (e: PointerEvent): void => {
    if (!this.enabled || e.button !== 0) return;
    e.preventDefault();
    try { this.el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    this.pointers.set(e.pointerId, { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: e.timeStamp });
    if (this.pointers.size === 1) {
      this.dragging = false; this.held = false; this.tapAllowed = true;
      clearTimeout(this.holdTimer);
      this.holdTimer = window.setTimeout(() => {
        const p = this.pointers.get(e.pointerId);
        if (this.enabled && p && this.pointers.size === 1 && this.tapAllowed && !this.dragging) { this.held = true; this.h.onHold(p.x, p.y); }
      }, 520);
    } else {
      clearTimeout(this.holdTimer);
      this.tapAllowed = false;
      this.endHold();
      this.lastPinch = this.pointers.size === 2 ? this.pinchDist() : 0;
    }
  };
  private pinchDist(): number {
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
  private move = (e: PointerEvent): void => {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    e.preventDefault();
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (this.pointers.size > 2) return;
    if (this.pointers.size === 2) {
      const d = this.pinchDist();
      if (this.lastPinch > 0) this.h.onPinch(d / this.lastPinch);
      this.lastPinch = d;
      return;
    }
    if (this.held) return;
    if (!this.dragging && Math.hypot(p.x - p.sx, p.y - p.sy) > 10) { this.dragging = true; clearTimeout(this.holdTimer); }
    if (this.dragging) this.h.onDrag(dx, dy);
  };
  private up = (e: PointerEvent): void => {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    e.preventDefault();
    this.pointers.delete(e.pointerId);
    clearTimeout(this.holdTimer);
    if (this.pointers.size === 0) {
      const isTap = this.enabled && !this.held && !this.dragging && this.tapAllowed &&
        e.timeStamp - p.t < 600 && Math.hypot(e.clientX - p.sx, e.clientY - p.sy) <= 10;
      this.endHold();
      this.dragging = false; this.tapAllowed = false;
      if (isTap) this.h.onTap(e.clientX, e.clientY);
    }
    this.lastPinch = 0;
  };
  private endHold(): void {
    if (this.held) { this.held = false; this.h.onHoldEnd?.(); }
  }
  private cancel = (e: PointerEvent): void => {
    if (this.pointers.has(e.pointerId)) this.reset();
  };
  private reset(): void {
    clearTimeout(this.holdTimer);
    const pointers = [...this.pointers.keys()];
    this.pointers.clear();
    this.endHold();
    this.dragging = false; this.tapAllowed = false; this.lastPinch = 0;
    for (const id of pointers) {
      try { if (this.el.hasPointerCapture(id)) this.el.releasePointerCapture(id); } catch { /* already cancelled */ }
    }
  }
}
