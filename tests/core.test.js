import assert from 'node:assert/strict';
import test from 'node:test';

import {
    GPU_PROBED_ENCODERS,
    computeOverlayRect,
    computeScaledDimensions,
    gstRegistryPath,
    hiddenGpuEncoders,
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

test('flags GPU encoders hidden by the registry only when no GPU pipeline works', () => {
    const nvenc264 = { elements: ['videoconvert', 'nvh264enc', 'h264parse'] };
    const nvenc265 = { elements: ['videoconvert', 'nvh265enc', 'h265parse'] };
    const base = ['videoconvert', 'h264parse', 'h265parse'];

    // Stale registry: nvcodec cached without its encoders.
    assert.deepEqual(hiddenGpuEncoders([nvenc264, nvenc265], new Set(base)),
        ['nvh264enc', 'nvh265enc']);
    // One working GPU pipeline is enough; a missing HEVC variant is no symptom.
    assert.deepEqual(hiddenGpuEncoders([nvenc264, nvenc265],
        new Set([...base, 'nvh264enc'])), []);
    // No GPU pipeline candidates (vendor not present).
    assert.deepEqual(hiddenGpuEncoders([], new Set(base)), []);
    // Plain elements are never treated as GPU-probed.
    assert.deepEqual(hiddenGpuEncoders([{ elements: ['x264enc'] }], new Set()), []);
});

test('every GPU-probed encoder maps to the plugin that registers it', () => {
    for (const [element, plugin] of Object.entries(GPU_PROBED_ENCODERS)) {
        const expected = element.startsWith('nv') ? 'nvcodec'
            : element.startsWith('vaapi') ? 'vaapi' : 'va';
        assert.equal(plugin, expected, element);
    }
});

test('resolves the GStreamer registry path like gstregistry.c', () => {
    const env = vars => name => vars[name] ?? null;
    assert.equal(gstRegistryPath(env({}), '/home/u/.cache', 'x86_64'),
        '/home/u/.cache/gstreamer-1.0/registry.x86_64.bin');
    assert.equal(gstRegistryPath(env({ GST_REGISTRY: '/r.bin' }), '/c', 'x86_64'),
        '/r.bin');
    assert.equal(gstRegistryPath(
        env({ GST_REGISTRY: '/r.bin', GST_REGISTRY_1_0: '/r10.bin' }), '/c', 'x86_64'),
    '/r10.bin');
    assert.equal(gstRegistryPath(env({}), '/c', null), null);
    assert.equal(gstRegistryPath(env({}), null, 'x86_64'), null);
});
