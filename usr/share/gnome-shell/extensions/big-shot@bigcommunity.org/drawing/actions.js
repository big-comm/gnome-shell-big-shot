/**
 * Big Shot — Drawing Actions
 *
 * All annotation tools that can be placed on a screenshot.
 * Each action knows how to draw itself via Cairo and report its bounds.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import cairo from 'gi://cairo';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';

// =============================================================================
// DRAWING MODES
// =============================================================================

export const DrawingMode = Object.freeze({
    SELECT:         'SELECT',
    PEN:            'PEN',
    ARROW:          'ARROW',
    LINE:           'LINE',
    RECT:           'RECT',
    CIRCLE:         'CIRCLE',
    TEXT:           'TEXT',
    HIGHLIGHTER:    'HIGHLIGHTER',
    CENSOR:         'CENSOR',
    BLUR:           'BLUR',
    NUMBER:         'NUMBER',
    NUMBER_ARROW:   'NUMBER_ARROW',
    NUMBER_POINTER: 'NUMBER_POINTER',
    ERASER:         'ERASER',
    INVERT:         'INVERT',
    ZOOM_CALLOUT:   'ZOOM_CALLOUT',
});

// =============================================================================
// DRAWING OPTIONS
// =============================================================================

export class DrawingOptions {
    constructor({
        mode = DrawingMode.PEN,
        primaryColor = [0.93, 0.2, 0.23, 1.0],
        fillColor = null,
        borderColor = null,
        size = 3,
        font = 'Sans',
        intensity = 3,
        liveVideo = false,
    } = {}) {
        this.mode = mode;
        this.primaryColor = primaryColor;
        this.fillColor = fillColor;
        this.borderColor = borderColor;
        this.size = size;
        this.font = font;
        this.intensity = intensity;
        this.liveVideo = liveVideo;
    }

    clone() {
        return new DrawingOptions({
            mode: this.mode,
            primaryColor: [...this.primaryColor],
            fillColor: this.fillColor ? [...this.fillColor] : null,
            borderColor: this.borderColor ? [...this.borderColor] : null,
            size: this.size,
            font: this.font,
            intensity: this.intensity,
            liveVideo: this.liveVideo,
        });
    }
}

// =============================================================================
// BASE ACTION
// =============================================================================

class DrawingAction {
    draw(_cr, _toWidget, _scale) {
        throw new Error('Not implemented');
    }

    getBounds() {
        throw new Error('Not implemented');
    }

    containsPoint(x, y) {
        const [minX, minY, maxX, maxY] = this.getBounds();
        return x >= minX && x <= maxX && y >= minY && y <= maxY;
    }

    translate(_dx, _dy) {
        throw new Error('Not implemented');
    }
}

// =============================================================================
// PEN (freehand stroke with Bézier smoothing)
// =============================================================================

export class StrokeAction extends DrawingAction {
    constructor(stroke, options) {
        super();
        this.stroke = stroke;
        this.options = options;
    }

    draw(cr, toWidget, scale) {
        if (this.stroke.length < 2) return;

        const coords = this.stroke.map(([x, y]) => toWidget(x, y));
        const lineWidth = this.options.size * scale;

        cr.setLineWidth(lineWidth);
        cr.setLineCap(1); // ROUND
        cr.setLineJoin(1); // ROUND
        cr.setSourceRGBA(...this.options.primaryColor);

        cr.moveTo(...coords[0]);
        for (let i = 1; i < coords.length - 1; i++) {
            const [x1, y1] = coords[i];
            const [x2, y2] = coords[i + 1];
            const midX = (x1 + x2) * 0.5;
            const midY = (y1 + y2) * 0.5;
            cr.curveTo(x1, y1, x1, y1, midX, midY);
        }
        cr.lineTo(...coords[coords.length - 1]);
        cr.stroke();
    }

    getBounds() {
        if (!this.stroke.length) return [0, 0, 0, 0];
        const xs = this.stroke.map(p => p[0]);
        const ys = this.stroke.map(p => p[1]);
        const pad = this.options.size / 2;
        return [Math.min(...xs) - pad, Math.min(...ys) - pad,
                Math.max(...xs) + pad, Math.max(...ys) + pad];
    }

    translate(dx, dy) {
        this.stroke = this.stroke.map(([x, y]) => [x + dx, y + dy]);
    }
}

// =============================================================================
// ARROW
// =============================================================================

export class ArrowAction extends DrawingAction {
    constructor(start, end, shift, options) {
        super();
        this.options = options;
        this.start = start;

        if (shift) {
            const dx = Math.abs(end[0] - start[0]);
            const dy = Math.abs(end[1] - start[1]);
            this.end = dx > dy ? [end[0], start[1]] : [start[0], end[1]];
        } else {
            this.end = end;
        }
    }

    draw(cr, toWidget, scale) {
        const [sx, sy] = toWidget(...this.start);
        const [ex, ey] = toWidget(...this.end);
        const dist = Math.hypot(ex - sx, ey - sy);
        if (dist < 2) return;

        const width = this.options.size * 1.75 * scale;
        const angle = Math.atan2(ey - sy, ex - sx);
        const headSize = this.options.size * 3 * 1.75 * scale *
            Math.min(1.0, Math.max(0.3, dist / (120 * scale)));
        const arrowAngle = Math.PI / 6;

        const lx = ex + headSize * Math.cos(angle + Math.PI - arrowAngle);
        const ly = ey + headSize * Math.sin(angle + Math.PI - arrowAngle);
        const rx = ex + headSize * Math.cos(angle + Math.PI + arrowAngle);
        const ry = ey + headSize * Math.sin(angle + Math.PI + arrowAngle);

        cr.setLineWidth(width);
        cr.setLineCap(1); // ROUND

        // Shadow
        const shadowOff = Math.max(1, Math.round(scale));
        cr.setSourceRGBA(0, 0, 0, 0.5);
        cr.moveTo(sx + shadowOff, sy + shadowOff);
        cr.lineTo(ex + shadowOff, ey + shadowOff);
        cr.stroke();
        cr.moveTo(ex + shadowOff, ey + shadowOff);
        cr.lineTo(lx + shadowOff, ly + shadowOff);
        cr.stroke();
        cr.moveTo(ex + shadowOff, ey + shadowOff);
        cr.lineTo(rx + shadowOff, ry + shadowOff);
        cr.stroke();

        // Arrow
        cr.setSourceRGBA(...this.options.primaryColor);

        // Shaft
        cr.moveTo(sx, sy);
        cr.lineTo(ex, ey);
        cr.stroke();

        // Arrowhead
        cr.moveTo(ex, ey);
        cr.lineTo(lx, ly);
        cr.stroke();
        cr.moveTo(ex, ey);
        cr.lineTo(rx, ry);
        cr.stroke();
    }

    getBounds() {
        const pad = this.options.size * 3 * 1.75;
        return [
            Math.min(this.start[0], this.end[0]) - pad,
            Math.min(this.start[1], this.end[1]) - pad,
            Math.max(this.start[0], this.end[0]) + pad,
            Math.max(this.start[1], this.end[1]) + pad,
        ];
    }

    translate(dx, dy) {
        this.start = [this.start[0] + dx, this.start[1] + dy];
        this.end = [this.end[0] + dx, this.end[1] + dy];
    }
}

// =============================================================================
// LINE
// =============================================================================

export class LineAction extends ArrowAction {
    draw(cr, toWidget, scale) {
        const [sx, sy] = toWidget(...this.start);
        const [ex, ey] = toWidget(...this.end);

        const width = this.options.size * 1.75 * scale;
        cr.setLineWidth(width);
        cr.setLineCap(1);
        cr.setSourceRGBA(...this.options.primaryColor);
        cr.moveTo(sx, sy);
        cr.lineTo(ex, ey);
        cr.stroke();
    }
}

// =============================================================================
// RECTANGLE
// =============================================================================

export class RectAction extends DrawingAction {
    constructor(start, end, shift, options) {
        super();
        this.options = options;
        this.start = start;
        this.end = end;
        this.shift = shift;
    }

    draw(cr, toWidget, scale) {
        let [x1, y1] = toWidget(...this.start);
        let [x2, y2] = toWidget(...this.end);

        if (this.shift) {
            const size = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
            x2 = x2 < x1 ? x1 - size : x1 + size;
            y2 = y2 < y1 ? y1 - size : y1 + size;
        }

        const strokeOff = (this.options.size * scale) / 2;
        const x = Math.min(x1, x2) + strokeOff;
        const y = Math.min(y1, y2) + strokeOff;
        const w = Math.abs(x2 - x1) - this.options.size * scale;
        const h = Math.abs(y2 - y1) - this.options.size * scale;

        if (w <= 0 || h <= 0) return;

        if (this.options.fillColor) {
            cr.setSourceRGBA(...this.options.fillColor);
            cr.rectangle(x, y, w, h);
            cr.fill();
        }

        cr.setSourceRGBA(...this.options.primaryColor);
        cr.setLineWidth(this.options.size * scale);
        cr.rectangle(x, y, w, h);
        cr.stroke();
    }

    getBounds() {
        return [
            Math.min(this.start[0], this.end[0]),
            Math.min(this.start[1], this.end[1]),
            Math.max(this.start[0], this.end[0]),
            Math.max(this.start[1], this.end[1]),
        ];
    }

    translate(dx, dy) {
        this.start = [this.start[0] + dx, this.start[1] + dy];
        this.end = [this.end[0] + dx, this.end[1] + dy];
    }
}

// =============================================================================
// CIRCLE / OVAL
// =============================================================================

export class CircleAction extends RectAction {
    draw(cr, toWidget, scale) {
        let [x1, y1] = toWidget(...this.start);
        let [x2, y2] = toWidget(...this.end);

        if (this.shift) {
            const size = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
            x2 = x2 < x1 ? x1 - size : x1 + size;
            y2 = y2 < y1 ? y1 - size : y1 + size;
        }

        const cx = (x1 + x2) / 2;
        const cy = (y1 + y2) / 2;
        const rx = (Math.abs(x2 - x1) - this.options.size * scale) / 2;
        const ry = (Math.abs(y2 - y1) - this.options.size * scale) / 2;

        if (rx <= 0 || ry <= 0) return;

        cr.save();
        cr.translate(cx, cy);
        cr.scale(rx, ry);
        cr.arc(0, 0, 1, 0, 2 * Math.PI);
        cr.restore();

        if (this.options.fillColor) {
            cr.setSourceRGBA(...this.options.fillColor);
            cr.fillPreserve();
        }

        cr.setSourceRGBA(...this.options.primaryColor);
        cr.setLineWidth(this.options.size * scale);
        cr.stroke();
    }
}

// =============================================================================
// TEXT
// =============================================================================

export class TextAction extends DrawingAction {
    constructor(position, text, options, fontSize = 16) {
        super();
        this.position = position;
        this.text = text;
        this.options = options;
        this.fontSize = fontSize;
    }

    draw(cr, toWidget, scale) {
        if (!this.text.trim()) return;

        const [wx, wy] = toWidget(...this.position);
        const size = this.fontSize * scale;

        // Use PangoCairo for proper font rendering
        const layout = PangoCairo.create_layout(cr);
        const fontDesc = Pango.FontDescription.from_string(`${this.options.font} ${size}`);
        layout.set_font_description(fontDesc);
        layout.set_text(this.text, -1);

        const [inkRect, logicalRect] = layout.get_pixel_extents();
        const textWidth = logicalRect.width;
        const textHeight = logicalRect.height;

        const tx = wx - textWidth / 2;
        const ty = wy - textHeight;

        // Background fill
        if (this.options.fillColor) {
            const pad = 4 * scale;
            cr.setSourceRGBA(...this.options.fillColor);
            const bgX = tx - pad;
            const bgY = ty - pad;
            const bgW = textWidth + 2 * pad;
            const bgH = textHeight + 2 * pad;

            // Rounded rectangle
            const r = Math.min(6 * scale, Math.min(bgW, bgH) / 4);
            cr.newSubPath();
            cr.arc(bgX + r, bgY + r, r, Math.PI, 3 * Math.PI / 2);
            cr.arc(bgX + bgW - r, bgY + r, r, 3 * Math.PI / 2, 0);
            cr.arc(bgX + bgW - r, bgY + bgH - r, r, 0, Math.PI / 2);
            cr.arc(bgX + r, bgY + bgH - r, r, Math.PI / 2, Math.PI);
            cr.closePath();
            cr.fill();
        }

        // Text shadow
        const shadowOff = Math.max(1, Math.round(scale));
        cr.moveTo(tx + shadowOff, ty + shadowOff);
        cr.setSourceRGBA(0, 0, 0, 0.5);
        PangoCairo.show_layout(cr, layout);

        // Text
        cr.moveTo(tx, ty);
        cr.setSourceRGBA(...this.options.primaryColor);
        PangoCairo.show_layout(cr, layout);
    }

    getBounds() {
        const pad = this.fontSize + 8;
        const [x, y] = this.position;
        const estimatedWidth = this.text.length * this.fontSize * 0.6;
        return [
            x - estimatedWidth / 2 - pad,
            y - this.fontSize - pad,
            x + estimatedWidth / 2 + pad,
            y + pad,
        ];
    }

    translate(dx, dy) {
        this.position = [this.position[0] + dx, this.position[1] + dy];
    }
}

// =============================================================================
// HIGHLIGHTER
// =============================================================================

export class HighlighterAction extends StrokeAction {
    constructor(stroke, options, shift) {
        if (shift && stroke.length >= 2) {
            const start = stroke[0];
            const end = stroke[stroke.length - 1];
            super([start, [end[0], start[1]]], options);
        } else {
            super(stroke, options);
        }
    }

    draw(cr, toWidget, scale) {
        if (this.stroke.length < 2) return;

        const coords = this.stroke.map(([x, y]) => toWidget(x, y));
        const [r, g, b] = this.options.primaryColor;

        cr.save();
        // Semi-transparent OVER — works on both transparent overlay
        // and image surface (at save time). Gives a consistent
        // translucent highlight effect in all contexts.
        cr.setSourceRGBA(r, g, b, 0.45);
        cr.setLineWidth(this.options.size * scale * 2);
        cr.setLineCap(0); // BUTT

        cr.moveTo(...coords[0]);
        for (let i = 1; i < coords.length; i++) {
            cr.lineTo(...coords[i]);
        }
        cr.stroke();
        cr.restore();
    }

}

// =============================================================================
// CENSOR — mosaic pattern to hide content
// =============================================================================

export class CensorAction extends RectAction {
    draw(cr, toWidget, _scale) {
        // If we have a real pixelation preview, draw it
        if (this._previewBlocks) {
            const baseX = Math.min(this.start[0], this.end[0]);
            const baseY = Math.min(this.start[1], this.end[1]);

            cr.save();
            for (const block of this._previewBlocks) {
                const [wx, wy] = toWidget(baseX + block.rx, baseY + block.ry);
                const [wx2, wy2] = toWidget(
                    baseX + block.rx + block.rw,
                    baseY + block.ry + block.rh
                );
                cr.setSourceRGBA(block.r, block.g, block.b, 1.0);
                cr.rectangle(wx, wy, wx2 - wx, wy2 - wy);
                cr.fill();
            }
            cr.restore();
            return;
        }

        if (this.options?.liveVideo) {
            this._drawOpaqueLiveMask(cr, toWidget);
            return;
        }

        // Fallback: checkerboard placeholder (shown during drag)
        let [x1, y1] = toWidget(...this.start);
        let [x2, y2] = toWidget(...this.end);

        const x = Math.min(x1, x2);
        const y = Math.min(y1, y2);
        const w = Math.abs(x2 - x1);
        const h = Math.abs(y2 - y1);

        if (w < 1 || h < 1) return;

        cr.save();
        cr.rectangle(x, y, w, h);
        cr.clip();

        const blockSize = this._blockSizeForIntensity(1);
        const blocksX = Math.max(1, Math.floor(w / blockSize));
        const blocksY = Math.max(1, Math.floor(h / blockSize));

        for (let bx = 0; bx < blocksX; bx++) {
            for (let by = 0; by < blocksY; by++) {
                const shade = ((bx + by) % 2 === 0) ? 0.3 : 0.5;
                cr.setSourceRGBA(shade, shade, shade, 0.9);
                cr.rectangle(
                    x + bx * blockSize,
                    y + by * blockSize,
                    blockSize,
                    blockSize
                );
                cr.fill();
            }
        }
        cr.restore();
    }

    _drawOpaqueLiveMask(cr, toWidget) {
        let [x1, y1] = toWidget(...this.start);
        let [x2, y2] = toWidget(...this.end);

        const x = Math.min(x1, x2);
        const y = Math.min(y1, y2);
        const w = Math.abs(x2 - x1);
        const h = Math.abs(y2 - y1);

        if (w < 1 || h < 1) return;

        cr.save();
        cr.rectangle(x, y, w, h);
        cr.clip();

        const blockSize = this._blockSizeForIntensity(1);
        const blocksX = Math.max(1, Math.ceil(w / blockSize));
        const blocksY = Math.max(1, Math.ceil(h / blockSize));

        for (let bx = 0; bx < blocksX; bx++) {
            for (let by = 0; by < blocksY; by++) {
                const shade = ((bx + by) % 2 === 0) ? 0.04 : 0.16;
                cr.setSourceRGBA(shade, shade, shade, 1.0);
                cr.rectangle(
                    x + bx * blockSize,
                    y + by * blockSize,
                    blockSize,
                    blockSize
                );
                cr.fill();
            }
        }

        cr.restore();
    }

    /**
     * Compute block size from intensity level (1-5).
     * Higher intensity → larger blocks → stronger pixelation.
     */
    _blockSizeForIntensity(scaleFactor) {
        const level = this.options?.intensity || 3;
        // level 1=3 (weak), 2=5, 3=8, 4=12, 5=16 (strong)
        const sizes = [3, 5, 8, 12, 16];
        const base = sizes[Math.max(0, Math.min(level - 1, 4))];
        return Math.max(2, Math.round(base * scaleFactor));
    }

    /**
     * Generate real pixelation preview from screenshot pixel data.
     * Called by DrawingOverlay after the rectangle is committed.
     */
    generatePreview(pixbuf, bufScale) {
        const regionX = Math.min(this.start[0], this.end[0]);
        const regionY = Math.min(this.start[1], this.end[1]);
        const regionW = Math.abs(this.end[0] - this.start[0]);
        const regionH = Math.abs(this.end[1] - this.start[1]);

        const imgW = pixbuf.get_width();
        const imgH = pixbuf.get_height();

        const x = Math.round(Math.max(0, Math.min(regionX * bufScale, imgW - 1)));
        const y = Math.round(Math.max(0, Math.min(regionY * bufScale, imgH - 1)));
        const w = Math.round(Math.min(regionW * bufScale, imgW - x));
        const h = Math.round(Math.min(regionH * bufScale, imgH - y));

        if (w < 2 || h < 2) return;

        const blockSize = this._blockSizeForIntensity(bufScale);
        const bytes = pixbuf.read_pixel_bytes();
        const data = bytes.get_data();
        const rowstride = pixbuf.get_rowstride();
        const nChannels = pixbuf.get_n_channels();

        const blocks = [];
        const blocksX = Math.ceil(w / blockSize);
        const blocksY = Math.ceil(h / blockSize);

        for (let bxi = 0; bxi < blocksX; bxi++) {
            for (let byi = 0; byi < blocksY; byi++) {
                const bx0 = x + bxi * blockSize;
                const by0 = y + byi * blockSize;
                const bx1 = Math.min(bx0 + blockSize, x + w, imgW);
                const by1 = Math.min(by0 + blockSize, y + h, imgH);

                let rSum = 0, gSum = 0, bSum = 0, count = 0;
                for (let py = by0; py < by1; py++) {
                    for (let px = bx0; px < bx1; px++) {
                        const off = py * rowstride + px * nChannels;
                        rSum += data[off];
                        gSum += data[off + 1];
                        bSum += data[off + 2];
                        count++;
                    }
                }

                if (count > 0) {
                    blocks.push({
                        rx: (bx0 - x) / bufScale,
                        ry: (by0 - y) / bufScale,
                        rw: (bx1 - bx0) / bufScale,
                        rh: (by1 - by0) / bufScale,
                        r: rSum / count / 255,
                        g: gSum / count / 255,
                        b: bSum / count / 255,
                    });
                }
            }
        }

        this._previewBlocks = blocks;
    }

    /**
     * Apply real pixelation on GdkPixbuf at save time.
     */
    drawReal(pixbuf, GdkPixbuf, GLib, toWidget, scale) {
        let [x1, y1] = toWidget(...this.start);
        let [x2, y2] = toWidget(...this.end);

        const imgW = pixbuf.get_width();
        const imgH = pixbuf.get_height();

        const x = Math.round(Math.max(0, Math.min(Math.min(x1, x2), imgW - 1)));
        const y = Math.round(Math.max(0, Math.min(Math.min(y1, y2), imgH - 1)));
        const w = Math.round(Math.min(Math.abs(x2 - x1), imgW - x));
        const h = Math.round(Math.min(Math.abs(y2 - y1), imgH - y));

        if (w < 2 || h < 2) return pixbuf;

        const blockSize = this._blockSizeForIntensity(scale);

        const bytes = pixbuf.read_pixel_bytes();
        const data = bytes.get_data();
        const rowstride = pixbuf.get_rowstride();
        const nChannels = pixbuf.get_n_channels();

        const arr = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) arr[i] = data[i];

        const blocksX = Math.ceil(w / blockSize);
        const blocksY = Math.ceil(h / blockSize);

        for (let bx = 0; bx < blocksX; bx++) {
            for (let by = 0; by < blocksY; by++) {
                const bx0 = x + bx * blockSize;
                const by0 = y + by * blockSize;
                const bx1 = Math.min(bx0 + blockSize, x + w, imgW);
                const by1 = Math.min(by0 + blockSize, y + h, imgH);

                let rSum = 0, gSum = 0, bSum = 0, aSum = 0, count = 0;
                for (let py = by0; py < by1; py++) {
                    for (let px = bx0; px < bx1; px++) {
                        const off = py * rowstride + px * nChannels;
                        rSum += arr[off]; gSum += arr[off + 1];
                        bSum += arr[off + 2];
                        if (nChannels === 4) aSum += arr[off + 3];
                        count++;
                    }
                }
                if (count === 0) continue;

                const avgR = (rSum / count) | 0;
                const avgG = (gSum / count) | 0;
                const avgB = (bSum / count) | 0;
                const avgA = nChannels === 4 ? ((aSum / count) | 0) : 255;

                for (let py = by0; py < by1; py++) {
                    for (let px = bx0; px < bx1; px++) {
                        const off = py * rowstride + px * nChannels;
                        arr[off] = avgR;
                        arr[off + 1] = avgG;
                        arr[off + 2] = avgB;
                        if (nChannels === 4) arr[off + 3] = avgA;
                    }
                }
            }
        }

        const newBytes = GLib.Bytes.new(arr);
        return GdkPixbuf.Pixbuf.new_from_bytes(
            newBytes, pixbuf.get_colorspace(),
            pixbuf.get_has_alpha(), pixbuf.get_bits_per_sample(),
            imgW, imgH, rowstride
        );
    }
}

