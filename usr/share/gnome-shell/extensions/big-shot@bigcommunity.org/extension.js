/**
 * Big Shot — Enhanced Screenshot & Screencast for GNOME Shell
 *
 * SPDX-License-Identifier: MIT
 */

// Top-level imports are intentionally minimal. Anything imported here runs
// synchronously inside GNOME's serial extension load loop and delays every
// other extension's enable() — including Dash to Dock, which in turn lets
// the vanilla GNOME dash flash on cold-boot login. Heavy modules (Gio,
// Shell, St, GdkPixbuf, cairo, MessageTray, all parts/*) are loaded inside
// the `heavyDepsReady` IIFE below, after `startup-complete`, so they don't
// block the cold-boot path.
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

let Gio = null;
let Shell = null;
let St = null;
let GdkPixbuf = null;
let cairo = null;
let MessageTray = null;
let PartToolbar = null;
let PartAnnotation = null;
let PartMagnifier = null;
let PartAudio = null;
let PartFramerate = null;
let PartDownsize = null;
let PartIndicator = null;
let PartQuickStop = null;
let PartWebcam = null;
let PartVideoAnnotation = null;
let computeScaledDimensions = null;
let recordingExtension = null;

/**
 * Deferred load of every heavy dependency.
 *
 * Order matters for cold-boot perf:
 *   1. Module evaluation finishes immediately (only 3 cheap imports above).
 *   2. GNOME's serial loader moves on to the next extension without delay.
 *   3. Dash to Dock's enable() runs and hides the vanilla dash before the
 *      compositor has a chance to paint a frame with it visible.
 *   4. After `startup-complete`, this IIFE pulls in the heavy modules in
 *      parallel — `import()` yields between modules so the main loop stays
 *      responsive.
 *
 * Methods that use these references must `await heavyDepsReady` first.
 */
const heavyDepsReady = (async () => {
    if (Main.layoutManager._startingUp) {
        await new Promise(resolve => {
            const id = Main.layoutManager.connect('startup-complete', () => {
                Main.layoutManager.disconnect(id);
                resolve();
            });
        });
    }

    const [
        gioMod, shellMod, stMod, pixbufMod, cairoMod,
        msgTrayMod,
        toolbarMod, annotationMod, magnifierMod, audioMod, framerateMod,
        downsizeMod, indicatorMod, quickstopMod, webcamMod, videoAnnotationMod,
        coreMod,
    ] = await Promise.all([
        import('gi://Gio'),
        import('gi://Shell'),
        import('gi://St'),
        import('gi://GdkPixbuf'),
        import('gi://cairo'),
        import('resource:///org/gnome/shell/ui/messageTray.js'),
        import('./parts/parttoolbar.js'),
        import('./parts/partannotation.js'),
        import('./parts/partmagnifier.js'),
        import('./parts/partaudio.js'),
        import('./parts/partframerate.js'),
        import('./parts/partdownsize.js'),
        import('./parts/partindicator.js'),
        import('./parts/partquickstop.js'),
        import('./parts/partwebcam.js'),
        import('./parts/partvideoannotation.js'),
        import('./lib/core.js'),
    ]);

    Gio = gioMod.default;
    Shell = shellMod.default;
    St = stMod.default;
    GdkPixbuf = pixbufMod.default;
    cairo = cairoMod.default;
    MessageTray = msgTrayMod;
    PartToolbar = toolbarMod.PartToolbar;
    PartAnnotation = annotationMod.PartAnnotation;
    PartMagnifier = magnifierMod.PartMagnifier;
    PartAudio = audioMod.PartAudio;
    PartFramerate = framerateMod.PartFramerate;
    PartDownsize = downsizeMod.PartDownsize;
    PartIndicator = indicatorMod.PartIndicator;
    PartQuickStop = quickstopMod.PartQuickStop;
    PartWebcam = webcamMod.PartWebcam;
    PartVideoAnnotation = videoAnnotationMod.PartVideoAnnotation;
    computeScaledDimensions = coreMod.computeScaledDimensions;
    recordingExtension = coreMod.recordingExtension;
})();

// =============================================================================
// GPU DETECTION (following big-video-converter pattern)
// =============================================================================

/** GPU vendor enum */
const GpuVendor = Object.freeze({
    NVIDIA: 'nvidia',
    AMD: 'amd',
    INTEL: 'intel',
    UNKNOWN: 'unknown',
});

/**
 * Detect GPU vendor using lspci output.
 * Returns an array of detected vendors in priority order.
 */
async function detectGpuVendors() {
    try {
        const proc = Gio.Subprocess.new(
            ['lspci'],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
        );
        const [, stdout] = await proc.communicate_utf8_async(null, null);
        if (!stdout) return [GpuVendor.UNKNOWN];

        const vendors = [];
        const lines = stdout.toLowerCase();

        if (/(?:vga|display controller|3d).*nvidia/.test(lines))
            vendors.push(GpuVendor.NVIDIA);
        if (/(?:vga|display controller).*(?:\bamd\b|\bati\b)/.test(lines))
            vendors.push(GpuVendor.AMD);
        if (/(?:vga|display controller).*intel/.test(lines))
            vendors.push(GpuVendor.INTEL);

        return vendors.length > 0 ? vendors : [GpuVendor.UNKNOWN];
    } catch {
        return [GpuVendor.UNKNOWN];
    }
}

// =============================================================================
// GSTREAMER PIPELINE CONFIGURATIONS
// =============================================================================

/**
 * Quality presets aligned with big-video-converter.
 * QP/CRF/CQ values follow the same scale: lower = higher quality, larger files.
 *
 * big-video-converter mapping:
 *   high   → H.264 QP 21 / HEVC QP 25 / VP9 CQ 24
 *   medium → H.264 QP 24 / HEVC QP 28 / VP9 CQ 28
 *   low    → H.264 QP 27 / HEVC QP 31 / VP9 CQ 31
 */
const QUALITY_PRESETS = Object.freeze({
    high: {
        qp: 21, qp_i: 21, qp_p: 23, qp_b: 25,
        hevc_qp: 25, hevc_qp_i: 25, hevc_qp_p: 27, hevc_qp_b: 29,
        openh264_br: 6000000, vp9_cq: 24, vp9_minq: 10, vp9_maxq: 50,
    },
    medium: {
        qp: 24, qp_i: 24, qp_p: 26, qp_b: 28,
        hevc_qp: 28, hevc_qp_i: 28, hevc_qp_p: 30, hevc_qp_b: 32,
        openh264_br: 3500000, vp9_cq: 28, vp9_minq: 15, vp9_maxq: 55,
    },
    low: {
        qp: 27, qp_i: 27, qp_p: 29, qp_b: 31,
        hevc_qp: 31, hevc_qp_i: 31, hevc_qp_p: 33, hevc_qp_b: 35,
        openh264_br: 2000000, vp9_cq: 31, vp9_minq: 20, vp9_maxq: 58,
    },
});

/**
 * Pipeline configs grouped by GPU vendor.
 * Each config has:
 *   label    — Human-readable name
 *   src      — Input capsfilter (FRAMERATE_CAPS replaced at runtime)
 *   enc      — Function(preset) returning encoder chain string
 *   elements — Required GStreamer elements to check
 *   ext      — Output container extension (mp4/webm)
 *   vendors  — Array of GPU vendors this config works on
 *   auto     — false keeps heavy software codecs manual-only
 */
const VIDEO_PIPELINES = [
    // ── NVIDIA (NVENC with raw input — works with GNOME Screencast service) ──
    {
        id: 'nvidia-raw-h264-nvenc',
        label: 'NVIDIA H.264',
        vendors: [GpuVendor.NVIDIA],
        src: 'videoconvert chroma-mode=none dither=none matrix-mode=output-only n-threads=4 ! queue',
        enc: (p) => `nvh264enc rc-mode=cqp qp-const=${p.qp} ! h264parse config-interval=-1`,
        elements: ['videoconvert', 'nvh264enc', 'h264parse'],
        ext: 'mp4',
    },
    // ── NVIDIA HEVC/H.265: better compression than H.264 when selected ──
    {
        id: 'nvidia-raw-h265-nvenc',
        label: 'NVIDIA H.265',
        vendors: [GpuVendor.NVIDIA],
        src: 'videoconvert chroma-mode=none dither=none matrix-mode=output-only n-threads=4 ! queue',
        enc: (p) => `nvh265enc rc-mode=cqp qp-const=${p.hevc_qp} ! h265parse config-interval=-1`,
        elements: ['videoconvert', 'nvh265enc', 'h265parse'],
        ext: 'mp4',
    },
    // ── AMD + Intel (VA — new gst-plugin-va, raw input) ──
    {
        id: 'va-raw-h264-lp',
        label: 'VA H.264 Low-Power',
        vendors: [GpuVendor.AMD, GpuVendor.INTEL],
        src: 'videoconvert chroma-mode=none dither=none matrix-mode=output-only n-threads=4 ! queue',
        enc: (p) => `vah264lpenc rate-control=cqp qpi=${p.qp_i} qpp=${p.qp_p} qpb=${p.qp_b} ! h264parse config-interval=-1`,
        elements: ['videoconvert', 'vah264lpenc', 'h264parse'],
        ext: 'mp4',
    },
    {
        id: 'va-raw-h264',
        label: 'VA H.264',
        vendors: [GpuVendor.AMD, GpuVendor.INTEL],
        src: 'videoconvert chroma-mode=none dither=none matrix-mode=output-only n-threads=4 ! queue',
        enc: (p) => `vah264enc rate-control=cqp qpi=${p.qp_i} qpp=${p.qp_p} qpb=${p.qp_b} ! h264parse config-interval=-1`,
        elements: ['videoconvert', 'vah264enc', 'h264parse'],
        ext: 'mp4',
    },
    // ── AMD + Intel HEVC/H.265 (VA — new gst-plugin-va, raw input) ──
    {
        id: 'va-raw-h265-lp',
        label: 'VA H.265 Low-Power',
        vendors: [GpuVendor.AMD, GpuVendor.INTEL],
        src: 'videoconvert chroma-mode=none dither=none matrix-mode=output-only n-threads=4 ! queue',
        enc: (p) => `vah265lpenc rate-control=cqp qpi=${p.hevc_qp_i} qpp=${p.hevc_qp_p} qpb=${p.hevc_qp_b} ! h265parse config-interval=-1`,
        elements: ['videoconvert', 'vah265lpenc', 'h265parse'],
        ext: 'mp4',
    },
    {
        id: 'va-raw-h265',
        label: 'VA H.265',
        vendors: [GpuVendor.AMD, GpuVendor.INTEL],
        src: 'videoconvert chroma-mode=none dither=none matrix-mode=output-only n-threads=4 ! queue',
        enc: (p) => `vah265enc rate-control=cqp qpi=${p.hevc_qp_i} qpp=${p.hevc_qp_p} qpb=${p.hevc_qp_b} ! h265parse config-interval=-1`,
        elements: ['videoconvert', 'vah265enc', 'h265parse'],
        ext: 'mp4',
    },
    // ── AMD + Intel (VAAPI — legacy gstreamer-vaapi, raw input) ──
    {
        id: 'vaapi-raw-h264',
        label: 'VAAPI H.264',
        vendors: [GpuVendor.AMD, GpuVendor.INTEL],
        src: 'videoconvert chroma-mode=none dither=none matrix-mode=output-only n-threads=4 ! queue',
        enc: (p) => `vaapih264enc rate-control=cqp init-qp=${p.qp} ! h264parse config-interval=-1`,
        elements: ['videoconvert', 'vaapih264enc', 'h264parse'],
        ext: 'mp4',
    },
    // ── AMD + Intel HEVC/H.265 (VAAPI — legacy gstreamer-vaapi, raw input) ──
    {
        id: 'vaapi-raw-h265',
        label: 'VAAPI H.265',
        vendors: [GpuVendor.AMD, GpuVendor.INTEL],
        src: 'videoconvert chroma-mode=none dither=none matrix-mode=output-only n-threads=4 ! queue',
        enc: (p) => `vaapih265enc rate-control=cqp init-qp=${p.hevc_qp} ! h265parse config-interval=-1`,
        elements: ['videoconvert', 'vaapih265enc', 'h265parse'],
        ext: 'mp4',
    },
    // ── Software fallbacks (any GPU / no GPU) ──
    // Note: the screencast service prepends "capsfilter caps=video/x-raw,max-framerate=F/1"
    // for custom pipelines, which forces video/x-raw (no DMABuf/GL/CUDA memory).
    {
        id: 'sw-memfd-h264-x264',
        label: 'Software H.264 x264',
        vendors: [],
        src: 'videoconvert chroma-mode=none dither=none matrix-mode=output-only n-threads=4 ! video/x-raw,format=I420 ! queue',
        enc: (p) => `x264enc speed-preset=faster pass=qual quantizer=${p.qp} threads=0 key-int-max=120 ! h264parse config-interval=-1`,
        elements: ['videoconvert', 'x264enc', 'h264parse'],
        ext: 'mp4',
        auto: false,
    },
    {
        id: 'sw-memfd-h265-x265',
        label: 'Software H.265 x265',
        vendors: [],
        src: 'videoconvert chroma-mode=none dither=none matrix-mode=output-only n-threads=4 ! video/x-raw,format=I420 ! queue',
        enc: (p) => `x265enc speed-preset=faster tune=ssim qp=${p.hevc_qp} log-level=warning ! h265parse config-interval=-1`,
        elements: ['videoconvert', 'x265enc', 'h265parse'],
        ext: 'mp4',
        auto: false,
    },
    {
        id: 'sw-memfd-h264-openh264',
        label: 'Software H.264',
        vendors: [],
        // No capsfilter here — the screencast service prepends its own
        // capsfilter caps=video/x-raw,max-framerate=F/1 for custom pipelines.
        // Adding a second capsfilter causes FATAL_ERRORS linking failure.
        src: 'videoconvert chroma-mode=none dither=none matrix-mode=output-only n-threads=4 ! queue',
        enc: (p) => `openh264enc complexity=high bitrate=${p.openh264_br} multi-thread=4 ! h264parse config-interval=-1`,
        elements: ['videoconvert', 'openh264enc', 'h264parse'],
        ext: 'mp4',
    },
    {
        id: 'sw-memfd-vp9',
        label: 'Software VP9',
        vendors: [],
        src: 'videoconvert chroma-mode=none dither=none matrix-mode=output-only n-threads=4 ! queue',
        enc: (p) => `vp9enc min_quantizer=${p.vp9_minq} max_quantizer=${p.vp9_maxq} cq_level=${p.vp9_cq} cpu-used=5 threads=4 deadline=1 static-threshold=1000 buffer-size=20000 row-mt=1 ! queue`,
        elements: ['videoconvert', 'vp9enc'],
        ext: 'webm',
        auto: false,
    },
];

