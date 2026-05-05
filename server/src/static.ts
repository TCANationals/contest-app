// Optional static-asset hosting for the judge SPA bundle.
//
// In production we deploy the SPA and the server as a single Railway
// service: the SPA is built to `spa/dist/` and the Fastify process
// serves those files alongside the JSON/WS API on the same origin.
// This co-location is what lets the SPA fetch `/api/...` and open
// `/judge` / `/contestant` WebSockets with relative URLs (see
// `spa/src/api/client.ts` and `spa/src/hooks/useWebSocket.ts`) without
// any CORS plumbing.
//
// Activation is opt-in: the plugin is only registered when a SPA dist
// directory is actually present. The default search path resolves to
// `<repo>/spa/dist` relative to this compiled module, but `SPA_DIST_DIR`
// can override it for non-standard layouts (or to disable serving by
// pointing somewhere that doesn't exist). Tests and dev (`tsx watch`)
// keep their existing behavior because there's no `dist/` to find.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fastifyStatic, { type FastifyStaticOptions } from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * API/WS path prefixes that must NEVER fall back to `index.html`. A 404
 * inside `/api/*` is a real bug we want to surface to the SPA's fetch
 * wrapper as JSON, not silently masked by a 200 + HTML body. The WS
 * upgrade routes are listed for the same reason: a stray HTTP GET to
 * `/judge` should not return the SPA shell (it would confuse anyone
 * debugging a botched upgrade).
 */
const API_PREFIXES = ['/api/', '/healthz', '/judge', '/contestant'];

function isApiPath(url: string): boolean {
  const path = url.split('?', 1)[0] ?? url;
  return API_PREFIXES.some((p) =>
    p.endsWith('/') ? path.startsWith(p) : path === p || path.startsWith(`${p}/`),
  );
}

/**
 * Resolve the directory holding the built SPA bundle, or `null` if no
 * such directory exists at any of the candidate locations.
 *
 * Candidates, in order:
 *  1. `SPA_DIST_DIR` env var (absolute or relative to cwd).
 *  2. `<this module>/../../spa/dist` — the layout produced by
 *     `npm run build` from the repo root, where `server/dist/static.js`
 *     sits next to a sibling `spa/dist/`.
 */
function resolveSpaDist(): string | null {
  const envDir = process.env.SPA_DIST_DIR?.trim();
  if (envDir) {
    const abs = path.resolve(envDir);
    return existsSync(abs) ? abs : null;
  }
  const compiled = fileURLToPath(new URL('../../spa/dist', import.meta.url));
  return existsSync(compiled) ? compiled : null;
}

/**
 * Register the SPA static handler. Returns the resolved root directory
 * if hosting was enabled, otherwise `null` (so the caller can log
 * accordingly).
 */
export async function registerSpa(app: FastifyInstance): Promise<string | null> {
  const root = resolveSpaDist();
  if (!root) return null;

  const opts: FastifyStaticOptions = {
    root,
    // Default `wildcard: true` registers `GET *` so any non-API path
    // is checked against disk; missing files fall through to the
    // notFound handler below for the client-side router fallback.
    wildcard: true,
    // Long-cache the immutable hashed assets Vite emits under
    // `/assets/*`; everything else (index.html, manifest, sw.js)
    // keeps the default no-cache behavior so PWA updates are picked
    // up promptly.
    setHeaders: (res, filePath) => {
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('cache-control', 'public, max-age=31536000, immutable');
      }
    },
  };
  await app.register(fastifyStatic, opts);

  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return reply.code(404).send({ error: 'not_found' });
    }
    if (isApiPath(req.url)) {
      return reply.code(404).send({ error: 'not_found' });
    }
    // Anything else: serve the SPA shell so React Router can take over.
    // The cast is required because @fastify/static augments FastifyReply
    // via `declare module 'fastify'`, but the augmentation isn't picked
    // up under `moduleResolution: Bundler` for packages that use
    // `export =`.
    return (reply as FastifyReply & {
      sendFile(filename: string): FastifyReply;
    }).sendFile('index.html');
  });

  return root;
}
