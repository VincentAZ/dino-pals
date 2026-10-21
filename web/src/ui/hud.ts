// Two big round bubbles (food, magic), a tiny parent-only "i" button and a loading sparkle.
export interface HudHandlers { onFood: () => void; onMagic: () => void; onInfo: () => void }

export class Hud {
  root: HTMLElement;
  private loading: HTMLElement;
  constructor(h: HudHandlers) {
    this.root = document.createElement('div');
    this.root.id = 'hud';
    this.root.innerHTML = `
      <button id="btn-food" class="bubble" aria-label="food">
        <svg viewBox="0 0 64 64"><circle cx="32" cy="38" r="16" fill="#ff5e5e"/><circle cx="26" cy="32" r="5" fill="#ffd0d0" opacity=".7"/><path d="M32 22 C32 14 38 10 44 10 C44 18 38 22 32 22 Z" fill="#4caf50"/><path d="M32 22 L31 14" stroke="#6d4c41" stroke-width="3" stroke-linecap="round"/></svg>
      </button>
      <button id="btn-magic" class="bubble" aria-label="magic">
        <svg viewBox="0 0 64 64"><path d="M32 6 L37 25 L56 30 L37 35 L32 54 L27 35 L8 30 L27 25 Z" fill="#ffd54f"/><path d="M50 8 L52 15 L59 17 L52 19 L50 26 L48 19 L41 17 L48 15 Z" fill="#fff59d"/><path d="M12 42 L14 48 L20 50 L14 52 L12 58 L10 52 L4 50 L10 48 Z" fill="#fff59d"/></svg>
      </button>
      <button id="btn-info" aria-label="info">i</button>
      <div id="loading"><span></span><span></span><span></span></div>
    `;
    document.body.appendChild(this.root);
    const food = this.root.querySelector('#btn-food') as HTMLButtonElement;
    const magic = this.root.querySelector('#btn-magic') as HTMLButtonElement;
    const info = this.root.querySelector('#btn-info') as HTMLButtonElement;
    this.loading = this.root.querySelector('#loading') as HTMLElement;
    const press = (b: HTMLElement, fn: () => void) => {
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); b.classList.add('pressed'); fn(); setTimeout(() => b.classList.remove('pressed'), 250); }, { passive: false });
      b.addEventListener('pointerup', (e) => e.stopPropagation());
    };
    press(food, h.onFood); press(magic, h.onMagic);
    // parent-only: 2 s long-press
    let timer = 0;
    info.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); info.classList.add('pressed'); timer = window.setTimeout(() => { info.classList.remove('pressed'); h.onInfo(); }, 2000); }, { passive: false });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) info.addEventListener(ev, (e) => { e.stopPropagation(); clearTimeout(timer); info.classList.remove('pressed'); });
  }
  setLoading(v: boolean): void { this.loading.classList.toggle('on', v); }
}
