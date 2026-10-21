// The only "screen": a full-screen tap-to-start with a big animated dinosaur silhouette.
export function showSplash(): Promise<void> {
  const el = document.createElement('div');
  el.id = 'splash';
  el.innerHTML = `
    <div class="splash-sky"></div>
    <svg class="splash-dino" viewBox="0 0 400 300" aria-hidden="true">
      <g class="dino-body">
        <path d="M60 230 C40 200 60 150 120 140 C150 135 190 120 220 105 C250 90 270 70 300 60 C330 50 360 60 370 85 C375 100 360 110 345 112 L320 118 C310 140 290 150 270 155 C250 160 240 175 235 190 L240 230 L215 232 L212 200 C195 205 175 210 160 212 L158 235 L130 236 L128 214 C110 216 85 222 60 230 Z"/>
        <circle cx="340" cy="82" r="6" class="eye"/>
      </g>
      <g class="dino-legs">
        <rect x="128" y="205" width="30" height="40" rx="10"/>
        <rect x="212" y="200" width="30" height="40" rx="10"/>
      </g>
      <path class="dino-tail" d="M60 230 C30 220 10 200 0 170 C25 185 45 200 70 205 Z"/>
    </svg>
    <div class="splash-ring"></div>
    <div class="splash-hand">👆</div>
  `;
  document.body.appendChild(el);
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
