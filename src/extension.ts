import * as vscode from 'vscode';
import { colorFor, DEFAULT_PALETTE, DEFAULT_THRESHOLDS, Palette, renderBar, Thresholds } from './bar';
import { Snapshot, UsageTracker, WindowState } from './usage';

const HIGH_WATER_KEY = 'claudeUsageBar.highWater';
const CAPS_KEY = 'claudeUsageBar.caps';

let tracker: UsageTracker;
let sessionItem: vscode.StatusBarItem;
let weekItem: vscode.StatusBarItem;
let timer: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext) {
    const home = config().get<string>('claudeHome') || UsageTracker.defaultHome();
    tracker = new UsageTracker(home);
    tracker.seed(
        context.globalState.get(HIGH_WATER_KEY, { session: 0, week: 0 }),
        context.globalState.get(CAPS_KEY, {})
    );

    // Left side, so it sits with the git indicators rather than off in the language/encoding cluster.
    sessionItem = vscode.window.createStatusBarItem('claudeUsageBar.session', vscode.StatusBarAlignment.Left, 100);
    weekItem = vscode.window.createStatusBarItem('claudeUsageBar.week', vscode.StatusBarAlignment.Left, 99);
    sessionItem.name = 'Claude session usage';
    weekItem.name = 'Claude weekly usage';
    sessionItem.command = 'claudeUsageBar.showDetails';
    weekItem.command = 'claudeUsageBar.showDetails';
    context.subscriptions.push(sessionItem, weekItem);

    context.subscriptions.push(
        vscode.commands.registerCommand('claudeUsageBar.refresh', () => tick(context)),
        vscode.commands.registerCommand('claudeUsageBar.showDetails', () => showDetails(context)),
        vscode.commands.registerCommand('claudeUsageBar.calibrate', () => calibrate(context)),
        vscode.commands.registerCommand('claudeUsageBar.resetHighWater', async () => {
            tracker.resetHighWater();
            await context.globalState.update(HIGH_WATER_KEY, { session: 0, week: 0 });
            await context.globalState.update(CAPS_KEY, {});
            tick(context);
            vscode.window.showInformationMessage('Claude Usage: caps reset; rebuilt from transcript history.');
        }),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('claudeUsageBar')) restartTimer(context);
        })
    );

    sessionItem.show();
    weekItem.show();
    restartTimer(context);
}

export function deactivate() {
    if (timer) clearInterval(timer);
}

function config() {
    return vscode.workspace.getConfiguration('claudeUsageBar');
}

function restartTimer(context: vscode.ExtensionContext) {
    if (timer) clearInterval(timer);
    tick(context);
    const seconds = Math.max(5, config().get<number>('refreshSeconds', 15));
    timer = setInterval(() => tick(context), seconds * 1000);
}

let last: Snapshot | undefined;

function tick(context: vscode.ExtensionContext) {
    const cfg = config();
    const sessionMs = cfg.get<number>('sessionWindowHours', 5) * 3600_000;
    const weekMs = cfg.get<number>('weekWindowDays', 7) * 86_400_000;
    const includeCacheReads = cfg.get<boolean>('includeCacheReads', false);

    let snap: Snapshot;
    try {
        snap = tracker.refresh(sessionMs, weekMs, includeCacheReads);
    } catch (err) {
        sessionItem.text = 'S $(error)';
        sessionItem.tooltip = `Claude Usage: could not read transcripts — ${err}`;
        weekItem.hide();
        return;
    }
    last = snap;

    void context.globalState.update(HIGH_WATER_KEY, tracker.getHighWater());
    void context.globalState.update(CAPS_KEY, tracker.getCaps());

    if (snap.events === 0) {
        sessionItem.text = 'S $(dash)';
        sessionItem.tooltip = 'Claude Usage: no transcripts found under ~/.claude/projects.';
        weekItem.hide();
        return;
    }

    const cells = Math.max(1, cfg.get<number>('barCells', 5));
    // A partial override in settings.json should keep the defaults for whatever it leaves out.
    const palette: Palette = { ...DEFAULT_PALETTE, ...cfg.get<Partial<Palette>>('colors', {}) };
    const thresholds: Thresholds = { ...DEFAULT_THRESHOLDS, ...cfg.get<Partial<Thresholds>>('thresholds', {}) };

    paint(sessionItem, 'S', snap.session, cells, palette, thresholds);
    paint(weekItem, 'W', snap.week, cells, palette, thresholds);
    weekItem.show();
}

