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
      <p class="hint">Tap the ground to walk. Drag to look around. Pinch to zoom. Tap a dinosaur to say hello; hold one to make it follow you.</p>
      <div class="row">
        <button id="credits-reset">Reset position</button>
        <button id="credits-close">Close</button>
      </div>
      <h3>Dinosaurs</h3><ul>${dinoRows}</ul>
      <h3>Animal sounds</h3><p>Real animal recordings from Wikimedia Commons (public domain / CC0), edited into dinosaur voices.</p><ul>${sndRows}</ul>
      <h3>Environment</h3><p>${env?.source ?? 'Poly Haven'} — ${env?.license ?? 'CC0'}</p><ul>${envRows}</ul>
      <h3>Engine</h3><p>three.js (MIT). Sounds and music are synthesized in the browser. Made with love for one small explorer.</p>
    </div>`;
  document.body.appendChild(el);
  el.querySelector('#credits-close')!.addEventListener('click', () => el.remove());
  el.querySelector('#credits-reset')!.addEventListener('click', () => { onReset(); el.remove(); });
}
