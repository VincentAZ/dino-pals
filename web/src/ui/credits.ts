// Parent-only overlay: attribution + reset position.
import type { Species } from '../dinos/manifest.ts';

interface EnvCredits { source: string; license: string; assets: Record<string, { type: string; name: string; authors: Record<string, string>; license: string; url: string }> }

export async function showCredits(species: Species[], onReset: () => void): Promise<void> {
  let env: EnvCredits | null = null;
  try { env = await (await fetch('/assets/env/credits.json')).json(); } catch { /* ignore */ }
  let snd: { credits: Record<string, { license: string; author: string; url: string }> } | null = null;
  try { snd = await (await fetch('/assets/audio/voices.json')).json(); } catch { /* ignore */ }
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  const sndRows = snd ? Object.entries(snd.credits).map(([name, c]) => `<li>${esc(name)} — ${esc(c.author || 'unknown')} (${esc(c.license)}) <a href="${esc(c.url)}" target="_blank" rel="noopener">link</a></li>`).join('') : '';
  const el = document.createElement('div');
  el.id = 'credits';
  const dinoRows = species.map((s) => `<li><b>${s.name}</b>${s.attribution.author ? ` — ${s.attribution.author}` : ''}${s.attribution.license ? ` (${s.attribution.license})` : ''}${s.attribution.url ? ` <a href="${s.attribution.url}" target="_blank" rel="noopener">link</a>` : ''}</li>`).join('');
  const envRows = env ? Object.values(env.assets).map((a) => `<li>${a.name} — ${Object.keys(a.authors).join(', ') || 'Poly Haven'} (${a.license}) <a href="${a.url}" target="_blank" rel="noopener">link</a></li>`).join('') : '<li>Poly Haven assets (CC0)</li>';
  el.innerHTML = `
    <div class="panel">
      <h2>Dino Pals</h2>
      <p class="hint">Tap the ground to walk. Drag to look around. Pinch to zoom. Tap a dinosaur to say hello, tap again for more; hold one to make it follow you. The apple drops food, the sparkle button changes the time of day.</p>
      <h3>For grown-ups</h3>
      <ul class="tips">
        <li><b>Full screen:</b> in Safari tap Share, then <i>Add to Home Screen</i>, and open Dino Pals from its icon. No browser bars, nothing to tap by accident.</li>
        <li><b>Keep little hands in the game:</b> turn on <i>Guided Access</i> (Settings, Accessibility, Guided Access), open Dino Pals, then triple-click the top or Home button.</li>
        <li><b>Sound:</b> the dinosaurs are real animal recordings; check the volume and that the silent switch is off.</li>
        <li>This panel opens when the little <i>i</i> is held for two seconds.</li>
      </ul>
      <div class="row">
        <button id="credits-reset">Reset position</button>
        <button id="credits-close">Close</button>
      </div>
      <h3>Dinosaurs</h3><ul>${dinoRows}</ul>
      <h3>Animal sounds</h3><p>Real animal recordings from Wikimedia Commons (public domain / CC0), edited into dinosaur voices.</p><ul>${sndRows}</ul>
      <h3>Environment</h3><p>${env?.source ?? 'Poly Haven'} — ${env?.license ?? 'CC0'}</p><ul>${envRows}</ul>
      <h3>Engine</h3><p>three.js (MIT). Music and sound effects are synthesized in the browser; the animal voices and birdsong are the recordings listed above. Made with love for one small explorer.</p>
    </div>`;
  document.body.appendChild(el);
  el.querySelector('#credits-close')!.addEventListener('click', () => el.remove());
  el.addEventListener('click', (e) => { if (e.target === el) el.remove(); });   // tapping the dark backdrop closes it too
  el.querySelector('#credits-reset')!.addEventListener('click', () => { onReset(); el.remove(); });
}
