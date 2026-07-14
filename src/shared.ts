// One VS Code install can have many windows open, and every window runs its own extension host — so
// without coordination the poll rate is (windows x timer) + (a poll per focus change), which is how
// you get a 429 from an endpoint that a single window would never trouble.
//
// Everything below is that coordination: a state file in global storage (one path for all windows of
// an install) holding the last good snapshot and any rate-limit backoff, plus a lock file so only one
// window actually calls the API on any given tick. Both are advisory. A window that cannot read or
// take them still works — it just does its own fetch, which is exactly today's behaviour.

import * as fs from 'fs';
import * as path from 'path';
import { UsageSnapshot } from './api';

export interface SharedState {
    /** Last successful read from any window. */
    snapshot?: UsageSnapshot;
    /** No window may call the API before this instant (epoch ms). Set when we get a 429. */
    backoffUntil?: number;
    /** Consecutive 429s, so the backoff escalates instead of retrying into the same wall. */
    strikes?: number;
}

/** How long a fetch may hold the lock before another window assumes the holder died. */
const LOCK_STALE_MS = 30_000;

export function stateFile(dir: string): string {
    return path.join(dir, 'usage-state.json');
}

export function read(file: string): SharedState {
    try {
        const state = JSON.parse(fs.readFileSync(file, 'utf8'));
        return state && typeof state === 'object' ? state : {};
    } catch {
        return {}; // Missing or corrupt is not an error: it just means we know nothing yet.
    }
}

export function write(file: string, state: SharedState): void {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // Write-then-rename, so a window reading concurrently sees the old file or the new one, never
        // a half-written one.
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
        fs.renameSync(tmp, file);
    } catch {
        // A shared cache we cannot write is a lost optimisation, not a failure worth surfacing.
    }
}

/**
 * True if this window won the right to make the API call. `wx` fails when the file exists, and that
 * failure is atomic on every platform we run on — which is the whole point.
 */
export function acquireLock(file: string): boolean {
    const lock = `${file}.lock`;
    try {
        fs.mkdirSync(path.dirname(lock), { recursive: true });
        fs.closeSync(fs.openSync(lock, 'wx'));
        return true;
    } catch {
        // Held. Steal it only if the holder is old enough to be presumed dead (crashed window, or a
        // fetch that outlived its timeout).
        try {
            if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
                fs.rmSync(lock, { force: true });
                fs.closeSync(fs.openSync(lock, 'wx'));
                return true;
            }
        } catch {
            // Lost the race to steal it, or cannot stat. Either way, someone else is fetching.
        }
        return false;
    }
}

export function releaseLock(file: string): void {
    try {
        fs.rmSync(`${file}.lock`, { force: true });
    } catch {
        // It will go stale and be stolen. Nothing useful to do here.
    }
}
