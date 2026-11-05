# Tetorica 2A03 Synth — Tauri

A desktop version of [Tetorica 2A03 Synth](https://kyorohiro.github.io/hello_ymfm_wasm/synth-2a03/index.html).
Play and edit NES Pulse, Triangle, Noise, DMC and FDS; draw DMC target curves or
FDS Wave RAM, import sounds from VGM / VGZ, and take instruments away as presets,
raw DPCM or JavaScript. The app does not play complete game songs.

The desktop shell follows Tetorica's [DMG](https://github.com/kyorohiro/tetorica-dmg-synth-tauri),
[SPU](https://github.com/kyorohiro/tetorica-spu-synth-tauri) and
[FM2612](https://github.com/kyorohiro/tetorica-fm2612-synth-tauri) Synths:
Menu, Pin, native file saving, and Web Audio / Native output selection.
The frontend and WASM are local; no engine download is needed at startup.

## Run

Use Node.js 22 or newer, Python 3, Rust and the platform's Tauri 2 build tools
(Xcode command-line tools on macOS).

```sh
npm ci
npm run dev
```

Enable audio, then play the displayed computer keys or click a key. All keys
play the selected source. Pulse has two hardware voices in round robin;
Triangle, Noise, DMC and FDS each have one. Noise and DMC keys trigger the
configured sound; the Pitch wheels do not tune them. See the complete
[bundled Synth guide](dist/README.md) for hardware envelopes, gates, modulation,
DMC editing, and the software click guard.

- **Menu → Import** opens an instrument preset or a VGM / VGZ sound library.
- **Menu → Export** and the browser editor's save controls use a native save
  dialog. Preset JSON retains playback controls; raw DPCM retains sample bytes.
- **Pin** toggles always-on-top for the current app session.
- **Menu → Reload** asks before discarding the current session.
- **Menu → Audio output** selects Web Audio or Native (Rust).

The Web editor remains available, including both Pitch wheels, Octave, Master
0–380%, waveform / spectrum, collapsible sections and live hardware meters.
DMC's Auto fit height is a software drawing aid and may adjust nearby bits;
its decoded blue curve still obeys the hardware's ±2 steps and DAC limits.
FDS / DMC's optional click guard is also a software output feature.
Save instruments before reloading; automatic session restoration is not included.

## Audio output

Both outputs use the same NES APU + FDS WASM / AudioWorklet graph. Native output
sends final, Master-scaled PCM through binary Tauri IPC to Rust / CPAL for device
playback. Synthesis continues inside the WebView.

Switching output stops held notes and resets Pitch, keeping the instrument.
Native starts with the default system output; select another device and choose
Apply device to switch it. Output failure stops playback and falls back to Web
Audio with an explanation. Enable audio restarts a closed engine.

The transport uses the same bounded credits, resampling and clock correction
as DMG / SPU. Background WebView scheduling may still interrupt synthesis;
Native output does not move the sound chip outside the WebView.

## Read, modify and reuse

The app runs the original modules directly. Start with:

| Edit | Location |
| --- | --- |
| App / keyboard and file actions | [dist/synth-2a03/synth.js](dist/synth-2a03/synth.js) |
| Sound controls and DMC editor | [dist/synth-2a03/editor.js](dist/synth-2a03/editor.js), [dmc_editor.js](dist/synth-2a03/dmc_editor.js) |
| Chip programming / voices | [dist/synth-2a03/instrument.js](dist/synth-2a03/instrument.js) |
| AudioWorklet and output | [processor.js](dist/synth-2a03/processor.js), [audio.js](dist/synth-2a03/audio.js) |
| Reusable NES sound APIs | [dist/js/](dist/js/) |
| Desktop Menu / Pin / audio bridge | [desktop/](desktop/) |
| Native file dialogs / device transport | [src-tauri/src/](src-tauri/src/) |
| Native core sources / rebuilding / licenses | [dist/sources/NES-FDS.md](dist/sources/NES-FDS.md), [dist/licenses/](dist/licenses/) |

Authored JavaScript and CSS retain their original files, identifiers, imports
and comments, without bundling or minification. The compact generated WASM loader
is kept with its corresponding source and build recipe.

After editing live browser files:

```sh
npm run record:edits
npm run dev
# Or build your modified app:
npm run build
```

`record:edits` records modified / added files and optional-file deletions in
local-changes.json. It keeps release.lock.json and original source receipts
unchanged. Record again after further edits. Share local-changes.json with your
edited dist when sharing a fork. The original browser inputs remain in
[their source ZIP](dist/sources/2a03-synth-browser-inputs.zip), with a
[hash receipt](dist/sources/2a03-synth-browser.json).

## Update the browser app

Generate a source-copy ZIP in the upstream repository and import it:

```sh
npm run import:release -- /path/to/tetorica_2a03_synth_VERSION_itch.zip
python3 scripts/import_release.py --check
npm test
```

Keep dist/ and release.lock.json together in the same commit. Successful import
replaces dist and clears local edits; commit or copy your modifications first.
An invalid import retains the existing app and local manifest. Keep
.gitattributes: dist/** -text preserves exact imported bytes on Windows.

## Verify and build

```sh
npm test
cargo test --locked --manifest-path src-tauri/Cargo.toml
npx playwright install chromium webkit
npm run test:browser
npm run build
```

Browser verification exercises actual WASM and capture Worklets with a mocked
Tauri IPC host and muted speakers. Native Rust tests cover transport logic;
these checks do not establish real-device latency or long-duration audio quality.

The initial app version is 0.0.1; its identifier is net.tetorica.synth-2a03.
On macOS the build is placed under src-tauri/target/release/bundle/macos/.
GitHub Actions builds macOS ARM64 / Intel, Windows x86_64, and Linux x86_64 / ARM64
on their own runners. Local macOS compilation does not validate other platforms.
Signing / notarization requires the owner's credentials; see deploy_mac.sh.

## Sources and licenses

- [Parent toolkit, browser app and JavaScript APIs](https://github.com/kyorohiro/hello_ymfm_wasm)
- [Native sound-chip toolkit](https://github.com/kyorohiro/tetorica-soundchip-native)
- [Work record / next checks](docs/todo_20261105.md)

The desktop shell is BSD-3-Clause; see LICENSE. Retain dist/LICENSE,
dist/licenses/ and native attribution when redistributing. The NES / FDS cores
carry their own corresponding licenses and source notices. No BIOS, ROM or game
recording is included.
