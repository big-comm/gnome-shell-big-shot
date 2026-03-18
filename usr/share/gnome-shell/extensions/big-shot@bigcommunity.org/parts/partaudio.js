/**
 * Big Shot — Audio recording (Desktop + Mic)
 *
 * Adds toggle buttons for desktop audio and microphone capture.
 * Uses PulseAudio via Gvc.MixerControl to detect audio devices.
 *
 * Based on gnome-shell-screencast-extra-feature approach:
 * buttons are injected into the native _typeButtonContainer.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Gvc from 'gi://Gvc';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Screenshot from 'resource:///org/gnome/shell/ui/screenshot.js';

import { PartUI } from './partbase.js';

/**
 * A Clutter constraint to snap allocation to pixel boundaries.
 * Resolves sub-pixel positioning on some displays.
 */
export const PixelConstraint = GObject.registerClass(
    class PixelConstraint extends Clutter.Constraint {
        vfunc_update_allocation(_actor, allocation) {
            allocation.x1 = Math.ceil(allocation.x1);
            allocation.y1 = Math.ceil(allocation.y1);
            allocation.x2 = Math.floor(allocation.x2);
            allocation.y2 = Math.floor(allocation.y2);
        }
    });

/**
 * Icon+Label button matching the native GNOME screenshot UI style.
 * Uses Gio.FileIcon for custom SVG icons from the extension.
 */
export const IconLabelButton = GObject.registerClass(
    class IconLabelButton extends St.Button {
        _init(icon, label, params) {
            super._init(params);

        this._container = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'icon-label-button-container',
        });
        this.set_child(this._container);

        this._container.add_child(new St.Icon({ gicon: icon }));

        const labelActor = new St.Label({
            text: label,
            x_align: Clutter.ActorAlign.CENTER,
        });
            this.set({ labelActor });
            this._container.add_child(labelActor);
        }
    });

// =============================================================================
// PartAudio — Desktop + Mic audio capture
// =============================================================================

export class PartAudio extends PartUI {
    constructor(screenshotUI, extension) {
        super(screenshotUI, extension);

        this._desktopDevice = null;
        this._micDevice = null;
        this._iconsDir = extension.dir.get_child('data').get_child('icons');

        // Initialize audio mixer
        this._mixer = new Gvc.MixerControl({ name: 'Big Shot Audio' });
        this._mixer.open();

        this._mixerReadyId = this._mixer.connect('state-changed', () => {
            if (this._mixer.get_state() === Gvc.MixerControlState.READY)
                this._onMixerReady();
        });

        this._createButtons();
    }

    _createButtons() {
        const typeContainer = this._ui._typeButtonContainer;
        if (!typeContainer) return;

        // Desktop audio button
        this._desktopButton = new IconLabelButton(
            new Gio.FileIcon({ file: this._iconsDir.get_child('screenshot-ui-speaker-symbolic.svg') }),
            _('Desktop'),
            {
                constraints: new PixelConstraint(),
                style_class: 'screenshot-ui-type-button',
                toggle_mode: true,
                reactive: false,
            }
        );

        // Mic button
        this._micButton = new IconLabelButton(
            new Gio.FileIcon({ file: this._iconsDir.get_child('screenshot-ui-mic-symbolic.svg') }),
            _('Mic'),
            {
                constraints: new PixelConstraint(),
                style_class: 'screenshot-ui-type-button',
                toggle_mode: true,
                reactive: false,
            }
        );

        typeContainer.add_child(this._desktopButton);
        typeContainer.add_child(this._micButton);

        // Add tooltips
        this._desktopTooltip = new Screenshot.Tooltip(this._desktopButton, {
            style_class: 'screenshot-ui-tooltip',
            visible: false,
        });
        this._micTooltip = new Screenshot.Tooltip(this._micButton, {
            style_class: 'screenshot-ui-tooltip',
            visible: false,
        });
        this._ui.add_child(this._desktopTooltip);
        this._ui.add_child(this._micTooltip);

        // Initially not visible and not reactive
        this._desktopButton.visible = false;
        this._micButton.visible = false;
    }

    _disconnectMixer() {
        if (this._mixerReadyId) {
            this._mixer?.disconnect(this._mixerReadyId);
            this._mixerReadyId = null;
        }
    }

