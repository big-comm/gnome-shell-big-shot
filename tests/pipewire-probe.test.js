import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

test('synthetic PipeWire probe rejects unsafe arguments and cleans up failures', () => {
    const result = spawnSync('python3', ['-B', 'tests/pipewire_probe_test.py'], {
        encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
});
