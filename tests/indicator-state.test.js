import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(
    'usr/share/gnome-shell/extensions/big-shot@communitybig.org/parts/partindicator.js', 'utf8');
const Indicator = vm.runInNewContext(source.replace(/^import .*;\n/gm, '')
    .replace('export class PartIndicator', 'class PartIndicator') + '\nPartIndicator;',
{PartUI: class {}, _: text => text});

function fixture() {
    const indicator = new Indicator({}, {});
    const style = () => ({
        classes: new Set(),
        add_style_class_name(value) { this.classes.add(value); },
        remove_style_class_name(value) { this.classes.delete(value); },
    });
    indicator._pauseButton = {};
    indicator._stopButton = {};
    indicator._stopIcon = {};
    indicator._stopText = {};
    indicator._icon = style();
    indicator._timerLabel = style();
    indicator._canPause = true;
    return indicator;
}

test('indicator preserves recording, paused, and resumed controls', () => {
    const indicator = fixture();
    indicator._updatePanelButton();
    assert.equal(indicator._pauseButton.reactive, true);
    assert.equal(indicator._pauseButton.accessible_name, 'Pause recording');
    assert.equal(indicator._icon.icon_name, 'media-playback-pause-symbolic');
    assert.equal(indicator._stopButton.accessible_name, 'Stop recording');
    indicator._isPaused = true;
    indicator._updatePanelButton();
    assert.equal(indicator._pauseButton.accessible_name, 'Resume recording');
    assert.equal(indicator._icon.icon_name, 'media-playback-start-symbolic');
    assert.equal(indicator._timerLabel.classes.has('big-shot-paused-timer'), true);
    indicator._isPaused = false;
    indicator._updatePanelButton();
    assert.equal(indicator._timerLabel.classes.has('big-shot-paused-timer'), false);
});

test('busy and failed stops disable pause and expose explicit recovery', () => {
    const indicator = fixture();
    indicator.onStopping();
    assert.equal(indicator._pauseButton.reactive, false);
    assert.equal(indicator._stopText.visible, false);
    indicator.onStopFailed();
    assert.equal(indicator._pauseButton.reactive, false);
    assert.match(indicator._stopButton.accessible_name, /Force stop recording service/);
    assert.equal(indicator._stopIcon.icon_name, 'process-stop-symbolic');
    assert.equal(indicator._stopText.visible, true);
});

test('indicator updates tolerate controls already destroyed', () => {
    const indicator = new Indicator({}, {});
    assert.doesNotThrow(() => indicator._updatePanelButton());
});
