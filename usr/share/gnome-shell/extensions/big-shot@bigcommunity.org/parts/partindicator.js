/**
 * Big Shot — Panel indicator during recording
 *
 * Shows a pause/resume button in the top panel with elapsed timer.
 * Supports pause/resume recording via stop+restart+merge.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { PartUI } from './partbase.js';

export class PartIndicator extends PartUI {
    constructor(screenshotUI, extension) {
        super(screenshotUI, extension);
        this._isReady = false;
        this._panelButton = null;
        this._timerId = 0;
        this._elapsed = 0;
        this._pausedElapsed = 0;
        this._isPaused = false;
    }

    onPipelineStarting() {
        this._isReady = false;
    }

    onPipelineReady() {
        this._isReady = true;
    }

    /**
     * Called when recording starts — show the pause button in the panel.
     */
    onRecordingStarted() {
        console.log('[Big Shot Indicator] onRecordingStarted called');
        this._elapsed = 0;
        this._pausedElapsed = 0;
        this._isPaused = false;
        this._createPanelButton();
        console.log('[Big Shot Indicator] _createPanelButton done');
        this._startTimer();
        console.log('[Big Shot Indicator] _startTimer done');
    }

    /**
     * Called when recording is paused.
     */
    onPaused() {
        this._isPaused = true;
        this._pausedElapsed += this._elapsed;
        this._elapsed = 0;
        this._stopTimer();
        this._updatePanelButton();
    }

    /**
     * Called when recording is resumed.
     */
    onResumed() {
        this._isPaused = false;
        this._elapsed = 0;
        this._startTimer();
        this._updatePanelButton();
    }

    /**
     * Called when recording fully stops.
     */
    onRecordingStopped() {
        this._stopTimer();
        this._destroyPanelButton();
        this._elapsed = 0;
        this._pausedElapsed = 0;
        this._isPaused = false;
    }

    _createPanelButton() {
        console.log('[Big Shot Indicator] _createPanelButton start');
        this._destroyPanelButton();

        try {
            this._panelButton = new PanelMenu.Button(0.0, 'Big Shot Pause', true);
            console.log('[Big Shot Indicator] PanelMenu.Button created');
        } catch (e) {
            console.error('[Big Shot Indicator] PanelMenu.Button creation FAILED:', e.message, e.stack);
            return;
        }

        const box = new St.BoxLayout({
            style_class: 'panel-status-indicators-box',
            style: 'spacing: 4px;',
        });

        this._timerLabel = new St.Label({
            text: '00:00',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 12px; font-variant-numeric: tabular-nums;',
        });
        box.add_child(this._timerLabel);

        this._icon = new St.Icon({
            icon_name: 'media-playback-pause-symbolic',
            style_class: 'system-status-icon',
            icon_size: 16,
        });
        box.add_child(this._icon);

        this._panelButton.add_child(box);

        this._panelButton.connect('button-press-event', () => {
            this._onPauseClicked();
            return Clutter.EVENT_STOP;
        });

        // Position right before the native recording indicator (screenRecording)
        try {
            const nativeIndicator = Main.panel.statusArea['screenRecording'];
            if (nativeIndicator) {
                const rightBox = Main.panel._rightBox;
                const nativeIndex = rightBox.get_children().indexOf(nativeIndicator.container);
                Main.panel.addToStatusArea('big-shot-pause', this._panelButton, nativeIndex, 'right');
            } else {
                Main.panel.addToStatusArea('big-shot-pause', this._panelButton, 0, 'right');
            }
            console.log('[Big Shot Indicator] addToStatusArea SUCCESS, visible:', this._panelButton.visible, 'width:', this._panelButton.width);
        } catch (e) {
            console.error('[Big Shot Indicator] addToStatusArea FAILED:', e.message, e.stack);
        }
    }

    _destroyPanelButton() {
        if (this._panelButton) {
            this._panelButton.destroy();
            this._panelButton = null;
        }
        this._icon = null;
        this._timerLabel = null;
    }

    _updatePanelButton() {
        if (!this._icon) return;

        if (this._isPaused) {
            this._icon.icon_name = 'media-playback-start-symbolic';
            this._icon.add_style_class_name('big-shot-paused-icon');
            if (this._timerLabel)
                this._timerLabel.add_style_class_name('big-shot-paused-timer');
        } else {
            this._icon.icon_name = 'media-playback-pause-symbolic';
            this._icon.remove_style_class_name('big-shot-paused-icon');
            if (this._timerLabel)
                this._timerLabel.remove_style_class_name('big-shot-paused-timer');
        }
    }

    _onPauseClicked() {
        this._ext?.togglePauseRecording();
    }

    _startTimer() {
        this._stopTimer();
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            this._elapsed++;
            this._updateTimerLabel();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
    }

    _updateTimerLabel() {
        if (!this._timerLabel) return;
        const total = this._pausedElapsed + this._elapsed;
        const minutes = Math.floor(total / 60);
        const seconds = total % 60;
        this._timerLabel.text = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

    destroy() {
        this._stopTimer();
        this._destroyPanelButton();
        super.destroy();
    }
}
