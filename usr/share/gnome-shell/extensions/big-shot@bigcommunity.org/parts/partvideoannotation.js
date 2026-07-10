/**
 * Big Shot — Live video annotation
 *
 * Reuses the screenshot drawing tools on a TopChrome overlay so annotations
 * can be captured by the active screencast.
 *
 * SPDX-License-Identifier: MIT
 */

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { PartUI } from './partbase.js';
import { DrawingOverlay } from '../drawing/overlay.js';

export class PartVideoAnnotation extends PartUI {
    constructor(screenshotUI, extension) {
        super(screenshotUI, extension);

        this._toolbar = extension._toolbar;
        this._overlay = null;
        this._editing = false;
        this._activeMode = null; // null | 'live' | 'paused'
        this._resumePausedOnFinish = false;
        this._buttons = [];

        this._toolbar?.onToolChanged((toolId) => {
            this._onToolChanged(toolId);
        });
    }

    onRecordingStarted() {
        this._createPanelButtons();
    }

    onRecordingStopped() {
        this._finishEdit(false);
        this._destroyOverlay();
        this._destroyPanelButtons();
    }

    toggleLiveEdit() {
        if (this._activeMode === 'live') {
            this._finishEdit(false);
            return;
        }

        if (this._activeMode === 'paused')
            this._finishEdit(false);

        this._startEdit('live');
    }

    async togglePausedEdit() {
        if (this._activeMode === 'paused') {
            this._finishEdit(false);
            return;
        }

        if (this._activeMode === 'live')
            this._finishEdit(false);

        if (this._ext?._recordingState === 'recording') {
            this._resumePausedOnFinish = await this._ext.pauseRecording();
            if (!this._resumePausedOnFinish)
                return;
        } else {
            this._resumePausedOnFinish = this._ext?._recordingState === 'paused';
        }

        this._startEdit('paused');
    }

    togglePanelEdit() {
        if (this._ext?._recordingState === 'paused') {
            if (this._activeMode === 'paused') {
                this._finishEdit(false);
                return;
            }

            if (this._activeMode === 'live')
                this._finishEdit(false);

            this._resumePausedOnFinish = true;
            this._startEdit('paused');
            return;
        }

        this.toggleLiveEdit();
    }

    enterPausedEditFromPause() {
        if (this._activeMode === 'paused')
            return;

        if (this._activeMode === 'live')
            this._finishEdit(false);

        this._resumePausedOnFinish = this._ext?._recordingState === 'paused';
        this._startEdit('paused');
    }

    finishPausedEditFromPause() {
        if (this._activeMode !== 'paused')
            return false;
        this._finishEdit(false);
        return true;
    }

    finishEditForStop() {
        if (!this._editing && !this._activeMode)
            return;
        this._finishEdit(false);
    }

    clearAnnotations() {
        this._overlay?.clear();
    }

    _startEdit(mode) {
        if (!this._toolbar)
            return;

        this._ensureOverlay();
        if (!this._overlay)
            return;

        this._activeMode = mode;
        this._editing = true;
        if (mode === 'paused')
            this._overlay.clearPreviewCache();

        this._savedUndo = this._toolbar._onUndo;
        this._savedRedo = this._toolbar._onRedo;
        this._toolbar._onUndo = () => this._overlay?.undo();
        this._toolbar._onRedo = () => this._overlay?.redo();

        this._toolbar.attachEditForRecording(() => {
            this._finishEdit(false);
        });

        if (!this._toolbar.activeTool)
            this._toolbar.selectTool('pen');
        else
            this._overlay.setReactive(true);

        this._raiseRecordingControls();
        this._syncPanelButtons();
    }

    _finishEdit(resumePaused) {
        if (!this._editing && !this._activeMode)
            return;

        this._overlay?.clearSelection();
        this._overlay?.setReactive(false);

        if (this._toolbar) {
            this._toolbar.selectTool(null);
            this._toolbar.detachEditForRecording();
            this._toolbar._onUndo = this._savedUndo;
            this._toolbar._onRedo = this._savedRedo;
        }

        const shouldResume = resumePaused &&
            this._activeMode === 'paused' &&
            this._resumePausedOnFinish &&
            this._ext?._recordingState === 'paused';

        this._editing = false;
        this._activeMode = null;
        this._resumePausedOnFinish = false;

        if (shouldResume)
            this._ext.resumeRecording();

        this._syncPanelButtons();
    }

    _ensureOverlay() {
        if (this._overlay) {
            this._resizeOverlay();
            return;
        }

        this._overlay = new DrawingOverlay(this._ui, this._toolbar, {
            keyActor: global.stage,
            useTopChrome: true,
            liveVideo: true,
            enableEffectPreview: true,
            captureStageForPreview: true,
            shouldCaptureStagePreview: () => this._activeMode === 'paused' || this._activeMode === 'live',
            getPreviewHiddenActors: () => this._previewHiddenActors(),
            captureInputWithActor: true,
            shouldIgnoreEvent: (event, x, y) => this._isControlEvent(event, x, y),
            onCancel: () => this._finishEdit(false),
        });
        this._resizeOverlay();
    }

