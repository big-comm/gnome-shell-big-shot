// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { PartUI } from './partbase.js';

export function monitorForRect(monitors, rect, fallback) {
    let chosen = monitors.includes(fallback) ? fallback : monitors[0] ?? null;
    let largest = 0;
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
        rect.width <= 0 || rect.height <= 0)
        return chosen;
    for (const monitor of monitors) {
        const width = Math.max(0, Math.min(rect.x + rect.width, monitor.x + monitor.width) -
            Math.max(rect.x, monitor.x));
        const height = Math.max(0, Math.min(rect.y + rect.height, monitor.y + monitor.height) -
            Math.max(rect.y, monitor.y));
        const area = width * height;
        if (area > largest || (area > 0 && area === largest && monitor === fallback)) {
            chosen = monitor;
            largest = area;
        }
    }
    return chosen;
}

export class PartMonitor extends PartUI {
    constructor(ui, extension, changed) {
        super(ui, extension);
        this._changed = changed;
        this._selectorSignals = [];
        this._syncId = 0;
        this._monitor = null;
        this._constraint = ui._primaryMonitorBin?.get_constraints()
            .find(constraint => constraint instanceof Layout.MonitorConstraint) ?? null;
        this._original = this._constraint
            ? {primary: this._constraint.primary, index: this._constraint.index} : null;
        this._ownedIndex = null;
        this._connectSignal(ui, 'notify::visible', () => {
            if (ui.visible) {
                this._bindSelectors();
                this._queueSync();
            } else {
                this._disconnectSelectors();
                this._restore();
            }
        });
        this._connectSignal(Main.layoutManager, 'monitors-changed', () => {
            this._bindSelectors();
            this._queueSync();
        });
        for (const button of [ui._selectionButton, ui._screenButton, ui._windowButton]) {
            if (button)
                this._connectSignal(button, 'notify::checked', () => this._queueSync());
        }
        if (ui._areaSelector)
            this._connectSignal(ui._areaSelector, 'drag-ended', () => this._queueSync());
        if (ui.visible) {
            this._bindSelectors();
            this._queueSync();
        }
    }

    get monitor() {
        const monitors = Main.layoutManager.monitors;
        const fallback = monitors.includes(this._monitor)
            ? this._monitor : Main.layoutManager.primaryMonitor;
        if (!this._ui.visible)
            return fallback;
        if (this._ui._screenButton?.checked) {
            const index = this._ui._screenSelectors?.findIndex(selector => selector.checked);
            return monitors[index] ?? fallback;
        }
        let rect;
        if (this._ui._windowButton?.checked) {
            rect = this._ui._windowSelectors?.flatMap(selector => selector.windows())
                .find(window => window.checked)?.boundingBox;
        } else if (this._ui._selectionButton?.checked) {
            const geometry = this._ui._areaSelector?.getGeometry();
            if (geometry) {
                const [x, y, width, height] = geometry;
                rect = {x, y, width, height};
            }
        }
        return monitorForRect(monitors, rect, fallback);
    }

    _bindSelectors() {
        this._disconnectSelectors();
        if (!this._ui.visible)
            return;
        const selectors = [
            ...(this._ui._screenSelectors ?? []),
            ...(this._ui._windowSelectors ?? []).flatMap(selector => selector.windows()),
        ];
        for (const selector of selectors) {
            const id = selector.connect('notify::checked', () => this._queueSync());
            this._selectorSignals.push([selector, id]);
        }
    }

    _disconnectSelectors() {
        for (const [selector, id] of this._selectorSignals.splice(0)) {
            try { selector.disconnect(id); } catch (_e) { /* Selector already disposed. */ }
        }
    }

    _queueSync() {
        if (this._syncId || !this._ui.visible)
            return;
        this._syncId = this._addIdle(() => {
            this._syncId = 0;
            if (!this._ui.visible)
                return GLib.SOURCE_REMOVE;
            const monitor = this.monitor;
            if (!monitor)
                return GLib.SOURCE_REMOVE;
            const changed = this._monitor !== monitor || this._ownedIndex === null;
            this._monitor = monitor;
            if (this._constraint && (this._constraint.primary ||
                this._constraint.index !== monitor.index)) {
                this._constraint.index = monitor.index;
                this._ownedIndex = monitor.index;
            }
            if (changed)
                this._changed();
            return GLib.SOURCE_REMOVE;
        });
    }

    _restore() {
        this._removeSource(this._syncId);
        this._syncId = 0;
        if (this._ownedIndex !== null && this._constraint &&
            !this._constraint.primary && this._constraint.index === this._ownedIndex) {
            this._constraint.index = this._original.index;
            this._constraint.primary = this._original.primary;
        }
        this._ownedIndex = null;
    }

    destroy() {
        this._disconnectSelectors();
        this._restore();
        super.destroy();
    }
}
