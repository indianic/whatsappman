import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, copyFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Full-cycle smoke test on Linux, in a throwaway container.
 *
 * TIER: smoke — not a unit test, not an eval. `test/` asks whether a function
 * computes the right value; `eval/` asks whether the surface we hand a model or
 * a user is correct and self-consistent, offline and in under a second. This
 * asks the third question neither can: does the ACTUAL published artifact
 * install and work on a real operating system? It needs network, a container
 * runtime and a running daemon, so it deliberately lives outside `npm run
 * verify` and runs as `npm run smoke`.
 *
 * Every other test here imports TypeScript from src/. That can never catch the
 * failures that only exist for a real user on a real machine: a file missing
 * from the published package, a POSIX-only assumption, the wrong autostart
 * mechanism picked for the platform, or a daemon that will not start outside
 * macOS. This installs the ACTUAL npm tarball into a clean Linux image and
 * drives the CLI end to end.
 *
 * OPT-IN: it needs Docker, and reports as skipped without it. Run it with:
 *
 *   npm run smoke         # ~9s warm, ~25s the first time
 *   npm run smoke:clean   # drop the cached base image + npm cache
 *
 * WHAT IS CACHED, AND WHY. There is no per-run `docker build` at all. A base
 * image of OS + node + git is built once and reused; this run's tarball and
 * smoke script are bind-mounted into it, and npm's cache lives in a named
 * volume. The earlier version baked the tarball into an image and deleted the
 * image afterwards, so every run re-did apt and an npm install that clones
 * libsignal over git — work that never changes between runs.
 *
 * WHAT IS STILL DISPOSED. The run container (`--rm`) and the build context, in
 * a finally block, on success and failure alike. Only the two cache artifacts
 * survive, and `npm run smoke:clean` removes those on demand.
 *
 * NOT covered: Windows. Windows containers require a Windows host, so no amount
 * of Docker on macOS or Linux can substitute for testing there — that is what
 * the windows-latest runner in .github/workflows/ci.yml is for.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * The base image: OS + node + git, and nothing of ours.
 *
 * Kept deliberately free of the package so it is stable and can be REUSED. The
 * first version of this eval baked the tarball into the image and deleted the
 * whole thing afterwards, so every run re-did the expensive part — apt, and an
 * npm install that clones libsignal over git. Nothing about the OS changes
 * between runs, so nothing about it needs rebuilding.
 *
 * `git` is not optional: Baileys depends on libsignal via a git URL, so npm
 * shells out to git during install. Without it the install dies with a bare
 * "npm error syscall spawn git / ENOENT" — exactly what a user on a lean box
 * would see.
 */
const BASE_DOCKERFILE = `FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends procps ca-certificates git \\
 && rm -rf /var/lib/apt/lists/*
`;

/**
 * Tagged by a hash of its own definition, so editing BASE_DOCKERFILE builds a
 * new base automatically instead of silently reusing a stale one.
 */
const BASE_TAG = `whatsappman-smoke-base:${createHash('sha1').update(BASE_DOCKERFILE).digest('hex').slice(0, 12)}`;

/** Persistent npm cache, so the dependency download happens once per machine. */
const NPM_CACHE_VOLUME = 'whatsappman-smoke-npm-cache';

function imageExists(tag: string): boolean {
  try {
    execFileSync('docker', ['image', 'inspect', tag], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Build the base only when it is missing. This is the whole caching story. */
function ensureBase(): { built: boolean } {
  if (imageExists(BASE_TAG)) return { built: false };
  const ctx = mkdtempSync(path.join(os.tmpdir(), 'wam-base-'));
  try {
    writeFileSync(path.join(ctx, 'Dockerfile'), BASE_DOCKERFILE);
    execFileSync('docker', ['build', '-q', '-t', BASE_TAG, ctx], { stdio: 'pipe' });
    return { built: true };
  } finally {
    rmSync(ctx, { recursive: true, force: true });
  }
}

test(
  'the published package installs and works end-to-end on Linux',
  // Skips rather than fails without Docker: this tier is explicitly opt-in, and
  // a missing container runtime is not a defect in the product.
  { skip: !dockerAvailable() ? 'Docker is not available — skipping the container smoke test' : false },
  () => {

    const { built } = ensureBase();
    console.log(built ? `built base image ${BASE_TAG}` : `reusing cached base image ${BASE_TAG}`);

    const ctx = mkdtempSync(path.join(os.tmpdir(), 'wam-docker-'));
    let output = '';
    try {
      // Pack the REAL artifact: this is what npm would publish, so a file
      // missing from package.json "files" fails here rather than for a user.
      execFileSync('npm', ['pack', '--pack-destination', ctx], { cwd: ROOT, stdio: 'pipe' });
      const tgz = readdirSync(ctx).find((f) => f.endsWith('.tgz'));
      assert.ok(tgz, 'npm pack produced no tarball');
      copyFileSync(path.join(ctx, tgz), path.join(ctx, 'pkg.tgz'));
      // The SAME assertions CI runs on ubuntu/macos/windows — one list, so the
      // container and the three CI platforms can never drift apart.
      copyFileSync(path.join(ROOT, 'smoke/cli-assertions.mjs'), path.join(ctx, 'cli-assertions.mjs'));
      // Exercises every command, including stop/restart/reset — safe only here,
      // where the whole machine is disposable.
      copyFileSync(path.join(ROOT, 'smoke/all-commands.mjs'), path.join(ctx, 'all-commands.mjs'));

      // No per-run `docker build`: mount this run's two files into the cached
      // base and install there. The image layer that used to be invalidated by
      // every fresh tarball simply no longer exists, and the npm cache volume
      // carries the dependency download (libsignal's git clone included) over
      // from the last run.
      output = execFileSync(
        'docker',
        [
          'run',
          '--rm',
          '-v',
          `${ctx}:/work:ro`,
          '-v',
          `${NPM_CACHE_VOLUME}:/root/.npm`,
          BASE_TAG,
          'sh',
          '-c',
          'npm install -g /work/pkg.tgz --no-fund --no-audit >/dev/null 2>&1 && node /work/cli-assertions.mjs && node /work/all-commands.mjs',
        ],
        { encoding: 'utf8', stdio: 'pipe' },
      );
    } catch (err) {
      const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
      output = String(e.stdout ?? '') + String(e.stderr ?? '') + (e.message ?? '');
      throw new Error(`Linux smoke test failed:\n${output}`);
    } finally {
      // The run container is disposed by --rm and the build context by path.
      // The base image and npm cache are deliberately KEPT — they are the cache.
      // `npm run smoke:clean` removes them when you want the space back.
      rmSync(ctx, { recursive: true, force: true });
    }

    process.stdout.write(output);
    assert.match(output, /RESULT:0/, 'one or more in-container checks failed (see output above)');
  },
);
