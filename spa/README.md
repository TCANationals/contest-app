# TCA Timer — SPA

Scaffolding for the judge web app described in `TCA_Timer_Design_Spec.docx.md` §10.

All business logic is currently a placeholder.

## Commands

```bash
npm install
npm run lint      # tsc -b --noEmit
npm test          # vitest run
npm run dev       # vite
npm run build     # tsc -b && vite build
npm run preview   # vite preview
```

## Structure

```
src/
  main.tsx          mounts React, Router, React-Query
  App.tsx           navigation skeleton
  pages/            Timer, Help, Log, Settings, Rooms, Projector (§10.2)
  components/
    CountdownWithBorder.tsx   shared digit renderer (§9.2.4, §10.5)
  hooks/
    useWebSocket.ts           WS connect + reconnect stub (§6.4)
    useTimer.ts               offset + computeRemainingMs (§6.5)
  store/            Zustand store (placeholder)
  pwa/              manifest + service-worker stub (§10.1)
```
