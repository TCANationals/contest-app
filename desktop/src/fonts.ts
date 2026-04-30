// Embed JetBrains Mono so the overlay renders with the intended
// monospaced digits on every host, regardless of what the user has
// installed (§9.2 calls for "JetBrains Mono or system monospace
// fallback" — we bundle the font directly so the primary option is
// always available).
//
// Only weights 400 and 700 are used by the overlay (700 for the
// countdown digits, 400 everywhere else). Importing the per-weight CSS
// files keeps the bundle small — Vite copies the matching .woff2 files
// into the dist/assets directory, so the CSP's `font-src 'self'` rule
// already covers them.

import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
