import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { shots } from './tools/vite-plugins.ts';

const root = fileURLToPath(new URL('.', import.meta.url));

/** The StarCraft II install, served to the dev server for the loader, where this repository has the tool (tools/sc2-assets.ts). */
async function install(): Promise<Plugin[]> {
  const tool = path.join(root, 'tools', 'sc2-assets.ts');
  // (It reads the install for the StarCraft II loader: nothing to serve without the loader either.)
  if (!existsSync(tool) || !existsSync(path.join(root, 'plugins', 'sc2-loader'))) return [];
  const { sc2Assets } = (await import(/* @vite-ignore */ pathToFileURL(tool).href)) as { sc2Assets: (root: string) => Plugin };
  return [sc2Assets(root)];
}

export default defineConfig(async () => ({
  plugins: [...(await install()), shots(root)],
  server: {
    port: 5173,
    strictPort: true,
    // cache/install links to the StarCraft II install on the NAS; never crawl or watch it.
    watch: { ignored: ['**/cache/**', '**/third_party/**', '**/tools/sc2x/**'] },
  },
  // `vite preview` serves the production build; `npm run lan` opens it to the local network.
  // Its addresses are always allowed; `.local` adds this Mac's Bonjour name.
  preview: { port: 4173, strictPort: true, allowedHosts: ['.local'] },
  optimizeDeps: { entries: ['index.html', 'viewer.html'] },
  // The game loads its assets with top-level await.
  build: { target: 'esnext' },
}));
