import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const extensionPath =
    'usr/share/gnome-shell/extensions/big-shot@bigcommunity.org/extension.js';

test('critical recording contracts remain wired', async () => {
    const source = await readFile(extensionPath, 'utf8');
    assert.match(source, /await this\._detectPipelines\(\)/);
    assert.match(source, /this\._activeEnableSerial !== enableSerial/);
    assert.match(source, /defaultPipeline: true/);
    assert.match(source, /\{ width, height \}/);
    assert.doesNotMatch(source, /proc\.wait\(null\)/);
});

test('window recording updates its area indicator', async () => {
    const source = await readFile(extensionPath, 'utf8');
    const start = source.indexOf('async _startWindowScreencast(ui)');
    const end = source.indexOf('\n    _unpatchScreencast()', start);
    const method = source.slice(start, end);

    assert.ok(start >= 0 && end > start);
    assert.match(method,
        /_screencastAreaIndicator\?\.setSelectionRect\(x, y, width, height\)/);
    assert.ok(method.indexOf('setSelectionRect') < method.indexOf('ui.close(true)'));
});
