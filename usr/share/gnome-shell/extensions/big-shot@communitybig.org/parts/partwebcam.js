/**
 * Big Shot — Webcam overlay during screen recording
 *
 * Displays a draggable webcam preview on screen using GStreamer + Clutter,
 * captured by the screencast compositor pipeline.
 * All mask effects (circle, halo, teardrop, vignette, rounded, widescreen,
 * ornate, neon) are
 * implemented as pixel-level alpha/colour operations — no external SVGs.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Screenshot from 'resource:///org/gnome/shell/ui/screenshot.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { PartUI } from './partbase.js';
import { IconLabelButton, PixelConstraint } from './partaudio.js';

// Top-level await would block this module's evaluation, which in turn delays
// every extension that loads after big-shot (dash-to-dock among them) and
// causes the vanilla GNOME dash to flash on cold-boot login. Kick the imports
// off in the background instead and let consumers `await gstReady` on demand.
let Gst = null;
let _GstApp = null;
const gstReady = (async () => {
    try {
        Gst = (await import('gi://Gst?version=1.0')).default;
        _GstApp = (await import('gi://GstApp?version=1.0')).default;
        return true;
    } catch {
        return false;
    }
})();

const WEBCAM_DEFAULT_WIDTH = 320;

export const BUILTIN_MASKS = [
    { id: 'none',             label: () => _('None') },
    { id: 'circle',           label: () => _('Circle') },
    { id: 'halo',             label: () => _('Halo') },
    { id: 'teardrop',         label: () => _('Teardrop') },
    { id: 'spotlight',        label: () => _('Spot') },
    { id: 'squircle',         label: () => _('Rounded') },
    { id: 'widescreen',       label: () => _('Widescreen') },
    { id: 'ornate-frame',     label: () => _('Ornate') },
    { id: 'neon',             label: () => _('Neon Pink') },
    { id: 'neon-blue',        label: () => _('Neon Blue') },
    { id: 'spectrum',         label: () => _('Neon Spectrum') },
];

/** Ring and glow colours for the single-colour neon masks. */
const NEON_PALETTES = Object.freeze({
    neon: { ring: [255, 60, 235], glow: [190, 0, 220] },
    'neon-blue': { ring: [90, 215, 255], glow: [0, 120, 240] },
});

/** Neon Spectrum sweeps these stops around the ring, hue by angle. */
const SPECTRUM_STOPS = Object.freeze([
    [255, 70, 200],   // pink
    [200, 70, 255],   // violet
    [110, 120, 255],  // indigo
    [80, 200, 255],   // cyan
    [200, 70, 255],   // back to violet, so the sweep closes seamlessly
]);

export class PartWebcam extends PartUI {
    constructor(screenshotUI, extension) {
        super(screenshotUI, extension);

        this._enabled = false;
        this._maskId = 'circle';
        this._width = WEBCAM_DEFAULT_WIDTH;

        // Runtime state
        this._pipeline = null;
        this._container = null;
        this._webcamActor = null;
        this._pollTimerId = 0;
        this._sink = null;
        this._coglCtx = null;
        this._frameWidth = 0;
        this._frameHeight = 0;
        this._probing = false;

        // Drag state
        this._dragging = false;
        this._dragOffsetX = 0;
        this._dragOffsetY = 0;
        this._capturedEventId = 0;

        // Saved position
        this._savedX = 80;
        this._savedY = 80;

        this._createButton();
    }

    // =========================================================================
    // Bottom bar button
    // =========================================================================

    _createButton() {
        const typeContainer = this._ui._typeButtonContainer;
        if (!typeContainer)
            return;

        this._webcamButton = new IconLabelButton(
            new Gio.ThemedIcon({ name: 'camera-web-symbolic' }),
            _('Webcam'),
            {
                constraints: new PixelConstraint(),
                style_class: 'screenshot-ui-type-button',
                toggle_mode: true,
                reactive: false,
            },
        );
        this._webcamButton.visible = false;

        this._webcamButton.connect('notify::checked', () => {
            if (this._resettingButton)
                return;
            this.enabled = this._webcamButton.checked;
            if (this._enabled)
                this.startPreview();
            else
                this.stopPreview();
            this._webcamToggledCallback?.(this._enabled);
        });

        typeContainer.add_child(this._webcamButton);

        // Tooltip
        this._webcamTooltip = new Screenshot.Tooltip(this._webcamButton, {
            text: _('Webcam Overlay'),
            style_class: 'screenshot-ui-tooltip',
            visible: false,
        });
        this._ui.add_child(this._webcamTooltip);
    }

    /** Register callback for external listeners (e.g. mask row visibility). */
    onWebcamToggled(callback) {
        this._webcamToggledCallback = callback;
    }

    get enabled() { return this._enabled; }
    set enabled(val) {
        this._enabled = Boolean(val);
        if (!this._enabled)
            this.stopPreview();
    }

    get maskId() { return this._maskId; }
    set maskId(val) {
        this._maskId = val;
        this._updateContainerLayout();
    }

    get width() { return this._width; }
    set width(val) {
        if (this._width === val)
            return;
        this._width = val;
        // If currently previewing, restart with new size
        if (this._enabled && this._pipeline && !this._probing) {
            this._stopPipeline();
            this._startPipeline();
        }
    }

