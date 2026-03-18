/**
 * Big Shot — Webcam overlay during screen recording
 *
 * Displays a draggable webcam preview on screen using GStreamer + Clutter,
 * captured by the screencast compositor pipeline.
 * All mask effects (circle, oval, soft, vignette, ornate, rings) are
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

let Gst = null;
let _GstApp = null;
try {
    Gst = (await import('gi://Gst?version=1.0')).default;
    _GstApp = (await import('gi://GstApp?version=1.0')).default;
} catch {
    // GStreamer not available
}

const WEBCAM_DEFAULT_WIDTH = 200;

const BUILTIN_MASKS = [
    { id: 'none',             label: 'None' },
    { id: 'circle',           label: 'Circle' },
    { id: 'ellipse',          label: 'Oval' },
    { id: 'soft-circle',      label: 'Soft' },
    { id: 'spotlight',        label: 'Spot' },
    { id: 'ornate-frame',     label: 'Ornate' },
    { id: 'concentric-rings', label: 'Rings' },
];

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
            }
        );
        this._webcamButton.visible = false;

        this._webcamButton.connect('notify::checked', () => {
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
        this._enabled = !!val;
        if (!this._enabled)
            this.stopPreview();
    }

    get maskId() { return this._maskId; }
    set maskId(val) {
        this._maskId = val;
        this._updateContainerLayout();
    }

    get masks() { return BUILTIN_MASKS; }
    get available() { return Gst !== null; }

    // =========================================================================
    // Preview lifecycle
    // =========================================================================

    startPreview() {
        if (!this._enabled || !Gst || this._pipeline || !this._isCastMode)
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
    }

    // =========================================================================
    // Container / overlay geometry helpers
    // =========================================================================

    /** Circle-based masks use a square container inscribed in the shorter dim. */
    _isCircleBased() {
        return this._maskId !== 'none' && this._maskId !== 'ellipse';
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
            this._frameHeight || Math.round(this._width * 3 / 4)
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
        Main.layoutManager.addTopChrome(this._container, {
            affectsInputRegion: true,
            trackFullscreen: false,
        });
        this._container.set_position(this._savedX, this._savedY);
        this._overlayParent = 'chrome';
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
     *  where rx,ry define the ellipse axes.
     */
    _applyMaskToPixels(data, w, h) {
        switch (this._maskId) {
        case 'none':
            return;
        case 'circle':
            this._maskCircle(data, w, h);
            return;
        case 'ellipse':
            this._maskEllipse(data, w, h);
            return;
        case 'soft-circle':
            this._maskSoft(data, w, h);
            return;
        case 'spotlight':
            this._maskSpotlight(data, w, h);
            return;
        case 'ornate-frame':
            this._maskOrnate(data, w, h);
            return;
        case 'concentric-rings':
            this._maskRings(data, w, h);
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
                        data[(y * w + x) * 4 + 3] * t
                    );
                }
            }
        }
    }

    /** Ellipse filling the full frame. */
    _maskEllipse(data, w, h) {
        const cx = w / 2;
        const cy = h / 2;
        const rx = cx;
        const ry = cy;
        const edge = 0.04;
        const thresh2 = (1 - edge) * (1 - edge);

        for (let y = 0; y < h; y++) {
            const dy = (y - cy) / ry;
            const dy2 = dy * dy;
            for (let x = 0; x < w; x++) {
                const dx = (x - cx) / rx;
                const d2 = dx * dx + dy2;
                if (d2 > 1.0)
                    data[(y * w + x) * 4 + 3] = 0;
                else if (d2 > thresh2) {
                    const d = Math.sqrt(d2);
                    const t = (1.0 - d) / edge;
                    data[(y * w + x) * 4 + 3] = Math.round(
                        data[(y * w + x) * 4 + 3] * t
                    );
                }
            }
        }
    }

    /** Circle with wide feathered edge. */
    _maskSoft(data, w, h) {
        const cx = w / 2;
        const cy = h / 2;
        const r = Math.min(w, h) / 2;
        const edge = 0.40;
        const thresh2 = (1 - edge) * (1 - edge);

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
                if (d2 > 1.0)
                    data[(y * w + x) * 4 + 3] = 0;
                else if (d2 > thresh2) {
                    const d = Math.sqrt(d2);
                    const t = (1.0 - d) / edge;
                    // Quadratic ease-in for softer gradient
                    data[(y * w + x) * 4 + 3] = Math.round(
                        data[(y * w + x) * 4 + 3] * t * t
                    );
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

        // BigCommunity gradient stops (angular gradient around the circle)
        // Blue #3B82F6 → Purple #8B5CF6 → Pink #EC4899
        const stops = [
            { angle: 0,     r: 59,  g: 130, b: 246 },  // blue
            { angle: 0.5,   r: 139, g: 92,  b: 246 },  // purple
            { angle: 1.0,   r: 236, g: 72,  b: 153 },  // pink
        ];

        for (let y = 0; y < h; y++) {
            const dy = (y - cy) / r;
            const dy2 = dy * dy;
            if (dy2 > 1.05) {
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
                    if (d > 0.82) {
                        // Border zone — angular gradient
                        const angle = (Math.atan2(y - cy, x - cx) / Math.PI + 1) / 2;
                        // Interpolate gradient colour based on angle
                        let cR, cG, cB;
                        if (angle < 0.5) {
                            const t = angle / 0.5;
                            cR = Math.round(stops[0].r * (1 - t) + stops[1].r * t);
                            cG = Math.round(stops[0].g * (1 - t) + stops[1].g * t);
                            cB = Math.round(stops[0].b * (1 - t) + stops[1].b * t);
                        } else {
                            const t = (angle - 0.5) / 0.5;
                            cR = Math.round(stops[1].r * (1 - t) + stops[2].r * t);
                            cG = Math.round(stops[1].g * (1 - t) + stops[2].g * t);
                            cB = Math.round(stops[1].b * (1 - t) + stops[2].b * t);
                        }
                        const blend = Math.min(1.0, (d - 0.82) / 0.08);
                        data[idx]     = Math.round(data[idx]     * (1 - blend) + cR * blend);
                        data[idx + 1] = Math.round(data[idx + 1] * (1 - blend) + cG * blend);
                        data[idx + 2] = Math.round(data[idx + 2] * (1 - blend) + cB * blend);
                        // Smooth alpha at outer edge
                        if (d > 0.96)
                            data[idx + 3] = Math.round(255 * ((1.0 - d) / 0.04));
                    }
                }
            }
        }
    }

    /** Concentric rings: circle with semi-transparent ring bands. */
    _maskRings(data, w, h) {
        const cx = w / 2;
        const cy = h / 2;
        const r = Math.min(w, h) / 2;
        // Ring positions (normalised to radius)
        const rings = [0.35, 0.55, 0.75, 0.92];
        const rw = 0.03;  // ring half-width

        for (let y = 0; y < h; y++) {
            const dy = (y - cy) / r;
            const dy2 = dy * dy;
            if (dy2 > 1.05) {
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
                    // Soft outer edge
                    if (d > 0.96)
                        data[idx + 3] = Math.round(data[idx + 3] * ((1 - d) / 0.04));
                    // Draw ring overlays (semi-transparent white)
                    for (const rp of rings) {
                        const dist = Math.abs(d - rp);
                        if (dist < rw) {
                            const intensity = 0.45 * (1 - dist / rw);
                            data[idx]     = Math.min(255, Math.round(data[idx]     + (255 - data[idx])     * intensity));
                            data[idx + 1] = Math.min(255, Math.round(data[idx + 1] + (255 - data[idx + 1]) * intensity));
                            data[idx + 2] = Math.min(255, Math.round(data[idx + 2] + (255 - data[idx + 2]) * intensity));
                        }
                    }
                }
            }
        }
    }

    // =========================================================================
    // Drag handling
    // =========================================================================

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

        // Press: detect on the container itself (reactive St.Widget)
        this._container.connect('button-press-event', (_actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;

            const [mx, my] = event.get_coords();
            this._dragging = true;
            this._dragOffsetX = this._container.x - mx;
            this._dragOffsetY = this._container.y - my;
            return Clutter.EVENT_STOP;
        });

        // Motion & release: listen on screenshotUI via captured-event
        // so drag continues even if the pointer leaves the container.
        this._dragCapturedId = this._ui.connect('captured-event', (_actor, event) => {
            if (!this._dragging)
                return Clutter.EVENT_PROPAGATE;

            const type = event.type();

            if (type === Clutter.EventType.MOTION) {
                const [mx, my] = event.get_coords();
                this._container.set_position(
                    mx + this._dragOffsetX,
                    my + this._dragOffsetY
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
        });
    }

    _cleanupDrag() {
        this._dragging = false;
        if (this._dragCapturedId) {
            this._ui.disconnect(this._dragCapturedId);
            this._dragCapturedId = 0;
        }
    }

    // =========================================================================
    // GStreamer pipeline
    // =========================================================================

    _findWebcamDevice() {
        for (let i = 0; i < 10; i++) {
            const path = `/dev/video${i}`;
            if (GLib.file_test(path, GLib.FileTest.EXISTS))
                return path;
        }
        return null;
    }

    _startPipeline() {
        if (!Gst || this._pipeline)
            return;

        try {
            Gst.init([]);
        } catch {
            // Already initialized
        }

        const device = this._findWebcamDevice();
        if (!device) {
            console.warn('[Big Shot Webcam] No webcam device found');
            return;
        }

        // Phase 1: Probe native resolution (no videoscale)
        this._probing = true;
        try {
            const probeStr = [
                `v4l2src device=${device} !`,
                'videoconvert !',
                'video/x-raw,format=RGBA !',
                'appsink name=sink max-buffers=1 drop=true sync=false',
            ].join(' ');

            this._pipeline = Gst.parse_launch(probeStr);
            this._sink = this._pipeline.get_by_name('sink');
            this._pipeline.set_state(Gst.State?.PLAYING ?? 4);

            this._pollTimerId = GLib.timeout_add(GLib.PRIORITY_HIGH, 50, () => {
                return this._probeFrame(device);
            });
        } catch (e) {
            console.error(`[Big Shot Webcam] Probe failed: ${e.message}`);
            this._probing = false;
            this._pipeline = null;
        }
    }

    /** Read first frame to detect native webcam resolution, then start render pipeline. */
    _probeFrame(device) {
        if (!this._sink)
            return GLib.SOURCE_REMOVE;

        const sample = this._sink.try_pull_sample(0);
        if (!sample)
            return GLib.SOURCE_CONTINUE;

        // Read native dimensions
        const caps = sample.get_caps();
        const struct = caps.get_structure(0);
        const [, nw] = struct.get_int('width');
        const [, nh] = struct.get_int('height');

        // Stop probe pipeline
        if (this._pollTimerId) {
            GLib.source_remove(this._pollTimerId);
            this._pollTimerId = 0;
        }
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
        this._startRenderPipeline(device, targetW, targetH);
        return GLib.SOURCE_REMOVE;
    }

    _startRenderPipeline(device, w, h) {
        try {
            const pipelineStr = [
                `v4l2src device=${device} !`,
                'videoflip method=horizontal-flip !',
                'videoconvert ! videoscale !',
                `video/x-raw,format=RGBA,width=${w},height=${h} !`,
                'appsink name=sink max-buffers=1 drop=true sync=false',
            ].join(' ');

            this._pipeline = Gst.parse_launch(pipelineStr);
            this._sink = this._pipeline.get_by_name('sink');
            this._pipeline.set_state(Gst.State?.PLAYING ?? 4);

            this._pollTimerId = GLib.timeout_add(GLib.PRIORITY_HIGH, 33, () => {
                this._pollFrame();
                return GLib.SOURCE_CONTINUE;
            });
        } catch (e) {
            console.error(`[Big Shot Webcam] Pipeline failed: ${e.message}`);
            this._pipeline = null;
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
                    data
                );

                if (texture) {
                    const content = Clutter.TextureContent.new_from_texture(
                        texture, null
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
            GLib.source_remove(this._pollTimerId);
            this._pollTimerId = 0;
        }
        this._sink = null;
        this._probing = false;

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
