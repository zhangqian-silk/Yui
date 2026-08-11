// Fresh build boundary for the tier entrypoints.
//
// The tier test files import Yui internals from `dist/` (the compiled TypeScript
// output). A contributor who runs `make test-tier T=unit` on a fresh checkout —
// without first running `npm run build` — would otherwise hit a bare
// module-not-found from `dist/`. The supported entrypoint must not require a
// prior manual build, and it must never run leftover output that is older than
// src/. Presence of dist/cli.js cannot prove freshness, so the supported
// boundary always performs the one canonical TypeScript build before launching
// a non-empty tier. The default npm test path owns the same boundary through
// its pretest hook.
//
// The decision is factored into a pure, injectable function so it is
// deterministic and unit-testable without touching the real filesystem or
// spawning a real build.

/**
 * @typedef {Readonly<{
 *   built: boolean,
 *   reason: string,
 *   exitCode: number
 * }>} EnsureBuildResult
 */

/**
 * Performs the TypeScript build exactly once before a tier runs. Pure with
 * respect to its injected seam so a test can drive every branch:
 *
 * @param {Readonly<{
 *   build?: () => { status?: number | null, error?: Error },
 *   log?: (message: string) => void
 * }>} input
 * @returns {EnsureBuildResult}
 */
export function ensureDistBuilt(input) {
  if (typeof input.build !== "function") {
    return Object.freeze({
      built: false,
      reason: "fresh dist build required and no builder available",
      exitCode: 1
    });
  }
  input.log?.("Running fresh dist build (`npm run build`) before the tier.");
  const result = input.build();
  if (result?.error) {
    return Object.freeze({
      built: false,
      reason: `automatic build failed to start: ${result.error.message}`,
      exitCode: 1
    });
  }
  const status = result?.status ?? 1;
  return Object.freeze({
    built: status === 0,
    reason: status === 0
      ? "fresh dist build completed"
      : `automatic build exited with status ${status}`,
    exitCode: status
  });
}
