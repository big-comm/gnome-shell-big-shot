/**
 * Big Shot — Crop part
 *
 * Adds crop + padding functionality for screenshot beautification.
 * Provides a crop box overlay with 8 draggable handles (4 corners + 4 edges).
 *
 * SPDX-License-Identifier: MIT
 */

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import { PartUI } from './partbase.js';

const PADDING_VALUES = [0, 16, 32, 48, 64];
const HANDLE_SIZE = 10;
const MIN_CROP = 32;
const KEYBOARD_STEP = 8;

// Handle positions: which edges they control
const HANDLE_DEFS = [
    { id: 'nw', edges: ['top', 'left'],    cursor: 'nw-resize' },
    { id: 'n',  edges: ['top'],             cursor: 'n-resize'  },
    { id: 'ne', edges: ['top', 'right'],    cursor: 'ne-resize' },
    { id: 'e',  edges: ['right'],           cursor: 'e-resize'  },
    { id: 'se', edges: ['bottom', 'right'], cursor: 'se-resize' },
    { id: 's',  edges: ['bottom'],          cursor: 's-resize'  },
    { id: 'sw', edges: ['bottom', 'left'],  cursor: 'sw-resize' },
    { id: 'w',  edges: ['left'],            cursor: 'w-resize'  },
];

export class PartCrop extends PartUI {
    constructor(screenshotUI, extension) {
        super(screenshotUI, extension);

        this._cropRect = null; // {x, y, width, height}
        this._imageWidth = 0;
        this._imageHeight = 0;
        this._padding = 0;
        this._isActive = false;
        this._dragging = null; // { handleId, startRect, startX, startY }

        this._buildUI();
    }

    _buildUI() {
        // Main crop border overlay
        this._overlay = new St.Widget({
            style_class: 'big-shot-crop-overlay',
            style: 'border: 2px dashed rgba(255,255,255,0.8);',
            visible: false,
            reactive: true,
        });

        // 8 draggable handles
        this._handles = new Map();
        for (const def of HANDLE_DEFS) {
            const handle = new St.Widget({
                style_class: 'big-shot-crop-handle',
                style: `width: ${HANDLE_SIZE}px; height: ${HANDLE_SIZE}px; ` +
                       'background: white; border: 1px solid #62a0ea; border-radius: 1px;',
                reactive: true,
                can_focus: true,
                visible: false,
                accessible_name: `Crop ${def.id}`,
            });

            handle.connect('button-press-event', (_actor, event) => {
                this._onHandlePress(def, event);
                return Clutter.EVENT_STOP;
            });

            handle.connect('key-press-event', (_actor, event) => {
                return this._onHandleKeyPress(def, event);
            });

            this._handles.set(def.id, handle);
        }

        // Allow dragging from inside the crop box to move the whole region
        this._overlay.connect('button-press-event', (_actor, event) => {
            this._onOverlayPress(event);
            return Clutter.EVENT_STOP;
        });

        // Padding display label
        this._paddingLabel = new St.Label({
            text: '0px',
            style: 'color: white; font-size: 11px;',
            visible: false,
        });

        if (this._ui) {
            this._ui.add_child(this._overlay);
            for (const [, handle] of this._handles) {
                this._ui.add_child(handle);
            }
            this._ui.add_child(this._paddingLabel);

            // Global motion and release for drag handling
            this._connectSignal(this._ui, 'motion-event', (_actor, event) => {
                return this._onGlobalMotion(event);
            });
            this._connectSignal(this._ui, 'button-release-event', (_actor, event) => {
                return this._onGlobalRelease(event);
            });
        }
    }

    activate(imageWidth, imageHeight) {
        this._isActive = true;
        this._imageWidth = imageWidth;
        this._imageHeight = imageHeight;
        this._cropRect = { x: 0, y: 0, width: imageWidth, height: imageHeight };
        this._updateOverlay();
        this._overlay.visible = true;
        for (const [, h] of this._handles) h.visible = true;
    }

    deactivate() {
        this._isActive = false;
        this._overlay.visible = false;
        this._paddingLabel.visible = false;
        for (const [, h] of this._handles) h.visible = false;
        this._dragging = null;
    }

    cyclePadding() {
        const idx = PADDING_VALUES.indexOf(this._padding);
        this._padding = PADDING_VALUES[(idx + 1) % PADDING_VALUES.length];
        this._paddingLabel.text = `${this._padding}px`;
        this._paddingLabel.visible = this._padding > 0;
    }

    get padding() {
        return this._padding;
    }

    get cropRect() {
        return this._cropRect;
    }

    // ── Handle drag ──

    _onHandlePress(def, event) {
        if (!this._cropRect) return;
        const [x, y] = event.get_coords();
        this._dragging = {
            handleId: def.id,
            edges: def.edges,
            startX: x,
            startY: y,
            startRect: { ...this._cropRect },
        };
    }

