// Tests that also run inside an Amadeus worker sandbox (workers run `npm test` there).
// The sandbox's temp folder denies renames and Git metadata writes, while the workspace
// allows both, so worker runs keep scratch folders in the workspace's git-ignored .tmp.
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPOSITORY = resolve(import.meta.dirname, '..', '..');
const INSIDE_WORKER = process.env.AMADEUS_WORKER === '1';

export function scratchDir(prefix) {
  if (!INSIDE_WORKER) return mkdtempSync(join(tmpdir(), prefix));
  const root = join(REPOSITORY, '.tmp', 'test-scratch');
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, prefix));
}

/**
 * Skip reason for tests that build a worker workspace (a Git repository resolved through its
 * parent folders). Neither is possible inside the worker sandbox: the temp folder denies Git
 * metadata writes and the workspace's parent folders are unreadable. They run on the host.
 */
export const NEEDS_WORKER_WORKSPACE = INSIDE_WORKER
  && 'builds a worker workspace, which the worker sandbox cannot do; this test runs on the host';