// =============================================================================
// BLUR — Gaussian-like blur effect
// Preview: shows a semi-transparent frosted overlay.
// Real blur is performed at save time using box-blur on pixel data.
// =============================================================================

export class BlurAction extends RectAction {
    /**
     * Compute blur intensity multiplier from level (1-5).
     * Higher intensity → larger radius → stronger blur.
     */
    _blurIntensityMultiplier() {
        const level = this.options?.intensity || 3;
        const mults = [0.5, 0.8, 1.0, 1.5, 2.5];
        return mults[Math.max(0, Math.min(level - 1, 4))];
    }

    /**
     * Preview draw — uses cached downscaled surface for real blur preview,
     * or falls back to frosted/hatched overlay during drag.
     */
    draw(cr, toWidget, scale) {
        let [x1, y1] = toWidget(...this.start);
        let [x2, y2] = toWidget(...this.end);

        const x = Math.min(x1, x2);
        const y = Math.min(y1, y2);
        const w = Math.abs(x2 - x1);
        const h = Math.abs(y2 - y1);

        if (w < 1 || h < 1) return;

        // Real blur preview from cached downscaled surface
        if (this._previewSurface) {
            cr.save();
            cr.rectangle(x, y, w, h);
            cr.clip();
            cr.translate(x, y);
            cr.scale(w / this._previewSmallW, h / this._previewSmallH);
            cr.setSourceSurface(this._previewSurface, 0, 0);
            // BILINEAR filter (enum value 4) for smooth blur effect
            const pattern = cr.getSource();
            if (pattern.setFilter)
                pattern.setFilter(4);
            cr.paint();
            cr.restore();
            return;
        }

        if (this.options?.liveVideo) {
            this._drawLiveBlurMask(cr, x, y, w, h, scale);
            return;
        }

        // Fallback: frosted/hatched overlay (shown during drag)
        cr.save();
        cr.rectangle(x, y, w, h);
        cr.setSourceRGBA(0.8, 0.85, 1.0, 0.35);
        cr.fill();

        cr.rectangle(x, y, w, h);
        cr.clip();

        cr.setSourceRGBA(1.0, 1.0, 1.0, 0.3);
        cr.setLineWidth(1.0);
        const spacing = 6 * scale;
        const maxDim = w + h;
        for (let d = -maxDim; d < maxDim; d += spacing) {
            cr.moveTo(x + d, y);
            cr.lineTo(x + d + h, y + h);
        }
        cr.stroke();
        cr.restore();
    }

