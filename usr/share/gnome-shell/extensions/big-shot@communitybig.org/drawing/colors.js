/**
 * Big Shot — Color palette and utilities
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

export const PALETTE = [
    '#ed333b', // Red
    '#ff7800', // Orange
    '#f8e45c', // Yellow
    '#57e389', // Green
    '#62a0ea', // Blue
    '#9141ac', // Purple
    '#ffffff', // White
    '#000000', // Black
    '#c0bfbc', // Light Gray
    '#77767b', // Dark Gray
    '#e01b24', // Dark Red
    '#ff6600', // Dark Orange
];

export const HIGHLIGHTER_COLORS = [
    [1.0, 0.92, 0.23, 0.5],  // Yellow
    [0.34, 0.89, 0.54, 0.5], // Green
    [0.38, 0.63, 0.92, 0.5], // Blue
    [0.93, 0.2, 0.23, 0.5],  // Red
    [0.57, 0.25, 0.67, 0.5], // Purple
];

/**
 * Convert hex color string to [r, g, b, a] array (0-1 range)
 */
export function hexToRGBA(hex, alpha = 1.0) {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    return [r, g, b, alpha];
}

/**
 * Convert [r, g, b, a] to hex string
 */
export function rgbaToHex(rgba) {
    const r = Math.round(rgba[0] * 255).toString(16).padStart(2, '0');
    const g = Math.round(rgba[1] * 255).toString(16).padStart(2, '0');
    const b = Math.round(rgba[2] * 255).toString(16).padStart(2, '0');
    return `#${r}${g}${b}`;
}

/**
 * Convert 0-1 float RGB to CSS rgb() string
 */
export function rgbToCSS(r, g, b) {
    return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}
