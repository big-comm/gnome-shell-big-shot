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
        this._canPause = false;
        this._busy = false;
        this._stopFailed = false;
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
    onRecordingStarted(canPause) {
        this._elapsed = 0;
        this._pausedElapsed = 0;
        this._isPaused = false;
        this._canPause = canPause;
        this._busy = false;
        this._stopFailed = false;
        this._createPanelButton();
        this._startTimer();
    }

    /**
     * Called when recording is paused.
     */
    onPaused() {
        this._busy = false;
        this._stopFailed = false;
        this._isPaused = true;
        this._pausedElapsed += this._elapsed;
        this._elapsed = 0;
        this._stopTimer();
        this._updatePanelButton();
    }

    /**
     * Called when recording is resumed.
     */
    onResuming() {
        this._busy = true;
        this._isPaused = false;
        this._updatePanelButton();
    }

    onResumed() {
        this._busy = false;
        this._stopFailed = false;
        this._isPaused = false;
        this._elapsed = 0;
        this._startTimer();
        this._updatePanelButton();
    }

    onStopping() {
        this._busy = true;
        this._updatePanelButton();
    }

    onStopFailed() {
        this._busy = true;
        this._stopFailed = true;
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
        this._canPause = false;
        this._busy = false;
        this._stopFailed = false;
    }

    _createPanelButton() {
        this._destroyPanelButton();

        try {
            const accessibleName = this._canPause
                ? _('Pause recording')
                : _('Screen recording');
            this._panelButton = new PanelMenu.Button(0.0, accessibleName, true);
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
        const pauseBox = new St.BoxLayout({ style: 'spacing: 4px;' });
        pauseBox.add_child(this._timerLabel);

        if (this._canPause) {
            this._icon = new St.Icon({
                icon_name: 'media-playback-pause-symbolic',
                style_class: 'system-status-icon',
                icon_size: 16,
            });
            pauseBox.add_child(this._icon);
        }

        this._pauseButton = new St.Button({
            child: pauseBox,
            accessible_name: _('Pause recording'),
            reactive: this._canPause,
            can_focus: this._canPause,
        });
        this._pauseButton.connect('clicked', () => this._onPauseClicked());
        box.add_child(this._pauseButton);
        this._stopIcon = new St.Icon({
            icon_name: 'media-playback-stop-symbolic',
            style_class: 'system-status-icon',
            icon_size: 16,
        });
        const stopBox = new St.BoxLayout({ style: 'spacing: 4px;' });
        stopBox.add_child(this._stopIcon);
        this._stopText = new St.Label({
            text: _('Force stop'), visible: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        stopBox.add_child(this._stopText);
        this._stopButton = new St.Button({
            child: stopBox,
            accessible_name: _('Stop recording'),
            can_focus: true,
        });
        this._stopButton.connect('clicked', () => this._onStopClicked());
        box.add_child(this._stopButton);
        this._panelButton.add_child(box);

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
        this._pauseButton = null;
        this._stopButton = null;
        this._stopIcon = null;
        this._stopText = null;
    }

    _updatePanelButton() {
        this._updatePauseButton();
        this._updateStopButton();
        this._updatePauseIcon();
    }

    _updatePauseButton() {
        if (!this._pauseButton)
            return;
        this._pauseButton.reactive = this._canPause && !this._busy;
        this._pauseButton.accessible_name = this._isPaused
            ? _('Resume recording') : _('Pause recording');
    }

    _updateStopButton() {
        if (!this._stopButton)
            return;
        this._stopButton.accessible_name = this._stopFailed
            ? _('Force stop recording service (last fragment may be incomplete)')
            : _('Stop recording');
        this._stopIcon.icon_name = this._stopFailed
            ? 'process-stop-symbolic' : 'media-playback-stop-symbolic';
        this._stopText.visible = this._stopFailed;
    }

    _updatePauseIcon() {
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
        if (!this._busy)
            void this._ext?.togglePauseRecording();
    }

    _onStopClicked() {
        if (this._stopFailed)
            void this._ext?.forceStopRecording();
        else
            void this._ui?.stopScreencast();
    }

    _startTimer() {
        this._stopTimer();
        this._timerId = this._addTimeout(1000, () => {
            this._elapsed++;
            this._updateTimerLabel();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTimer() {
        if (this._timerId) {
            this._removeSource(this._timerId);
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
