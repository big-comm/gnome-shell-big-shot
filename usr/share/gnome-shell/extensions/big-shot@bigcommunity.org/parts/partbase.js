/**
 * Big Shot — Base classes for extension modules (Parts)
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

// =============================================================================
// PartBase — Simplest base class
// =============================================================================

export class PartBase {
    constructor() {
        this._destroyed = false;
    }

    destroy() {
        this._destroyed = true;
    }
}

// =============================================================================
// PartUI — Base with ScreenshotUI awareness
// =============================================================================

export class PartUI extends PartBase {
    constructor(screenshotUI, extension) {
        super();
        this._ui = screenshotUI;
        this._ext = extension;
        this._signals = [];
        this._isCastMode = false;

        // Monitor screenshot/screencast mode toggle
        const shotBtn = this._ui._shotButton;
        if (shotBtn) {
            this._isCastMode = !shotBtn.checked;
            this._connectSignal(shotBtn, 'notify::checked', () => {
                this._isCastMode = !shotBtn.checked;
                this._onModeChanged(this._isCastMode);
            });
        }
    }

    _connectSignal(obj, signal, callback) {
        const id = obj.connect(signal, callback);
        this._signals.push({ obj, id });
        return id;
    }

    _onModeChanged(_isCast) {
        // Override in subclasses
    }

    destroy() {
        for (const { obj, id } of this._signals) {
            try {
                obj.disconnect(id);
            } catch {
                // Already disconnected
            }
        }
        this._signals = [];
        super.destroy();
    }
}

// =============================================================================
// PartPopupSelect — Button with popup menu for value selection
// =============================================================================

export class PartPopupSelect extends PartUI {
    constructor(screenshotUI, extension, options, defaultValue, labelFn, tooltipText = null) {
        super(screenshotUI, extension);

        this._options = options;
        this._value = defaultValue;
        this._labelFn = labelFn;

        // Create the button
        this._button = new St.Button({
            style_class: 'screenshot-ui-show-pointer-button',
            toggle_mode: false,
            can_focus: true,
            child: new St.Label({
                text: this._labelFn(this._value),
                y_align: Clutter.ActorAlign.CENTER,
            }),
        });

        this._button.connect('clicked', () => this._showPopup());

        // Optional tooltip
        if (tooltipText) {
            this._tooltipText = tooltipText;
            this._button.connect('enter-event', () => {
                this._showButtonTooltip(this._button, this._tooltipText);
            });
            this._button.connect('leave-event', () => {
                this._hideButtonTooltip();
            });
        }

        // Create popup container
        this._popup = new St.BoxLayout({
            style_class: 'screenshot-ui-type-button-container',
            vertical: true,
            visible: false,
            reactive: true,
        });

        this._popup.set_style('background: rgba(30,30,30,0.95); border-radius: 12px; padding: 4px;');

        for (const opt of this._options) {
            const item = new St.Button({
                style_class: 'screenshot-ui-show-pointer-button',
                label: this._labelFn(opt),
                can_focus: true,
            });
            item.connect('clicked', () => {
                this._value = opt;
                this._button.child.text = this._labelFn(opt);
                this._popup.visible = false;
            });
            this._popup.add_child(item);
        }

        // Insert into the native show-pointer container (right side of bottom bar)
        // or fall back to the bottom area group
        const showPointerContainer = this._ui._showPointerButtonContainer;
        if (showPointerContainer) {
            showPointerContainer.insert_child_at_index(this._button, 0);
        } else {
            const bottomGroup = this._ui._panel ?? this._ui._bottomAreaGroup ?? this._ui._content;
            if (bottomGroup)
                bottomGroup.add_child(this._button);
        }
        // Popup is added to the screenhotUI directly for proper z-ordering
        this._ui.add_child(this._popup);

        // Only visible in cast mode
        this._button.visible = false;
        this._popup.visible = false;
    }

    get value() {
        return this._value;
    }

    _showPopup() {
        this._popup.visible = !this._popup.visible;
        if (this._popup.visible) {
            const [bx, by] = this._button.get_transformed_position();
            this._popup.set_position(bx, by - this._popup.height - 8);
        }
    }

    _onModeChanged(isCast) {
        this._button.visible = isCast;
        if (!isCast) this._popup.visible = false;
    }

    _showButtonTooltip(button, text) {
        this._hideButtonTooltip();
        this._tooltip = new St.Label({
            text,
            style: 'background: rgba(0,0,0,0.85); color: #ffffff; padding: 4px 8px; border-radius: 4px; font-size: 11px;',
        });
        this._ui.add_child(this._tooltip);
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (!this._tooltip) return GLib.SOURCE_REMOVE;
            const [bx, by] = button.get_transformed_position();
            const bw = button.width;
            const tw = this._tooltip.width;
            this._tooltip.set_position(bx + (bw - tw) / 2, by - this._tooltip.height - 4);
            return GLib.SOURCE_REMOVE;
        });
    }

    _hideButtonTooltip() {
        this._tooltip?.destroy();
        this._tooltip = null;
    }

    destroy() {
        this._hideButtonTooltip();
        if (this._popup) {
            const popupParent = this._popup.get_parent();
            if (popupParent) popupParent.remove_child(this._popup);
            this._popup.destroy();
            this._popup = null;
        }
        if (this._button) {
            const btnParent = this._button.get_parent();
            if (btnParent) btnParent.remove_child(this._button);
            this._button.destroy();
            this._button = null;
        }
        super.destroy();
    }
}
