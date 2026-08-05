/**
 * Where the web console listens.
 *
 * The port was written into five places as the literal 3456 — the service, the
 * PM2 entry, the Caddy route, the URL printed at the end of `yos init`, and the
 * fallback service starter. Nothing checked whether it was free, so a machine
 * with anything already on 3456 got an init that printed a console URL and a
 * password, exited 0, and left a service crash-looping on EADDRINUSE.
 *
 * A port is probed by binding it, which is the only answer that is not a guess.
 */

import fs from 'node:fs';
import net from 'node:net';
import { ENV_FILE } from './config.js';

export const DEFAULT_WEB_CONSOLE_PORT = 3456;
/** How many consecutive ports to try before giving up. */
export const PORT_SEARCH_LIMIT = 10;

/**
 * Is this port bindable right now?
 *
 * Bound to the same host the console binds to: a port free on 0.0.0.0 can still
 * be taken on 127.0.0.1, and vice versa.
 *
 * @returns {Promise<boolean>} false when the port is taken or not permitted
 */
export function probePort(port, { host = '127.0.0.1' } = {}) {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const finish = (free) => {
      if (settled) return;
      settled = true;
      resolve(free);
    };

    server.once('error', () => finish(false));
    server.once('listening', () => {
      server.close(() => finish(true));
    });

    try {
      server.listen({ port, host, exclusive: true });
    } catch {
      finish(false);
    }
  });
}

/**
 * Pick the port the console will actually use.
 *
 * A port the user asked for explicitly is reported as unavailable rather than
 * silently replaced — moving someone's configured port is a surprise they would
 * find out about from a broken bookmark.
 *
 * @param {object} [options]
 * @param {number} [options.preferred] - port to try first
 * @param {boolean} [options.explicit] - true when the user configured it
 * @returns {Promise<{port: number|null, preferred: number, moved: boolean, exhausted: boolean}>}
 */
export async function resolveWebConsolePort({
  preferred = DEFAULT_WEB_CONSOLE_PORT,
  host = '127.0.0.1',
  limit = PORT_SEARCH_LIMIT,
  explicit = false,
  probe = probePort,
} = {}) {
  const base = Number(preferred);
  const start = Number.isInteger(base) && base > 0 && base < 65_536
    ? base
    : DEFAULT_WEB_CONSOLE_PORT;

  if (await probe(start, { host })) {
    return { port: start, preferred: start, moved: false, exhausted: false };
  }

  if (explicit) {
    return { port: null, preferred: start, moved: false, exhausted: true };
  }

  for (let offset = 1; offset < limit; offset++) {
    const candidate = start + offset;
    if (candidate > 65_535) break;
    if (await probe(candidate, { host })) {
      return { port: candidate, preferred: start, moved: true, exhausted: false };
    }
  }

  return { port: null, preferred: start, moved: false, exhausted: true };
}

/**
 * The port the console is actually on, as recorded by `yos init`.
 *
 * Every place that names the port to a user or wires traffic to it reads this,
 * so the printed URL, the Caddy route and the service cannot disagree.
 *
 * @returns {number}
 */
export function readRecordedConsolePort({ envFile = ENV_FILE, env = process.env } = {}) {
  const fromEnv = Number(env.WEB_CONSOLE_PORT);
  if (Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv < 65_536) return fromEnv;
  try {
    const match = fs.readFileSync(envFile, 'utf8').match(/^\s*WEB_CONSOLE_PORT\s*=\s*(\d+)\s*$/m);
    if (match) {
      const port = Number(match[1]);
      if (Number.isInteger(port) && port > 0 && port < 65_536) return port;
    }
  } catch { /* no .env yet — the default is still the truth */ }
  return DEFAULT_WEB_CONSOLE_PORT;
}
