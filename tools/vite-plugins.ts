// A Vite plugin both builds' dev servers use (vite.config.ts, vite.standalone.config.ts): screenshots for tests.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/** Dev only: POST a PNG data URL to /__shot?name=x and it lands in cache/shots/x.png. */
export function shots(root: string): Plugin {
  return {
    name: 'shots',
    configureServer(server) {
      server.middlewares.use('/__shot', (req, res) => {
        // It writes files: only from this machine, even when the server is open to the network.
        if (!/^(::1|(::ffff:)?127\.)/.test(req.socket.remoteAddress ?? '')) {
          res.statusCode = 403;
          res.end();
          return;
        }
        const name = new URL(req.url ?? '/', 'http://local').searchParams.get('name') ?? 'shot';
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const dir = path.join(root, 'cache', 'shots');
          mkdirSync(dir, { recursive: true });
          writeFileSync(path.join(dir, `${name.replace(/[^\w-]/g, '')}.png`), Buffer.from(body.replace(/^data:image\/png;base64,/, ''), 'base64'));
          res.end('ok');
        });
      });
    },
  };
}
