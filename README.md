<div align="center">

# Big Shot

**Enhanced Screenshot & Screencast for GNOME Shell**

A GNOME Shell extension that transforms the native Print Screen UI into a powerful annotation and recording tool — with drawing tools, webcam overlay, audio capture, and GPU-accelerated screencasting.

<img src="usr/share/icons/hicolor/scalable/apps/big-shot.svg" width="128" alt="Big Shot icon">

[![GNOME Shell](https://img.shields.io/badge/GNOME_Shell-46--50-4A86CF?logo=gnome&logoColor=white)](https://extensions.gnome.org/) [![GJS](https://img.shields.io/badge/GJS-ES2022-F7DF1E?logo=javascript&logoColor=black)](https://gjs.guide/) [![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Platform](https://img.shields.io/badge/platform-Linux-FCC624?logo=linux&logoColor=black)](https://www.gnome.org/) [![GStreamer](https://img.shields.io/badge/GStreamer-1.0-red)](https://gstreamer.freedesktop.org/) [![i18n](https://img.shields.io/badge/i18n-29_languages-green)](locale/)

</div>

---

## Overview

**Big Shot** hooks into GNOME Shell's built-in Screenshot UI (activated by `Print Screen`) and extends it with:

- **15 annotation tools** for marking up screenshots in real-time
- **Desktop + Microphone audio** recording via PulseAudio/PipeWire
- **GPU-accelerated screencasting** with automatic hardware detection (NVIDIA NVENC, AMD/Intel VA-API)
- **Live webcam overlay** with 7 mask effects and 5 size presets
- **Live video annotations** using the same drawing tools during recording or while paused
- **Pause/Resume recording** with automatic segment merging, panel indicator, and timer
- **Copy to Clipboard & Save As…** with annotations composited onto the image

No separate windows. No external apps. Everything lives inside the native GNOME UI.

---

## Features

### 🖊️ Screenshot Annotation Tools

15 tools available via floating draggable toolbar:

| Tool | Description |
|------|-------------|
| **Select / Move** | Select and drag existing annotations |
| **Pen** | Freehand stroke with Bézier curve smoothing |
| **Arrow** | Arrow with proportional head and shadow, Shift-snap to axis |
| **Line** | Straight line, Shift-snap to horizontal/vertical |
| **Rectangle** | Outlined or filled rectangle, Shift = square |
| **Oval** | Outlined or filled ellipse, Shift = circle |
| **Text** | Inline text entry with system font selector (PangoCairo rendering) |
| **Highlighter** | Semi-transparent marker (45% opacity), Shift = horizontal |
| **Censor (Pixelate)** | Real mosaic pixelation over sensitive areas — 5 intensity levels |
| **Blur** | Gaussian-like blur (iterative box blur, 3 passes) — 5 intensity levels |
| **Invert Colors** | Invert the selected region using real pixel data |
| **Number Stamp** | Sequential numbered circles for step-by-step guides |
| **Number + Arrow** | Numbered badge with arrow pointing to target |
| **Number + Pointer** | Numbered badge with dot pointer line |
| **Eraser** | Remove annotations |

### 🎨 Annotation Controls

- **12-color palette** (Red, Orange, Yellow, Green, Blue, Purple, White, Black, Light Gray, Dark Gray, Dark Red, Dark Orange)
- **5 highlighter colors** with 50% opacity (Yellow, Green, Blue, Red, Purple)
- **Separate fill color** selector (stroke and fill are independent)
- **Brush size:** 1–100 with +/− buttons, popup presets (1–14), mouse scroll, or **Ctrl+Scroll anywhere** on canvas
- **Intensity** for Censor/Blur: 1–5, scroll adjustable, Ctrl+Scroll support
- **Font selector** for Text tool (lists all system fonts)
- **Undo / Redo** (full action history)
- **OCR text extraction** with automatic language selection and one-click Tesseract setup for the current system language on Arch-based systems
- **Copy to Clipboard** — composites annotations onto the image as PNG
- **Save As…** — file chooser via xdg-desktop-portal with annotations composited
- **Floating draggable toolbar** with opacity animation (90% → 100% on hover)
- **Toggle native panel** visibility (show/hide GNOME's bottom panel while editing)
- **Tooltips** on hover for all toolbar buttons

### 🎬 Screencast Mode

| Feature | Description |
|---------|-------------|
| **Desktop Audio** | Record system audio via PulseAudio monitor source, auto channel detection |
| **Microphone** | Record microphone input via PulseAudio source, auto channel detection |
| **Audio Mix** | Simultaneous desktop + mic recording via GStreamer `audiomixer` with latency compensation |
| **Framerate** | 15 / 24 / 30 (default) / 60 FPS |
| **Resolution** | 100% (default) / 75% / 50% / 33% downscaling |
| **Quality** | High / Medium / Low (bitrate presets) |
| **Codec selection** | Auto (best available) or manual selection from detected codecs |
| **Live annotation** | Draw on top of open windows while recording; annotations are captured into the video |
| **Paused annotation** | Pause recording and enter edit mode automatically; exit edit mode while staying paused |
| **Privacy effects** | Censor, Blur, and Invert capture real pixels for video overlays in live and paused modes |
| **Clear annotations** | Remove all active video annotations from the top-panel clear button |
| **Pause / Resume** | Stop the current segment, keep the session paused, then resume into a new segment |
| **Quick Stop** | Re-open screenshot UI while recording → stops recording instantly |
| **Panel indicator** | Timer (MM:SS) + pause/play button in the top panel |
| **Screenshot while recording** | Take screenshots during an active screencast (patched GNOME limitation) |

### 📷 Webcam Overlay

- **Live GStreamer webcam preview** captured by the screencast pipeline
- **7 pixel-level mask effects** (no external SVGs — all computed per-pixel):

| Mask | Effect |
|------|--------|
| **None** | Full rectangle, no mask |
| **Circle** | Sharp circle with 4% soft edge |
| **Oval** | Ellipse filling the entire frame |
| **Soft** | Circle with 40% feathered edge (quadratic ease-in) |
| **Spotlight** | Vignette effect — bright center, darkened edges |
| **Ornate** | Circular gradient border (blue→purple→pink BigCommunity colors) |
| **Checker** | Alternating transparent checkerboard pattern |

- **5 size presets:** XS (120px), S (200px), M (320px, default), L (480px), XL (640px)
- **Fully draggable** — position is preserved between sessions
- **Smart reparenting** — preview lives inside screenshotUI; migrates to TopChrome during recording

### 🎮 Video Settings Panel

Floating draggable panel (visible in screencast mode) with:
- **Quality row:** High / Medium / Low
- **Codec row:** Dynamically populated from detected GPU pipelines + Auto option
- **Mask row:** 7 mask options (visible when webcam is active)
- **Size row:** XS / S / M / L / XL (visible when webcam is active)

### ✏️ Video Annotation Workflow

Video annotations reuse the screenshot drawing toolbar and are rendered as a GNOME Shell TopChrome overlay, so the screencast captures them directly.

- Click the **pencil** icon while recording to enter or exit live edit mode.
- Click **Pause** while recording to pause the current segment and enter paused edit mode automatically.
- While paused, use the **Select / Move** tool to select, move, or edit existing annotations without resuming recording.
- Click the top-panel **play** button to resume recording; if paused edit mode is active, it closes the edit overlay first and then starts the next recording segment.
- Censor, Blur, and Invert generate pixel-based previews from the current screen frame in both live and paused modes. During live capture, only the current effect action is excluded from the frame capture so previous annotations stay visible.
- ESC and the toolbar close button exit video edit mode without resuming a paused recording.

### 🔍 GPU Detection & Pipeline Cascade

Follows the same detection pattern as [big-video-converter](https://github.com/biglinux/big-video-converter):

```
lspci → detect GPU vendor(s) → check GStreamer elements → cascade fallback
```

| Detected GPU | Available Pipelines |
|---|---|
| **NVIDIA** | NVIDIA H.264 (`nvh264enc`, CBR-HQ 40 Mbps) → MP4 |
| **AMD / Intel** | VA H.264 Low-Power (`vah264lpenc`) → VA H.264 (`vah264enc`) → VAAPI H.264 (`vaapih264enc`, legacy) → MP4 |
| **Any (Software)** | Software H.264 (`openh264enc`, multi-thread) → MP4 |
| **Any (Software)** | Software VP9 (`vp9enc`, CQ13, row-mt) → WebM |

Pipeline ordering: GPU hardware-accelerated first → Software fallback. The GNOME screencast service automatically prepends `pipewiresrc ! capsfilter` and appends `filesink`, so the extension only provides the encoding/muxing chain.

### ⌨️ Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `1`–`9` | Select annotation tool (Pen, Arrow, Line, Rect, Oval, Text, Highlight, Censor, Number) |
| `0` or `S` | Enter selection/move mode |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` / `Ctrl+Y` | Redo |
| `Delete` / `Backspace` | Remove selected or last object |
| `Escape` | Deselect current object, or exit video edit mode |
| `Ctrl+Scroll` | Adjust brush size (or intensity for Censor/Blur) |

---

## Technical Notes

### GNOME Screencast Service Integration

Big Shot monkey-patches the GNOME Shell Screencast D-Bus proxy (`_screencastProxy`) to inject custom GStreamer pipelines. The GNOME screencast service (a separate process since GNOME 49) automatically prepends `pipewiresrc ! capsfilter` and appends `filesink` to the pipeline string, so the extension only provides the encoding/muxing portion.

Key implementation details:
- **No duplicate capsfilter** — the service already adds `capsfilter caps=video/x-raw,max-framerate=F/1`, so the extension's pipelines must NOT include their own capsfilter
- **File extension fix** — custom pipelines result in `.undefined` extension; the extension renames the output file to the correct `.mp4` or `.webm`
- **Screenshot during recording** — GNOME normally blocks `screenshotUI.open()` when `_screencastInProgress` is true; the extension temporarily clears this flag for screenshot mode
- **Force-enable screencast button** — works around a GNOME 49 bug where `Gst.init_check(null)` crashes the native screencast service, hiding the cast button

### Pause / Resume Recording

Recording pause is segment-based:
- **Pause:** stops and finalizes the current screencast segment, marks the recording session as paused, and keeps the GNOME UI in a recording-aware state.
- **Paused edit:** opens the video annotation overlay automatically. Exiting the overlay does not resume recording.
- **Resume:** starts the next screencast segment with the same codec, quality, framerate, downsize, audio, and webcam settings.
- **Final stop:** if more than one segment exists, Big Shot merges the segments with `ffmpeg -f concat -c copy` and cleans up temporary segment files under `~/Videos/BigShot/.segments/`.
- **Single-segment recordings:** no merge is needed; the original output file is kept.

This avoids freezing the external screencast process with POSIX signals and keeps pause/resume independent from the process name used by GNOME Shell.

### Live Video Annotation Overlay

The video annotation overlay is separate from the screenshot preview overlay:
- It uses TopChrome so annotations are visible above normal application windows and captured by the screencast.
- The top panel is left clickable while editing, and the floating edit toolbar is kept above the drawing capture layer.
- Live Censor/Blur/Invert previews capture a current stage frame and exclude only the in-progress effect action, preventing stale previews and avoiding a full overlay blink.
- Paused Censor/Blur/Invert previews capture a paused stage frame for accurate pixel effects without adding extra recorded frames.

### Audio Pipeline

Audio capture works via `Gvc.MixerControl` to detect PulseAudio/PipeWire output monitors and microphone inputs:
- `provide-clock=false` on `pulsesrc` prevents clock conflicts with `pipewiresrc`
- Channel count is detected dynamically from the mixer device (not hardcoded)
- `audiomixer latency=100000000` handles synchronization for simultaneous desktop + mic

### Annotation Compositing

Annotations are rendered onto the screenshot at save time:
1. Pixel-manipulating effects (Censor/Blur/Invert) applied directly on `GdkPixbuf` pixel data
2. Vector annotations (Pen, Arrow, Text, etc.) rendered via Cairo on an `ImageSurface`
3. Final PNG written to clipboard + file with full annotation fidelity

---

## Compatibility

- **GNOME Shell:** 46, 47, 48, 49, 50
- **Distribution:** Arch Linux (BigLinux / BigCommunity) — works on any Arch-based distro
- **Audio:** PulseAudio / PipeWire (via PulseAudio compatibility)
- **Video:** GStreamer 1.0
- **Webcam:** Any V4L2 camera supported by GStreamer

---

## Installation

### Arch Linux (PKGBUILD)

```bash
cd pkgbuild
makepkg -si
```

### Manual (for testing)

```bash
chmod +x build.sh
./build.sh
gnome-extensions install --force big-shot.zip
# Log out and back in, or restart GNOME Shell
```

---

## Dependencies

### Required

| Package | Purpose |
|---------|---------|
| `gnome-shell` >= 46 | Host shell |
| `gstreamer` | Video pipeline framework + `gst-inspect-1.0` |
| `gst-plugins-base` | Base elements (`videoconvert`, `audiomixer`, `capsfilter`, `queue`) |
| `gst-plugins-good` | `pulsesrc`, `vp9enc`, `mp4mux`, `webmmux` |
| `gst-plugins-bad` | `openh264enc`, VA-API plugins |
| `gst-plugin-va` | Modern VA H.264 encoding (`vah264enc`, `vah264lpenc`) |
| `pciutils` | GPU detection via `lspci` |
| `ffmpeg` | Merge pause/resume recording segments |

### Optional

| Package | Purpose |
|---------|---------|
| `gst-plugins-ugly` | Additional GStreamer codecs (x264, mpeg2, a52) |
| `tesseract` | OCR text extraction; Big Shot can install it on first use |
| `tesseract-data-*` | OCR data matching the current system language |

### Build

| Package | Purpose |
|---------|---------|
| `gettext` | Compile `.po` → `.mo` translations |

---

## Translations

Big Shot ships with **29 languages**, all 100% translated:

<div align="center">

| | | | | |
|:---:|:---:|:---:|:---:|:---:|
| 🇧🇬 Búlgaro | 🇨🇿 Tcheco | 🇩🇰 Dinamarquês | 🇩🇪 Alemão | 🇬🇷 Grego |
| 🇬🇧 Inglês | 🇪🇸 Espanhol | 🇪🇪 Estoniano | 🇫🇮 Finlandês | 🇫🇷 Francês |
| 🇮🇱 Hebraico | 🇭🇷 Croata | 🇭🇺 Húngaro | 🇮🇸 Islandês | 🇮🇹 Italiano |
| 🇯🇵 Japonês | 🇰🇷 Coreano | 🇳🇱 Holandês | 🇳🇴 Norueguês | 🇵🇱 Polonês |
| 🇵🇹 Português | 🇧🇷 Português (BR) | 🇷🇴 Romeno | 🇷🇺 Russo | 🇸🇰 Eslovaco |
| 🇸🇪 Sueco | 🇹🇷 Turco | 🇺🇦 Ucraniano | 🇨🇳 Chinês | |

</div>

```
████████████████████████████████████████ 100% — All 29 languages fully translated
```

To add a new language, copy `usr/share/gnome-shell/extensions/big-shot@bigcommunity.org/po/big-shot.pot` to a new PO file in the same directory and translate the strings. Runtime MO catalogs are generated from this directory during packaging.

---

## Acknowledgments

Big Shot was inspired by and based on the following projects:

- **[GNOME Shell Screencast Extra Feature](https://github.com/WSID/gnome-shell-screencast-extra-feature)** — GNOME Shell extension for enhanced screencast recording that served as the foundation for the audio capture, GPU pipeline detection, and screencast monkey-patching approach.

---

## License

[MIT](LICENSE) — Copyright © 2024–2026 BigCommunity
