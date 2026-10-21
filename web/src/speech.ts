// Says the species name with the Web Speech API (slow, friendly).
let voice: SpeechSynthesisVoice | null = null;
let lastAt = 0;
function pickVoice(): void {
  if (!('speechSynthesis' in window)) return;
  const vs = speechSynthesis.getVoices();
  if (!vs.length) return;
  const pref = ['Samantha', 'Karen', 'Google US English', 'Moira', 'Ava', 'Allison', 'Susan'];
  voice = vs.find((v) => pref.some((p) => v.name.includes(p)) && v.lang.startsWith('en')) ?? vs.find((v) => v.lang === 'en-US') ?? vs.find((v) => v.lang.startsWith('en')) ?? vs[0];
}
if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.addEventListener?.('voiceschanged', pickVoice); }

export function say(text: string, delayMs = 0): void {
  if (!('speechSynthesis' in window)) return;
  const now = performance.now();
  if (now - lastAt < 500) return;
  lastAt = now;
  const go = () => {
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US'; u.rate = 0.78; u.pitch = 1.15; u.volume = 1;
      if (voice) u.voice = voice;
      speechSynthesis.speak(u);
    } catch { /* ignore */ }
  };
  if (delayMs > 0) setTimeout(go, delayMs); else go();
}