    _onOverlayPress(event) {
        if (!this._cropRect) return;
        const [x, y] = event.get_coords();
        this._dragging = {
            handleId: 'move',
            edges: [],
            startX: x,
            startY: y,
            startRect: { ...this._cropRect },
        };
    }

    _onHandleKeyPress(def, event) {
        if (!this._cropRect || !this._isActive) return Clutter.EVENT_PROPAGATE;

        const sym = event.get_key_symbol();
        let dx = 0, dy = 0;
        if (sym === Clutter.KEY_Left) dx = -KEYBOARD_STEP;
        else if (sym === Clutter.KEY_Right) dx = KEYBOARD_STEP;
        else if (sym === Clutter.KEY_Up) dy = -KEYBOARD_STEP;
        else if (sym === Clutter.KEY_Down) dy = KEYBOARD_STEP;
        else return Clutter.EVENT_PROPAGATE;

        const edges = def.edges;
        let { x: rx, y: ry, width: rw, height: rh } = this._cropRect;

        if (edges.includes('left')) { const nx = Math.max(0, Math.min(rx + dx, rx + rw - MIN_CROP)); rw -= nx - rx; rx = nx; }
        if (edges.includes('right')) { rw = Math.max(MIN_CROP, Math.min(rw + dx, this._imageWidth - rx)); }
        if (edges.includes('top')) { const ny = Math.max(0, Math.min(ry + dy, ry + rh - MIN_CROP)); rh -= ny - ry; ry = ny; }
        if (edges.includes('bottom')) { rh = Math.max(MIN_CROP, Math.min(rh + dy, this._imageHeight - ry)); }

        this._cropRect = { x: rx, y: ry, width: rw, height: rh };
        this._updateOverlay();
        return Clutter.EVENT_STOP;
    }

    _onGlobalMotion(event) {
        if (!this._dragging) return Clutter.EVENT_PROPAGATE;

        const [x, y] = event.get_coords();
        const dx = x - this._dragging.startX;
        const dy = y - this._dragging.startY;
        const orig = this._dragging.startRect;

        if (this._dragging.handleId === 'move') {
            // Move the entire crop box
            let nx = orig.x + dx;
            let ny = orig.y + dy;
            nx = Math.max(0, Math.min(nx, this._imageWidth - orig.width));
            ny = Math.max(0, Math.min(ny, this._imageHeight - orig.height));
            this._cropRect.x = nx;
            this._cropRect.y = ny;
        } else {
            // Resize from handle edges
            const edges = this._dragging.edges;
            let { x: rx, y: ry, width: rw, height: rh } = orig;

            if (edges.includes('left')) {
                const newX = Math.max(0, Math.min(rx + dx, rx + rw - MIN_CROP));
                rw = rw - (newX - rx);
                rx = newX;
            }
            if (edges.includes('right')) {
                rw = Math.max(MIN_CROP, Math.min(orig.width + dx, this._imageWidth - rx));
            }
            if (edges.includes('top')) {
                const newY = Math.max(0, Math.min(ry + dy, ry + rh - MIN_CROP));
                rh = rh - (newY - ry);
                ry = newY;
            }
            if (edges.includes('bottom')) {
                rh = Math.max(MIN_CROP, Math.min(orig.height + dy, this._imageHeight - ry));
            }

            this._cropRect = { x: rx, y: ry, width: rw, height: rh };
        }

        this._updateOverlay();
        return Clutter.EVENT_STOP;
    }

    _onGlobalRelease(_event) {
        if (!this._dragging) return Clutter.EVENT_PROPAGATE;
        this._dragging = null;
        return Clutter.EVENT_STOP;
    }

    // ── Update positions ──

    _updateOverlay() {
        if (!this._cropRect || !this._isActive) return;
        const { x, y, width, height } = this._cropRect;

        this._overlay.set_position(x, y);
        this._overlay.set_size(width, height);

        // Position handles
        const hs = HANDLE_SIZE / 2;
        const cx = x + width / 2;
        const cy = y + height / 2;

        const positions = {
            nw: [x - hs, y - hs],
            n:  [cx - hs, y - hs],
            ne: [x + width - hs, y - hs],
            e:  [x + width - hs, cy - hs],
            se: [x + width - hs, y + height - hs],
            s:  [cx - hs, y + height - hs],
            sw: [x - hs, y + height - hs],
            w:  [x - hs, cy - hs],
        };

        for (const [id, handle] of this._handles) {
            const [hx, hy] = positions[id];
            handle.set_position(hx, hy);
        }
    }

    _onModeChanged(isCast) {
        super._onModeChanged(isCast);
        if (isCast)
            this.deactivate();
    }

    destroy() {
        this._overlay?.destroy();
        this._paddingLabel?.destroy();
        for (const [, h] of this._handles) h.destroy();
        this._handles.clear();
        super.destroy();
    }
}
