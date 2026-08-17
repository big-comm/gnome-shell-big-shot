/**
 * Big Shot — Drawing Overlay
 *
 * A transparent Clutter.Actor overlay on top of the screenshot preview.
 * Handles mouse/touch input for drawing annotations using Cairo.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    DrawingMode,
    DrawingOptions,
    createAction,
    CensorAction,
    BlurAction,
    InvertAction,
    ZoomCalloutAction,
    TextAction,
    NumberStampAction,
    NumberArrowAction,
    NumberPointerAction,
} from './actions.js';

const TOOL_TO_MODE = {
    'pen': DrawingMode.PEN,
    'arrow': DrawingMode.ARROW,
    'line': DrawingMode.LINE,
    'rect': DrawingMode.RECT,
    'circle': DrawingMode.CIRCLE,
    'text': DrawingMode.TEXT,
    'highlight': DrawingMode.HIGHLIGHTER,
    'censor': DrawingMode.CENSOR,
    'blur': DrawingMode.BLUR,
    'invert': DrawingMode.INVERT,
    'zoom': DrawingMode.ZOOM_CALLOUT,
    'number': DrawingMode.NUMBER,
    'number-arrow': DrawingMode.NUMBER_ARROW,
    'number-pointer': DrawingMode.NUMBER_POINTER,
    'eraser': DrawingMode.ERASER,
    'select': DrawingMode.SELECT,
};

const MultilineEntry = GObject.registerClass(
class MultilineEntry extends St.Entry {
    vfunc_allocate(box) {
        super.vfunc_allocate(box);
        const contentBox = this.get_theme_node().get_content_box(box);
        this.clutter_text.allocate(contentBox);
        this.get_hint_actor()?.allocate(contentBox);
    }
});

export class DrawingOverlay {
    constructor(screenshotUI, toolbar, options = {}) {
        this._ui = screenshotUI;
        this._toolbar = toolbar;
        this._parentActor = options.parentActor ?? screenshotUI;
        this._keyActor = options.keyActor ?? screenshotUI;
        this._useTopChrome = Boolean(options.useTopChrome);
        this._liveVideo = Boolean(options.liveVideo);
        this._enableEffectPreview = options.enableEffectPreview ?? !this._liveVideo;
        this._onCancel = options.onCancel ?? null;
        this._useStageEvents = Boolean(options.useStageEvents);
        this._captureInputWithActor = Boolean(options.captureInputWithActor);
        this._eventActor = options.eventActor ?? global.stage;
        this._shouldIgnoreEvent = options.shouldIgnoreEvent ?? null;
        this._captureStageForPreview = Boolean(options.captureStageForPreview);
        this._shouldCaptureStagePreview = options.shouldCaptureStagePreview ?? (() => this._captureStageForPreview);
        this._getPreviewHiddenActors = options.getPreviewHiddenActors ?? (() => []);
        this._destroyed = false;
        this._sourceIds = new Set();
        this._pendingIdleWaits = new Map();
        this._eventsActive = false;
        this._originX = 0;
        this._originY = 0;
        this._actions = [];
        this._undoStack = [];
        this._currentStroke = null;
        this._startPoint = null;
        this._isDrawing = false;
        this._previewExcludedAction = null;
        // Number counters are computed dynamically from this._actions
        // See _getNextNumber()

        // Selection / move state
        this._selectedAction = null;
        this._isDragging = false;
        this._dragStart = null;
        // Resize-by-handle state (text actions)
        this._isResizing = false;
        this._resizeCenter = null;
        this._resizeStartDist = 0;
        this._resizeStartFont = 0;

        this._buildOverlay();
    }

    _addIdle(callback, priority = GLib.PRIORITY_DEFAULT) {
        if (this._destroyed)
            return 0;

        let id = 0;
        id = GLib.idle_add(priority, () => {
            let result = GLib.SOURCE_REMOVE;
            try {
                if (!this._destroyed)
                    result = callback();
                return result;
            } finally {
                if (result === GLib.SOURCE_REMOVE)
                    this._sourceIds.delete(id);
            }
        });
        this._sourceIds.add(id);
        return id;
    }

    _removeSource(id) {
        if (!id || !this._sourceIds.delete(id))
            return;
        GLib.source_remove(id);
    }

    _waitForIdle() {
        if (this._destroyed)
            return Promise.resolve(false);

        return new Promise(resolve => {
            let id = 0;
            id = this._addIdle(() => {
                this._pendingIdleWaits.delete(id);
                resolve(true);
                return GLib.SOURCE_REMOVE;
            });
            this._pendingIdleWaits.set(id, resolve);
        });
    }

    _cancelSources() {
        for (const resolve of this._pendingIdleWaits.values())
            resolve(false);
        this._pendingIdleWaits.clear();
        for (const id of this._sourceIds)
            GLib.source_remove(id);
        this._sourceIds.clear();
    }

    _getNextNumber(actionClass) {
        let count = 0;
        for (const action of this._actions) {
            if (action instanceof actionClass)
                count++;
        }
        return count + 1;
    }

    _buildOverlay() {
        // Create a St.DrawingArea for Cairo rendering.
        // Positioned between _areaSelector and _primaryMonitorBin in z-order:
        //   - ABOVE _areaSelector: when reactive, captures drawing events
        //   - BELOW _primaryMonitorBin: panel/close button still receive clicks
        // Reactivity is toggled by setReactive() when a drawing tool is active.
        this._actor = new St.DrawingArea({
            reactive: false,
            can_focus: true,
            x_expand: true,
            y_expand: true,
            accessible_name: _('Drawing canvas'),
        });

        // Connect repaint for Cairo drawing
        this._repaintId = this._actor.connect('repaint', (area) => {
            const cr = area.get_context();
            const [width, height] = area.get_surface_size();
            this._onDraw(cr, width, height);
        });

        // Direct event handlers on the actor.
        // These fire when the actor is reactive and under the pointer.
        // The GrabHelper in ScreenshotUI creates a ClutterGrab that blocks
        // global.stage captured-event, so we must use direct event handlers.
        this._actor.connect('button-press-event', (_actor, event) => {
            return this._onButtonPress(event);
        });
        this._actor.connect('button-release-event', (_actor, event) => {
            return this._onButtonRelease(event);
        });
        this._actor.connect('motion-event', (_actor, event) => {
            return this._onMotion(event);
        });
        this._actor.connect('scroll-event', (_actor, event) => {
            return this._onScroll(event);
        });
        this._actor.connect('key-press-event', (_actor, event) => {
            if (!this._actor?.visible) return Clutter.EVENT_PROPAGATE;
            return this._onKeyPress(event);
        });

        if (this._useStageEvents && !this._captureInputWithActor && this._eventActor) {
            this._stageEventId = this._eventActor.connect('captured-event',
                (_actor, event) => this._onStageCapturedEvent(event));
        }

        // Key events for shortcuts (connected to the UI itself)
        if (this._keyActor) {
            this._keyId = this._keyActor.connect('key-press-event', (_actor, event) => {
                if (!this._actor?.visible) return Clutter.EVENT_PROPAGATE;
                return this._onKeyPress(event);
            });
        }

        // Initially hidden
        this._actor.visible = false;

        // Insert BELOW _primaryMonitorBin (which contains panel/close button)
        // and ABOVE _areaSelector (the selection handles).
        if (this._useTopChrome) {
            Main.layoutManager.addTopChrome(this._actor, {
                trackFullscreen: false,
            });
            this._addedAsChrome = true;
        } else if (this._ui) {
            const primaryBin = this._ui._primaryMonitorBin;
            if (primaryBin?.get_parent() === this._ui) {
                this._ui.insert_child_below(this._actor, primaryBin);
            } else {
                this._ui.add_child(this._actor);
            }
        }
    }

    show(width, height, x = 0, y = 0) {
        this._originX = x;
        this._originY = y;
        this._actor.set_position(x, y);
        this._actor.set_size(width, height);
        this._actor.visible = true;
        this._actor.queue_repaint();
    }

    hide() {
        this._actor.visible = false;
    }

    /**
     * Enable/disable event capture for drawing.
     * Toggles the actor's reactivity so it captures mouse events directly.
     * When reactive, the actor (positioned above _areaSelector but below
     * _primaryMonitorBin) intercepts clicks for drawing; the native panel
     * and close button remain clickable since they're in a higher z-layer.
     */
    setReactive(active) {
        if (this._captureInputWithActor) {
            this._eventsActive = false;
            if (this._actor) {
                this._actor.reactive = active;
                if (active)
                    this._actor.grab_key_focus?.();
            }
        } else if (this._useStageEvents) {
            this._eventsActive = active;
            if (this._actor)
                this._actor.reactive = false;
        } else if (this._actor) {
            this._actor.reactive = active;
            if (active)
                this._actor.grab_key_focus?.();
        }
        if (!active) {
            // Reset drawing state when deactivating
            this._isDrawing = false;
            this._currentStroke = null;
            this._startPoint = null;
            this._currentEndPoint = null;
            this._isDragging = false;
            this._dragStart = null;
        }
    }

    _onStageCapturedEvent(event) {
        if (!this._eventsActive || !this._actor?.visible)
            return Clutter.EVENT_PROPAGATE;

        const type = event.type();

        if (type === Clutter.EventType.KEY_PRESS) {
            if (this._shouldIgnoreStageEvent(event, null, null))
                return Clutter.EVENT_PROPAGATE;
            return this._onKeyPress(event);
        }

        if (type === Clutter.EventType.BUTTON_PRESS) {
            const [x, y] = event.get_coords();
            if (this._actorContainsStagePoint(this._textPopover, x, y) ||
                this._shouldIgnoreStageEvent(event, x, y))
                return Clutter.EVENT_PROPAGATE;
            return this._onButtonPress(event);
        }

        if (type === Clutter.EventType.MOTION) {
            if (!this._isDrawing && !this._isDragging && !this._isResizing)
                return Clutter.EVENT_PROPAGATE;
            return this._onMotion(event);
        }

        if (type === Clutter.EventType.BUTTON_RELEASE) {
            if (!this._isDrawing && !this._isDragging && !this._isResizing)
                return Clutter.EVENT_PROPAGATE;
            return this._onButtonRelease(event);
        }

        if (type === Clutter.EventType.SCROLL) {
            if (!(this._selectedAction instanceof ZoomCalloutAction) &&
                !(this._selectedAction instanceof TextAction))
                return Clutter.EVENT_PROPAGATE;
            return this._onScroll(event);
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _shouldIgnoreStageEvent(event, x, y) {
        if (!this._shouldIgnoreEvent)
            return false;

        if (this._shouldIgnoreEvent.length >= 3)
            return this._shouldIgnoreEvent(event, x, y);
        return this._shouldIgnoreEvent(x, y);
    }

    _actorContainsStagePoint(actor, stageX, stageY) {
        if (!actor?.visible)
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

    _getOptions() {
        const toolbar = this._toolbar;
        const mode = TOOL_TO_MODE[toolbar?.activeTool] || DrawingMode.PEN;
        const colorHex = toolbar?.currentColor || '#ed333b';
        const fillHex = toolbar?.fillColor;
        const size = toolbar?.brushSize || 3;
        const intensity = toolbar?.intensity || 3;

        let fillColor = null;
        if (mode === DrawingMode.NUMBER || mode === DrawingMode.NUMBER_ARROW || mode === DrawingMode.NUMBER_POINTER) {
            fillColor = this._hexToRGBA(colorHex);
        } else if (fillHex) {
            fillColor = this._hexToRGBA(fillHex);
        }

        return new DrawingOptions({
            mode,
            primaryColor: this._hexToRGBA(colorHex),
            size,
            fillColor,
            font: toolbar?.currentFont || 'Sans',
            intensity,
            liveVideo: this._liveVideo,
        });
    }

    _hexToRGBA(hex) {
        const r = parseInt(hex.slice(1, 3), 16) / 255;
        const g = parseInt(hex.slice(3, 5), 16) / 255;
        const b = parseInt(hex.slice(5, 7), 16) / 255;
        return [r, g, b, 1.0];
    }

    _toImageCoords(x, y) {
        // Convert widget coordinates to image coordinates
        // For now, 1:1 mapping (will be adjusted when crop/zoom is implemented)
        return [x, y];
    }

    _toWidgetCoords(x, y) {
        return [x - this._originX, y - this._originY];
    }

    // =========================================================================
    // INPUT HANDLERS
    // =========================================================================

    _onButtonPress(event) {
        const [x, y] = event.get_coords();
        const [ix, iy] = this._toImageCoords(x, y);
        const now = GLib.get_monotonic_time();

        // Selection mode: no tool active or select tool → select/move objects
        const isSelectMode = !this._toolbar?.activeTool || this._toolbar.activeTool === 'select';

        // Eraser mode: click on an action to remove it
        const isEraserMode = this._toolbar?.activeTool === 'eraser';
        if (isEraserMode) {
            for (let i = this._actions.length - 1; i >= 0; i--) {
                if (this._actions[i].containsPoint(ix, iy)) {
                    this._undoStack.push(this._actions.splice(i, 1)[0]);
                    this._actor.queue_repaint();
                    return Clutter.EVENT_STOP;
                }
            }
            return Clutter.EVENT_STOP;
        }

        if (isSelectMode) {
            // Grabbing a corner handle of the selected text starts a resize.
            if (this._selectedAction instanceof TextAction &&
                this._hitTextResizeHandle(this._selectedAction, ix, iy)) {
                const [minX, minY, maxX, maxY] = this._selectedAction.getBounds();
                this._resizeCenter = [(minX + maxX) / 2, (minY + maxY) / 2];
                this._resizeStartDist = Math.max(1, Math.hypot(
                    ix - this._resizeCenter[0], iy - this._resizeCenter[1]));
                this._resizeStartFont = this._selectedAction.fontSize;
                this._isResizing = true;
                return Clutter.EVENT_STOP;
            }

            // Try to find an action under the cursor (top-most first)
            let found = null;
            for (let i = this._actions.length - 1; i >= 0; i--) {
                if (this._actions[i].containsPoint(ix, iy)) {
                    found = this._actions[i];
                    break;
                }
            }

            // Double-click on TextAction → edit it
            if (found instanceof TextAction &&
                this._lastClickAction === found &&
                (now - this._lastClickTime) < 500000) { // 500ms
                this._lastClickAction = null;
                this._lastClickTime = 0;
                this._editTextAction(found);
                return Clutter.EVENT_STOP;
            }

            // Double-click on a zoom callout → add / edit its caption
            if (found instanceof ZoomCalloutAction &&
                this._lastClickAction === found &&
                (now - this._lastClickTime) < 500000) { // 500ms
                this._lastClickAction = null;
                this._lastClickTime = 0;
                this._showCaptionPopover(found);
                return Clutter.EVENT_STOP;
            }

            this._lastClickAction = found;
            this._lastClickTime = now;

            this._selectedAction = found;
            if (found) {
                this._isDragging = true;
                this._dragStart = [ix, iy];
                this._actor.queue_repaint();
                return Clutter.EVENT_STOP;
            }
            this._actor.queue_repaint();
            return Clutter.EVENT_PROPAGATE;
        }

        // Drawing mode
        const mode = TOOL_TO_MODE[this._toolbar.activeTool] || DrawingMode.PEN;
        this._isDrawing = true;
        this._startPoint = [ix, iy];

        if (mode === DrawingMode.PEN || mode === DrawingMode.HIGHLIGHTER) {
            this._currentStroke = [[ix, iy]];
        }

        return Clutter.EVENT_STOP;
    }

    _onMotion(event) {
        const [x, y] = event.get_coords();
        const [ix, iy] = this._toImageCoords(x, y);

        // Resize mode — scaling selected text via a corner handle
        if (this._isResizing && this._selectedAction && this._resizeCenter) {
            const d = Math.hypot(ix - this._resizeCenter[0], iy - this._resizeCenter[1]);
            const f = this._resizeStartFont * (d / this._resizeStartDist);
            this._selectedAction.fontSize = Math.max(8, Math.min(200, f));
            this._actor.queue_repaint();
            return Clutter.EVENT_STOP;
        }

        // Drag mode — moving selected action
        if (this._isDragging && this._selectedAction && this._dragStart) {
            const dx = ix - this._dragStart[0];
            const dy = iy - this._dragStart[1];
            this._selectedAction.translate(dx, dy);
            this._dragStart = [ix, iy];
            this._actor.queue_repaint();
            return Clutter.EVENT_STOP;
        }

        if (!this._isDrawing) return Clutter.EVENT_STOP;

        const mode = TOOL_TO_MODE[this._toolbar.activeTool] || DrawingMode.PEN;

        if ((mode === DrawingMode.PEN || mode === DrawingMode.HIGHLIGHTER) && this._currentStroke) {
            this._currentStroke.push([ix, iy]);
        }

        // Track current endpoint for all modes (needed for live shape preview)
        this._currentEndPoint = [ix, iy];
        this._actor.queue_repaint();

        return Clutter.EVENT_STOP;
    }

    _onButtonRelease(event) {
        // End resize
        if (this._isResizing) {
            this._isResizing = false;
            this._resizeCenter = null;
            return Clutter.EVENT_STOP;
        }

        // End drag
        if (this._isDragging) {
            this._isDragging = false;
            this._dragStart = null;
            return Clutter.EVENT_STOP;
        }

        if (!this._isDrawing) return Clutter.EVENT_STOP;

        const [x, y] = event.get_coords();
        const [ix, iy] = this._toImageCoords(x, y);
        const mode = TOOL_TO_MODE[this._toolbar.activeTool] || DrawingMode.PEN;
        const shift = (event.get_state() & Clutter.ModifierType.SHIFT_MASK) !== 0;
        const options = this._getOptions();

        let action = null;

        switch (mode) {
            case DrawingMode.PEN:
                if (this._currentStroke?.length > 1) {
                    action = createAction(DrawingMode.PEN, { stroke: this._currentStroke }, options);
                }
                break;
            case DrawingMode.HIGHLIGHTER:
                if (this._currentStroke?.length > 1) {
                    action = createAction(DrawingMode.HIGHLIGHTER, {
                        stroke: this._currentStroke, shift,
                    }, options);
                }
                break;
            case DrawingMode.ARROW:
                action = createAction(DrawingMode.ARROW, {
                    start: this._startPoint, end: [ix, iy], shift,
                }, options);
                break;
            case DrawingMode.LINE:
                action = createAction(DrawingMode.LINE, {
                    start: this._startPoint, end: [ix, iy], shift,
                }, options);
                break;
            case DrawingMode.RECT:
                action = createAction(DrawingMode.RECT, {
                    start: this._startPoint, end: [ix, iy], shift,
                }, options);
                break;
            case DrawingMode.CIRCLE:
                action = createAction(DrawingMode.CIRCLE, {
                    start: this._startPoint, end: [ix, iy], shift,
                }, options);
                break;
            case DrawingMode.CENSOR:
                action = createAction(DrawingMode.CENSOR, {
                    start: this._startPoint, end: [ix, iy],
                }, options);
                break;
            case DrawingMode.BLUR:
                action = createAction(DrawingMode.BLUR, {
                    start: this._startPoint, end: [ix, iy],
                }, options);
                break;
            case DrawingMode.INVERT:
                action = createAction(DrawingMode.INVERT, {
                    start: this._startPoint, end: [ix, iy],
                }, options);
                break;
            case DrawingMode.ZOOM_CALLOUT: {
                const zdx = ix - this._startPoint[0];
                const zdy = iy - this._startPoint[1];
                if (Math.abs(zdx) > 8 && Math.abs(zdy) > 8) {
                    const zoom = 2;
                    const destPos = this._computeCalloutDest(this._startPoint, [ix, iy], zoom);
                    action = createAction(DrawingMode.ZOOM_CALLOUT, {
                        start: this._startPoint, end: [ix, iy], destPos, zoom,
                    }, options);
                }
                break;
            }
            case DrawingMode.TEXT:
                // Show text entry popover instead of hardcoded text
                this._showTextPopover(this._startPoint, options);
                this._isDrawing = false;
                this._currentStroke = null;
                this._startPoint = null;
                return Clutter.EVENT_STOP;
            case DrawingMode.NUMBER:
                action = createAction(DrawingMode.NUMBER, {
                    position: this._startPoint,
                    number: this._getNextNumber(NumberStampAction),
                }, options);
                break;
            case DrawingMode.NUMBER_ARROW: {
                const dx = ix - this._startPoint[0];
                const dy = iy - this._startPoint[1];
                if (Math.hypot(dx, dy) >= 5) {
                    action = createAction(DrawingMode.NUMBER_ARROW, {
                        start: this._startPoint,
                        end: [ix, iy],
                        number: this._getNextNumber(NumberArrowAction),
                    }, options);
                }
                break;
            }
            case DrawingMode.NUMBER_POINTER: {
                const dx = ix - this._startPoint[0];
                const dy = iy - this._startPoint[1];
                if (Math.hypot(dx, dy) >= 5) {
                    action = createAction(DrawingMode.NUMBER_POINTER, {
                        start: this._startPoint,
                        end: [ix, iy],
                        number: this._getNextNumber(NumberPointerAction),
                    }, options);
                }
                break;
            }
            case DrawingMode.ERASER:
                // Eraser is handled in _onButtonPress (click-to-remove)
                break;
        }

        if (action) {
            this._actions.push(action);
            this._undoStack = []; // Clear redo stack on new action

            // Generate real preview for effect actions (censor/blur/invert/zoom)
            if (action instanceof CensorAction || action instanceof BlurAction ||
                action instanceof InvertAction || action instanceof ZoomCalloutAction) {
                if (this._liveVideo && this._captureStageForPreview)
                    this.clearPreviewCache();
                this._generateEffectPreview(action).catch(e =>
                    console.error(`[Big Shot] Preview generation failed: ${e.message}`),
                );
            }
        }

        // Newly created zoom callout → prompt for an optional caption.
        if (action instanceof ZoomCalloutAction)
            this._showCaptionPopover(action);

        this._isDrawing = false;
        this._currentStroke = null;
        this._startPoint = null;
        this._currentEndPoint = null;
        this._actor.queue_repaint();

        return Clutter.EVENT_STOP;
    }

    _onScroll(event) {
        // Scroll over a selected zoom callout adjusts its magnification;
        // over a selected text it adjusts the font size.
        const sel = this._selectedAction;
        if (!(sel instanceof ZoomCalloutAction) && !(sel instanceof TextAction))
            return Clutter.EVENT_PROPAGATE;

        const dir = event.get_scroll_direction();
        let delta = 0;
        if (dir === Clutter.ScrollDirection.UP) {
            delta = 1;
        } else if (dir === Clutter.ScrollDirection.DOWN) {
            delta = -1;
        } else if (dir === Clutter.ScrollDirection.SMOOTH) {
            const [, dy] = event.get_scroll_delta();
            if (dy < 0) delta = 1;
            else if (dy > 0) delta = -1;
            else return Clutter.EVENT_PROPAGATE;
        } else {
            return Clutter.EVENT_PROPAGATE;
        }

        if (sel instanceof ZoomCalloutAction) {
            sel.setZoom(sel.zoom + delta * 0.25);
            this._clampActionToCanvas(sel);
        } else { // TextAction
            sel.fontSize = Math.max(8, Math.min(200, sel.fontSize + delta * 2));
        }
        this._actor.queue_repaint();
        return Clutter.EVENT_STOP;
    }

    /** Keep a zoom callout's inset (and its caption) inside the canvas. */
    _clampActionToCanvas(action) {
        if (!(action instanceof ZoomCalloutAction) || !this._actor) return;
        const W = this._actor.width;
        const H = this._actor.height;
        // Reserve room for the caption band below the inset so it isn't clipped.
        const capH = typeof action.captionBlockHeight === 'function'
            ? action.captionBlockHeight() : 0;
        const x = Math.min(Math.max(0, action.destPos[0]), Math.max(0, W - action.destW));
        const y = Math.min(Math.max(0, action.destPos[1]), Math.max(0, H - action.destH - capH));
        action.destPos = [x, y];
    }

    /** True if (ix,iy) is over one of the selection's corner handles. */
    _hitTextResizeHandle(action, ix, iy, tol = 12) {
        const [minX, minY, maxX, maxY] = action.getBounds();
        const corners = [[minX, minY], [maxX, minY], [minX, maxY], [maxX, maxY]];
        return corners.some(([cx, cy]) =>
            Math.abs(ix - cx) <= tol && Math.abs(iy - cy) <= tol);
    }

    _onKeyPress(event) {
        const key = event.get_key_symbol();
        const ctrl = (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const shift = (event.get_state() & Clutter.ModifierType.SHIFT_MASK) !== 0;

        // Ctrl+Z = Undo
        if (ctrl && !shift && key === Clutter.KEY_z) {
            this.undo();
            return Clutter.EVENT_STOP;
        }

        // Ctrl+Shift+Z or Ctrl+Y = Redo
        if ((ctrl && shift && key === Clutter.KEY_z) || (ctrl && key === Clutter.KEY_y)) {
            this.redo();
            return Clutter.EVENT_STOP;
        }

        // Delete = remove last action (or selected action)
        if (key === Clutter.KEY_Delete || key === Clutter.KEY_BackSpace) {
            if (this._selectedAction) {
                const idx = this._actions.indexOf(this._selectedAction);
                if (idx >= 0) {
                    this._undoStack.push(this._actions.splice(idx, 1)[0]);
                    this._selectedAction = null;
                    this._actor.queue_repaint();
                }
            } else if (this._actions.length > 0) {
                this._undoStack.push(this._actions.pop());
                this._actor.queue_repaint();
            }
            return Clutter.EVENT_STOP;
        }

        // Keyboard tool shortcuts
        const TOOL_KEYS = {
            [Clutter.KEY_1]: 'pen',
            [Clutter.KEY_2]: 'arrow',
            [Clutter.KEY_3]: 'line',
            [Clutter.KEY_4]: 'rect',
            [Clutter.KEY_5]: 'circle',
            [Clutter.KEY_6]: 'text',
            [Clutter.KEY_7]: 'highlight',
            [Clutter.KEY_8]: 'censor',
            [Clutter.KEY_9]: 'number',
            [Clutter.KEY_b]: 'blur',
            [Clutter.KEY_i]: 'invert',
            [Clutter.KEY_e]: 'eraser',
        };

        if (!ctrl && !shift && TOOL_KEYS[key]) {
            this._toolbar?.selectTool(TOOL_KEYS[key]);
            return Clutter.EVENT_STOP;
        }

        // 0 or S → selection mode
        if (!ctrl && !shift && (key === Clutter.KEY_0 || key === Clutter.KEY_s)) {
            this._toolbar?.selectTool(null); // Deselect all → enter select mode
            return Clutter.EVENT_STOP;
        }

        // Escape → deselect current selection
        if (key === Clutter.KEY_Escape) {
            if (this._onCancel) {
                this._onCancel();
                return Clutter.EVENT_STOP;
            }
            if (this._selectedAction) {
                this._selectedAction = null;
                this._actor.queue_repaint();
                return Clutter.EVENT_STOP;
            }
        }

        return Clutter.EVENT_PROPAGATE;
    }

    // =========================================================================
    // TEXT POPOVER
    // =========================================================================

    _showTextPopover(position, options, existingAction = null, custom = null) {
        this._closeTextPopover();

        const [wx, wy] = this._useTopChrome
            ? position
            : this._toWidgetCoords(position[0], position[1]);

        this._textPopover = new St.BoxLayout({
            style: 'background: rgba(30,30,30,0.95); border-radius: 8px; padding: 8px; ' +
                   'border: 1px solid rgba(255,255,255,0.15);',
            vertical: false,
            reactive: true,
        });

        const EntryClass = custom ? St.Entry : MultilineEntry;
        this._textEntry = new EntryClass({
            hint_text: custom?.hint ?? _('Text…'),
            style: custom
                ? 'width: 200px; min-height: 28px; font-size: 14px;'
                : 'width: 320px; min-height: 96px; border-radius: 10px; font-size: 14px;',
            can_focus: true,
            accessible_name: custom?.accessibleName ?? _('Annotation text'),
        });

        const textActor = this._textEntry.clutter_text;
        const multiline = !custom;
        textActor.set_single_line_mode(!multiline);
        textActor.set_line_wrap(multiline);
        textActor.set_activatable(!multiline);

        // Pre-fill: custom flow supplies its own initial text; otherwise editing.
        if (custom) {
            if (custom.initialText) this._textEntry.set_text(custom.initialText);
        } else if (existingAction) {
            this._textEntry.set_text(existingAction.text);
        }

        // Live preview for custom flows (e.g. caption) as the user types.
        if (custom?.onChange) {
            this._textEntry.clutter_text.connect('text-changed', () => {
                custom.onChange(this._textEntry.get_text());
            });
        }

        const confirmBtn = new St.Button({
            style_class: 'screenshot-ui-show-pointer-button',
            child: new St.Icon({ icon_name: 'object-select-symbolic', icon_size: 16 }),
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: _('Confirm'),
        });

        const confirmAction = () => {
            const text = this._textEntry.get_text().trim();
            if (custom) {
                custom.onConfirm(text);
            } else if (existingAction) {
            // Editing existing text
                if (text) {
                    existingAction.text = text;
                } else {
                    // Empty text → remove the action
                    const idx = this._actions.indexOf(existingAction);
                    if (idx >= 0) {
                        this._undoStack.push(this._actions.splice(idx, 1)[0]);
                    }
                }
            } else if (text) {
                // Creating new text
                const action = createAction(DrawingMode.TEXT, {
                    position,
                    text,
                    fontSize: options.size * 5,
                }, options);
                if (action) {
                    this._actions.push(action);
                    this._undoStack = [];
                }
            }
            this._closeTextPopover();
            this._actor.queue_repaint();
        };

        confirmBtn.connect('clicked', confirmAction);
        if (!multiline)
            textActor.connect('activate', confirmAction);

        // Multiline text: Enter inserts a line break; Ctrl+Enter confirms.
        // Custom single-line flows retain Enter-to-confirm behavior.
        textActor.connect('key-press-event', (_actor, event) => {
            const key = event.get_key_symbol();
            if (key === Clutter.KEY_Escape) {
                custom?.onCancel?.();
                this._closeTextPopover();
                return Clutter.EVENT_STOP;
            }
            if (multiline &&
                (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter)) {
                if (event.get_state() & Clutter.ModifierType.CONTROL_MASK) {
                    confirmAction();
                    return Clutter.EVENT_STOP;
                }

                let cursor = textActor.cursor_position;
                const selection = textActor.selection_bound;
                if (cursor < 0)
                    cursor = textActor.get_text().length;
                if (selection >= 0 && selection !== cursor) {
                    const start = Math.min(cursor, selection);
                    const end = Math.max(cursor, selection);
                    textActor.delete_text(start, end);
                    cursor = start;
                }
                textActor.insert_text('\n', cursor);
                textActor.set_cursor_position(cursor + 1);
                textActor.set_selection_bound(cursor + 1);
                return Clutter.EVENT_STOP;
            }
            if (custom?.onKey && custom.onKey(event))
                return Clutter.EVENT_STOP;
            return Clutter.EVENT_PROPAGATE;
        });

        this._textPopover.add_child(this._textEntry);
        if (custom?.extraChild)
            this._textPopover.add_child(custom.extraChild);
        this._textPopover.add_child(confirmBtn);

        this._addFloatingChild(this._textPopover);
        this._textPopover.set_position(
            Math.max(0, wx - 100),
            Math.max(0, wy - 44),
        );

        // Focus the entry after a frame
        this._focusIdleId = this._addIdle(() => {
            this._focusIdleId = 0;
            if (this._textEntry) {
                this._textEntry.grab_key_focus();
                // Select all text when editing (existing action or pre-filled custom)
                if (existingAction || custom?.initialText) {
                    const clutterText = this._textEntry.clutter_text;
                    clutterText.set_selection(0, clutterText.get_text().length);
                }
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _editTextAction(action) {
        this._selectedAction = null;
        this._showTextPopover(action.position, action.options, action);
    }

    /** Prompt for / edit a zoom callout's caption (empty = no caption). */
    _showCaptionPopover(action) {
        this._selectedAction = null;
        const anchor = [action.destPos[0], action.destPos[1] + action.destH];
        const origCaption = action.caption;
        const origSizeIndex = action.captionSizeIndex;
        const origStyle = action.captionStyle;

        // Button to toggle the caption style (neutral strip ↔ orange highlight
        // box). Its background reflects the active style so toggling is obvious.
        const styleLabel = new St.Label({ text: '★',
            style: 'color: #ffffff; font-weight: bold; padding: 0 6px;',
            y_align: Clutter.ActorAlign.CENTER });
        const styleBtn = new St.Button({
            child: styleLabel,
            can_focus: false,
            accessible_name: _('Caption style — click to toggle highlight / neutral'),
        });
        const refreshStyleBtn = () => {
            styleBtn.set_style(action.captionStyle === 'highlight'
                ? 'background: #dd4814; border-radius: 6px; border: 1px solid rgba(255,255,255,0.4); min-height: 28px;'
                : 'background: rgba(255,255,255,0.12); border-radius: 6px; border: 1px solid rgba(255,255,255,0.2); min-height: 28px;');
        };
        refreshStyleBtn();
        styleBtn.connect('clicked', () => {
            action.toggleCaptionStyle();
            refreshStyleBtn();
            this._actor.queue_repaint();
            this._textEntry?.grab_key_focus();
        });

        this._showTextPopover(anchor, action.options, null, {
            hint: _('Caption (↑/↓ = size)…'),
            accessibleName: _('Zoom caption'),
            initialText: action.caption || '',
            extraChild: styleBtn,
            // Live preview while typing; nudge the inset up if the caption
            // would run past the bottom of the canvas.
            onChange: (text) => {
                action.setCaption(text);
                this._clampActionToCanvas(action);
                this._actor.queue_repaint();
            },
            // Up/Down cycle the caption size (P/M/G).
            onKey: (event) => {
                const sym = event.get_key_symbol();
                if (sym === Clutter.KEY_Up || sym === Clutter.KEY_Down) {
                    action.cycleCaptionSize(sym === Clutter.KEY_Up ? 1 : -1);
                    this._clampActionToCanvas(action);
                    this._actor.queue_repaint();
                    return true;
                }
                return false;
            },
            onConfirm: (text) => action.setCaption(text),
            // Restore on cancel so a discarded edit leaves nothing behind.
            onCancel: () => {
                action.caption = origCaption;
                action.captionSizeIndex = origSizeIndex;
                action.captionStyle = origStyle;
                this._actor.queue_repaint();
            },
        });
    }

    _closeTextPopover() {
        if (this._focusIdleId) {
            this._removeSource(this._focusIdleId);
            this._focusIdleId = 0;
        }
        if (this._textPopover?._bigShotChrome) {
            try { Main.layoutManager.removeChrome(this._textPopover); } catch (_e) { /* */ }
            this._textPopover._bigShotChrome = false;
        }
        this._textPopover?.destroy();
        this._textPopover = null;
        this._textEntry = null;

        // Return focus to the screenshot UI so Enter key works for capture
        this._ui?.grab_key_focus?.();
    }

    _addFloatingChild(actor) {
        if (this._useTopChrome) {
            Main.layoutManager.addTopChrome(actor, {
                trackFullscreen: false,
            });
            actor._bigShotChrome = true;
            return;
        }
        this._ui?.add_child(actor);
    }

    // =========================================================================
    // UNDO / REDO
    // =========================================================================

    undo() {
        if (this._actions.length === 0) return;
        this._undoStack.push(this._actions.pop());
        this._actor.queue_repaint();
    }

    redo() {
        if (this._undoStack.length === 0) return;
        this._actions.push(this._undoStack.pop());
        this._actor.queue_repaint();
    }

    // =========================================================================
    // RENDERING
    // =========================================================================

    _onDraw(cr, _width, _height) {
        // Clear (Cairo.Operator.CLEAR = 0)
        cr.save();
        cr.setOperator(0);
        cr.paint();
        cr.restore();

        const scale = 1.0; // Will be dynamic with zoom
        const toWidget = (x, y) => this._toWidgetCoords(x, y);

        // Draw all committed actions
        for (const action of this._actions) {
            if (action === this._previewExcludedAction)
                continue;

            cr.save();
            cr.newPath();
            action.draw(cr, toWidget, scale);
            cr.restore();
        }

        // Draw current in-progress action (live preview while dragging)
        if (this._isDrawing && this._startPoint) {
            const options = this._getOptions();
            const mode = TOOL_TO_MODE[this._toolbar.activeTool] || DrawingMode.PEN;
            let tempAction;
            const end = this._currentEndPoint || this._startPoint;

            switch (mode) {
                case DrawingMode.PEN:
                    if (this._currentStroke?.length > 1)
                        tempAction = createAction(DrawingMode.PEN, { stroke: this._currentStroke }, options);
                    break;
                case DrawingMode.HIGHLIGHTER:
                    if (this._currentStroke?.length > 1)
                        tempAction = createAction(DrawingMode.HIGHLIGHTER, { stroke: this._currentStroke, shift: false }, options);
                    break;
                case DrawingMode.ARROW:
                    tempAction = createAction(DrawingMode.ARROW, { start: this._startPoint, end, shift: false }, options);
                    break;
                case DrawingMode.LINE:
                    tempAction = createAction(DrawingMode.LINE, { start: this._startPoint, end, shift: false }, options);
                    break;
                case DrawingMode.RECT:
                    tempAction = createAction(DrawingMode.RECT, { start: this._startPoint, end, shift: false }, options);
                    break;
                case DrawingMode.CIRCLE:
                    tempAction = createAction(DrawingMode.CIRCLE, { start: this._startPoint, end, shift: false }, options);
                    break;
                case DrawingMode.CENSOR:
                    tempAction = createAction(DrawingMode.CENSOR, { start: this._startPoint, end }, options);
                    break;
                case DrawingMode.BLUR:
                    tempAction = createAction(DrawingMode.BLUR, { start: this._startPoint, end }, options);
                    break;
                case DrawingMode.INVERT:
                    tempAction = createAction(DrawingMode.INVERT, { start: this._startPoint, end }, options);
                    break;
                case DrawingMode.NUMBER_ARROW:
                    tempAction = createAction(DrawingMode.NUMBER_ARROW, {
                        start: this._startPoint, end, number: this._getNextNumber(NumberArrowAction),
                    }, options);
                    break;
                case DrawingMode.NUMBER_POINTER:
                    tempAction = createAction(DrawingMode.NUMBER_POINTER, {
                        start: this._startPoint, end, number: this._getNextNumber(NumberPointerAction),
                    }, options);
                    break;
            }

            if (tempAction) {
                cr.save();
                cr.newPath();
                tempAction.draw(cr, toWidget, scale);
                cr.restore();
            }

            // Zoom callout: just show the source selection while dragging;
            // the magnified inset appears on release once pixels are captured.
            if (mode === DrawingMode.ZOOM_CALLOUT) {
                const [wx1, wy1] = toWidget(...this._startPoint);
                const [wx2, wy2] = toWidget(...end);
                cr.save();
                cr.setSourceRGBA(0.384, 0.627, 0.917, 0.95); // #62a0ea
                cr.setLineWidth(1.5);
                cr.setDash([5, 4], 0);
                cr.rectangle(
                    Math.min(wx1, wx2), Math.min(wy1, wy2),
                    Math.abs(wx2 - wx1), Math.abs(wy2 - wy1),
                );
                cr.stroke();
                cr.restore();
            }
        }

        // Draw selection bounding box
        if (this._selectedAction) {
            const [minX, minY, maxX, maxY] = this._selectedAction.getBounds();
            const [wx1, wy1] = toWidget(minX, minY);
            const [wx2, wy2] = toWidget(maxX, maxY);
            const pad = 4;

            cr.save();
            cr.setSourceRGBA(0.384, 0.627, 0.917, 0.9); // #62a0ea
            cr.setLineWidth(1.5);
            cr.setDash([4, 4], 0);
            cr.rectangle(wx1 - pad, wy1 - pad, wx2 - wx1 + 2 * pad, wy2 - wy1 + 2 * pad);
            cr.stroke();

            // Small handles at corners
            const handleSize = 5;
            cr.setDash([], 0);
            for (const [hx, hy] of [[wx1 - pad, wy1 - pad], [wx2 + pad, wy1 - pad],
                                     [wx1 - pad, wy2 + pad], [wx2 + pad, wy2 + pad]]) {
                cr.setSourceRGBA(1, 1, 1, 1);
                cr.rectangle(hx - handleSize / 2, hy - handleSize / 2, handleSize, handleSize);
                cr.fill();
                cr.setSourceRGBA(0.384, 0.627, 0.917, 1);
                cr.rectangle(hx - handleSize / 2, hy - handleSize / 2, handleSize, handleSize);
                cr.stroke();
            }
            cr.restore();
        }

        return true;
    }

    // =========================================================================
    // EFFECT PREVIEW (censor / blur real preview from screenshot pixels)
    // =========================================================================

    async _ensurePixbufCache(excludedAction = null) {
        if (this._destroyed || !this._enableEffectPreview) return;
        if (this._cachedPixbuf) return;

        if (this._captureStageForPreview && this._shouldCaptureStagePreview()) {
            await this._captureStagePixbuf(excludedAction);
            if (this._destroyed)
                return;
            if (this._cachedPixbuf)
                return;
        }

        if (this._liveVideo && this._captureStageForPreview)
            return;

        const content = this._ui._stageScreenshot?.get_content();
        if (!content) return;
        const texture = content.get_texture();
        if (!texture) return;

        const bufScale = this._ui._scale || 1;
        const stream = Gio.MemoryOutputStream.new_resizable();
        const pixbuf = await Shell.Screenshot.composite_to_stream(
            texture, 0, 0, -1, -1, bufScale,
            null, 0, 0, 1,
            stream,
        );
        stream.close(null);
        if (this._destroyed)
            return;

        if (pixbuf) {
            this._cachedPixbuf = pixbuf;
            this._cachedBufScale = bufScale;
        }
    }

    async _captureStagePixbuf(excludedAction = null) {
        this._previewExcludedAction = excludedAction;
        this._actor?.queue_repaint();

        const hiddenActors = [
            excludedAction ? null : this._actor,
            ...this._getPreviewHiddenActors(),
        ].filter(actor => actor?.visible);

        for (const actor of hiddenActors)
            actor.hide();

        try {
            if (!await this._waitForIdle())
                return;

            const shooter = new Shell.Screenshot();
            const [content] = await shooter.screenshot_stage_to_content();
            if (this._destroyed)
                return;
            const texture = content?.get_texture?.();
            if (!texture)
                return;

            const bufScale = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
            const stream = Gio.MemoryOutputStream.new_resizable();
            const pixbuf = await Shell.Screenshot.composite_to_stream(
                texture, 0, 0, -1, -1, bufScale,
                null, 0, 0, 1,
                stream,
            );
            stream.close(null);
            if (this._destroyed)
                return;

            if (pixbuf) {
                this._cachedPixbuf = pixbuf;
                this._cachedBufScale = bufScale;
            }
        } catch (e) {
            console.error(`[Big Shot] Stage preview capture failed: ${e.message}`);
        } finally {
            this._previewExcludedAction = null;
            for (const actor of hiddenActors) {
                if (actor.get_stage?.() === global.stage)
                    actor.show();
            }
            this._actor?.queue_repaint();
        }
    }

    async _generateEffectPreview(action) {
        await this._ensurePixbufCache(action);
        if (this._destroyed || !this._cachedPixbuf) return;

        action.generatePreview(this._cachedPixbuf, this._cachedBufScale);
        this._actor.queue_repaint();
    }

    /**
     * Pick where the magnified inset lands: alongside the source region,
     * in whichever direction fits the canvas (right → left → below → above),
     * falling back to a clamped position when nothing fits cleanly.
     */
    _computeCalloutDest(srcStart, srcEnd, zoom) {
        const sx0 = Math.min(srcStart[0], srcEnd[0]);
        const sy0 = Math.min(srcStart[1], srcEnd[1]);
        const sx1 = Math.max(srcStart[0], srcEnd[0]);
        const sy1 = Math.max(srcStart[1], srcEnd[1]);
        const dw = (sx1 - sx0) * zoom;
        const dh = (sy1 - sy0) * zoom;

        const W = this._actor?.width || (sx1 + dw);
        const H = this._actor?.height || (sy1 + dh);
        const margin = 24;

        const candidates = [
            [sx1 + margin, sy0],            // right
            [sx0 - margin - dw, sy0],       // left
            [sx0, sy1 + margin],            // below
            [sx0, sy0 - margin - dh],       // above
        ];
        for (const [cx, cy] of candidates) {
            if (cx >= 0 && cy >= 0 && cx + dw <= W && cy + dh <= H)
                return [cx, cy];
        }

        // Nothing fits — clamp the inset inside the canvas.
        const cx = Math.min(Math.max(0, sx1 + margin), Math.max(0, W - dw));
        const cy = Math.min(Math.max(0, sy0), Math.max(0, H - dh));
        return [cx, cy];
    }

    // =========================================================================
    // CLEANUP
    // =========================================================================

    clear() {
        this._actions = [];
        this._undoStack = [];
        // Number counters are dynamic — no reset needed
        this.clearPreviewCache();
        this._actor.queue_repaint();
    }

    clearPreviewCache() {
        this._cachedPixbuf = null;
        this._cachedBufScale = null;
    }

    clearSelection() {
        this._selectedAction = null;
        this._actor?.queue_repaint();
    }

    destroy() {
        this._destroyed = true;
        this._cancelSources();
        this._closeTextPopover();
        this._cachedPixbuf = null;
        this._cachedBufScale = null;

        // Ensure overlay is no longer reactive
        if (this._actor)
            this._actor.reactive = false;

        if (this._repaintId) {
            this._actor.disconnect(this._repaintId);
        }
        if (this._keyId && this._keyActor) {
            this._keyActor.disconnect(this._keyId);
            this._keyId = 0;
        }
        if (this._stageEventId && this._eventActor) {
            this._eventActor.disconnect(this._stageEventId);
            this._stageEventId = 0;
        }

        if (this._actor && this._addedAsChrome) {
            try { Main.layoutManager.removeChrome(this._actor); } catch (_e) { /* */ }
            this._addedAsChrome = false;
        }
        this._actor?.destroy();
        this._actor = null;
    }
}
