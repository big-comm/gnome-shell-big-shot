/**
 * Big Shot — Framerate selector
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { PartPopupSelect } from './partbase.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

export class PartFramerate extends PartPopupSelect {
    constructor(screenshotUI, extension) {
        super(
            screenshotUI,
            extension,
            [15, 24, 30, 60],
            30,
            (v) => `${v} FPS`,
            _('Frames per second')
        );
    }
}
