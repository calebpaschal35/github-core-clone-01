// Entry point: bind the forge, tell the suite where it lives, and wait until the suite is done.
//
// The env next door owns port 8080 and hands this process two things through the environment:
// MAKEFUN_ENV_URL (where to register and to ask "are we done yet") and MAKEFUN_SHOP_TOKEN (the
// bearer token the suite presents on every call). Without MAKEFUN_ENV_URL there is no trial to
// join, so the program stops at once instead of serving into the void.
//
// The order matters: the server listens first (port 0, so the kernel picks a free one), then the
// program registers that port, then it polls GET /done until the env answers {"done": true} and
// exits 0. A failed poll is retried with a short backoff; the program never exits early.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is not set, so there is no env to join\n');
  process.exit(1);
}

const PER_CALL_MS = 30_000;
const FIRST_WAIT_MS = 250;
const LONGEST_WAIT_MS = 2_000;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function waitAfter(attempt: number): number {
  return Math.min(LONGEST_WAIT_MS, FIRST_WAIT_MS * 2 ** Math.min(attempt, 8));
}

/** POST {"port": N} until the env takes it; 409 means a first registration already won. */
async function announce(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const answer = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(PER_CALL_MS),
      });
      if (answer.status === 200 || answer.status === 409) return;
      if (answer.status === 400 || answer.status === 405) {
        throw new Error(`register was refused with HTTP ${answer.status}: ${await answer.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register was refused')) throw err;
    }
    await pause(waitAfter(attempt));
  }
}

/** GET /done until the env answers {"done": true}; anything else means "keep waiting". */
async function waitUntilDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const answer = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(PER_CALL_MS) });
      if (answer.ok) {
        const body = (await answer.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is still starting, or the poll timed out: either way it is not done yet.
    }
    await pause(waitAfter(attempt));
  }
}

async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind a TCP port');
  }
  process.stdout.write(`[forge] listening on port ${bound.port}\n`);
  await announce(bound.port);
  process.stdout.write('[forge] registered; waiting for the env to finish\n');
  await waitUntilDone();
  server.close();
  process.stdout.write('[forge] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
