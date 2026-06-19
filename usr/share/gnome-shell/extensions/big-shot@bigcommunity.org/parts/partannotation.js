/**
 * Big Shot — Annotation integration part
 *
 * Connects the toolbar (tool/color/size selection) to the drawing overlay.
 * Manages the overlay lifecycle tied to the screenshot UI.
 *
 * SPDX-License-Identifier: MIT
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

        // Size the overlay to the full monitor — the ScreenshotUI covers the
        // entire screen regardless of selection mode (fullscreen/window/area).
        // Coordinate mapping to the actual captured region is handled by
        // DrawingOverlay._toImageCoords().
        const monitor = global.display.get_current_monitor();
        const rect = global.display.get_monitor_geometry(monitor);
        this._overlay.show(rect.width, rect.height);
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
