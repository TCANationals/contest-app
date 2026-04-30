# `@tca-timer/shared` — shared timer-display logic

Single source of truth for the timer rendering code that the
contestant overlay (`desktop/`) and the judge SPA (`spa/`) need to
render identically. Keeping it in one module guarantees that, e.g.
"red & pulsing under 60 s" or the local-clock offset math don't
drift between platforms.

This package is **pure TypeScript** with **no runtime dependencies**
— consumers import the `.ts` sources directly via `tsc` /
`@vitejs/plugin-react`'s native TS handling. There's no build step,
no `dist/` to publish, and no need for either consumer to keep its
own copy of `vitest` configured here.

## What's in here

| Module | Spec | Notes |
| :----- | :--- | :---- |
| `types.ts`     | §5.2 STATE frame + §6.3 ping sample | `TimerStatus`, `TimerState`, `OffsetSample` |
| `compute.ts`   | §6.3 / §6.5 | `computeRemainingMs(state, activeOffsetMs, now?)` |
| `format.ts`    | §9.2.4 / §10.5 | `formatMs(ms)` → `MM:SS` / `H:MM:SS`, `formatCountdown(status, ms)` → adds idle `--:--` |
| `colors.ts`    | §9.2.4 priority table | `countdownStyle(status, ms)` → `{color, outline, pulse}` |
| `timesync.ts`  | §6.3 | `OffsetTracker` (sliding window of 8, drop 2 worst RTTs, median of remaining 6) + `computeSample`/`median` helpers |

What is **NOT** in here:

- Alarm / flash decisions — desktop-only behavior (§9.5).
- React components (`CountdownWithBorder`) — currently a SPA-only
  Tailwind-styled component. A shared component would lock both
  apps into the same layout, which is wrong: the overlay is
  corner-anchored at 380×96 while the SPA renders the digits
  responsively at `8vw` with `paint-order` outlining. Sharing the
  *style decision* (color/outline/pulse) without the component
  layout is the right boundary.

## Consuming

`desktop/package.json` and `spa/package.json` reference this package
via a `file:` dependency:

```json
"dependencies": {
  "@tca-timer/shared": "file:../shared"
}
```

Both Vite + Vitest resolve those imports through the package's
`exports` map straight at the TS sources, so source edits in
`shared/src/` are picked up by the consuming app's normal dev /
HMR cycle without any rebuild step.

## Commands

```bash
cd shared
npm run lint   # tsc --noEmit
npm test       # vitest run
```