    get masks() {
        return BUILTIN_MASKS.map(mask => ({ ...mask, label: mask.label() }));
    }
    get available() { return Gst !== null; }

    get selectedDevice() { return this._selectedDevice ?? null; }
    set selectedDevice(val) {
        if (this._selectedDevice === val)
            return;
        this._selectedDevice = val;
        // Restart pipeline with new device if currently previewing
        if (this._enabled && this._pipeline && !this._probing) {
            this._stopPipeline();
            this._startPipeline();
        }
    }

    /** Enumerate available webcam devices with human-readable names.
     *  Filters out duplicate V4L2 nodes (metadata/secondary) by keeping
     *  only the first device per unique name (typically the capture node).
     *  Returns [{device: '/dev/video0', name: 'USB Camera', index: 0}, ...] */
    async enumerateDevices() {
        const seen = new Set();
        const cams = [];
        for (let i = 0; i < 10; i++) {
            const dev = `/dev/video${i}`;
            if (!GLib.file_test(dev, GLib.FileTest.EXISTS))
                continue;
            // Read device name from sysfs
            const nameFile = `/sys/class/video4linux/video${i}/name`;
            // TRANSLATORS: %d is the numeric camera device index.
            let name = _('Camera %d').format(i);
            try {
                // Async so probing ten device nodes never blocks the
                // compositor. Wrapped by hand rather than promisifying
                // Gio.File, which is shared with every other extension.
                const contents = await new Promise((resolve, reject) => {
                    Gio.File.new_for_path(nameFile).load_contents_async(
                        null, (file, result) => {
                            try {
                                const [, bytes] =
                                    file.load_contents_finish(result);
                                resolve(bytes);
                            } catch (e) {
                                reject(e);
                            }
                        });
                });
                name = new TextDecoder().decode(contents).trim();
            } catch { /* keep the numbered fallback name */ }

            // Skip duplicate names (secondary V4L2 nodes for same camera)
            if (seen.has(name))
                continue;
            seen.add(name);

            cams.push({ device: dev, name, index: i });
        }
        return cams;
    }

    // =========================================================================
    // Preview lifecycle
    // =========================================================================

    async startPreview() {
        if (!Gst)
            await gstReady;
        if (!this._enabled || !Gst || this._pipeline || !this._isCastMode || !this._ui.visible)
            return;

        this._createOverlay();
        this._startPipeline();
    }

    stopPreview() {
        this._stopPipeline();
        this._destroyOverlay();
    }

    _onModeChanged(isCast) {
        // Show/hide bottom bar button based on screencast mode
        if (this._webcamButton) {
            this._webcamButton.visible = isCast;
            this._webcamButton.reactive = isCast;
        }

        // Don't stop webcam if recording — _finishClosing() resets mode
        // to screenshot, but we need the webcam to persist during recording.
        if (!isCast && (!this._ext || this._ext._recordingState === 'idle'))
            this.stopPreview();
        else if (isCast && this._enabled && this._ui.visible &&
            (!this._ext || this._ext._recordingState === 'idle'))
            this.startPreview();

        this._webcamToggledCallback?.(isCast && this._enabled);
    }

    // =========================================================================
    // Container / overlay geometry helpers
    // =========================================================================

    /** Masks that keep the camera's own aspect instead of a square crop.
     *  Widescreen does its own cropping, so it needs the full frame — boxing
     *  it inside a square would leave a thin strip. */
    static FULL_FRAME_MASKS = new Set(['none', 'widescreen']);

    /** Circle-based masks use a square container inscribed in the shorter dim. */
    _isCircleBased() {
        return !PartWebcam.FULL_FRAME_MASKS.has(this._maskId);
    }

    _containerSize() {
        const fw = this._frameWidth || this._width;
        const fh = this._frameHeight || Math.round(this._width * 3 / 4);
        if (this._isCircleBased()) {
            const s = Math.min(fw, fh);
            return { w: s, h: s };
        }
        return { w: fw, h: fh };
    }

    _actorOffset() {
        const fw = this._frameWidth || this._width;
        const fh = this._frameHeight || Math.round(this._width * 3 / 4);
        if (this._isCircleBased()) {
            const s = Math.min(fw, fh);
            return { x: -(fw - s) / 2, y: -(fh - s) / 2 };
        }
        return { x: 0, y: 0 };
    }

    /** Recalculate container and webcamActor layout when mask changes. */
    _updateContainerLayout() {
        if (!this._container || !this._webcamActor)
            return;

        const { w, h } = this._containerSize();
        const off = this._actorOffset();

        this._container.set_size(w, h);
        this._webcamActor.set_position(off.x, off.y);
        this._webcamActor.set_size(
            this._frameWidth || this._width,
            this._frameHeight || Math.round(this._width * 3 / 4),
        );
    }

    // =========================================================================
    // Overlay
    // =========================================================================

    _createOverlay() {
        if (this._container)
            return;

        const fw = this._frameWidth || this._width;
        const fh = this._frameHeight || Math.round(this._width * 3 / 4);
        const { w, h } = this._containerSize();
        const off = this._actorOffset();

        this._container = new St.Widget({
            reactive: true,
            width: w,
            height: h,
            x: this._savedX,
            y: this._savedY,
            clip_to_allocation: true,
        });

        this._webcamActor = new Clutter.Actor({
            width: fw,
            height: fh,
            x: off.x,
            y: off.y,
        });
        this._container.add_child(this._webcamActor);

        this._setupDrag();

        // Start as child of screenshotUI so the GrabHelper considers
        // clicks on us as "inside" the modal — prevents UI close on click.
        this._overlayParent = 'ui';
        this._ui.add_child(this._container);
    }

