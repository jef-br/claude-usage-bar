import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { fetchUsage, Meter, UsageSnapshot } from './api';
import { colorFor, DEFAULT_PALETTE, DEFAULT_THRESHOLDS, Palette, renderBar, Thresholds } from './bar';

let sessionItem: vscode.StatusBarItem;
let weekItem: vscode.StatusBarItem;
let channel: vscode.OutputChannel;
let timer: NodeJS.Timeout | undefined;

/** Last successful read. Kept across failures so a blip shows a stale-but-real number, never a wrong one. */
let snapshot: UsageSnapshot | undefined;
let failure: string | undefined;
let inFlight = false;

export function activate(context: vscode.ExtensionContext) {
    // Left side, so it sits with the git indicators rather than off in the language/encoding cluster.
    sessionItem = vscode.window.createStatusBarItem('claudeUsageBar.session', vscode.StatusBarAlignment.Left, 100);
    weekItem = vscode.window.createStatusBarItem('claudeUsageBar.week', vscode.StatusBarAlignment.Left, 99);
    sessionItem.name = 'Claude session usage';
    weekItem.name = 'Claude weekly usage';
    sessionItem.command = 'claudeUsageBar.showDetails';
    weekItem.command = 'claudeUsageBar.showDetails';

    channel = vscode.window.createOutputChannel('Claude Usage');

    context.subscriptions.push(
        sessionItem,
        weekItem,
        channel,
        vscode.commands.registerCommand('claudeUsageBar.refresh', refreshCommand),
        vscode.commands.registerCommand('claudeUsageBar.showDetails', showDetails),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('claudeUsageBar')) restartTimer();
        }),
        // Coming back to the window is the moment a stale bar is most likely to mislead.
        vscode.window.onDidChangeWindowState(state => {
            if (state.focused) void poll();
        })
    );

    sessionItem.text = 'S $(sync~spin)';
    sessionItem.show();
    restartTimer();
}

export function deactivate() {
    if (timer) clearInterval(timer);
}

function config() {
    return vscode.workspace.getConfiguration('claudeUsageBar');
}

function claudeHome(): string {
    return config().get<string>('claudeHome') || path.join(os.homedir(), '.claude');
}

function restartTimer() {
    if (timer) clearInterval(timer);
    void poll();
    // Floor of 15s: the endpoint is cheap but it is a shared service, not a local file.
    const seconds = Math.max(15, config().get<number>('refreshSeconds', 60));
    timer = setInterval(() => void poll(), seconds * 1000);
}

async function poll(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
        // fetchUsage re-reads the credential file every time, so a token Claude Code rotated in the
        // background is picked up here without a restart.
        snapshot = await fetchUsage(claudeHome());
        failure = undefined;
    } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
    } finally {
        inFlight = false;
        paintAll();
    }
}

function paintAll() {
    const cfg = config();
    const cells = Math.max(1, cfg.get<number>('barCells', 5));
    // A partial override in settings.json should keep the defaults for whatever it leaves out.
    const palette: Palette = { ...DEFAULT_PALETTE, ...cfg.get<Partial<Palette>>('colors', {}) };
    const thresholds: Thresholds = { ...DEFAULT_THRESHOLDS, ...cfg.get<Partial<Thresholds>>('thresholds', {}) };
    const showPercent = cfg.get<boolean>('showPercent', true);

    if (!snapshot) {
        sessionItem.text = '$(warning) Claude usage';
        sessionItem.color = undefined;
        sessionItem.tooltip = failureTooltip();
        sessionItem.show();
        weekItem.hide();
        return;
    }

    const stale = failure !== undefined;
    paint(sessionItem, 'S', snapshot.session, cells, palette, thresholds, showPercent, stale);
    paint(weekItem, 'W', snapshot.week, cells, palette, thresholds, showPercent, stale);
    weekItem.show();
}

function paint(
    item: vscode.StatusBarItem,
    label: string,
    m: Meter,
    cells: number,
    palette: Palette,
    thresholds: Thresholds,
    showPercent: boolean,
    stale: boolean
) {
    const fill = Math.min(1, Math.max(0, m.percent / 100));
    const pct = showPercent ? ` ${Math.round(m.percent)}%` : '';
    item.text = `${stale ? '$(warning) ' : ''}${label} ${renderBar(fill, cells)}${pct}`;
    item.color = colorFor(fill, palette, thresholds);
    item.tooltip = tooltip(label, m, stale);
}

