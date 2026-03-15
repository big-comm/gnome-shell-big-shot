/**
 * Big Shot — Enhanced Screenshot & Screencast for GNOME Shell
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

export const APP_VERSION = '0.4.0';

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
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

        console.log('[Big Shot] Extension enabled');
    }

    disable() {
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

        // Dismiss any open config dialogs
        this._dismissCloudConfigDialog();
        this._dismissShareConfigDialog();

        this._screenshotUI = null;
        this._availableConfigs = null;

        console.log('[Big Shot] Extension disabled');
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

        console.log('[Big Shot] Screencast button force-enabled');
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
            console.log('[Big Shot] _saveScreenshot called');
            const overlay = ext._annotation?._overlay;
            const actions = overlay?._actions;
            console.log(`[Big Shot] overlay=${!!overlay}, actions=${actions?.length ?? 'null'}`);

            // No annotations — use original save
            if (!actions || actions.length === 0) {
                console.log('[Big Shot] No annotations, using original save');
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
                                console.log(`[Big Shot] drawReal applied: ${action.constructor.name}`);
                            } else {
                                console.log(`[Big Shot] drawReal returned null: ${action.constructor.name}`);
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

        console.log('[Big Shot] _saveScreenshot intercepted for annotation compositing');
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
    // ACTION BUTTONS — Copy, Save As, Cloud Upload, Share
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
        console.log(`[Big Shot] _handleAction('${action}') called`);

        try {
            const result = await this._captureAnnotatedBytes();
            console.log(`[Big Shot] _captureAnnotatedBytes result: ${!!result}`);
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
                console.log('[Big Shot] Screenshot copied to clipboard');
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

            case 'cloud': {
                // Nextcloud WebDAV upload
                const configPath = GLib.build_filenamev([
                    GLib.get_user_config_dir(), 'big-shot', 'cloud.json']);
                const configFile = Gio.File.new_for_path(configPath);

                let config = null;
                if (configFile.query_exists(null)) {
                    try {
                        const [, configData] = configFile.load_contents(null);
                        config = JSON.parse(new TextDecoder().decode(configData));
                    } catch (_e) {
                        config = null;
                    }
                }

                if (!config?.url || !config?.username || !config?.password) {
                    // Show config dialog
                    this._showCloudConfigDialog(bytes, config || {});
                    return;
                }

                const clipboard = St.Clipboard.get_default();
                clipboard.set_content(St.ClipboardType.CLIPBOARD, 'image/png', bytes);

                ui.close();

                this._uploadToNextcloud(bytes, config);
                break;
            }

            case 'share': {
                const configPath = GLib.build_filenamev([
                    GLib.get_user_config_dir(), 'big-shot', 'share.json']);
                const configFile = Gio.File.new_for_path(configPath);

                let config = null;
                if (configFile.query_exists(null)) {
                    try {
                        const [, configData] = configFile.load_contents(null);
                        config = JSON.parse(new TextDecoder().decode(configData));
                    } catch (_e) {
                        config = null;
                    }
                }

                if (!config?.url) {
                    this._showShareConfigDialog(bytes, config || {});
                    return;
                }

                const clipboard = St.Clipboard.get_default();
                clipboard.set_content(St.ClipboardType.CLIPBOARD, 'image/png', bytes);

                ui.close();

                this._uploadToEndpoint(bytes, config);
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
                                            console.log(`[Big Shot] Saved to: ${uris[0]}`);
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
     * Upload PNG bytes to Nextcloud via WebDAV.
     * Config: { url, username, password, folder }
     */
    _uploadToNextcloud(bytes, config) {
        const time = GLib.DateTime.new_now_local();
        const fileName = `Screenshot_${time.format('%Y-%m-%d_%H-%M-%S')}.png`;
        const folder = config.folder || '/Screenshots';
        const uploadUrl = `${config.url.replace(/\/$/, '')}/remote.php/dav/files/${config.username}${folder}/${fileName}`;

        const auth = GLib.base64_encode(`${config.username}:${config.password}`);

        try {
            const proc = Gio.Subprocess.new(
                ['curl', '-sS', '-o', '/dev/null', '-w', '%{http_code}',
                    '-X', 'PUT',
                    '-H', `Authorization: Basic ${auth}`,
                    '-H', 'Content-Type: image/png',
                    '--data-binary', '@-',
                    uploadUrl],
                Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );

            const bytesData = bytes.get_data();
            proc.communicate_async(GLib.Bytes.new(bytesData), null, (_p, asyncResult) => {
                try {
                    const [, stdout, stderr] = proc.communicate_finish(asyncResult);
                    const httpCode = new TextDecoder().decode(stdout.get_data()).trim();
                    const errText = stderr ? new TextDecoder().decode(stderr.get_data()).trim() : '';
                    const exitOk = proc.get_successful();

                    if (!exitOk || httpCode === '000' || httpCode === '') {
                        const detail = errText || _('Connection failed');
                        this._showNotification(_('Nextcloud upload failed'), detail);
                        console.error(`[Big Shot] Nextcloud curl error: ${detail}`);
                        return;
                    }

                    if (httpCode === '201' || httpCode === '204') {
                        this._showNotification(
                            _('Uploaded to Nextcloud'),
                            fileName);
                        console.log(`[Big Shot] Nextcloud upload OK: ${httpCode}`);
                    } else {
                        this._showNotification(
                            _('Nextcloud upload failed'),
                            `HTTP ${httpCode}`);
                        console.error(`[Big Shot] Nextcloud upload failed: HTTP ${httpCode}`);
                    }
                } catch (e) {
                    console.error(`[Big Shot] Nextcloud upload error: ${e.message}`);
                    this._showNotification(_('Nextcloud upload failed'), e.message);
                }
            });
        } catch (e) {
            console.error(`[Big Shot] Nextcloud upload launch failed: ${e.message}`);
            this._showNotification(_('Nextcloud upload failed'), e.message);
        }
    }

    /**
     * Upload PNG bytes to a custom endpoint.
     * Config: { url, method, headers, fileField, responseUrlField }
     */
    _uploadToEndpoint(bytes, config) {
        const time = GLib.DateTime.new_now_local();
        const fileName = `Screenshot_${time.format('%Y-%m-%d_%H-%M-%S')}.png`;

        // Build curl command for multipart upload
        const tmpPath = GLib.build_filenamev([
            GLib.get_tmp_dir(), `bigshot-upload-${Date.now()}.png`]);
        const tmpFile = Gio.File.new_for_path(tmpPath);
        const outStream = tmpFile.create(Gio.FileCreateFlags.NONE, null);
        outStream.write_bytes(bytes, null);
        outStream.close(null);

        const fileField = config.fileField || 'file';
        const method = config.method || 'POST';
        const args = [
            'curl', '-s', '-X', method,
            '-F', `${fileField}=@${tmpPath};type=image/png;filename=${fileName}`,
        ];

        // Add custom headers
        if (config.headers) {
            for (const [key, value] of Object.entries(config.headers)) {
                args.push('-H', `${key}: ${value}`);
            }
        }

        args.push(config.url);

        try {
            const proc = Gio.Subprocess.new(
                args,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
            );

            proc.communicate_async(null, null, (_p, asyncResult) => {
                try {
                    const [, stdout] = proc.communicate_finish(asyncResult);
                    const responseText = new TextDecoder().decode(stdout.get_data()).trim();

                    // Try to extract URL from response
                    let shareUrl = null;
                    const urlField = config.responseUrlField || 'url';
                    try {
                        const json = JSON.parse(responseText);
                        shareUrl = this._extractJsonField(json, urlField);
                    } catch (_e) {
                        // Maybe it's just a plain URL
                        if (responseText.startsWith('http'))
                            shareUrl = responseText;
                    }

                    if (shareUrl) {
                        // Copy link to clipboard
                        const clipboard = St.Clipboard.get_default();
                        clipboard.set_text(St.ClipboardType.CLIPBOARD, shareUrl);
                        this._showNotification(
                            _('Link copied to clipboard'),
                            shareUrl);
                        console.log(`[Big Shot] Share URL: ${shareUrl}`);
                    } else {
                        this._showNotification(
                            _('Upload complete'),
                            _('Could not extract share URL'));
                        console.log(`[Big Shot] Upload done, response: ${responseText.substring(0, 200)}`);
                    }
                } catch (e) {
                    console.error(`[Big Shot] Share upload error: ${e.message}`);
                    this._showNotification(_('Upload failed'), e.message);
                } finally {
                    try { Gio.File.new_for_path(tmpPath).delete(null); } catch (_e) { /* */ }
                }
            });
        } catch (e) {
            console.error(`[Big Shot] Share upload launch failed: ${e.message}`);
            this._showNotification(_('Upload failed'), e.message);
            try { Gio.File.new_for_path(tmpPath).delete(null); } catch (_e) { /* */ }
        }
    }

    /**
     * Extract a value from a JSON object by dot-separated path.
     */
    _extractJsonField(obj, path) {
        const parts = path.split('.');
        let current = obj;
        for (const part of parts) {
            if (current == null) return null;
            current = current[part];
        }
        return typeof current === 'string' ? current : null;
    }

    /**
     * Collapse or restore the native GNOME screenshot panel.
     */
    _setNativePanelCollapsed(collapsed) {
        const ui = this._screenshotUI;
        if (!ui) return;

        const panel = ui._panel;
        const closeBtn = ui._closeButton;
        if (!panel) return;

        if (collapsed) {
            panel.add_style_class_name('big-shot-panel-hidden');
            if (closeBtn)
                closeBtn.add_style_class_name('big-shot-panel-hidden');
        } else {
            panel.remove_style_class_name('big-shot-panel-hidden');
            if (closeBtn)
                closeBtn.remove_style_class_name('big-shot-panel-hidden');
        }
    }

    /**
     * Show a cloud config dialog inside the screenshot UI.
     */
    _showCloudConfigDialog(bytes, existingConfig) {
        this._dismissCloudConfigDialog();
        console.log('[Big Shot] _showCloudConfigDialog called');

        const ui = this._screenshotUI;

        // Full-screen backdrop using constraints
        const backdrop = new St.Widget({
            style: 'background: rgba(0,0,0,0.5);',
            reactive: true,
            layout_manager: new Clutter.BinLayout(),
        });
        backdrop.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.SIZE,
        }));
        backdrop.connect('button-press-event', (_actor, event) => {
            if (event.get_source() === backdrop) {
                this._dismissCloudConfigDialog();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // Dialog panel
        const dialog = new St.BoxLayout({
            vertical: true,
            style: `background: rgba(36,36,36,0.95); border-radius: 16px;
                    padding: 24px; min-width: 340px; max-width: 400px; spacing: 10px;`,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });

        const title = new St.Label({
            text: _('Cloud Settings (Nextcloud)'),
            style: 'font-size: 16px; font-weight: bold; color: #fff; margin-bottom: 8px;',
            x_align: Clutter.ActorAlign.CENTER,
        });
        dialog.add_child(title);

        const makeField = (label, value, isPassword) => {
            const row = new St.BoxLayout({ vertical: true, style: 'spacing: 4px;' });
            row.add_child(new St.Label({
                text: label,
                style: 'font-size: 12px; color: rgba(255,255,255,0.7);',
            }));
            const entry = new St.Entry({
                text: value || '',
                style: `background: rgba(255,255,255,0.1); border-radius: 8px;
                        padding: 8px 12px; color: #fff; font-size: 13px;
                        border: 1px solid rgba(255,255,255,0.15);`,
                can_focus: true,
                hint_text: label,
            });
            if (isPassword) {
                const clutterText = entry.get_clutter_text();
                clutterText.set_password_char('\u25CF');
            }
            row.add_child(entry);
            dialog.add_child(row);
            return entry;
        };

        const urlEntry = makeField(_('URL'), existingConfig.url, false);
        const userEntry = makeField(_('Username'), existingConfig.username, false);
        const passEntry = makeField(_('Password'), existingConfig.password, true);
        const folderEntry = makeField(_('Folder (optional)'),
            existingConfig.folder || '/Screenshots', false);

        // TAB navigation between entries
        const cloudEntries = [urlEntry, userEntry, passEntry, folderEntry];
        for (let i = 0; i < cloudEntries.length; i++) {
            cloudEntries[i].get_clutter_text().connect('key-press-event', (_actor, event) => {
                if (event.get_key_symbol() === Clutter.KEY_Tab) {
                    const next = cloudEntries[(i + 1) % cloudEntries.length];
                    next.grab_key_focus();
                    return Clutter.EVENT_STOP;
                }
                if (event.get_key_symbol() === Clutter.KEY_ISO_Left_Tab) {
                    const prev = cloudEntries[(i - 1 + cloudEntries.length) % cloudEntries.length];
                    prev.grab_key_focus();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
        }

        // Buttons row
        const btnRow = new St.BoxLayout({
            style: 'spacing: 12px; margin-top: 8px;',
            x_align: Clutter.ActorAlign.CENTER,
        });

        const cancelBtn = new St.Button({
            label: _('Cancel'),
            style: `background: rgba(255,255,255,0.1); border-radius: 8px;
                    padding: 8px 20px; color: #fff; font-size: 13px;`,
        });
        cancelBtn.connect('clicked', () => this._dismissCloudConfigDialog());
        btnRow.add_child(cancelBtn);

        const saveBtn = new St.Button({
            label: _('Save & Upload'),
            style: `background: #3584e4; border-radius: 8px;
                    padding: 8px 20px; color: #fff; font-size: 13px; font-weight: bold;`,
        });
        saveBtn.connect('clicked', () => {
            const url = urlEntry.get_text().trim();
            const username = userEntry.get_text().trim();
            const password = passEntry.get_text().trim();
            const folder = folderEntry.get_text().trim() || '/Screenshots';

            if (!url || !username || !password) {
                this._toolbar.showInlineMessage(_('Fill all required fields'));
                return;
            }

            // Save config
            const config = { url, username, password, folder };
            const configDir = GLib.build_filenamev([
                GLib.get_user_config_dir(), 'big-shot']);
            GLib.mkdir_with_parents(configDir, 0o755);
            const configPath = GLib.build_filenamev([configDir, 'cloud.json']);
            const file = Gio.File.new_for_path(configPath);
            const json = JSON.stringify(config, null, 2);
            file.replace_contents(
                new TextEncoder().encode(json),
                null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            console.log(`[Big Shot] Cloud config saved to ${configPath}`);

            this._dismissCloudConfigDialog();

            // Copy to clipboard and upload
            const clipboard = St.Clipboard.get_default();
            clipboard.set_content(St.ClipboardType.CLIPBOARD, 'image/png', bytes);
            ui.close();
            this._uploadToNextcloud(bytes, config);
        });
        btnRow.add_child(saveBtn);

        // Reset button
        const resetBtn = new St.Button({
            label: _('Reset'),
            style: `background: rgba(224,27,36,0.8); border-radius: 8px;
                    padding: 8px 16px; color: #fff; font-size: 12px;`,
        });
        resetBtn.connect('clicked', () => {
            const configPath = GLib.build_filenamev([
                GLib.get_user_config_dir(), 'big-shot', 'cloud.json']);
            const f = Gio.File.new_for_path(configPath);
            if (f.query_exists(null)) {
                f.delete(null);
                console.log(`[Big Shot] Cloud config deleted: ${configPath}`);
            }
            urlEntry.set_text('');
            userEntry.set_text('');
            passEntry.set_text('');
            folderEntry.set_text('/Screenshots');
            this._toolbar.showInlineMessage(_('Cloud config removed'));
        });
        btnRow.add_child(resetBtn);

        dialog.add_child(btnRow);
        backdrop.add_child(dialog);

        this._cloudConfigDialog = backdrop;
        global.stage.add_child(backdrop);
        console.log(`[Big Shot] Cloud dialog added to UI, backdrop visible=${backdrop.visible}, size=${backdrop.width}x${backdrop.height}`);

        // Focus the URL field
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            urlEntry.grab_key_focus();
            return GLib.SOURCE_REMOVE;
        });
    }

    _dismissCloudConfigDialog() {
        if (this._cloudConfigDialog) {
            this._cloudConfigDialog.destroy();
            this._cloudConfigDialog = null;
        }
    }

    /**
     * Show a share endpoint config dialog inside the screenshot UI.
     */
    _showShareConfigDialog(bytes, existingConfig) {
        this._dismissShareConfigDialog();

        const ui = this._screenshotUI;

        const backdrop = new St.Widget({
            style: 'background: rgba(0,0,0,0.5);',
            reactive: true,
            layout_manager: new Clutter.BinLayout(),
        });
        backdrop.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.SIZE,
        }));
        backdrop.connect('button-press-event', (_actor, event) => {
            if (event.get_source() === backdrop) {
                this._dismissShareConfigDialog();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        const dialog = new St.BoxLayout({
            vertical: true,
            style: `background: rgba(36,36,36,0.95); border-radius: 16px;
                    padding: 24px; min-width: 340px; max-width: 400px; spacing: 10px;`,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });

        const title = new St.Label({
            text: _('Share Settings'),
            style: 'font-size: 16px; font-weight: bold; color: #fff; margin-bottom: 8px;',
            x_align: Clutter.ActorAlign.CENTER,
        });
        dialog.add_child(title);

        const makeField = (label, value) => {
            const row = new St.BoxLayout({ vertical: true, style: 'spacing: 4px;' });
            row.add_child(new St.Label({
                text: label,
                style: 'font-size: 12px; color: rgba(255,255,255,0.7);',
            }));
            const entry = new St.Entry({
                text: value || '',
                style: `background: rgba(255,255,255,0.1); border-radius: 8px;
                        padding: 8px 12px; color: #fff; font-size: 13px;
                        border: 1px solid rgba(255,255,255,0.15);`,
                can_focus: true,
                hint_text: label,
            });
            row.add_child(entry);
            dialog.add_child(row);
            return entry;
        };

        const urlEntry = makeField(_('Upload URL'), existingConfig.url);
        const fileFieldEntry = makeField(_('File field name'),
            existingConfig.fileField || 'file');
        const responseUrlEntry = makeField(_('Response URL field (JSON path)'),
            existingConfig.responseUrlField || 'url');

        // TAB navigation between entries
        const shareEntries = [urlEntry, fileFieldEntry, responseUrlEntry];
        for (let i = 0; i < shareEntries.length; i++) {
            shareEntries[i].get_clutter_text().connect('key-press-event', (_actor, event) => {
                if (event.get_key_symbol() === Clutter.KEY_Tab) {
                    const next = shareEntries[(i + 1) % shareEntries.length];
                    next.grab_key_focus();
                    return Clutter.EVENT_STOP;
                }
                if (event.get_key_symbol() === Clutter.KEY_ISO_Left_Tab) {
                    const prev = shareEntries[(i - 1 + shareEntries.length) % shareEntries.length];
                    prev.grab_key_focus();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
        }

        const btnRow = new St.BoxLayout({
            style: 'spacing: 12px; margin-top: 8px;',
            x_align: Clutter.ActorAlign.CENTER,
        });

        const cancelBtn = new St.Button({
            label: _('Cancel'),
            style: `background: rgba(255,255,255,0.1); border-radius: 8px;
                    padding: 8px 20px; color: #fff; font-size: 13px;`,
        });
        cancelBtn.connect('clicked', () => this._dismissShareConfigDialog());
        btnRow.add_child(cancelBtn);

        const saveBtn = new St.Button({
            label: _('Save & Upload'),
            style: `background: #3584e4; border-radius: 8px;
                    padding: 8px 20px; color: #fff; font-size: 13px; font-weight: bold;`,
        });
        saveBtn.connect('clicked', () => {
            const url = urlEntry.get_text().trim();
            const fileField = fileFieldEntry.get_text().trim() || 'file';
            const responseUrlField = responseUrlEntry.get_text().trim() || 'url';

            if (!url) {
                this._toolbar.showInlineMessage(_('URL is required'));
                return;
            }

            const config = {
                url,
                method: 'POST',
                fileField,
                responseUrlField,
            };
            const configDir = GLib.build_filenamev([
                GLib.get_user_config_dir(), 'big-shot']);
            GLib.mkdir_with_parents(configDir, 0o755);
            const configPath = GLib.build_filenamev([configDir, 'share.json']);
            const file = Gio.File.new_for_path(configPath);
            const json = JSON.stringify(config, null, 2);
            file.replace_contents(
                new TextEncoder().encode(json),
                null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            console.log(`[Big Shot] Share config saved to ${configPath}`);

            this._dismissShareConfigDialog();

            const clipboard = St.Clipboard.get_default();
            clipboard.set_content(St.ClipboardType.CLIPBOARD, 'image/png', bytes);
            ui.close();
            this._uploadToEndpoint(bytes, config);
        });
        btnRow.add_child(saveBtn);

        const resetBtn = new St.Button({
            label: _('Reset'),
            style: `background: rgba(224,27,36,0.8); border-radius: 8px;
                    padding: 8px 16px; color: #fff; font-size: 12px;`,
        });
        resetBtn.connect('clicked', () => {
            const configPath = GLib.build_filenamev([
                GLib.get_user_config_dir(), 'big-shot', 'share.json']);
            const f = Gio.File.new_for_path(configPath);
            if (f.query_exists(null)) {
                f.delete(null);
                console.log(`[Big Shot] Share config deleted: ${configPath}`);
            }
            urlEntry.set_text('');
            fileFieldEntry.set_text('file');
            responseUrlEntry.set_text('url');
            this._toolbar.showInlineMessage(_('Share config removed'));
        });
        btnRow.add_child(resetBtn);

        dialog.add_child(btnRow);
        backdrop.add_child(dialog);

        this._shareConfigDialog = backdrop;
        global.stage.add_child(backdrop);

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            urlEntry.grab_key_focus();
            return GLib.SOURCE_REMOVE;
        });
    }

    _dismissShareConfigDialog() {
        if (this._shareConfigDialog) {
            this._shareConfigDialog.destroy();
            this._shareConfigDialog = null;
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
            console.log(`[Big Shot] Notification fallback: ${title} — ${body}`);
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
        console.log(`[Big Shot] Detected GPU vendor(s): ${this._gpuVendors.join(', ')}`);

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
        } else {
            console.log(`[Big Shot] Pipeline priority (${this._availableConfigs.length} config(s)):`);
            this._availableConfigs.forEach((c, i) => {
                console.log(`  [${i}] ${c.id} — ${c.label}`);
            });
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

            // Collapse native panel when a drawing tool is active
            this._setNativePanelCollapsed(toolId !== null);
        });

        // Wire action buttons (copy, save-as, cloud, share)
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
    }

    _patchScreencast() {
        const screenshotUI = this._screenshotUI;
        const screencastProxy = screenshotUI._screencastProxy;
        if (!screencastProxy) {
            console.log('[Big Shot] WARNING: _screencastProxy not found on screenshotUI');
            return;
        }
        console.log('[Big Shot] Patching screencast proxy methods');

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
            // QuickStop: if recording and user re-opens the UI,
            // stop the ongoing recording instead of opening.
            const recorder = Main.screenshotUI?._recorder;
            if (recorder?.is_recording?.()) {
                try {
                    recorder.close();
                    Main.screenshotUI?.close();
                } catch (e) {
                    console.error(`[Big Shot] Quick stop error: ${e.message}`);
                }
                return;
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

        this._origScreencast = null;
        this._origScreencastArea = null;
        this._origOpen = null;
    }

    async _screencastCommonAsync(filePath, options, originalMethod) {
        // Lazy pipeline detection on first use (avoids blocking enable())
        this._detectPipelines();

        if (this._availableConfigs.length === 0) {
            console.log('[Big Shot] No custom pipelines, using GNOME default');
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

            console.log(`[Big Shot] Trying pipeline [${i}]: ${config.id} (${config.label})`);
            console.log(`[Big Shot] Pipeline string: ${pipeline}`);

            try {
                const result = await originalMethod(filePath, pipelineOptions);
                console.log(`[Big Shot] Pipeline ${config.id} succeeded`);
                this._indicator?.onPipelineReady();

                // Fix .undefined extension: GNOME creates files with .undefined
                // for custom pipelines. Schedule rename after recording stops
                // and fix the return path so notifications use correct extension.
                if (result && result[0] && typeof result[1] === 'string') {
                    const actualPath = result[1];
                    const correctExt = `.${config.ext}`;
                    if (!actualPath.endsWith(correctExt)) {
                        const newPath = actualPath.replace(/\.[^.]+$/, correctExt);
                        console.log(`[Big Shot] Scheduling rename: ${actualPath} → ${newPath}`);
                        this._scheduleFileRename(actualPath, config.ext);
                        return [result[0], newPath];
                    }
                }
                return result;
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
            console.log(`[Big Shot] Downsize ${Math.round(downsize * 100)}%: ${geo.width}x${geo.height} → ${targetW}x${targetH}`);
        }

        const audioInput = this._audio?.makeAudioInput();
        const ext = config.ext;
        const muxer = MUXERS[ext];

        console.log(`[Big Shot] _makePipeline: audioInput=${audioInput ? 'YES' : 'NO'}, ext=${ext}`);

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
