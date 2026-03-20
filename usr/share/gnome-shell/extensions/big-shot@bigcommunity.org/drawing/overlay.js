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
import Shell from 'gi://Shell';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    DrawingMode,
    DrawingOptions,
    createAction,
    CensorAction,
    BlurAction,
    TextAction,
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
    'number': DrawingMode.NUMBER,
    'number-arrow': DrawingMode.NUMBER_ARROW,
    'number-pointer': DrawingMode.NUMBER_POINTER,
    'eraser': DrawingMode.ERASER,
    'select': DrawingMode.SELECT,
};

export class DrawingOverlay {
    constructor(screenshotUI, toolbar) {
        this._ui = screenshotUI;
        this._toolbar = toolbar;
        this._actions = [];
        this._undoStack = [];
        this._currentStroke = null;
        this._startPoint = null;
        this._isDrawing = false;
        this._nextNumber = 1;
        this._lastNumberTool = null;

        // Selection / move state
        this._selectedAction = null;
        this._isDragging = false;
        this._dragStart = null;

        this._buildOverlay();
    }

    // Reset number count when switching tool or starting new area
    resetNumberingIfNeeded() {
        const tool = this._toolbar?.activeTool;
        if (tool === 'number' || tool === 'number-arrow' || tool === 'number-pointer') {
            if (this._lastNumberTool !== tool) {
                this._nextNumber = 1;
                this._lastNumberTool = tool;
            }
        } else {
            this._lastNumberTool = null;
        }
    }

