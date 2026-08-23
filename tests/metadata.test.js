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
const packageBuildPath = path.join('pkgbuild', 'PKGBUILD');

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

test('distribution preserves compatible licensing and upstream attribution', async () => {
    const [license, legacyLicense, notice, packageManifest, packageLock,
        packageBuild, bundleBuild] =
        await Promise.all([
            readFile('LICENSE', 'utf8'),
            readFile('LICENSE.MIT', 'utf8'),
            readFile('NOTICE', 'utf8'),
            readFile('package.json', 'utf8'),
            readFile('package-lock.json', 'utf8'),
            readFile(packageBuildPath, 'utf8'),
            readFile(path.join('scripts', 'build-gnome-extension.sh'), 'utf8'),
        ]);

    assert.match(license, /GNU GENERAL PUBLIC LICENSE/);
    assert.match(license, /Version 2, June 1991/);
    assert.match(legacyLicense, /MIT License/);
    assert.match(notice, /WSID\/gnome-shell-screencast-extra-feature/);
    assert.match(notice, /GPL-2\.0-or-later/);
    assert.equal(JSON.parse(packageManifest).license, 'GPL-2.0-or-later');
    assert.equal(JSON.parse(packageLock).packages[''].license,
        'GPL-2.0-or-later');
    assert.match(packageBuild, /license=\('GPL-2\.0-or-later'\)/);
    assert.match(bundleBuild, /--extra-source=NOTICE/);
    assert.match(bundleBuild, /--extra-source=LICENSE\.MIT/);
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