    _drawLiveBlurMask(cr, x, y, w, h, scale) {
        cr.save();
        cr.rectangle(x, y, w, h);
        cr.clip();

        cr.setSourceRGBA(0.78, 0.84, 0.9, 0.88);
        cr.rectangle(x, y, w, h);
        cr.fill();

        cr.setSourceRGBA(1.0, 1.0, 1.0, 0.45);
        cr.setLineWidth(1.2 * scale);
        const spacing = Math.max(4, 6 * scale);
        const maxDim = w + h;
        for (let d = -maxDim; d < maxDim; d += spacing) {
            cr.moveTo(x + d, y);
            cr.lineTo(x + d + h, y + h);
        }
        cr.stroke();
        cr.restore();
    }

    /**
     * Generate real blur preview from screenshot pixel data.
     * Creates a small downscaled Cairo ImageSurface; when painted back
     * at full size with bilinear filtering, it produces a blur effect.
     */
    generatePreview(pixbuf, bufScale) {
        const regionX = Math.min(this.start[0], this.end[0]);
        const regionY = Math.min(this.start[1], this.end[1]);
        const regionW = Math.abs(this.end[0] - this.start[0]);
        const regionH = Math.abs(this.end[1] - this.start[1]);

        const imgW = pixbuf.get_width();
        const imgH = pixbuf.get_height();

        const x = Math.round(Math.max(0, Math.min(regionX * bufScale, imgW - 1)));
        const y = Math.round(Math.max(0, Math.min(regionY * bufScale, imgH - 1)));
        const w = Math.round(Math.min(regionW * bufScale, imgW - x));
        const h = Math.round(Math.min(regionH * bufScale, imgH - y));

        if (w < 2 || h < 2) return;

        const bytes = pixbuf.read_pixel_bytes();
        const data = bytes.get_data();
        const rowstride = pixbuf.get_rowstride();
        const nChannels = pixbuf.get_n_channels();

        // Downscale factor — larger = more blur
        // Intensity 1-5 maps to multiplier [0.5, 0.8, 1.0, 1.5, 2.5]
        const intensityMult = this._blurIntensityMultiplier();
        const radius = Math.max(3, Math.round((this.options?.size || 8) * bufScale * intensityMult));
        const downFactor = Math.max(2, Math.round(radius * 1.5));

        const smallW = Math.max(2, Math.ceil(w / downFactor));
        const smallH = Math.max(2, Math.ceil(h / downFactor));

        const surface = new cairo.ImageSurface(cairo.Format.ARGB32, smallW, smallH);
        const scr = new cairo.Context(surface);

        for (let sy = 0; sy < smallH; sy++) {
            for (let sx = 0; sx < smallW; sx++) {
                const srcX0 = x + sx * downFactor;
                const srcY0 = y + sy * downFactor;
                const srcX1 = Math.min(srcX0 + downFactor, x + w, imgW);
                const srcY1 = Math.min(srcY0 + downFactor, y + h, imgH);

                let rSum = 0, gSum = 0, bSum = 0, count = 0;
                for (let py = srcY0; py < srcY1; py++) {
                    for (let px = srcX0; px < srcX1; px++) {
                        const off = py * rowstride + px * nChannels;
                        rSum += data[off];
                        gSum += data[off + 1];
                        bSum += data[off + 2];
                        count++;
                    }
                }

                if (count > 0) {
                    scr.setSourceRGBA(
                        rSum / count / 255,
                        gSum / count / 255,
                        bSum / count / 255,
                        1.0
                    );
                    scr.rectangle(sx, sy, 1, 1);
                    scr.fill();
                }
            }
        }

        surface.flush();
        this._previewSurface = surface;
        this._previewSmallW = smallW;
        this._previewSmallH = smallH;
    }

