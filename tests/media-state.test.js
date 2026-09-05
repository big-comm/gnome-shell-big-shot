import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = 'usr/share/gnome-shell/extensions/big-shot@communitybig.org/';
const read = file => readFileSync(root + file, 'utf8');
const base = read('parts/partbase.js').replace(/^import .*;\n/gm, '').replaceAll('export ', '');
const audio = read('parts/partaudio.js').split('export class PartAudio')[1];
const webcam = read('parts/partwebcam.js').split('export class PartWebcam')[1];
const extension = read('extension.js');

class Actor {
    signals = new Map();
    _checked = false;
    connect(name, callback) {
        this.signals.set(name, [...this.signals.get(name) ?? [], callback]);
    }
    emit(name) { for (const callback of this.signals.get(name) ?? []) callback(); }
    get checked() { return this._checked; }
    set checked(value) {
        if (this._checked === value) return;
        this._checked = value;
        this.emit('notify::checked');
    }
    add_child() {}
    get_child() { return this; }
    open() {}
}

function fixture() {
    const context = {
        IconLabelButton: Actor, PixelConstraint: Actor,
        Gio: {FileIcon: Actor, ThemedIcon: Actor},
        Gvc: {MixerControl: Actor}, Screenshot: {Tooltip: Actor},
        WEBCAM_DEFAULT_WIDTH: 320, Gst: {}, _: text => text,
    };
    const classes = vm.runInNewContext(`${base}
        class PartAudio${audio}
        class PartWebcam${webcam}
        ({PartAudio, PartWebcam})`, context);
    const ui = Object.assign(new Actor(), {
        visible: true, _shotButton: new Actor(), _typeButtonContainer: new Actor(),
    });
    ui._shotButton.checked = true;
    const ext = {dir: new Actor(), _recordingState: 'idle'};
    ext._audio = new classes.PartAudio(ui, ext);
    ext._webcam = new classes.PartWebcam(ui, ext);
    let preview = false;
    ext._webcam._createOverlay = () => { preview = true; };
    ext._webcam._startPipeline = () => { ext._webcam._pipeline = {}; };
    ext._webcam._stopPipeline = () => { ext._webcam._pipeline = null; };
    ext._webcam._destroyOverlay = () => { preview = false; };
    ext._webcam.reparentForPreview = () => {};
    ext._webcam.reparentForRecording = () => {};
    const devices = [{id: 1}, {id: 2}];
    ext._audio.enumerateMicrophones = () => devices;
    const cameras = [{device: '/dev/video0'}, {device: '/dev/video2'}];
    ext._webcam.enumerateDevices = async () => cameras;
    const toolbar = ext._toolbar = {
        _micRow: {}, _maskRow: {}, _sizeRow: {}, _cameraRow: {},
        _selectedMicDevice: 2,
        populateMicrophones(list) {
            this._micRow.visible = list.length > 1;
            if (!this._micRow.visible) this._selectedMicDevice = null;
        },
        populateCameras(list) { this._cameraRow.visible = list.length > 1; },
        repositionVideoPanel() {},
    };
    const wire = (start, end) => vm.runInNewContext(
        `(function () {${extension.slice(extension.indexOf(start), extension.indexOf(end))}})`,
        {ui, warn: assert.fail}).call(ext);
    wire('        this._webcam.onWebcamToggled(', '        // Wire camera selection');
    wire('        this._audio.onMicToggled(', '        // Wire mic selection');
    wire("        this._webcamUIVisId = ui.connect(", '\n    }\n\n    _patchScreencast()');
    return {ui, ext, toolbar, preview: () => preview,
        cast: value => { ui._shotButton.checked = !value; },
        visible: value => { ui.visible = value; ui.emit('notify::visible'); }};
}

test('microphone selector returns with the checked button and selected device', () => {
    const f = fixture();
    f.cast(true);
    f.ext._audio._micButton.checked = true;
    assert.equal(f.toolbar._micRow.visible, true);
    f.visible(false);
    f.cast(false);
    assert.equal(f.toolbar._micRow.visible, false);
    assert.equal(f.ext._audio._micButton.checked, true);
    f.visible(true);
    f.cast(true);
    assert.equal(f.toolbar._micRow.visible, true);
    assert.equal(f.toolbar._selectedMicDevice, 2);
    f.ext._audio._micButton.checked = false;
    f.cast(false);
    f.cast(true);
    assert.equal(f.toolbar._micRow.visible, false);
});

test('webcam settings and preview return after close and mode changes', async () => {
    const f = fixture();
    f.cast(true);
    f.ext._webcam._webcamButton.checked = true;
    await Promise.resolve();
    assert.equal(f.preview(), true);
    assert.equal(f.toolbar._cameraRow.visible, true);
    f.visible(false);
    f.cast(false);
    assert.equal(f.preview(), false);
    assert.equal(f.ext._webcam._webcamButton.checked, true);
    assert.equal(f.toolbar._maskRow.visible, false);
    f.visible(true);
    assert.equal(f.preview(), false);
    f.cast(true);
    await Promise.resolve();
    assert.equal(f.preview(), true);
    for (const row of ['_maskRow', '_sizeRow', '_cameraRow'])
        assert.equal(f.toolbar[row].visible, true);
    f.cast(false);
    assert.equal(f.preview(), false);
    f.cast(true);
    assert.equal(f.preview(), true);
});

test('closing for recording preserves the webcam preview', () => {
    const f = fixture();
    f.cast(true);
    f.ext._webcam._webcamButton.checked = true;
    f.ext._recordingState = 'recording';
    f.visible(false);
    f.cast(false);
    assert.equal(f.preview(), true);
    assert.equal(f.ext._webcam.enabled, true);
});

test('late camera enumeration cannot reveal disabled camera settings', async () => {
    const f = fixture();
    f.cast(true);
    f.ext._webcam._webcamButton.checked = true;
    f.ext._webcam._webcamButton.checked = false;
    await Promise.resolve();
    assert.equal(f.toolbar._cameraRow.visible, false);
    assert.equal(f.preview(), false);
    f.ext._webcam._webcamButton.checked = true;
    f.cast(false);
    await Promise.resolve();
    assert.equal(f.toolbar._cameraRow.visible, false);
});

test('hidden capture UI cannot restart webcam preview', async () => {
    const f = fixture();
    f.cast(true);
    f.ext._webcam._webcamButton.checked = true;
    f.visible(false);
    await f.ext._webcam.startPreview();
    assert.equal(f.preview(), false);
});