    /** Move the overlay to TopChrome (for recording, when UI hides). */
    reparentForRecording() {
        if (!this._container || this._overlayParent === 'chrome')
            return;
        this._savedX = this._container.x;
        this._savedY = this._container.y;
        this._ui.remove_child(this._container);
        // GNOME 50 removed `affectsInputRegion` — passing it throws and
        // aborts the reparent, breaking drag during recording.
        Main.layoutManager.addTopChrome(this._container, {
            trackFullscreen: false,
        });
        this._container.set_position(this._savedX, this._savedY);
        this._overlayParent = 'chrome';

        // Reconnect drag capture to global.stage so dragging works during recording
        this._connectDragCapture(global.stage);
    }

    /** Move the overlay back to the screenshotUI (for preview). */
    reparentForPreview() {
        if (!this._container || this._overlayParent === 'ui')
            return;
        this._savedX = this._container.x;
        this._savedY = this._container.y;
        Main.layoutManager.removeChrome(this._container);
        this._ui.add_child(this._container);
        this._container.set_position(this._savedX, this._savedY);
        this._overlayParent = 'ui';

        // Reconnect drag capture back to screenshotUI
        this._connectDragCapture(this._ui);
    }

    _destroyOverlay() {
        if (this._container) {
            this._savedX = this._container.x;
            this._savedY = this._container.y;
        }

        this._cleanupDrag();

        if (this._container) {
            if (this._overlayParent === 'chrome')
                Main.layoutManager.removeChrome(this._container);
            else
                this._ui.remove_child(this._container);

            this._container.destroy();
            this._container = null;
            this._webcamActor = null;
            this._overlayParent = null;
        }
    }

    // =========================================================================
    // Pixel-level mask functions
    // =========================================================================

    /** Apply the active mask to RGBA pixel data in-place.
     *  All masks work in normalised-radius space:
     *    dist = sqrt((dx/rx)^2 + (dy/ry)^2)
     *  where rx,ry define the mask axes.
     */
    _applyMaskToPixels(data, w, h) {
        switch (this._maskId) {
        case 'none':
            return;
        case 'circle':
            this._maskCircle(data, w, h);
            return;
        case 'halo':
            this._maskHalo(data, w, h);
            return;
        case 'teardrop':
            this._maskTeardrop(data, w, h);
            return;
        case 'spotlight':
            this._maskSpotlight(data, w, h);
            return;
        case 'squircle':
            this._maskRoundedRect(data, w, h, 1.0, 0.14);
            return;
        case 'widescreen':
            this._maskRoundedRect(data, w, h, 16 / 9, 0.08);
            return;
        case 'spectrum':
            this._maskNeon(data, w, h, null);
            return;
        case 'ornate-frame':
            this._maskOrnate(data, w, h);
            return;
        case 'neon':
        case 'neon-blue':
            this._maskNeon(data, w, h, NEON_PALETTES[this._maskId]);
            return;
        }
    }

    /** Sharp circle — r = min(w,h)/2, centred. */
    _maskCircle(data, w, h) {
        const cx = w / 2;
        const cy = h / 2;
        const r = Math.min(w, h) / 2;
        const edge = 0.04;         // 4 % soft edge
        const thresh2 = (1 - edge) * (1 - edge);

        for (let y = 0; y < h; y++) {
            const dy = (y - cy) / r;
            const dy2 = dy * dy;
            if (dy2 > 1.1) {
                // Entire row outside — zero alpha
                for (let x = 0; x < w; x++)
                    data[(y * w + x) * 4 + 3] = 0;
                continue;
            }
            for (let x = 0; x < w; x++) {
                const dx = (x - cx) / r;
                const d2 = dx * dx + dy2;
                if (d2 > 1.0)
                    data[(y * w + x) * 4 + 3] = 0;
                else if (d2 > thresh2) {
                    const d = Math.sqrt(d2);
                    const t = (1.0 - d) / edge;
                    data[(y * w + x) * 4 + 3] = Math.round(
                        data[(y * w + x) * 4 + 3] * t,
                    );
                }
            }
        }
    }

