/**
 * Big Shot — Magnifier / Zoom Lens for pixel-perfect area selection
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { PartUI } from './partbase.js';

// Cairo operators (numeric, same pattern as overlay.js)
const CAIRO_OPERATOR_CLEAR    = 0;  // Cairo.Operator.CLEAR
const CAIRO_OPERATOR_OVER     = 2;  // Cairo.Operator.OVER
const CAIRO_OPERATOR_DEST_OUT = 7;  // Cairo.Operator.DEST_OUT

export class PartMagnifier extends PartUI {
    constructor(screenshotUI, extension) {
        super(screenshotUI, extension);

        this._zoomScale = 2;
        this._minZoom = 2;
        this._maxZoom = 6;
        this._size = 300;
        this._isActive = false;
        this._pollTimerId = 0;
        this._pointerX = 0;
        this._pointerY = 0;

        this._buildUI();

        // Start polling when screenshot UI opens, stop when it closes
        this._connectSignal(this._ui, 'notify::visible',
            this._onUIVisibilityChanged.bind(this));

        // Scroll zoom via screenshotUI events (works outside grabs)
        this._connectSignal(this._ui, 'captured-event',
            this._onScrollEvent.bind(this));
    }

    _buildUI() {
        // Container — clips clone to 300×300 rect
        this._container = new St.Widget({
            width: this._size,
            height: this._size,
            visible: false,
            reactive: false,
            clip_to_allocation: true,
        });

        // Clone Main.uiGroup (NOT global.stage — avoids render loop)
        this._clone = new Clutter.Clone({
            source: Main.uiGroup,
            clip_to_allocation: true,
        });
        this._container.add_child(this._clone);

        // Circular mask drawn with Cairo — covers corners, soft edges
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

        // Crosshair lines (on top of mask)
        const half = Math.floor(this._size / 2);
        const crossStyle = 'background-color: rgba(255, 50, 50, 0.7);';
        this._crossH = new St.Widget({
            style: crossStyle, width: this._size, height: 1,
            x: 0, y: half,
        });
        this._crossV = new St.Widget({
            style: crossStyle, width: 1, height: this._size,
            x: half, y: 0,
        });
        this._container.add_child(this._crossH);
        this._container.add_child(this._crossV);

        // Zoom label
        this._zoomLabel = new St.Label({
            style: 'background-color: rgba(0,0,0,0.7); color: white; '
                 + 'font-size: 11px; padding: 2px 6px; border-radius: 4px;',
            text: this._fmtZoom(),
            x: 10, y: 10,
        });
        this._container.add_child(this._zoomLabel);

        // Attach to global.stage (outside Main.uiGroup → no recursion)
        global.stage.add_child(this._container);
        Shell.util_set_hidden_from_pick(this._container, true);
    }

    /** Cairo mask: opaque corners, soft circular edge, transparent center */
    _drawMask(cr, w, h) {
        const cx = w / 2;
        const cy = h / 2;
        const radius = Math.min(cx, cy) - 4;

        // 1. Clear surface to fully transparent
        cr.save();
        cr.setOperator(CAIRO_OPERATOR_CLEAR);
        cr.paint();
        cr.restore();

        // 2. Fill everything with opaque dark (masks the corners)
        cr.setOperator(CAIRO_OPERATOR_OVER);
        cr.setSourceRGBA(0.06, 0.06, 0.06, 1.0);
        cr.rectangle(0, 0, w, h);
        cr.fill();

        // 3. Cut a clean circular hole — clone shows through here
        cr.setOperator(CAIRO_OPERATOR_CLEAR);
        cr.arc(cx, cy, radius, 0, Math.PI * 2);
        cr.fill();

        // 4. Soft vignette: graduated dark rings inside the circle edge
        cr.setOperator(CAIRO_OPERATOR_OVER);
        const edgeWidth = 14;
        for (let i = 0; i < edgeWidth; i++) {
            const r = radius - i;
            const alpha = 0.45 * (1 - i / edgeWidth);
            cr.setSourceRGBA(0.08, 0.08, 0.1, alpha);
            cr.setLineWidth(1.5);
            cr.arc(cx, cy, r, 0, Math.PI * 2);
            cr.stroke();
        }

        // 5. Bright lens ring at the edge
        cr.setOperator(CAIRO_OPERATOR_OVER);
        cr.setSourceRGBA(1, 1, 1, 0.3);
        cr.setLineWidth(2);
        cr.arc(cx, cy, radius, 0, Math.PI * 2);
        cr.stroke();
    }

    // -----------------------------------------------------------------
    // Screenshot-UI visibility → start/stop polling
    // -----------------------------------------------------------------

    _onUIVisibilityChanged() {
        if (this._ui.visible) {
            this._startPolling();
        } else {
            this._deactivate();
            this._stopPolling();
            this._zoomScale = 2;
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
            this._zoomScale = Math.min(this._maxZoom, this._zoomScale + 0.5);
            this._zoomLabel?.set_text(this._fmtZoom());
            return Clutter.EVENT_STOP;
        } else if (dir === Clutter.ScrollDirection.DOWN) {
            this._zoomScale = Math.max(this._minZoom, this._zoomScale - 0.5);
            this._zoomLabel?.set_text(this._fmtZoom());
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // -----------------------------------------------------------------
    // Polling: checks Shift state + pointer position at ~60fps
    // Works during grabs (selection handle drags) because
    // global.get_pointer() reads directly from the input seat.
    // -----------------------------------------------------------------

    _startPolling() {
        this._stopPolling();
        this._pollTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            const [x, y, mods] = global.get_pointer();
            const shiftHeld = (mods & Clutter.ModifierType.SHIFT_MASK) !== 0;
            const isArea = this._ui._selectionButton?.checked === true;

            if (shiftHeld && isArea) {
                this._pointerX = x;
                this._pointerY = y;
                if (!this._isActive) {
                    this._isActive = true;
                    this._container.show();
                }
                this._updatePosition();
            } else {
                if (this._isActive) {
                    this._isActive = false;
                    this._container.hide();
                }
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopPolling() {
        if (this._pollTimerId) {
            GLib.source_remove(this._pollTimerId);
            this._pollTimerId = 0;
        }
    }

    _deactivate() {
        if (this._isActive) {
            this._isActive = false;
            this._container.hide();
        }
    }

    // -----------------------------------------------------------------
    // Position & zoom
    // -----------------------------------------------------------------

    _fmtZoom() {
        return `${this._zoomScale.toFixed(1)}\u00d7`;
    }

    _updatePosition() {
        const scale = this._zoomScale;
        const half = this._size / 2;

        this._clone.set_scale(scale, scale);
        this._clone.set_position(
            half - this._pointerX * scale,
            half - this._pointerY * scale,
        );

        const offset = 30;
        let cx = this._pointerX + offset;
        let cy = this._pointerY + offset;

        const mon = Main.layoutManager.currentMonitor;
        if (cx + this._size > mon.x + mon.width)
            cx = this._pointerX - this._size - offset;
        if (cy + this._size > mon.y + mon.height)
            cy = this._pointerY - this._size - offset;
        if (cx < mon.x) cx = this._pointerX + offset;
        if (cy < mon.y) cy = this._pointerY + offset;

        this._container.set_position(cx, cy);
    }

    // -----------------------------------------------------------------
    // Cleanup
    // -----------------------------------------------------------------

    destroy() {
        this._deactivate();
        this._stopPolling();
        if (this._container) {
            const parent = this._container.get_parent();
            if (parent) parent.remove_child(this._container);
            this._container.destroy();
            this._container = null;
        }
        super.destroy();
    }
}
