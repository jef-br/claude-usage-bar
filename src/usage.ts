import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** One assistant message's token accounting, as recorded in a Claude Code transcript. */
export interface UsageEvent {
    t: number;          // epoch ms
    input: number;
    output: number;
    cacheWrite: number; // cache_creation_input_tokens
    cacheRead: number;  // cache_read_input_tokens
    model: string;
}

/** A limit we actually observed being hit — the only moment the true cap is directly visible. */
export interface LimitHit {
    t: number;
    text: string;
    scope: 'session' | 'week';
}

/**
 * Where a cap came from, in ascending order of trust:
 *  - estimate:   high-water mark. A lower bound — reads high, never low.
 *  - calibrated: back-computed from a percentage /usage reported. Exact for the meter in use.
 *  - observed:   pinned by an actual limit hit. Ground truth.
 */
export type CapSource = 'estimate' | 'calibrated' | 'observed';

export interface CapFact {
    value: number;
    source: 'calibrated' | 'observed';
    at: number;
}

export interface WindowState {
    used: number;
    cap: number;
    fill: number; // used / cap, clamped to [0,1]
    capSource: CapSource;
    peakAt: number | null;
}

export interface Snapshot {
    session: WindowState;
    week: WindowState;
    events: number;
    since: number | null;
}

/** Incremental read cursor for one append-only transcript file. */
interface FileCursor {
    offset: number;
    partial: string;
}

// Model-scoped limits ("You've reached your Fable 5 limit") are a different budget from the
// session/weekly caps this bar tracks — matching one would pin the wrong number.
const MODEL_LIMIT = /reached your (opus|sonnet|haiku|fable)\b/i;
const SESSION_LIMIT = /(session limit|5-hour limit|five-hour limit)/i;
const WEEK_LIMIT = /(weekly limit|week limit)/i;
const ANY_LIMIT = /(usage limit|limit reached|reached your .*limit)/i;

export class UsageTracker {
    private events: UsageEvent[] = [];
    private cursors = new Map<string, FileCursor>();
    private limitHits: LimitHit[] = [];

    // Ratchet: the largest window we have ever seen sustained. Persisted by the caller so it
    // survives a transcript being deleted, and so it only ever grows.
    private highWater = { session: 0, week: 0 };
    private caps: { session?: CapFact; week?: CapFact } = {};

    constructor(private claudeHome: string) {}

    static defaultHome(): string {
        return path.join(os.homedir(), '.claude');
    }

    seed(highWater: { session: number; week: number }, caps: { session?: CapFact; week?: CapFact }) {
        this.highWater = { ...highWater };
        this.caps = { ...caps };
    }

    getHighWater() { return { ...this.highWater }; }
    getCaps() { return { ...this.caps }; }
    getLimitHits() { return [...this.limitHits]; }

    resetHighWater() {
        this.highWater = { session: 0, week: 0 };
        this.caps = {};
    }

    /**
     * Pin a cap from a percentage that `/usage` reported. cap = used_now / fraction.
     *
     * Only valid for the meter in force when it was taken: the same reading implies a different cap
     * depending on whether cache reads are counted. Recalibrate after changing includeCacheReads.
     */
    calibrate(scope: 'session' | 'week', fraction: number, windowMs: number, includeCacheReads: boolean): number {
        if (!(fraction > 0 && fraction <= 1)) throw new Error('Percentage must be between 0 and 100.');
        const meter = this.meterFor(includeCacheReads);
        const now = Date.now();
        const used = this.windowSum(now - windowMs, now, meter);
        const value = Math.round(used / fraction);
        this.caps[scope] = { value, source: 'calibrated', at: now };
        return value;
    }

    private meterFor(includeCacheReads: boolean) {
        return (e: UsageEvent) =>
            e.input + e.output + e.cacheWrite + (includeCacheReads ? e.cacheRead : 0);
    }

    /** Re-read whatever has been appended since the last call. Cheap enough to run every few seconds. */
    refresh(sessionWindowMs: number, weekWindowMs: number, includeCacheReads: boolean): Snapshot {
        let added = false;
        for (const file of this.transcriptFiles()) {
            if (this.readAppended(file)) added = true;
        }
        if (added) this.events.sort((a, b) => a.t - b.t);

        const meter = this.meterFor(includeCacheReads);

        // Recompute peaks from the full history every refresh: 20k events is microseconds, and it
        // keeps the ratchet honest if the window length setting changes.
        const sPeak = this.rollingPeak(sessionWindowMs, meter);
        const wPeak = this.rollingPeak(weekWindowMs, meter);
        this.highWater.session = Math.max(this.highWater.session, sPeak.value);
        this.highWater.week = Math.max(this.highWater.week, wPeak.value);

        this.pinObservedCaps(sessionWindowMs, weekWindowMs, meter);

        const now = Date.now();
        const sUsed = this.windowSum(now - sessionWindowMs, now, meter);
        const wUsed = this.windowSum(now - weekWindowMs, now, meter);

        return {
            session: this.state(sUsed, this.caps.session, this.highWater.session, sPeak.at),
            week: this.state(wUsed, this.caps.week, this.highWater.week, wPeak.at),
            events: this.events.length,
            since: this.events.length ? this.events[0].t : null
        };
    }