    /** Halo: a thin translucent light band just inside a darkened rim, so the
     *  webcam reads as sitting behind glass. The band stays see-through — it
     *  frames the subject instead of covering them. */
    _maskHalo(data, w, h) {
        const cx = w / 2;
        const cy = h / 2;
        const r = Math.min(w, h) / 2;
        const edge = 0.025;

        const bandInner = 0.855;  // narrow band, hugging the rim
        const bandOuter = 0.965;
        const bandPeak = (bandOuter + bandInner) / 2;
        const bandHalf = (bandOuter - bandInner) / 2;
        const maxWhite = 0.30;    // translucent: content stays visible through it

        const rimStart = 0.955;   // dark outline that defines the edge
        const maxDark = 0.62;

        for (let y = 0; y < h; y++) {
            const dy = (y - cy) / r;
            const dy2 = dy * dy;
            if (dy2 > 1.1) {
                for (let x = 0; x < w; x++)
                    data[(y * w + x) * 4 + 3] = 0;
                continue;
            }
            for (let x = 0; x < w; x++) {
                const dx = (x - cx) / r;
                const d2 = dx * dx + dy2;
                const idx = (y * w + x) * 4;
                if (d2 > 1.0) {
                    data[idx + 3] = 0;
                    continue;
                }
                const d = Math.sqrt(d2);

                if (d > bandInner) {
                    const t = 1 - Math.abs(d - bandPeak) / bandHalf;
                    const mix = maxWhite * Math.max(0, t) ** 1.2;
                    data[idx]     = Math.round(data[idx]     * (1 - mix) + 255 * mix);
                    data[idx + 1] = Math.round(data[idx + 1] * (1 - mix) + 255 * mix);
                    data[idx + 2] = Math.round(data[idx + 2] * (1 - mix) + 255 * mix);
                }

                if (d > rimStart) {
                    const t = (d - rimStart) / (1 - rimStart);
                    const dark = 1 - maxDark * t ** 0.8;
                    data[idx]     = Math.round(data[idx]     * dark);
                    data[idx + 1] = Math.round(data[idx + 1] * dark);
                    data[idx + 2] = Math.round(data[idx + 2] * dark);
                }

                if (d > 1 - edge)
                    data[idx + 3] = Math.round(data[idx + 3] * ((1 - d) / edge));
            }
        }
    }

    /** Rounded rectangle, cropping the sides to `aspect` and rounding the
     *  corners by `radius` (a fraction of the shorter side).
     *
     *  Uses a signed distance field so the straight edges get exactly the
     *  same soft transition as the corners. Testing the corners separately —
     *  as this did before — left the flat sides cut off abruptly, which read
     *  as "only the corners have an effect".
     */
    _maskRoundedRect(data, w, h, aspect, radius) {
        // Largest aspect-correct box that fits the frame, centred.
        let boxW = w;
        let boxH = Math.round(w / aspect);
        if (boxH > h) {
            boxH = h;
            boxW = Math.round(h * aspect);
        }
        const cx = w / 2;
        const cy = h / 2;
        const rad = Math.min(boxW, boxH) * radius;
        // Half-extents of the straight part, i.e. the box minus its corners.
        const halfW = boxW / 2 - rad;
        const halfH = boxH / 2 - rad;
        const edge = Math.max(1.2, Math.min(boxW, boxH) * 0.012);

        const smooth = (t) => {
            const c = Math.min(1, Math.max(0, t));
            return c * c * (3 - 2 * c);
        };

        for (let y = 0; y < h; y++) {
            const qy = Math.abs(y + 0.5 - cy) - halfH;
            for (let x = 0; x < w; x++) {
                const qx = Math.abs(x + 0.5 - cx) - halfW;
                // Signed distance to the rounded-box outline: < 0 inside.
                const dist = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
                    Math.min(Math.max(qx, qy), 0) - rad;
                const idx = (y * w + x) * 4;
                if (dist >= 0) {
                    data[idx + 3] = 0;
                } else if (dist > -edge) {
                    data[idx + 3] = Math.round(
                        data[idx + 3] * smooth(-dist / edge));
                }
            }
        }
    }

    /** Spotlight / vignette: circle with darkened edges inside. */
    _maskSpotlight(data, w, h) {
        const cx = w / 2;
        const cy = h / 2;
        const r = Math.min(w, h) / 2;

        for (let y = 0; y < h; y++) {
            const dy = (y - cy) / r;
            const dy2 = dy * dy;
            if (dy2 > 1.1) {
                for (let x = 0; x < w; x++)
                    data[(y * w + x) * 4 + 3] = 0;
                continue;
            }
            for (let x = 0; x < w; x++) {
                const dx = (x - cx) / r;
                const d2 = dx * dx + dy2;
                const idx = (y * w + x) * 4;
                if (d2 > 1.0) {
                    data[idx + 3] = 0;
                } else {
                    const d = Math.sqrt(d2);
                    // Darken edges: brightness = 1 in centre → 0.15 at rim
                    let brightness;
                    if (d < 0.5)
                        brightness = 1.0;
                    else
                        brightness = 1.0 - 0.85 * ((d - 0.5) / 0.5) ** 1.6;
                    data[idx]     = Math.round(data[idx]     * brightness);
                    data[idx + 1] = Math.round(data[idx + 1] * brightness);
                    data[idx + 2] = Math.round(data[idx + 2] * brightness);
                    // Smooth alpha at very edge
                    if (d > 0.96)
                        data[idx + 3] = Math.round(data[idx + 3] * ((1 - d) / 0.04));
                }
            }
        }
    }

