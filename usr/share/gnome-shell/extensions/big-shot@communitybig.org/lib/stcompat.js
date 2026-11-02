/**
 * Big Shot — St API differences across supported shell versions
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Clutter from 'gi://Clutter';
import St from 'gi://St';

let orientationSupported = null;

/**
 * Whether this shell's St.BoxLayout accepts the `orientation` property.
 *
 * St.BoxLayout:orientation was added in GNOME 48, and :vertical — the only
 * spelling 46 and 47 understand — was deprecated at the same time and
 * removed in 51. No single spelling covers the whole supported range, and
 * passing the wrong one is fatal: GJS raises "No property vertical on
 * StBoxLayout" from the constructor, which aborts enable() outright.
 *
 * Probed rather than derived from the version number, so the answer comes
 * from the shell actually running instead of from a table that has to be
 * kept correct release after release. The probe runs once; the throwaway
 * actor is destroyed immediately.
 */
function supportsOrientation() {
    if (orientationSupported !== null)
        return orientationSupported;

    try {
        new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL}).destroy();
        orientationSupported = true;
    } catch {
        orientationSupported = false;
    }
    return orientationSupported;
}

/**
 * Create an St.BoxLayout, spelling the orientation the way this shell wants.
 *
 * Takes `vertical: true|false` and translates it, so call sites read the
 * same on every release. Every other property is passed through untouched.
 *
 * @param {object} props - St.BoxLayout properties, plus `vertical`
 * @returns {St.BoxLayout} the new box
 */
export function boxLayout(props = {}) {
    const {vertical = false, ...rest} = props;

    if (!supportsOrientation())
        return new St.BoxLayout({vertical, ...rest});

    return new St.BoxLayout({
        orientation: vertical
            ? Clutter.Orientation.VERTICAL
            : Clutter.Orientation.HORIZONTAL,
        ...rest,
    });
}

/** Reset the cached probe result. Test seam; not used at runtime. */
export function resetOrientationProbe() {
    orientationSupported = null;
}
