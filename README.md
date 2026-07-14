# Claude Usage Bar

Two bars in the VS Code status bar: **S** = 5-hour session usage, **W** = weekly usage.

```
S █▍░░░ 28%   W ▏░░░░ 3%
```

![image](preview.png)

## Where the numbers come from

Straight from `https://api.anthropic.com/api/oauth/usage` — **the same endpoint `/usage` itself
calls**, authenticated with the OAuth token Claude Code has already stored on your machine. The
percentages are the ones Anthropic computes, not a guess: same meter, same reset boundaries, same
numbers you'd see by typing `/usage`.

That also means the bar knows **when your limits reset** (hover either bar for a countdown), which is
something no amount of local arithmetic can work out.

### Why not read the transcripts?

Earlier versions did, and it could not be made accurate. Transcripts record raw token counts, but:

- **Limits don't reset on a rolling window.** They reset at fixed boundaries the transcripts never
  mention, so a local estimate keeps showing yesterday's usage after a reset has already cleared it.
- **Limits aren't metered in raw tokens.** Anthropic weights usage per model, and doesn't publish the
  weights or your cap.

Anything derived from `~/.claude/projects/**/*.jsonl` is therefore an estimate with no way to
self-correct. This extension no longer guesses.

## Credentials

Read-only, from `~/.claude/.credentials.json` (or the macOS Keychain). The token is re-read on every
poll, so when Claude Code rotates it in the background the bar picks it up with no restart.

The extension **never refreshes the token itself.** Refreshing rotates the refresh token, and racing
Claude Code for it would sign you out of both. If sign-in expires, run `claude` once in a terminal
and the bar recovers on its next poll.

## Failure behaviour

A wrong number is worse than no number. If the API can't be reached, the bar keeps the last good
reading but flags it with a ⚠ and tells you in the tooltip how stale it is. If a reading was never
obtained, it says so rather than showing an empty bar.

## Colours

Green below 50%, yellow to 66%, orange to 75%, red to 100%, dark blue at cap. `S` and `W` are
separate status bar items, so they colour independently. Both the palette and the thresholds are
settings.

## Settings

| Setting | Default | |
|---|---|---|
| `claudeUsageBar.refreshSeconds` | `150` | poll interval — 2.5 min is what the endpoint tolerates, and is also the floor. All windows share one poll at this rate; window-focus refreshes are served from it |
| `claudeUsageBar.showPercent` | `true` | show the numeric percentage next to each bar |
| `claudeUsageBar.barCells` | `5` | bar width in characters (8 sub-steps each) |
| `claudeUsageBar.claudeHome` | `~/.claude` | where to read the sign-in token from |
| `claudeUsageBar.colors` | — | palette overrides |
| `claudeUsageBar.thresholds` | — | fill fractions at which each colour takes over |

Commands: **Claude Usage: Refresh now**, **Claude Usage: Show details**.

## Develop

```bash
npm install
npm run compile
# then press F5 in VS Code to launch an Extension Development Host
```

## Install locally

```bash
npx @vscode/vsce package
code --install-extension claude-usage-bar-0.2.0.vsix
```