    /**
     * Apply real blur on a GdkPixbuf at save time.
     * Uses iterative box blur on the pixel data (RGBA).
     * @param {object} pixbuf - GdkPixbuf.Pixbuf
     * @param {object} GdkPixbuf - GdkPixbuf module
     * @param {object} GLib - GLib module
     * @param {Function} toWidget - coordinate transform
     * @param {number} scale - draw scale
     * @returns {object} modified GdkPixbuf.Pixbuf
     */
    drawReal(pixbuf, GdkPixbuf, GLib, toWidget, scale) {
        let [x1, y1] = toWidget(...this.start);
        let [x2, y2] = toWidget(...this.end);

        const imgW = pixbuf.get_width();
        const imgH = pixbuf.get_height();

        const x = Math.round(Math.max(0, Math.min(Math.min(x1, x2), imgW - 1)));
        const y = Math.round(Math.max(0, Math.min(Math.min(y1, y2), imgH - 1)));
        const w = Math.round(Math.min(Math.abs(x2 - x1), imgW - x));
        const h = Math.round(Math.min(Math.abs(y2 - y1), imgH - y));

        if (w < 2 || h < 2) return pixbuf;

        const intensityMult = this._blurIntensityMultiplier();
        const radius = Math.max(3, Math.round((this.options?.size || 8) * scale * intensityMult));
        const passes = 3;

        const bytes = pixbuf.read_pixel_bytes();
        const data = bytes.get_data();
        const rowstride = pixbuf.get_rowstride();
        const nChannels = pixbuf.get_n_channels();

        // Make a mutable copy
        const arr = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) arr[i] = data[i];

        // Extract region into flat buffer
        const regionBuf = new Uint8Array(w * h * nChannels);
        for (let ry = 0; ry < h; ry++) {
            for (let rx = 0; rx < w; rx++) {
                const srcOff = (y + ry) * rowstride + (x + rx) * nChannels;
                const dstOff = (ry * w + rx) * nChannels;
                for (let c = 0; c < nChannels; c++)
                    regionBuf[dstOff + c] = arr[srcOff + c];
            }
        }

        // Box blur (horizontal then vertical), repeated for Gaussian approximation
        const tmp = new Uint8Array(w * h * nChannels);
        let src = regionBuf;
        let dst = tmp;