    /** Ornate: circle with BigCommunity gradient border (blue→purple→pink). */
    _maskOrnate(data, w, h) {
        const cx = w / 2;
        const cy = h / 2;
        const r = Math.min(w, h) / 2;

        // Border ring (normalised to radius)
        const innerR = 0.946;
        const outerR = 1.0;
        const aa = 0.012;

        // Circular gradient stops (seamless loop around the circle):
        //  Left=Blue, Top=Purple, Right=Pink, Bottom=Purple, back to Blue
        // Angle normalised [0,1): 0=left, 0.25=top, 0.5=right, 0.75=bottom
        const gStops = [
            { a: 0.00, r: 59,  g: 130, b: 246 },  // blue  (left)
            { a: 0.25, r: 139, g: 92,  b: 246 },  // purple (top)
            { a: 0.50, r: 236, g: 72,  b: 153 },  // pink  (right)
            { a: 0.75, r: 139, g: 92,  b: 246 },  // purple (bottom)
            { a: 1.00, r: 59,  g: 130, b: 246 },  // blue  (left, wrap)
        ];

        for (let y = 0; y < h; y++) {
            const dy = (y - cy) / r;
            const dy2 = dy * dy;
            if (dy2 > (outerR + aa) * (outerR + aa)) {
                for (let x = 0; x < w; x++)
                    data[(y * w + x) * 4 + 3] = 0;
                continue;
            }
            for (let x = 0; x < w; x++) {
                const dx = (x - cx) / r;
                const d2 = dx * dx + dy2;
                const idx = (y * w + x) * 4;
                const d = Math.sqrt(d2);

                if (d > outerR + aa) {
                    data[idx + 3] = 0;
                } else if (d > innerR - aa) {
                    // Angular position [0,1)
                    const angle = (Math.atan2(y - cy, x - cx) / Math.PI + 1) / 2;

                    // Find surrounding gradient stops and interpolate
                    let cR, cG, cB;
                    for (let i = 0; i < gStops.length - 1; i++) {
                        if (angle >= gStops[i].a && angle <= gStops[i + 1].a) {
                            const span = gStops[i + 1].a - gStops[i].a;
                            const t = (angle - gStops[i].a) / span;
                            cR = gStops[i].r * (1 - t) + gStops[i + 1].r * t;
                            cG = gStops[i].g * (1 - t) + gStops[i + 1].g * t;
                            cB = gStops[i].b * (1 - t) + gStops[i + 1].b * t;
                            break;
                        }
                    }

                    // Blend factor: 0 = webcam, 1 = gradient
                    let blend = 1.0;
                    if (d < innerR)
                        blend = (d - (innerR - aa)) / aa;

                    // Outer edge alpha
                    let alpha = 255;
                    if (d > outerR)
                        alpha = Math.round(255 * Math.max(0, (outerR + aa - d) / aa));

                    data[idx]     = Math.round(data[idx]     * (1 - blend) + cR * blend);
                    data[idx + 1] = Math.round(data[idx + 1] * (1 - blend) + cG * blend);
                    data[idx + 2] = Math.round(data[idx + 2] * (1 - blend) + cB * blend);
                    data[idx + 3] = Math.min(data[idx + 3], alpha);
                }
                // else: inside inner circle — keep webcam pixels unchanged
            }
        }
    }

    /** Sample the spectrum gradient at an angle, in radians. */
    _spectrumColour(angle) {
        const span = SPECTRUM_STOPS.length - 1;
        const t = ((angle / (Math.PI * 2)) % 1 + 1) % 1 * span;
        const i = Math.min(span - 1, Math.floor(t));
        const f = t - i;
        const a = SPECTRUM_STOPS[i];
        const b = SPECTRUM_STOPS[i + 1];
        return [
            a[0] + (b[0] - a[0]) * f,
            a[1] + (b[1] - a[1]) * f,
            a[2] + (b[2] - a[2]) * f,
        ];
    }

