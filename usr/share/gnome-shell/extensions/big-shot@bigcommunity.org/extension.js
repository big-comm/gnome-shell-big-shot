/**
 * Big Shot — Enhanced Screenshot & Screencast for GNOME Shell
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

export const APP_VERSION = '0.1.0';

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import St from 'gi://St';
import GdkPixbuf from 'gi://GdkPixbuf';
import cairo from 'gi://cairo';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
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
    // ── NVIDIA (CUDA + NVENC) ──
    {
        id: 'nvidia-cuda-h264-nvenc',
        label: 'NVIDIA CUDA H.264',
        vendors: [GpuVendor.NVIDIA],
        src: 'capsfilter caps=video/x-raw(memory:CUDAMemory),framerate=FRAMERATE_CAPS ! cudaconvert ! cudadownload ! videoconvert ! queue',
        enc: 'nvh264enc rc-mode=cbr-hq bitrate=40000 ! h264parse',
        elements: ['cudaupload', 'cudaconvert', 'cudadownload', 'nvh264enc'],
        ext: 'mp4',
    },
    {
        id: 'nvidia-gl-h264-nvenc',
        label: 'NVIDIA GL H.264',
        vendors: [GpuVendor.NVIDIA],
        src: 'capsfilter caps=video/x-raw(memory:GLMemory),framerate=FRAMERATE_CAPS ! gldownload ! videoconvert ! queue',
        enc: 'nvh264enc rc-mode=cbr-hq bitrate=40000 ! h264parse',
        elements: ['gldownload', 'nvh264enc'],
        ext: 'mp4',
    },
    // ── AMD + Intel (VAAPI) ──
    {
        id: 'vaapi-h264-lp',
        label: 'VAAPI LP H.264',
        vendors: [GpuVendor.AMD, GpuVendor.INTEL],
        src: 'capsfilter caps=video/x-raw(memory:DMABuf),framerate=FRAMERATE_CAPS',
        enc: 'vaapih264enc rate-control=cbr bitrate=40000 tune=high-compression ! h264parse',
        elements: ['vaapih264enc'],
        lowpower: true,
        ext: 'mp4',
    },
    {
        id: 'vaapi-h264',
        label: 'VAAPI H.264',
        vendors: [GpuVendor.AMD, GpuVendor.INTEL],
        src: 'capsfilter caps=video/x-raw(memory:DMABuf),framerate=FRAMERATE_CAPS',
        enc: 'vaapih264enc rate-control=cbr bitrate=40000 ! h264parse',
        elements: ['vaapih264enc'],
        ext: 'mp4',
    },
    // ── Software fallbacks (any GPU / no GPU) ──
    // Note: the screencast service prepends "capsfilter caps=video/x-raw,max-framerate=F/1"
    // for custom pipelines, which forces video/x-raw (no DMABuf). DMABuf/GL pipelines will
    // fail in the custom path but serve as fallback reference for future direct-pipeline mode.
    {
        id: 'sw-gl-h264-openh264',
        label: 'Software GL H.264',
        vendors: [],
        src: 'capsfilter caps=video/x-raw(memory:DMABuf),framerate=FRAMERATE_CAPS ! glupload ! glcolorconvert ! gldownload ! queue',
        enc: 'openh264enc complexity=high bitrate=40000000 multi-thread=4 ! h264parse',
        elements: ['glupload', 'glcolorconvert', 'gldownload', 'openh264enc'],
        ext: 'mp4',
    },
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
        id: 'sw-gl-vp8',
        label: 'Software GL VP8',
        vendors: [],
        src: 'capsfilter caps=video/x-raw(memory:DMABuf),framerate=FRAMERATE_CAPS ! glupload ! glcolorconvert ! gldownload ! queue',
        enc: 'vp8enc min_quantizer=10 max_quantizer=50 cq_level=13 cpu-used=5 threads=4 deadline=1 static-threshold=1000 buffer-size=20000 ! queue',
        elements: ['glupload', 'glcolorconvert', 'gldownload', 'vp8enc'],
        ext: 'webm',
    },
    {
        id: 'sw-memfd-vp8',
        label: 'Software VP8',
        vendors: [],
        src: 'videoconvert chroma-mode=none dither=none matrix-mode=output-only n-threads=4 ! queue',
        enc: 'vp8enc min_quantizer=10 max_quantizer=50 cq_level=13 cpu-used=5 threads=4 deadline=1 static-threshold=1000 buffer-size=20000 ! queue',
        elements: ['videoconvert', 'vp8enc'],
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

        // Initialize translations
        this.initTranslations();

        console.log('[Big Shot] Extension enabled');
    }

    disable() {
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
    }

    _unpatchScreencast() {
        const screencastProxy = this._screenshotUI?._screencastProxy;
        if (!screencastProxy) return;

        if (this._origScreencast)
            screencastProxy.ScreencastAsync = this._origScreencast;
        if (this._origScreencastArea)
            screencastProxy.ScreencastAreaAsync = this._origScreencastArea;

        this._origScreencast = null;
        this._origScreencastArea = null;
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
        const framerateCaps = `${framerate}/1`;

        // Set framerate in D-Bus options
        options['framerate'] = new GLib.Variant('i', framerate);

        // Show indicator once at the start of cascade
        this._indicator?.onPipelineStarting();

        // Try each config in cascade: GPU hw → VAAPI → Software
        for (let i = 0; i < this._availableConfigs.length; i++) {
            const config = this._availableConfigs[i];
            const pipeline = this._makePipelineString(config, framerateCaps, downsize);
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
                // Service returns [success, actualPath] — rename .undefined → correct ext
                const actualPath = Array.isArray(result) ? result[1] : null;
                if (actualPath)
                    fixFilePath(actualPath, config.ext);
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

    _makePipelineString(config, framerateCaps, downsize) {
        let video = config.src.replace('FRAMERATE_CAPS', framerateCaps);
        video += ` ! ${config.enc}`;

        // Downsize
        if (downsize < 1.0) {
            const scaleStr = `videoscale ! video/x-raw,width=(int)(width*${downsize}),height=(int)(height*${downsize})`;
            video = video.replace('capsfilter', `capsfilter ! ${scaleStr}`);
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
