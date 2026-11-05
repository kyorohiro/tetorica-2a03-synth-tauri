# Tetorica 2A03 Synth verification — 2026-11-05

Local implementation is complete. The imported frontend is the current readable
NES APU + FDS browser distribution, with 40 authored modules and 72 total files.
The ZIP SHA-256 is c00694ebf5daf80a2b8026934d0c0d082bd93102aa785859f8d25bfc804e5bac.
The native shell uses the existing DMG/SPU bounded audio transport; synthesis
remains in the WebView and the sound-chip core was not changed for this port.

| Check | Result |
| --- | --- |
| Python import / local-edit / checkout tests | 21 passed |
| Desktop JS / transport / Worklet tests | 42 passed |
| Rust tests | 24 passed, 2 device-dependent tests ignored by default |
| Explicit CoreAudio continuous test | 30.00 s silence, 48 kHz, underruns 0, 29 injected 25 ms producer delays |
| Chromium / WebKit desktop integration | Both passed, actual WASM and capture Worklet, muted speakers |
| Missing assets / page errors / narrow overflow | 0 in both browsers |
| macOS debug app build | Passed |
| Actual Tauri app launch | Title, Menu / Pin and NES/FDS UI visible |

Browser tests use mocked Tauri IPC rather than a live CPAL device. The separate
silent device test verifies the real native output stream, not human listening.
No real-device latency or long-duration/background audio guarantee is inferred.

The browser matrix covers all five sound sources (including both physical Pulse
voices), binary preset save/cancel, NES VGZ import, exact raw DPCM save without
generated padding, DMC cancellation preserving playback, FDS drawing, Pitch reset,
output switching/performance blocking, and native-write failure fallback.
See [the JSON report](desktop_browser_20261105.json).

The initial desktop version is 0.0.1. GitHub Actions also passed all six jobs: browser plus macOS ARM64 / Intel,
Windows x86_64, and Linux x86_64 / ARM64. Installer artifacts were uploaded for
all five native targets. See the [CI receipt](ci_20261105.json) and
[work log](todo_20261105.md). No release tag,notarization or binary
publication has been performed as part of the local verification.
