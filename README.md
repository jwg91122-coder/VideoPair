# VideoPair

An Electron desktop player for comparing local videos and images in split, wipe,
and single-source views. Video playback uses Chromium's native media pipeline,
with frame callbacks and drift correction to keep two sources aligned.

## Features

- Horizontal and vertical split layouts, an adjustable wipe, and single-source comparison.
- Synchronized playback, seeking, frame stepping, looping, and wheel zoom.
- Selectable audio source, volume controls, and borderless fullscreen.
- Optional overlays showing stream metadata, dropped frames, and synchronization drift.
- FFprobe metadata inspection and runtime decoding capability checks.

Codec playback, hardware acceleration, and HDR presentation depend on the operating
system, GPU, drivers, display, and Electron/Chromium support. Recognizing metadata
does not guarantee that a file can be decoded. Synchronization is best effort;
this is not a frame-accurate reference decoder.

## Run from source

Install Node.js **22.12 or newer** (Node 24 is used in CI) and npm, then run:

```sh
npm ci
npm start
```

On Windows, `build.bat dev` installs locked dependencies, checks the source, and
starts the app. If a compatible Node installation is unavailable, the script
downloads a project-local runtime and verifies its SHA-256 checksum.

Open two files using **Open media** or drag them onto the player. Right-click a
media pane to choose its source. Images can also be compared.

| Control | Action |
| --- | --- |
| Space / K | Play or pause |
| Comma / period | Previous / next frame |
| Left / right arrow | Seek one second outside wipe mode |
| Shift + left / right arrow | Seek five seconds outside wipe mode |
| M | Mute or unmute |
| Mouse wheel over media | Zoom both sources |
| Double-click media | Toggle fullscreen |
| Click in single mode | Switch source |

In fullscreen, move the pointer near the bottom edge to reveal controls.
See [PERFORMANCE.md](PERFORMANCE.md) for playback and layout details.
The in-app Help link currently opens the upstream project's documentation.
