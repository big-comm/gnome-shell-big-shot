/**
 * Big Shot — Enhanced Screenshot & Screencast for GNOME Shell
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

export const APP_VERSION = '0.5.0';

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import St from 'gi://St';
import GdkPixbuf from 'gi://GdkPixbuf';
import cairo from 'gi://cairo';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Screenshot from 'resource:///org/gnome/shell/ui/screenshot.js';

// Parts
import { PartToolbar } from './parts/parttoolbar.js';
import { PartAnnotation } from './parts/partannotation.js';

import { PartAudio } from './parts/partaudio.js';
import { PartFramerate } from './parts/partframerate.js';
import { PartDownsize } from './parts/partdownsize.js';
import { PartIndicator } from './parts/partindicator.js';
import { PartQuickStop } from './parts/partquickstop.js';
import { PartWebcam } from './parts/partwebcam.js';

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
function detectGpuVendors() {
    try {
        const proc = Gio.Subprocess.new(
            ['lspci'],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
        );
        const [, stdout] = proc.communicate_utf8(null, null);
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
 * Pipeline configs grouped by GPU vendor.
 * Each config has:
 *   label    — Human-readable name
 *   src      — Input capsfilter (FRAMERATE_CAPS replaced at runtime)
 *   enc      — Encoder chain
 *   elements — Required GStreamer elements to check
 *   ext      — Output container extension (mp4/webm)
 *   vendors  — Array of GPU vendors this config works on
 *   lowpower — Optional, use low-power VAAPI mode
 */
const VIDEO_PIPELINES = [
    // ── NVIDIA (NVENC with raw input — works with GNOME Screencast service) ──
    {
        id: 'nvidia-raw-h264-nvenc',
        label: 'NVIDIA H.264',
        vendors: [GpuVendor.NVIDIA],
        src: 'videoconvert chroma-mode=none dither=none matrix-mode=output-only n-threads=4 ! queue',
        enc: 'nvh264enc rc-mode=cbr-hq bitrate=40000 ! h264parse',
        elements: ['videoconvert', 'nvh264enc'],
        ext: 'mp4',
    },
    // ── AMD + Intel (VA — new gst-plugin-va, raw input) ──
    {
        id: 'va-raw-h264-lp',
        label: 'VA H.264 Low-Power',
        vendors: [GpuVendor.AMD, GpuVendor.INTEL],
        src: 'videoconvert chroma-mode=none dither=none matrix-mode=output-only n-threads=4 ! queue',
        enc: 'vah264lpenc rate-control=cbr bitrate=40000 ! h264parse',
        elements: ['videoconvert', 'vah264lpenc'],
        ext: 'mp4',
    },
    {
        id: 'va-raw-h264',
        label: 'VA H.264',
        vendors: [GpuVendor.AMD, GpuVendor.INTEL],
        src: 'videoconvert chroma-mode=none dither=none matrix-mode=output-only n-threads=4 ! queue',
        enc: 'vah264enc rate-control=cbr bitrate=40000 ! h264parse',
        elements: ['videoconvert', 'vah264enc'],
        ext: 'mp4',
    },
    // ── AMD + Intel (VAAPI — legacy gstreamer-vaapi, raw input) ──
    {
        id: 'vaapi-raw-h264',
        label: 'VAAPI H.264',
        vendors: [GpuVendor.AMD, GpuVendor.INTEL],
        src: 'videoconvert chroma-mode=none dither=none matrix-mode=output-only n-threads=4 ! queue',
        enc: 'vaapih264enc rate-control=cbr bitrate=40000 ! h264parse',
        elements: ['videoconvert', 'vaapih264enc'],
        ext: 'mp4',
    },
    // ── Software fallbacks (any GPU / no GPU) ──
    // Note: the screencast service prepends "capsfilter caps=video/x-raw,max-framerate=F/1"
    // for custom pipelines, which forces video/x-raw (no DMABuf/GL/CUDA memory).
    {
        id: 'sw-memfd-h264-openh264',
        label: 'Software H.264',
        vendors: [],
        // No capsfilter here — the screencast service prepends its own
        // capsfilter caps=video/x-raw,max-framerate=F/1 for custom pipelines.
        // Adding a second capsfilter causes FATAL_ERRORS linking failure.
        src: 'videoconvert chroma-mode=none dither=none matrix-mode=output-only n-threads=4 ! queue',
        enc: 'openh264enc complexity=high bitrate=40000000 multi-thread=4 ! h264parse',
        elements: ['videoconvert', 'openh264enc'],
        ext: 'mp4',
    },
    {
        id: 'sw-memfd-vp9',
        label: 'Software VP9',
        vendors: [],
        src: 'videoconvert chroma-mode=none dither=none matrix-mode=output-only n-threads=4 ! queue',
        enc: 'vp9enc min_quantizer=10 max_quantizer=50 cq_level=13 cpu-used=5 threads=4 deadline=1 static-threshold=1000 buffer-size=20000 row-mt=1 ! queue',
        elements: ['videoconvert', 'vp9enc'],
        ext: 'webm',
    },
];

