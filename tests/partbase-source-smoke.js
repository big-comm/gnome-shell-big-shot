import GLib from 'gi://GLib';

import { PartBase } from '../usr/share/gnome-shell/extensions/big-shot@communitybig.org/parts/partbase.js';

const loop = GLib.MainLoop.new(null, false);
const part = new PartBase();
let idleRan = false;
let canceledTimeoutRan = false;

const completedId = part._addIdle(() => {
    idleRan = true;
    return GLib.SOURCE_REMOVE;
});

part._addTimeout(30, () => {
    canceledTimeoutRan = true;
    return GLib.SOURCE_REMOVE;
});

GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => {
    part._removeSource(completedId);
    part.destroy();
    return GLib.SOURCE_REMOVE;
});

GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
    loop.quit();
    return GLib.SOURCE_REMOVE;
});

loop.run();

if (!idleRan)
    throw new Error('Tracked idle did not run');
if (canceledTimeoutRan)
    throw new Error('Tracked timeout ran after destroy');
