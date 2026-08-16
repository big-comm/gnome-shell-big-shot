import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const uuid = 'big-shot@communitybig.org';
const extensionDir = path.join(
    'usr', 'share', 'gnome-shell', 'extensions', uuid);
const metadataPath = path.join(extensionDir, 'metadata.json');
const packageInstallPath = path.join('pkgbuild', 'pkgbuild.install');

test('metadata identity and declarations stay consistent', async () => {
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));

    assert.equal(metadata.uuid, uuid);
    assert.equal(path.basename(extensionDir), metadata.uuid);
    assert.equal(metadata['gettext-domain'], metadata.uuid);
    assert.match(metadata.description, /clipboard/i);
    assert.match(metadata.url, /^https:\/\//);
});

test('metadata declares stable GNOME Shell releases', async () => {
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));

    assert.ok(Array.isArray(metadata['shell-version']));
    assert.ok(metadata['shell-version'].length > 0);
    for (const version of metadata['shell-version'])
        assert.match(version, /^\d+$/);
});

test('package migration removes only the legacy system identity', async t => {
    const source = await readFile(packageInstallPath, 'utf8');
    const legacyUuid = `big-shot@${'bigcommunity.org'}`;
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'big-shot-migration-'));
    const extensionsDir = path.join(
        rootDir, 'usr', 'share', 'gnome-shell', 'extensions');
    const legacyDir = path.join(extensionsDir, legacyUuid);
    const currentDir = path.join(extensionsDir, uuid);

    t.after(() => rm(rootDir, { recursive: true, force: true }));

    assert.match(source, new RegExp(
        `/usr/share/gnome-shell/extensions/${legacyUuid.replace('.', '\\.')}`));
    assert.match(source, /removeLegacyExtension/);
    assert.doesNotMatch(source, /gsettings|gnome-extensions/);

    await mkdir(legacyDir, { recursive: true });
    await mkdir(currentDir, { recursive: true });
    await execFileAsync('bash', [
        '-c', 'source "$1"; removeLegacyExtension "$2"',
        'bash', packageInstallPath, rootDir,
    ]);

    await assert.rejects(access(legacyDir));
    await access(currentDir);
});
