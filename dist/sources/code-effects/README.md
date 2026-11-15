# Code software effects

The BSD-3-Clause effect rack runs after the NES APU. Its readable implementation is js/native_fx_rack.js. Rebuild with Emscripten from this directory.

```sh
sh scripts/build_native_audio_effect.sh /tmp/tetorica-nes-effects
cp /tmp/tetorica-nes-effects/gain.wasm ../../js/native_audio_effect.wasm
```
