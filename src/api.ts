// The authoritative source for Claude usage: the same endpoint `/usage` itself calls.
//
// No vscode import, so it can be exercised outside the editor.
//
// Everything here is read-only with respect to Claude Code's own state. In particular we never
// refresh the OAuth token ourselves: refresh rotates the refresh token, and racing Claude Code for
// that would sign the user out of both. We just re-read the credential file on every poll, so when
// Claude Code rotates the token in the background we pick the new one up on the next tick.

import * as cp from 'child_process';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';
const TIMEOUT_MS = 15_000;

/** Credentials are missing or rejected — the user has to act. Distinct from a transient outage. */
export class AuthError extends Error {}
/** The endpoint was reachable but unhappy, or wasn't reachable at all. Retrying may fix it. */
export class ApiError extends Error {}

/** One limit meter, as a percentage of the cap with the instant it resets. */
export interface Meter {
    percent: number;         // 0-100, as Anthropic computes it — not a token count
    resetsAt: number | null; // epoch ms
}

/** A weekly limit scoped to one model (e.g. "Opus"), which rides alongside the overall weekly cap. */
export interface ScopedMeter extends Meter {
    label: string;
}

export interface UsageSnapshot {
    session: Meter;
    week: Meter;
    scoped: ScopedMeter[];
    fetchedAt: number;
}

interface Credentials {
    accessToken: string;
    expiresAt: number | null;
}

export async function fetchUsage(claudeHome: string): Promise<UsageSnapshot> {
    const creds = loadCredentials(claudeHome);
    const body = await getJson(USAGE_URL, creds.accessToken);
    return parseUsage(body);
}

/**
 * Claude Code keeps its OAuth token in a file everywhere except macOS, where it lives in the
 * Keychain. Try the file first regardless — on macOS a file is still written in some setups.
 */
export function loadCredentials(claudeHome: string): Credentials {
    const file = path.join(claudeHome, '.credentials.json');
    let raw: string | undefined;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch {
        // Fall through to the Keychain.
    }

    const fromFile = raw ? parseCredentials(raw) : null;
    if (fromFile) return fromFile;

    if (process.platform === 'darwin') {
        const fromKeychain = readKeychain();
        if (fromKeychain) return fromKeychain;
    }

    throw new AuthError('No Claude Code credentials found. Run `claude` once to sign in.');
}

function parseCredentials(raw: string): Credentials | null {
    try {
        const oauth = JSON.parse(raw)?.claudeAiOauth;
        if (typeof oauth?.accessToken !== 'string' || !oauth.accessToken) return null;
        return {
            accessToken: oauth.accessToken,
            expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null
        };
    } catch {
        return null;
    }
}

function readKeychain(): Credentials | null {
    try {
        const out = cp.execFileSync(
            'security',
            ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
            { encoding: 'utf8', timeout: 5_000 }
        );
        return parseCredentials(out);
    } catch {
        return null;
    }
}

/**
 * node:https rather than fetch, because VS Code patches the https agent for corporate proxies when
 * http.proxySupport is on and undici's fetch does not go through it.
 */
function getJson(url: string, token: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const req = https.request(
            url,
            {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'anthropic-beta': OAUTH_BETA,
                    Accept: 'application/json',
                    'User-Agent': 'claude-usage-bar'
                },
                timeout: TIMEOUT_MS
            },
            res => {
                const chunks: Buffer[] = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => {
                    const status = res.statusCode ?? 0;
                    if (status === 401 || status === 403) {
                        reject(new AuthError('Claude Code sign-in has expired. Run `claude` to sign in again.'));
                        return;
                    }
                    if (status < 200 || status >= 300) {
                        reject(new ApiError(`Usage API returned HTTP ${status}.`));
                        return;
                    }
                    try {
                        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                    } catch {
                        reject(new ApiError('Usage API returned a malformed response.'));
                    }
                });
            }
        );
        req.on('timeout', () => req.destroy(new ApiError('Usage API timed out.')));
        req.on('error', err => reject(err instanceof ApiError ? err : new ApiError(err.message)));
        req.end();
    });
}

export function parseUsage(body: any): UsageSnapshot {
    // Refuse to invent a reading. A missing meter must surface as an error, not as a confident 0% —
    // an empty bar is indistinguishable from "you've used nothing", which is the exact failure this
    // extension exists to avoid.
    if (!isMeter(body?.five_hour) || !isMeter(body?.seven_day)) {
        throw new ApiError('Usage API response did not contain the expected session and weekly meters.');
    }
    return {
        session: meter(body.five_hour),
        week: meter(body.seven_day),
        scoped: scopedMeters(body),
        fetchedAt: Date.now()
    };
}

function isMeter(raw: any): boolean {
    return !!raw && Number.isFinite(Number(raw.utilization));
}

function meter(raw: any): Meter {
    const pct = Number(raw?.utilization);
    return {
        percent: Number.isFinite(pct) ? Math.max(0, pct) : 0,
        resetsAt: epoch(raw?.resets_at)
    };
}

/**
 * The `limits` array is the richer, newer shape and is the only place the per-model weekly caps are
 * named. Absent or unrecognised entries just mean no scoped bars — never a hard failure.
 */
function scopedMeters(body: any): ScopedMeter[] {
    if (!Array.isArray(body?.limits)) return [];
    return body.limits
        .filter((l: any) => l?.kind === 'weekly_scoped' && typeof l?.scope?.model?.display_name === 'string')
        .map((l: any) => ({
            label: l.scope.model.display_name as string,
            percent: Number.isFinite(Number(l.percent)) ? Math.max(0, Number(l.percent)) : 0,
            resetsAt: epoch(l.resets_at)
        }));
}

function epoch(v: any): number | null {
    if (typeof v !== 'string') return null;
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
}
