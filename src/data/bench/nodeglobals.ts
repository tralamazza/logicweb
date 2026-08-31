// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Minimal typed access to the node globals the two node entry points need.
 *
 * The project tsconfig sets `types: ["w3c-web-usb"]`, so @types/node is deliberately not
 * in scope - this is a browser application and the DOM lib is the right ambient set. The
 * node bench runners are development tools that happen to live under src/, so rather than
 * widening the project's ambient types (which is the lead's file, not mine) they reach
 * for `process` through globalThis with a local structural type, and fail loudly if it is
 * not there.
 */

export interface NodeProcessLike {
  argv: string[];
  env: Record<string, string | undefined>;
  exit(code: number): never;
  memoryUsage(): { rss: number; heapUsed: number; heapTotal: number };
}

export function nodeProcess(): NodeProcessLike {
  const p = (globalThis as { process?: NodeProcessLike }).process;
  if (!p || typeof p.exit !== 'function') {
    throw new Error('this entry point only runs under node; use src/data/bench/main.ts in a browser');
  }
  return p;
}

/** `--expose-gc` if it was passed, otherwise null. */
export function nodeGc(): (() => void) | null {
  return (globalThis as { gc?: () => void }).gc ?? null;
}
