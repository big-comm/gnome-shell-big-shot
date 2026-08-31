/**
 * Big Shot — Enhanced Screenshot & Screencast for GNOME Shell
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

// Top-level imports are intentionally minimal. Anything imported here runs
// synchronously inside GNOME's serial extension load loop and delays every
// other extension's enable() — including Dash to Dock, which in turn lets
// the vanilla GNOME dash flash on cold-boot login. Heavy modules (Gio,
// Shell, St, Cogl, GdkPixbuf, cairo, MessageTray, all parts/*) are loaded lazily
// after enable() and startup completion, so module evaluation has no lifecycle
// side effects.
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

let Gio = null;
let Shell = null;
let St = null;
let Cogl = null;
let GdkPixbuf = null;
let cairo = null;
let MessageTray = null;
let PartToolbar = null;
let clearToolbarFontCache = null;
let PartAnnotation = null;
let PartMagnifier = null;
let PartAudio = null;
let PartFramerate = null;
let PartDownsize = null;
let PartIndicator = null;
let PartWebcam = null;
let PartVideoAnnotation = null;
let computeScaledDimensions = null;
let recordingExtension = null;
let shellMajor = 0;

/**
 * Load every heavy dependency on first use.
 *
 * Order matters for cold-boot perf:
 *   1. Module evaluation finishes immediately (only 3 cheap imports above).
 *   2. GNOME's serial loader moves on to the next extension without delay.
 *   3. Dash to Dock's enable() runs and hides the vanilla dash before the
 *      compositor has a chance to paint a frame with it visible.
 *   4. The enabled extension pulls in the heavy modules in parallel after
 *      `startup-complete` — `import()` yields between modules so the main loop
 *      stays responsive.
 *
 * Methods that use these references must `await loadHeavyDeps()` first.
 */
let heavyDepsPromise = null;

function loadHeavyDeps() {
    if (!heavyDepsPromise) {
        heavyDepsPromise = (async () => {
            const [
                gioMod, shellMod, stMod, coglMod, pixbufMod, cairoMod,
                msgTrayMod, configMod,
                toolbarMod, annotationMod, magnifierMod, audioMod, framerateMod,
                downsizeMod, indicatorMod, webcamMod, videoAnnotationMod,
                coreMod,
            ] = await Promise.all([
                import('gi://Gio'),
                import('gi://Shell'),
                import('gi://St'),
                import('gi://Cogl'),
                import('gi://GdkPixbuf'),
                import('gi://cairo'),
                import('resource:///org/gnome/shell/ui/messageTray.js'),
                import('resource:///org/gnome/shell/misc/config.js'),
                import('./parts/parttoolbar.js'),
                import('./parts/partannotation.js'),
                import('./parts/partmagnifier.js'),
                import('./parts/partaudio.js'),
                import('./parts/partframerate.js'),
                import('./parts/partdownsize.js'),
                import('./parts/partindicator.js'),
                import('./parts/partwebcam.js'),
                import('./parts/partvideoannotation.js'),
                import('./lib/core.js'),
            ]);

            Gio = gioMod.default;
            Shell = shellMod.default;
            St = stMod.default;
            Cogl = coglMod.default;
            GdkPixbuf = pixbufMod.default;
            cairo = cairoMod.default;
            MessageTray = msgTrayMod;
            PartToolbar = toolbarMod.PartToolbar;
            clearToolbarFontCache = toolbarMod.clearFontCache;
            PartAnnotation = annotationMod.PartAnnotation;
            PartMagnifier = magnifierMod.PartMagnifier;
            PartAudio = audioMod.PartAudio;
            PartFramerate = framerateMod.PartFramerate;
            PartDownsize = downsizeMod.PartDownsize;
            PartIndicator = indicatorMod.PartIndicator;
            PartWebcam = webcamMod.PartWebcam;
            PartVideoAnnotation = videoAnnotationMod.PartVideoAnnotation;
            computeScaledDimensions = coreMod.computeScaledDimensions;
            recordingExtension = coreMod.recordingExtension;
            shellMajor = coreMod.shellMajorVersion(configMod.PACKAGE_VERSION);
        })();
    }

    return heavyDepsPromise;
}

// =============================================================================
// GPU DETECTION (following big-video-converter pattern)
// =============================================================================

/**
 * The only two console entry points in this file.
 *
 * Every failure path routes through these so the log surface stays auditable
 * and reviewers can see at a glance that nothing logs on success. The `[Big
 * Shot]` prefix is applied here instead of at each call site.
 */
function warn(message) {
    console.warn(`[Big Shot] ${message}`);
}

function fail(message) {
    console.error(`[Big Shot] ${message}`);
}

/** GPU vendor enum */
const GpuVendor = Object.freeze({
    NVIDIA: 'nvidia',
    AMD: 'amd',
    INTEL: 'intel',
    UNKNOWN: 'unknown',
});

// =============================================================================
// GSTREAMER PIPELINE CONFIGURATIONS
// =============================================================================

/**
 * Quality presets, named after the big-video-converter scale.
 * QP/CQ values follow the same convention: lower = better image, bigger file.
 *
 * `medium` is the default and carries the values that used to be called
 * `high`, so recordings keep the quality users already had while the scale
 * gains headroom in both directions.
 */
const DEFAULT_QUALITY = 'medium';

const QUALITY_PRESETS = Object.freeze({
    veryhigh: {
        qp: 15, qp_i: 15, qp_p: 17, qp_b: 19,
        hevc_qp: 19, hevc_qp_i: 19, hevc_qp_p: 21, hevc_qp_b: 23,
        openh264_br: 12000000, vp9_cq: 18, vp9_minq: 6, vp9_maxq: 40,
    },
    high: {
        qp: 18, qp_i: 18, qp_p: 20, qp_b: 22,
        hevc_qp: 22, hevc_qp_i: 22, hevc_qp_p: 24, hevc_qp_b: 26,
        openh264_br: 9000000, vp9_cq: 21, vp9_minq: 8, vp9_maxq: 45,
    },
    medium: {
        qp: 21, qp_i: 21, qp_p: 23, qp_b: 25,
        hevc_qp: 25, hevc_qp_i: 25, hevc_qp_p: 27, hevc_qp_b: 29,
        openh264_br: 6000000, vp9_cq: 24, vp9_minq: 10, vp9_maxq: 50,
    },
    low: {
        qp: 25, qp_i: 25, qp_p: 27, qp_b: 29,
        hevc_qp: 29, hevc_qp_i: 29, hevc_qp_p: 31, hevc_qp_b: 33,
        openh264_br: 3500000, vp9_cq: 28, vp9_minq: 15, vp9_maxq: 55,
    },
    verylow: {
        qp: 29, qp_i: 29, qp_p: 31, qp_b: 33,
        hevc_qp: 33, hevc_qp_i: 33, hevc_qp_p: 35, hevc_qp_b: 37,
        openh264_br: 2000000, vp9_cq: 31, vp9_minq: 20, vp9_maxq: 58,
    },
    superlow: {
        qp: 33, qp_i: 33, qp_p: 35, qp_b: 37,
        hevc_qp: 37, hevc_qp_i: 37, hevc_qp_p: 39, hevc_qp_b: 41,
        openh264_br: 1000000, vp9_cq: 35, vp9_minq: 25, vp9_maxq: 62,
    },
});