const AUDIO_PIPELINES = {
    vorbis: [
        { element: 'vorbisenc', pipeline: 'vorbisenc ! queue' },
    ],
    aac: [
        { element: 'fdkaacenc', pipeline: 'fdkaacenc ! queue' },
        { element: 'avenc_aac', pipeline: 'avenc_aac ! queue' },
        { element: 'voaacenc', pipeline: 'voaacenc ! queue' },
    ],
};

const MUXERS = {
    mp4: 'mp4mux fragment-duration=500 fragment-mode=first-moov-then-finalise',
    webm: 'webmmux',
};

const SCREENCAST_DBUS_TIMEOUT_MS = 30000;

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Check if a GStreamer element exists on the system
 */
<<<<<<< Updated upstream
=======
function waitSubprocessAsync(proc) {
    return new Promise((resolve, reject) => {
        proc.wait_async(null, (source, result) => {
            try {
                source.wait_finish(result);
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });
}

>>>>>>> Stashed changes
async function checkElement(name) {
    try {
        const proc = Gio.Subprocess.new(
            ['gst-inspect-1.0', '--exists', name],
            Gio.SubprocessFlags.NONE,
        );
<<<<<<< Updated upstream
        await proc.wait_async(null);
=======
        await waitSubprocessAsync(proc);
>>>>>>> Stashed changes
        return proc.get_successful();
    } catch {
        return false;
    }
}

/**
 * Some annotations (zoom callouts) can be placed outside the captured area.
 * Compute how much the export canvas must grow so they are not clipped.
 *
 * Coordinates: annotations live in monitor-logical coords; the captured image
 * occupies the rect [offsetX, offsetY, offsetX+imgW/bufScale, offsetY+imgH/bufScale].
 * Returns pixel-space padding to add around the base image plus the new size.
 * `expanded: false` means nothing overflows — keep the original 1:1 behavior.
 */
function _computeCanvasExpansion(actions, imgW, imgH, offsetX, offsetY, bufScale) {
    const none = { expanded: false };
    if (!actions || actions.length === 0) return none;

    const imgMaxX = offsetX + imgW / bufScale;
    const imgMaxY = offsetY + imgH / bufScale;

    let minX = offsetX, minY = offsetY, maxX = imgMaxX, maxY = imgMaxY;
    let overflow = false;
    for (const a of actions) {
        if (!a?.expandsCanvas || typeof a.getBounds !== 'function') continue;
        const [bMinX, bMinY, bMaxX, bMaxY] = a.getBounds();
        if (bMinX < minX) { minX = bMinX; overflow = true; }
        if (bMinY < minY) { minY = bMinY; overflow = true; }
        if (bMaxX > maxX) { maxX = bMaxX; overflow = true; }
        if (bMaxY > maxY) { maxY = bMaxY; overflow = true; }
    }
    if (!overflow) return none;

    const padLeftPx = Math.ceil((offsetX - minX) * bufScale);
    const padTopPx = Math.ceil((offsetY - minY) * bufScale);
    const padRightPx = Math.ceil((maxX - imgMaxX) * bufScale);
    const padBottomPx = Math.ceil((maxY - imgMaxY) * bufScale);

    return {
        expanded: true,
        padLeftPx,
        padTopPx,
        newW: imgW + padLeftPx + padRightPx,
        newH: imgH + padTopPx + padBottomPx,
    };
}

/**
 * Recording output folder under XDG_VIDEOS_DIR (always literal, never
 * translated, so the path is the same in every locale).
 */
const BIGSHOT_VIDEO_FOLDER = 'BigShot';
const BIGSHOT_SEGMENT_FOLDER = '.segments';

/**
 * Build the relative file template the screencast service receives. The
 * service expands %d → YYYY-MM-DD and %t → HH-MM-SS server-side, so the
 * placeholders MUST survive translation literally.
 *
 * We ignore the path GNOME passes ('Screencasts/Screencast From %d %t')
 * and emit our own so:
 *  - the folder is always ~/Videos/BigShot/ (locale-independent),
 *  - the filename starts with "BigShot" instead of "Screencast",
 *  - the "from" word follows the active GNOME locale via the extension's
 *    own gettext domain (so we don't depend on the upstream gnome-shell
 *    translation, which on several locales translates "%d %t" to "%s"
 *    and breaks the service's token expansion).
 */
function buildBigShotRecordingPath() {
    return GLib.build_filenamev([
        BIGSHOT_VIDEO_FOLDER,
        _('BigShot from %d %t'),
    ]);
}

function buildBigShotSegmentPath(sessionId, index) {
    return GLib.build_filenamev([
        BIGSHOT_VIDEO_FOLDER,
        BIGSHOT_SEGMENT_FOLDER,
        sessionId,
        `segment-${String(index).padStart(3, '0')}`,
    ]);
}

function getSegmentSessionFolder(sessionId) {
    return GLib.build_filenamev([
        getRecordingFolder(),
        BIGSHOT_SEGMENT_FOLDER,
        sessionId,
    ]);
}

function buildSegmentSessionId() {
    const now = GLib.DateTime.new_now_local();
    const stamp = now.format('%Y%m%d-%H%M%S') ?? String(GLib.get_monotonic_time());
    const suffix = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
    return `${stamp}-${suffix}`;
}

function getRecordingFolder() {
    const videoDir = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_VIDEOS)
        ?? GLib.get_home_dir();
    return GLib.build_filenamev([videoDir, BIGSHOT_VIDEO_FOLDER]);
}

function findRecentFileInDirectory(dirPath, prefix, ext, startedAtUnix) {
    const dir = Gio.File.new_for_path(dirPath);
    if (!dir.query_exists(null))
        return null;

    let enumerator = null;
    let best = null;

    try {
        enumerator = dir.enumerate_children(
            'standard::name,standard::type,standard::size,time::modified',
            Gio.FileQueryInfoFlags.NONE,
            null,
        );

        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            if (info.get_file_type() !== Gio.FileType.REGULAR)
                continue;

            const name = info.get_name();
            if (!name.startsWith(prefix))
                continue;
            if (!name.endsWith(`.${ext}`) && !name.endsWith('.undefined') && !name.endsWith('.unknown'))
                continue;

            const modified = info.get_attribute_uint64('time::modified');
            const size = info.get_size();
            if (size <= 0 || modified < startedAtUnix - 10)
                continue;

            if (!best || modified > best.modified || (modified === best.modified && size > best.size)) {
                best = {
                    modified,
                    size,
                    path: dir.get_child(name).get_path(),
                };
            }
        }
    } catch (e) {
        console.warn(`[Big Shot] Could not scan recording folder: ${e.message}`);
    } finally {
        try { enumerator?.close(null); } catch (_e) { /* */ }
    }

    return best?.path ?? null;
}

function findRecentRecordingFile(ext, startedAtUnix) {
    return findRecentFileInDirectory(getRecordingFolder(), 'BigShot', ext, startedAtUnix);
}

function findRecentSegmentFile(sessionId, index, ext, startedAtUnix) {
    return findRecentFileInDirectory(
        getSegmentSessionFolder(sessionId),
        `segment-${String(index).padStart(3, '0')}`,
        ext,
        startedAtUnix,
    );
}

/**
 * Make sure ~/Videos/BigShot/ exists before the screencast service tries
 * to write to it. The service does not auto-create the target directory.
 */
function ensureRecordingFolder() {
    try {
        GLib.mkdir_with_parents(getRecordingFolder(), 0o755);
    } catch (e) {
        console.warn(`[Big Shot] Could not create recording folder: ${e.message}`);
    }
}

/**
 * Fix the file path extension after recording
 * GNOME creates files with .unknown extension, we rename to .mp4/.webm
 */
function fixFilePath(filePath, ext) {
    if (!filePath || !ext) return filePath;
    const file = Gio.File.new_for_path(filePath);
    if (!file.query_exists(null)) {
        const expectedPath = filePath.replace(/\.[^.]+$/, `.${ext}`);
        return Gio.File.new_for_path(expectedPath).query_exists(null)
            ? expectedPath
            : filePath;
    }
    // Replace the last extension (e.g., .webm → .mkv). Works correctly for
    // typical screencast filenames like 'Screencast_2024-01-01.webm'.
    const newPath = filePath.replace(/\.[^.]+$/, `.${ext}`);
    if (newPath !== filePath) {
        const newFile = Gio.File.new_for_path(newPath);
        try {
            file.move(newFile, Gio.FileCopyFlags.OVERWRITE, null, null);
            return newPath;
        } catch (e) {
            console.error(`[Big Shot] Failed to rename file: ${e.message}`);
            return filePath;
        }
    }
    return newPath;
}

function deletePathIfExists(path) {
    if (!path)
        return;
    try {
        const file = Gio.File.new_for_path(path);
        if (file.query_exists(null))
            file.delete(null);
    } catch (e) {
        console.warn(`[Big Shot] Could not delete ${path}: ${e.message}`);
    }
}

function escapeFfmpegConcatPath(path) {
    return path.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// =============================================================================
// MAIN EXTENSION CLASS
// =============================================================================

export default class BigShotExtension extends Extension {
    enable() {
        this._enableSerial = (this._enableSerial ?? 0) + 1;
        this._activeEnableSerial = this._enableSerial;
        this._deferredReadySerial = 0;
        this._parts = [];
        this._availableConfigs = null; // null = not yet detected (lazy)
<<<<<<< Updated upstream
        this._availableElements = new Set();
        this._pipelineDetectionPromise = null;
        this._pipelineDetectionGeneration = (this._pipelineDetectionGeneration ?? 0) + 1;
=======
        this._pipelineDetectionPromise = null;
>>>>>>> Stashed changes
        this._currentConfigIndex = 0;

        // Pause/resume recording state
        this._recordingState = 'idle'; // 'idle' | 'starting' | 'recording' | 'pausing' | 'paused' | 'resuming'
        this._recordingContext = null;
        this._recordingSession = null;
        this._currentSegment = null;
        this._suppressPauseStopFailure = false;
        this._stopWatcherId = 0;
        this._origScreencastProxyTimeout = null;
        this._ocrInstallPromise = null;

        const screenshotUI = Main.screenshotUI;
        if (!screenshotUI) {
            console.error('[Big Shot] ScreenshotUI not found');
            return;
        }

        this._screenshotUI = screenshotUI;

        // Initialize translations (must be before _createParts so _() works)
        this.initTranslations();

        // NOTE: Pipeline detection moved to lazy — runs on first screencast attempt
        // to avoid blocking enable() with synchronous subprocess calls.

        // Defer the heavy UI/patch work until the shell finishes startup, so
        // other extensions (Dash to Dock in particular) can replace the default
        // dash before our synchronous widget construction runs.
        this._scheduleDeferredEnable(this._activeEnableSerial);
    }

    _scheduleDeferredEnable(enableSerial) {
        // `heavyDepsReady` already waits for `startup-complete` internally,
        // so we don't need to gate on it again here. Just schedule a low-
        // priority idle that awaits the lazy import chain and then runs the
        // patches/parts. Keeping enable() returning fast (synchronous, no
        // await) is what lets every later extension's enable() run promptly.
        this._enableDeferredId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this._enableDeferredId = 0;
            this._runDeferredEnable(enableSerial);
            return GLib.SOURCE_REMOVE;
        });
    }

    async _runDeferredEnable(enableSerial) {
        try {
            await heavyDepsReady;
        } catch (e) {
            console.error(`[Big Shot] Failed to load deps: ${e.message}\n${e.stack}`);
            return;
        }

        // The same extension instance can be disabled and re-enabled while
        // imports are pending. A screenshotUI null check alone cannot tell an
        // old invocation from the current generation.
        if (!this._screenshotUI || this._activeEnableSerial !== enableSerial ||
            this._deferredReadySerial === enableSerial)
            return;
        this._deferredReadySerial = enableSerial;

        // Each patch is wrapped so a future API change in one area doesn't
        // prevent the rest of the extension from loading. Better partial
        // functionality than a fully broken extension.
        this._safeStep('createParts', () => this._createParts());
        this._safeStep('patchScreencast', () => this._patchScreencast());

        // Force-enable the screencast (video) button.
        // GNOME 49 has a bug where Gst.init_check(null) crashes the native
        // screencast service, hiding the cast button even when GStreamer
        // encoders are available. Since Big Shot provides its own pipelines,
        // force the button visible so users can switch to video mode.
        this._safeStep('forceEnableScreencast', () => this._forceEnableScreencast());

        // Intercept _saveScreenshot to composite annotations onto the image
        this._safeStep('patchSaveScreenshot', () => this._patchSaveScreenshot());

<<<<<<< Updated upstream
        // Warm the registry without blocking the Shell main loop.
        this._detectPipelines().catch(e => {
            console.warn(`[Big Shot] Pipeline detection failed: ${e.message}`);
=======
        // Warm the codec cache without blocking the Shell main loop. If the
        // user starts recording immediately, that call awaits the same promise.
        this._detectPipelines().catch(e => {
            if (this._activeEnableSerial === enableSerial)
                console.warn(`[Big Shot] Pipeline detection failed: ${e.message}`);
>>>>>>> Stashed changes
        });
    }

    /**
     * Run an enable-time step and log (without throwing) on failure.
     * Keeps the extension partially functional when a single GNOME API
     * changes between releases.
     */
    _safeStep(label, fn) {
        try {
            fn();
        } catch (e) {
            console.error(`[Big Shot] step "${label}" failed: ${e.message}\n${e.stack}`);
        }
    }

    disable() {
<<<<<<< Updated upstream
        this._pipelineDetectionGeneration++;
        this._pipelineDetectionPromise = null;

=======
        this._activeEnableSerial = 0;
        this._deferredReadySerial = 0;
>>>>>>> Stashed changes
        // Cancel deferred enable if it hasn't fired yet (extension disabled
        // before the idle callback ran). Without this, the parts/patches would
        // be created against a screenshotUI we no longer track. The async
        // path inside _runDeferredEnable also bails out if _screenshotUI was
        // cleared, so racing disable() against the heavyDepsReady await is
        // safe.
        if (this._enableDeferredId) {
            GLib.source_remove(this._enableDeferredId);
            this._enableDeferredId = 0;
        }

        // Clean up pause/resume state
        this._recordingState = 'idle';
        this._recordingContext = null;
        this._recordingSession = null;
        this._currentSegment = null;
        if (this._stopWatcherId) {
            GLib.source_remove(this._stopWatcherId);
            this._stopWatcherId = 0;
        }

        // Clean up webcam UI visibility listener
        if (this._webcamUIVisId) {
            try { this._screenshotUI?.disconnect(this._webcamUIVisId); } catch (_e) { /* */ }
            this._webcamUIVisId = 0;
        }

        // Clean up pending rename timer
        if (this._renameTimerId) {
            GLib.source_remove(this._renameTimerId);
            this._renameTimerId = 0;
        }
        this._pendingRename = null;
        this._pipelineDetectionPromise = null;

        this._ocrInstallPromise = null;

        // Destroy all parts
        for (const part of this._parts) {
            try {
                part.destroy();
            } catch (e) {
                console.error(`[Big Shot] Error destroying part: ${e.message}`);
            }
        }
        this._parts = [];

        // Revert monkey-patches — each isolated so one failure doesn't
        // leave the others in a half-patched state.
        this._safeStep('unpatchScreencast', () => this._unpatchScreencast());
        this._safeStep('revertForceScreencast', () => this._revertForceScreencast());
        this._safeStep('unpatchSaveScreenshot', () => this._unpatchSaveScreenshot());

        this._screenshotUI = null;
        this._availableConfigs = null;
        this._availableElements?.clear();
    }

    _forceEnableScreencast() {
        const ui = this._screenshotUI;
        if (!ui) return;

        // Save original state and method
        this._origScreencastSupported = ui._screencastSupported;
        this._origSyncCastButton = ui._syncCastButton?.bind(ui);

        // Force screencast as supported
        ui._screencastSupported = true;

        // Override _syncCastButton to always keep _screencastSupported = true.
        // The native screencast proxy callback sets _screencastSupported = false
        // asynchronously when the screencast service crashes (GNOME 49 bug),
        // which would hide the cast button after our force-enable.
        if (typeof ui._syncCastButton === 'function') {
            ui._syncCastButton = () => {
                ui._screencastSupported = true;
                this._origSyncCastButton();
            };
            ui._syncCastButton();
        } else {
            const castBtn = ui._castButton;
            if (castBtn) {
                castBtn.visible = true;
                castBtn.reactive = true;
            }
        }

    }

    _revertForceScreencast() {
        const ui = this._screenshotUI;
        if (!ui) return;

        // Restore original _syncCastButton method
        if (this._origSyncCastButton) {
            ui._syncCastButton = this._origSyncCastButton;
            this._origSyncCastButton = undefined;
        }

        if (this._origScreencastSupported !== undefined) {
            ui._screencastSupported = this._origScreencastSupported;
            if (typeof ui._syncCastButton === 'function')
                ui._syncCastButton();
            this._origScreencastSupported = undefined;
        }
    }

    // =========================================================================
    // SAVE SCREENSHOT — Composite annotations onto the screenshot
    // =========================================================================

    _patchSaveScreenshot() {
        const ui = this._screenshotUI;
        if (!ui || typeof ui._saveScreenshot !== 'function') return;

        this._origSaveScreenshot = ui._saveScreenshot.bind(ui);
        const ext = this;

        ui._saveScreenshot = async function () {
            const overlay = ext._annotation?._overlay;
            const actions = overlay?._actions;

            // No annotations — use original save
            if (!actions || actions.length === 0) {
                return ext._origSaveScreenshot();
            }

            // --- Capture the original screenshot as PNG bytes ---
            let texture, geometry, cursorTexture, cursorX, cursorY, cursorScale, bufScale;

            if (this._selectionButton.checked || this._screenButton.checked) {
                const content = this._stageScreenshot.get_content();
                if (!content) return;

                texture = content.get_texture();
                geometry = this._getSelectedGeometry(true);
                bufScale = this._scale;

                cursorTexture = this._cursor.content?.get_texture();
                if (!this._cursor.visible)
                    cursorTexture = null;
                cursorX = this._cursor.x * bufScale;
                cursorY = this._cursor.y * bufScale;
                cursorScale = this._cursorScale;
            } else if (this._windowButton.checked) {
                const window =
                    this._windowSelectors.flatMap(s => s.windows())
                        .find(win => win.checked);
                if (!window) return;

                const content = window.windowContent;
                if (!content) return;

                texture = content.get_texture();
                geometry = null;
                bufScale = window.bufferScale;
                cursorTexture = window.getCursorTexture()?.get_texture();
                if (!this._cursor.visible)
                    cursorTexture = null;
                cursorX = window.cursorPoint.x * bufScale;
                cursorY = window.cursorPoint.y * bufScale;
                cursorScale = this._cursorScale;
            }

            if (!texture) return;

            const [gx, gy, gw, gh] = geometry ?? [0, 0, -1, -1];

            // Composite original screenshot to stream (same as native)
            const stream = Gio.MemoryOutputStream.new_resizable();
            const pixbuf = await Shell.Screenshot.composite_to_stream(
                texture, gx, gy, gw, gh, bufScale,
                cursorTexture ?? null, cursorX ?? 0, cursorY ?? 0, cursorScale ?? 1,
                stream,
            );
            stream.close(null);

            if (!pixbuf) {
                return ext._origSaveScreenshot();
            }

            // --- Render annotations onto the screenshot via Cairo ---
            const imgW = pixbuf.get_width();
            const imgH = pixbuf.get_height();

            // Geometry offset: annotations are in monitor coords (full screen),
            // the captured image starts at (gx/bufScale, gy/bufScale).
            const offsetX = gx / bufScale;
            const offsetY = gy / bufScale;

            // Use a temp file approach: pixbuf → PNG → Cairo surface → draw → PNG → pixbuf
            const tmpDir = GLib.get_tmp_dir();
            const tmpBase = GLib.build_filenamev([tmpDir, `bigshot-base-${Date.now()}.png`]);
            const tmpAnnotated = GLib.build_filenamev([tmpDir, `bigshot-ann-${Date.now()}.png`]);

            try {
                // Coordinate transform for annotations
                const toWidget = (x, y) => [
                    (x - offsetX) * bufScale,
                    (y - offsetY) * bufScale,
                ];
                const drawScale = 1.0;

                // 1. Apply pixel-manipulating effects (pixelate, blur)
                // on the GdkPixbuf before converting to Cairo surface
                let workPixbuf = pixbuf;
                for (const action of actions) {
                    if (typeof action.drawReal === 'function') {
                        try {
                            const result = action.drawReal(
                                workPixbuf, GdkPixbuf, GLib, toWidget, drawScale,
                            );
                            if (result) {
                                workPixbuf = result;
                            } else {
                            }
                        } catch (err) {
                            console.error(`[Big Shot] drawReal failed for ${action.constructor.name}: ${err.message}\n${err.stack}`);
                        }
                    }
                }

                // 2. Save (possibly modified) pixbuf as PNG
                workPixbuf.savev(tmpBase, 'png', [], []);

                // 3. Build the Cairo surface. If an annotation (e.g. a zoom inset)
                //    sits outside the captured area, grow the canvas and fill the
                //    new region with a neutral border so nothing gets clipped.
                const exp = _computeCanvasExpansion(actions, imgW, imgH, offsetX, offsetY, bufScale);
                let surface, cr, drawToWidget;
                if (exp.expanded) {
                    const baseSurface = cairo.ImageSurface.createFromPNG(tmpBase);
                    surface = new cairo.ImageSurface(cairo.Format.ARGB32, exp.newW, exp.newH);
                    cr = new cairo.Context(surface);
                    cr.setSourceRGBA(1, 1, 1, 1); // white border fill
                    cr.paint();
                    cr.setSourceSurface(baseSurface, exp.padLeftPx, exp.padTopPx);
                    cr.paint();
                    drawToWidget = (x, y) => [
                        (x - offsetX) * bufScale + exp.padLeftPx,
                        (y - offsetY) * bufScale + exp.padTopPx,
                    ];
                } else {
                    surface = cairo.ImageSurface.createFromPNG(tmpBase);
                    cr = new cairo.Context(surface);
                    drawToWidget = toWidget;
                }

                // 4. Draw all normal annotations (pen, arrow, text, etc.)
                for (const action of actions) {
                    if (typeof action.drawReal !== 'function') {
                        cr.save();
                        action.draw(cr, drawToWidget, drawScale);
                        cr.restore();
                    }
                }

                // 5. Save annotated surface as PNG
                surface.writeToPNG(tmpAnnotated);
                surface.finish();

                // 5. Load annotated PNG as pixbuf for clipboard + file save
                const annotPixbuf = GdkPixbuf.Pixbuf.new_from_file(tmpAnnotated);

                // 6. Play sound
                global.display.get_sound_player().play_from_theme(
                    'screen-capture', _('Screenshot taken'), null);

                // 7. Store to clipboard + file
                const finalBytes = ext._pixbufToBytes(annotPixbuf);
                const resultFile = ext._storeScreenshotBytes(finalBytes, annotPixbuf);

                if (resultFile)
                    this.emit('screenshot-taken', resultFile);

            } catch (e) {
                console.error(`[Big Shot] Annotation compositing failed: ${e.message}`);
                // Fallback: save without annotations
                global.display.get_sound_player().play_from_theme(
                    'screen-capture', _('Screenshot taken'), null);
                const bytes = stream.steal_as_bytes();
                const resultFile = ext._storeScreenshotBytes(bytes, pixbuf);
                if (resultFile)
                    this.emit('screenshot-taken', resultFile);
            } finally {
                // Clean up temp files
                try { Gio.File.new_for_path(tmpBase).delete(null); } catch (_e) { /* ignore */ }
                try { Gio.File.new_for_path(tmpAnnotated).delete(null); } catch (_e) { /* ignore */ }
            }
        };

    }

    /**
     * Convert a GdkPixbuf.Pixbuf to PNG GLib.Bytes
     */
    _pixbufToBytes(pixbuf) {
        const [ok, buffer] = pixbuf.save_to_bufferv('png', [], []);
        if (!ok) throw new Error('Failed to save pixbuf to buffer');
        return GLib.Bytes.new(buffer);
    }

    /**
     * Store screenshot to clipboard + file (mirrors GNOME's _storeScreenshot)
     */
    _storeScreenshotBytes(bytes, _pixbuf) {
        // Clipboard
        const clipboard = St.Clipboard.get_default();
        clipboard.set_content(St.ClipboardType.CLIPBOARD, 'image/png', bytes);

        const time = GLib.DateTime.new_now_local();
        let file = null;

        const lockdownSettings =
            new Gio.Settings({ schema_id: 'org.gnome.desktop.lockdown' });
        const disableSaveToDisk =
            lockdownSettings.get_boolean('disable-save-to-disk');

        if (!disableSaveToDisk) {
            const dir = Gio.File.new_for_path(GLib.build_filenamev([
                GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) || GLib.get_home_dir(),
                _('Screenshots'),
            ]));

            try {
                dir.make_directory_with_parents(null);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                    throw e;
            }

            const baseName = _('Screenshot from %s').format(
                time.format('%Y-%m-%d %H-%M-%S'));

            function* suffixes() {
                yield '';
                for (let i = 1; ; i++)
                    yield `-${i}`;
            }

            for (const suffix of suffixes()) {
                file = dir.get_child(`${baseName}${suffix}.png`);
                try {
                    const stream = file.create(Gio.FileCreateFlags.NONE, null);
                    stream.write_bytes(bytes, null);
                    stream.close(null);
                    break;
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                        throw e;
                    file = null;
                }
            }

            if (file) {
                // Add to recent files
                try {
                    const recentFile = GLib.build_filenamev([
                        GLib.get_user_data_dir(), 'recently-used.xbel']);
                    const uri = file.get_uri();
                    const bookmarks = new GLib.BookmarkFile();
                    try {
                        bookmarks.load_from_file(recentFile);
                    } catch (_e) { /* ignore if file doesn't exist */ }
                    bookmarks.add_application(uri, GLib.get_prgname(), 'gio open %u');
                    bookmarks.to_file(recentFile);
                } catch (_e) { /* ignore */ }
            }
        }

        return file;
    }

    _unpatchSaveScreenshot() {
        const ui = this._screenshotUI;
        if (!ui) return;

        if (this._origSaveScreenshot) {
            ui._saveScreenshot = this._origSaveScreenshot;
            this._origSaveScreenshot = undefined;
        }
    }

    // =========================================================================
    // ACTION BUTTONS — Copy, Save As
    // =========================================================================

    /**
     * Capture current screenshot and composite annotations into PNG bytes.
     * Returns { bytes: GLib.Bytes, pixbuf: GdkPixbuf.Pixbuf } or null on failure.
     */
    async _captureAnnotatedBytes() {
        const ui = this._screenshotUI;
        const overlay = this._annotation?._overlay;
        const actions = overlay?._actions ?? [];

        let texture, geometry, cursorTexture, cursorX, cursorY, cursorScale, bufScale;

        if (ui._selectionButton.checked || ui._screenButton.checked) {
            const content = ui._stageScreenshot.get_content();
            if (!content) return null;
            texture = content.get_texture();
            geometry = ui._getSelectedGeometry(true);
            bufScale = ui._scale;
            cursorTexture = ui._cursor.content?.get_texture();
            if (!ui._cursor.visible) cursorTexture = null;
            cursorX = ui._cursor.x * bufScale;
            cursorY = ui._cursor.y * bufScale;
            cursorScale = ui._cursorScale;
        } else if (ui._windowButton.checked) {
            const window = ui._windowSelectors
                .flatMap(s => s.windows())
                .find(win => win.checked);
            if (!window) return null;
            const content = window.windowContent;
            if (!content) return null;
            texture = content.get_texture();
            geometry = null;
            bufScale = window.bufferScale;
            cursorTexture = window.getCursorTexture()?.get_texture();
            if (!ui._cursor.visible) cursorTexture = null;
            cursorX = window.cursorPoint.x * bufScale;
            cursorY = window.cursorPoint.y * bufScale;
            cursorScale = ui._cursorScale;
        }

        if (!texture) return null;

        const [gx, gy, gw, gh] = geometry ?? [0, 0, -1, -1];
        const stream = Gio.MemoryOutputStream.new_resizable();
        const pixbuf = await Shell.Screenshot.composite_to_stream(
            texture, gx, gy, gw, gh, bufScale,
            cursorTexture ?? null, cursorX ?? 0, cursorY ?? 0, cursorScale ?? 1,
            stream,
        );
        stream.close(null);

        if (!pixbuf) return null;

        if (actions.length === 0) {
            const bytes = stream.steal_as_bytes();
            return { bytes, pixbuf };
        }

        const offsetX = gx / bufScale;
        const offsetY = gy / bufScale;
        const tmpDir = GLib.get_tmp_dir();
        const tmpBase = GLib.build_filenamev([tmpDir, `bigshot-base-${Date.now()}.png`]);
        const tmpAnnotated = GLib.build_filenamev([tmpDir, `bigshot-ann-${Date.now()}.png`]);

        try {
            const toWidget = (x, y) => [
                (x - offsetX) * bufScale,
                (y - offsetY) * bufScale,
            ];
            const drawScale = 1.0;

            let workPixbuf = pixbuf;
            for (const action of actions) {
                if (typeof action.drawReal === 'function') {
                    try {
                        const result = action.drawReal(workPixbuf, GdkPixbuf, GLib, toWidget, drawScale);
                        if (result) workPixbuf = result;
                    } catch (err) {
                        console.error(`[Big Shot] drawReal failed: ${err.message}`);
                    }
                }
            }

            workPixbuf.savev(tmpBase, 'png', [], []);

            // Grow the canvas with a neutral border if an annotation (e.g. a zoom
            // inset) sits outside the captured area, so it is not clipped.
            const imgW = pixbuf.get_width();
            const imgH = pixbuf.get_height();
            const exp = _computeCanvasExpansion(actions, imgW, imgH, offsetX, offsetY, bufScale);
            let surface, cr, drawToWidget;
            if (exp.expanded) {
                const baseSurface = cairo.ImageSurface.createFromPNG(tmpBase);
                surface = new cairo.ImageSurface(cairo.Format.ARGB32, exp.newW, exp.newH);
                cr = new cairo.Context(surface);
                cr.setSourceRGBA(1, 1, 1, 1); // white border fill
                cr.paint();
                cr.setSourceSurface(baseSurface, exp.padLeftPx, exp.padTopPx);
                cr.paint();
                drawToWidget = (x, y) => [
                    (x - offsetX) * bufScale + exp.padLeftPx,
                    (y - offsetY) * bufScale + exp.padTopPx,
                ];
            } else {
                surface = cairo.ImageSurface.createFromPNG(tmpBase);
                cr = new cairo.Context(surface);
                drawToWidget = toWidget;
            }

            for (const action of actions) {
                if (typeof action.drawReal !== 'function') {
                    cr.save();
                    action.draw(cr, drawToWidget, drawScale);
                    cr.restore();
                }
            }

            surface.writeToPNG(tmpAnnotated);
            surface.finish();

            const annotPixbuf = GdkPixbuf.Pixbuf.new_from_file(tmpAnnotated);
            const bytes = this._pixbufToBytes(annotPixbuf);
            return { bytes, pixbuf: annotPixbuf };
        } finally {
            try { Gio.File.new_for_path(tmpBase).delete(null); } catch (_e) { /* */ }
            try { Gio.File.new_for_path(tmpAnnotated).delete(null); } catch (_e) { /* */ }
        }
    }

<<<<<<< Updated upstream
=======
    // =========================================================================
    // OCR — Optical Character Recognition via Tesseract
    // =========================================================================

    _getInstalledTessdataLanguages() {
        const languages = [];
        let enumerator = null;

        try {
            enumerator = Gio.File.new_for_path('/usr/share/tessdata').enumerate_children(
                'standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info = null;
            while ((info = enumerator.next_file(null)) !== null) {
                const name = info.get_name();
                if (name.endsWith('.traineddata'))
                    languages.push(name.slice(0, -'.traineddata'.length));
            }
        } catch {
            // Tesseract may use a non-standard data directory.
        } finally {
            try { enumerator?.close(null); } catch { /* */ }
        }

        return languages;
    }

    /**
     * Check if Tesseract OCR is installed on the system.
     * @returns {Promise<boolean>}
     */
    async _checkTesseractAvailable() {
        return GLib.file_test('/usr/bin/tesseract', GLib.FileTest.IS_EXECUTABLE);
    }

    /**
     * Get list of installed Tesseract language packs.
     * @returns {Promise<string[]>} e.g. ['eng', 'por', 'spa']
     */
    async _getTesseractLanguages() {
        try {
            const proc = Gio.Subprocess.new(
                ['/usr/bin/tesseract', '--list-langs'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            );
            const [, stdout, stderr] = await proc.communicate_utf8_async(null, null);
            // Tesseract outputs to stderr on some versions, stdout on others
            const output = (stdout || '') + (stderr || '');
            const reported = output.split(/\r?\n/)
                .map(line => line.trim())
                .filter(line => /^[a-z][a-z0-9_]*$/i.test(line));
            return [...new Set([
                ...reported,
                ...this._getInstalledTessdataLanguages(),
            ])];
        } catch {
            return this._getInstalledTessdataLanguages();
        }
    }

    /**
     * Detect system locale and map to Tesseract language code.
     * @returns {string} Tesseract language string e.g. 'por+eng+spa'
     */
    _getOcrSystemLanguage() {
        const LOCALE_MAP = {
            'ar': 'ara', 'bg': 'bul', 'cs': 'ces', 'da': 'dan',
            'de': 'deu', 'el': 'ell', 'en': 'eng', 'es': 'spa',
            'et': 'est', 'fi': 'fin', 'fr': 'fra', 'he': 'heb',
            'hi': 'hin', 'hr': 'hrv', 'hu': 'hun', 'is': 'isl',
            'it': 'ita', 'ja': 'jpn', 'ko': 'kor', 'nb': 'nor',
            'nl': 'nld', 'nn': 'nor', 'no': 'nor', 'pl': 'pol',
            'pt': 'por', 'ro': 'ron', 'ru': 'rus', 'sk': 'slk',
            'sv': 'swe', 'tr': 'tur', 'uk': 'ukr', 'zh': 'chi_sim',
        };

        for (const locale of GLib.get_language_names()) {
            const normalized = locale.toLowerCase().replace('-', '_');
            if (/^zh_(tw|hk|mo)/.test(normalized))
                return 'chi_tra';
            const langCode = locale.split(/[_.@]/, 1)[0].toLowerCase();
            if (LOCALE_MAP[langCode])
                return LOCALE_MAP[langCode];
        }
        return 'eng';
    }

    async _getOcrDefaultLang(availableLanguages = null) {
        const sysLang = this._getOcrSystemLanguage();

        // Build default: system lang + por + eng + spa (deduped)
        const defaults = [sysLang, 'por', 'eng', 'spa'];
        const available = availableLanguages || await this._getTesseractLanguages();
        const filtered = [...new Set(defaults)].filter(l => available.includes(l));

        return filtered.length > 0 ? filtered.join('+') : available[0];
    }

    _getOcrInstallPackages() {
        return ['tesseract', `tesseract-data-${this._getOcrSystemLanguage()}`];
    }

    async _refreshOcrLanguages() {
        if (!await this._checkTesseractAvailable()) {
            this._toolbar?.setOcrLanguages([]);
            return [];
        }

        const languages = (await this._getTesseractLanguages())
            .filter(language => language !== 'osd');
        this._toolbar?.setOcrLanguages(languages);
        return languages;
    }

    _confirmOcrInstall() {
        return this._toolbar?.confirmOcrInstall(this._getOcrInstallPackages().join(', ')) ??
            Promise.resolve(false);
    }

    async _closeScreenshotUiForAuthentication() {
        const ui = this._screenshotUI;
        if (!ui?.visible)
            return;

        ui.close();
        await new Promise(resolve => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                resolve();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _showOcrMessage(message) {
        if (this._screenshotUI?.visible)
            this._toolbar?.showInlineMessage(message);
        else
            this._showNotification('OCR', message);
    }

    async _installOcrSupport() {
        const pkexec = '/usr/bin/pkexec';
        const pacman = '/usr/bin/pacman';
        if (!GLib.file_test(pkexec, GLib.FileTest.IS_EXECUTABLE) ||
            !GLib.file_test(pacman, GLib.FileTest.IS_EXECUTABLE)) {
            this._toolbar?.showInlineMessage(
                _('Automatic installation is unavailable. Install Tesseract and its language packs with your package manager.'));
            return false;
        }

        try {
            if (!await this._confirmOcrInstall())
                return false;
        } catch (e) {
            console.error(`[Big Shot] Could not open OCR installation dialog: ${e.message}`);
            this._toolbar?.showInlineMessage(
                _('Automatic installation is unavailable. Install Tesseract and its language packs with your package manager.'));
            return false;
        }

        await this._closeScreenshotUiForAuthentication();
        this._showOcrMessage(_('Installing OCR support...'));

        try {
            const packages = this._getOcrInstallPackages();
            const proc = Gio.Subprocess.new([
                pkexec,
                pacman,
                '-S',
                '--needed',
                '--noconfirm',
                ...packages,
            ], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            const [, stdout, stderr] = await proc.communicate_utf8_async(null, null);

            if (!proc.get_successful()) {
                const details = (stderr || stdout || '').trim();
                if (details)
                    console.error(`[Big Shot] OCR package installation failed: ${details}`);
                this._showOcrMessage(
                    _('Could not install OCR support. Check the package manager and try again.'));
                return false;
            }

            const requiredLanguage = this._getOcrSystemLanguage();
            let languages = [];
            for (let attempt = 0; attempt < 3; attempt++) {
                languages = await this._refreshOcrLanguages();
                if (languages.includes(requiredLanguage))
                    break;
                await new Promise(resolve => {
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                        resolve();
                        return GLib.SOURCE_REMOVE;
                    });
                });
            }
            if (!languages.includes(requiredLanguage)) {
                this._showOcrMessage(
                    _('OCR was installed, but no language packs were found.'));
                return false;
            }

            this._showOcrMessage(_('OCR support installed successfully.'));
            return true;
        } catch (e) {
            console.error(`[Big Shot] OCR package installation failed: ${e.message}`);
            this._showOcrMessage(
                _('Could not install OCR support. Check the package manager and try again.'));
            return false;
        }
    }

    async _ensureOcrSupport() {
        const languages = await this._refreshOcrLanguages();
        const requiredLanguage = this._toolbar?.ocrLanguage || this._getOcrSystemLanguage();
        if (languages.includes(requiredLanguage))
            return true;

        if (!this._ocrInstallPromise) {
            this._ocrInstallPromise = this._installOcrSupport().finally(() => {
                this._ocrInstallPromise = null;
            });
        }
        return await this._ocrInstallPromise;
    }

    /**
     * Run Tesseract OCR on an image file asynchronously.
     * @param {string} imagePath - Path to PNG file
     * @param {string} lang - Tesseract language string e.g. 'por+eng'
     * @returns {Promise<string>} extracted text
     */
    async _runOCR(imagePath, lang) {
        const proc = Gio.Subprocess.new(
            ['/usr/bin/tesseract', imagePath, 'stdout', '-l', lang],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        );

        return new Promise((resolve, reject) => {
            proc.communicate_utf8_async(null, null, (source, asyncResult) => {
                try {
                    const [, stdout, stderr] = source.communicate_utf8_finish(asyncResult);
                    if (source.get_successful()) {
                        resolve((stdout || '').trim());
                    } else {
                        reject(new Error(stderr || 'Tesseract failed'));
                    }
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

>>>>>>> Stashed changes
    /**
     * Handle action button clicks from the toolbar.
     */
    async _handleAction(action) {
        const ui = this._screenshotUI;

        try {
            if (action === 'install-ocr') {
                await this._ensureOcrSupport();
                return;
            }

            const result = await this._captureAnnotatedBytes();
            if (!result) {
                console.error('[Big Shot] Failed to capture screenshot');
                return;
            }

            const { bytes, pixbuf } = result;

            // Preserve the selected pixels before closing Screenshot UI for
            // the PolicyKit authentication dialog.
            if (action === 'ocr' && !await this._ensureOcrSupport())
                return;

            switch (action) {
            case 'copy': {
                const clipboard = St.Clipboard.get_default();
                clipboard.set_content(St.ClipboardType.CLIPBOARD, 'image/png', bytes);
                global.display.get_sound_player().play_from_theme(
                    'screen-capture', _('Screenshot copied'), null);
                ui.close();
                break;
            }

            case 'save-as': {
                // Save to temp file, then open portal file chooser
                const tmpPath = GLib.build_filenamev([
                    GLib.get_tmp_dir(), `bigshot-saveas-${Date.now()}.png`]);
                const tmpFile = Gio.File.new_for_path(tmpPath);
                const outStream = tmpFile.create(Gio.FileCreateFlags.NONE, null);
                outStream.write_bytes(bytes, null);
                outStream.close(null);

                // Also copy to clipboard
                const clipboard = St.Clipboard.get_default();
                clipboard.set_content(St.ClipboardType.CLIPBOARD, 'image/png', bytes);

                ui.close();

                // Open file chooser via xdg-desktop-portal
                this._openSaveDialog(tmpPath, pixbuf);
                break;
            }

<<<<<<< Updated upstream
=======
            case 'ocr': {
                // Determine language
                const selectedLang = this._toolbar?.ocrLanguage;
                const lang = selectedLang || await this._getOcrDefaultLang();

                // Show processing message
                this._showOcrMessage(_('Extracting text...'));

                // Save screenshot to temp file for Tesseract
                const tmpOcrPath = GLib.build_filenamev([
                    GLib.get_tmp_dir(), `bigshot-ocr-${Date.now()}.png`]);

                try {
                    const tmpOcrFile = Gio.File.new_for_path(tmpOcrPath);
                    const ocrStream = tmpOcrFile.create(Gio.FileCreateFlags.NONE, null);
                    ocrStream.write_bytes(bytes, null);
                    ocrStream.close(null);

                    const text = await this._runOCR(tmpOcrPath, lang);

                    if (text && text.length > 0) {
                        // Copy extracted text to clipboard
                        const clipboard = St.Clipboard.get_default();
                        clipboard.set_text(St.ClipboardType.CLIPBOARD, text);

                        this._showOcrMessage(
                            _('Text copied to clipboard! (%d chars)').format(text.length));

                        console.log(`[Big Shot] OCR extracted ${text.length} chars (lang=${lang})`);
                    } else {
                        this._showOcrMessage(
                            _('No text found in selection'));
                    }
                } catch (e) {
                    console.error(`[Big Shot] OCR failed: ${e.message}`);
                    this._showOcrMessage(
                        _('OCR failed: %s').format(e.message));
                } finally {
                    try { Gio.File.new_for_path(tmpOcrPath).delete(null); } catch (_e) { /* */ }
                }
                break;
            }

>>>>>>> Stashed changes
            }
        } catch (e) {
            console.error(`[Big Shot] Action '${action}' failed: ${e.message}\n${e.stack}`);
        }
    }

    /**
     * Open a Save As dialog via xdg-desktop-portal FileChooser.
     */
    _openSaveDialog(tmpPath, _pixbuf) {
        try {
            const time = GLib.DateTime.new_now_local();
            const suggestedName = _('Screenshot from %s').format(
                time.format('%Y-%m-%d %H-%M-%S')) + '.png';

            // Use xdg-open with the temp file, or try portal
            const bus = Gio.DBus.session;
            bus.call(
                'org.freedesktop.portal.Desktop',
                '/org/freedesktop/portal/desktop',
                'org.freedesktop.portal.FileChooser',
                'SaveFile',
                new GLib.Variant('(ssa{sv})', [
                    '',
                    _('Save Screenshot'),
                    {
                        'current_name': new GLib.Variant('s', suggestedName),
                        'current_folder': new GLib.Variant('ay',
                            new TextEncoder().encode(
                                GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) ||
                                GLib.get_home_dir(),
                            )),
                        'filters': new GLib.Variant('a(sa(us))', [
                            ['PNG Images', [
                                [0, '*.png'],
                            ]],
                        ]),
                    },
                ]),
                new GLib.VariantType('(o)'),
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                (conn, asyncResult) => {
                    try {
                        const result = conn.call_finish(asyncResult);
                        const [requestPath] = result.deepUnpack();

                        // Listen for the Response signal
                        const subId = bus.signal_subscribe(
                            'org.freedesktop.portal.Desktop',
                            'org.freedesktop.portal.Request',
                            'Response',
                            requestPath,
                            null,
                            Gio.DBusSignalFlags.NO_MATCH_RULE,
                            (_c, _sender, _path, _iface, _signal, params) => {
                                bus.signal_unsubscribe(subId);
                                const [response, results] = params.deepUnpack();
                                if (response === 0 && results.uris) {
                                    const uris = results.uris.deepUnpack();
                                    if (uris.length > 0) {
                                        const destFile = Gio.File.new_for_uri(uris[0]);
                                        const srcFile = Gio.File.new_for_path(tmpPath);
                                        try {
                                            srcFile.copy(destFile, Gio.FileCopyFlags.OVERWRITE, null, null);
                                        } catch (err) {
                                            console.error(`[Big Shot] Save failed: ${err.message}`);
                                        }
                                    }
                                }
                                // Clean up temp file
                                try { Gio.File.new_for_path(tmpPath).delete(null); } catch (_e) { /* */ }
                            },
                        );
                    } catch (e) {
                        console.error(`[Big Shot] Portal SaveFile failed: ${e.message}`);
                        // Fallback: just open file manager at the temp location
                        try { Gio.File.new_for_path(tmpPath).delete(null); } catch (_e) { /* */ }
                    }
                },
            );
        } catch (e) {
            console.error(`[Big Shot] Save dialog failed: ${e.message}`);
            try { Gio.File.new_for_path(tmpPath).delete(null); } catch (_e) { /* */ }
        }
    }

    /**
     * Show a desktop notification via GNOME Shell.
     */
    _showNotification(title, body) {
        try {
            const source = new MessageTray.Source({
                title: 'Big Shot',
                iconName: 'camera-photo-symbolic',
            });
            Main.messageTray.add(source);
            const notification = new MessageTray.Notification({
                source,
                title,
                body,
            });
            source.addNotification(notification);
        } catch (_e) {
            // Fallback: show as OSD via Main.osdWindowManager
            try {
                const monitor = global.display.get_current_monitor();
                Main.osdWindowManager.show(monitor, null, `${title}: ${body}`, -1);
            } catch (_e2) {
                // Last resort: just console log
            }
        }
    }

<<<<<<< Updated upstream
    _detectPipelines() {
        if (this._availableConfigs !== null)
            return Promise.resolve(this._availableConfigs);
        if (this._pipelineDetectionPromise)
            return this._pipelineDetectionPromise;

        const generation = this._pipelineDetectionGeneration;
        this._pipelineDetectionPromise = this._runPipelineDetection(generation)
            .finally(() => {
                if (generation === this._pipelineDetectionGeneration)
                    this._pipelineDetectionPromise = null;
            });
        return this._pipelineDetectionPromise;
    }

    async _runPipelineDetection(generation) {
        const startedAt = GLib.get_monotonic_time();
        const gpuVendors = await detectGpuVendors();
        const vendorSet = new Set(gpuVendors);

        const candidates = VIDEO_PIPELINES.filter(config =>
            config.vendors.length === 0 ||
            config.vendors.some(vendor => vendorSet.has(vendor)));
        const elementNames = new Set(candidates.flatMap(config => config.elements));
        elementNames.add('mp4mux');
        elementNames.add('webmmux');
        for (const choices of Object.values(AUDIO_PIPELINES)) {
            for (const choice of choices)
                elementNames.add(choice.element);
        }

        const checks = await Promise.all([...elementNames].map(async name =>
            [name, await checkElement(name)]));
        const availableElements = new Set(
            checks.filter(([, available]) => available).map(([name]) => name));

        if (generation !== this._pipelineDetectionGeneration || !this._screenshotUI)
            return [];

        const available = candidates.filter(config =>
            config.elements.every(element => availableElements.has(element)) &&
            availableElements.has(config.ext === 'mp4' ? 'mp4mux' : 'webmmux'));
        const gpuConfigs = available.filter(config => config.vendors.length > 0);
        const swConfigs = available.filter(config => config.vendors.length === 0);

        this._gpuVendors = gpuVendors;
        this._availableElements = availableElements;
        this._availableConfigs = [...gpuConfigs, ...swConfigs];
        if (this._availableConfigs.length === 0)
            console.warn('[Big Shot] No compatible GStreamer pipeline found!');
        else
            console.log(`[Big Shot] Pipeline detection ready in ${Math.round((GLib.get_monotonic_time() - startedAt) / 1000)} ms: ${this._availableConfigs.map(config => config.id).join(', ')}`);

        return this._availableConfigs;
=======
    async _detectPipelines() {
        // Already detected — skip
        if (this._availableConfigs !== null)
            return this._availableConfigs;
        if (this._pipelineDetectionPromise)
            return this._pipelineDetectionPromise;

        const enableSerial = this._activeEnableSerial;
        const detection = (async () => {
            const elementNames = [...new Set(VIDEO_PIPELINES.flatMap(config => config.elements))];
            const [gpuVendors, elementResults] = await Promise.all([
                detectGpuVendors(),
                Promise.all(elementNames.map(async name => [name, await checkElement(name)])),
            ]);

            if (!enableSerial || this._activeEnableSerial !== enableSerial)
                return [];

            const availableElements = new Map(elementResults);
            const vendorSet = new Set(gpuVendors);
            const gpuConfigs = [];
            const swConfigs = [];

            for (const config of VIDEO_PIPELINES) {
                if (!config.elements.every(element => availableElements.get(element)))
                    continue;

                if (config.vendors.length === 0) {
                    swConfigs.push(config);
                } else if (config.vendors.some(vendor => vendorSet.has(vendor))) {
                    gpuConfigs.push(config);
                }
            }

            this._gpuVendors = gpuVendors;
            this._availableConfigs = [...gpuConfigs, ...swConfigs];
            if (this._availableConfigs.length === 0)
                console.warn('[Big Shot] No compatible GStreamer pipeline found!');
            return this._availableConfigs;
        })();

        this._pipelineDetectionPromise = detection;
        try {
            return await detection;
        } finally {
            if (this._pipelineDetectionPromise === detection)
                this._pipelineDetectionPromise = null;
        }
>>>>>>> Stashed changes
    }

    _getAutoPipelineConfigs() {
        if (!this._availableConfigs)
            return [];

        const gpuConfigs = this._availableConfigs.filter(config => config.vendors.length > 0);
        const swFallbacks = this._availableConfigs.filter(config =>
            config.vendors.length === 0 && config.auto !== false);

        return [...gpuConfigs, ...swFallbacks];
    }

    _createParts() {
        const ui = this._screenshotUI;
        const ext = this;

        // Toolbar — main contextual toolbar above screenshot UI
        this._toolbar = new PartToolbar(ui, ext);
        this._parts.push(this._toolbar);

        // Annotation — connects toolbar to drawing overlay
        this._annotation = new PartAnnotation(ui, ext);
        this._parts.push(this._annotation);

        // Video annotation — same drawing tools captured during screencast
        this._videoAnnotation = new PartVideoAnnotation(ui, ext);
        this._parts.push(this._videoAnnotation);

        // Magnifier — zoom pop-up on shift key
        this._magnifier = new PartMagnifier(ui, ext);
        this._parts.push(this._magnifier);

        // Wire toolbar tool changes to overlay reactivity
        this._toolbar.onToolChanged((toolId) => {
            // Toggle drawing overlay reactivity: only capture events when
            // a drawing tool is active (pen, arrow, line, etc.).
            // No-tool mode must let events pass through to native screenshot controls.
            const overlay = this._annotation?._overlay;
            if (overlay) {
                const isDrawTool = toolId !== null;
                overlay.setReactive(isDrawTool);
            }

            // Panel visibility is controlled by the eye button in the
            // edit toolbar; do not override the user's choice here.
        });

        // Wire action buttons (copy, save-as, ocr)
        this._toolbar.onAction((action) => {
            this._handleAction(action);
        });

<<<<<<< Updated upstream
=======
        // Detect Tesseract and populate OCR languages (async — won't block UI)
        this._refreshOcrLanguages().catch(e => {
            console.log(`[Big Shot] Tesseract detection skipped: ${e.message}`);
        });

>>>>>>> Stashed changes
        // Audio — Desktop + Mic toggle buttons
        this._audio = new PartAudio(ui, ext);
        this._parts.push(this._audio);

        // Framerate selector
        this._framerate = new PartFramerate(ui, ext);
        this._parts.push(this._framerate);

        // Downsize selector
        this._downsize = new PartDownsize(ui, ext);
        this._parts.push(this._downsize);

        // Panel indicator (spinner + timer)
        this._indicator = new PartIndicator(ui, ext);
        this._parts.push(this._indicator);

        // Quick Stop
        this._quickstop = new PartQuickStop(ui, ext);
        this._parts.push(this._quickstop);

        // Webcam overlay
        this._webcam = new PartWebcam(ui, ext);
        this._parts.push(this._webcam);

        // Wire webcam toggle (bottom bar button) to mask/size/camera row visibility
        this._webcam.onWebcamToggled((enabled) => {
            if (this._toolbar._maskRow)
                this._toolbar._maskRow.visible = enabled;
            if (this._toolbar._sizeRow)
                this._toolbar._sizeRow.visible = enabled;
            if (this._toolbar._cameraRow && enabled) {
                // Populate camera list when webcam is enabled
                const devices = this._webcam.enumerateDevices();
                this._toolbar.populateCameras(devices);
            } else if (this._toolbar._cameraRow) {
                this._toolbar._cameraRow.visible = false;
            }
            // Reposition video panel so it doesn't overlap the bottom bar
            this._toolbar.repositionVideoPanel();
        });

        // Wire camera selection from toolbar
        this._toolbar.onCameraChanged((device) => {
            this._webcam.selectedDevice = device;
        });

        // Wire mic toggle → populate microphone selector in toolbar
        this._audio.onMicToggled((enabled) => {
            if (enabled) {
                const mics = this._audio.enumerateMicrophones();
                this._toolbar.populateMicrophones(mics);
            } else {
                this._toolbar.populateMicrophones([]);
            }
            this._toolbar.repositionVideoPanel();
        });

        // Wire mic selection from toolbar
        this._toolbar.onMicChanged((micId) => {
            this._audio.selectedMicId = micId;
        });

        // Wire mask selection from toolbar
        this._toolbar.onMaskChanged((maskId) => {
            this._webcam.maskId = maskId;
        });

        // Wire size selection from toolbar
        this._toolbar.onSizeChanged((width) => {
            this._webcam.width = width;
        });

        // Stop webcam preview when UI closes without active recording
        // Re-start preview when UI opens if webcam is still enabled
        // Reparent webcam overlay between screenshotUI (preview) and TopChrome (recording)
        this._webcamUIVisId = ui.connect('notify::visible', () => {
            if (ui.visible && this._webcam.enabled && this._recordingState === 'idle') {
                this._webcam.reparentForPreview();
                this._webcam.startPreview();
            } else if (!ui.visible && this._recordingState === 'idle') {
                // Reset webcam button to off so next open starts clean
                if (this._webcam?._webcamButton)
                    this._webcam._webcamButton.checked = false;
            } else if (!ui.visible && this._recordingState !== 'idle') {
                // Recording started, UI hiding — move webcam to TopChrome
                this._webcam?.reparentForRecording();
            }
        });
    }

    _patchScreencast() {
        const screenshotUI = this._screenshotUI;
        if (!screenshotUI) return;

        const screencastProxy = screenshotUI._screencastProxy;
        const ext = this;

        // Save original methods (proxy methods only exist if the proxy
        // exists; if a future Shell removes the proxy entirely we just
        // skip the pipeline injection silently).
        if (screencastProxy) {
            this._origScreencast = screencastProxy.ScreencastAsync?.bind(screencastProxy);
            this._origScreencastArea = screencastProxy.ScreencastAreaAsync?.bind(screencastProxy);
            if (typeof screencastProxy.get_default_timeout === 'function' &&
                typeof screencastProxy.set_default_timeout === 'function') {
                this._origScreencastProxyTimeout = screencastProxy.get_default_timeout();
                screencastProxy.set_default_timeout(SCREENCAST_DBUS_TIMEOUT_MS);
            }

            // Patch ScreencastAsync
            if (this._origScreencast) {
                screencastProxy.ScreencastAsync = function (filePath, options) {
<<<<<<< Updated upstream
                    const geometry = screenshotUI._getSelectedGeometry?.(true);
                    const captureSize = geometry
                        ? { width: geometry[2], height: geometry[3] }
                        : null;
                    return ext._screencastCommonAsync(
                        filePath, options, ext._origScreencast, captureSize);
=======
                    return ext._screencastCommonAsync(
                        filePath,
                        options,
                        ext._origScreencast,
                        { width: global.stage.width, height: global.stage.height },
                    );
>>>>>>> Stashed changes
                };
            }

            // Patch ScreencastAreaAsync
            if (this._origScreencastArea) {
                screencastProxy.ScreencastAreaAsync = function (x, y, width, height, filePath, options) {
<<<<<<< Updated upstream
                    return ext._screencastCommonAsync(filePath, options, (fp, opts) => {
                        return ext._origScreencastArea(x, y, width, height, fp, opts);
                    }, { width, height });
=======
                    return ext._screencastCommonAsync(
                        filePath,
                        options,
                        (fp, opts) => ext._origScreencastArea(x, y, width, height, fp, opts),
                        { width, height },
                    );
>>>>>>> Stashed changes
                };
            }

            this._origStopScreencastAsync = screencastProxy.StopScreencastAsync?.bind(screencastProxy);
            if (this._origStopScreencastAsync) {
                screencastProxy.StopScreencastAsync = function (...args) {
                    return ext._stopScreencastProxyAsync(...args);
                };
            }
        } else {
            console.warn('[Big Shot] _screencastProxy not found — custom pipelines disabled');
        }

        // Single open() patch: combines QuickStop (stop recording on
        // re-open) and allow-screenshot-while-recording logic.
        // Having a single save/restore avoids stale closure chains after
        // lock-screen disable/enable cycles.
        if (typeof screenshotUI.open !== 'function') {
            console.warn('[Big Shot] screenshotUI.open missing — Quick Stop disabled');
            return;
        }
        this._origOpen = screenshotUI.open.bind(screenshotUI);
        screenshotUI.open = function (mode) {
            if (mode === undefined) mode = 0; // UIMode.SCREENSHOT default

            // QuickStop only when user re-opens in SCREENCAST mode while
            // a recording is in progress. Opening in SCREENSHOT mode (e.g.
            // PrintScreen) must NOT stop the recording — the user wants to
            // grab a quick screenshot/edit while the recording continues.
            if (mode === 1 /* UIMode.SCREENCAST */) {
                if (ext._recordingState === 'paused') {
                    ext._finishPausedRecording();
                    Main.screenshotUI?.close();
                    return Promise.resolve();
                }
                if (ext._isRecordingActive()) {
                    try {
                        ext._stopActiveRecording();
                        Main.screenshotUI?.close();
                    } catch (e) {
                        console.error(`[Big Shot] Quick stop error: ${e.message}`);
                    }
                    return Promise.resolve();
                }
            }

            // Allow screenshot UI while recording: GNOME blocks open() when
            // _screencastInProgress is true. Temporarily clear the flag so
            // screenshot mode (UIMode.SCREENSHOT=0) can open during recording.
            if (this._screencastInProgress && mode !== 1) {
                const saved = this._screencastInProgress;
                this._screencastInProgress = false;
                const result = ext._origOpen.call(this, mode);
                this._screencastInProgress = saved;
                return result;
            }
            return ext._origOpen.call(this, mode);
        };

        // Patch _startScreencast so we can mark recording state BEFORE
        // the UI calls close(true), allowing the notify::visible handler
        // to reparent the webcam overlay instead of destroying it.
        // Also: native _startScreencast doesn't handle window mode; intercept
        // when _windowButton is checked and convert to ScreencastAreaAsync
        // using the window's screen rect.
        this._origStartScreencast = screenshotUI._startScreencast?.bind(screenshotUI);
        if (this._origStartScreencast) {
            screenshotUI._startScreencast = function (...args) {
                ext._recordingState = 'starting';
                if (this._windowButton?.checked) {
                    return ext._startWindowScreencast(this);
                }
                return ext._origStartScreencast(...args);
            };
        }

        this._origStopScreencast = screenshotUI.stopScreencast?.bind(screenshotUI);
        if (this._origStopScreencast) {
            screenshotUI.stopScreencast = function (...args) {
                return ext._stopScreencastUiAsync(...args);
            };
        }

        this._origScreencastFailed = screenshotUI._screencastFailed?.bind(screenshotUI);
        if (this._origScreencastFailed) {
            screenshotUI._screencastFailed = function (...args) {
                if (ext._shouldIgnorePauseStopFailure()) {
                    ext._suppressPauseStopFailure = false;
                    return;
                }
                return ext._origScreencastFailed(...args);
            };
        }

        // Native sets _windowButton.reactive = false in two places when
        // entering screencast mode:
        //   1. _onCastButtonToggled (toggle handler)
        //   2. _syncWindowButtonSensitivity (called from open/refresh paths)
        // Patch both so the window button stays usable during screencast.
        this._origSyncWindowButtonSensitivity =
            screenshotUI._syncWindowButtonSensitivity?.bind(screenshotUI);
        if (this._origSyncWindowButtonSensitivity) {
            screenshotUI._syncWindowButtonSensitivity = function () {
                const windows =
                    this._windowSelectors.flatMap(selector => selector.windows());
                this._windowButton.reactive =
                    Main.sessionMode.hasWindows && windows.length > 0;
            };
        }

        // Native connects _onCastButtonToggled via .bind() at construction
        // time, so monkey-patching the method has no effect on the live
        // signal handler. Instead, connect our own notify::checked listener
        // that runs after the native one and reverts reactive=false — but
        // only when there are actually windows to record (matches the
        // disabled state shown in screenshot mode when no windows exist).
        const castButton = screenshotUI._castButton;
        if (castButton) {
            const refreshWindowReactive = () => {
                if (!castButton.checked) return;
                screenshotUI._syncWindowButtonSensitivity?.();
            };
            this._castButtonReactivityId = castButton.connect(
                'notify::checked', refreshWindowReactive);
            refreshWindowReactive();
        }
    }

    /**
     * Start a screencast of the currently selected window by converting it
     * to a ScreencastAreaAsync call with the window's screen rect.
     * Native GNOME 50 _startScreencast bails out when window mode is active
     * (TODO comment in shell source), so we provide the implementation here.
     */
    async _startWindowScreencast(ui) {
        const item = ui._windowSelectors
            ?.flatMap(s => s.windows())
            ?.find(win => win.checked);
        if (!item) {
            this._recordingState = 'idle';
            return;
        }

        // UIWindowSelectorWindow exposes boundingBox = window.get_frame_rect()
        // (logical screen coordinates), set at construction. The MetaWindow
        // itself isn't kept as a property by GNOME 50.
        const rect = item.boundingBox;
        if (!rect || rect.width <= 0 || rect.height <= 0) {
            console.warn('[Big Shot] Window screencast: invalid bounding box');
            this._recordingState = 'idle';
            return;
        }
        const proxy = ui._screencastProxy;
        if (!proxy || typeof proxy.ScreencastAreaAsync !== 'function') {
            console.warn('[Big Shot] Window screencast: proxy unavailable');
            this._recordingState = 'idle';
            return;
        }

        // Round to even pixels. H.264 (and most HW encoders) require even
        // width/height; an odd rect makes the videocrop produce a stream
        // the encoder can't accept cleanly, which the user sees as dropped
        // / repeated frames at the edge.
        const x = rect.x & ~1;
        const y = rect.y & ~1;
        const width = Math.max(2, rect.width & ~1);
        const height = Math.max(2, rect.height & ~1);

        const drawCursor = ui._cursor?.visible ?? true;
        // Save under ~/Videos/BigShot/ so window and full-screen recordings
        // land in the same place. The screencast service resolves this
        // relative to XDG_VIDEOS_DIR and expands %d/%t.
        const filePath = buildBigShotRecordingPath();
        ensureRecordingFolder();
        const options = { 'draw-cursor': new GLib.Variant('b', drawCursor) };

        // Set in-progress BEFORE the async call so the indicator picks it up
        // (mirrors native _startScreencast).
        if (typeof ui._setScreencastInProgress === 'function')
            ui._setScreencastInProgress(true);
        else
            ui._screencastInProgress = true;
        ui._screencastStarting = true;

        // Close the UI immediately so the fade-out doesn't get recorded.
        try { ui.close(true); } catch (_e) { /* */ }

        try {
            const [success, path] = await proxy.ScreencastAreaAsync(
                x, y, width, height, filePath, options,
            );
            if (success) {
                ui._screencastPath = path;
            } else {
                this._recordingState = 'idle';
                if (typeof ui._setScreencastInProgress === 'function')
                    ui._setScreencastInProgress(false);
                else
                    ui._screencastInProgress = false;
                console.warn('[Big Shot] Window screencast: service returned failure');
            }
        } catch (e) {
            this._recordingState = 'idle';
            if (typeof ui._setScreencastInProgress === 'function')
                ui._setScreencastInProgress(false);
            else
                ui._screencastInProgress = false;
            console.error(`[Big Shot] Window screencast error: ${e.message}`);
        } finally {
            delete ui._screencastStarting;
        }
    }

    _unpatchScreencast() {
        const ui = this._screenshotUI;
        const screencastProxy = ui?._screencastProxy;

        if (screencastProxy) {
            if (this._origScreencast)
                screencastProxy.ScreencastAsync = this._origScreencast;
            if (this._origScreencastArea)
                screencastProxy.ScreencastAreaAsync = this._origScreencastArea;
            if (this._origStopScreencastAsync)
                screencastProxy.StopScreencastAsync = this._origStopScreencastAsync;
            if (this._origScreencastProxyTimeout !== null &&
                typeof screencastProxy.set_default_timeout === 'function')
                screencastProxy.set_default_timeout(this._origScreencastProxyTimeout);
        }

        if (ui && this._origOpen)
            ui.open = this._origOpen;
        if (ui && this._origStartScreencast)
            ui._startScreencast = this._origStartScreencast;
        if (ui && this._origStopScreencast)
            ui.stopScreencast = this._origStopScreencast;
        if (ui && this._origScreencastFailed)
            ui._screencastFailed = this._origScreencastFailed;
        if (ui && this._origSyncWindowButtonSensitivity)
            ui._syncWindowButtonSensitivity = this._origSyncWindowButtonSensitivity;
        if (ui && this._castButtonReactivityId && ui._castButton) {
            try { ui._castButton.disconnect(this._castButtonReactivityId); } catch (_e) { /* */ }
        }

        this._origScreencast = null;
        this._origScreencastArea = null;
        this._origStopScreencastAsync = null;
        this._origOpen = null;
        this._origStartScreencast = null;
        this._origStopScreencast = null;
        this._origScreencastFailed = null;
        this._origSyncWindowButtonSensitivity = null;
        this._castButtonReactivityId = 0;
        this._origScreencastProxyTimeout = null;
    }

    async _screencastCommonAsync(filePath, options, originalMethod, captureSize = null) {
<<<<<<< Updated upstream
        // Share the background probe when it is still finishing.
=======
        // Lazy pipeline detection on first use (avoids blocking enable())
>>>>>>> Stashed changes
        await this._detectPipelines();

        // Force every recording (full-screen and area) into ~/Videos/BigShot/
        // with the localized "BigShot from %d %t" filename.
        filePath = buildBigShotRecordingPath();
        ensureRecordingFolder();

<<<<<<< Updated upstream
        if (!this._availableConfigs?.length) {
            return this._startNativeFallback(
                filePath, options, originalMethod, captureSize);
        }

=======
>>>>>>> Stashed changes
        const framerate = this._framerate?.value ?? 30;
        const downsize = this._downsize?.value ?? 1.0;
        const quality = this._toolbar?.videoQuality ?? 'high';
        const framerateCaps = `${framerate}/1`;

        // Set framerate in D-Bus options
        options['framerate'] = new GLib.Variant('i', framerate);
        const baseOptions = { ...options };

        // Show indicator once at the start of cascade
        this._indicator?.onPipelineStarting();

        // Auto mode is GPU-first. Software encoders are only fallbacks after
        // every detected GPU pipeline failed. Manual codec selection still
        // starts with the selected pipeline.
        let configs = this._getAutoPipelineConfigs();
        const preferredId = this._toolbar?.selectedPipelineId;
        if (preferredId) {
            const preferred = this._availableConfigs.find(c => c.id === preferredId);
            configs = preferred
                ? [preferred, ...configs.filter(c => c.id !== preferredId)]
                : configs;
        }

        // Try each config in cascade: preferred → GPU hw → VAAPI → Software
        for (let i = 0; i < configs.length; i++) {
            const config = configs[i];
            const pipeline = this._makePipelineString(
<<<<<<< Updated upstream
                config, framerateCaps, downsize, quality, captureSize);
=======
                config,
                framerateCaps,
                downsize,
                quality,
                captureSize,
            );
>>>>>>> Stashed changes
            const pipelineOptions = {
                ...options,
                pipeline: new GLib.Variant('s', pipeline),
            };

            // Mark recording as starting BEFORE await so that
            // the notify::visible handler can reparent the webcam overlay
            // instead of stopping it when the UI hides.
            this._recordingState = 'starting';
            const startedAtUnix = GLib.DateTime.new_now_local().to_unix();

            try {
                const result = await originalMethod(filePath, pipelineOptions);
                if (result && result[0] === false)
                    throw new Error('Screencast service returned failure');
                return this._registerRecordingStarted({
                    result,
                    config,
                    originalMethod,
                    baseOptions,
                    framerateCaps,
                    downsize,
                    quality,
                    captureSize,
                    fallbackPath: filePath,
                });
            } catch (e) {
                const recovered = this._recoverStartedRecordingAfterTimeout({
                    error: e,
                    config,
                    originalMethod,
                    baseOptions,
                    framerateCaps,
                    downsize,
                    quality,
                    captureSize,
                    startedAtUnix,
                });
                if (recovered)
                    return recovered;

                this._recordingState = 'idle';
                console.warn(`[Big Shot] Pipeline ${config.id} failed: ${e.message}`);
                // Continue to next config
            }
        }

        // All custom pipelines exhausted — clean up indicator and fall back
        console.warn('[Big Shot] All pipelines failed, falling back to GNOME default');
<<<<<<< Updated upstream
        this._indicator?.onPipelineReady();
        return this._startNativeFallback(
            filePath, options, originalMethod, captureSize);
    }

    async _startNativeFallback(filePath, options, originalMethod, captureSize) {
=======
        return this._startDefaultRecording({
            filePath,
            options: baseOptions,
            originalMethod,
            framerateCaps,
            downsize,
            quality,
            captureSize,
        });
    }

    async _startDefaultRecording({
        filePath,
        options,
        originalMethod,
        framerateCaps,
        downsize,
        quality,
        captureSize,
    }) {
>>>>>>> Stashed changes
        this._recordingState = 'starting';
        try {
            const result = await originalMethod(filePath, options);
            if (result && result[0] === false)
                throw new Error('Screencast service returned failure');

            const actualPath = result?.[1] ?? filePath;
<<<<<<< Updated upstream
            const extensionMatch = typeof actualPath === 'string'
                ? actualPath.match(/\.([A-Za-z0-9]+)$/)
                : null;
            const ext = extensionMatch?.[1] ?? 'webm';
            return this._registerRecordingStarted({
                result,
                config: {
                    id: 'gnome-default',
                    label: 'GNOME Default',
                    ext,
                    native: true,
                },
                originalMethod,
                baseOptions: { ...options },
                framerateCaps: `${this._framerate?.value ?? 30}/1`,
                downsize: 1.0,
                quality: 'high',
                captureSize,
                fallbackPath: actualPath,
=======
            const config = {
                id: 'gnome-default',
                label: 'GNOME default',
                ext: recordingExtension(actualPath),
                vendors: [],
            };
            return this._registerRecordingStarted({
                result,
                config,
                originalMethod,
                baseOptions: options,
                framerateCaps,
                downsize,
                quality,
                captureSize,
                fallbackPath: filePath,
                defaultPipeline: true,
>>>>>>> Stashed changes
            });
        } catch (e) {
            this._recordingState = 'idle';
            this._indicator?.onPipelineReady();
            throw e;
        }
    }

    _registerRecordingStarted({
        result,
        config,
        originalMethod,
        baseOptions,
        framerateCaps,
        downsize,
        quality,
        captureSize,
        fallbackPath,
        defaultPipeline = false,
    }) {
        this._indicator?.onPipelineReady();

        this._recordingState = 'recording';
        console.log(`[Big Shot] Recording started with ${config.id}`);
        this._recordingContext = {
            config,
            originalMethod,
        };

        const actualPath = result?.[1] ?? fallbackPath;
        const correctExt = `.${config.ext}`;
        const correctedPath = typeof actualPath === 'string' && !actualPath.endsWith(correctExt)
            ? actualPath.replace(/\.[^.]+$/, correctExt)
            : actualPath;

        this._recordingSession = {
            id: buildSegmentSessionId(),
            config,
            starter: originalMethod,
            baseOptions,
            framerateCaps,
            downsize,
            quality,
            captureSize,
<<<<<<< Updated upstream
=======
            defaultPipeline,
>>>>>>> Stashed changes
            ext: config.ext,
            segments: [],
            finalPath: correctedPath,
            nextIndex: 2,
        };
        this._currentSegment = {
            index: 1,
            actualPath,
            path: correctedPath,
            ext: config.ext,
            finalized: false,
        };
        this._currentSegmentPath = correctedPath;

        this._watchForFinalStop();

        try {
            this._indicator?.onRecordingStarted();
            this._videoAnnotation?.onRecordingStarted();
        } catch (indErr) {
            console.error('[Big Shot] onRecordingStarted ERROR:', indErr.message, indErr.stack);
        }

        return (result && result[0])
            ? [result[0], correctedPath]
            : result;
    }

    _isStartupTimeout(error) {
        if (error?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.TIMED_OUT))
            return true;
        const message = String(error?.message ?? error).toLowerCase();
        return message.includes('timeout') || message.includes('timed out') ||
            message.includes('tempo limite');
    }

    _recoverStartedRecordingAfterTimeout({
        error,
        config,
        originalMethod,
        baseOptions,
        framerateCaps,
        downsize,
        quality,
        captureSize,
        startedAtUnix,
    }) {
        if (!this._isStartupTimeout(error))
            return null;

        const activePath = findRecentRecordingFile(config.ext, startedAtUnix);
        if (!activePath) {
            this._stopScreencastAfterStartupFailure();
            return null;
        }

        console.warn(`[Big Shot] Pipeline ${config.id} start timed out after output began; keeping recording attached`);
        return this._registerRecordingStarted({
            result: [true, activePath],
            config,
            originalMethod,
            baseOptions,
            framerateCaps,
            downsize,
            quality,
            captureSize,
            fallbackPath: activePath,
        });
    }

    _stopScreencastAfterStartupFailure() {
        if (!this._origStopScreencastAsync)
            return;

        try {
            const result = this._origStopScreencastAsync();
            if (result?.catch)
                result.catch(e => console.warn(`[Big Shot] stale screencast stop failed: ${e.message}`));
        } catch (e) {
            console.warn(`[Big Shot] stale screencast stop failed: ${e.message}`);
        }
    }

    // =========================================================================
    // RECORDING STATE — version-agnostic helpers
    // =========================================================================

    /**
     * Whether a screencast is currently active.
     * Works across GNOME versions: prefers the public state flag, falls back
     * to the legacy Shell.Recorder when the flag is absent.
     */
    _isRecordingActive() {
        const ui = this._screenshotUI ?? Main.screenshotUI;
        if (!ui) return false;
        if (ui._screencastInProgress) return true;
        // GNOME ≤ 49 fallback
        const recorder = ui._recorder;
        if (recorder && typeof recorder.is_recording === 'function') {
            try { return recorder.is_recording(); } catch (_e) { /* */ }
        }
        return false;
    }

    /**
     * Stop the active screencast, choosing the best available API.
     * GNOME 50 removed Shell.Recorder.close() and introduced the public
     * stopScreencast() method on ScreenshotUI; older versions still expose
     * the recorder. Try both, swallow errors so the UI can always close.
     */
    _stopActiveRecording() {
        const ui = this._screenshotUI ?? Main.screenshotUI;
        if (!ui) return;

        if (this._recordingState === 'paused') {
            this._finishPausedRecording();
            return;
        }

        // Preferred: GNOME 50+ public API
        if (typeof ui.stopScreencast === 'function') {
            try { ui.stopScreencast(); return; } catch (e) {
                console.warn(`[Big Shot] stopScreencast failed: ${e.message}`);
            }
        }

        // Legacy: GNOME ≤ 49 internal recorder
        const recorder = ui._recorder;
        if (recorder && typeof recorder.close === 'function') {
            try { recorder.close(); return; } catch (e) {
                console.warn(`[Big Shot] recorder.close failed: ${e.message}`);
            }
        }

        // Last resort: ask the screencast service directly
        const proxy = ui._screencastProxy;
        if (proxy && typeof proxy.StopScreencastAsync === 'function') {
            try { proxy.StopScreencastAsync(); } catch (e) {
                console.warn(`[Big Shot] StopScreencastAsync failed: ${e.message}`);
            }
        }
    }

    _prepareRecordingStop() {
        this._videoAnnotation?.finishEditForStop();
    }

    _stopScreencastProxyAsync(...args) {
        if (this._recordingState === 'paused') {
            this._finishPausedRecording();
            return Promise.resolve([true]);
        }

        this._prepareRecordingStop();
        return this._origStopScreencastAsync(...args);
    }

    _stopScreencastUiAsync(...args) {
        if (this._recordingState === 'paused') {
            this._finishPausedRecording();
            return Promise.resolve();
        }

        this._prepareRecordingStop();
        return this._origStopScreencast(...args);
    }

    _setScreencastInProgress(active) {
        const ui = this._screenshotUI ?? Main.screenshotUI;
        if (!ui)
            return;

        if (typeof ui._setScreencastInProgress === 'function')
            ui._setScreencastInProgress(active);
        else
            ui._screencastInProgress = active;
    }

    _shouldIgnorePauseStopFailure() {
        return this._suppressPauseStopFailure &&
            (this._recordingState === 'pausing' || this._recordingState === 'paused');
    }

    // =========================================================================
    // PAUSE / RESUME RECORDING
    // =========================================================================

    async _stopCurrentSegmentForPause() {
        if (!this._origStopScreencastAsync)
            return false;

        this._suppressPauseStopFailure = true;
        const result = await this._origStopScreencastAsync();
        return Array.isArray(result) ? Boolean(result[0]) : Boolean(result);
    }

    _finalizeCurrentSegment() {
        const segment = this._currentSegment;
        if (!segment || segment.finalized)
            return null;

        const finalPath = fixFilePath(segment.actualPath, segment.ext) ?? segment.path;
        segment.path = finalPath;
        segment.finalized = true;

        const session = this._recordingSession;
        if (session && !session.segments.some(s => s.path === finalPath))
            session.segments.push({ ...segment, path: finalPath });

        this._currentSegment = null;
        return finalPath;
    }

    async _startNextSegment() {
        const session = this._recordingSession;
        if (!session?.starter || !session.config)
            throw new Error('No recording session to resume');

        const index = session.nextIndex++;
        const filePath = buildBigShotSegmentPath(session.id, index);
        GLib.mkdir_with_parents(getSegmentSessionFolder(session.id), 0o755);

<<<<<<< Updated upstream
        let pipelineOptions = { ...session.baseOptions };
        if (!session.config.native) {
=======
        const pipelineOptions = { ...session.baseOptions };
        if (!session.defaultPipeline) {
>>>>>>> Stashed changes
            const pipeline = this._makePipelineString(
                session.config,
                session.framerateCaps,
                session.downsize,
                session.quality,
                session.captureSize,
            );
<<<<<<< Updated upstream
            pipelineOptions = {
                ...pipelineOptions,
                pipeline: new GLib.Variant('s', pipeline),
            };
=======
            pipelineOptions.pipeline = new GLib.Variant('s', pipeline);
>>>>>>> Stashed changes
        }

        const startedAtUnix = GLib.DateTime.new_now_local().to_unix();
        let result;

        try {
            result = await session.starter(filePath, pipelineOptions);
            if (result && result[0] === false)
                throw new Error('Screencast service returned failure');
        } catch (e) {
            if (!this._isStartupTimeout(e))
                throw e;

            const activePath = findRecentSegmentFile(session.id, index, session.ext, startedAtUnix);
            if (!activePath)
                throw e;

            console.warn(`[Big Shot] Resume segment ${index} timed out after output began; keeping recording attached`);
            result = [true, activePath];
        }

        const actualPath = result?.[1] ?? filePath;
        const correctExt = `.${session.ext}`;
        const correctedPath = typeof actualPath === 'string' && !actualPath.endsWith(correctExt)
            ? actualPath.replace(/\.[^.]+$/, correctExt)
            : actualPath;

        this._currentSegment = {
            index,
            actualPath,
            path: correctedPath,
            ext: session.ext,
            finalized: false,
        };
        this._currentSegmentPath = correctedPath;

        const ui = this._screenshotUI ?? Main.screenshotUI;
        if (ui)
            ui._screencastPath = session.finalPath;
        this._setScreencastInProgress(true);
    }

    async pauseRecording() {
        if (this._recordingState !== 'recording')
            return false;
        if (!this._recordingSession || !this._currentSegment) {
            console.warn('[Big Shot] Pause unavailable without active segment');
            return false;
        }

        this._recordingState = 'pausing';
        this._indicator?.onPaused();

        try {
            if (!await this._stopCurrentSegmentForPause())
                throw new Error('StopScreencast returned false');

            this._finalizeCurrentSegment();
            this._recordingState = 'paused';
            this._setScreencastInProgress(true);
            return true;
        } catch (e) {
            console.error(`[Big Shot] Failed to pause recording: ${e.message}`);
            this._recordingState = 'recording';
            this._suppressPauseStopFailure = false;
            this._setScreencastInProgress(true);
            this._indicator?.onResumed();
            return false;
        }
    }

    async resumeRecording() {
        if (this._recordingState === 'resuming')
            return true;
        if (this._recordingState !== 'paused')
            return false;

        this._recordingState = 'resuming';
        this._indicator?.onResuming?.();

        try {
            await this._startNextSegment();
            this._recordingState = 'recording';
            this._indicator?.onResumed();
            return true;
        } catch (e) {
            console.error(`[Big Shot] Failed to resume recording: ${e.message}`);
            this._recordingState = 'paused';
            this._indicator?.onPaused();
            return false;
        }
    }

    /**
     * Toggle pause/resume — called by the indicator panel button.
     */
    async togglePauseRecording() {
        if (this._recordingState === 'recording') {
            if (await this.pauseRecording())
                this._videoAnnotation?.enterPausedEditFromPause();
        } else if (this._recordingState === 'paused') {
            this._videoAnnotation?.finishPausedEditFromPause();
            await this.resumeRecording();
        }
    }

    /**
     * Watch for the final stop (user-initiated).
     */
    _watchForFinalStop() {
        if (this._stopWatcherId) {
            GLib.source_remove(this._stopWatcherId);
            this._stopWatcherId = 0;
        }

        this._stopWatcherId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            if (this._recordingState === 'pausing' ||
                this._recordingState === 'paused' ||
                this._recordingState === 'resuming')
                return GLib.SOURCE_CONTINUE;

            if (this._screenshotUI?._screencastInProgress)
                return GLib.SOURCE_CONTINUE;

            this._stopWatcherId = 0;
            this._onFinalStop();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Handle the final recording stop — clean up indicator.
     */
    _onFinalStop() {
        if (this._recordingState === 'idle') return;

        this._finalizeCurrentSegment();
        const session = this._recordingSession;

        this._recordingState = 'idle';
        this._videoAnnotation?.onRecordingStopped();
        this._indicator?.onRecordingStopped();
        this._webcam?.stopPreview();
        this._recordingContext = null;
        this._recordingSession = null;
        this._currentSegment = null;

        if (session?.segments?.length > 1)
            this._mergeSegments(session);
    }

    _finishPausedRecording() {
        if (this._recordingState !== 'paused')
            return false;

        this._prepareRecordingStop();
        this._setScreencastInProgress(false);
        this._onFinalStop();
        return true;
    }

    _mergeSegments(session) {
        const finalPath = session.finalPath;
        const tmpPath = `${finalPath}.merge-${session.id}.${session.ext}`;
        const listPath = GLib.build_filenamev([
            getRecordingFolder(),
            `${session.id}.concat.txt`,
        ]);

        try {
            const list = session.segments
                .map(segment => `file '${escapeFfmpegConcatPath(segment.path)}'`)
                .join('\n') + '\n';
            Gio.File.new_for_path(listPath).replace_contents(
                new TextEncoder().encode(list),
                null,
                false,
                Gio.FileCreateFlags.NONE,
                null,
            );

            const proc = Gio.Subprocess.new([
                'ffmpeg',
                '-hide_banner',
                '-loglevel', 'warning',
                '-y',
                '-f', 'concat',
                '-safe', '0',
                '-i', listPath,
                '-c', 'copy',
                tmpPath,
            ], Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);

            proc.wait_async(null, (subprocess, result) => {
                try {
                    subprocess.wait_finish(result);
                    if (!subprocess.get_successful())
                        throw new Error('ffmpeg concat failed');

                    const tmpFile = Gio.File.new_for_path(tmpPath);
                    tmpFile.move(
                        Gio.File.new_for_path(finalPath),
                        Gio.FileCopyFlags.OVERWRITE,
                        null,
                        null,
                    );
                    this._cleanupMergedSegments(session, listPath, tmpPath);
                } catch (e) {
                    console.error(`[Big Shot] Failed to merge recording segments: ${e.message}`);
                    deletePathIfExists(tmpPath);
                    deletePathIfExists(listPath);
                }
            });
        } catch (e) {
            console.error(`[Big Shot] Failed to start segment merge: ${e.message}`);
            deletePathIfExists(tmpPath);
            deletePathIfExists(listPath);
        }
    }

    _cleanupMergedSegments(session, listPath, tmpPath) {
        deletePathIfExists(listPath);
        deletePathIfExists(tmpPath);

        for (const segment of session.segments) {
            if (segment.path !== session.finalPath)
                deletePathIfExists(segment.path);
            if (segment.actualPath !== segment.path)
                deletePathIfExists(segment.actualPath);
        }

        const sessionDir = GLib.build_filenamev([
            getRecordingFolder(),
            BIGSHOT_SEGMENT_FOLDER,
            session.id,
        ]);
        deletePathIfExists(sessionDir);
    }

    /**
     * Schedule file rename after recording stops.
     * GNOME creates the file with .undefined extension when using custom
     * pipelines. We poll until recording ends and the file exists, then rename.
     */
    _scheduleFileRename(filePath, ext) {
        if (!filePath || !ext) return;
        if (this._renameTimerId) {
            GLib.source_remove(this._renameTimerId);
            this._renameTimerId = 0;
        }
        this._pendingRename = { filePath, ext };
        // Poll every 500ms: check if recording stopped and file exists
        this._renameTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            const screenshotUI = this._screenshotUI;
            // Still recording — keep waiting
            if (screenshotUI?._screencastInProgress)
                return GLib.SOURCE_CONTINUE;

            // Recording stopped — try to rename the file
            this._renameTimerId = 0;
            const pending = this._pendingRename;
            if (pending) {
                this._pendingRename = null;
                // Small delay to ensure file is fully written
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                    fixFilePath(pending.filePath, pending.ext);
                    return GLib.SOURCE_REMOVE;
                });
            }
            return GLib.SOURCE_REMOVE;
        });
    }

<<<<<<< Updated upstream
    _selectAudioPipeline(ext) {
        const type = ext === 'mp4' ? 'aac' : 'vorbis';
        return AUDIO_PIPELINES[type]
            .find(choice => this._availableElements?.has(choice.element))
            ?.pipeline ?? null;
    }

    _makePipelineString(
        config, framerateCaps, downsize, quality = 'high', captureSize = null,
    ) {
=======
    _makePipelineString(config, framerateCaps, downsize, quality = 'high', captureSize = null) {
>>>>>>> Stashed changes
        let video = config.src.replace('FRAMERATE_CAPS', framerateCaps);

        // Resolve quality preset and build encoder string
        const preset = QUALITY_PRESETS[quality] ?? QUALITY_PRESETS.high;
        video += ` ! ${config.enc(preset)}`;

        // Downsize — insert videoscale between videoconvert and encoder
        if (downsize < 1.0) {
<<<<<<< Updated upstream
            let sourceWidth = captureSize?.width;
            let sourceHeight = captureSize?.height;
            if (!sourceWidth || !sourceHeight) {
                const monitor = global.display.get_current_monitor();
                const geo = global.display.get_monitor_geometry(monitor);
                sourceWidth = geo.width;
                sourceHeight = geo.height;
            }
            const targetW = Math.max(2, Math.round(sourceWidth * downsize)) & ~1;
            const targetH = Math.max(2, Math.round(sourceHeight * downsize)) & ~1;
            // Insert videoscale after the first "queue" in the video chain
            video = video.replace(
                /queue/,
                `queue ! videoscale ! video/x-raw,width=${targetW},height=${targetH}`,
=======
            const sourceSize = captureSize ?? (() => {
                const monitor = global.display.get_current_monitor();
                const geo = global.display.get_monitor_geometry(monitor);
                return { width: geo.width, height: geo.height };
            })();
            const target = computeScaledDimensions(
                sourceSize.width,
                sourceSize.height,
                downsize,
>>>>>>> Stashed changes
            );
            if (target) {
                // Even output dimensions are required by common H.264/H.265 encoders.
                video = video.replace(
                    /queue/,
                    `queue ! videoscale ! video/x-raw,width=${target.width},height=${target.height}`,
                );
            }
        }

        const audioInput = this._audio?.makeAudioInput();
        const ext = config.ext;
        const muxer = MUXERS[ext];


        if (audioInput) {
            // GStreamer multi-branch pipeline for audio+video:
            //   pipewiresrc ! video_chain ! queue ! mux.  pulsesrc ! audio_chain ! queue ! mux.  muxer name=mux ! filesink
            // The screencast service prepends pipewiresrc and appends ! filesink
            const audioPipeline = this._selectAudioPipeline(ext);
            if (!audioPipeline) {
                console.warn(`[Big Shot] No ${ext === 'mp4' ? 'AAC' : 'Vorbis'} encoder; recording without audio`);
                return `${video} ! ${muxer}`;
            }
            const videoSeg = `${video} ! queue ! mux.`;
            const audioSeg = `${audioInput} ! ${audioPipeline} ! mux.`;
            const muxDef = `${muxer} name=mux`;
            return `${videoSeg} ${audioSeg} ${muxDef}`;
        }

        return `${video} ! ${muxer}`;
    }
}
