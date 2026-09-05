import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const parts = 'usr/share/gnome-shell/extensions/big-shot@communitybig.org/parts/';
const read = file => readFileSync(parts + file, 'utf8');
const strip = source => source.replace(/^import .*;\n/gm, '').replaceAll('export ', '');
const baseSource = strip(read('partbase.js'));
const source = strip(read('partmonitor.js'));
const monitors = [
    {index: 0, x: 0, y: 0, width: 1920, height: 1080},
    {index: 1, x: -2560, y: -360, width: 2560, height: 1440},
    {index: 2, x: 0, y: -1200, width: 1920, height: 1200},
];

class Signals {
    callbacks = new Map();
    next = 0;
    connect(name, callback) {
        this.callbacks.set(++this.next, {name, callback});
        return this.next;
    }
    disconnect(id) { this.callbacks.delete(id); }
    emit(name) {
        for (const signal of [...this.callbacks.values()]) {
            if (signal.name === name) signal.callback();
        }
    }
}

function fixture() {
    const timers = new Map();
    let serial = 0, changes = 0;
    class MonitorConstraint {
        _primary = true;
        _index = -1;
        get primary() { return this._primary; }
        set primary(value) { this._primary = value; if (value) this._index = -1; }
        get index() { return this._index; }
        set index(value) { this._index = value; this._primary = false; }
    }
    const GLib = {
        SOURCE_REMOVE: false, PRIORITY_DEFAULT: 0,
        idle_add(_priority, callback) { timers.set(++serial, callback); return serial; },
        source_remove(id) { timers.delete(id); },
    };
    const manager = Object.assign(new Signals(), {monitors: [...monitors], primaryMonitor: monitors[0]});
    const constraint = new MonitorConstraint();
    const otherConstraint = {};
    const ui = Object.assign(new Signals(), {
        visible: true,
        _primaryMonitorBin: {get_constraints: () => [otherConstraint, constraint]},
        _selectionButton: Object.assign(new Signals(), {checked: true}),
        _screenButton: Object.assign(new Signals(), {checked: false}),
        _windowButton: Object.assign(new Signals(), {checked: false}),
        _shotButton: Object.assign(new Signals(), {checked: true}),
        _areaSelector: Object.assign(new Signals(), {getGeometry: () => [-1600, 100, 800, 600]}),
        _screenSelectors: monitors.map(() => Object.assign(new Signals(), {checked: false})),
        _windowSelectors: [],
    });
    const context = {GLib, Main: {layoutManager: manager}, Layout: {MonitorConstraint}};
    const {PartMonitor, monitorForRect} = vm.runInNewContext(
        baseSource + '\n' + source + '\n({PartMonitor, monitorForRect})', context);
    const part = new PartMonitor(ui, {}, () => changes++);
    const flush = () => {
        for (const [id, callback] of [...timers]) {
            timers.delete(id);
            callback();
        }
    };
    return {part, ui, constraint, otherConstraint, manager, timers, flush, monitorForRect,
        changes: () => changes};
}

test('selection uses logical overlap across horizontal and vertical monitors', () => {
    const f = fixture();
    const choose = rect => f.monitorForRect(monitors, rect, monitors[0]);
    assert.equal(choose({x: -1600, y: 10, width: 800, height: 600}), monitors[1]);
    assert.equal(choose({x: 100, y: -1100, width: 800, height: 600}), monitors[2]);
    assert.equal(choose({x: -900, y: 10, width: 1200, height: 600}), monitors[1]);
    assert.equal(choose({x: -300, y: 10, width: 1200, height: 600}), monitors[0]);
    assert.equal(choose({x: -300, y: 10, width: 600, height: 600}), monitors[0]);
    assert.equal(choose({x: NaN, y: 0, width: 1, height: 1}), monitors[0]);
    assert.equal(f.monitorForRect([], null, monitors[0]), null);
    f.part.destroy();
});