function paint(item: vscode.StatusBarItem, label: string, w: WindowState, cells: number, palette: Palette, thresholds: Thresholds) {
    item.text = `${label} ${renderBar(w.fill, cells)}`;
    item.color = colorFor(w.fill, palette, thresholds);
    item.tooltip = tooltip(label, w);
}

function tooltip(label: string, w: WindowState): vscode.MarkdownString {
    const title = label === 'S' ? 'Session (rolling 5h)' : 'Week (rolling 7d)';
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${title}**\n\n`);
    md.appendMarkdown(`Used: \`${w.used.toLocaleString()}\` tokens — **${(w.fill * 100).toFixed(1)}%**\n\n`);
    md.appendMarkdown(`Cap: \`${w.cap.toLocaleString()}\`\n\n`);

    if (w.capSource === 'observed') {
        md.appendMarkdown(`_Cap is **exact** — pinned from a real limit hit._`);
    } else if (w.capSource === 'calibrated') {
        md.appendMarkdown(`_Cap is **calibrated** against a percentage \`/usage\` reported. Re-run **Claude Usage: Calibrate from /usage** if it drifts._`);
    } else {
        const when = w.peakAt ? new Date(w.peakAt).toLocaleDateString() : 'unknown';
        md.appendMarkdown(
            `_Cap is an **estimate**: the largest ${label === 'S' ? '5h' : '7d'} window you have ever ` +
            `sustained without being cut off (peak ${when}). The real cap is at least this, so the bar ` +
            `reads high rather than low. Run **Claude Usage: Calibrate from /usage** to make it exact._`
        );
    }
    return md;
}

/**
 * Ask for what `/usage` currently reports and back-compute the caps: cap = used_now / fraction.
 * This is the only way to learn the true cap short of actually hitting it.
 */
async function calibrate(context: vscode.ExtensionContext) {
    const cfg = config();
    const includeCacheReads = cfg.get<boolean>('includeCacheReads', false);
    const windows: Array<{ scope: 'session' | 'week'; label: string; ms: number }> = [
        { scope: 'session', label: 'Session (5h)', ms: cfg.get<number>('sessionWindowHours', 5) * 3600_000 },
        { scope: 'week', label: 'Week (7d)', ms: cfg.get<number>('weekWindowDays', 7) * 86_400_000 }
    ];

    const applied: string[] = [];
    for (const w of windows) {
        const answer = await vscode.window.showInputBox({
            title: `Calibrate — ${w.label}`,
            prompt: `Run /usage in Claude Code. What percentage does it report for ${w.label}? Leave blank to skip.`,
            placeHolder: 'e.g. 68',
            validateInput: v => {
                if (!v.trim()) return null;
                const n = Number(v.replace('%', '').trim());
                return Number.isFinite(n) && n > 0 && n <= 100 ? null : 'Enter a number between 0 and 100.';
            }
        });
        if (answer === undefined) return; // escaped
        if (!answer.trim()) continue;

        const pct = Number(answer.replace('%', '').trim());
        const cap = tracker.calibrate(w.scope, pct / 100, w.ms, includeCacheReads);
        applied.push(`${w.label}: cap ≈ ${cap.toLocaleString()} tokens`);
    }

    if (applied.length === 0) return;
    await context.globalState.update(CAPS_KEY, tracker.getCaps());
    tick(context);
    vscode.window.showInformationMessage(`Claude Usage calibrated — ${applied.join('; ')}`);
}

async function showDetails(context: vscode.ExtensionContext) {
    if (!last) {
        vscode.window.showInformationMessage('Claude Usage: no data yet.');
        return;
    }
    const hits = tracker.getLimitHits();
    const lines = [
        `Session (5h):  ${last.session.used.toLocaleString()} / ${last.session.cap.toLocaleString()}  (${(last.session.fill * 100).toFixed(1)}%)  cap: ${last.session.capSource}`,
        `Week    (7d):  ${last.week.used.toLocaleString()} / ${last.week.cap.toLocaleString()}  (${(last.week.fill * 100).toFixed(1)}%)  cap: ${last.week.capSource}`,
        ``,
        `Messages tracked: ${last.events.toLocaleString()}`,
        `History since:    ${last.since ? new Date(last.since).toLocaleString() : 'n/a'}`,
        `Metering:         input + output + cache_write${config().get<boolean>('includeCacheReads') ? ' + cache_read' : ' (cache reads excluded)'}`,
        `Limit hits seen:  ${hits.length === 0 ? 'none — caps are high-water estimates' : hits.map(h => new Date(h.t).toLocaleString()).join(', ')}`
    ];
    const channel = vscode.window.createOutputChannel('Claude Usage');
    channel.clear();
    channel.appendLine(lines.join('\n'));
    channel.show(true);
}