/**
 * Pipeline configs grouped by GPU vendor.
 * Each config has:
 *   label    — Human-readable name
 *   src      — Input conversion chain; scaling and frame-rate caps
 *              are inserted before its queue at runtime
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
const SUBPROCESS_PROBE_CONCURRENCY = 4;

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

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
        warn(`Could not scan recording folder: ${e.message}`);
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
        warn(`Could not create recording folder: ${e.message}`);
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
            fail(`Failed to rename file: ${e.message}`);
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
        warn(`Could not delete ${path}: ${e.message}`);
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
        this._sourceIds = new Set();
        this._pendingDelays = new Map();
        this._subprocesses = new Set();
        this._tempDir = null;
        this._tempSerial = 0;
        this._deferredReadySerial = 0;
        this._startupCompleteId = 0;
        this._enableDeferredId = 0;
        this._parts = [];
        this._availableConfigs = null; // null = not yet detected (lazy)
        this._availableElements = new Set();
        this._pipelineDetectionPromise = null;
        this._pipelineDetectionGeneration = (this._pipelineDetectionGeneration ?? 0) + 1;
        this._currentConfigIndex = 0;

        // Pause/resume recording state
        this._recordingState = 'idle'; // 'idle' | 'starting' | 'recording' | 'pausing' | 'paused' | 'resuming'
        this._recordingContext = null;
        this._recordingSession = null;
        this._currentSegment = null;
        this._suppressPauseStopFailure = false;
        this._stopWatcherId = 0;
        this._stopCompletions = new Set();
        this._renameTimerId = 0;
        this._renameFinalizeId = 0;
        this._origScreencastProxyTimeout = null;
        this._notificationSource = null;
        this._notificationSourceDestroyId = 0;
        this._portalRequests = new Set();
        this._portalRequestSerial = 0;

        const screenshotUI = Main.screenshotUI;
        if (!screenshotUI) {
            fail('ScreenshotUI not found');
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
        if (Main.layoutManager._startingUp) {
            this._startupCompleteId = Main.layoutManager.connect(
                'startup-complete', () => {
                    this._disconnectStartupComplete();
                    if (this._activeEnableSerial === enableSerial)
                        this._queueDeferredEnable(enableSerial);
                });
            return;
        }

        this._queueDeferredEnable(enableSerial);
    }

    _queueDeferredEnable(enableSerial) {
        // Keeping enable() synchronous lets later extensions initialize before
        // Big Shot builds its UI and patches the screenshot implementation.
        this._enableDeferredId = this._addIdle(() => {
            this._enableDeferredId = 0;
            this._runDeferredEnable(enableSerial);
            return GLib.SOURCE_REMOVE;
        }, GLib.PRIORITY_LOW);
    }

    _disconnectStartupComplete() {
        if (!this._startupCompleteId)
            return;

        Main.layoutManager.disconnect(this._startupCompleteId);
        this._startupCompleteId = 0;
    }

    async _runDeferredEnable(enableSerial) {
        try {
            await loadHeavyDeps();
        } catch (e) {
            fail(`Failed to load deps: ${e.message}\n${e.stack}`);
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

        // Warm the codec cache without blocking the Shell main loop. If the
        // user starts recording immediately, that call awaits the same promise.
        this._detectPipelines().catch(e => {
            if (this._activeEnableSerial === enableSerial)
                warn(`Pipeline detection failed: ${e.message}`);
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
            fail(`step "${label}" failed: ${e.message}\n${e.stack}`);
        }
    }

    _addIdle(callback, priority = GLib.PRIORITY_DEFAULT) {
        if (!this._sourceIds)
            return 0;

        let id = 0;
        id = GLib.idle_add(priority, () => {
            let result = GLib.SOURCE_REMOVE;
            try {
                result = callback();
                return result;
            } finally {
                if (result === GLib.SOURCE_REMOVE)
                    this._sourceIds?.delete(id);
            }
        });
        this._sourceIds.add(id);
        return id;
    }

    _addTimeout(interval, callback, priority = GLib.PRIORITY_DEFAULT) {
        if (!this._sourceIds)
            return 0;

        let id = 0;
        id = GLib.timeout_add(priority, interval, () => {
            let result = GLib.SOURCE_REMOVE;
            try {
                result = callback();
                return result;
            } finally {
                if (result === GLib.SOURCE_REMOVE)
                    this._sourceIds?.delete(id);
            }
        });
        this._sourceIds.add(id);
        return id;
    }

    _removeSource(id) {
        if (!id || !this._sourceIds?.delete(id))
            return;
        GLib.source_remove(id);
    }

    _clearSources() {
        if (!this._sourceIds)
            return;
        for (const id of this._sourceIds)
            GLib.source_remove(id);
        this._sourceIds.clear();
    }

    _wait(interval) {
        if (!this._sourceIds)
            return Promise.resolve(false);

        return new Promise(resolve => {
            let id = 0;
            id = this._addTimeout(interval, () => {
                this._pendingDelays?.delete(id);
                resolve(true);
                return GLib.SOURCE_REMOVE;
            });
            this._pendingDelays.set(id, resolve);
        });
    }

    _cancelPendingDelays() {
        if (!this._pendingDelays)
            return;
        for (const [id, resolve] of this._pendingDelays) {
            this._removeSource(id);
            resolve(false);
        }
        this._pendingDelays.clear();
    }

    async _runSubprocess(argv, flags) {
        const registry = this._subprocesses;
        if (!registry)
            return { cancelled: true, successful: false, stdout: '', stderr: '' };

        const task = {
            cancelled: false,
            proc: Gio.Subprocess.new(argv, flags),
        };
        registry.add(task);

        try {
            // GJS resolves the promisified call to [stdout, stderr]; the
            // gboolean return value is dropped because failures reject the
            // promise instead. Older bindings prepended that boolean, so pick
            // the strings by shape rather than by a fixed position — reading
            // the wrong slot silently yields empty output, not an error.
            const reply = await task.proc.communicate_utf8_async(null, null);
            const [stdout, stderr] = typeof reply[0] === 'boolean'
                ? [reply[1], reply[2]]
                : [reply[0], reply[1]];
            return {
                cancelled: task.cancelled,
                successful: !task.cancelled && task.proc.get_successful(),
                stdout: stdout ?? '',
                stderr: stderr ?? '',
            };
        } catch (e) {
            if (task.cancelled)
                return { cancelled: true, successful: false, stdout: '', stderr: '' };
            throw e;
        } finally {
            registry.delete(task);
        }
    }

    _cancelSubprocesses() {
        for (const task of this._subprocesses ?? []) {
            task.cancelled = true;
            try { task.proc.force_exit(); } catch { /* */ }
        }
        this._subprocesses?.clear();
    }

    _getTempPath(stem, extension = 'png') {
        if (!this._tempDir)
            this._tempDir = GLib.dir_make_tmp('big-shot-XXXXXX');
        const name = `${stem}-${++this._tempSerial}.${extension}`;
        return GLib.build_filenamev([this._tempDir, name]);
    }

    _cleanupTempDir() {
        const path = this._tempDir;
        this._tempDir = null;
        if (!path)
            return;

        const dir = Gio.File.new_for_path(path);
        let enumerator = null;
        try {
            enumerator = dir.enumerate_children(
                'standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info = null;
            while ((info = enumerator.next_file(null)) !== null) {
                try { dir.get_child(info.get_name()).delete(null); } catch { /* */ }
            }
        } catch { /* */ } finally {
            try { enumerator?.close(null); } catch { /* */ }
        }

        try { dir.delete(null); } catch (e) {
            warn(`Could not remove temporary directory: ${e.message}`);
        }
    }

    disable() {
        this._pipelineDetectionGeneration++;
        this._pipelineDetectionPromise = null;
        this._activeEnableSerial = 0;
        this._deferredReadySerial = 0;
        this._disconnectStartupComplete();
        this._cancelPortalRequests();
        this._cancelSubprocesses();
        this._cleanupTempDir();
        // Cancel deferred enable if it hasn't fired yet (extension disabled
        // before the idle callback ran). Without this, the parts/patches would
        // be created against a screenshotUI we no longer track. The async
        // path inside _runDeferredEnable also bails out if _screenshotUI was
        // cleared, so racing disable() against the dependency imports is
        // safe.
        this._cancelPendingDelays();
        this._clearSources();
        this._sourceIds = null;
        this._pendingDelays = null;
        this._subprocesses = null;
        this._enableDeferredId = 0;
        this._portalRequests = null;

        // Clean up pause/resume state
        this._recordingState = 'idle';
        this._recordingContext = null;
        this._recordingSession = null;
        this._currentSegment = null;
        this._suppressPauseStopFailure = false;
        this._stopWatcherId = 0;
        this._stopCompletions.clear();

        // Clean up webcam UI visibility listener
        if (this._webcamUIVisId) {
            try { this._screenshotUI?.disconnect(this._webcamUIVisId); } catch (_e) { /* */ }
            this._webcamUIVisId = 0;
        }

        // Clean up pending rename timer
        this._renameTimerId = 0;
        this._renameFinalizeId = 0;
        this._pendingRename = null;
        this._pipelineDetectionPromise = null;

        if (this._notificationSourceDestroyId) {
            try {
                this._notificationSource?.disconnect(
                    this._notificationSourceDestroyId);
            } catch (_e) { /* source already gone */ }
            this._notificationSourceDestroyId = 0;
        }
        this._notificationSource?.destroy();
        this._notificationSource = null;

        // Destroy all parts
        for (const part of this._parts) {
            try {
                part.destroy();
            } catch (e) {
                fail(`Error destroying part: ${e.message}`);
            }
        }
        this._parts = [];
        this._toolbar = null;
        clearToolbarFontCache?.();
        this._annotation = null;
        this._videoAnnotation = null;
        this._magnifier = null;
        this._audio = null;
        this._framerate = null;
        this._downsize = null;
        this._indicator = null;
        this._webcam = null;

        // Revert monkey-patches — each isolated so one failure doesn't
        // leave the others in a half-patched state.
        this._safeStep('unpatchScreencast', () => this._unpatchScreencast());
        this._safeStep('revertForceScreencast', () => this._revertForceScreencast());
        this._safeStep('unpatchSaveScreenshot', () => this._unpatchSaveScreenshot());

        this._screenshotUI = null;
        this._availableConfigs = null;
        this._availableElements?.clear();
        this._availableElements = null;
        this._gpuVendors = null;
        this._currentSegmentPath = null;
        this._currentConfigIndex = 0;
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
            const enableSerial = ext._activeEnableSerial;
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

            if (ext._activeEnableSerial !== enableSerial)
                return;

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
            const tmpBase = ext._getTempPath('base');
            const tmpAnnotated = ext._getTempPath('annotated');

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
                            fail(`drawReal failed for ${action.constructor.name}: ${err.message}\n${err.stack}`);
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
                if (ext._activeEnableSerial !== enableSerial)
                    return;
                fail(`Annotation compositing failed: ${e.message}`);
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
    _storeScreenshotBytes(bytes, pixbuf) {
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

        this._showScreenshotNotification(pixbuf, time, file, disableSaveToDisk);

        return file;
    }

    _getNotificationSource() {
        if (this._notificationSource)
            return this._notificationSource;

        const source = new MessageTray.Source({
            title: _('Screen Capture'),
            iconName: 'screenshooter-symbolic',
        });
        // Tracked so disable() can drop the handler before destroying the
        // source; an unowned signal outliving enable() is a leak.
        this._notificationSourceDestroyId = source.connect('destroy', () => {
            this._notificationSourceDestroyId = 0;
            if (this._notificationSource === source)
                this._notificationSource = null;
        });
        Main.messageTray.add(source);
        this._notificationSource = source;
        return source;
    }

    _showScreenshotNotification(pixbuf, time, file, disableSaveToDisk) {
        try {
            // Cogl must not read RGB rows as RGBA. That can overrun the
            // pixbuf buffer and crash GNOME Shell in native memcpy code.
            const iconPixbuf = pixbuf.get_has_alpha()
                ? pixbuf
                : pixbuf.add_alpha(false, 0, 0, 0);
            if (!iconPixbuf)
                throw new Error('Failed to convert notification image to RGBA');
            const content = St.ImageContent.new_with_preferred_size(
                iconPixbuf.width, iconPixbuf.height);
            // GNOME 48 detached StImageContent from ClutterImage and added a
            // leading CoglContext to set_bytes(). GNOME 46/47 inherit
            // ClutterImage.set_bytes(), which takes no context, and 46 has no
            // ClutterActor:context property to read one from. Same method
            // name, different arity, so only the version tells them apart.
            if (shellMajor >= 48) {
                content.set_bytes(
                    global.stage.context.get_backend().get_cogl_context(),
                    iconPixbuf.read_pixel_bytes(),
                    Cogl.PixelFormat.RGBA_8888,
                    iconPixbuf.width,
                    iconPixbuf.height,
                    iconPixbuf.rowstride,
                );
            } else {
                content.set_bytes(
                    iconPixbuf.read_pixel_bytes(),
                    Cogl.PixelFormat.RGBA_8888,
                    iconPixbuf.width,
                    iconPixbuf.height,
                    iconPixbuf.rowstride,
                );
            }

            const source = this._getNotificationSource();
            const notification = new MessageTray.Notification({
                source,
                title: _('Screenshot captured'),
                body: _('You can paste the image from the clipboard'),
                datetime: time,
                gicon: content,
                isTransient: true,
            });

            if (!disableSaveToDisk && file) {
                notification.addAction(_('Show in Files'), () => {
                    const app = Gio.app_info_get_default_for_type(
                        'inode/directory', false);
                    if (!app) {
                        warn('No file manager handles directories');
                        return;
                    }
                    app.launch([file], global.create_app_launch_context(0, -1));
                });
                notification.connect('activated', () => {
                    try {
                        Gio.app_info_launch_default_for_uri(
                            file.get_uri(), global.create_app_launch_context(0, -1));
                    } catch (e) {
                        fail(`Could not open screenshot: ${e.message}`);
                    }
                    Main.overview.hide();
                    Main.panel.closeCalendar();
                });
            }
            source.addNotification(notification);
        } catch (e) {
            warn(`Screenshot notification failed: ${e.message}`);
            this._showNotification(
                _('Screenshot captured'),
                _('You can paste the image from the clipboard'));
        }
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
        const enableSerial = this._activeEnableSerial;
        const ui = this._screenshotUI;
        if (!ui)
            return null;
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

        if (this._activeEnableSerial !== enableSerial)
            return null;

        if (!pixbuf) return null;

        if (actions.length === 0) {
            const bytes = stream.steal_as_bytes();
            return { bytes, pixbuf };
        }

        const offsetX = gx / bufScale;
        const offsetY = gy / bufScale;
        const tmpBase = this._getTempPath('base');
        const tmpAnnotated = this._getTempPath('annotated');

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
                        fail(`drawReal failed: ${err.message}`);
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
        return GLib.find_program_in_path('tesseract') !== null;
    }

    /**
     * Get list of installed Tesseract language packs.
     * @returns {Promise<string[]>} e.g. ['eng', 'por', 'spa']
     */
    async _getTesseractLanguages() {
        try {
            const tesseract = GLib.find_program_in_path('tesseract');
            if (!tesseract)
                return this._getInstalledTessdataLanguages();
            const result = await this._runSubprocess(
                [tesseract, '--list-langs'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            );
            if (result.cancelled)
                return [];
            // Tesseract outputs to stderr on some versions, stdout on others
            const output = result.stdout + result.stderr;
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

    async _refreshOcrLanguages() {
        const enableSerial = this._activeEnableSerial;
        if (!await this._checkTesseractAvailable()) {
            if (this._activeEnableSerial === enableSerial)
                this._toolbar?.setOcrLanguages([]);
            return [];
        }

        const languages = (await this._getTesseractLanguages())
            .filter(language => language !== 'osd');
        if (this._activeEnableSerial === enableSerial)
            this._toolbar?.setOcrLanguages(languages);
        return languages;
    }

    _showOcrMessage(message) {
        if (this._screenshotUI?.visible)
            this._toolbar?.showInlineMessage(message);
        else
            this._showNotification('OCR', message);
    }

    async _ensureOcrSupport() {
        const enableSerial = this._activeEnableSerial;
        const languages = await this._refreshOcrLanguages();
        if (this._activeEnableSerial !== enableSerial)
            return false;
        const selectedLanguages = this._toolbar?.ocrLanguage?.split('+') ?? [];
        if (languages.length > 0 &&
            selectedLanguages.every(language => languages.includes(language)))
            return true;

        this._toolbar?.showInlineMessage(
            _('Automatic installation is unavailable. Install Tesseract and its language packs with your package manager.'));
        return false;
    }

    /**
     * Run Tesseract OCR on an image file asynchronously.
     * @param {string} imagePath - Path to PNG file
     * @param {string} lang - Tesseract language string e.g. 'por+eng'
     * @returns {Promise<{cancelled: boolean, text: string}>} extracted text
     */
    async _runOCR(imagePath, lang) {
        const tesseract = GLib.find_program_in_path('tesseract');
        if (!tesseract) {
            throw new Error(
                _('Automatic installation is unavailable. Install Tesseract and its language packs with your package manager.'));
        }

        const result = await this._runSubprocess(
            [tesseract, imagePath, 'stdout', '-l', lang],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        );
        if (result.cancelled)
            return { cancelled: true, text: '' };
        if (!result.successful)
            throw new Error(result.stderr || 'Tesseract failed');
        return { cancelled: false, text: result.stdout.trim() };
    }

    /**
     * Handle action button clicks from the toolbar.
     */
    async _handleAction(action) {
        const enableSerial = this._activeEnableSerial;
        const ui = this._screenshotUI;
        if (!ui)
            return;

        try {
            if (action === 'ocr-unavailable') {
                await this._ensureOcrSupport();
                return;
            }

            if (action === 'ocr' && !await this._ensureOcrSupport())
                return;
            if (this._activeEnableSerial !== enableSerial)
                return;

            const result = await this._captureAnnotatedBytes();
            if (this._activeEnableSerial !== enableSerial)
                return;
            if (!result) {
                fail('Failed to capture screenshot');
                return;
            }

            const { bytes } = result;

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
                const tmpPath = this._getTempPath('save-as');
                const tmpFile = Gio.File.new_for_path(tmpPath);
                const outStream = tmpFile.create(Gio.FileCreateFlags.NONE, null);
                outStream.write_bytes(bytes, null);
                outStream.close(null);

                // Also copy to clipboard
                const clipboard = St.Clipboard.get_default();
                clipboard.set_content(St.ClipboardType.CLIPBOARD, 'image/png', bytes);

                ui.close();

                // Open file chooser via xdg-desktop-portal
                this._openSaveDialog(tmpPath);
                break;
            }

            case 'ocr': {
                // Determine language
                const selectedLang = this._toolbar?.ocrLanguage;
                const lang = selectedLang || await this._getOcrDefaultLang();
                if (this._activeEnableSerial !== enableSerial)
                    return;

                // Show processing message
                this._showOcrMessage(_('Extracting text...'));

                // Save screenshot to temp file for Tesseract
                const tmpOcrPath = this._getTempPath('ocr');

                try {
                    const tmpOcrFile = Gio.File.new_for_path(tmpOcrPath);
                    const ocrStream = tmpOcrFile.create(Gio.FileCreateFlags.NONE, null);
                    ocrStream.write_bytes(bytes, null);
                    ocrStream.close(null);

                    const ocrResult = await this._runOCR(tmpOcrPath, lang);
                    if (ocrResult.cancelled || this._activeEnableSerial !== enableSerial)
                        return;
                    const { text } = ocrResult;

                    if (text && text.length > 0) {
                        // Copy extracted text to clipboard
                        const clipboard = St.Clipboard.get_default();
                        clipboard.set_text(St.ClipboardType.CLIPBOARD, text);

                        this._showOcrMessage(
                            _('Text copied to clipboard! (%d chars)').format(text.length));
                    } else {
                        this._showOcrMessage(
                            _('No text found in selection'));
                    }
                } catch (e) {
                    if (this._activeEnableSerial === enableSerial) {
                        fail(`OCR failed: ${e.message}`);
                        this._showOcrMessage(
                            _('OCR failed: %s').format(e.message));
                    }
                } finally {
                    try { Gio.File.new_for_path(tmpOcrPath).delete(null); } catch (_e) { /* */ }
                }
                break;
            }

            }
        } catch (e) {
            if (this._activeEnableSerial === enableSerial)
                fail(`Action '${action}' failed: ${e.message}\n${e.stack}`);
        }
    }

    _createPortalRequest(tmpPath) {
        const bus = Gio.DBus.session;
        const sender = (bus.get_unique_name() || 'bigshot')
            .replace(/^:/, '')
            .replace(/[^A-Za-z0-9_]/g, '_');
        const token = `bigshot_${Date.now()}_${++this._portalRequestSerial}`;
        const request = {
            bus,
            cancellable: new Gio.Cancellable(),
            done: false,
            requestPath: `/org/freedesktop/portal/desktop/request/${sender}/${token}`,
            subscriptionId: 0,
            timeoutId: 0,
            tmpPath,
            token,
        };
        this._portalRequests.add(request);
        return request;
    }

    _subscribePortalResponse(request, requestPath) {
        if (request.done)
            return;

        if (request.subscriptionId)
            request.bus.signal_unsubscribe(request.subscriptionId);
        request.requestPath = requestPath;
        request.subscriptionId = request.bus.signal_subscribe(
            'org.freedesktop.portal.Desktop',
            'org.freedesktop.portal.Request',
            'Response',
            requestPath,
            null,
            Gio.DBusSignalFlags.NO_MATCH_RULE,
            (_connection, _sender, _path, _interface, _signal, params) => {
                if (request.done)
                    return;

                const [response, results] = params.deepUnpack();
                const uriValue = results.uris;
                const uris = uriValue?.deepUnpack?.() ?? uriValue ?? [];
                if (response === 0 && uris.length > 0) {
                    const destFile = Gio.File.new_for_uri(uris[0]);
                    const srcFile = Gio.File.new_for_path(request.tmpPath);
                    try {
                        srcFile.copy(destFile, Gio.FileCopyFlags.OVERWRITE, null, null);
                    } catch (e) {
                        fail(`Save failed: ${e.message}`);
                    }
                }
                this._finishPortalRequest(request);
            },
        );
    }

    _finishPortalRequest(request, close = false) {
        if (request.done)
            return;
        request.done = true;

        if (request.subscriptionId) {
            request.bus.signal_unsubscribe(request.subscriptionId);
            request.subscriptionId = 0;
        }
        if (request.timeoutId) {
            this._removeSource(request.timeoutId);
            request.timeoutId = 0;
        }
        request.cancellable.cancel();

        if (close) {
            request.bus.call(
                'org.freedesktop.portal.Desktop',
                request.requestPath,
                'org.freedesktop.portal.Request',
                'Close',
                null,
                null,
                Gio.DBusCallFlags.NONE,
                1000,
                null,
                null,
            );
        }

        try { Gio.File.new_for_path(request.tmpPath).delete(null); } catch { /* */ }
        this._portalRequests?.delete(request);
    }

    _cancelPortalRequests() {
        for (const request of [...(this._portalRequests ?? [])])
            this._finishPortalRequest(request, true);
    }

    /**
     * Open a Save As dialog via xdg-desktop-portal FileChooser.
     */
    _openSaveDialog(tmpPath) {
        let request = null;
        try {
            const time = GLib.DateTime.new_now_local();
            const suggestedName = _('Screenshot from %s').format(
                time.format('%Y-%m-%d %H-%M-%S')) + '.png';

            if (!this._portalRequests) {
                try { Gio.File.new_for_path(tmpPath).delete(null); } catch { /* */ }
                return;
            }

            request = this._createPortalRequest(tmpPath);
            this._subscribePortalResponse(request, request.requestPath);
            request.timeoutId = this._addTimeout(300000, () => {
                request.timeoutId = 0;
                this._finishPortalRequest(request, true);
                return GLib.SOURCE_REMOVE;
            });

            const picturesDir = GLib.get_user_special_dir(
                GLib.UserDirectory.DIRECTORY_PICTURES) || GLib.get_home_dir();
            request.bus.call(
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
                            new TextEncoder().encode(`${picturesDir}\0`)),
                        'filters': new GLib.Variant('a(sa(us))', [
                            [_('PNG Images'), [
                                [0, '*.png'],
                            ]],
                        ]),
                        'handle_token': new GLib.Variant('s', request.token),
                    },
                ]),
                new GLib.VariantType('(o)'),
                Gio.DBusCallFlags.NONE,
                -1,
                request.cancellable,
                (conn, asyncResult) => {
                    let returnedPath = null;
                    try {
                        const result = conn.call_finish(asyncResult);
                        [returnedPath] = result.deepUnpack();
                    } catch (e) {
                        if (!request.done)
                            fail(`Portal SaveFile failed: ${e.message}`);
                        this._finishPortalRequest(request);
                        return;
                    }

                    if (request.done)
                        return;
                    if (returnedPath !== request.requestPath)
                        this._subscribePortalResponse(request, returnedPath);
                },
            );
        } catch (e) {
            fail(`Save dialog failed: ${e.message}`);
            if (request)
                this._finishPortalRequest(request);
            else
                try { Gio.File.new_for_path(tmpPath).delete(null); } catch { /* */ }
        }
    }

    /**
     * Show a desktop notification via GNOME Shell.
     */
    _showNotification(title, body) {
        try {
            const source = this._getNotificationSource();
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

    /**
     * PCI vendor IDs as exposed by every DRM device under sysfs.
     * Reading these needs no external tool, so it works where `lspci` is
     * missing, renamed, or shipped without the PCI ID database.
     */
    async _detectGpuVendorsFromSysfs() {
        const vendors = new Set();
        const byId = {
            '0x10de': GpuVendor.NVIDIA,
            '0x1002': GpuVendor.AMD,
            '0x1022': GpuVendor.AMD,
            '0x8086': GpuVendor.INTEL,
        };

        let enumerator = null;
        try {
            enumerator = Gio.File.new_for_path('/sys/class/drm')
                .enumerate_children('standard::name',
                    Gio.FileQueryInfoFlags.NONE, null);
            let info = null;
            while ((info = enumerator.next_file(null)) !== null) {
                const name = info.get_name();
                // Cards only; skip the connector entries (card0-HDMI-A-1, …).
                if (!/^card\d+$/.test(name))
                    continue;
                try {
                    // Async so the compositor keeps painting. Wrapped by hand
                    // instead of Gio._promisify, which would patch Gio.File
                    // process-wide and leak into every other extension.
                    const bytes = await new Promise((resolve, reject) => {
                        Gio.File
                            .new_for_path(`/sys/class/drm/${name}/device/vendor`)
                            .load_contents_async(null, (file, result) => {
                                try {
                                    const [, contents] =
                                        file.load_contents_finish(result);
                                    resolve(contents);
                                } catch (e) {
                                    reject(e);
                                }
                            });
                    });
                    const id = new TextDecoder().decode(bytes).trim().toLowerCase();
                    if (byId[id])
                        vendors.add(byId[id]);
                } catch (_e) { /* device without a readable vendor file */ }
            }
        } catch (_e) {
            // No sysfs DRM tree; the lspci path below still applies.
        } finally {
            try { enumerator?.close(null); } catch (_e) { /* */ }
        }

        return [...vendors];
    }

    async _detectGpuVendorsFromLspci() {
        try {
            const result = await this._runSubprocess(
                ['lspci'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
            );
            if (result.cancelled || !result.stdout)
                return [];

            const vendors = [];
            const lines = result.stdout.toLowerCase();
            if (/(?:vga|display controller|3d).*nvidia/.test(lines))
                vendors.push(GpuVendor.NVIDIA);
            if (/(?:vga|display controller).*(?:\bamd\b|\bati\b)/.test(lines))
                vendors.push(GpuVendor.AMD);
            if (/(?:vga|display controller).*intel/.test(lines))
                vendors.push(GpuVendor.INTEL);
            return vendors;
        } catch {
            return [];
        }
    }

    /**
     * Identify GPU vendors so vendor-specific encoders can be offered.
     *
     * Detection is advisory, never a gate: when nothing identifies the GPU,
     * return every vendor instead of UNKNOWN. A wrong guess costs nothing
     * because each pipeline still has to pass the GStreamer element probe —
     * whereas UNKNOWN silently hides every hardware encoder, leaving the user
     * with software encoding on a machine that can do better.
     */
    async _detectGpuVendors() {
        const fromSysfs = await this._detectGpuVendorsFromSysfs();
        if (fromSysfs.length > 0)
            return fromSysfs;

        const fromLspci = await this._detectGpuVendorsFromLspci();
        if (fromLspci.length > 0)
            return fromLspci;

        warn('GPU vendor undetected; probing every encoder');
        return [GpuVendor.NVIDIA, GpuVendor.AMD, GpuVendor.INTEL];
    }

    async _checkGstreamerElement(name) {
        try {
            const result = await this._runSubprocess(
                ['gst-inspect-1.0', '--exists', name],
                Gio.SubprocessFlags.NONE,
            );
            return !result.cancelled && result.successful;
        } catch {
            return false;
        }
    }

    async _checkGstreamerElements(names, generation) {
        const checks = new Array(names.length);
        let nextIndex = 0;
        const worker = async () => {
            while (generation === this._pipelineDetectionGeneration) {
                const index = nextIndex++;
                if (index >= names.length)
                    return;
                const name = names[index];
                checks[index] = [name, await this._checkGstreamerElement(name)];
            }
        };
        const workerCount = Math.min(SUBPROCESS_PROBE_CONCURRENCY, names.length);
        await Promise.all(Array.from({ length: workerCount }, () => worker()));
        return checks.filter(Boolean);
    }

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
        const gpuVendors = await this._detectGpuVendors();
        if (generation !== this._pipelineDetectionGeneration || !this._screenshotUI)
            return [];
        const vendorSet = new Set(gpuVendors);

        const candidates = VIDEO_PIPELINES.filter(config =>
            config.vendors.length === 0 ||
            config.vendors.some(vendor => vendorSet.has(vendor)));
        const elementNames = new Set(candidates.flatMap(config => config.elements));
        elementNames.add('mp4mux');
        elementNames.add('webmmux');
        // Used by every pipeline for constant-rate output, so probe it once
        // here instead of listing it in each config.
        elementNames.add('videorate');
        for (const choices of Object.values(AUDIO_PIPELINES)) {
            for (const choice of choices)
                elementNames.add(choice.element);
        }

        const checks = await this._checkGstreamerElements([...elementNames], generation);
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
            warn('No compatible GStreamer pipeline found!');

        return this._availableConfigs;
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

        // Detect Tesseract and populate OCR languages (async — won't block UI)
        this._refreshOcrLanguages().catch(e => {
            warn(`Tesseract detection failed: ${e.message}`);
        });

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
                // enumerateDevices() reads sysfs asynchronously; the guard
                // covers the webcam being switched off while it runs.
                this._webcam.enumerateDevices().then(devices => {
                    if (this._webcam && this._toolbar?._cameraRow)
                        this._toolbar.populateCameras(devices);
                }).catch(e => {
                    warn(`Camera list unavailable: ${e.message}`);
                });
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
                    return ext._screencastCommonAsync(
                        filePath,
                        options,
                        ext._origScreencast,
                        { width: global.stage.width, height: global.stage.height },
                    );
                };
            }

            // Patch ScreencastAreaAsync
            if (this._origScreencastArea) {
                screencastProxy.ScreencastAreaAsync = function (x, y, width, height, filePath, options) {
                    return ext._screencastCommonAsync(
                        filePath,
                        options,
                        (fp, opts) => ext._origScreencastArea(x, y, width, height, fp, opts),
                        { width, height },
                    );
                };
            }

            this._origStopScreencastAsync = screencastProxy.StopScreencastAsync?.bind(screencastProxy);
            if (this._origStopScreencastAsync) {
                screencastProxy.StopScreencastAsync = function (...args) {
                    return ext._stopScreencastProxyAsync(...args);
                };
            }
        } else {
            warn('_screencastProxy not found — custom pipelines disabled');
        }

        // Single open() patch: combines QuickStop (stop recording on
        // re-open) and allow-screenshot-while-recording logic.
        // Having a single save/restore avoids stale closure chains after
        // lock-screen disable/enable cycles.
        if (typeof screenshotUI.open !== 'function') {
            warn('screenshotUI.open missing — Quick Stop disabled');
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
                        fail(`Quick stop error: ${e.message}`);
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
                try {
                    return ext._origOpen.call(this, mode);
                } finally {
                    this._screencastInProgress = saved;
                }
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
        const enableSerial = this._activeEnableSerial;
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
            warn('Window screencast: invalid bounding box');
            this._recordingState = 'idle';
            return;
        }
        const proxy = ui._screencastProxy;
        if (!proxy || typeof proxy.ScreencastAreaAsync !== 'function') {
            warn('Window screencast: proxy unavailable');
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

        // The indicator retains its previous area until explicitly updated.
        // Keep it aligned with the window rect passed to the recorder.
        ui._screencastAreaIndicator?.setSelectionRect(x, y, width, height);

        // Close the UI immediately so the fade-out doesn't get recorded.
        try { ui.close(true); } catch (_e) { /* */ }

        try {
            const [success, path] = await proxy.ScreencastAreaAsync(
                x, y, width, height, filePath, options,
            );
            if (this._activeEnableSerial !== enableSerial)
                return;
            if (success) {
                ui._screencastPath = path;
            } else {
                this._recordingState = 'idle';
                if (typeof ui._setScreencastInProgress === 'function')
                    ui._setScreencastInProgress(false);
                else
                    ui._screencastInProgress = false;
                warn('Window screencast: service returned failure');
            }
        } catch (e) {
            if (this._activeEnableSerial !== enableSerial)
                return;
            this._recordingState = 'idle';
            if (typeof ui._setScreencastInProgress === 'function')
                ui._setScreencastInProgress(false);
            else
                ui._screencastInProgress = false;
            fail(`Window screencast error: ${e.message}`);
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

    async _screencastCommonAsync(_requestedPath, options, originalMethod, captureSize = null) {
        const enableSerial = this._activeEnableSerial;
        const stopMethod = this._origStopScreencastAsync;
        // Share the background probe when it is still finishing.
        await this._detectPipelines();
        if (this._activeEnableSerial !== enableSerial)
            return [false];

        // Force every recording (full-screen and area) into ~/Videos/BigShot/
        // with the localized "BigShot from %d %t" filename. The path GNOME
        // asked for is deliberately discarded.
        const filePath = buildBigShotRecordingPath();
        ensureRecordingFolder();

        const framerate = this._framerate?.value ?? 30;
        const downsize = this._downsize?.value ?? 1.0;
        const quality = this._toolbar?.videoQuality ?? DEFAULT_QUALITY;
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
                config,
                framerateCaps,
                downsize,
                quality,
                captureSize,
            );
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
                if (this._activeEnableSerial !== enableSerial) {
                    if (result?.[0] !== false)
                        this._stopStaleScreencast(stopMethod);
                    return [false];
                }
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
                if (this._activeEnableSerial !== enableSerial) {
                    this._stopStaleScreencast(stopMethod);
                    return [false];
                }
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
                warn(`Pipeline ${config.id} failed: ${e.message}`);
                // Continue to next config
            }
        }

        // All custom pipelines exhausted — clean up indicator and fall back
        warn('All pipelines failed, falling back to GNOME default');
        return this._startDefaultRecording({
            filePath,
            options: baseOptions,
            originalMethod,
            framerateCaps,
            downsize,
            quality,
            captureSize,
            enableSerial,
            stopMethod,
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
        enableSerial,
        stopMethod,
    }) {
        if (this._activeEnableSerial !== enableSerial)
            return [false];
        this._recordingState = 'starting';
        try {
            const result = await originalMethod(filePath, options);
            if (this._activeEnableSerial !== enableSerial) {
                if (result?.[0] !== false)
                    this._stopStaleScreencast(stopMethod);
                return [false];
            }
            if (result && result[0] === false)
                throw new Error('Screencast service returned failure');

            const actualPath = result?.[1] ?? filePath;
            const config = {
                id: 'gnome-default',
                label: _('GNOME default'),
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
            });
        } catch (e) {
            if (this._activeEnableSerial !== enableSerial) {
                this._stopStaleScreencast(stopMethod);
                return [false];
            }
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
            ffmpegPath: GLib.find_program_in_path('ffmpeg'),
            baseOptions,
            framerateCaps,
            downsize,
            quality,
            captureSize,
            defaultPipeline,
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
            this._indicator?.onRecordingStarted(
                this._recordingSession.ffmpegPath !== null);
            this._videoAnnotation?.onRecordingStarted();
        } catch (indErr) {
            fail('onRecordingStarted ERROR:', indErr.message, indErr.stack);
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

        warn(`Pipeline ${config.id} start timed out after output began; keeping recording attached`);
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
        this._stopStaleScreencast(this._origStopScreencastAsync);
    }

    _stopStaleScreencast(stopMethod) {
        if (!stopMethod)
            return;

        try {
            const result = stopMethod();
            if (result?.catch)
                result.catch(e => warn(`stale screencast stop failed: ${e.message}`));
        } catch (e) {
            warn(`stale screencast stop failed: ${e.message}`);
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
                warn(`stopScreencast failed: ${e.message}`);
            }
        }

        // Legacy: GNOME ≤ 49 internal recorder
        const recorder = ui._recorder;
        if (recorder && typeof recorder.close === 'function') {
            try { recorder.close(); return; } catch (e) {
                warn(`recorder.close failed: ${e.message}`);
            }
        }

        // Last resort: ask the screencast service directly
        const proxy = ui._screencastProxy;
        if (proxy && typeof proxy.StopScreencastAsync === 'function') {
            try { proxy.StopScreencastAsync(); } catch (e) {
                warn(`StopScreencastAsync failed: ${e.message}`);
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
        return this._trackRecordingStop(
            () => this._origStopScreencastAsync(...args));
    }

    _stopScreencastUiAsync(...args) {
        if (this._recordingState === 'paused') {
            this._finishPausedRecording();
            return Promise.resolve();
        }

        this._prepareRecordingStop();
        return this._trackRecordingStop(
            () => this._origStopScreencast(...args));
    }

    _trackRecordingStop(stop) {
        const completion = {};
        this._stopCompletions.add(completion);
        let result;
        try {
            result = stop();
        } catch (e) {
            this._recordingStopCompleted(completion);
            throw e;
        }

        return Promise.resolve(result).finally(() => {
            this._recordingStopCompleted(completion);
        });
    }

    _recordingStopCompleted(completion) {
        if (!this._stopCompletions.delete(completion))
            return;
        if (this._stopCompletions.size === 0 &&
            this._recordingState !== 'idle' &&
            !this._screenshotUI?._screencastInProgress) {
            this._removeSource(this._stopWatcherId);
            this._stopWatcherId = 0;
            this._onFinalStop();
        }
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
        const enableSerial = this._activeEnableSerial;
        const stopMethod = this._origStopScreencastAsync;
        const session = this._recordingSession;
        if (!session?.starter || !session.config)
            throw new Error('No recording session to resume');

        const index = session.nextIndex++;
        const filePath = buildBigShotSegmentPath(session.id, index);
        GLib.mkdir_with_parents(getSegmentSessionFolder(session.id), 0o755);

        const pipelineOptions = { ...session.baseOptions };
        if (!session.defaultPipeline) {
            const pipeline = this._makePipelineString(
                session.config,
                session.framerateCaps,
                session.downsize,
                session.quality,
                session.captureSize,
            );
            pipelineOptions.pipeline = new GLib.Variant('s', pipeline);
        }

        const startedAtUnix = GLib.DateTime.new_now_local().to_unix();
        let result;

        try {
            result = await session.starter(filePath, pipelineOptions);
            if (this._activeEnableSerial !== enableSerial) {
                if (result?.[0] !== false)
                    this._stopStaleScreencast(stopMethod);
                return false;
            }
            if (result && result[0] === false)
                throw new Error('Screencast service returned failure');
        } catch (e) {
            if (this._activeEnableSerial !== enableSerial) {
                this._stopStaleScreencast(stopMethod);
                return false;
            }
            if (!this._isStartupTimeout(e))
                throw e;

            const activePath = findRecentSegmentFile(session.id, index, session.ext, startedAtUnix);
            if (!activePath)
                throw e;

            warn(`Resume segment ${index} timed out after output began; keeping recording attached`);
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
        return true;
    }

    async pauseRecording() {
        const enableSerial = this._activeEnableSerial;
        if (this._recordingState !== 'recording')
            return false;
        if (!this._recordingSession || !this._currentSegment) {
            warn('Pause unavailable without active segment');
            return false;
        }
        if (!this._recordingSession.ffmpegPath) {
            warn('Pause unavailable: ffmpeg not found');
            return false;
        }

        this._recordingState = 'pausing';
        this._indicator?.onPaused();

        try {
            if (!await this._stopCurrentSegmentForPause())
                throw new Error('StopScreencast returned false');
            if (this._activeEnableSerial !== enableSerial)
                return false;

            this._finalizeCurrentSegment();
            this._recordingState = 'paused';
            this._setScreencastInProgress(true);
            return true;
        } catch (e) {
            if (this._activeEnableSerial !== enableSerial)
                return false;
            fail(`Failed to pause recording: ${e.message}`);
            this._recordingState = 'recording';
            this._suppressPauseStopFailure = false;
            this._setScreencastInProgress(true);
            this._indicator?.onResumed();
            return false;
        }
    }

    async resumeRecording() {
        const enableSerial = this._activeEnableSerial;
        if (this._recordingState === 'resuming')
            return true;
        if (this._recordingState !== 'paused')
            return false;

        this._recordingState = 'resuming';
        this._indicator?.onResuming?.();

        try {
            if (!await this._startNextSegment() ||
                this._activeEnableSerial !== enableSerial)
                return false;
            this._recordingState = 'recording';
            this._indicator?.onResumed();
            return true;
        } catch (e) {
            if (this._activeEnableSerial !== enableSerial)
                return false;
            fail(`Failed to resume recording: ${e.message}`);
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
            this._removeSource(this._stopWatcherId);
            this._stopWatcherId = 0;
        }

        this._stopWatcherId = this._addTimeout(500, () => {
            if (this._recordingState === 'pausing' ||
                this._recordingState === 'paused' ||
                this._recordingState === 'resuming' ||
                this._stopCompletions.size > 0)
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

    async _mergeSegments(session) {
        const enableSerial = this._activeEnableSerial;
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

            const result = await this._runSubprocess([
                session.ffmpegPath,
                '-hide_banner',
                '-loglevel', 'warning',
                '-y',
                '-f', 'concat',
                '-safe', '0',
                '-i', listPath,
                '-c', 'copy',
                tmpPath,
            ], Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);

            if (result.cancelled || this._activeEnableSerial !== enableSerial) {
                deletePathIfExists(tmpPath);
                deletePathIfExists(listPath);
                return;
            }
            if (!result.successful)
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
            fail(`Failed to merge recording segments: ${e.message}`);
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
        if (!filePath || !ext || !this._sourceIds) return;
        if (this._renameTimerId) {
            this._removeSource(this._renameTimerId);
            this._renameTimerId = 0;
        }
        if (this._renameFinalizeId) {
            this._removeSource(this._renameFinalizeId);
            this._renameFinalizeId = 0;
        }
        this._pendingRename = { filePath, ext };
        // Poll every 500ms: check if recording stopped and file exists
        this._renameTimerId = this._addTimeout(500, () => {
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
                this._renameFinalizeId = this._addTimeout(500, () => {
                    this._renameFinalizeId = 0;
                    fixFilePath(pending.filePath, pending.ext);
                    return GLib.SOURCE_REMOVE;
                });
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _selectAudioPipeline(ext) {
        const type = ext === 'mp4' ? 'aac' : 'vorbis';
        return AUDIO_PIPELINES[type]
            .find(choice => this._availableElements?.has(choice.element))
            ?.pipeline ?? null;
    }

    _makePipelineString(
        config, framerateCaps, downsize, quality = DEFAULT_QUALITY, captureSize = null,
    ) {
        let video = config.src;

        // Resolve quality preset and build encoder string
        const preset = QUALITY_PRESETS[quality] ?? QUALITY_PRESETS[DEFAULT_QUALITY];
        video += ` ! ${config.enc(preset)}`;

        // Downsize and constant frame rate share one conversion stage, built
        // in the order GStreamer expects: scale first, then rate, then the
        // caps that pin both. Inserting them before the first queue keeps the
        // encoder fed from a single negotiated format.
        const stage = [];

        if (downsize < 1.0) {
            const sourceSize = captureSize ?? (() => {
                const monitor = global.display.get_current_monitor();
                const geo = global.display.get_monitor_geometry(monitor);
                return { width: geo.width, height: geo.height };
            })();
            const target = computeScaledDimensions(
                sourceSize.width,
                sourceSize.height,
                downsize,
            );
            if (target) {
                // Even output dimensions are required by common H.264/H.265 encoders.
                stage.push('videoscale',
                    `video/x-raw,width=${target.width},height=${target.height}`);
            }
        }

        // The screencast service only caps the rate (max-framerate=F/1) and
        // PipeWire emits a frame just when the screen changes, so a quiet
        // desktop produced a variable-rate file averaging a fraction of the
        // requested FPS. videorate repeats the last frame to fill the gaps,
        // making the recording honour the chosen rate the way players,
        // editors and the segment concatenation all assume.
        if (framerateCaps && this._availableElements?.has('videorate')) {
            stage.push('videorate skip-to-first=true',
                `video/x-raw,framerate=${framerateCaps}`);
        }

        if (stage.length > 0)
            video = video.replace('queue', `${stage.join(' ! ')} ! queue`);

        const audioInput = this._audio?.makeAudioInput();
        const ext = config.ext;
        const muxer = MUXERS[ext];


        if (audioInput) {
            // GStreamer multi-branch pipeline for audio+video:
            //   pipewiresrc ! video_chain ! queue ! mux.  pulsesrc ! audio_chain ! queue ! mux.  muxer name=mux ! filesink
            // The screencast service prepends pipewiresrc and appends ! filesink
            const audioPipeline = this._selectAudioPipeline(ext);
            if (!audioPipeline) {
                warn(`No ${ext === 'mp4' ? 'AAC' : 'Vorbis'} encoder; recording without audio`);
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
