/**
 * Big Shot — Magnifier / Zoom Lens for pixel-perfect area selection
 *
 * SPDX-License-Identifier: MIT
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { PartUI } from './partbase.js';

// Cairo operators (numeric, same pattern as overlay.js — avoids importing cairo).
const CAIRO_OPERATOR_CLEAR = 0;
const CAIRO_OPERATOR_OVER  = 2;

// Lens geometry / behaviour. All sizes are in *logical* pixels and get
// multiplied by the stage scale factor at build time so the lens renders
// at the right physical size on HiDPI screens.
const LENS_SIZE         = 300;  // logical px (square container)
const LENS_PADDING      = 4;    // px between circle edge and container border
const LENS_VIGNETTE_PX  = 14;   // soft inner rim thickness
const LENS_OFFSET       = 30;   // logical px between cursor and lens corner
const ZOOM_MIN          = 2;
const ZOOM_MAX          = 6;
const ZOOM_STEP         = 0.5;
const ZOOM_DEFAULT      = 2;

// Polling: cheap rate while screenshot UI is open but lens is hidden,
// and a fast rate while the lens is actually following the pointer. The
// idle rate just watches for Shift to be pressed; the active rate drives
// position updates and is gated by a vsync-friendly cadence.
const POLL_IDLE_MS      = 200;  // ~5 Hz — Shift detection
const POLL_ACTIVE_MS    = 16;   // ~60 Hz — pointer tracking

// Mask / lens visual constants.
const MASK_BG_RGBA      = [0.06, 0.06, 0.06, 1.0];
const VIGNETTE_RGBA     = [0.08, 0.08, 0.10];
const VIGNETTE_ALPHA    = 0.45;
const RING_RGBA         = [1.0, 1.0, 1.0, 0.30];
const RING_WIDTH        = 2;

export class PartMagnifier extends PartUI {
    constructor(screenshotUI, extension) {
        super(screenshotUI, extension);

        // Logical → physical pixel conversion. St handles the actor sizing
        // for us in logical pixels, but the Cairo mask draws in surface
        // (physical) pixels, so we keep the factor for that path.
        this._scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;

        this._zoomScale = ZOOM_DEFAULT;
        this._size      = LENS_SIZE;
        this._isActive  = false;
        this._pollTimerId = 0;
        this._pollIntervalMs = POLL_IDLE_MS;
        this._pointerX = 0;
        this._pointerY = 0;
        this._selectionButtonWarned = false;

        this._buildUI();

        // Track scale-factor changes so the mask redraws sharp on theme changes.
        this._themeContextNotifyId = St.ThemeContext.get_for_stage(global.stage)
            .connect('notify::scale-factor', () => {
                this._scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
                this._mask?.queue_repaint();
            });

        // Start polling when screenshot UI opens, stop when it closes.
        this._connectSignal(this._ui, 'notify::visible',
            this._onUIVisibilityChanged.bind(this));

        // Scroll-to-zoom while the lens is on screen.
        this._connectSignal(this._ui, 'captured-event',
            this._onScrollEvent.bind(this));
    }

    // -----------------------------------------------------------------
    // UI construction
    // -----------------------------------------------------------------

    _buildUI() {
        // Container — clips clone to a square area.
        this._container = new St.Widget({
            style_class: 'big-shot-magnifier-lens',
            width: this._size,
            height: this._size,
            visible: false,
            reactive: false,
            clip_to_allocation: true,
        });

        // Clone Main.uiGroup (NOT global.stage — avoids render recursion since
        // the lens itself is parented to global.stage, outside Main.uiGroup).
        this._clone = new Clutter.Clone({
            source: Main.uiGroup,
            clip_to_allocation: true,
        });
        this._container.add_child(this._clone);

        // Circular mask drawn with Cairo — covers corners with soft edges.
        this._mask = new St.DrawingArea({
            width: this._size,
            height: this._size,
        });
        this._mask.connect('repaint', (area) => {
            const cr = area.get_context();
            const [w, h] = area.get_surface_size();
            this._drawMask(cr, w, h);
            cr.$dispose();
        });
        this._container.add_child(this._mask);

        // Crosshair lines (on top of mask). Style class so themes can override.
        const half = Math.floor(this._size / 2);
        this._crossH = new St.Widget({
            style_class: 'big-shot-magnifier-crosshair',
            width: this._size, height: 1,
            x: 0, y: half,
        });
        this._crossV = new St.Widget({
            style_class: 'big-shot-magnifier-crosshair',
            width: 1, height: this._size,
            x: half, y: 0,
        });
        this._container.add_child(this._crossH);
        this._container.add_child(this._crossV);

        // Zoom label.
        this._zoomLabel = new St.Label({
            style_class: 'big-shot-magnifier-zoom-label',
            text: this._fmtZoom(),
            x: 10, y: 10,
        });
        this._container.add_child(this._zoomLabel);

        // Attach to global.stage so the clone of Main.uiGroup never sees itself.
        global.stage.add_child(this._container);
        Shell.util_set_hidden_from_pick(this._container, true);
    }

    /** Cairo mask: opaque corners, soft circular edge, transparent center. */
    _drawMask(cr, w, h) {
        const cx = w / 2;
        const cy = h / 2;
        const radius = Math.min(cx, cy) - LENS_PADDING;

        // 1. Clear surface to fully transparent.
        cr.save();
        cr.setOperator(CAIRO_OPERATOR_CLEAR);
        cr.paint();
        cr.restore();

        // 2. Fill everything with opaque dark (masks the corners).
        cr.setOperator(CAIRO_OPERATOR_OVER);
        cr.setSourceRGBA(...MASK_BG_RGBA);
        cr.rectangle(0, 0, w, h);
        cr.fill();

        // 3. Cut a clean circular hole — clone shows through here.
        cr.setOperator(CAIRO_OPERATOR_CLEAR);
        cr.arc(cx, cy, radius, 0, Math.PI * 2);
        cr.fill();

        // 4. Soft vignette: graduated dark rings inside the circle edge.
        cr.setOperator(CAIRO_OPERATOR_OVER);
        for (let i = 0; i < LENS_VIGNETTE_PX; i++) {
            const r = radius - i;
            const alpha = VIGNETTE_ALPHA * (1 - i / LENS_VIGNETTE_PX);
            cr.setSourceRGBA(...VIGNETTE_RGBA, alpha);
            cr.setLineWidth(1.5);
            cr.arc(cx, cy, r, 0, Math.PI * 2);
            cr.stroke();
        }

        // 5. Bright lens ring at the edge.
        cr.setOperator(CAIRO_OPERATOR_OVER);
        cr.setSourceRGBA(...RING_RGBA);
        cr.setLineWidth(RING_WIDTH);
        cr.arc(cx, cy, radius, 0, Math.PI * 2);
        cr.stroke();
    }

    // -----------------------------------------------------------------
    // Screenshot-UI visibility → start/stop polling
    // -----------------------------------------------------------------

    _onUIVisibilityChanged() {
        if (this._ui.visible) {
            this._setPollRate(POLL_IDLE_MS);
        } else {
            this._deactivate();
            this._stopPolling();
            this._zoomScale = ZOOM_DEFAULT;
            this._zoomLabel?.set_text(this._fmtZoom());
        }
    }

    // -----------------------------------------------------------------
    // Scroll handler (captured-event on screenshotUI)
    // -----------------------------------------------------------------

    _onScrollEvent(_actor, event) {
        if (!this._isActive) return Clutter.EVENT_PROPAGATE;
        if (event.type() !== Clutter.EventType.SCROLL)
            return Clutter.EVENT_PROPAGATE;

        const dir = event.get_scroll_direction();
        if (dir === Clutter.ScrollDirection.UP) {
            this._zoomScale = Math.min(ZOOM_MAX, this._zoomScale + ZOOM_STEP);
            this._zoomLabel?.set_text(this._fmtZoom());
            return Clutter.EVENT_STOP;
        } else if (dir === Clutter.ScrollDirection.DOWN) {
            this._zoomScale = Math.max(ZOOM_MIN, this._zoomScale - ZOOM_STEP);
            this._zoomLabel?.set_text(this._fmtZoom());
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // -----------------------------------------------------------------
    // Polling — adaptive: idle (5 Hz) until Shift is pressed, then ~60 Hz.
    // We keep using polling instead of key-press/release listeners because
    // GNOME's screenshot UI installs grabs that swallow keyboard events,
    // and `global.get_pointer()` reads directly from the input seat.
    // -----------------------------------------------------------------

    _setPollRate(intervalMs) {
        if (this._pollIntervalMs === intervalMs && this._pollTimerId) return;
        this._stopPolling();
        this._pollIntervalMs = intervalMs;
        this._pollTimerId = this._addTimeout(intervalMs, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _tick() {
        const [x, y, mods] = global.get_pointer();
        const shiftHeld = (mods & Clutter.ModifierType.SHIFT_MASK) !== 0;
        const isArea = this._isAreaSelection();

        if (shiftHeld && isArea) {
            this._pointerX = x;
            this._pointerY = y;
            if (!this._isActive) {
                this._isActive = true;
                this._container.show();
                // Speed up: track the pointer at vsync rate.
                this._setPollRate(POLL_ACTIVE_MS);
            }
            this._updatePosition();
        } else if (this._isActive) {
            this._isActive = false;
            this._container.hide();
            // Slow down: just watch for Shift to come back.
            this._setPollRate(POLL_IDLE_MS);
        }
    }

    _stopPolling() {
        if (this._pollTimerId) {
            this._removeSource(this._pollTimerId);
            this._pollTimerId = 0;
        }
    }

    _deactivate() {
        if (this._isActive) {
            this._isActive = false;
            this._container.hide();
        }
    }

    /**
     * Returns true if the screenshot UI is currently in area-selection mode.
     * Uses the private `_selectionButton` Shell field; if upstream renames it
     * we log once and silently skip the magnifier instead of throwing.
     */
    _isAreaSelection() {
        const button = this._ui._selectionButton;
        if (button === undefined) {
            if (!this._selectionButtonWarned) {
                this._selectionButtonWarned = true;
                console.warn('[Big Shot] Magnifier: _selectionButton not found on screenshot UI; '
                           + 'lens disabled (Shell API may have changed).');
            }
            return false;
        }
        return button?.checked === true;
    }

    // -----------------------------------------------------------------
    // Position & zoom
    // -----------------------------------------------------------------

    _fmtZoom() {
        return `${this._zoomScale.toFixed(1)}×`;
    }

    _updatePosition() {
        const scale = this._zoomScale;
        const half = this._size / 2;

        this._clone.set_scale(scale, scale);
        this._clone.set_position(
            half - this._pointerX * scale,
            half - this._pointerY * scale,
        );

        let cx = this._pointerX + LENS_OFFSET;
        let cy = this._pointerY + LENS_OFFSET;

        const mon = Main.layoutManager.currentMonitor;
        if (cx + this._size > mon.x + mon.width)
            cx = this._pointerX - this._size - LENS_OFFSET;
        if (cy + this._size > mon.y + mon.height)
            cy = this._pointerY - this._size - LENS_OFFSET;
        if (cx < mon.x) cx = this._pointerX + LENS_OFFSET;
        if (cy < mon.y) cy = this._pointerY + LENS_OFFSET;

        this._container.set_position(cx, cy);
    }

    // -----------------------------------------------------------------
    // Cleanup
    // -----------------------------------------------------------------

    destroy() {
        this._deactivate();
        this._stopPolling();

        if (this._themeContextNotifyId) {
            St.ThemeContext.get_for_stage(global.stage).disconnect(this._themeContextNotifyId);
            this._themeContextNotifyId = 0;
        }

        if (this._clone) {
            // Drop the clone source explicitly so the cloned Main.uiGroup is
            // not retained through this widget after destroy().
            this._clone.set_source(null);
            this._clone = null;
        }

        if (this._container) {
            const parent = this._container.get_parent();
            if (parent) parent.remove_child(this._container);
            this._container.destroy();
            this._container = null;
        }
        super.destroy();
    }
}