        for (let pass = 0; pass < passes; pass++) {
            // Horizontal pass
            for (let ry = 0; ry < h; ry++) {
                for (let rx = 0; rx < w; rx++) {
                    const sums = new Float64Array(nChannels);
                    let cnt = 0;
                    for (let k = -radius; k <= radius; k++) {
                        const sx = Math.max(0, Math.min(rx + k, w - 1));
                        const off = (ry * w + sx) * nChannels;
                        for (let c = 0; c < nChannels; c++)
                            sums[c] += src[off + c];
                        cnt++;
                    }
                    const off = (ry * w + rx) * nChannels;
                    for (let c = 0; c < nChannels; c++)
                        dst[off + c] = (sums[c] / cnt) | 0;
                }
            }
            [src, dst] = [dst, src];

            // Vertical pass
            for (let rx = 0; rx < w; rx++) {
                for (let ry = 0; ry < h; ry++) {
                    const sums = new Float64Array(nChannels);
                    let cnt = 0;
                    for (let k = -radius; k <= radius; k++) {
                        const sy = Math.max(0, Math.min(ry + k, h - 1));
                        const off = (sy * w + rx) * nChannels;
                        for (let c = 0; c < nChannels; c++)
                            sums[c] += src[off + c];
                        cnt++;
                    }
                    const off = (ry * w + rx) * nChannels;
                    for (let c = 0; c < nChannels; c++)
                        dst[off + c] = (sums[c] / cnt) | 0;
                }
            }
            [src, dst] = [dst, src];
        }

        // Write blurred region back
        for (let ry = 0; ry < h; ry++) {
            for (let rx = 0; rx < w; rx++) {
                const srcOff = (ry * w + rx) * nChannels;
                const dstOff = (y + ry) * rowstride + (x + rx) * nChannels;
                for (let c = 0; c < nChannels; c++)
                    arr[dstOff + c] = src[srcOff + c];
            }
        }

        const newBytes = GLib.Bytes.new(arr);
        return GdkPixbuf.Pixbuf.new_from_bytes(
            newBytes, pixbuf.get_colorspace(),
            pixbuf.get_has_alpha(), pixbuf.get_bits_per_sample(),
            imgW, imgH, rowstride
        );
    }
}

// =============================================================================
// INVERT — Invert colors of a rectangular region
// =============================================================================

export class InvertAction extends RectAction {
    /**
     * Preview draw — uses the cached inverted Cairo surface for real preview
     * (after the rectangle is committed), or falls back to a hatched overlay
     * during drag.
     */
    draw(cr, toWidget, _scale) {
        let [x1, y1] = toWidget(...this.start);
        let [x2, y2] = toWidget(...this.end);

        const x = Math.min(x1, x2);
        const y = Math.min(y1, y2);
        const w = Math.abs(x2 - x1);
        const h = Math.abs(y2 - y1);

        if (w < 1 || h < 1) return;

        // Real inverted preview from cached surface
        if (this._previewSurface) {
            cr.save();
            cr.rectangle(x, y, w, h);
            cr.clip();
            cr.translate(x, y);
            cr.scale(w / this._previewW, h / this._previewH);
            cr.setSourceSurface(this._previewSurface, 0, 0);
            const pattern = cr.getSource();
            // BILINEAR (4) — keeps the preview smooth when widget size differs
            // from the cached surface size.
            if (pattern.setFilter)
                pattern.setFilter(4);
            cr.paint();
            cr.restore();
            return;
        }

        if (this.options?.liveVideo) {
            this._drawLiveInvertMask(cr, x, y, w, h);
            return;
        }

        // Fallback: hatched overlay during drag (preview not ready yet).
        cr.save();
        cr.rectangle(x, y, w, h);
        cr.setSourceRGBA(1.0, 1.0, 1.0, 0.5);
        cr.fillPreserve();
        cr.clip();

        cr.setSourceRGBA(0.0, 0.0, 0.0, 0.3);
        cr.setLineWidth(1.0);
        const spacing = 6;
        const maxDim = w + h;
        for (let d = -maxDim; d < maxDim; d += spacing) {
            cr.moveTo(x + d, y);
            cr.lineTo(x + d + h, y + h);
        }
        cr.stroke();
        cr.restore();
    }

    _drawLiveInvertMask(cr, x, y, w, h) {
        cr.save();
        cr.rectangle(x, y, w, h);
        cr.clip();

        cr.setSourceRGBA(1.0, 1.0, 1.0, 0.82);
        cr.rectangle(x, y, w, h);
        cr.fill();

        cr.setSourceRGBA(0.0, 0.0, 0.0, 0.35);
        cr.setLineWidth(1.0);
        const spacing = 5;
        const maxDim = w + h;
        for (let d = -maxDim; d < maxDim; d += spacing) {
            cr.moveTo(x + d, y);
            cr.lineTo(x + d + h, y + h);
        }
        cr.stroke();
        cr.restore();
    }

    /**
     * Generate real inverted-color preview from screenshot pixel data.
     * Builds a Cairo ImageSurface by drawing inverted pixels via a Context
     * (the GJS Cairo binding doesn't expose ImageSurface.getData(), so we
     * can't write the byte buffer directly). For very large regions we cap
     * the preview resolution and let bilinear filtering upscale at draw
     * time — the saved result is always exact (drawReal at full resolution).
     */
    generatePreview(pixbuf, bufScale) {
        const regionX = Math.min(this.start[0], this.end[0]);
        const regionY = Math.min(this.start[1], this.end[1]);
        const regionW = Math.abs(this.end[0] - this.start[0]);
        const regionH = Math.abs(this.end[1] - this.start[1]);

        const imgW = pixbuf.get_width();
        const imgH = pixbuf.get_height();

        const x = Math.round(Math.max(0, Math.min(regionX * bufScale, imgW - 1)));
        const y = Math.round(Math.max(0, Math.min(regionY * bufScale, imgH - 1)));
        const w = Math.round(Math.min(regionW * bufScale, imgW - x));
        const h = Math.round(Math.min(regionH * bufScale, imgH - y));

        if (w < 2 || h < 2) return;

        // Cap at ~160k pixels (~400×400) to keep per-pixel Cairo fills cheap;
        // bilinear filter at draw() upscales smoothly when the widget is bigger.
        const MAX_PREVIEW_PIXELS = 160000;
        let pw = w, ph = h;
        if (w * h > MAX_PREVIEW_PIXELS) {
            const factor = Math.sqrt((w * h) / MAX_PREVIEW_PIXELS);
            pw = Math.max(2, Math.round(w / factor));
            ph = Math.max(2, Math.round(h / factor));
        }

        const bytes = pixbuf.read_pixel_bytes();
        const data = bytes.get_data();
        const rowstride = pixbuf.get_rowstride();
        const nChannels = pixbuf.get_n_channels();

        const surface = new cairo.ImageSurface(cairo.Format.ARGB32, pw, ph);
        const scr = new cairo.Context(surface);

        for (let py = 0; py < ph; py++) {
            const srcY = y + Math.min(h - 1, Math.floor(py * h / ph));
            for (let px = 0; px < pw; px++) {
                const srcX = x + Math.min(w - 1, Math.floor(px * w / pw));
                const off = srcY * rowstride + srcX * nChannels;
                const r = (255 - data[off]) / 255;
                const g = (255 - data[off + 1]) / 255;
                const b = (255 - data[off + 2]) / 255;
                const a = nChannels === 4 ? data[off + 3] / 255 : 1.0;
                scr.setSourceRGBA(r, g, b, a);
                scr.rectangle(px, py, 1, 1);
                scr.fill();
            }
        }

        surface.flush();
        this._previewSurface = surface;
        this._previewW = pw;
        this._previewH = ph;
    }

    /**
     * Apply real color inversion on GdkPixbuf at save time.
     * For each pixel in the region: R' = 255 - R, G' = 255 - G, B' = 255 - B.
     * Alpha channel is preserved.
     */
    drawReal(pixbuf, GdkPixbuf, GLib, toWidget, _scale) {
        let [x1, y1] = toWidget(...this.start);
        let [x2, y2] = toWidget(...this.end);

        const imgW = pixbuf.get_width();
        const imgH = pixbuf.get_height();

        const x = Math.round(Math.max(0, Math.min(Math.min(x1, x2), imgW - 1)));
        const y = Math.round(Math.max(0, Math.min(Math.min(y1, y2), imgH - 1)));
        const w = Math.round(Math.min(Math.abs(x2 - x1), imgW - x));
        const h = Math.round(Math.min(Math.abs(y2 - y1), imgH - y));

        if (w < 2 || h < 2) return pixbuf;

        const byteData = pixbuf.read_pixel_bytes();
        const data = byteData.get_data();
        const rowstride = pixbuf.get_rowstride();
        const nChannels = pixbuf.get_n_channels();

        // Make a mutable copy of all pixel data
        const arr = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) arr[i] = data[i];