test('controls follow selection, screen and window without changing capture geometry', () => {
    const f = fixture();
    f.flush();
    assert.equal(f.constraint.primary, false);
    assert.equal(f.constraint.index, 1);
    assert.deepEqual(f.ui._areaSelector.getGeometry(), [-1600, 100, 800, 600]);
    f.ui._areaSelector.getGeometry = () => [100, -900, 500, 500];
    f.ui._areaSelector.emit('drag-ended');
    f.flush();
    assert.equal(f.constraint.index, 2);
    f.ui._selectionButton.checked = false;
    f.ui._screenButton.checked = true;
    f.ui._screenSelectors[0].checked = true;
    f.ui._screenSelectors[0].emit('notify::checked');
    f.flush();
    assert.equal(f.constraint.index, 0);
    const window = Object.assign(new Signals(), {
        checked: true, boundingBox: {x: -1500, y: 50, width: 900, height: 700},
    });
    f.ui._windowSelectors = [{windows: () => [window]}];
    f.ui._screenButton.checked = false;
    f.ui._windowButton.checked = true;
    f.ui.emit('notify::visible');
    f.flush();
    assert.equal(f.constraint.index, 1);
    window.boundingBox = {x: 100, y: 50, width: 900, height: 700};
    window.emit('notify::checked');
    f.flush();
    assert.equal(f.constraint.index, 0);
    f.part.destroy();
    assert.equal(window.callbacks.size, 0);
});

test('close, reopen, topology changes and teardown restore owned constraints', () => {
    const f = fixture();
    f.flush();
    f.ui.visible = false;
    f.ui.emit('notify::visible');
    assert.equal(f.constraint.primary, true);
    assert.equal(f.part.monitor, monitors[1], 'recording retains the captured monitor');
    assert.ok(f.ui._screenSelectors.every(selector => selector.callbacks.size === 0));
    f.ui.visible = true;
    f.ui.emit('notify::visible');
    f.flush();
    assert.equal(f.constraint.index, 1);
    f.manager.monitors = [monitors[0]];
    f.manager.emit('monitors-changed');
    f.flush();
    assert.equal(f.constraint.index, 0);
    f.ui._areaSelector.emit('drag-ended');
    f.part.destroy();
    assert.equal(f.constraint.primary, true);
    assert.equal(f.constraint.index, -1);
    assert.equal(f.timers.size, 0);
    assert.equal(f.manager.callbacks.size, 0);
    assert.equal(f.ui.callbacks.size, 0);
    assert.equal(f.ui._primaryMonitorBin.get_constraints()[0], f.otherConstraint);
});

test('teardown preserves a later external constraint change', () => {
    const f = fixture();
    f.flush();
    f.constraint.index = 2;
    f.part.destroy();
    assert.equal(f.constraint.index, 2);
    assert.equal(f.constraint.primary, false);
});

test('floating and recording toolbars use the capture monitor', () => {
    const text = read('parttoolbar.js');
    const floating = text.slice(text.indexOf('    _positionCaptureToolbar(actor) {'),
        text.indexOf('    repositionVideoPanel() {'));
    const recording = text.slice(text.indexOf('    _setRecordingToolbarPosition() {'),
        text.indexOf('    _presentRecordingToolbar() {'));
    const Toolbar = vm.runInNewContext('class Toolbar {' + floating + recording + '}; Toolbar', {});
    const toolbar = new Toolbar();
    toolbar._ui = {_panel: {visible: true, get_preferred_height: () => [0, 150]}};
    toolbar._monitorPlacement = {monitor: monitors[1]};
    let position;
    const actor = {
        get_parent: () => toolbar._ui,
        get_preferred_width: () => [0, 600], get_preferred_height: () => [0, 80],
        set_position(x, y) { position = {x, y}; },
    };
    toolbar._positionCaptureToolbar(actor);
    assert.equal(position.x, -1580);
    assert.ok(position.y >= -360 && position.y + 80 <= 1080);
    toolbar._editContainer = actor;
    toolbar._setRecordingToolbarPosition();
    assert.equal(position.x, -1580);
    assert.ok(position.y >= -360 && position.y + 80 <= 1080);
});
