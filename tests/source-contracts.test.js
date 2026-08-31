import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const extensionPath =
    'usr/share/gnome-shell/extensions/big-shot@communitybig.org/extension.js';
const partsDir =
    'usr/share/gnome-shell/extensions/big-shot@communitybig.org/parts';

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

test('dependency loading starts only from the enabled lifecycle', async () => {
    const source = await readFile(extensionPath, 'utf8');
    const classStart = source.indexOf('export default class BigShotExtension');
    const moduleScope = source.slice(0, classStart);
    const scheduleStart = source.indexOf('    _scheduleDeferredEnable(');
    const runStart = source.indexOf('    async _runDeferredEnable(', scheduleStart);
    const scheduleMethods = source.slice(scheduleStart, runStart);
    const disableStart = source.indexOf('    disable() {', runStart);
    const disableEnd = source.indexOf('    _createParts() {', disableStart);
    const disableMethod = source.slice(disableStart, disableEnd);

    assert.ok(classStart >= 0 && scheduleStart > classStart);
    assert.doesNotMatch(moduleScope, /layoutManager\.connect\(/);
    assert.doesNotMatch(source, /heavyDepsReady/);
    assert.match(source, /await loadHeavyDeps\(\)/);
    assert.match(scheduleMethods, /'startup-complete'/);
    assert.match(scheduleMethods, /this\._startupCompleteId/);
    assert.match(disableMethod, /this\._disconnectStartupComplete\(\)/);
    for (const field of [
        '_toolbar', '_annotation', '_videoAnnotation', '_magnifier', '_audio',
        '_framerate', '_downsize', '_indicator', '_webcam',
        '_availableElements', '_gpuVendors', '_currentSegmentPath',
    ]) {
        assert.match(disableMethod, new RegExp(`this\\.${field} = null`));
    }
    assert.doesNotMatch(source, /PartQuickStop|partquickstop/);
});

test('extension deferred callbacks are centrally owned', async () => {
    const source = await readFile(extensionPath, 'utf8');
    const helpersStart = source.indexOf('    _addIdle(');
    const helpersEnd = source.indexOf('    disable() {', helpersStart);
    const helpers = source.slice(helpersStart, helpersEnd);
    const outsideHelpers = source.slice(0, helpersStart) + source.slice(helpersEnd);
    const disableEnd = source.indexOf('    _forceEnableScreencast()', helpersEnd);
    const disableMethod = source.slice(helpersEnd, disableEnd);

    assert.ok(helpersStart >= 0 && helpersEnd > helpersStart);
    assert.match(helpers, /this\._sourceIds\?\.delete\(id\)/);
    assert.match(helpers, /_cancelPendingDelays\(\)/);
    assert.doesNotMatch(outsideHelpers,
        /GLib\.(?:idle_add|timeout_add|source_remove)\(/);
    assert.match(disableMethod, /this\._cancelPendingDelays\(\)/);
    assert.match(disableMethod, /this\._clearSources\(\)/);
    assert.match(source, /this\._renameFinalizeId = this\._addTimeout\(500/);
});

test('external subprocesses are owned, bounded, and cancelled on disable', async () => {
    const source = await readFile(extensionPath, 'utf8');
    const runStart = source.indexOf('    async _runSubprocess(');
    const disableStart = source.indexOf('    disable() {', runStart);
    const subprocessHelpers = source.slice(runStart, disableStart);
    const disableEnd = source.indexOf('    _forceEnableScreencast()', disableStart);
    const disableMethod = source.slice(disableStart, disableEnd);
    const mergeStart = source.indexOf('    async _mergeSegments(');
    const mergeEnd = source.indexOf('    _cleanupMergedSegments(', mergeStart);
    const mergeMethod = source.slice(mergeStart, mergeEnd);

    assert.ok(runStart >= 0 && disableStart > runStart);
    assert.equal(source.match(/Gio\.Subprocess\.new\(/g)?.length, 1);
    assert.equal(source.match(/communicate_utf8_async\(/g)?.length, 1);
    assert.match(subprocessHelpers, /registry\.add\(task\)/);
    assert.match(subprocessHelpers, /registry\.delete\(task\)/);
    assert.match(subprocessHelpers, /task\.cancelled = true/);
    assert.match(subprocessHelpers, /task\.proc\.force_exit\(\)/);
    assert.doesNotMatch(subprocessHelpers, /cancellable\.cancel\(\)/);
    assert.match(disableMethod, /this\._cancelSubprocesses\(\)/);
    assert.match(disableMethod, /this\._subprocesses = null/);
    assert.match(source, /const SUBPROCESS_PROBE_CONCURRENCY = 4/);
    assert.match(source,
        /Math\.min\(SUBPROCESS_PROBE_CONCURRENCY, names\.length\)/);
    assert.match(mergeMethod, /await this\._runSubprocess\(/);
    assert.match(mergeMethod, /this\._activeEnableSerial !== enableSerial/);
});

test('runtime logging contains no routine success output', async () => {
    const source = await readFile(extensionPath, 'utf8');

    assert.doesNotMatch(source, /console\.(?:log|debug|info)\(/);
    // Shexli (EGO-A-004) caps ungated console calls at 5. Every failure path
    // goes through warn()/fail(), so console appears only in those two.
    assert.equal(source.match(/console\./g)?.length, 2);
    assert.match(source, /function warn\(message\) \{\n    console\.warn\(`\[Big Shot\] \$\{message\}`\);/);
    assert.match(source, /function fail\(message\) \{\n    console\.error\(`\[Big Shot\] \$\{message\}`\);/);
});

test('temporary images stay inside private directories', async () => {
    const [extension, actions] = await Promise.all([
        readFile(extensionPath, 'utf8'),
        readFile(`${partsDir}/../drawing/actions.js`, 'utf8'),
    ]);

    assert.doesNotMatch(extension, /GLib\.get_tmp_dir\(\)/);
    assert.doesNotMatch(actions, /GLib\.get_tmp_dir\(\)/);
    assert.match(extension, /GLib\.dir_make_tmp\('big-shot-XXXXXX'\)/);
    assert.match(extension, /this\._cleanupTempDir\(\)/);
    assert.match(actions, /GLib\.dir_make_tmp\('big-shot-zoom-XXXXXX'\)/);
    assert.match(actions, /GLib\.rmdir\(tmpDir\)/);
});

test('OCR never installs system packages', async () => {
    const [extension, toolbar] = await Promise.all([
        readFile(extensionPath, 'utf8'),
        readFile(`${partsDir}/parttoolbar.js`, 'utf8'),
    ]);

    assert.doesNotMatch(extension, /pkexec|pacman|--noconfirm/);
    assert.doesNotMatch(extension, /_installOcrSupport|_ocrInstallPromise/);
    assert.doesNotMatch(extension, /\/usr\/bin\/tesseract/);
    assert.doesNotMatch(toolbar, /confirmOcrInstall|_ocrInstallPopup/);
    assert.match(extension, /GLib\.find_program_in_path\('tesseract'\)/);
    assert.match(extension,
        /selectedLanguages\.every\(language => languages\.includes\(language\)\)/);
    assert.match(extension, /Install Tesseract and its language packs with your package manager/);
    assert.match(toolbar, /this\._actionCallback\?\.\('ocr-unavailable'\)/);
});

test('screenshot storage restores the native notification contract', async () => {
    const source = await readFile(extensionPath, 'utf8');
    const storeStart = source.indexOf('    _storeScreenshotBytes(');
    const storeEnd = source.indexOf('    _unpatchSaveScreenshot()', storeStart);
    const storageMethods = source.slice(storeStart, storeEnd);
    const disableStart = source.indexOf('    disable() {');
    const disableEnd = source.indexOf('    _forceEnableScreencast()', disableStart);
    const disableMethod = source.slice(disableStart, disableEnd);

    assert.ok(storeStart >= 0 && storeEnd > storeStart);
    assert.match(storageMethods,
        /this\._showScreenshotNotification\(pixbuf, time, file, disableSaveToDisk\)/);
    assert.match(storageMethods, /St\.ImageContent\.new_with_preferred_size/);
    assert.match(storageMethods, /pixbuf\.get_has_alpha\(\)/);
    assert.match(storageMethods, /pixbuf\.add_alpha\(false, 0, 0, 0\)/);
    assert.match(storageMethods, /iconPixbuf\.read_pixel_bytes\(\)/);
    assert.match(storageMethods, /Cogl\.PixelFormat\.RGBA_8888/);
    assert.match(storageMethods, /gicon: content/);
    assert.match(storageMethods, /isTransient: true/);
    assert.match(storageMethods, /notification\.addAction\(_\('Show in Files'\)/);
    assert.match(storageMethods, /notification\.connect\('activated'/);
    assert.match(storageMethods, /Gio\.app_info_launch_default_for_uri/);
    assert.match(disableMethod, /this\._notificationSource\?\.destroy\(\)/);
});

test('portal requests are subscribed early and cleaned on disable', async () => {
    const source = await readFile(extensionPath, 'utf8');
    const portalStart = source.indexOf('    _createPortalRequest(');
    const portalEnd = source.indexOf('    _showNotification(', portalStart);
    const portalMethods = source.slice(portalStart, portalEnd);
    const openStart = portalMethods.indexOf('    _openSaveDialog(');
    const openMethod = portalMethods.slice(openStart);
    const disableStart = source.indexOf('    disable() {');
    const disableEnd = source.indexOf('    _forceEnableScreencast()', disableStart);
    const disableMethod = source.slice(disableStart, disableEnd);

    assert.ok(portalStart >= 0 && portalEnd > portalStart);
    assert.match(portalMethods, /'handle_token': new GLib\.Variant\('s', request\.token\)/);
    assert.ok(openMethod.indexOf('_subscribePortalResponse(request, request.requestPath)') <
        openMethod.indexOf('request.bus.call('));
    assert.match(portalMethods, /signal_unsubscribe\(request\.subscriptionId\)/);
    assert.match(portalMethods, /request\.cancellable\.cancel\(\)/);
    assert.match(portalMethods,
        /Gio\.File\.new_for_path\(request\.tmpPath\)\.delete\(null\)/);
    assert.match(portalMethods, /this\._addTimeout\(300000/);
    assert.match(disableMethod, /this\._cancelPortalRequests\(\)/);
});

test('recording finalization waits for stop completion', async () => {
    const source = await readFile(extensionPath, 'utf8');
    const stopStart = source.indexOf('    _stopScreencastProxyAsync(');
    const stopEnd = source.indexOf('    _setScreencastInProgress(', stopStart);
    const stopMethods = source.slice(stopStart, stopEnd);
    const watcherStart = source.indexOf('    _watchForFinalStop()');
    const watcherEnd = source.indexOf('    _onFinalStop()', watcherStart);
    const watcher = source.slice(watcherStart, watcherEnd);

    assert.ok(stopStart >= 0 && stopEnd > stopStart);
    assert.match(stopMethods, /this\._trackRecordingStop\(/);
    assert.match(stopMethods, /Promise\.resolve\(result\)\.finally/);
    assert.match(stopMethods, /this\._stopCompletions\.delete\(completion\)/);
    assert.match(stopMethods, /this\._removeSource\(this\._stopWatcherId\)/);
    assert.match(watcher, /this\._stopCompletions\.size > 0/);
});

test('pause is unavailable when ffmpeg cannot merge segments', async () => {
    const [extension, indicator] = await Promise.all([
        readFile(extensionPath, 'utf8'),
        readFile(`${partsDir}/partindicator.js`, 'utf8'),
    ]);
    const pauseStart = extension.indexOf('    async pauseRecording()');
    const pauseEnd = extension.indexOf('    async resumeRecording()', pauseStart);
    const pauseMethod = extension.slice(pauseStart, pauseEnd);
    const mergeStart = extension.indexOf('    async _mergeSegments(');
    const mergeEnd = extension.indexOf('    _cleanupMergedSegments(', mergeStart);
    const mergeMethod = extension.slice(mergeStart, mergeEnd);

    assert.match(extension, /ffmpegPath: GLib\.find_program_in_path\('ffmpeg'\)/);
    assert.match(pauseMethod, /if \(!this\._recordingSession\.ffmpegPath\)/);
    assert.match(mergeMethod, /session\.ffmpegPath/);
    assert.doesNotMatch(mergeMethod, /\n\s*'ffmpeg',/);
    assert.match(indicator, /this\._panelButton\.reactive = this\._canPause/);
});

test('remaining user-visible labels use gettext and logical alignment', async () => {
    const [extension, toolbar, webcam, indicator] = await Promise.all([
        readFile(extensionPath, 'utf8'),
        readFile(`${partsDir}/parttoolbar.js`, 'utf8'),
        readFile(`${partsDir}/partwebcam.js`, 'utf8'),
        readFile(`${partsDir}/partindicator.js`, 'utf8'),
    ]);

    for (const label of [
        'None', 'Circle', 'Oval', 'Soft', 'Spot', 'Ornate', 'Checker', 'Neon',
    ]) {
        assert.match(toolbar, new RegExp(`_\\('${label}'\\)`));
        assert.match(webcam, new RegExp(`_\\('${label}'\\)`));
    }
    assert.match(toolbar, /_\('Software %s'\)/);
    assert.match(toolbar, /_\('%s Low-Power'\)/);
    assert.match(webcam, /_\('Camera %d'\)\.format\(i\)/);
    assert.match(extension, /_\('PNG Images'\)/);
    assert.match(extension, /_\('GNOME default'\)/);
    assert.match(indicator, /_\('Pause recording'\)/);
    assert.match(indicator, /_\('Screen recording'\)/);
    assert.doesNotMatch(toolbar, /text-align:\s*(?:left|right)/);
});

test('zoom captions honor toolbar font controls without resizing the toolbar', async () => {
    const [actions, toolbar, stylesheet] = await Promise.all([
        readFile(`${partsDir}/../drawing/actions.js`, 'utf8'),
        readFile(`${partsDir}/parttoolbar.js`, 'utf8'),
        readFile(`${partsDir}/../stylesheet.css`, 'utf8'),
    ]);

    assert.match(actions, /this\.options\.size \* 5 \* scale/);
    assert.doesNotMatch(actions, /this\.destH \* m/);
    assert.match(toolbar, /toolId === 'text' \|\| toolId === 'zoom'/);
    assert.match(stylesheet,
        /\.big-shot-edit-tool-btn \{[^}]*border: 1px solid transparent;/s);
    assert.match(stylesheet,
        /\.big-shot-edit-tool-btn:checked \{[^}]*border: 1px solid rgba/s);
});

test('async capture and recording continuations reject stale enables', async () => {
    const source = await readFile(extensionPath, 'utf8');
    const captureStart = source.indexOf('    async _captureAnnotatedBytes(');
    const captureEnd = source.indexOf('    _getInstalledTessdataLanguages(', captureStart);
    const captureMethod = source.slice(captureStart, captureEnd);
    const actionStart = source.indexOf('    async _handleAction(');
    const actionEnd = source.indexOf('    _createPortalRequest(', actionStart);
    const actionMethod = source.slice(actionStart, actionEnd);
    const castStart = source.indexOf('    async _screencastCommonAsync(');
    const castEnd = source.indexOf('    async _startDefaultRecording(', castStart);
    const castMethod = source.slice(castStart, castEnd);
    const resumeStart = source.indexOf('    async _startNextSegment(');
    const resumeEnd = source.indexOf('    _watchForFinalStop()', resumeStart);
    const resumeMethods = source.slice(resumeStart, resumeEnd);

    for (const method of [captureMethod, actionMethod, castMethod, resumeMethods]) {
        assert.match(method, /const enableSerial = this\._activeEnableSerial/);
        assert.match(method, /this\._activeEnableSerial !== enableSerial/);
    }
    assert.match(castMethod, /const stopMethod = this\._origStopScreencastAsync/);
    assert.match(castMethod, /this\._stopStaleScreencast\(stopMethod\)/);
    assert.match(resumeMethods, /this\._stopStaleScreencast\(stopMethod\)/);
});

test('toolbar deferred callbacks are owned and stage-safe', async () => {
    const [base, toolbar, indicator, magnifier, webcam] = await Promise.all([
        readFile(`${partsDir}/partbase.js`, 'utf8'),
        readFile(`${partsDir}/parttoolbar.js`, 'utf8'),
        readFile(`${partsDir}/partindicator.js`, 'utf8'),
        readFile(`${partsDir}/partmagnifier.js`, 'utf8'),
        readFile(`${partsDir}/partwebcam.js`, 'utf8'),
    ]);

    assert.match(base, /this\._sourceIds = new Set\(\)/);
    assert.match(base, /_addIdle\(/);
    assert.match(base, /_addTimeout\(/);
    assert.match(base, /this\._sourceIds\.clear\(\)/);
    const baseHelpersEnd = base.indexOf('// PartUI');
    assert.doesNotMatch(base.slice(baseHelpersEnd),
        /GLib\.(?:idle_add|timeout_add|source_remove)\(/);
    assert.doesNotMatch(toolbar,
        /GLib\.(?:idle_add|timeout_add|source_remove)\(/);
    for (const part of [indicator, magnifier, webcam]) {
        assert.doesNotMatch(part,
            /GLib\.(?:idle_add|timeout_add|source_remove)\(/);
    }
    assert.match(toolbar, /_actorIsOnStage\(actor\)/);
    assert.match(toolbar, /this\._actorIsOnStage\(tooltip\)/);
    assert.match(toolbar, /this\._removeSource\(this\._tooltipIdleId\)/);

    const destroyStart = toolbar.indexOf('    _destroyFloatingActor(actor) {');
    const destroyEnd = toolbar.indexOf('\n    /**', destroyStart);
    const destroyMethod = toolbar.slice(destroyStart, destroyEnd);
    assert.doesNotMatch(destroyMethod, /Main\.layoutManager\.removeChrome\(/);
    assert.match(destroyMethod, /actor\.destroy\(\)/);

    const hideStart = toolbar.indexOf('    _hideTooltip() {');
    const hideEnd = toolbar.indexOf('    _destroyTooltip() {', hideStart);
    const hideMethod = toolbar.slice(hideStart, hideEnd);
    assert.match(hideMethod, /this\._tooltip\?\.hide\(\)/);
    assert.doesNotMatch(hideMethod, /destroy\(\)/);
    assert.match(toolbar, /this\._destroyTooltip\(\)/);
});

test('drawing overlay owns and cancels deferred callbacks', async () => {
    const overlay = await readFile(
        'usr/share/gnome-shell/extensions/big-shot@communitybig.org/drawing/overlay.js',
        'utf8');
    const helpersStart = overlay.indexOf('    _addIdle(');
    const helpersEnd = overlay.indexOf('    _getNextNumber(', helpersStart);
    const outsideHelpers = overlay.slice(0, helpersStart) + overlay.slice(helpersEnd);
    const destroyStart = overlay.indexOf('    destroy() {');
    const destroyMethod = overlay.slice(destroyStart);

    assert.ok(helpersStart >= 0 && helpersEnd > helpersStart);
    assert.doesNotMatch(outsideHelpers,
        /GLib\.(?:idle_add|timeout_add|source_remove)\(/);
    assert.match(overlay, /if \(!await this\._waitForIdle\(\)\)/);
    assert.match(destroyMethod, /this\._destroyed = true/);
    assert.match(destroyMethod, /this\._cancelSources\(\)/);
});

test('screenshot open restores recording state after synchronous failures', async () => {
    const source = await readFile(extensionPath, 'utf8');
    const patchStart = source.indexOf('    _patchScreencast()');
    const patchEnd = source.indexOf('    async _startWindowScreencast(', patchStart);
    const patchMethod = source.slice(patchStart, patchEnd);

    assert.ok(patchStart >= 0 && patchEnd > patchStart);
    assert.match(patchMethod,
        /this\._screencastInProgress = false;\s*try \{\s*return ext\._origOpen\.call\(this, mode\);\s*\} finally \{\s*this\._screencastInProgress = saved;/s);
});

test('toolbar font cache is released on disable', async () => {
    const [source, toolbar] = await Promise.all([
        readFile(extensionPath, 'utf8'),
        readFile(`${partsDir}/parttoolbar.js`, 'utf8'),
    ]);
    const disableStart = source.indexOf('    disable() {');
    const disableEnd = source.indexOf('    _forceEnableScreencast()', disableStart);
    const disableMethod = source.slice(disableStart, disableEnd);

    assert.match(toolbar, /export function clearFontCache\(\)/);
    assert.match(source, /clearToolbarFontCache = toolbarMod\.clearFontCache/);
    assert.match(disableMethod, /clearToolbarFontCache\?\.\(\)/);
});

test('shell API generations are selected by version, not assumed', async () => {
    const source = await readFile(extensionPath, 'utf8');
    const notifyStart = source.indexOf('    _showScreenshotNotification(');
    const notifyEnd = source.indexOf('    _unpatchSaveScreenshot(', notifyStart);
    const notifyMethod = source.slice(notifyStart, notifyEnd);

    assert.ok(notifyStart >= 0 && notifyEnd > notifyStart);
    assert.match(source,
        /shellMajor = coreMod\.shellMajorVersion\(configMod\.PACKAGE_VERSION\)/);
    // StImageContent.set_bytes() gained a CoglContext in GNOME 48, and
    // ClutterActor:context only exists from 47 on. Both must stay behind the
    // version guard so 46/47 keep the ClutterImage arity.
    assert.match(notifyMethod, /if \(shellMajor >= 48\) \{/);
    assert.doesNotMatch(
        notifyMethod.slice(0, notifyMethod.indexOf('if (shellMajor >= 48)')),
        /global\.stage\.context/);
});

test('widget properties stay available on every declared shell version', async () => {
    const sources = await Promise.all([
        'extension.js', 'drawing/overlay.js', 'drawing/actions.js',
        'parts/partaudio.js', 'parts/partbase.js', 'parts/partdownsize.js',
        'parts/partframerate.js', 'parts/partindicator.js',
        'parts/partmagnifier.js', 'parts/parttoolbar.js',
        'parts/partvideoannotation.js', 'parts/partwebcam.js',
    ].map(name => readFile(
        `usr/share/gnome-shell/extensions/big-shot@communitybig.org/${name}`,
        'utf8')));

    // St.BoxLayout:orientation landed in GNOME 48; `vertical` spans 46-50.
    for (const source of sources)
        assert.doesNotMatch(source, /orientation:\s*Clutter\.Orientation/);
});

test('subprocess output is read by shape, and GPU detection never gates on one tool', async () => {
    const source = await readFile(extensionPath, 'utf8');
    const runStart = source.indexOf('    async _runSubprocess(');
    const runEnd = source.indexOf('    _cancelSubprocesses(', runStart);
    const runMethod = source.slice(runStart, runEnd);

    assert.ok(runStart >= 0 && runEnd > runStart);
    // GJS resolves the promisified call to [stdout, stderr]. Destructuring a
    // leading boolean that is not there reads stderr as stdout and yields ""
    // with no error, which silently disabled GPU detection and OCR.
    assert.doesNotMatch(runMethod, /const \[, stdout, stderr\] = await/);
    assert.match(runMethod, /typeof reply\[0\] === 'boolean'/);

    const gpuStart = source.indexOf('    async _detectGpuVendors()');
    const gpuEnd = source.indexOf('    async _checkGstreamerElement(', gpuStart);
    const gpuMethod = source.slice(gpuStart, gpuEnd);

    assert.ok(gpuStart >= 0 && gpuEnd > gpuStart);
    // sysfs first, lspci second, and never UNKNOWN — UNKNOWN hides every
    // hardware encoder, so an undetected GPU must probe them all instead.
    assert.match(gpuMethod, /_detectGpuVendorsFromSysfs\(\)/);
    assert.match(gpuMethod, /await this\._detectGpuVendorsFromLspci\(\)/);
    assert.doesNotMatch(gpuMethod, /GpuVendor\.UNKNOWN/);
    assert.match(gpuMethod,
        /return \[GpuVendor\.NVIDIA, GpuVendor\.AMD, GpuVendor\.INTEL\]/);
});

test('recordings are pinned to the requested constant frame rate', async () => {
    const source = await readFile(extensionPath, 'utf8');
    const makeStart = source.indexOf('    _makePipelineString(');
    const makeEnd = source.indexOf('\n}', makeStart);
    const makeMethod = source.slice(makeStart, makeEnd);

    assert.ok(makeStart >= 0 && makeEnd > makeStart);
    // The service only sets max-framerate, so PipeWire emits frames only on
    // change. videorate fills the gaps to honour the selected FPS.
    assert.match(makeMethod, /videorate skip-to-first=true/);
    assert.match(makeMethod, /video\/x-raw,framerate=\$\{framerateCaps\}/);
    // Scale before rate, so duplicated frames are not scaled twice.
    assert.ok(makeMethod.indexOf('videoscale') < makeMethod.indexOf('videorate'));
    // videorate must be probed like every other element it relies on.
    assert.match(makeMethod, /this\._availableElements\?\.has\('videorate'\)/);
    assert.match(source, /elementNames\.add\('videorate'\)/);
    // The dead placeholder is gone; the stage is built explicitly.
    assert.doesNotMatch(source, /FRAMERATE_CAPS/);
});
