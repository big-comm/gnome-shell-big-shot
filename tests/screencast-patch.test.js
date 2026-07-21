import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const patchScript = path.resolve(
    'usr/share/libalpm/scripts/gnome-shell-big-shot-screencast-fix.sh');
const serviceSource = `#!/usr/bin/gjs -m
imports.package.init({
    name: 'org.gnome.Shell.Screencast',
});
print('service');
`;

async function fixture(probeBody) {
    const dir = await mkdtemp(path.join(tmpdir(), 'big-shot-patch-'));
    const target = path.join(dir, 'org.gnome.Shell.Screencast');
    const probe = path.join(dir, 'gjs-probe');
    await writeFile(target, serviceSource);
    await writeFile(probe, `#!/bin/sh\n${probeBody}\n`);
    await chmod(probe, 0o755);
    return { dir, target, probe };
}

function run(target, probe, action) {
    return spawnSync('bash', [patchScript, action], {
        encoding: 'utf8',
        env: {
            ...process.env,
            BIG_SHOT_SCREENCAST_TARGET: target,
            BIG_SHOT_GJS_BIN: probe,
        },
    });
}

test('patches only the expected Gst null failure and restores current backup', async () => {
    const { target, probe } = await fixture(
        "echo \"Expected type utf8 for Argument 'argv' but got type 'null'\" >&2; exit 1");
    const applied = run(target, probe, '--apply');
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(await readFile(target, 'utf8'), /Workaround GNOME 49 bug/);

    const removed = run(target, probe, '--remove');
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(await readFile(target, 'utf8'), serviceSource);
});

test('does not patch on unrelated probe failures', async () => {
    const { target, probe } = await fixture('echo unrelated >&2; exit 1');
    const result = run(target, probe, '--apply');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(target, 'utf8'), serviceSource);
    assert.match(result.stdout, /unrelated reason/);
});

test('does not restore a stale backup over an unpatched service', async () => {
    const { target, probe } = await fixture('exit 0');
    await writeFile(`${target}.big-shot-backup`, 'obsolete');
    const result = run(target, probe, '--remove');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(target, 'utf8'), serviceSource);
});