        // Invert RGB channels in the selected region
        for (let py = y; py < y + h && py < imgH; py++) {
            for (let px = x; px < x + w && px < imgW; px++) {
                const off = py * rowstride + px * nChannels;
                arr[off]     = 255 - arr[off];     // R
                arr[off + 1] = 255 - arr[off + 1]; // G
                arr[off + 2] = 255 - arr[off + 2]; // B
                // Alpha (arr[off + 3]) is preserved
            }
        }

        const newBytes = GLib.Bytes.new(arr);
        return GdkPixbuf.Pixbuf.new_from_bytes(
            newBytes, pixbuf.get_colorspace(),
            pixbuf.get_has_alpha(), pixbuf.get_bits_per_sample(),
            imgW, imgH, rowstride
        );
    }
}

// =============================================================================
// NUMBER STAMP
// =============================================================================

export class NumberStampAction extends DrawingAction {
    constructor(position, number, options) {
        super();
        this.position = position;
        this.number = number;
        this.options = options;
    }

    draw(cr, toWidget, scale) {
        const [wx, wy] = toWidget(...this.position);
        const r = this.options.size * 2 * scale;

        // Circle background
        cr.setSourceRGBA(...(this.options.fillColor || this.options.primaryColor));
        cr.arc(wx, wy, r, 0, 2 * Math.PI);
        cr.fill();

        // Circle border
        if (this.options.borderColor) {
            cr.setSourceRGBA(...this.options.borderColor);
            cr.setLineWidth(2 * scale);
            cr.arc(wx, wy, r, 0, 2 * Math.PI);
            cr.stroke();
        }

        // Number text
        cr.selectFontFace('Sans', 0, 1); // NORMAL, BOLD
        cr.setFontSize(r * 1.2);
        const text = String(this.number);
        const ext = cr.textExtents(text);
        const tx = wx - ext.width / 2 - ext.xBearing;
        const ty = wy + ext.height / 2;

        if (this.options.borderColor) {
            cr.moveTo(tx, ty);
            cr.textPath(text);
            cr.setSourceRGBA(...this.options.borderColor);
            cr.setLineWidth(4 * scale);
            cr.strokePreserve();
        }

        cr.setSourceRGBA(1, 1, 1, 1); // White text
        cr.moveTo(tx, ty);
        cr.showText(text);
    }

    getBounds() {
        const r = this.options.size * 2 + 5;
        const [x, y] = this.position;
        return [x - r, y - r, x + r, y + r];
    }

    containsPoint(px, py) {
        const [x, y] = this.position;
        const r = this.options.size * 2 + 5;
        return (px - x) ** 2 + (py - y) ** 2 <= r ** 2;
    }

    translate(dx, dy) {
        this.position = [this.position[0] + dx, this.position[1] + dy];
    }
}

// =============================================================================
// NUMBER + ARROW ACTION
// =============================================================================

export class NumberArrowAction extends DrawingAction {
    constructor(position, end, number, options) {
        super();
        this.position = position; // arrow tip (where it points)
        this.end = end;           // number badge center
        this.number = number;
        this.options = options;
    }

    draw(cr, toWidget, scale) {
        const [tipX, tipY] = toWidget(...this.position);
        const [badgeX, badgeY] = toWidget(...this.end);
        const r = this.options.size * 2 * scale;

        // Arrow shaft from badge to tip
        const dx = tipX - badgeX;
        const dy = tipY - badgeY;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 1) return;

        const nx = dx / len;
        const ny = dy / len;

        // Start from badge edge, end near tip (leave room for arrowhead)
        const sx = badgeX + nx * r;
        const sy = badgeY + ny * r;
        const headLen = Math.max(14 * scale, r * 0.7);
        const ex = tipX - nx * headLen * 0.3;
        const ey = tipY - ny * headLen * 0.3;

        cr.setSourceRGBA(...this.options.primaryColor);
        cr.setLineWidth(Math.max(2, this.options.size * 0.4) * scale);
        cr.setLineCap(1); // ROUND
        cr.moveTo(sx, sy);
        cr.lineTo(ex, ey);
        cr.stroke();

        // Arrowhead
        const perpX = -ny;
        const perpY = nx;
        const hw = headLen * 0.5;
        cr.moveTo(tipX, tipY);
        cr.lineTo(tipX - nx * headLen + perpX * hw, tipY - ny * headLen + perpY * hw);
        cr.lineTo(tipX - nx * headLen - perpX * hw, tipY - ny * headLen - perpY * hw);
        cr.closePath();
        cr.fill();

        // Number badge (circle)
        cr.setSourceRGBA(...(this.options.fillColor || this.options.primaryColor));
        cr.arc(badgeX, badgeY, r, 0, 2 * Math.PI);
        cr.fill();

        // Number text
        cr.selectFontFace('Sans', 0, 1);
        cr.setFontSize(r * 1.2);
        const text = String(this.number);
        const ext = cr.textExtents(text);
        const tx = badgeX - ext.width / 2 - ext.xBearing;
        const ty = badgeY + ext.height / 2;
        cr.setSourceRGBA(1, 1, 1, 1);
        cr.moveTo(tx, ty);
        cr.showText(text);
    }

    getBounds() {
        const r = this.options.size * 2 + 5;
        const [x1, y1] = this.position;
        const [x2, y2] = this.end;
        return [
            Math.min(x1, x2) - r, Math.min(y1, y2) - r,
            Math.max(x1, x2) + r, Math.max(y1, y2) + r,
        ];
    }

    containsPoint(px, py) {
        const [bx, by] = this.end;
        const r = this.options.size * 2 + 5;
        if ((px - bx) ** 2 + (py - by) ** 2 <= r ** 2) return true;

        const [ax, ay] = this.position;
        return _pointToSegmentDist(px, py, ax, ay, bx, by) < 8;
    }

    translate(dx, dy) {
        this.position = [this.position[0] + dx, this.position[1] + dy];
        this.end = [this.end[0] + dx, this.end[1] + dy];
    }
}

// =============================================================================
// NUMBER + POINTER ACTION
// =============================================================================

export class NumberPointerAction extends DrawingAction {
    constructor(position, end, number, options) {
        super();
        this.position = position; // pointer dot
        this.end = end;           // number badge center
        this.number = number;
        this.options = options;
    }

    draw(cr, toWidget, scale) {
        const [dotX, dotY] = toWidget(...this.position);
        const [badgeX, badgeY] = toWidget(...this.end);
        const r = this.options.size * 2 * scale;
        const dotR = Math.max(3, this.options.size * 0.8) * scale;

        // Line from badge to dot
        const dx = dotX - badgeX;
        const dy = dotY - badgeY;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len > 1) {
            const nx = dx / len;
            const ny = dy / len;
            cr.setSourceRGBA(...this.options.primaryColor);
            cr.setLineWidth(Math.max(1.5, this.options.size * 0.5) * scale);
            cr.setLineCap(1); // ROUND
            cr.moveTo(badgeX + nx * r, badgeY + ny * r);
            cr.lineTo(dotX - nx * dotR, dotY - ny * dotR);
            cr.stroke();
        }

        // Pointer dot
        cr.setSourceRGBA(...this.options.primaryColor);
        cr.arc(dotX, dotY, dotR, 0, 2 * Math.PI);
        cr.fill();

        // Number badge
        cr.setSourceRGBA(...(this.options.fillColor || this.options.primaryColor));
        cr.arc(badgeX, badgeY, r, 0, 2 * Math.PI);
        cr.fill();

