/**
 * Big Shot — Gradient background part
 *
 * Adds gradient background selection for screenshot beautification.
 * Shows a row of gradient swatches in the toolbar when 'gradient' tool is active.
 * Includes angle selector and border-radius control.
 *
 * SPDX-License-Identifier: MIT
 */

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { PartUI } from './partbase.js';
import { GRADIENTS } from '../data/gradients.js';
import { rgbToCSS } from '../drawing/colors.js';

const ANGLE_VALUES = [0, 45, 90, 135, 180, 225, 270, 315];
const RADIUS_VALUES = [0, 8, 16, 24, 32];

export class PartGradient extends PartUI {
    constructor(screenshotUI, extension) {
        super(screenshotUI, extension);

        this._selected = GRADIENTS.length - 1; // 'None' by default
        this._angleIndex = 3; // Default: 135°
        this._radiusIndex = 0; // Default: 0 (no radius)
        this._toolbar = extension._toolbar;

        this._buildPicker();
    }

    _buildPicker() {
        this._picker = new St.BoxLayout({
            style_class: 'screenshot-ui-type-button-container',
            style: 'background-color: rgba(30, 30, 30, 0.95); border-radius: 14px; ' +
                'padding: 4px;',
            vertical: false,
            visible: false,
            reactive: true,
            x_align: Clutter.ActorAlign.CENTER,
        });

        this._swatches = [];

        for (let i = 0; i < GRADIENTS.length; i++) {
            const grad = GRADIENTS[i];
            const swatch = new St.Button({
                style_class: 'big-shot-gradient-swatch',
                toggle_mode: true,
                can_focus: true,
            });

            if (grad.stops.length >= 2) {
                const [, r1, g1, b1] = grad.stops[0];
                const [, r2, g2, b2] = grad.stops[grad.stops.length - 1];
                const c1 = rgbToCSS(r1, g1, b1);
                const c2 = rgbToCSS(r2, g2, b2);
                swatch.set_style(
                    `background: linear-gradient(135deg, ${c1}, ${c2});`
                );
            } else {
                // 'None' swatch
                swatch.set_style(
                    'background: transparent; border: 2px dashed rgba(255,255,255,0.3);'
                );
            }

            swatch.set_accessible_name(grad.name);
            swatch.connect('clicked', () => this._onSwatchClicked(i));

            this._picker.add_child(swatch);
            this._swatches.push(swatch);
        }

        // Separator
        const sep = new St.Widget({
            style: 'width: 1px; background: rgba(255,255,255,0.2); margin: 4px 6px;',
        });
        this._picker.add_child(sep);

        // Angle button — cycles through angle presets
        this._angleButton = new St.Button({
            style_class: 'screenshot-ui-show-pointer-button',
            child: new St.Label({
                text: `${ANGLE_VALUES[this._angleIndex]}°`,
                y_align: Clutter.ActorAlign.CENTER,
            }),
            can_focus: true,
        });
        this._angleButton.set_accessible_name(_('Gradient Angle'));
        this._angleButton.connect('clicked', () => this._cycleAngle());
        this._picker.add_child(this._angleButton);

        // Border radius button — cycles through radius presets
        this._radiusButton = new St.Button({
            style_class: 'screenshot-ui-show-pointer-button',
            child: new St.Label({
                text: `R:${RADIUS_VALUES[this._radiusIndex]}`,
                y_align: Clutter.ActorAlign.CENTER,
            }),
            can_focus: true,
        });
        this._radiusButton.set_accessible_name(_('Border Radius'));
        this._radiusButton.connect('clicked', () => this._cycleRadius());
        this._picker.add_child(this._radiusButton);

        // Mark default (None) as checked
        if (this._swatches[this._selected])
            this._swatches[this._selected].checked = true;

        // Add directly to screenshotUI — positioned manually above the toolbar
        if (this._ui) {
            this._ui.add_child(this._picker);
        }
    }

    _onSwatchClicked(index) {
        for (let i = 0; i < this._swatches.length; i++) {
            this._swatches[i].checked = (i === index);
        }
        this._selected = index;
    }

    _cycleAngle() {
        this._angleIndex = (this._angleIndex + 1) % ANGLE_VALUES.length;
        this._angleButton.child.text = `${ANGLE_VALUES[this._angleIndex]}°`;
    }

    _cycleRadius() {
        this._radiusIndex = (this._radiusIndex + 1) % RADIUS_VALUES.length;
        this._radiusButton.child.text = `R:${RADIUS_VALUES[this._radiusIndex]}`;
    }

    /**
     * Returns the currently selected gradient with overridden angle, or null for 'None'.
     */
    get selectedGradient() {
        const grad = GRADIENTS[this._selected];
        if (!grad || !grad.stops || grad.stops.length === 0)
            return null;
        // Override with user-selected angle
        return { ...grad, angle: ANGLE_VALUES[this._angleIndex] };
    }

    /** Current border radius in pixels */
    get borderRadius() {
        return RADIUS_VALUES[this._radiusIndex];
    }

    _onModeChanged(isCast) {
        super._onModeChanged(isCast);
        this._picker.visible = false;
    }

    setVisible(visible) {
        this._picker.visible = visible;
        if (visible) {
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._repositionPicker();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    /**
     * Position the gradient picker above the annotation toolbar,
     * or above the native bottom area if the toolbar is not visible.
     */
    _repositionPicker() {
        if (!this._picker?.visible) return;

        // Position above the native panel
        const panel = this._ui._panel;
        if (!panel) return;
        const [bgX, bgY] = panel.get_transformed_position();
        const bgW = panel.width;
        const pw = this._picker.width;
        const ph = this._picker.height;
        this._picker.set_position(
            bgX + (bgW - pw) / 2,
            bgY - ph - 8
        );
    }

    destroy() {
        if (this._picker) {
            const parent = this._picker.get_parent();
            if (parent) parent.remove_child(this._picker);
            this._picker.destroy();
            this._picker = null;
        }
        this._swatches = [];
        super.destroy();
    }
}
