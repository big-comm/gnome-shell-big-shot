/**
 * Big Shot — Integrated edit toolbar
 *
 * Adds a pencil ✏️ toggle button to the native bottom row.
 * When toggled, drawing tools and style controls appear as
 * additional rows INSIDE the native screenshot panel — keeping
 * everything in a single unified box.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import PangoCairo from 'gi://PangoCairo';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { PartUI } from './partbase.js';
import { PALETTE } from '../drawing/colors.js';

// Cached font list (loaded once, shared across instances)
let _cachedFontNames = null;

function _getFontNames() {
    if (!_cachedFontNames) {
        const fontMap = PangoCairo.FontMap.get_default();
        const families = fontMap.list_families();
        _cachedFontNames = families.map(f => f.get_name()).sort((a, b) => a.localeCompare(b));
    }
    return _cachedFontNames;
}

const SCREENSHOT_TOOLS = [
    { id: 'select', icon: 'big-shot-select-symbolic', label: () => _('Select / Move') },
    { id: 'pen', icon: 'big-shot-pen-symbolic', label: () => _('Pen') },
    { id: 'arrow', icon: 'big-shot-arrow-symbolic', label: () => _('Arrow') },
    { id: 'line', icon: 'big-shot-line-symbolic', label: () => _('Line') },
    { id: 'rect', icon: 'big-shot-rect-symbolic', label: () => _('Rectangle') },
    { id: 'circle', icon: 'big-shot-circle-symbolic', label: () => _('Oval') },
    { id: 'text', icon: 'big-shot-text-symbolic', label: () => _('Text') },
    { id: 'highlight', icon: 'big-shot-highlight-symbolic', label: () => _('Highlighter') },
    { id: 'censor', icon: 'big-shot-censor-symbolic', label: () => _('Censor') },
    { id: 'blur', icon: 'big-shot-blur-symbolic', label: () => _('Blur') },
    { id: 'number', icon: 'big-shot-number-symbolic', label: () => _('Number') },
];



export class PartToolbar extends PartUI {
    constructor(screenshotUI, extension) {
        super(screenshotUI, extension);

        this._activeTool = null;
        this._toolButtons = new Map();
        this._editMode = false;
        this._currentColorHex = '#ed333b';
        this._fillColorHex = null;
        this._currentFont = 'Sans';

        // Video settings state
        this._videoQuality = 'high';   // 'high', 'medium', 'low'
        this._selectedPipelineId = null; // null = auto cascade

        this._buildToolbar();
    }

    _getIcon(iconName) {
        const iconsDir = this._ext.dir.get_child('data').get_child('icons');
        return new Gio.FileIcon({ file: iconsDir.get_child(`${iconName}.svg`) });
    }

    _buildToolbar() {
        const panel = this._ui._panel;
        if (!panel) return;

        // === Edit tools container (inserted INTO native panel when active) ===
        this._editContainer = new St.BoxLayout({
            vertical: true,
            style_class: 'big-shot-edit-container',
            reactive: true,
            x_align: Clutter.ActorAlign.CENTER,
        });

        // Row 1: Drawing tool icons
        const toolRow = new St.BoxLayout({
            style_class: 'big-shot-edit-row',
            x_align: Clutter.ActorAlign.CENTER,
        });
        for (const tool of SCREENSHOT_TOOLS) {
            const btn = new St.Button({
                style_class: 'big-shot-edit-tool-btn',
                toggle_mode: true,
                can_focus: true,
                child: new St.Icon({ gicon: this._getIcon(tool.icon), icon_size: 20 }),
                accessible_name: tool.label(),
            });
            btn._toolId = tool.id;
            btn.connect('clicked', () => this._onToolClicked(tool.id, btn));
            btn.connect('enter-event', () => this._showTooltip(btn, tool.label()));
            btn.connect('leave-event', () => this._hideTooltip());
            toolRow.add_child(btn);
            this._toolButtons.set(tool.id, btn);
        }
        this._editContainer.add_child(toolRow);

        // Row 2: Color + Fill + Size | Undo/Redo
        const styleRow = new St.BoxLayout({
            style_class: 'big-shot-edit-row',
            x_align: Clutter.ActorAlign.CENTER,
        });

        // Color swatch
        this._colorSwatch = new St.Widget({
            style: `background: ${this._currentColorHex}; border-radius: 50%; min-width: 20px; min-height: 20px; border: 2px solid rgba(255,255,255,0.3);`,
        });
        this._colorButton = new St.Button({
            style_class: 'big-shot-edit-tool-btn',
            child: this._colorSwatch,
            can_focus: true,
            accessible_name: _('Color'),
        });
        this._colorButton.connect('clicked', () => this._showColorPopup('stroke'));
        this._colorButton.connect('enter-event', () => this._showTooltip(this._colorButton, _('Color')));
        this._colorButton.connect('leave-event', () => this._hideTooltip());
        styleRow.add_child(this._colorButton);

        // Fill swatch
        this._fillSwatch = new St.Widget({
            style: 'background: transparent; border: 2px dashed rgba(255,255,255,0.5); border-radius: 50%; min-width: 20px; min-height: 20px;',
        });
        this._fillButton = new St.Button({
            style_class: 'big-shot-edit-tool-btn',
            child: this._fillSwatch,
            can_focus: true,
            accessible_name: _('Fill'),
        });
        this._fillButton.connect('clicked', () => this._showColorPopup('fill'));
        this._fillButton.connect('enter-event', () => this._showTooltip(this._fillButton, _('Fill')));
        this._fillButton.connect('leave-event', () => this._hideTooltip());
        styleRow.add_child(this._fillButton);

        // Size
        this._sizeLabel = new St.Label({
            text: '3',
            style: 'color: #ffffff; font-size: 13px;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._sizeButton = new St.Button({
            style_class: 'big-shot-edit-tool-btn',
            child: this._sizeLabel,
            can_focus: true,
            accessible_name: _('Brush Size'),
        });
        this._sizeButton.connect('clicked', () => this._showSizePopup());
        this._sizeButton.connect('enter-event', () => this._showTooltip(this._sizeButton, _('Brush Size')));
        this._sizeButton.connect('leave-event', () => this._hideTooltip());
        styleRow.add_child(this._sizeButton);

        // Font selector (visible only for Text tool)
        this._fontLabel = new St.Label({
            text: this._currentFont,
            style: 'color: #ffffff; font-size: 11px;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._fontButton = new St.Button({
            style_class: 'big-shot-edit-tool-btn',
            child: this._fontLabel,
            can_focus: true,
            accessible_name: _('Font'),
            visible: false,
        });
        this._fontButton.connect('clicked', () => this._showFontPopup());
        this._fontButton.connect('enter-event', () => this._showTooltip(this._fontButton, _('Font')));
        this._fontButton.connect('leave-event', () => this._hideTooltip());
        styleRow.add_child(this._fontButton);

        // Intensity level (visible only for Censor / Blur)
        this._intensityLevel = 3;
        const intensityBox = new St.BoxLayout({ style: 'spacing: 2px;' });
        this._intensityIcon = new St.Icon({
            icon_name: 'view-grid-symbolic',
            icon_size: 14,
            style: 'color: #ffffff;',
        });
        this._intensityLabel = new St.Label({
            text: '3',
            style: 'color: #ffffff; font-size: 13px;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        intensityBox.add_child(this._intensityIcon);
        intensityBox.add_child(this._intensityLabel);
        this._intensityButton = new St.Button({
            style_class: 'big-shot-edit-tool-btn',
            child: intensityBox,
            can_focus: true,
            accessible_name: _('Intensity'),
            visible: false,
        });
        this._intensityButton.connect('clicked', () => this._showIntensityPopup());
        this._intensityButton.connect('enter-event', () => this._showTooltip(this._intensityButton, _('Intensity')));
        this._intensityButton.connect('leave-event', () => this._hideTooltip());
        styleRow.add_child(this._intensityButton);

        // Separator
        styleRow.add_child(new St.Widget({ style_class: 'big-shot-edit-sep' }));

        // Undo
        this._undoButton = new St.Button({
            style_class: 'big-shot-edit-tool-btn',
            child: new St.Icon({ icon_name: 'edit-undo-symbolic', icon_size: 20 }),
            can_focus: true,
            accessible_name: _('Undo'),
        });
        this._undoButton.connect('clicked', () => this._onUndo());
        this._undoButton.connect('enter-event', () => this._showTooltip(this._undoButton, _('Undo')));
        this._undoButton.connect('leave-event', () => this._hideTooltip());
        styleRow.add_child(this._undoButton);

        // Redo
        this._redoButton = new St.Button({
            style_class: 'big-shot-edit-tool-btn',
            child: new St.Icon({ icon_name: 'edit-redo-symbolic', icon_size: 20 }),
            can_focus: true,
            accessible_name: _('Redo'),
        });
        this._redoButton.connect('clicked', () => this._onRedo());
        this._redoButton.connect('enter-event', () => this._showTooltip(this._redoButton, _('Redo')));
        this._redoButton.connect('leave-event', () => this._hideTooltip());
        styleRow.add_child(this._redoButton);

        this._editContainer.add_child(styleRow);

        // NOTE: _editContainer is NOT added to a parent yet.
        // It gets inserted into _panel when edit mode is toggled ON.

        // === Video Settings Container (also inserted INTO _panel) ===
        this._videoContainer = new St.BoxLayout({
            vertical: true,
            style_class: 'big-shot-edit-container',
            reactive: true,
            x_align: Clutter.ActorAlign.CENTER,
        });

        // Row 1: Quality label + buttons
        const qualityBox = new St.BoxLayout({ vertical: false, style: 'spacing: 8px;' });
        qualityBox.add_child(new St.Label({
            text: _('Quality'),
            style: 'color: rgba(255,255,255,0.6); font-size: 12px; min-width: 50px;',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._qualityButtons = new Map();
        const qualityOptions = [
            { id: 'high', label: _('High') },
            { id: 'medium', label: _('Medium') },
            { id: 'low', label: _('Low') },
        ];
        for (const q of qualityOptions) {
            const btn = new St.Button({
                style_class: 'screenshot-ui-show-pointer-button',
                toggle_mode: true,
                can_focus: true,
                label: q.label,
            });
            btn.checked = (q.id === this._videoQuality);
            const qid = q.id;
            btn.connect('clicked', () => this._onQualityClicked(qid));
            btn.connect('enter-event', () => this._showTooltip(btn, _('Recording quality (bitrate)')));
            btn.connect('leave-event', () => this._hideTooltip());
            qualityBox.add_child(btn);
            this._qualityButtons.set(q.id, btn);
        }
        this._videoContainer.add_child(qualityBox);

        // Row 2: Codec label + buttons (populated dynamically)
        const codecBox = new St.BoxLayout({ vertical: false, style: 'spacing: 8px;' });
        codecBox.add_child(new St.Label({
            text: _('Codec'),
            style: 'color: rgba(255,255,255,0.6); font-size: 12px; min-width: 50px;',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._codecButtonsRow = new St.BoxLayout({ style: 'spacing: 4px;' });
        codecBox.add_child(this._codecButtonsRow);
        this._videoContainer.add_child(codecBox);
        this._codecButtons = new Map();

        // NOTE: _videoContainer is NOT added to a parent yet.

        // === Edit toggle button — in _showPointerButtonContainer ===
        this._editButton = new St.Button({
            style_class: 'screenshot-ui-show-pointer-button',
            toggle_mode: true,
            can_focus: true,
            child: new St.Icon({ icon_name: 'document-edit-symbolic', icon_size: 16 }),
            accessible_name: _('Edit'),
        });
        this._editButton.connect('notify::checked', () => {
            this._editMode = this._editButton.checked;
            if (this._isCastMode) {
                this._detachEditFromPanel();
                if (this._editMode) {
                    this._attachVideoToPanel();
                } else {
                    this._detachVideoFromPanel();
                }
            } else {
                this._detachVideoFromPanel();
                if (this._editMode) {
                    this._attachEditToPanel();
                } else {
                    this._detachEditFromPanel();
                    this.selectTool(null);
                }
            }
        });

        // Insert edit button into the native bottom-row controls
        const showPointerContainer = this._ui._showPointerButtonContainer;
        if (showPointerContainer) {
            showPointerContainer.insert_child_at_index(this._editButton, 0);
        } else {
            const bottomRow = this._ui._bottomRowContainer;
            if (bottomRow) bottomRow.add_child(this._editButton);
        }

        this._connectSignal(this._ui, 'notify::visible', () => this._onUIVisibilityChanged());
    }

    /** Insert edit tools at position 0 of the native panel (above mode buttons). */
    _attachEditToPanel() {
        const panel = this._ui._panel;
        if (!panel || this._editContainer.get_parent()) return;
        panel.insert_child_at_index(this._editContainer, 0);
        // Slide-in animation
        this._editContainer.opacity = 0;
        this._editContainer.ease({
            opacity: 255,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    /** Remove edit tools from the native panel. */
    _detachEditFromPanel() {
        const parent = this._editContainer.get_parent();
        if (parent) parent.remove_child(this._editContainer);
    }

    /** Insert video settings at position 0 of the native panel. */
    _attachVideoToPanel() {
        const panel = this._ui._panel;
        if (!panel || this._videoContainer.get_parent()) return;
        this._populateVideoCodecs();
        panel.insert_child_at_index(this._videoContainer, 0);
    }

    /** Remove video settings from the native panel. */
    _detachVideoFromPanel() {
        const parent = this._videoContainer.get_parent();
        if (parent) parent.remove_child(this._videoContainer);
    }

    _onToolClicked(toolId, btn) {
        for (const [id, otherBtn] of this._toolButtons) {
            if (id !== toolId)
                otherBtn.checked = false;
        }
        this._activeTool = btn.checked ? toolId : null;
        this._fontButton.visible = (this._activeTool === 'text');
        this._intensityButton.visible = (this._activeTool === 'censor' || this._activeTool === 'blur');
        this._onToolChanged(this._activeTool);
    }

    _onToolChanged(toolId) {
        this._toolChangedCallback?.(toolId);
    }

    onToolChanged(callback) {
        this._toolChangedCallback = callback;
    }

    selectTool(toolId) {
        if (toolId === null) {
            for (const [, btn] of this._toolButtons)
                btn.checked = false;
            this._activeTool = null;
            this._fontButton.visible = false;
            this._intensityButton.visible = false;
            this._onToolChanged(null);
            return;
        }
        const btn = this._toolButtons.get(toolId);
        if (!btn) return;
        for (const [id, otherBtn] of this._toolButtons)
            otherBtn.checked = (id === toolId);
        this._activeTool = toolId;
        this._fontButton.visible = (toolId === 'text');
        this._intensityButton.visible = (toolId === 'censor' || toolId === 'blur');
        this._onToolChanged(toolId);
    }

    get activeTool() { return this._activeTool; }

    _showSizePopup() {
        this._closeSizePopup();
        this._closeColorPopup();

        this._sizePopup = new St.BoxLayout({
            style_class: 'big-shot-edit-popup',
            vertical: true,
            reactive: true,
        });

        // Grid row of preset sizes (1-14)
        const row1 = new St.BoxLayout({ style_class: 'big-shot-edit-row' });
        const row2 = new St.BoxLayout({ style_class: 'big-shot-edit-row' });
        for (let i = 1; i <= 14; i++) {
            const btn = new St.Button({
                style_class: 'big-shot-edit-tool-btn',
                can_focus: true,
                child: new St.Label({
                    text: String(i),
                    style: 'color: #ffffff; font-size: 12px;',
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                }),
            });
            if (i === this.brushSize)
                btn.add_style_pseudo_class('checked');
            const size = i;
            btn.connect('clicked', () => {
                this._setBrushSize(size);
                this._closeSizePopup();
            });
            if (i <= 7)
                row1.add_child(btn);
            else
                row2.add_child(btn);
        }
        this._sizePopup.add_child(row1);
        this._sizePopup.add_child(row2);

        // Custom size entry row
        const customRow = new St.BoxLayout({ style_class: 'big-shot-edit-row' });
        const customEntry = new St.Entry({
            hint_text: _('Custom'),
            style: 'width: 60px; color: #ffffff; font-size: 12px;',
            can_focus: true,
        });
        customEntry.clutter_text.connect('activate', () => {
            const val = parseInt(customEntry.get_text());
            if (val > 0 && val <= 100) {
                this._setBrushSize(val);
                this._closeSizePopup();
            }
        });
        customRow.add_child(customEntry);
        this._sizePopup.add_child(customRow);

        // Position above the size button
        this._ui.add_child(this._sizePopup);
        const [bx, by] = this._sizeButton.get_transformed_position();
        this._sizePopup.set_position(bx, by - this._sizePopup.height - 8);
    }

    _closeSizePopup() {
        this._sizePopup?.destroy();
        this._sizePopup = null;
    }

    _showFontPopup() {
        this._closeFontPopup();

        this._fontPopup = new St.BoxLayout({
            style_class: 'big-shot-edit-popup',
            vertical: true,
            reactive: true,
            style: 'padding: 4px;',
        });

        const fontNames = _getFontNames();

        // Scrollable list
        const scrollView = new St.ScrollView({
            style: 'max-height: 300px; min-width: 200px;',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });

        const listBox = new St.BoxLayout({ vertical: true, style: 'spacing: 2px;' });

        for (const name of fontNames) {
            const escapedName = name.replace(/'/g, "\\'");
            const btn = new St.Button({
                style_class: 'big-shot-edit-tool-btn',
                can_focus: true,
                x_expand: true,
                child: new St.Label({
                    text: name,
                    style: `color: #ffffff; font-size: 15px; font-family: '${escapedName}'; text-align: left;`,
                    x_align: Clutter.ActorAlign.START,
                    x_expand: true,
                }),
            });
            if (name === this._currentFont)
                btn.add_style_pseudo_class('checked');
            btn.connect('clicked', () => {
                this._currentFont = name;
                this._fontLabel.text = name;
                this._closeFontPopup();
            });
            listBox.add_child(btn);
        }

        scrollView.set_child(listBox);
        this._fontPopup.add_child(scrollView);

        this._ui.add_child(this._fontPopup);

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (!this._fontPopup) return GLib.SOURCE_REMOVE;
            const [bx, by] = this._fontButton.get_transformed_position();
            const monitor = global.display.get_current_monitor();
            const geo = global.display.get_monitor_geometry(monitor);
            let cpx = bx;
            let cpy = by - this._fontPopup.height - 8;
            cpx = Math.max(geo.x, Math.min(cpx, geo.x + geo.width - this._fontPopup.width));
            cpy = Math.max(geo.y, cpy);
            this._fontPopup.set_position(cpx, cpy);
            return GLib.SOURCE_REMOVE;
        });

        this._fontPopupTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this._fontPopupTimeoutId = 0;
            if (this._destroyed) return GLib.SOURCE_REMOVE;
            this._fontPopupClickId = global.stage.connect('button-press-event', () => {
                this._closeFontPopup();
                return Clutter.EVENT_PROPAGATE;
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _closeFontPopup() {
        if (this._fontPopupTimeoutId) {
            GLib.source_remove(this._fontPopupTimeoutId);
            this._fontPopupTimeoutId = 0;
        }
        if (this._fontPopupClickId) {
            global.stage.disconnect(this._fontPopupClickId);
            this._fontPopupClickId = null;
        }
        this._fontPopup?.destroy();
        this._fontPopup = null;
    }

    _setBrushSize(size) {
        this._sizeLabel.text = String(size);
    }

    get brushSize() {
        return parseInt(this._sizeLabel.text) || 3;
    }

    get intensity() {
        return this._intensityLevel || 3;
    }

    _showIntensityPopup() {
        this._closeIntensityPopup();
        this._closeColorPopup();
        this._closeSizePopup();

        this._intensityPopup = new St.BoxLayout({
            style_class: 'big-shot-edit-popup',
            vertical: true,
            reactive: true,
        });

        // Title row
        const titleLabel = new St.Label({
            text: _('Intensity'),
            style: 'color: rgba(255,255,255,0.7); font-size: 11px; margin-bottom: 4px;',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._intensityPopup.add_child(titleLabel);

        // 5 level buttons
        const row = new St.BoxLayout({ style_class: 'big-shot-edit-row' });
        const labels = ['1', '2', '3', '4', '5'];
        for (let i = 1; i <= 5; i++) {
            const level = i;
            const btn = new St.Button({
                style_class: 'big-shot-edit-tool-btn',
                can_focus: true,
                child: new St.Label({
                    text: labels[i - 1],
                    style: 'color: #ffffff; font-size: 14px; min-width: 28px;',
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                }),
                accessible_name: `${_('Intensity')} ${level}`,
            });
            if (level === this._intensityLevel)
                btn.add_style_pseudo_class('checked');
            btn.connect('clicked', () => {
                this._intensityLevel = level;
                this._intensityLabel.text = String(level);
                this._closeIntensityPopup();
            });
            row.add_child(btn);
        }
        this._intensityPopup.add_child(row);

        this._ui.add_child(this._intensityPopup);

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (!this._intensityPopup) return GLib.SOURCE_REMOVE;
            const [bx, by] = this._intensityButton.get_transformed_position();
            const monitor = global.display.get_current_monitor();
            const geo = global.display.get_monitor_geometry(monitor);
            let cpx = bx;
            let cpy = by - this._intensityPopup.height - 8;
            cpx = Math.max(geo.x, Math.min(cpx, geo.x + geo.width - this._intensityPopup.width));
            cpy = Math.max(geo.y, cpy);
            this._intensityPopup.set_position(cpx, cpy);
            return GLib.SOURCE_REMOVE;
        });

        this._intensityPopupTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this._intensityPopupTimeoutId = 0;
            if (this._destroyed) return GLib.SOURCE_REMOVE;
            this._intensityPopupClickId = global.stage.connect('button-press-event', () => {
                this._closeIntensityPopup();
                return Clutter.EVENT_PROPAGATE;
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _closeIntensityPopup() {
        if (this._intensityPopupTimeoutId) {
            GLib.source_remove(this._intensityPopupTimeoutId);
            this._intensityPopupTimeoutId = 0;
        }
        if (this._intensityPopupClickId) {
            global.stage.disconnect(this._intensityPopupClickId);
            this._intensityPopupClickId = null;
        }
        this._intensityPopup?.destroy();
        this._intensityPopup = null;
    }

    _showColorPopup(target) {
        this._closeColorPopup();

        this._colorPopup = new St.BoxLayout({
            style_class: 'big-shot-edit-popup',
            vertical: true,
            reactive: true,
        });

        for (let row = 0; row < 2; row++) {
            const rowBox = new St.BoxLayout({ style: 'spacing: 6px;' });
            for (let col = 0; col < 6; col++) {
                const color = PALETTE[row * 6 + col];
                const swatch = new St.Button({
                    style: `background: ${color}; width: 28px; height: 28px; border-radius: 8px; margin: 2px; border: 2px solid transparent;`,
                    reactive: true,
                    can_focus: true,
                    accessible_name: color,
                });
                swatch.connect('clicked', () => {
                    this._applyColor(target, color);
                    this._closeColorPopup();
                });
                rowBox.add_child(swatch);
            }
            this._colorPopup.add_child(rowBox);
        }

        if (target === 'fill') {
            const noFillBtn = new St.Button({
                style_class: 'big-shot-edit-tool-btn',
                label: _('No Fill'),
                can_focus: true,
                style: 'margin-top: 4px; color: #ffffff;',
            });
            noFillBtn.connect('clicked', () => {
                this._applyColor('fill', null);
                this._closeColorPopup();
            });
            this._colorPopup.add_child(noFillBtn);
        }

        const anchor = target === 'fill' ? this._fillButton : this._colorButton;
        this._ui.add_child(this._colorPopup);

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (!this._colorPopup) return GLib.SOURCE_REMOVE;
            const [bx, by] = anchor.get_transformed_position();
            const monitor = global.display.get_current_monitor();
            const geo = global.display.get_monitor_geometry(monitor);
            let cpx = bx - 40;
            let cpy = by - this._colorPopup.height - 8;
            cpx = Math.max(geo.x, Math.min(cpx, geo.x + geo.width - this._colorPopup.width));
            cpy = Math.max(geo.y, cpy);
            this._colorPopup.set_position(cpx, cpy);
            return GLib.SOURCE_REMOVE;
        });

        this._popupTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this._popupTimeoutId = 0;
            if (this._destroyed) return GLib.SOURCE_REMOVE;
            this._colorPopupClickId = global.stage.connect('button-press-event', () => {
                this._closeColorPopup();
                return Clutter.EVENT_PROPAGATE;
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _applyColor(target, color) {
        if (target === 'stroke') {
            this._currentColorHex = color;
            this._colorSwatch.set_style(
                `background: ${color}; border-radius: 50%; min-width: 24px; min-height: 24px; border: 2px solid rgba(255,255,255,0.3);`
            );
        } else {
            this._fillColorHex = color;
            if (color) {
                this._fillSwatch.set_style(
                    `background: ${color}; border-radius: 50%; min-width: 24px; min-height: 24px; border: 2px solid rgba(255,255,255,0.3);`
                );
            } else {
                this._fillSwatch.set_style(
                    'background: transparent; border: 2px dashed rgba(255,255,255,0.5); border-radius: 50%; min-width: 24px; min-height: 24px;'
                );
            }
        }
    }

    _closeColorPopup() {
        if (this._popupTimeoutId) {
            GLib.source_remove(this._popupTimeoutId);
            this._popupTimeoutId = 0;
        }
        if (this._colorPopupClickId) {
            global.stage.disconnect(this._colorPopupClickId);
            this._colorPopupClickId = null;
        }
        this._colorPopup?.destroy();
        this._colorPopup = null;
    }

    get currentColor() { return this._currentColorHex || '#ed333b'; }
    get fillColor() { return this._fillColorHex; }
    get currentFont() { return this._currentFont || 'Sans'; }

    // Video settings getters
    get videoQuality() { return this._videoQuality; }
    get selectedPipelineId() { return this._selectedPipelineId; }

    _onQualityClicked(qualityId) {
        this._videoQuality = qualityId;
        for (const [id, btn] of this._qualityButtons) {
            btn.checked = (id === qualityId);
        }
    }

    _populateVideoCodecs() {
        // Trigger lazy pipeline detection
        this._ext._detectPipelines();
        const configs = this._ext._availableConfigs;
        if (!configs) return;

        // Only rebuild if configs changed
        const configIds = configs.map(c => c.id).join(',');
        if (this._lastCodecConfigIds === configIds) return;
        this._lastCodecConfigIds = configIds;

        // Clear existing buttons
        this._codecButtonsRow.destroy_all_children();
        this._codecButtons.clear();

        // Auto button
        const autoBtn = new St.Button({
            style_class: 'screenshot-ui-show-pointer-button',
            toggle_mode: true,
            can_focus: true,
            label: _('Auto'),
        });
        autoBtn.checked = (this._selectedPipelineId === null);
        autoBtn.connect('clicked', () => this._onCodecClicked(null));
        autoBtn.connect('enter-event', () => this._showTooltip(autoBtn, _('Use best available codec')));
        autoBtn.connect('leave-event', () => this._hideTooltip());
        this._codecButtonsRow.add_child(autoBtn);
        this._codecButtons.set(null, autoBtn);

        // One button per available pipeline
        for (const config of configs) {
            const btn = new St.Button({
                style_class: 'screenshot-ui-show-pointer-button',
                toggle_mode: true,
                can_focus: true,
                label: config.label,
            });
            btn.checked = (this._selectedPipelineId === config.id);
            const cid = config.id;
            btn.connect('clicked', () => this._onCodecClicked(cid));
            btn.connect('enter-event', () => this._showTooltip(btn, _('Video codec')));
            btn.connect('leave-event', () => this._hideTooltip());
            this._codecButtonsRow.add_child(btn);
            this._codecButtons.set(config.id, btn);
        }
    }

    _onCodecClicked(pipelineId) {
        this._selectedPipelineId = pipelineId;
        for (const [id, btn] of this._codecButtons) {
            btn.checked = (id === pipelineId);
        }
    }

    // Video settings panel is now embedded in _panel via _attachVideoToPanel().

    _onUndo() { }
    _onRedo() { }

    _showTooltip(button, text) {
        this._hideTooltip();
        this._tooltip = new St.Label({
            text,
            style_class: 'big-shot-tooltip',
            style: 'background: rgba(0,0,0,0.85); color: #ffffff; padding: 4px 8px; border-radius: 4px; font-size: 11px;',
        });
        this._ui.add_child(this._tooltip);

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (!this._tooltip) return GLib.SOURCE_REMOVE;
            const [bx, by] = button.get_transformed_position();
            const bw = button.width;
            const tw = this._tooltip.width;
            this._tooltip.set_position(
                bx + (bw - tw) / 2,
                by - this._tooltip.height - 4
            );
            return GLib.SOURCE_REMOVE;
        });
    }

    _hideTooltip() {
        if (this._tooltip) {
            this._tooltip.destroy();
            this._tooltip = null;
        }
    }

    _onUIVisibilityChanged() {
        if (this._ui.visible) {
            this._editButton.visible = true;
            if (this._isCastMode) {
                this._detachEditFromPanel();
                this.selectTool(null);
                if (this._editMode)
                    this._attachVideoToPanel();
            } else {
                this._detachVideoFromPanel();
            }
        } else {
            this._editButton.checked = false;
            this._editMode = false;
            this._detachEditFromPanel();
            this._detachVideoFromPanel();
            this.selectTool(null);
        }
    }

    _onModeChanged(isCast) {
        super._onModeChanged(isCast);
        this._editButton.visible = this._ui.visible;
        this._editButton.checked = false;
        this._editMode = false;
        this._detachEditFromPanel();
        this._detachVideoFromPanel();
        this.selectTool(null);
    }

    destroy() {
        this._detachEditFromPanel();
        this._detachVideoFromPanel();
        this._closeColorPopup();
        this._closeSizePopup();
        this._closeFontPopup();
        this._closeIntensityPopup();
        this._hideTooltip();

        if (this._editButton) {
            const p = this._editButton.get_parent();
            if (p) p.remove_child(this._editButton);
            this._editButton.destroy();
            this._editButton = null;
        }
        if (this._editContainer) {
            this._editContainer.destroy();
            this._editContainer = null;
        }
        if (this._videoContainer) {
            this._videoContainer.destroy();
            this._videoContainer = null;
        }

        this._toolButtons.clear();
        this._qualityButtons?.clear();
        this._codecButtons?.clear();
        super.destroy();
    }
}
