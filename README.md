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

## Validate and package

```sh
npm test
npm run pack
npm run build
```

`npm test` checks JavaScript syntax, runs the existing source-level smoke checks,
and tests the IPC sender policy. These checks do not replace playback testing
with real media and hardware. GitHub Actions checks Windows, macOS, and Linux,
and verifies unpacked Windows packaging.

Builds go into `dist/`. Windows builds use an NSIS installer; macOS and Linux
targets are configured for DMG and AppImage. Build on the target operating system;
signing and notarization require your own credentials.

The cleanup audit on October 13, 2026 found no production dependency advisories.
Eight moderate findings remain in electron-builder's development dependency
chain. Run `npm audit` before releasing; its suggested forced fix currently
downgrades electron-builder, so it has not been applied automatically.

Windows shortcuts: `build.bat` builds an installer, `build.bat pack` creates an
unpacked app, and `build.bat bootstrap` prepares the local Node runtime.
`build.bat clean` removes `dist/`; `build.bat clean-all` also removes dependencies
and portable tools.

For a custom FFprobe binary, set `FFPROBE_PATH` to its executable path before
starting the application. Otherwise, the platform binary from
`@ffprobe-installer/ffprobe` is used.

## Repository layout

- `src/`: Electron main process, isolated preload bridge, sender policy, and media probe.
- `public/`: Renderer, HTML, and styles.
- `assets/`: Application icon.
- `scripts/`: Validation runner and regression checks.
- `.github/workflows/`: Continuous integration.

Commit `package-lock.json`. Generated builds, `node_modules/`, `.tools/`, local
environment files, and signing credentials are ignored. Distribute installers
through GitHub Releases rather than committing them to the source repository.

## License and attribution

This project retains the [GNU Affero General Public License v3](LICENSE) supplied
with the source. Package metadata uses `AGPL-3.0-only` to match that file.
The original package author is Ruoshi, and the source references
[bergkamp/video-comparison-player](https://github.com/bergkamp/video-comparison-player).
The bundled FFprobe binary and other dependencies retain their own licenses;
review their notices when distributing a build.
