// The only "screen": a full-bleed scene rendered from the game itself, with a pulsing tap hint.
import { versioned } from '../assets.ts';

export function showSplash(): Promise<void> {
  const el = document.createElement('div');
  el.id = 'splash';
  el.innerHTML = `
    <div class="splash-img" role="img" aria-label="Dinosaurs in a meadow below a volcano"></div>
    <div class="splash-vignette"></div>
    <div class="splash-ring"></div>
    <div class="splash-hand">👆</div>
  `;
  document.body.appendChild(el);
  // the gradient shows instantly; the rendered scene fades in as soon as it has loaded (~150 KB)
  const img = new Image();
  img.onload = () => { (el.querySelector('.splash-img') as HTMLElement).style.backgroundImage = `url("${img.src}")`; el.classList.add('ready'); };
  img.src = versioned('/assets/ui/splash.webp');
  return new Promise((resolve) => {
    const go = (e: Event) => {
      e.preventDefault();
      el.removeEventListener('pointerdown', go);
      el.classList.add('out');
      setTimeout(() => el.remove(), 700);
      resolve();
    };
    el.addEventListener('pointerdown', go, { passive: false });
  });
}
