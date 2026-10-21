import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// Content hash of every file under public/assets. Data URLs (models, textures, audio, json) carry it as
// ?v=<hash>, so they change exactly when their content does and can be cached as immutable (vercel.json).
function assetHashes(): Record<string, string> {
  const pub = path.join(ROOT, 'public'); const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out['/' + path.relative(pub, p).split(path.sep).join('/')] = createHash('sha1').update(fs.readFileSync(p)).digest('hex').slice(0, 10);
    }
  };
  walk(path.join(pub, 'assets'));
  return out;
}

export default defineConfig({ define: { __ASSET_HASHES__: JSON.stringify(assetHashes()) } });
