# Working on tract tools

`README.md` says what this is. The host contract is Tetravox's `docs/ARCHITECTURE.md` §13.

- `pnpm run verify` before any commit. `pnpm run agreement` and `pnpm run e2e` when a kernel or the panel changes.
- Expected values come from MRtrix through `scripts/reference/`, never from this code.
- Kernels stay pure, in `src/kernels/`. No logic in `src/Panel.tsx`.
- `setStreamlineField` detaches the array it is given.
- E2E runs hidden, always. Never add a visible window.
- No tracking, SIFT, resampling, transforms, density maps, 3D node graphs or along-tract profiles (Tetravox's decision log, 2026-11-06).