function tooltip(label: string, m: Meter, stale: boolean): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${label === 'S' ? 'Session' : 'Weekly'}** — ${m.percent.toFixed(0)}% used\n\n`);
    md.appendMarkdown(`Resets ${untilText(m.resetsAt)}${m.resetsAt ? ` (${new Date(m.resetsAt).toLocaleString()})` : ''}\n\n`);

    if (label === 'W' && snapshot?.scoped.length) {
        const active = snapshot.scoped.filter(s => s.percent > 0);
        if (active.length) {
            md.appendMarkdown(`Per-model weekly: ${active.map(s => `${s.label} ${s.percent.toFixed(0)}%`).join(', ')}\n\n`);
        }
    }

    md.appendMarkdown('---\n\n');
    if (stale) {
        md.appendMarkdown(`$(warning) **Stale** — last good read ${new Date(snapshot!.fetchedAt).toLocaleTimeString()}.\n\n`);
        md.appendMarkdown(`Latest attempt failed: ${failure}`);
        md.supportThemeIcons = true;
    } else {
        md.appendMarkdown(`_Live from Claude's usage API — the same numbers \`/usage\` reports. Updated ${new Date(snapshot!.fetchedAt).toLocaleTimeString()}._`);
    }
    return md;
}

function failureTooltip(): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**Claude Usage — no data**\n\n${failure ?? 'Loading…'}`);
    return md;
}

/** Relative reset time. "in 3h 12m" is what you actually want to know; the wall clock is secondary. */
function untilText(t: number | null): string {
    if (t === null) return 'at an unknown time';
    const ms = t - Date.now();
    if (ms <= 0) return 'now';
    const mins = Math.round(ms / 60_000);
    if (mins < 60) return `in ${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `in ${hours}h ${mins % 60}m`;
    return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * A command that silently does its work reads as a broken command. Always land some visible signal:
 * a transient status message on success, a modal-free warning on failure.
 */
async function refreshCommand() {
    await poll();
    if (failure) {
        const action = failure.includes('sign in') ? 'How do I fix this?' : undefined;
        const picked = await vscode.window.showWarningMessage(`Claude Usage: ${failure}`, ...(action ? [action] : []));
        if (picked) showDetails();
        return;
    }
    vscode.window.setStatusBarMessage(
        `$(check) Claude Usage: session ${snapshot!.session.percent.toFixed(0)}%, week ${snapshot!.week.percent.toFixed(0)}%`,
        4000
    );
}

function showDetails() {
    const lines: string[] = [];
    if (snapshot) {
        lines.push(
            `Session   ${snapshot.session.percent.toFixed(0).padStart(3)}%   resets ${untilText(snapshot.session.resetsAt)}   ${stamp(snapshot.session.resetsAt)}`,
            `Weekly    ${snapshot.week.percent.toFixed(0).padStart(3)}%   resets ${untilText(snapshot.week.resetsAt)}   ${stamp(snapshot.week.resetsAt)}`
        );
        for (const s of snapshot.scoped) {
            lines.push(`  ${s.label} (weekly)  ${s.percent.toFixed(0).padStart(3)}%`);
        }
        lines.push('', `Last successful read: ${new Date(snapshot.fetchedAt).toLocaleString()}`);
    } else {
        lines.push('No usage data yet.');
    }

    lines.push('', `Source: https://api.anthropic.com/api/oauth/usage (the endpoint /usage itself calls)`);
    lines.push(`Credentials: ${path.join(claudeHome(), '.credentials.json')}${process.platform === 'darwin' ? ' or macOS Keychain' : ''}`);

    if (failure) {
        lines.push('', `Last attempt FAILED: ${failure}`);
        lines.push('', 'If sign-in has expired, run `claude` in a terminal once — Claude Code will refresh');
        lines.push('the token and this bar will pick it up on the next poll. This extension deliberately');
        lines.push('never refreshes the token itself, to avoid signing you out of Claude Code.');
    }

    channel.clear();
    channel.appendLine(lines.join('\n'));
    channel.show(true);
}

function stamp(t: number | null): string {
    return t ? `(${new Date(t).toLocaleString()})` : '';
}
