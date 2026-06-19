/**
 * Big Shot — Gradient presets for screenshot beautification
 *
 * SPDX-License-Identifier: MIT
 */

import Cairo from 'gi://cairo';

/**
 * Each gradient has:
 *   name   — Display name
 *   stops  — Array of [offset, r, g, b] in 0-1 range
 *   angle  — Degrees (0 = top-to-bottom, 90 = left-to-right)
 */
export const GRADIENTS = [
    {
        name: 'Red Flame',
        angle: 135,
        stops: [
            [0.0, 0.93, 0.11, 0.14],
            [1.0, 1.0, 0.47, 0.0],
        ],
    },
    {
        name: 'Sunset Orange',
        angle: 135,
        stops: [
            [0.0, 1.0, 0.47, 0.0],
            [1.0, 1.0, 0.68, 0.0],
        ],
    },
    {
        name: 'Golden Hour',
        angle: 135,
        stops: [
            [0.0, 1.0, 0.68, 0.0],
            [1.0, 0.97, 0.89, 0.36],
        ],
    },
    {
        name: 'Mint Fresh',
        angle: 135,
        stops: [
            [0.0, 0.34, 0.89, 0.54],
            [1.0, 0.0, 0.78, 0.58],
        ],
    },
    {
        name: 'Ocean Breeze',
        angle: 135,
        stops: [
            [0.0, 0.38, 0.63, 0.92],
            [1.0, 0.2, 0.4, 0.74],
        ],
    },
    {
        name: 'Purple Dream',
        angle: 135,
        stops: [
            [0.0, 0.57, 0.25, 0.67],
            [1.0, 0.35, 0.15, 0.60],
        ],
    },
    {
        name: 'Night Sky',
        angle: 135,
        stops: [
            [0.0, 0.12, 0.12, 0.30],
            [1.0, 0.22, 0.18, 0.42],
        ],
    },
    {
        name: 'Coral Pink',
        angle: 135,
        stops: [
            [0.0, 1.0, 0.44, 0.47],
            [1.0, 1.0, 0.63, 0.55],
        ],
    },
    {
        name: 'None',
        angle: 0,
        stops: [],
    },
];

/**
 * Helper: paint a gradient onto a Cairo context within the given rect.
 *
 * @param {Cairo.Context} cr
 * @param {Object} gradient — one of the GRADIENTS entries
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 */
export function paintGradient(cr, gradient, x, y, w, h) {
    if (!gradient.stops || gradient.stops.length === 0)
        return;

    const rad = gradient.angle * (Math.PI / 180);
    const cx = x + w / 2;
    const cy = y + h / 2;
    const diag = Math.sqrt(w * w + h * h) / 2;

    const x0 = cx - diag * Math.sin(rad);
    const y0 = cy - diag * Math.cos(rad);
    const x1 = cx + diag * Math.sin(rad);
    const y1 = cy + diag * Math.cos(rad);

    const pat = new Cairo.LinearGradient(x0, y0, x1, y1);
    for (const [offset, r, g, b] of gradient.stops)
        pat.addColorStopRGBA(offset, r, g, b, 1.0);

    cr.setSource(pat);
    cr.rectangle(x, y, w, h);
    cr.fill();
}

/**
 * Paint a soft drop shadow behind a rectangle.
 * Uses multiple offset rectangles with decreasing opacity.
 *
 * @param {Cairo.Context} cr
 * @param {number} x — image x
 * @param {number} y — image y
 * @param {number} w — image width
 * @param {number} h — image height
 * @param {number} radius — shadow blur radius (default 16)
 * @param {number} offsetY — vertical offset (default 4)
 */
export function paintDropShadow(cr, x, y, w, h, radius = 16, offsetY = 4) {
    const steps = 8;
    for (let i = steps; i >= 1; i--) {
        const spread = (radius * i) / steps;
        const alpha = 0.25 * (1 - i / (steps + 1));
        cr.setSourceRGBA(0, 0, 0, alpha);
        cr.rectangle(
            x - spread,
            y - spread + offsetY,
            w + 2 * spread,
            h + 2 * spread
        );
        cr.fill();
    }
}

/**
 * Paint a rounded rectangle clip path.
 *
 * @param {Cairo.Context} cr
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {number} r — border radius
 */
export function paintRoundedRect(cr, x, y, w, h, r) {
    if (r <= 0) {
        cr.rectangle(x, y, w, h);
        return;
    }
    r = Math.min(r, Math.min(w, h) / 2);
    cr.newSubPath();
    cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
    cr.arc(x + w - r, y + r, r, 3 * Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.closePath();
}