    _buildOverlay() {
        // Create a St.DrawingArea for Cairo rendering.
        // Positioned between _areaSelector and _primaryMonitorBin in z-order:
        //   - ABOVE _areaSelector: when reactive, captures drawing events
        //   - BELOW _primaryMonitorBin: panel/close button still receive clicks
        // Reactivity is toggled by setReactive() when a drawing tool is active.
        this._actor = new St.DrawingArea({
            reactive: false,
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

        // Key events for shortcuts (connected to the UI itself)
        this._keyId = this._ui.connect('key-press-event', (actor, event) => {
            if (!this._actor?.visible) return Clutter.EVENT_PROPAGATE;
            return this._onKeyPress(event);
        });

        // Initially hidden
        this._actor.visible = false;

        // Insert BELOW _primaryMonitorBin (which contains panel/close button)
        // and ABOVE _areaSelector (the selection handles).
        if (this._ui) {
            const primaryBin = this._ui._primaryMonitorBin;
            if (primaryBin?.get_parent() === this._ui) {
                this._ui.insert_child_below(this._actor, primaryBin);
            } else {
                this._ui.add_child(this._actor);
            }
        }
    }

    show(width, height) {
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
        if (this._actor) {
            this._actor.reactive = active;
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
        return [x, y];
    }

    // =========================================================================
    // INPUT HANDLERS
    // =========================================================================

    _onButtonPress(event) {
        // Reset numbering if needed when user switches tool
        this.resetNumberingIfNeeded();
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
            // Reset numbering when starting a new area (deseleciona tudo)
            this._nextNumber = 1;
            this._lastNumberTool = null;
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
                        stroke: this._currentStroke, shift
                    }, options);
                }
                break;
            case DrawingMode.ARROW:
                action = createAction(DrawingMode.ARROW, {
                    start: this._startPoint, end: [ix, iy], shift
                }, options);
                break;
            case DrawingMode.LINE:
                action = createAction(DrawingMode.LINE, {
                    start: this._startPoint, end: [ix, iy], shift
                }, options);
                break;
            case DrawingMode.RECT:
                action = createAction(DrawingMode.RECT, {
                    start: this._startPoint, end: [ix, iy], shift
                }, options);
                break;
            case DrawingMode.CIRCLE:
                action = createAction(DrawingMode.CIRCLE, {
                    start: this._startPoint, end: [ix, iy], shift
                }, options);
                break;
            case DrawingMode.CENSOR:
                action = createAction(DrawingMode.CENSOR, {
                    start: this._startPoint, end: [ix, iy]
                }, options);
                break;
            case DrawingMode.BLUR:
                action = createAction(DrawingMode.BLUR, {
                    start: this._startPoint, end: [ix, iy]
                }, options);
                break;
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
                    number: this._nextNumber++,
                }, options);
                break;
            case DrawingMode.NUMBER_ARROW:
                action = createAction(DrawingMode.NUMBER_ARROW, {
                    start: this._startPoint,
                    end: [ix, iy],
                    number: this._nextNumber++,
                }, options);
                break;
            case DrawingMode.NUMBER_POINTER:
                action = createAction(DrawingMode.NUMBER_POINTER, {
                    start: this._startPoint,
                    end: [ix, iy],
                    number: this._nextNumber++,
                }, options);
                break;
            case DrawingMode.ERASER:
                // Eraser is handled in _onButtonPress (click-to-remove)
                break;
        }

        if (action) {
            this._actions.push(action);
            this._undoStack = []; // Clear redo stack on new action

            // Generate real preview for effect actions (censor/blur)
            if (action instanceof CensorAction || action instanceof BlurAction) {
                this._generateEffectPreview(action).catch(e =>
                    console.error(`[Big Shot] Preview generation failed: ${e.message}`)
                );
            }
        }

        this._isDrawing = false;
        this._currentStroke = null;
        this._startPoint = null;
        this._currentEndPoint = null;
        this._actor.queue_repaint();

        return Clutter.EVENT_STOP;
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

    _showTextPopover(position, options, existingAction = null) {
        this._closeTextPopover();

        const [wx, wy] = this._toWidgetCoords(position[0], position[1]);

        this._textPopover = new St.BoxLayout({
            style: 'background: rgba(30,30,30,0.95); border-radius: 8px; padding: 8px; ' +
                   'border: 1px solid rgba(255,255,255,0.15);',
            vertical: false,
            reactive: true,
        });

        this._textEntry = new St.Entry({
            hint_text: _('Text…'),
            style: 'width: 200px; min-height: 28px; font-size: 14px;',
            can_focus: true,
            accessible_name: _('Annotation text'),
        });

        // Pre-fill with existing text when editing
        if (existingAction) {
            this._textEntry.set_text(existingAction.text);
        }

        const confirmBtn = new St.Button({
            style_class: 'screenshot-ui-show-pointer-button',
            child: new St.Icon({ icon_name: 'object-select-symbolic', icon_size: 16 }),
            can_focus: true,
            accessible_name: _('Confirm'),
        });

        const confirmAction = () => {
            const text = this._textEntry.get_text().trim();
            if (existingAction) {
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
        this._textEntry.clutter_text.connect('activate', confirmAction);

        // Escape closes without adding
        this._textEntry.clutter_text.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this._closeTextPopover();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._textPopover.add_child(this._textEntry);
        this._textPopover.add_child(confirmBtn);

        this._ui.add_child(this._textPopover);
        this._textPopover.set_position(
            Math.max(0, wx - 100),
            Math.max(0, wy - 44)
        );

        // Focus the entry after a frame
        this._focusIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._focusIdleId = 0;
            if (this._textEntry) {
                this._textEntry.grab_key_focus();
                // Select all text when editing existing action
                if (existingAction) {
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

    _closeTextPopover() {
        if (this._focusIdleId) {
            GLib.source_remove(this._focusIdleId);
            this._focusIdleId = 0;
        }
        this._textPopover?.destroy();
        this._textPopover = null;
        this._textEntry = null;

        // Return focus to the screenshot UI so Enter key works for capture
        this._ui?.grab_key_focus();
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

    _onDraw(cr, width, height) {
        // Clear (Cairo.Operator.CLEAR = 0)
        cr.save();
        cr.setOperator(0);
        cr.paint();
        cr.restore();

        const scale = 1.0; // Will be dynamic with zoom
        const toWidget = (x, y) => this._toWidgetCoords(x, y);

        // Draw all committed actions
        for (const action of this._actions) {
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
                case DrawingMode.NUMBER_ARROW:
                    tempAction = createAction(DrawingMode.NUMBER_ARROW, {
                        start: this._startPoint, end, number: this._nextNumber,
                    }, options);
                    break;
                case DrawingMode.NUMBER_POINTER:
                    tempAction = createAction(DrawingMode.NUMBER_POINTER, {
                        start: this._startPoint, end, number: this._nextNumber,
                    }, options);
                    break;
            }

            if (tempAction) {
                cr.save();
                cr.newPath();
                tempAction.draw(cr, toWidget, scale);
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

    async _ensurePixbufCache() {
        if (this._cachedPixbuf) return;

        const content = this._ui._stageScreenshot?.get_content();
        if (!content) return;
        const texture = content.get_texture();
        if (!texture) return;

        const bufScale = this._ui._scale || 1;
        const stream = Gio.MemoryOutputStream.new_resizable();
        const pixbuf = await Shell.Screenshot.composite_to_stream(
            texture, 0, 0, -1, -1, bufScale,
            null, 0, 0, 1,
            stream
        );
        stream.close(null);

        if (pixbuf) {
            this._cachedPixbuf = pixbuf;
            this._cachedBufScale = bufScale;
        }
    }

    async _generateEffectPreview(action) {
        await this._ensurePixbufCache();
        if (!this._cachedPixbuf) return;

        action.generatePreview(this._cachedPixbuf, this._cachedBufScale);
        this._actor.queue_repaint();
    }

    // =========================================================================
    // CLEANUP
    // =========================================================================

    clear() {
        this._actions = [];
        this._undoStack = [];
        this._nextNumber = 1;
        this._cachedPixbuf = null;
        this._cachedBufScale = null;
        this._actor.queue_repaint();
    }

    destroy() {
        this._closeTextPopover();
        this._cachedPixbuf = null;
        this._cachedBufScale = null;

        // Ensure overlay is no longer reactive
        if (this._actor)
            this._actor.reactive = false;

        if (this._repaintId) {
            this._actor.disconnect(this._repaintId);
        }
        if (this._keyId) {
            this._ui.disconnect(this._keyId);
            this._keyId = 0;
        }

        this._actor?.destroy();
        this._actor = null;
    }
}