    /** Neon ring with outer glow.
     *
     *  `palette` null selects the angular spectrum sweep instead of a single
     *  colour. Every transition is smoothed over one pixel — measured as
     *  1/r in the normalised space the mask works in — because a fixed
     *  fraction of the radius is thinner than a pixel on a small preview and
     *  that is what made the ring look stair-stepped.
     */
    _maskNeon(data, w, h, palette = NEON_PALETTES.neon) {
        const cx = w / 2;
        const cy = h / 2;
        const r = Math.min(w, h) / 2;
        const px = 1 / r;                     // one pixel, normalised
        const aa = Math.max(px * 1.5, 0.006);  // anti-alias width

        // Ring thick enough to survive small previews.
        const ringCenter = 0.90;
        const ringHalf = Math.max(0.026, px * 2.5);
        const ringInner = ringCenter - ringHalf;
        const ringOuter = ringCenter + ringHalf;
        const glowInner = ringInner - 0.16;   // soft bloom on the inside
        const glowOuter = 1.0;                // fades out by the crop edge

        const smooth = (t) => {
            const c = Math.min(1, Math.max(0, t));
            return c * c * (3 - 2 * c);
        };

        for (let y = 0; y < h; y++) {
            const dy = (y - cy) / r;
            const dy2 = dy * dy;
            if (dy2 > 1.2) {
                for (let x = 0; x < w; x++)
                    data[(y * w + x) * 4 + 3] = 0;
                continue;
            }
            for (let x = 0; x < w; x++) {
                const dx = (x - cx) / r;
                const d = Math.sqrt(dx * dx + dy2);
                const idx = (y * w + x) * 4;

                const [cR, cG, cB] = palette
                    ? palette.ring
                    : this._spectrumColour(Math.atan2(dy, dx) + Math.PI);
                const [gR, gG, gB] = palette ? palette.glow : [cR * 0.75, cG * 0.75, cB * 0.9];

                if (d > glowOuter + aa) {
                    data[idx + 3] = 0;
                    continue;
                }

                // Ring intensity: 1 at the centre line, easing to 0 over aa.
                const ring = 1 - smooth((Math.abs(d - ringCenter) - ringHalf) / aa + 1);

                if (ring > 0.001) {
                    // White-hot core blended towards the neon colour outwards.
                    const core = ring ** 2.2;
                    const rr = cR + (255 - cR) * core * 0.85;
                    const rg = cG + (255 - cG) * core * 0.85;
                    const rb = cB + (255 - cB) * core * 0.85;
                    data[idx]     = Math.round(data[idx]     * (1 - ring) + rr * ring);
                    data[idx + 1] = Math.round(data[idx + 1] * (1 - ring) + rg * ring);
                    data[idx + 2] = Math.round(data[idx + 2] * (1 - ring) + rb * ring);
                    data[idx + 3] = Math.max(data[idx + 3], Math.round(255 * ring));
                }

                if (d > ringOuter) {
                    // Outside the ring there is no webcam content: paint glow
                    // over transparency so it blends with whatever is behind.
                    const t = (d - ringOuter) / (glowOuter - ringOuter);
                    const glow = (1 - smooth(t)) ** 1.6;
                    const alpha = Math.round(200 * glow);
                    if (ring <= 0.001) {
                        data[idx]     = Math.round(gR);
                        data[idx + 1] = Math.round(gG);
                        data[idx + 2] = Math.round(gB);
                        data[idx + 3] = alpha;
                    } else {
                        data[idx + 3] = Math.max(data[idx + 3], alpha);
                    }
                } else if (d > glowInner && ring <= 0.001) {
                    // Inner bloom tinting the webcam edge.
                    const t = (d - glowInner) / (ringInner - glowInner);
                    const bloom = smooth(t) * 0.5;
                    data[idx]     = Math.round(data[idx]     * (1 - bloom) + gR * bloom);
                    data[idx + 1] = Math.round(data[idx + 1] * (1 - bloom) + gG * bloom);
                    data[idx + 2] = Math.round(data[idx + 2] * (1 - bloom) + gB * bloom);
                }
            }
        }
    }

    /** Teardrop: the streaming-overlay frame — a circle whose bottom-right
     *  corner stays square, giving the drop/speech-bubble silhouette, wrapped
     *  in a thin white border. The distance field is evaluated per quadrant so
     *  the border keeps an even thickness all the way around the join.
     */
    _maskTeardrop(data, w, h) {
        const cx = w / 2;
        const cy = h / 2;
        const r = Math.min(w, h) / 2;
        const aa = Math.max(1.2, r * 0.012);
        const border = Math.max(2, r * 0.05);   // thin, like the reference

        const smooth = (t) => {
            const c = Math.min(1, Math.max(0, t));
            return c * c * (3 - 2 * c);
        };

        for (let y = 0; y < h; y++) {
            const py = y + 0.5 - cy;
            for (let x = 0; x < w; x++) {
                const px = x + 0.5 - cx;
                const idx = (y * w + x) * 4;

                // Bottom-right quadrant is a square corner; the rest is round.
                const dist = (px >= 0 && py >= 0)
                    ? Math.max(px - r, py - r)
                    : Math.hypot(px, py) - r;

                if (dist >= 0) {
                    data[idx + 3] = 0;
                    continue;
                }
                // White band hugging the inside of the outline.
                const white = smooth((dist + border) / border);
                if (white > 0.001) {
                    data[idx]     = Math.round(data[idx]     * (1 - white) + 255 * white);
                    data[idx + 1] = Math.round(data[idx + 1] * (1 - white) + 255 * white);
                    data[idx + 2] = Math.round(data[idx + 2] * (1 - white) + 255 * white);
                }
                if (dist > -aa)
                    data[idx + 3] = Math.round(data[idx + 3] * smooth(-dist / aa));
            }
        }
    }

    /** Check if stage coordinates are within the container's bounds. */
    _hitTestContainer(stageX, stageY) {
        if (!this._container)
            return false;
        const [ok, lx, ly] = this._container.transform_stage_point(stageX, stageY);
        return ok && lx >= 0 && ly >= 0 &&
               lx <= this._container.width && ly <= this._container.height;
    }

    _setupDrag() {
        if (!this._container)
            return;

        // All drag events (press, motion, release) are handled via
        // captured-event on the parent scope. This avoids relying on
        // button-press-event delivery to the container, which can fail
        // when the overlay is reparented to TopChrome during recording.
        this._connectDragCapture(this._ui);
    }

