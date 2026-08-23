/**
 * Pure helpers shared by the GNOME integration and Node.js tests.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

function _evenDimension(value) {
    return Math.max(2, Math.round(value / 2) * 2);
}

export function computeScaledDimensions(sourceWidth, sourceHeight, scale) {
    if (!Number.isFinite(sourceWidth) || sourceWidth <= 0 ||
        !Number.isFinite(sourceHeight) || sourceHeight <= 0 ||
        !Number.isFinite(scale) || scale <= 0)
        return null;

    return {
        width: _evenDimension(sourceWidth * scale),
        height: _evenDimension(sourceHeight * scale),
    };
}

export function computeOverlayRect(stageWidth, stageHeight, panelRect = null,
    panelVisible = false, edgeTolerance = 32) {
    const result = {
        x: 0,
        y: 0,
        width: Math.max(1, stageWidth),
        height: Math.max(1, stageHeight),
    };

    if (!panelVisible || !panelRect)
        return result;

    const { x, y, width, height } = panelRect;
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0)
        return result;

    if (width >= height) {
        if (y <= edgeTolerance) {
            result.y = Math.max(0, y + height);
            result.height = Math.max(1, stageHeight - result.y);
        } else if (y + height >= stageHeight - edgeTolerance) {
            result.height = Math.max(1, y);
        }
    } else if (x <= edgeTolerance) {
        result.x = Math.max(0, x + width);
        result.width = Math.max(1, stageWidth - result.x);
    } else if (x + width >= stageWidth - edgeTolerance) {
        result.width = Math.max(1, x);
    }

    return result;
}

/**
 * Major GNOME Shell version from a `Config.PACKAGE_VERSION` string.
 *
 * Used to pick between API generations that changed shape rather than name,
 * where feature detection cannot tell them apart. Returns 0 when the version
 * is unusable so callers fall back to the oldest supported code path.
 */
export function shellMajorVersion(packageVersion) {
    if (typeof packageVersion !== 'string')
        return 0;

    const major = Number.parseInt(packageVersion.split('.')[0], 10);
    return Number.isInteger(major) && major > 0 ? major : 0;
}

export function recordingExtension(path, fallback = 'webm') {
    if (typeof path !== 'string')
        return fallback;

    const match = path.toLowerCase().match(/\.([a-z0-9]+)$/);
    if (!match || ['unknown', 'undefined'].includes(match[1]))
        return fallback;
    return match[1];
}