        // Number text
        cr.selectFontFace('Sans', 0, 1);
        cr.setFontSize(r * 1.2);
        const text = String(this.number);
        const ext = cr.textExtents(text);
        const tx = badgeX - ext.width / 2 - ext.xBearing;
        const ty = badgeY + ext.height / 2;
        cr.setSourceRGBA(1, 1, 1, 1);
        cr.moveTo(tx, ty);
        cr.showText(text);
    }

    getBounds() {
        const r = this.options.size * 2 + 5;
        const [x1, y1] = this.position;
        const [x2, y2] = this.end;
        return [
            Math.min(x1, x2) - r, Math.min(y1, y2) - r,
            Math.max(x1, x2) + r, Math.max(y1, y2) + r,
        ];
    }

    containsPoint(px, py) {
        const [bx, by] = this.end;
        const r = this.options.size * 2 + 5;
        if ((px - bx) ** 2 + (py - by) ** 2 <= r ** 2) return true;

        const [ax, ay] = this.position;
        return _pointToSegmentDist(px, py, ax, ay, bx, by) < 8;
    }

    translate(dx, dy) {
        this.position = [this.position[0] + dx, this.position[1] + dy];
        this.end = [this.end[0] + dx, this.end[1] + dy];
    }
}

// =============================================================================
// ZOOM CALLOUT — crop a region, magnify it as an inset, link it with an arrow
// Preview & export both go through draw(): the cropped pixels are captured once
// into a Cairo surface by generatePreview(), then painted scaled into the inset.
// =============================================================================

export class ZoomCalloutAction extends DrawingAction {
    constructor(srcStart, srcEnd, destPos, zoom, options, caption = '') {
        super();
        this.options = options;

        // Source rectangle, normalized to top-left / bottom-right (image coords)
        this.srcStart = [Math.min(srcStart[0], srcEnd[0]), Math.min(srcStart[1], srcEnd[1])];
        this.srcEnd = [Math.max(srcStart[0], srcEnd[0]), Math.max(srcStart[1], srcEnd[1])];

        this.zoom = ZoomCalloutAction.clampZoom(zoom || 2);
        this.destPos = destPos; // top-left of the magnified inset (image coords)

        // Optional caption rendered below the inset (empty = none)
        this.caption = (caption || '').trim();
        // Caption size: index into CAPTION_SCALES (0=small, 1=medium, 2=large)
        this.captionSizeIndex = 1;
        // Caption style: 'dark' (neutral strip) or 'highlight' (orange box)
        this.captionStyle = 'dark';

        // The inset (and its caption) may sit outside the captured area, so the
        // export pipeline should grow the canvas to keep it from being clipped.
        this.expandsCanvas = true;

        // Captured source pixels (filled by generatePreview); reused on every repaint
        this._sourceSurface = null;
        this._srcPixW = 0;
        this._srcPixH = 0;
    }

    static clampZoom(z) {
        return Math.max(1.5, Math.min(6, z));
    }

    get srcW() { return this.srcEnd[0] - this.srcStart[0]; }
    get srcH() { return this.srcEnd[1] - this.srcStart[1]; }
    get destW() { return this.srcW * this.zoom; }
    get destH() { return this.srcH * this.zoom; }

    setZoom(z) {
        this.zoom = ZoomCalloutAction.clampZoom(z);
    }

    setCaption(text) {
        this.caption = (text || '').trim();
    }

    // Caption font size as a fraction of the inset HEIGHT: P / M / G.
    // Proportional so the caption scales with the magnified crop instead of
    // being a fixed size (small crop → small caption, bigger crop → bigger).
    static get CAPTION_SCALES() { return [0.10, 0.15, 0.23]; }

    cycleCaptionSize(dir) {
        const max = ZoomCalloutAction.CAPTION_SCALES.length - 1;
        this.captionSizeIndex = Math.max(0, Math.min(max, this.captionSizeIndex + dir));
    }

    toggleCaptionStyle() {
        this.captionStyle = this.captionStyle === 'highlight' ? 'dark' : 'highlight';
    }

    /** Caption font size in image space (proportional to inset height, clamped). */
    captionFontSize() {
        const m = ZoomCalloutAction.CAPTION_SCALES[this.captionSizeIndex] ?? 0.15;
        return Math.max(11, Math.min(60, this.destH * m));
    }

    /** Height (image space) the caption band occupies below the inset, 0 if none. */
    captionBlockHeight() {
        if (!this.caption) return 0;
        return this.captionFontSize() * 1.3 + 12; // text + vertical padding + gap
    }

    /**
     * Capture the source region pixels into a standalone Cairo surface.
     * Goes through a tiny temp PNG — the same pixbuf→surface bridge the
     * export pipeline already relies on, so it works in every context.
     */
    generatePreview(pixbuf, bufScale) {
        const imgW = pixbuf.get_width();
        const imgH = pixbuf.get_height();

        const sx = Math.round(Math.max(0, Math.min(this.srcStart[0] * bufScale, imgW - 1)));
        const sy = Math.round(Math.max(0, Math.min(this.srcStart[1] * bufScale, imgH - 1)));
        const sw = Math.round(Math.min(this.srcW * bufScale, imgW - sx));
        const sh = Math.round(Math.min(this.srcH * bufScale, imgH - sy));
        if (sw < 1 || sh < 1) return;

        const tmpPath = GLib.build_filenamev([
            GLib.get_tmp_dir(),
            `big-shot-zoom-${GLib.get_monotonic_time()}.png`,
        ]);

        try {
            const sub = pixbuf.new_subpixbuf(sx, sy, sw, sh).copy();
            sub.savev(tmpPath, 'png', [], []);
            this._sourceSurface = cairo.ImageSurface.createFromPNG(tmpPath);
            this._srcPixW = sw;
            this._srcPixH = sh;
        } catch (err) {
            console.error(`[Big Shot] Zoom callout capture failed: ${err.message}`);
            this._sourceSurface = null;
        } finally {
            GLib.unlink(tmpPath);
        }
    }

    draw(cr, toWidget, scale) {
        const [dx0, dy0] = toWidget(this.destPos[0], this.destPos[1]);
        const [dx1, dy1] = toWidget(this.destPos[0] + this.destW, this.destPos[1] + this.destH);
        const dw = dx1 - dx0;
        const dh = dy1 - dy0;

        const [sx0, sy0] = toWidget(this.srcStart[0], this.srcStart[1]);
        const [sx1, sy1] = toWidget(this.srcEnd[0], this.srcEnd[1]);

        // 1. Connector from the source rectangle to the inset
        this._drawConnector(cr, sx0, sy0, sx1, sy1, dx0, dy0, dw, dh, scale);

        // 2. Thin outline around the source region (what's being magnified)
        cr.save();
        cr.setSourceRGBA(...this.options.primaryColor);
        cr.setLineWidth(Math.max(1, this.options.size * 0.6 * scale));
        cr.rectangle(sx0, sy0, sx1 - sx0, sy1 - sy0);
        cr.stroke();
        cr.restore();

        // 3. The magnified image
        if (this._sourceSurface && dw > 1 && dh > 1) {
            cr.save();
            cr.rectangle(dx0, dy0, dw, dh);
            cr.clip();
            cr.translate(dx0, dy0);
            cr.scale(dw / this._srcPixW, dh / this._srcPixH);
            cr.setSourceSurface(this._sourceSurface, 0, 0);
            // Highest-quality resampling (enum 2 = BEST) so magnified text
            // stays as crisp as the source pixels allow.
            const pattern = cr.getSource();
            if (pattern.setFilter)
                pattern.setFilter(2);
            cr.paint();
            cr.restore();
        } else if (dw > 1 && dh > 1) {
            // Surface not ready yet — neutral placeholder
            cr.save();
            cr.setSourceRGBA(0.15, 0.15, 0.15, 0.85);
            cr.rectangle(dx0, dy0, dw, dh);
            cr.fill();
            cr.restore();
        }

        // 4. Inset frame (shadow + white border) on top of the image
        const borderW = Math.max(2, this.options.size * 0.9 * scale);
        cr.save();
        const shadowOff = Math.max(1, Math.round(scale));
        cr.setSourceRGBA(0, 0, 0, 0.35);
        cr.setLineWidth(borderW);
        cr.rectangle(dx0 + shadowOff, dy0 + shadowOff, dw, dh);
        cr.stroke();
        cr.setSourceRGBA(1, 1, 1, 1);
        cr.setLineWidth(borderW);
        cr.rectangle(dx0, dy0, dw, dh);
        cr.stroke();
        cr.restore();

        // 5. Optional caption strip below the inset
        if (this.caption)
            this._drawCaption(cr, dx0, dy0, dw, dh, scale);
    }