const AUDIO_PIPELINE = {
    vorbis: 'vorbisenc ! queue',
    aac: 'fdkaacenc ! queue',
};

const MUXERS = {
    mp4: 'mp4mux fragment-duration=500',
    webm: 'webmmux',
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Check if a GStreamer element exists on the system
 */
function checkElement(name) {
    try {
        const proc = Gio.Subprocess.new(
            ['gst-inspect-1.0', '--exists', name],
            Gio.SubprocessFlags.NONE
        );
        proc.wait(null);
        return proc.get_successful();
    } catch {
        return false;
    }
}

/**
 * Check if all elements in a pipeline config are available
 */
function checkPipeline(config) {
    return config.elements.every(el => checkElement(el));
}

/**
 * Fix the file path extension after recording
 * GNOME creates files with .unknown extension, we rename to .mp4/.webm
 */
function fixFilePath(filePath, ext) {
    if (!filePath || !ext) return;
    const file = Gio.File.new_for_path(filePath);
    if (!file.query_exists(null)) return;
    // Replace the last extension (e.g., .webm → .mkv). Works correctly for
    // typical screencast filenames like 'Screencast_2024-01-01.webm'.
    const newPath = filePath.replace(/\.[^.]+$/, `.${ext}`);
    if (newPath !== filePath) {
        const newFile = Gio.File.new_for_path(newPath);
        try {
            file.move(newFile, Gio.FileCopyFlags.NONE, null, null);
        } catch (e) {
            console.error(`[Big Shot] Failed to rename file: ${e.message}`);
        }
    }
}

// =============================================================================
// MAIN EXTENSION CLASS
// =============================================================================

export default class BigShotExtension extends Extension {
    enable() {
        this._parts = [];
        this._availableConfigs = null; // null = not yet detected (lazy)
        this._currentConfigIndex = 0;

        // Pause/resume recording state
        this._recordingState = 'idle'; // 'idle' | 'recording' | 'paused'
        this._recordingContext = null;
        this._stopWatcherId = 0;

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

        // Create all parts (modules)
        this._createParts();

        // Monkey-patch screencast proxy
        this._patchScreencast();

        // Force-enable the screencast (video) button.
        // GNOME 49 has a bug where Gst.init_check(null) crashes the native
        // screencast service, hiding the cast button even when GStreamer
        // encoders are available. Since Big Shot provides its own pipelines,
        // force the button visible so users can switch to video mode.
        this._forceEnableScreencast();

        // Intercept _saveScreenshot to composite annotations onto the image
        this._patchSaveScreenshot();

    }

    disable() {
        // Clean up pause/resume state
        this._recordingState = 'idle';
        this._recordingContext = null;
        if (this._stopWatcherId) {
            GLib.source_remove(this._stopWatcherId);
            this._stopWatcherId = 0;
        }

        // Clean up webcam UI visibility listener
        if (this._webcamUIVisId) {
            this._screenshotUI?.disconnect(this._webcamUIVisId);
            this._webcamUIVisId = 0;
        }

        // Clean up pending rename timer
        if (this._renameTimerId) {
            GLib.source_remove(this._renameTimerId);
            this._renameTimerId = 0;
        }
        this._pendingRename = null;

        // Destroy all parts
        for (const part of this._parts) {
            try {
                part.destroy();
            } catch (e) {
                console.error(`[Big Shot] Error destroying part: ${e.message}`);
            }
        }
        this._parts = [];

        // Revert monkey-patches
        this._unpatchScreencast();

        // Revert force-enabled screencast button
        this._revertForceScreencast();

        // Revert save screenshot intercept
        this._unpatchSaveScreenshot();

        this._screenshotUI = null;
        this._availableConfigs = null;

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
                stream
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
                                workPixbuf, GdkPixbuf, GLib, toWidget, drawScale
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

                // 3. Load as Cairo ImageSurface
                const surface = cairo.ImageSurface.createFromPNG(tmpBase);
                const cr = new cairo.Context(surface);

                // 4. Draw all normal annotations (pen, arrow, text, etc.)
                for (const action of actions) {
                    if (typeof action.drawReal !== 'function') {
                        cr.save();
                        action.draw(cr, toWidget, drawScale);
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
            stream
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
            const surface = cairo.ImageSurface.createFromPNG(tmpBase);
            const cr = new cairo.Context(surface);

            for (const action of actions) {
                if (typeof action.drawReal !== 'function') {
                    cr.save();
                    action.draw(cr, toWidget, drawScale);
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

    /**
     * Handle action button clicks from the toolbar.
     */
    async _handleAction(action) {
        const ui = this._screenshotUI;

        try {
            const result = await this._captureAnnotatedBytes();
            if (!result) {
                console.error('[Big Shot] Failed to capture screenshot');
                return;
            }

            const { bytes, pixbuf } = result;

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

            }
        } catch (e) {
            console.error(`[Big Shot] Action '${action}' failed: ${e.message}\n${e.stack}`);
        }
    }

    /**
     * Open a Save As dialog via xdg-desktop-portal FileChooser.
     */
    _openSaveDialog(tmpPath, pixbuf) {
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
                                GLib.get_home_dir()
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
                            }
                        );
                    } catch (e) {
                        console.error(`[Big Shot] Portal SaveFile failed: ${e.message}`);
                        // Fallback: just open file manager at the temp location
                        try { Gio.File.new_for_path(tmpPath).delete(null); } catch (_e) { /* */ }
                    }
                }
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
        } catch (e) {
            // Fallback: show as OSD via Main.osdWindowManager
            try {
                const monitor = global.display.get_current_monitor();
                Main.osdWindowManager.show(monitor, null, `${title}: ${body}`, -1);
            } catch (_e2) {
                // Last resort: just console log
            }
        }
    }

    _detectPipelines() {
        // Already detected — skip
        if (this._availableConfigs !== null)
            return;

        // 1. Detect GPU vendor(s) via lspci (same as big-video-converter)
        this._gpuVendors = detectGpuVendors();

        const vendorSet = new Set(this._gpuVendors);

        // 2. Build ordered config list:
        //    - First: configs matching detected GPU (NVIDIA, AMD, or Intel — all equal priority)
        //    - Last: software fallbacks (vendors=[])
        const gpuConfigs = []; // Hardware-accelerated for detected GPU
        const swConfigs = [];  // Software fallbacks

        for (const config of VIDEO_PIPELINES) {
            if (!checkPipeline(config))
                continue;

            // Software config (vendors is empty array)
            if (config.vendors.length === 0) {
                swConfigs.push(config);
                continue;
            }

            // GPU config — add if ANY detected vendor matches
            const matches = config.vendors.some(v => vendorSet.has(v));
            if (matches)
                gpuConfigs.push(config);
        }

        // Final order: GPU hardware (your detected vendor) → Software fallback
        this._availableConfigs = [...gpuConfigs, ...swConfigs];

        if (this._availableConfigs.length === 0) {
            console.warn('[Big Shot] No compatible GStreamer pipeline found!');
        }
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

        // Wire action buttons (copy, save-as)
        this._toolbar.onAction((action) => {
            this._handleAction(action);
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

        // Quick Stop
        this._quickstop = new PartQuickStop(ui, ext);
        this._parts.push(this._quickstop);

        // Webcam overlay
        this._webcam = new PartWebcam(ui, ext);
        this._parts.push(this._webcam);

        // Wire webcam toggle (bottom bar button) to mask row visibility
        this._webcam.onWebcamToggled((enabled) => {
            if (this._toolbar._maskRow)
                this._toolbar._maskRow.visible = enabled;
        });

        // Wire mask selection from toolbar
        this._toolbar.onMaskChanged((maskId) => {
            this._webcam.maskId = maskId;
        });

        // Stop webcam preview when UI closes without active recording
        // Re-start preview when UI opens if webcam is still enabled
        // Reparent webcam overlay between screenshotUI (preview) and TopChrome (recording)
        this._webcamUIVisId = ui.connect('notify::visible', () => {
            if (ui.visible && this._webcam.enabled && this._recordingState === 'idle') {
                this._webcam.reparentForPreview();
                this._webcam.startPreview();
            } else if (!ui.visible && this._recordingState === 'idle') {
                this._webcam?.stopPreview();
            } else if (!ui.visible && this._recordingState !== 'idle') {
                // Recording started, UI hiding — move webcam to TopChrome
                this._webcam?.reparentForRecording();
            }
        });
    }

    _patchScreencast() {
        const screenshotUI = this._screenshotUI;
        const screencastProxy = screenshotUI._screencastProxy;
        if (!screencastProxy) {
            return;
        }

        // Save original methods
        this._origScreencast = screencastProxy.ScreencastAsync?.bind(screencastProxy);
        this._origScreencastArea = screencastProxy.ScreencastAreaAsync?.bind(screencastProxy);

        const ext = this;

        // Patch ScreencastAsync
        if (this._origScreencast) {
            screencastProxy.ScreencastAsync = function (filePath, options) {
                return ext._screencastCommonAsync(filePath, options, ext._origScreencast);
            };
        }

        // Patch ScreencastAreaAsync
        if (this._origScreencastArea) {
            screencastProxy.ScreencastAreaAsync = function (x, y, width, height, filePath, options) {
                return ext._screencastCommonAsync(filePath, options, (fp, opts) => {
                    return ext._origScreencastArea(x, y, width, height, fp, opts);
                });
            };
        }

        // Single open() patch: combines QuickStop (stop recording on
        // re-open) and allow-screenshot-while-recording logic.
        // Having a single save/restore avoids stale closure chains after
        // lock-screen disable/enable cycles.
        this._origOpen = screenshotUI.open.bind(screenshotUI);
        screenshotUI.open = function (mode) {
            // QuickStop: if recording (or paused) and user re-opens the UI,
            // stop the ongoing recording instead of opening.
            if (ext._recordingState === 'paused') {
                // Resume the screencast process first so it can finalize the file
                ext._signalScreencastProcess('CONT');
                // Let GNOME stop the recording normally
                const recorder = Main.screenshotUI?._recorder;
                if (recorder?.is_recording?.()) {
                    try { recorder.close(); } catch (_e) { /* */ }
                }
                ext._onFinalStop();
                Main.screenshotUI?.close();
                return Promise.resolve();
            }

            const recorder = Main.screenshotUI?._recorder;
            if (recorder?.is_recording?.()) {
                try {
                    recorder.close();
                    Main.screenshotUI?.close();
                } catch (e) {
                    console.error(`[Big Shot] Quick stop error: ${e.message}`);
                }
                return Promise.resolve();
            }

            if (mode === undefined) mode = 0; // UIMode.SCREENSHOT
            // Allow screenshot while recording: GNOME blocks open() when
            // _screencastInProgress is true. We temporarily clear the flag
            // so screenshot mode (UIMode.SCREENSHOT=0) can open during recording.
            if (this._screencastInProgress && mode !== 1) { // 1 = UIMode.SCREENCAST
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
        this._origStartScreencast = screenshotUI._startScreencast?.bind(screenshotUI);
        if (this._origStartScreencast) {
            screenshotUI._startScreencast = function (...args) {
                ext._recordingState = 'starting';
                return ext._origStartScreencast(...args);
            };
        }
    }

    _unpatchScreencast() {
        const screencastProxy = this._screenshotUI?._screencastProxy;
        if (!screencastProxy) return;

        if (this._origScreencast)
            screencastProxy.ScreencastAsync = this._origScreencast;
        if (this._origScreencastArea)
            screencastProxy.ScreencastAreaAsync = this._origScreencastArea;
        if (this._origOpen)
            this._screenshotUI.open = this._origOpen;
        if (this._origStartScreencast)
            this._screenshotUI._startScreencast = this._origStartScreencast;

        this._origScreencast = null;
        this._origScreencastArea = null;
        this._origOpen = null;
        this._origStartScreencast = null;
    }

    async _screencastCommonAsync(filePath, options, originalMethod) {
        // Lazy pipeline detection on first use (avoids blocking enable())
        this._detectPipelines();

        if (this._availableConfigs.length === 0) {
            return originalMethod(filePath, options);
        }

        const framerate = this._framerate?.value ?? 30;
        const downsize = this._downsize?.value ?? 1.0;
        const quality = this._toolbar?.videoQuality ?? 'high';
        const framerateCaps = `${framerate}/1`;

        // Set framerate in D-Bus options
        options['framerate'] = new GLib.Variant('i', framerate);

        // Show indicator once at the start of cascade
        this._indicator?.onPipelineStarting();

        // Build pipeline order: preferred codec first, then rest
        let configs = [...this._availableConfigs];
        const preferredId = this._toolbar?.selectedPipelineId;
        if (preferredId) {
            const idx = configs.findIndex(c => c.id === preferredId);
            if (idx > 0) {
                const [preferred] = configs.splice(idx, 1);
                configs.unshift(preferred);
            }
        }

        // Try each config in cascade: preferred → GPU hw → VAAPI → Software
        for (let i = 0; i < configs.length; i++) {
            const config = configs[i];
            const pipeline = this._makePipelineString(config, framerateCaps, downsize, quality);
            const pipelineOptions = {
                ...options,
                pipeline: new GLib.Variant('s', pipeline),
            };

            // Mark recording as starting BEFORE await so that
            // the notify::visible handler can reparent the webcam overlay
            // instead of stopping it when the UI hides.
            this._recordingState = 'starting';

            try {
                const result = await originalMethod(filePath, pipelineOptions);
                this._indicator?.onPipelineReady();

                // Save recording context for pause/resume
                this._recordingState = 'recording';
                this._recordingContext = {
                    config,
                };

                // Fix .undefined extension: GNOME creates files with .undefined
                // for custom pipelines. Schedule rename after recording stops
                // and fix the return path so notifications use correct extension.
                let correctedPath = result?.[1] ?? filePath;
                if (result && result[0] && typeof result[1] === 'string') {
                    const actualPath = result[1];
                    const correctExt = `.${config.ext}`;
                    if (!actualPath.endsWith(correctExt)) {
                        correctedPath = actualPath.replace(/\.[^.]+$/, correctExt);
                        this._scheduleFileRename(actualPath, config.ext);
                    }
                }
                this._currentSegmentPath = correctedPath;

                // Start watching for final stop
                this._watchForFinalStop();

                // Notify indicator
                console.log('[Big Shot] About to call onRecordingStarted, indicator exists:', !!this._indicator);
                try {
                    this._indicator?.onRecordingStarted();
                    console.log('[Big Shot] onRecordingStarted called successfully');
                } catch (indErr) {
                    console.error('[Big Shot] onRecordingStarted ERROR:', indErr.message, indErr.stack);
                }

                // Return result with corrected file extension so GNOME
                // notifications point to the .mp4/.webm file, not .undefined
                return (result && result[0])
                    ? [result[0], correctedPath]
                    : result;
            } catch (e) {
                console.warn(`[Big Shot] Pipeline ${config.id} failed: ${e.message}`);
                // Continue to next config
            }
        }

        // All custom pipelines exhausted — clean up indicator and fall back
        console.warn('[Big Shot] All pipelines failed, falling back to GNOME default');
        this._indicator?.onPipelineReady();
        return originalMethod(filePath, options);
    }

    // =========================================================================
    // PAUSE / RESUME RECORDING
    // =========================================================================

    /**
     * Find the PID of the gnome-shell-screencast subprocess.
     * Returns the PID as a number, or 0 if not found.
     */
    _findScreencastPid() {
        try {
            const proc = Gio.Subprocess.new(
                ['pgrep', '-f', 'org.gnome.Shell.Screencast'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
            );
            const [, stdout] = proc.communicate_utf8(null, null);
            const pid = parseInt((stdout || '').trim().split('\n')[0], 10);
            return isNaN(pid) ? 0 : pid;
        } catch (_e) {
            return 0;
        }
    }

    /**
     * Send a POSIX signal to the screencast process.
     */
    _signalScreencastProcess(signal) {
        const pid = this._findScreencastPid();
        if (!pid) {
            console.warn('[Big Shot] Screencast process not found for signal');
            return false;
        }
        try {
            const proc = Gio.Subprocess.new(
                ['kill', `-${signal}`, String(pid)],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE
            );
            proc.wait(null);
            return proc.get_successful();
        } catch (e) {
            console.error(`[Big Shot] Failed to signal process: ${e.message}`);
            return false;
        }
    }

    /**
     * Pause the current recording by sending SIGSTOP to the screencast
     * subprocess. The GStreamer pipeline freezes and no new frames are
     * captured, but GNOME Shell continues to think recording is active.
     */
    pauseRecording() {
        if (this._recordingState !== 'recording') return;

        if (this._signalScreencastProcess('STOP')) {
            this._recordingState = 'paused';
            this._indicator?.onPaused();
            console.log('[Big Shot] Recording paused (SIGSTOP)');
        }
    }

    /**
     * Resume recording by sending SIGCONT to the screencast subprocess.
     */
    resumeRecording() {
        if (this._recordingState !== 'paused') return;

        if (this._signalScreencastProcess('CONT')) {
            this._recordingState = 'recording';
            this._indicator?.onResumed();
            console.log('[Big Shot] Recording resumed (SIGCONT)');
        }
    }

    /**
     * Toggle pause/resume — called by the indicator panel button.
     */
    togglePauseRecording() {
        if (this._recordingState === 'recording') {
            this.pauseRecording();
        } else if (this._recordingState === 'paused') {
            this.resumeRecording();
        }
    }

    /**
     * Watch for the final stop (user-initiated).
     * When the user stops recording, we make sure to resume first if paused.
     */
    _watchForFinalStop() {
        if (this._stopWatcherId) {
            GLib.source_remove(this._stopWatcherId);
            this._stopWatcherId = 0;
        }

        this._stopWatcherId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            // If paused, keep watching — the user may resume or the QuickStop
            // handler will SIGCONT before stopping.
            if (this._recordingState === 'paused')
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

        this._recordingState = 'idle';
        this._indicator?.onRecordingStopped();
        this._webcam?.stopPreview();
        this._recordingContext = null;
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

    _makePipelineString(config, framerateCaps, downsize, quality = 'high') {
        let video = config.src.replace('FRAMERATE_CAPS', framerateCaps);
        video += ` ! ${config.enc}`;

        // Apply quality adjustment to bitrate
        if (quality !== 'high') {
            const factor = quality === 'medium' ? 0.5 : 0.25;
            // HW encoders use bitrate in kbps (e.g., bitrate=40000)
            // SW encoders use bitrate in bps (e.g., bitrate=40000000)
            video = video.replace(/bitrate=(\d+)/g, (_match, val) => {
                return `bitrate=${Math.round(parseInt(val) * factor)}`;
            });
            // VP8/VP9 use quantizer-based quality (higher = lower quality)
            video = video.replace(/min_quantizer=(\d+)/g, (_match, val) => {
                const adj = quality === 'medium' ? 5 : 10;
                return `min_quantizer=${Math.min(parseInt(val) + adj, 63)}`;
            });
            video = video.replace(/max_quantizer=(\d+)/g, (_match, val) => {
                const adj = quality === 'medium' ? 3 : 8;
                return `max_quantizer=${Math.min(parseInt(val) + adj, 63)}`;
            });
        }

        // Downsize — insert videoscale between videoconvert and encoder
        if (downsize < 1.0) {
            const monitor = global.display.get_current_monitor();
            const geo = global.display.get_monitor_geometry(monitor);
            const targetW = Math.round(geo.width * downsize);
            const targetH = Math.round(geo.height * downsize);
            // Insert videoscale after the first "queue" in the video chain
            video = video.replace(
                /queue/,
                `queue ! videoscale ! video/x-raw,width=${targetW},height=${targetH}`
            );
        }

        const audioInput = this._audio?.makeAudioInput();
        const ext = config.ext;
        const muxer = MUXERS[ext];


        if (audioInput) {
            // GStreamer multi-branch pipeline for audio+video:
            //   pipewiresrc ! video_chain ! queue ! mux.  pulsesrc ! audio_chain ! queue ! mux.  muxer name=mux ! filesink
            // The screencast service prepends pipewiresrc and appends ! filesink
            const audioPipeline = ext === 'mp4' ? AUDIO_PIPELINE.aac : AUDIO_PIPELINE.vorbis;
            const videoSeg = `${video} ! queue ! mux.`;
            const audioSeg = `${audioInput} ! ${audioPipeline} ! mux.`;
            const muxDef = `${muxer} name=mux`;
            return `${videoSeg} ${audioSeg} ${muxDef}`;
        }

        return `${video} ! ${muxer}`;
    }
}
