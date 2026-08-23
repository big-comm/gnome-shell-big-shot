/**
 * Big Shot — Annotation integration part
 *
 * Connects the toolbar (tool/color/size selection) to the drawing overlay.
 * Manages the overlay lifecycle tied to the screenshot UI.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { PartUI } from './partbase.js';
import { DrawingOverlay } from '../drawing/overlay.js';

export class PartAnnotation extends PartUI {
    constructor(screenshotUI, extension) {
        super(screenshotUI, extension);

        this._overlay = null;
        this._toolbar = extension._toolbar;

        // Wire toolbar undo/redo to overlay
        if (this._toolbar) {
            this._toolbar._onUndo = () => this._overlay?.undo();
            this._toolbar._onRedo = () => this._overlay?.redo();
        }

        // When screenshot UI opens, create the overlay
        this._connectSignal(this._ui, 'notify::visible', () => {
            this._onUIVisibilityChanged();
        });
    }

    _onUIVisibilityChanged() {
        if (this._ui.visible && !this._isCastMode) {
            this._ensureOverlay();
        } else {
            this._destroyOverlay();
        }
    }

    _onModeChanged(isCast) {
        super._onModeChanged(isCast);
        if (isCast) {
            this._destroyOverlay();
        } else if (this._ui.visible) {
            this._ensureOverlay();
        }
    }

    _ensureOverlay() {
        if (this._overlay) return;

        this._overlay = new DrawingOverlay(this._ui, this._toolbar);

        // Cover the complete logical monitor layout, including monitors placed
        // left/above the primary one (negative stage coordinates).
        const monitors = global.display.get_n_monitors();
        let minX = 0, minY = 0, maxX = 1, maxY = 1;
        for (let index = 0; index < monitors; index++) {
            const rect = global.display.get_monitor_geometry(index);
            minX = Math.min(minX, rect.x);
            minY = Math.min(minY, rect.y);
            maxX = Math.max(maxX, rect.x + rect.width);
            maxY = Math.max(maxY, rect.y + rect.height);
        }
        this._overlay.show(maxX - minX, maxY - minY, minX, minY);
    }

    _destroyOverlay() {
        if (!this._overlay) return;
        this._overlay.destroy();
        this._overlay = null;
    }

    destroy() {
        this._destroyOverlay();
        super.destroy();
    }
}
