import assert from 'node:assert/strict';
import test from 'node:test';

import {
    computeOverlayRect,
    computeScaledDimensions,
    recordingExtension,
    shellMajorVersion,
} from '../usr/share/gnome-shell/extensions/big-shot@communitybig.org/lib/core.js';

test('scales area dimensions and keeps encoder-safe even values', () => {
    assert.deepEqual(computeScaledDimensions(1001, 701, 0.75), {
        width: 750,
        height: 526,
    });
    assert.deepEqual(computeScaledDimensions(640, 480, 0.5), {
        width: 320,
        height: 240,
    });
    assert.equal(computeScaledDimensions(0, 480, 0.75), null);
});

test('keeps recording controls outside the drawing overlay on every edge', () => {
    assert.deepEqual(computeOverlayRect(1920, 1080,
        { x: 0, y: 0, width: 1920, height: 40 }, true),
    { x: 0, y: 40, width: 1920, height: 1040 });
    assert.deepEqual(computeOverlayRect(1920, 1080,
        { x: 0, y: 1040, width: 1920, height: 40 }, true),
    { x: 0, y: 0, width: 1920, height: 1040 });
    assert.deepEqual(computeOverlayRect(1920, 1080,
        { x: 0, y: 0, width: 48, height: 1080 }, true),
    { x: 48, y: 0, width: 1872, height: 1080 });
    assert.deepEqual(computeOverlayRect(1920, 1080,
        { x: 1872, y: 0, width: 48, height: 1080 }, true),
    { x: 0, y: 0, width: 1872, height: 1080 });
});

test('detects native recording extension safely', () => {
    assert.equal(recordingExtension('/tmp/video.webm'), 'webm');
    assert.equal(recordingExtension('/tmp/video.MP4'), 'mp4');
    assert.equal(recordingExtension('/tmp/video.undefined'), 'webm');
    assert.equal(recordingExtension(null), 'webm');
});

test('parses the shell major version defensively', () => {
    assert.equal(shellMajorVersion('46.0'), 46);
    assert.equal(shellMajorVersion('50.4'), 50);
    assert.equal(shellMajorVersion('49.rc'), 49);
    assert.equal(shellMajorVersion('unknown'), 0);
    assert.equal(shellMajorVersion(undefined), 0);
});