    _isControlEvent(event, stageX, stageY) {
        const target = event ? global.stage.get_event_actor(event) : null;
        if (this._toolbar?.containsRecordingControl?.(stageX, stageY, target))
            return true;

        const actors = this._panelControlActors();
        return this._actorIsDescendant(target, actors) ||
            actors.some(actor => this._actorContainsStagePoint(actor, stageX, stageY));
    }

    _previewHiddenActors() {
        return [
            ...(this._toolbar?.previewHiddenActors?.() ?? []),
            ...this._panelControlActors(),
        ];
    }

    _panelControlActors() {
        const pauseButton = this._ext?._indicator?._panelButton;
        const nativeIndicator = Main.panel.statusArea?.['screenRecording'];
        return [
            this._liveButton,
            this._liveButton?.container,
            this._clearButton,
            this._clearButton?.container,
            pauseButton,
            pauseButton?.container,
            nativeIndicator,
            nativeIndicator?.container,
        ].filter(Boolean);
    }

    _actorIsDescendant(actor, roots) {
        while (actor) {
            if (roots.includes(actor))
                return true;
            actor = actor.get_parent?.() ?? null;
        }
        return false;
    }

    _actorContainsStagePoint(actor, stageX, stageY) {
        if (!actor?.visible || stageX === null || stageY === null)
            return false;

        try {
            const [ok, x, y] = actor.transform_stage_point(stageX, stageY);
            if (!ok)
                return false;
            return x >= 0 && y >= 0 && x <= actor.width && y <= actor.height;
        } catch (_e) {
            return false;
        }
    }

    _resizeOverlay() {
        if (!this._overlay)
            return;

        const width = global.stage.width || Main.layoutManager.primaryMonitor.width;
        const height = global.stage.height || Main.layoutManager.primaryMonitor.height;
        const topInset = Main.panel?.visible ? Main.panel.height : 0;
        this._overlay.show(width, Math.max(1, height - topInset), 0, topInset);
    }

    _destroyOverlay() {
        this._overlay?.destroy();
        this._overlay = null;
    }

    _onToolChanged(toolId) {
        if (!this._editing || !this._overlay)
            return;

        const reactive = toolId !== null;
        this._overlay.setReactive(reactive);
        if (!reactive)
            this._overlay.clearSelection();
        if (reactive)
            this._raiseRecordingControls();
    }

    _raiseRecordingControls() {
        this._toolbar?.raiseRecordingToolbar?.();
    }

    _createPanelButtons() {
        if (this._buttons.length > 0)
            return;

        this._liveButton = this._makePanelButton(
            'document-edit-symbolic',
            _('Edit live'),
            () => this.togglePanelEdit(),
        );
        this._clearButton = this._makePanelButton(
            'edit-clear-symbolic',
            _('Clear annotations'),
            () => this.clearAnnotations(),
        );
        this._buttons = [this._liveButton, this._clearButton];

        try {
            const insertAt = this._panelInsertIndex();
            Main.panel.addToStatusArea('big-shot-video-live-edit', this._liveButton, insertAt, 'right');
            Main.panel.addToStatusArea('big-shot-video-clear', this._clearButton, insertAt + 1, 'right');
        } catch (e) {
            console.error(`[Big Shot] Video annotation buttons failed: ${e.message}`);
            this._destroyPanelButtons();
        }

        this._syncPanelButtons();
    }

    _panelInsertIndex() {
        const rightBox = Main.panel?._rightBox;
        const children = rightBox?.get_children?.() ?? [];

        const pauseIndicator = Main.panel.statusArea?.['big-shot-pause'];
        const pauseContainer = pauseIndicator?.container;
        const pauseIndex = pauseContainer ? children.indexOf(pauseContainer) : -1;
        if (pauseIndex >= 0)
            return pauseIndex + 1;

        const nativeIndicator = Main.panel.statusArea?.['screenRecording'];
        const nativeContainer = nativeIndicator?.container;
        const nativeIndex = nativeContainer ? children.indexOf(nativeContainer) : -1;
        if (nativeIndex >= 0)
            return nativeIndex;

        return 0;
    }

    _makePanelButton(iconName, accessibleName, callback) {
        const button = new PanelMenu.Button(0.0, accessibleName, true);
        const icon = new St.Icon({
            icon_name: iconName,
            style_class: 'system-status-icon',
            icon_size: 16,
        });
        button.add_child(icon);
        button._bigShotIcon = icon;
        button.connect('button-press-event', () => {
            callback();
            return Clutter.EVENT_STOP;
        });
        return button;
    }

    _syncPanelButtons() {
        this._setPanelIconActive(this._liveButton, this._activeMode !== null);
    }

    _setPanelIconActive(button, active) {
        const icon = button?._bigShotIcon;
        if (!icon)
            return;
        if (active)
            icon.set_style('color: #62a0ea;');
        else
            icon.set_style('');
    }

    _destroyPanelButtons() {
        for (const button of this._buttons)
            button?.destroy();
        this._buttons = [];
        this._liveButton = null;
        this._clearButton = null;
    }

    destroy() {
        this.onRecordingStopped();
        super.destroy();
    }
}