    /** Caption band centered just below the inset (figure-caption style). */
    _drawCaption(cr, dx0, dy0, dw, dh, scale) {
        const fontSize = this.captionFontSize() * scale;
        const padX = Math.max(6, 6 * scale);
        const padY = Math.max(4, 3 * scale);
        const gap = Math.max(4, 4 * scale);
        const highlight = this.captionStyle === 'highlight';

        // Both styles honour the toolbar font selector.
        const layout = PangoCairo.create_layout(cr);
        const family = this.options.font || 'Sans';
        layout.set_font_description(Pango.FontDescription.from_string(`${family} ${fontSize}`));
        layout.set_text(this.caption, -1);
        const [, logicalRect] = layout.get_pixel_extents();
        const textW = logicalRect.width;
        const textH = logicalRect.height;

        // Highlight style hugs the text (colored box); the neutral style
        // spans the inset width (figure-caption strip).
        const barW = highlight ? (textW + padX * 2) : Math.max(textW + padX * 2, dw);
        const barH = textH + padY * 2;
        const barX = dx0 + dw / 2 - barW / 2;
        const barY = dy0 + dh + gap;

        cr.save();
        const shadowOff = Math.max(1, Math.round(scale));
        cr.setSourceRGBA(0, 0, 0, 0.30);
        cr.rectangle(barX + shadowOff, barY + shadowOff, barW, barH);
        cr.fill();
        cr.setSourceRGBA(...(highlight ? [0.867, 0.282, 0.078, 1]   // orange highlight #DD4814
                                       : [0, 0, 0, 0.72]));
        cr.rectangle(barX, barY, barW, barH);
        cr.fill();

        // Centered white text.
        cr.setSourceRGBA(1, 1, 1, 1);
        cr.moveTo(barX + barW / 2 - textW / 2, barY + padY);
        PangoCairo.show_layout(cr, layout);
        cr.restore();
    }

    /** Arrow from the source-rect border toward the inset border. */
    _drawConnector(cr, sx0, sy0, sx1, sy1, dx0, dy0, dw, dh, scale) {
        const scx = (sx0 + sx1) / 2;
        const scy = (sy0 + sy1) / 2;
        const dcx = dx0 + dw / 2;
        const dcy = dy0 + dh / 2;

        let dirX = dcx - scx;
        let dirY = dcy - scy;
        const len = Math.hypot(dirX, dirY);
        if (len < 1) return;
        dirX /= len;
        dirY /= len;

        const [bx, by] = this._exitPoint(scx, scy, (sx1 - sx0) / 2, (sy1 - sy0) / 2, dirX, dirY);
        const [ex, ey] = this._exitPoint(dcx, dcy, dw / 2, dh / 2, -dirX, -dirY);

        const width = Math.max(1.5, this.options.size * 1.2 * scale);
        const angle = Math.atan2(ey - by, ex - bx);
        const headSize = Math.max(6, this.options.size * 2.5 * scale);
        const arrowAngle = Math.PI / 6;
        const lx = ex + headSize * Math.cos(angle + Math.PI - arrowAngle);
        const ly = ey + headSize * Math.sin(angle + Math.PI - arrowAngle);
        const rx = ex + headSize * Math.cos(angle + Math.PI + arrowAngle);
        const ry = ey + headSize * Math.sin(angle + Math.PI + arrowAngle);

        cr.save();
        cr.setLineWidth(width);
        cr.setLineCap(1); // ROUND

        // Shadow
        const off = Math.max(1, Math.round(scale));
        cr.setSourceRGBA(0, 0, 0, 0.4);
        cr.moveTo(bx + off, by + off); cr.lineTo(ex + off, ey + off); cr.stroke();
        cr.moveTo(ex + off, ey + off); cr.lineTo(lx + off, ly + off); cr.stroke();
        cr.moveTo(ex + off, ey + off); cr.lineTo(rx + off, ry + off); cr.stroke();

        // Arrow
        cr.setSourceRGBA(...this.options.primaryColor);
        cr.moveTo(bx, by); cr.lineTo(ex, ey); cr.stroke();
        cr.moveTo(ex, ey); cr.lineTo(lx, ly); cr.stroke();
        cr.moveTo(ex, ey); cr.lineTo(rx, ry); cr.stroke();
        cr.restore();
    }

    /** Point where a ray from (cx,cy) in direction (dx,dy) exits a half-w/half-h box. */
    _exitPoint(cx, cy, hw, hh, dx, dy) {
        const tx = dx !== 0 ? hw / Math.abs(dx) : Infinity;
        const ty = dy !== 0 ? hh / Math.abs(dy) : Infinity;
        const t = Math.min(tx, ty);
        return [cx + dx * t, cy + dy * t];
    }

    getBounds() {
        const xs = [this.srcStart[0], this.srcEnd[0], this.destPos[0], this.destPos[0] + this.destW];
        const ys = [this.srcStart[1], this.srcEnd[1], this.destPos[1], this.destPos[1] + this.destH];
        let maxY = Math.max(...ys);
        if (this.caption) {
            maxY = this.destPos[1] + this.destH + this.captionBlockHeight();
        }
        return [Math.min(...xs), Math.min(...ys), Math.max(...xs), maxY];
    }

    // Only the inset is grabbable — dragging moves the magnified box, not the source.
    containsPoint(x, y) {
        return x >= this.destPos[0] && x <= this.destPos[0] + this.destW &&
               y >= this.destPos[1] && y <= this.destPos[1] + this.destH;
    }

    translate(dx, dy) {
        this.destPos = [this.destPos[0] + dx, this.destPos[1] + dy];
    }
}

/** Distance from point (px,py) to line segment (ax,ay)-(bx,by) */
function _pointToSegmentDist(px, py, ax, ay, bx, by) {
    const abx = bx - ax, aby = by - ay;
    const apx = px - ax, apy = py - ay;
    const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / (abx * abx + aby * aby || 1)));
    const cx = ax + t * abx, cy = ay + t * aby;
    return Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
}

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Create a drawing action from the current mode and input
 */
export function createAction(mode, data, options) {
    switch (mode) {
        case DrawingMode.PEN:
            return new StrokeAction(data.stroke, options);
        case DrawingMode.ARROW:
            return new ArrowAction(data.start, data.end, data.shift, options);
        case DrawingMode.LINE:
            return new LineAction(data.start, data.end, data.shift, options);
        case DrawingMode.RECT:
            return new RectAction(data.start, data.end, data.shift, options);
        case DrawingMode.CIRCLE:
            return new CircleAction(data.start, data.end, data.shift, options);
        case DrawingMode.TEXT:
            return new TextAction(data.position, data.text, options, data.fontSize);
        case DrawingMode.HIGHLIGHTER:
            return new HighlighterAction(data.stroke, options, data.shift);
        case DrawingMode.CENSOR:
            return new CensorAction(data.start, data.end, false, options);
        case DrawingMode.BLUR:
            return new BlurAction(data.start, data.end, false, options);
        case DrawingMode.INVERT:
            return new InvertAction(data.start, data.end, false, options);
        case DrawingMode.ZOOM_CALLOUT:
            return new ZoomCalloutAction(data.start, data.end, data.destPos, data.zoom, options, data.caption);
        case DrawingMode.NUMBER:
            return new NumberStampAction(data.position, data.number, options);
        case DrawingMode.NUMBER_ARROW:
            return new NumberArrowAction(data.start, data.end, data.number, options);
        case DrawingMode.NUMBER_POINTER:
            return new NumberPointerAction(data.start, data.end, data.number, options);
        default:
            return null;
    }
}
