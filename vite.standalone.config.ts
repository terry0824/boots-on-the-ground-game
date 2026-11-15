// The web build: the same game, reading StarCraft II in the page from a folder the player picks
// (src/standalone). `npm run dev:standalone` serves it with the install readable at /__install,
// for tests without a picker (?source=http); `npm run build:standalone` writes
// dist-standalone/index.html, the whole game in one HTML file with no StarCraft II files in it,
// which runs opened straight from the disk (browsers won't load separate module scripts on a
// file:// page) or from any web host. `npm run preview:standalone` serves that build here, with
// the install for tests.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { NOTICE, TAGLINE } from './src/game/notice.ts';
import { shots } from './tools/vite-plugins.ts';

const root = fileURLToPath(new URL('.', import.meta.url));

/**
 * The built page with its script and stylesheet written into it: one file, nothing to load
 * beside it. Text that would end a script element early is escaped (`<\/script` is the same
 * string to JavaScript), and a script holding `<!--` is refused. With the dynamic imports
 * folded in, Vite leaves its preload list placeholder unfilled; there's nothing to preload, so
 * it becomes `void 0`, which its preload helper takes as "nothing".
 */
function singleFile(): Plugin {
  return {
    name: 'single-file',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const page = Object.values(bundle).find((f) => f.type === 'asset' && f.fileName.endsWith('.html'));
      if (!page || page.type !== 'asset') return;
      let html = String(page.source);
      for (const [name, file] of Object.entries(bundle)) {
        const ref = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (file.type === 'chunk') {
          // `<!--` inside an inline script can upset the HTML parser, and escaping it as `<\!--` changes what a
          // String.raw template holds (it once left the notice's placeholder on screen): it's refused instead.
          if (file.code.includes('<!--')) this.error(`${name} has "<!--" in its code: an inline script can't carry it (use an element as a marker).`);
          const code = file.code.replace(/__VITE_PRELOAD__/g, 'void 0').replace(/<\/script/gi, '<\\/script');
          html = html.replace(new RegExp(`<script[^>]*src="\\./${ref}"[^>]*></script>`), () => `<script type="module">${code}</script>`);
          html = html.replace(new RegExp(`<link[^>]*href="\\./${ref}"[^>]*>`), '');
          delete bundle[name];
        } else if (name.endsWith('.css')) {
          html = html.replace(new RegExp(`<link[^>]*href="\\./${ref}"[^>]*>`), () => `<style>${String(file.source)}</style>`);
          delete bundle[name];
        }
      }
      // What it is and whose code is in it, near the top of the one file that gets passed around: just after the
      // charset, which has to come within the file's first 1024 bytes (opened from disk, or from a server that
      // doesn't name the encoding, the browser would otherwise guess, and garble every "·" and curly quote).
      const notices = readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8').replaceAll('-->', '- ->');
      if (!/<meta charset="utf-8"\s*\/?>/i.test(html)) this.error('index.html has no <meta charset="utf-8">.');
      html = html.replace(/<meta charset="utf-8"\s*\/?>/i, (m) => `${m}\n<!--\n${TAGLINE}.\n\n${NOTICE}\n\n${notices}\n-->`);
      if (html.toLowerCase().indexOf('<meta charset') > 1024) this.error('The charset comes after the first 1024 bytes of the page.');
      page.source = html;
    },
  };
}

/** index.html, with the web build's front door in place of the game's entry. */
function entry(): Plugin {
  return {
    name: 'standalone-entry',
    transformIndexHtml: { order: 'pre', handler: (html) => html.replace('/src/game/main.ts', '/src/standalone/boot.ts') },
  };
}

/** The install for the loader's tests (`?source=http`), where this repository has the tool that serves it. */
async function devInstall(): Promise<Plugin[]> {
  const tool = path.join(root, 'tools', 'dev-install.ts');
  // (It reads the install for the StarCraft II loader: nothing to serve without the loader either.)
  if (!existsSync(tool) || !existsSync(path.join(root, 'plugins', 'sc2-loader'))) return [];
  const { devInstall: serve } = (await import(/* @vite-ignore */ pathToFileURL(tool).href)) as { devInstall: (root: string) => Plugin };
  return [serve(root)];
}

export default defineConfig(async () => ({
  plugins: [entry(), ...(await devInstall()), shots(root), singleFile()],
  // Relative addresses, so the site works from any folder of any host.
  base: './',
  server: {
    port: 5180,
    strictPort: true,
    watch: { ignored: ['**/cache/**', '**/third_party/**', '**/tools/sc2x/**', '**/release/**'] },
  },
  preview: { port: 4180, strictPort: true },
  build: {
    target: 'esnext',
    outDir: 'dist-standalone',
    emptyOutDir: true,
    // One script: the dynamic imports (the boot's, the test tools') folded into it.
    cssCodeSplit: false,
    chunkSizeWarningLimit: 4096,
    rolldownOptions: { input: path.join(root, 'index.html'), output: { inlineDynamicImports: true } },
  },
}));
