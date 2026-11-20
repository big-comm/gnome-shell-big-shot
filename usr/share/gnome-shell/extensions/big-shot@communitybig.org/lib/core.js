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

/**
 * Hardware encoders that their plugin registers only when the GPU answers a
 * probe while GStreamer scans plugins, mapped to that plugin.
 *
 * The registry cache keeps the result of that probe. If it was written while
 * the GPU was not ready (right after resume from suspend, for instance), the
 * plugin is cached without its encoders, and GStreamer never rescans an
 * unchanged plugin file: the encoder stays hidden until the cache is deleted,
 * and recording silently falls back to a software encoder.
 */
export const GPU_PROBED_ENCODERS = Object.freeze({
    nvh264enc: 'nvcodec',
    nvh265enc: 'nvcodec',
    vah264enc: 'va',
    vah264lpenc: 'va',
    vah265enc: 'va',
    vah265lpenc: 'va',
    vaapih264enc: 'vaapi',
    vaapih265enc: 'vaapi',
});

/**
 * Encoders that a stale registry may be hiding from the GPU pipelines.
 *
 * Only when no GPU pipeline is usable: that is the case that drops recording
 * to software. A GPU that simply lacks one variant (no low-power VA entry
 * point, no HEVC on an older NVENC) keeps a working pipeline and must not pay
 * for a registry rebuild on every detection. Order is preserved and
 * duplicates are dropped.
 */
export function hiddenGpuEncoders(gpuConfigs, availableElements) {
    if (gpuConfigs.some(config =>
        config.elements.every(element => availableElements.has(element))))
        return [];

    return [...new Set(gpuConfigs.flatMap(config => config.elements))]
        .filter(element =>
            Object.hasOwn(GPU_PROBED_ENCODERS, element) &&
            !availableElements.has(element));
}

/**
 * Path of the registry cache GStreamer reads, resolved the way gstregistry.c
 * does: GST_REGISTRY_1_0, then GST_REGISTRY, then the per-arch file in the
 * user cache directory. Returns null when the default path cannot be built.
 */
export function gstRegistryPath(getenv, userCacheDir, arch) {
    const override = getenv('GST_REGISTRY_1_0') || getenv('GST_REGISTRY');
    if (override)
        return override;
    if (!userCacheDir || !arch)
        return null;
    return `${userCacheDir}/gstreamer-1.0/registry.${arch}.bin`;
}
