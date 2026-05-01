#!/usr/bin/env node
/**
 * Build `tca-timer-ctl` and copy the resulting binary into
 * `src-tauri/binaries/` with the `-<target-triple>` suffix Tauri's
 * `bundle.externalBin` sidecar mechanism requires.
 *
 * Tauri only renames / copies sidecar binaries when running `tauri build`
 * (the `bundle` step) and `tauri dev` — both of which set
 * `TAURI_ENV_TARGET_TRIPLE` for `before*Command` hooks.[1] When invoked
 * outside that hook (e.g. plain `cargo build` for a developer testing
 * the CLI on its own), we fall back to `rustc --print host-tuple` so
 * the script still produces a usable binary at the expected path.
 *
 * The script also accepts `--release` to switch the cargo profile; when
 * Tauri runs us via `beforeBundleCommand` we forward `TAURI_ENV_DEBUG`
 * so the sidecar's optimization level matches the host app's.
 *
 * [1] https://v2.tauri.app/reference/environment-variables
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, '..');
const tauriRoot = resolve(desktopRoot, 'src-tauri');
const binariesDir = resolve(tauriRoot, 'binaries');

function resolveTargetTriple() {
  if (process.env.TAURI_ENV_TARGET_TRIPLE) {
    return process.env.TAURI_ENV_TARGET_TRIPLE;
  }
  return execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' })
    .trim();
}

function resolveProfile() {
  if (process.argv.includes('--release')) return 'release';
  if (process.argv.includes('--debug')) return 'debug';
  // Inside a Tauri hook command we infer the profile from the env vars
  // set by the CLI:
  //
  //   `tauri build`         → TAURI_ENV_DEBUG unset, profile = release
  //   `tauri build --debug` → TAURI_ENV_DEBUG = "true", profile = debug
  //   `tauri dev`           → TAURI_ENV_DEBUG = "true", profile = debug
  //
  // The `TAURI_ENV_*` variables are only present when the script is
  // running as a `before*Command`; outside of that context (a developer
  // running `npm run build:ctl` directly) we default to debug since
  // that's what plain `cargo build` produces.
  const inTauriHook = Boolean(process.env.TAURI_ENV_TARGET_TRIPLE);
  if (inTauriHook) {
    return process.env.TAURI_ENV_DEBUG === 'true' ? 'debug' : 'release';
  }
  if (process.env.TAURI_ENV_DEBUG === 'false') return 'release';
  if (process.env.TAURI_ENV_DEBUG === 'true') return 'debug';
  return 'debug';
}

function buildOneTarget({ triple, profile, useTargetDir }) {
  const cargoArgs = ['build', '--manifest-path', join(desktopRoot, 'Cargo.toml'),
    '-p', 'tca-timer-ctl'];
  if (profile === 'release') cargoArgs.push('--release');
  let buildOutDir = join(desktopRoot, 'target', profile);
  if (useTargetDir) {
    cargoArgs.push('--target', triple);
    buildOutDir = join(desktopRoot, 'target', triple, profile);
  }

  console.log(`[build-ctl] cargo ${cargoArgs.join(' ')}`);
  execFileSync('cargo', cargoArgs, { stdio: 'inherit', cwd: desktopRoot });

  const isWindows = triple.includes('windows');
  const exeSuffix = isWindows ? '.exe' : '';
  const builtBinary = join(buildOutDir, `tca-timer-ctl${exeSuffix}`);
  if (!existsSync(builtBinary)) {
    throw new Error(`expected built binary at ${builtBinary} but it was not produced`);
  }
  return builtBinary;
}

function main() {
  const triple = resolveTargetTriple();
  const profile = resolveProfile();
  const isWindows = triple.includes('windows') || process.platform === 'win32';
  const exeSuffix = isWindows ? '.exe' : '';

  console.log(`[build-ctl] target triple: ${triple}`);
  console.log(`[build-ctl] profile: ${profile}`);

  mkdirSync(binariesDir, { recursive: true });
  const outBinary = join(binariesDir, `tca-timer-ctl-${triple}${exeSuffix}`);

  // `universal-apple-darwin` is not a real rustc target — `cargo build
  // --target universal-apple-darwin` fails. When invoked with
  // `--target universal-apple-darwin`, Tauri builds the desktop crate
  // twice (once per arch) and the `tauri-build` build script checks for a
  // per-arch sidecar at `binaries/tca-timer-ctl-<arch>-apple-darwin`
  // before each cargo build proceeds. Tauri itself `lipo`s the sidecars
  // into the final bundle, so we just need to produce both per-arch
  // binaries here — NOT a pre-fattened `tca-timer-ctl-universal-apple-darwin`,
  // which Tauri doesn't look for.
  if (triple === 'universal-apple-darwin') {
    const archTriples = ['aarch64-apple-darwin', 'x86_64-apple-darwin'];
    for (const archTriple of archTriples) {
      const builtBinary = buildOneTarget({
        triple: archTriple,
        profile,
        useTargetDir: true,
      });
      const archOutBinary = join(binariesDir, `tca-timer-ctl-${archTriple}`);
      copyFileSync(builtBinary, archOutBinary);
      const archSize = statSync(archOutBinary).size;
      console.log(`[build-ctl] copied ${builtBinary} -> ${archOutBinary} (${archSize} bytes)`);
    }
    return;
  }

  // Honour an explicit target triple when one is provided (cross-compile or
  // CI). When TAURI_ENV_TARGET_TRIPLE matches the host triple we deliberately
  // omit `--target` to keep the build artifact under `target/<profile>/`
  // rather than `target/<triple>/<profile>/` — this matches what plain
  // `cargo build` produces and what local developers expect.
  let useTargetDir = false;
  if (process.env.TAURI_ENV_TARGET_TRIPLE) {
    const hostTriple = execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' })
      .trim();
    if (hostTriple !== triple) {
      useTargetDir = true;
    }
  }
  const builtBinary = buildOneTarget({ triple, profile, useTargetDir });
  copyFileSync(builtBinary, outBinary);
  const size = statSync(outBinary).size;
  console.log(`[build-ctl] copied ${builtBinary} -> ${outBinary} (${size} bytes)`);
}

try {
  main();
} catch (err) {
  console.error(`[build-ctl] failed: ${err && err.message ? err.message : err}`);
  process.exit(1);
}
