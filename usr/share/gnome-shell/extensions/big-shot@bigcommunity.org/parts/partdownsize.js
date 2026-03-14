/**
 * Big Shot — Resolution downsize selector
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { PartPopupSelect } from './partbase.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

export class PartDownsize extends PartPopupSelect {
    constructor(screenshotUI, extension) {
        super(
            screenshotUI,
            extension,
            [1.00, 0.75, 0.50, 0.33],
            1.00,
            (v) => `${Math.round(v * 100)}%`,
            _('Recording resolution')
        );
    }
}
