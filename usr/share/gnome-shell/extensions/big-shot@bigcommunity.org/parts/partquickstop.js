/**
 * Big Shot — Quick Stop for screencast
 *
 * If recording is in progress and user triggers screenshot (Ctrl+Alt+Shift+R),
 * stop the recording instead of opening the screenshot UI.
 *
 * NOTE: The actual open() interception is now handled in extension.js
 * (_patchScreencast) to avoid double monkey-patching that breaks after
 * lock-screen disable/enable cycles. This part exists only as a
 * placeholder for future quick-stop UI or settings.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { PartUI } from './partbase.js';

export class PartQuickStop extends PartUI {
    constructor(screenshotUI, extension) {
        super(screenshotUI, extension);
        // Quick-stop logic is handled in extension._patchScreencast()
    }
}
