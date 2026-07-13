// Pure rendering — no vscode import, so it can be exercised outside the editor.
// Defaults are the palette and thresholds from the original bar.html sketch; both are overridable
// from settings (claudeUsageBar.colors / claudeUsageBar.thresholds) with no rebuild.

export interface Palette {
    green: string;
    yellow: string;
    orange: string;
    red: string;
    maxed: string; // at or over cap
}

export interface Thresholds {
    yellow: number; // fill at or above this is yellow
    orange: number;
    red: number;
}

export const DEFAULT_PALETTE: Palette = {
    green: '#009C00',
    yellow: '#f3f300',
    orange: '#f99630',
    red: '#e90000',
    maxed: '#0033cc'
};

export const DEFAULT_THRESHOLDS: Thresholds = {
    yellow: 0.5,
    orange: 0.66,
    red: 0.75
};

// Eighth-blocks give 8 sub-steps per cell, so the default 5-cell bar has 40 steps of fill.
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
const FULL = '█';
const EMPTY = '░';

export function renderBar(fill: number, cells: number): string {
    const clamped = Math.max(0, Math.min(1, fill));
    const eighths = Math.round(clamped * cells * 8);
    let out = '';
    for (let i = 0; i < cells; i++) {
        const e = Math.max(0, Math.min(8, eighths - i * 8));
        out += e === 8 ? FULL : e === 0 ? EMPTY : EIGHTHS[e];
    }
    return out;
}

export function colorFor(
    fill: number,
    palette: Palette = DEFAULT_PALETTE,
    thresholds: Thresholds = DEFAULT_THRESHOLDS
): string {
    if (fill >= 1) return palette.maxed;
    if (fill >= thresholds.red) return palette.red;
    if (fill >= thresholds.orange) return palette.orange;
    if (fill >= thresholds.yellow) return palette.yellow;
    return palette.green;
}
