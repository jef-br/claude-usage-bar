// Pure rendering — no vscode import, so it can be exercised outside the editor.
// Palette and thresholds lifted verbatim from the original bar.html sketch.

export const BAR_GREEN = '#009C00';
export const BAR_YELLOW = '#f3f300';
export const BAR_ORANGE = '#f99630';
export const BAR_RED = '#e90000';
export const BAR_MAXED = '#0033cc'; // --bgColorDark: at or over the estimated cap

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

export function colorFor(fill: number): string {
    if (fill < 0.5) return BAR_GREEN;
    if (fill < 0.66) return BAR_YELLOW;
    if (fill < 0.75) return BAR_ORANGE;
    if (fill < 1) return BAR_RED;
    return BAR_MAXED;
}