    _onMixerReady() {
        this._disconnectMixer();
        this._updateDevices();
    }

    _updateDevices() {
        const defaultSink = this._mixer.get_default_sink();
        if (defaultSink) {
            this._desktopDevice = defaultSink.get_name() + '.monitor';
            const desc = defaultSink.get_description() || _('Desktop');
            if (this._desktopTooltip)
                this._desktopTooltip.text = _('Record Desktop Audio') + '\n' + desc;
        }

        const defaultSource = this._mixer.get_default_source();
        if (defaultSource) {
            this._micDevice = defaultSource.get_name();
            const desc = defaultSource.get_description() || _('Mic');
            if (this._micTooltip)
                this._micTooltip.text = _('Record Microphone') + '\n' + desc;
        }
    }

    makeAudioInput() {
        this._updateDevices();

        const desktopActive = this._desktopButton?.checked && this._desktopDevice;
        const micActive = this._micButton?.checked && this._micDevice;

        console.log(`[Big Shot Audio] desktopBtn=${this._desktopButton?.checked}, micBtn=${this._micButton?.checked}, dDev=${this._desktopDevice}, mDev=${this._micDevice}`);

        if (!desktopActive && !micActive) {
            console.log('[Big Shot Audio] No audio source active');
            return null;
        }

        // Desktop audio source
        let desktopSource = null;
        let desktopChannels = 2;
        if (desktopActive) {
            const sink = this._mixer.get_default_sink();
            if (sink) {
                const channelMap = sink.get_channel_map();
                if (channelMap)
                    desktopChannels = channelMap.get_num_channels();
            }
            desktopSource = [
                `pulsesrc device=${this._desktopDevice} provide-clock=false`,
                `capsfilter caps=audio/x-raw,channels=${desktopChannels}`,
                'audioconvert',
                'queue',
            ].join(' ! ');
        }

        // Microphone source
        let micSource = null;
        if (micActive) {
            const src = this._mixer.get_default_source();
            let micChannels = 2;
            if (src) {
                const channelMap = src.get_channel_map();
                if (channelMap)
                    micChannels = channelMap.get_num_channels();
            }
            micSource = [
                `pulsesrc device=${this._micDevice} provide-clock=false`,
                `capsfilter caps=audio/x-raw,channels=${micChannels}`,
                'audioconvert',
                'queue',
            ].join(' ! ');
        }

        // Both active — mix them
        if (desktopSource && micSource) {
            const result = [
                `${desktopSource} ! audiomixer name=am latency=100000000`,
                `${micSource} ! am.`,
                `am. ! capsfilter caps=audio/x-raw,channels=${desktopChannels} ! audioconvert ! queue`,
            ].join(' ');
            console.log(`[Big Shot Audio] Mixed pipeline: ${result}`);
            return result;
        }

        // Single source
        const result = desktopSource || micSource;
        console.log(`[Big Shot Audio] Single pipeline: ${result}`);
        return result;
    }

    _onModeChanged(isCast) {
        super._onModeChanged(isCast);
        if (this._desktopButton) {
            this._desktopButton.visible = isCast;
            this._desktopButton.reactive = isCast;
        }
        if (this._micButton) {
            this._micButton.visible = isCast;
            this._micButton.reactive = isCast;
        }
    }

    destroy() {
        if (this._desktopTooltip) {
            const p = this._desktopTooltip.get_parent();
            if (p) p.remove_child(this._desktopTooltip);
            this._desktopTooltip.destroy();
            this._desktopTooltip = null;
        }
        if (this._micTooltip) {
            const p = this._micTooltip.get_parent();
            if (p) p.remove_child(this._micTooltip);
            this._micTooltip.destroy();
            this._micTooltip = null;
        }
        if (this._desktopButton) {
            const parent = this._desktopButton.get_parent();
            if (parent) parent.remove_child(this._desktopButton);
            this._desktopButton.destroy();
            this._desktopButton = null;
        }
        if (this._micButton) {
            const parent = this._micButton.get_parent();
            if (parent) parent.remove_child(this._micButton);
            this._micButton.destroy();
            this._micButton = null;
        }
        this._disconnectMixer();
        this._mixer?.close();
        this._mixer = null;
        super.destroy();
    }
}