    /** Handler for all drag events via captured-event on the parent scope.
     *  Uses manual hit-testing so drag works in both screenshotUI and
     *  TopChrome (recording) contexts. */
    _onDragCapturedEvent(_actor, event) {
        const type = event.type();

        // Start drag on button press if click is on the webcam container
        if (type === Clutter.EventType.BUTTON_PRESS) {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;

            const [mx, my] = event.get_coords();
            const hit = this._hitTestContainer(mx, my);
            if (hit) {
                this._dragging = true;
                this._dragOffsetX = this._container.x - mx;
                this._dragOffsetY = this._container.y - my;
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }

        if (!this._dragging)
            return Clutter.EVENT_PROPAGATE;

        if (type === Clutter.EventType.MOTION) {
            const [mx, my] = event.get_coords();
            this._container.set_position(
                mx + this._dragOffsetX,
                my + this._dragOffsetY,
            );
            return Clutter.EVENT_STOP;
        }

        if (type === Clutter.EventType.BUTTON_RELEASE) {
            this._dragging = false;
            this._savedX = this._container.x;
            this._savedY = this._container.y;
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    /** Connect drag capture to a given actor (screenshotUI or global.stage). */
    _connectDragCapture(actor) {
        this._disconnectDragCapture();
        this._dragCaptureActor = actor;
        this._dragCapturedId = actor.connect('captured-event',
            this._onDragCapturedEvent.bind(this));
    }

    /** Disconnect the current drag capture listener. */
    _disconnectDragCapture() {
        if (this._dragCapturedId && this._dragCaptureActor) {
            this._dragCaptureActor.disconnect(this._dragCapturedId);
            this._dragCapturedId = 0;
            this._dragCaptureActor = null;
        }
    }

    _cleanupDrag() {
        this._dragging = false;
        this._disconnectDragCapture();
    }

    // =========================================================================
    // GStreamer pipeline
    // =========================================================================

    _findWebcamDevices() {
        const devices = [];
        for (let i = 0; i < 10; i++) {
            const path = `/dev/video${i}`;
            if (GLib.file_test(path, GLib.FileTest.EXISTS))
                devices.push(path);
        }
        return devices;
    }

    /** Try to start a v4l2src probe pipeline on the given device.
     *  Returns true if the pipeline started successfully. */
    _tryV4l2Device(device) {
        try {
            const probeStr = [
                `v4l2src device=${device} !`,
                'videoconvert !',
                'video/x-raw,format=RGBA !',
                'appsink name=sink max-buffers=1 drop=true sync=false',
            ].join(' ');

            const pipeline = Gst.parse_launch(probeStr);
            const ret = pipeline.set_state(Gst.State?.PAUSED ?? 2);
            const FAILURE = Gst.StateChangeReturn?.FAILURE ?? 0;

            if (ret === FAILURE) {
                pipeline.set_state(Gst.State?.NULL ?? 1);
                return false;
            }

            this._pipeline = pipeline;
            this._sink = pipeline.get_by_name('sink');
            this._pipeline.set_state(Gst.State?.PLAYING ?? 4);
            return true;
        } catch {
            return false;
        }
    }

    /** Try pipewiresrc as a fallback for cameras accessible via PipeWire. */
    _tryPipeWireSrc() {
        try {
            const probeStr = [
                'pipewiresrc !',
                'videoconvert !',
                'video/x-raw,format=RGBA !',
                'appsink name=sink max-buffers=1 drop=true sync=false',
            ].join(' ');

            const pipeline = Gst.parse_launch(probeStr);
            const ret = pipeline.set_state(Gst.State?.PAUSED ?? 2);
            const FAILURE = Gst.StateChangeReturn?.FAILURE ?? 0;

            if (ret === FAILURE) {
                pipeline.set_state(Gst.State?.NULL ?? 1);
                return false;
            }

            this._pipeline = pipeline;
            this._sink = pipeline.get_by_name('sink');
            this._pipeline.set_state(Gst.State?.PLAYING ?? 4);
            return true;
        } catch {
            return false;
        }
    }

    _startPipeline() {
        if (!Gst || this._pipeline)
            return;

        try {
            Gst.init([]);
        } catch {
            // Already initialized
        }

        let started = false;

        // If user selected a specific device, try only that one
        if (this._selectedDevice) {
            if (this._tryV4l2Device(this._selectedDevice)) {
                started = true;
                this._activeDevice = this._selectedDevice;
            }
        }

        // Otherwise try each /dev/video* device, validating capture capability
        if (!started) {
            const devices = this._findWebcamDevices();
            for (const device of devices) {
                if (this._tryV4l2Device(device)) {
                    started = true;
                    this._activeDevice = device;
                    break;
                }
            }
        }

        // Fallback: try PipeWire source
        if (!started) {
            if (this._tryPipeWireSrc()) {
                started = true;
                this._activeDevice = 'pipewire';
            }
        }

        if (!started) {
            console.warn('[Big Shot Webcam] No usable webcam device found');
            this._onWebcamFailed();
            return;
        }

        // Phase 1: Probe native resolution
        this._probing = true;
        this._probeStartTime = GLib.get_monotonic_time();

        this._pollTimerId = this._addTimeout(50, () => {
            return this._probeFrame(this._activeDevice);
        }, GLib.PRIORITY_HIGH);
    }

    /** Called when no webcam device could be started. Resets UI state. */
    _onWebcamFailed() {
        this._probing = false;
        this._pipeline = null;
        this._sink = null;
        this._enabled = false;
        this._resettingButton = true;
        if (this._webcamButton)
            this._webcamButton.checked = false;
        this._resettingButton = false;
        this._destroyOverlay();
        this._webcamToggledCallback?.(false);
    }

    /** Read first frame to detect native webcam resolution, then start render pipeline. */
    _probeFrame(device) {
        if (!this._sink)
            return GLib.SOURCE_REMOVE;

        // Timeout: abort if no frame within 5 seconds
        const elapsed = (GLib.get_monotonic_time() - this._probeStartTime) / 1e6;
        if (elapsed > 5.0) {
            console.warn('[Big Shot Webcam] Probe timed out — no frames received');
            this._pollTimerId = 0;
            this._stopPipeline();
            this._onWebcamFailed();
            return GLib.SOURCE_REMOVE;
        }

        const sample = this._sink.try_pull_sample(0);
        if (!sample)
            return GLib.SOURCE_CONTINUE;

        // Read native dimensions
        const caps = sample.get_caps();
        const struct = caps.get_structure(0);
        const [, nw] = struct.get_int('width');
        const [, nh] = struct.get_int('height');

        // Stop probe pipeline
        this._pollTimerId = 0;
        this._pipeline.set_state(Gst.State?.NULL ?? 1);
        this._pipeline = null;
        this._sink = null;
        this._probing = false;

        // Calculate target dimensions preserving aspect ratio
        const targetW = this._width;
        const targetH = Math.round(targetW * nh / nw);
        this._frameWidth = targetW;
        this._frameHeight = targetH;

        // Recalculate container/actor geometry
        this._updateContainerLayout();

        // Phase 2: Start rendering pipeline with correct dimensions
        this._startRenderPipeline(device, targetW, targetH, nw, nh);
        return GLib.SOURCE_REMOVE;
    }

    _startRenderPipeline(device, w, h, nativeW, nativeH) {
        try {
            const srcElement = device === 'pipewire'
                ? 'pipewiresrc !'
                : `v4l2src device=${device} !`;

            // Lock source to the probed native resolution so that
            // videoscale always receives the expected aspect ratio
            // instead of a different v4l2 mode negotiated by GStreamer.
            const nativeCaps = (nativeW && nativeH)
                ? `video/x-raw,width=${nativeW},height=${nativeH} !`
                : '';

            const pipelineStr = [
                srcElement,
                'videoflip method=horizontal-flip !',
                `videoconvert ! ${nativeCaps} videoscale !`,
                `video/x-raw,format=RGBA,width=${w},height=${h} !`,
                'appsink name=sink max-buffers=1 drop=true sync=false',
            ].join(' ');

            this._pipeline = Gst.parse_launch(pipelineStr);
            this._sink = this._pipeline.get_by_name('sink');

            const ret = this._pipeline.set_state(Gst.State?.PLAYING ?? 4);
            const FAILURE = Gst.StateChangeReturn?.FAILURE ?? 0;
            if (ret === FAILURE) {
                console.warn('[Big Shot Webcam] Render pipeline failed to start');
                this._pipeline.set_state(Gst.State?.NULL ?? 1);
                this._pipeline = null;
                this._sink = null;
                this._onWebcamFailed();
                return;
            }

            this._pollTimerId = this._addTimeout(33, () => {
                this._pollFrame();
                return GLib.SOURCE_CONTINUE;
            }, GLib.PRIORITY_HIGH);
        } catch (e) {
            console.error(`[Big Shot Webcam] Pipeline failed: ${e.message}`);
            this._pipeline = null;
            this._onWebcamFailed();
        }
    }

    _pollFrame() {
        if (!this._sink || !this._webcamActor)
            return;

        try {
            const sample = this._sink.try_pull_sample(0);
            if (!sample)
                return;

            const fw = this._frameWidth;
            const fh = this._frameHeight;

            const buffer = sample.get_buffer();
            const [success, mapInfo] = buffer.map(Gst.MapFlags?.READ ?? 1);
            if (!success)
                return;

            try {
                // Copy pixel data so we can modify for masking
                const data = new Uint8Array(mapInfo.data);

                // Apply pixel-level mask
                this._applyMaskToPixels(data, fw, fh);

                if (!this._coglCtx) {
                    const backend = Clutter.get_default_backend();
                    this._coglCtx = backend.get_cogl_context();
                }

                const texture = Cogl.Texture2D.new_from_data(
                    this._coglCtx,
                    fw, fh,
                    Cogl.PixelFormat.RGBA_8888,
                    fw * 4,
                    data,
                );

                if (texture) {
                    const content = Clutter.TextureContent.new_from_texture(
                        texture, null,
                    );
                    this._webcamActor.set_content(content);
                }
            } finally {
                buffer.unmap(mapInfo);
            }
        } catch {
            // Skip frame on error
        }
    }

    _stopPipeline() {
        if (this._pollTimerId) {
            this._removeSource(this._pollTimerId);
            this._pollTimerId = 0;
        }
        this._sink = null;
        this._probing = false;
        this._activeDevice = null;
        this._probeStartTime = 0;

        if (this._pipeline) {
            try {
                this._pipeline.set_state(Gst.State?.NULL ?? 1);
            } catch {
                // Ignore cleanup errors
            }
            this._pipeline = null;
        }
    }

    // =========================================================================
    // Cleanup
    // =========================================================================

    destroy() {
        this.stopPreview();

        if (this._webcamTooltip) {
            const p = this._webcamTooltip.get_parent();
            if (p) p.remove_child(this._webcamTooltip);
            this._webcamTooltip.destroy();
            this._webcamTooltip = null;
        }
        if (this._webcamButton) {
            const p = this._webcamButton.get_parent();
            if (p) p.remove_child(this._webcamButton);
            this._webcamButton.destroy();
            this._webcamButton = null;
        }

        super.destroy();
    }
}
