# Linux Piper backend

This directory contains the Linux-local Piper backend for Edge Natural TTS.

## Invariants

- **CPU only.** CUDA is out of scope.
- Piper is installed only inside the application-private runtime under
  `~/.local/share/edge-natural-tts/runtime/linux-piper/` (or the equivalent
  `XDG_DATA_HOME` path).
- Nothing is installed with `pip --user`, into system Python, or with sudo.
- Voice models are user data under
  `~/.local/share/edge-natural-tts/voices/` and are never deleted by the
  uninstaller.
- The helper is persistent for the lifetime of the Edge Native Messaging port.
  Ryan High is warmed opportunistically as soon as the helper starts, and the
  browser pipelines future sentence synthesis ahead of current playback to
  reduce startup and transition latency.
- The helper calls `PiperVoice.load(..., use_cuda=False)` and the launcher
  clears `CUDA_VISIBLE_DEVICES` as defense in depth.

## Install

First load this branch as an unpacked extension in Edge and copy its extension
ID from `edge://extensions`.

Then run:

```bash
bash native/linux-piper/install-native-host.sh --extension-id <extension-id>
```

The installer creates a private virtual environment, installs the pinned Piper
runtime there, copies the native host, and writes the per-user Edge Native
Messaging manifest:

```text
~/.config/microsoft-edge/NativeMessagingHosts/
  com.sguzman.edge_tts.linux_piper.json
```

No voice model is downloaded by the installer.

## Voice discovery

The host scans:

```text
~/.local/share/edge-natural-tts/voices/
```

A voice is eligible only when both files exist:

```text
VOICE.onnx
VOICE.onnx.json
```

For the current Ryan setup this means:

```text
en_US-ryan-high.onnx
en_US-ryan-high.onnx.json
```

The reader exposes discovered voices with the `[PIPER]` prefix.

## Timing status

The browser transport and model playback path are implemented. Piper 1.8.0 can
return phoneme/sample alignments, but those alignments do not directly identify
source-text character spans. The current Linux v1 host therefore emits
duration-weighted source-word timing marked `approximate`.

A later milestone should replace that approximation with a validated
phoneme-to-source-word alignment layer. Do not label the current timing as
exact.

## Speed and cadence

Piper does not use the browser playback-rate control for the entire requested
speed range. Common moderate changes are synthesized with Piper
`SynthesisConfig.length_scale`, while the browser applies only the residual
rate needed to preserve the full 0.5x-8x UI range. This keeps more of the
model's punctuation and phoneme timing intact than pure time compression.

## Uninstall

```bash
bash native/linux-piper/uninstall-native-host.sh
```

This removes the app-private Piper runtime and Edge Native Messaging manifest.
Downloaded voice models are intentionally preserved.