    private state(used: number, known: CapFact | undefined, highWater: number, peakAt: number | null): WindowState {
        // A known cap (limit hit, or calibrated against /usage) is trusted outright. Otherwise fall
        // back to the high-water mark, which is only a LOWER BOUND on the cap — we sustained it
        // without being cut off, so the real cap is at least this. Reading against a lower bound
        // makes the bar pessimistic, which is the safe direction to err.
        const cap = known?.value ?? Math.max(highWater, 1);
        return {
            used,
            cap,
            fill: Math.min(1, used / cap),
            capSource: known?.source ?? 'estimate',
            peakAt
        };
    }

    private windowSum(from: number, to: number, meter: (e: UsageEvent) => number): number {
        let sum = 0;
        for (const e of this.events) {
            if (e.t >= from && e.t <= to) sum += meter(e);
        }
        return sum;
    }

    /** Largest total in any window of the given length across all history (two-pointer). */
    private rollingPeak(windowMs: number, meter: (e: UsageEvent) => number): { value: number; at: number | null } {
        let best = 0;
        let bestAt: number | null = null;
        let sum = 0;
        let lo = 0;
        for (let hi = 0; hi < this.events.length; hi++) {
            sum += meter(this.events[hi]);
            while (this.events[hi].t - this.events[lo].t > windowMs) {
                sum -= meter(this.events[lo]);
                lo++;
            }
            if (sum > best) {
                best = sum;
                bestAt = this.events[hi].t;
            }
        }
        return { value: best, at: bestAt };
    }

    /**
     * If we ever genuinely hit a session/weekly limit, the window total at that instant IS the cap.
     * That is the one moment the real number is observable, so we snap to it and stop estimating.
     */
    private pinObservedCaps(sessionWindowMs: number, weekWindowMs: number, meter: (e: UsageEvent) => number) {
        for (const hit of this.limitHits) {
            const windowMs = hit.scope === 'session' ? sessionWindowMs : weekWindowMs;
            // An actual limit hit outranks a calibration: it is the cap, not an inference from one.
            if (this.caps[hit.scope]?.source === 'observed') continue;
            this.caps[hit.scope] = {
                value: this.windowSum(hit.t - windowMs, hit.t, meter),
                source: 'observed',
                at: hit.t
            };
        }
    }

    private transcriptFiles(): string[] {
        const root = path.join(this.claudeHome, 'projects');
        if (!fs.existsSync(root)) return [];
        const out: string[] = [];
        for (const dir of fs.readdirSync(root)) {
            const full = path.join(root, dir);
            try {
                if (!fs.statSync(full).isDirectory()) continue;
                for (const f of fs.readdirSync(full)) {
                    if (f.endsWith('.jsonl')) out.push(path.join(full, f));
                }
            } catch {
                // A session directory can vanish mid-scan; skip it rather than kill the refresh.
            }
        }
        return out;
    }

    /** Reads only the bytes appended since last time. Returns true if any event was added. */
    private readAppended(file: string): boolean {
        let size: number;
        try {
            size = fs.statSync(file).size;
        } catch {
            return false;
        }

        const cursor = this.cursors.get(file) ?? { offset: 0, partial: '' };
        if (size < cursor.offset) {
            // Truncated or replaced — start over rather than emit garbage.
            cursor.offset = 0;
            cursor.partial = '';
        }
        if (size === cursor.offset) {
            this.cursors.set(file, cursor);
            return false;
        }

        let text: string;
        try {
            const fd = fs.openSync(file, 'r');
            try {
                const buf = Buffer.alloc(size - cursor.offset);
                fs.readSync(fd, buf, 0, buf.length, cursor.offset);
                text = cursor.partial + buf.toString('utf8');
            } finally {
                fs.closeSync(fd);
            }
        } catch {
            return false;
        }

        const lines = text.split('\n');
        cursor.partial = lines.pop() ?? ''; // last element is an incomplete line (or '')
        cursor.offset = size;
        this.cursors.set(file, cursor);

        let added = false;
        for (const line of lines) {
            if (!line.trim()) continue;
            if (this.ingest(line)) added = true;
        }
        return added;
    }

    private ingest(line: string): boolean {
        let rec: any;
        try {
            rec = JSON.parse(line);
        } catch {
            return false;
        }

        const ts = rec?.timestamp;
        const msg = rec?.message;
        if (!ts || !msg) return false;
        const t = Date.parse(ts);
        if (Number.isNaN(t)) return false;

        this.detectLimitHit(rec, msg, t);

        const u = msg.usage;
        if (!u) return false;

        this.events.push({
            t,
            input: u.input_tokens ?? 0,
            output: u.output_tokens ?? 0,
            cacheWrite: u.cache_creation_input_tokens ?? 0,
            cacheRead: u.cache_read_input_tokens ?? 0,
            model: msg.model ?? 'unknown'
        });
        return true;
    }

    /**
     * Claude Code writes an API error as a synthetic assistant message (model: "<synthetic>").
     * Only session/weekly hits pin our caps — a model-scoped one ("reached your Fable 5 limit")
     * is a separate budget and would pin the wrong number.
     */
    private detectLimitHit(rec: any, msg: any, t: number) {
        if (msg.model !== '<synthetic>') return;
        const content = msg.content;
        if (!Array.isArray(content)) return;
        const text = content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join(' ');
        if (!text || !ANY_LIMIT.test(text)) return;
        if (MODEL_LIMIT.test(text)) return;

        const scope: 'session' | 'week' | null =
            WEEK_LIMIT.test(text) ? 'week' : SESSION_LIMIT.test(text) ? 'session' : null;
        if (!scope) return; // Unattributable limit text — better to keep estimating than pin wrongly.

        if (!this.limitHits.some(h => h.t === t)) {
            this.limitHits.push({ t, text, scope });
        }
    }
}
