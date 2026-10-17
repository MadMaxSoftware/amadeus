# Amadeus 0.4.3 - Fewer repeated steps, safer worker environments

Amadeus 0.4.3 fixes problems found by running real goals through Amadeus:
recoveries no longer redo finished work, projects can declare a build step,
pausing is cleaner, progress updates are smaller, and every worker now gets
an allowlisted environment.

## Less repeated work

- **Recoveries start from the rejected change.** When verification rejected a
  worker's change, the next worker used to start from a fresh copy and redo
  everything before fixing the problem. It now starts with that change
  already applied and only repairs it. If the change can no longer be applied
  (for example, the project moved on), the worker is told to redo it.
- **Recoveries see why the check failed.** The last lines a failed check
  printed are kept and passed to the recovery worker.
- **Declared build step.** A project that generates files from its sources
  can name the npm script that regenerates them in `.amadeus/verify.json`:

  ```json
  { "schemaVersion": 1, "build": "build", "checks": [] }
  ```

  Amadeus runs it in the worker sandbox before the other checks and applies
  the regenerated files together with the worker's change, so workers no
  longer have to run it. The script is read from your project, never from the
  worker's copy. A build step on its own does not count as a test.

## Pausing and progress

- **Pause cancels work that has not started.** Pausing a goal whose next step
  has not called a model yet now puts that step back in the queue; it runs
  when you resume. A step already working still finishes. Stopping a goal at
  that point ends the step cleanly, with nothing to reconcile.
- **Smaller progress updates.** While a worker runs, the chat now receives a
  short update with only the new checkpoints, gathered for about 20 seconds,
  instead of the whole goal record on every worker command. Stage changes and
  finished work still return the full record.
- **Searches that find nothing are no longer "failures".** A search command
  that finds no matches is reported as "found no matches" instead of "failed;
  the worker is adapting".

## Safety

- **Allowlisted worker environment for Codex and Cursor.** Codex and Cursor
  workers, and the commands they run, used to get the whole host environment
  minus credential-named variables, so values such as `DATABASE_URL` still got
  through. They now get only process plumbing and what developer tools need:
  your profile and temp folders, locale and terminal settings, toolchain
  locations, and proxy and certificate settings. A proxy address with a user
  name or password in it is dropped. Claude-style workers already worked this
  way.

## For contributors

- The test suite passes inside the worker sandbox, so workers no longer chase
  two failures that were caused by the sandbox. Tests that must build a worker
  workspace skip there and run on your computer.
- `npm run worker:sandbox-run` runs a command in a real Codex worker sandbox
  over a copy of the repository (no model calls).
- `npm run codex:worker-live-check` makes one real Codex call to confirm that
  a worker signs in, edits a file and runs Node and Git.

## Upgrading

- **Codex / ChatGPT desktop:** `codex plugin marketplace upgrade amadeus`,
  then restart the app.
- **Claude Code:** `claude plugin update amadeus@amadeus`, then restart it.
- **Claude desktop app:** chats there use a copy synced to your claude.ai
  account, separate from Claude Code's. It updates after claude.ai has synced
  the new version; restart the app to pick it up.

See [UPDATE.md](UPDATE.md) for consent-based update checks.
