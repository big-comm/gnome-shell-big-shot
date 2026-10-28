import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {computeScaledDimensions} from '../usr/share/gnome-shell/extensions/big-shot@communitybig.org/lib/core.js';

const source = readFileSync(
    'usr/share/gnome-shell/extensions/big-shot@communitybig.org/extension.js', 'utf8');

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
}

function fixture() {
    const events = [];
    const timers = new Map();
    const ui = {
        _screencastInProgress: true,
        _setScreencastInProgress(value) { this._screencastInProgress = value; },
        _showNotification: text => events.push(text),
    };
    const glib = {
        SOURCE_CONTINUE: true, SOURCE_REMOVE: false,
        Variant: class { constructor(_type, value) { this.value = value; } },
        VariantType: class {}, find_program_in_path: () => '/usr/bin/kill',
    };
    const bus = {
        pid: 42,
        call(...args) {
            const callback = args.at(-1);
            callback({call_finish: () => ({deep_unpack: () => [bus.pid]})}, {});
        },
    };
    const gio = {
        DBus: {session: bus}, DBusCallFlags: {NONE: 0},
        SubprocessFlags: {NONE: 0},
        Credentials: {new: () => ({get_unix_pid: () => 99})},
    };
    const {Extension, configs} = vm.runInNewContext(source
        .replace(/^import .*;\n/gm, '')
        .replace('let Gio = null;', 'let Gio = __gio;')
        .replace('let computeScaledDimensions = null;', 'let computeScaledDimensions = __scale;')
        .replace('export default class BigShotExtension', 'class BigShotExtension') +
        '\n({Extension: BigShotExtension, configs: VIDEO_PIPELINES});', {
        Extension: class {}, GLib: glib, Main: {screenshotUI: ui},
        __gio: gio, __scale: computeScaledDimensions,
        _: text => text, console: {warn() {}, error() {}},
    });
    const ext = Object.assign(new Extension(), {
        _activeEnableSerial: 1, _recordingEpoch: 1,
        _recordingState: 'recording', _screenshotUI: ui,
        _recordingStartPromise: null, _recordingStopPromise: null,
        _segmentStopPromise: null, _pausePromise: null, _resumePromise: null,
        _stopCompletions: new Set(), _stopWatcherId: 0,
        _recordingSession: {ffmpegPath: '/bin/ffmpeg', segments: []},
        _currentSegment: {path: '/test/segment.mp4'},
        _indicator: Object.fromEntries([
            'onStopping', 'onStopFailed', 'onPaused', 'onResuming',
            'onResumed', 'onRecordingStopped',
        ].map(name => [name, () => events.push(name)])),
        _videoAnnotation: {finishEditForStop() {}, onRecordingStopped() {}},
        _showNotification: title => events.push(title),
        _addTimeout(interval, callback) { timers.set(interval, callback); return interval; },
        _removeSource(id) { timers.delete(id); },
        _finalizeCurrentSegment() {
            if (this._currentSegment) {
                this._recordingSession.segments.push(this._currentSegment);
                this._currentSegment = null;
                events.push('finalized');
            }
        },
    });
    return {ext, ui, events, timers, bus, configs};
}

const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test('stop keeps recording visible until acknowledgement; repeated stops share one call', async () => {
    const {ext, ui, events} = fixture();
    const stop = deferred();
    let calls = 0;
    ext._origStopScreencastAsync = () => { calls++; return stop.promise; };
    const first = ext._stopScreencastUiAsync();
    const second = ext._stopScreencastUiAsync();
    await tick();
    assert.equal(calls, 1);
    assert.equal(ui._screencastInProgress, true);
    assert.equal(ext._recordingState, 'stopping');
    assert.equal(events.includes('finalized'), false);
    stop.resolve([true]);
    await Promise.all([first, second]);
    assert.equal(ext._recordingState, 'idle');
    assert.equal(ui._screencastInProgress, false);
    assert.equal(events.filter(x => x === 'Screencast recorded').length, 1);
    assert.equal(events.filter(x => x === 'finalized').length, 1);
});

// A rejected stop is a real failure: the service never acknowledged EOS.
// `false` is not — the service answered that it holds no recorder for us,
// which means the recording is already over. See _stopSegmentAsync.
test('failed stop (reject) preserves segments and blocks pause/resume', async () => {
    {
        const {ext, ui, events, timers} = fixture();
        const session = ext._recordingSession;
        ext._origStopScreencastAsync = () => Promise.reject(new Error('timeout'));
        await ext._stopScreencastUiAsync();
        assert.equal(ext._recordingState, 'stop-failed');
        assert.equal(ui._screencastInProgress, true);
        assert.equal(ext._recordingSession, session);
        assert.equal(events.includes('finalized'), false);
        assert.equal(await ext.pauseRecording(), false);
        assert.equal(await ext.resumeRecording(), false);
        ext._watchForFinalStop();
        ui._screencastInProgress = false;
        assert.equal(timers.get(500)(), true);
        assert.equal(events.includes('finalized'), false);
    }
});

test('stop answered false ends the session instead of blocking it', async () => {
    const {ext, ui} = fixture();
    // The service replies false only when it has no recorder for this sender,
    // so the recording is already finished. Treating that as a failure left
    // the extension in stop-failed, which blocks every later recording.
    ext._origStopScreencastAsync = () => Promise.resolve([false]);
    await ext._stopScreencastUiAsync();
    assert.equal(ext._recordingState, 'idle');
    assert.equal(ui._screencastInProgress, false);
});

test('pause updates the clock only after EOS; final stop during pause sends no second stop', async () => {
    const {ext, events} = fixture();
    const stop = deferred();
    let calls = 0;
    ext._origStopScreencastAsync = () => { calls++; return stop.promise; };
    const pause = ext.pauseRecording();
    const final = ext._stopScreencastUiAsync();
    await tick();
    assert.equal(events.includes('onPaused'), false);
    assert.equal(ext._recordingState, 'pausing');
    stop.resolve([true]);
    await Promise.all([pause, final]);
    assert.equal(calls, 1);
    assert.equal(ext._recordingState, 'idle');
    assert.equal(events.filter(x => x === 'finalized').length, 1);
});

test('pause timeout never restores the running clock or starts another segment', async () => {
    const {ext, events} = fixture();
    ext._origStopScreencastAsync = () => Promise.reject(new Error('timeout'));
    assert.equal(await ext.pauseRecording(), false);
    assert.equal(ext._recordingState, 'stop-failed');
    assert.equal(events.includes('onPaused'), false);
    assert.equal(events.includes('onResumed'), false);
    assert.equal(events.includes('finalized'), false);
});

test('stop queued during failed pause preserves the file and does not retry the service', async () => {
    const {ext, events} = fixture();
    const stop = deferred();
    let calls = 0;
    ext._origStopScreencastAsync = () => { calls++; return stop.promise; };
    const pause = ext.pauseRecording();
    const final = ext._stopScreencastUiAsync();
    stop.reject(new Error('timeout'));
    await Promise.all([pause, final]);
    assert.equal(calls, 1);
    assert.equal(ext._recordingState, 'stop-failed');
    assert.equal(events.includes('finalized'), false);
});

test('stop waits for resume, then stops the new segment once', async () => {
    const {ext} = fixture();
    ext._recordingState = 'paused';
    const resume = deferred();
    ext._startNextSegment = () => resume.promise;
    let calls = 0;
    ext._origStopScreencastAsync = async () => { calls++; return [true]; };
    const started = ext.resumeRecording();
    const stopped = ext._stopScreencastUiAsync();
    await tick();
    assert.equal(calls, 0);
    resume.resolve(true);
    await Promise.all([started, stopped]);
    assert.equal(calls, 1);
    assert.equal(ext._recordingState, 'idle');
});

test('resume timeout cannot masquerade as a paused recording', async () => {
    const {ext, events} = fixture();
    ext._recordingState = 'paused';
    ext._startNextSegment = async () => { throw new Error('timeout'); };
    assert.equal(await ext.resumeRecording(), false);
    assert.equal(ext._recordingState, 'stop-failed');
    assert.equal(events.includes('onPaused'), false);
});

test('late stop failure from a dead session cannot overwrite a new recording', async () => {
    const {ext} = fixture();
    const stop = deferred();
    ext._origStopScreencastAsync = () => stop.promise;
    const pending = ext._stopScreencastUiAsync();
    await tick();
    ext._recordingSession = null;
    ext._currentSegment = null;
    ext._onFinalStop();
    ext._recordingState = 'recording';
    const session = ext._recordingSession = {id: 'new'};
    stop.reject(new Error('service disappeared'));
    await pending;
    assert.equal(ext._recordingState, 'recording');
    assert.equal(ext._recordingSession, session);
});

test('stop waits for startup before asking the service to stop', async () => {
    const {ext} = fixture();
    const start = deferred();
    ext._recordingStartPromise = start.promise;
    ext._recordingState = 'starting';
    let calls = 0;
    ext._origStopScreencastAsync = async () => { calls++; return [true]; };
    const stopped = ext._stopScreencastUiAsync();
    await tick();
    assert.equal(calls, 0);
    start.resolve();
    await stopped;
    assert.equal(calls, 1);
    assert.equal(ext._recordingState, 'idle');
});

test('force stop targets only the current recording service and never finalizes its uncertain segment', async () => {
    const {ext, ui, events} = fixture();
    ui._screencastProxy = {g_name_owner: ':1.42'};
    ext._indicator._stopFailed = true;
    const calls = [];
    ext._runSubprocess = async args => { calls.push(args); return {successful: true}; };
    await ext.forceStopRecording();
    assert.deepEqual(Array.from(calls[0]), ['/usr/bin/kill', '-KILL', '--', '42']);
    assert.equal(ext._recordingState, 'idle');
    assert.equal(ui._screencastInProgress, false);
    assert.equal(events.includes('finalized'), false);
});

test('force stop refuses changed owners or sessions, the Shell PID, and healthy recordings', async () => {
    for (const scenario of ['replaced', 'session', 'recovered', 'shell', 'healthy']) {
        const {ext, ui, bus} = fixture();
        ui._screencastProxy = {g_name_owner: ':1.42'};
        ext._indicator._stopFailed = scenario !== 'healthy';
        if (scenario === 'shell') bus.pid = 99;
        if (['replaced', 'session', 'recovered'].includes(scenario)) {
            const call = bus.call.bind(bus);
            bus.call = (...args) => {
                if (scenario === 'replaced') ui._screencastProxy.g_name_owner = ':1.43';
                if (scenario === 'session') ext._recordingEpoch++;
                if (scenario === 'recovered') ext._indicator._stopFailed = false;
                call(...args);
            };
        }
        ext._runSubprocess = assert.fail;
        await ext.forceStopRecording();
        assert.equal(ext._recordingState, 'recording');
    }
});

test('stop during a pause toggle cannot reopen paused editing after finalization', async () => {
    const {ext} = fixture();
    const stop = deferred();
    ext._origStopScreencastAsync = () => stop.promise;
    ext._videoAnnotation.enterPausedEditFromPause = assert.fail;
    const toggle = ext.togglePauseRecording();
    const final = ext._stopScreencastUiAsync();
    stop.resolve([true]);
    await Promise.all([toggle, final]);
    assert.equal(ext._recordingState, 'idle');
});

test('NVENC H.264 and H.265 pipelines negotiate NV12 before encoding', () => {
    const {ext, configs} = fixture();
    ext._availableElements = new Set(['videorate']);
    for (const id of ['nvidia-raw-h264-nvenc', 'nvidia-raw-h265-nvenc']) {
        const config = configs.find(candidate => candidate.id === id);
        const pipeline = ext._makePipelineString(config, '30/1', 1, undefined,
            {width: 2560, height: 1440});
        assert.match(pipeline, /video\/x-raw,format=NV12 ! queue ! nvh26[45]enc/);
        assert.match(pipeline, /rc-mode=constqp/);
        assert.doesNotMatch(pipeline, /videoscale/);
    }
});

test('NV12 normalizes odd recording dimensions even at full resolution', () => {
    const {ext, configs} = fixture();
    const config = configs.find(candidate => candidate.id === 'nvidia-raw-h264-nvenc');
    const pipeline = ext._makePipelineString(config, null, 1, undefined,
        {width: 901, height: 721});
    assert.match(pipeline, /videoscale ! video\/x-raw,width=902,height=722/);
    assert.match(pipeline, /video\/x-raw,format=NV12/);
});

test('NV12 retains selected downscaling and framerate', () => {
    const {ext, configs} = fixture();
    ext._availableElements = new Set(['videorate']);
    const config = configs.find(candidate => candidate.id === 'nvidia-raw-h264-nvenc');
    const pipeline = ext._makePipelineString(config, '60/1', 0.5, undefined,
        {width: 2560, height: 1440});
    assert.match(pipeline, /width=1280,height=720/);
    assert.match(pipeline, /framerate=60\/1/);
    assert.match(pipeline, /format=NV12/);
});

test('pause survives the service leaving the bus', async () => {
    // org.gnome.Shell.Screencast shuts down ~2s after the pause segment
    // stops, so the owner is normally already gone when _screencastFailed
    // fires. Requiring g_name_owner here destroyed the paused session.
    const source = await import('node:fs/promises')
        .then(fs => fs.readFile(
            'usr/share/gnome-shell/extensions/big-shot@communitybig.org/extension.js',
            'utf8'));
    assert.doesNotMatch(source,
        /_shouldIgnorePauseStopFailure\(\) &&\s*screenshotUI\._screencastProxy\?\.g_name_owner/);
    assert.match(source, /if \(ext\._shouldIgnorePauseStopFailure\(\)\) \{/);
});

test('losing the service keeps the finished segments', async () => {
    const source = await import('node:fs/promises')
        .then(fs => fs.readFile(
            'usr/share/gnome-shell/extensions/big-shot@communitybig.org/extension.js',
            'utf8'));
    // _onFinalStop() is the only caller of _mergeSegments(session); clearing
    // the session first silently orphans every segment already on disk.
    const failedIdx = source.indexOf("if (args[0] === 'RECORDING') {");
    const block = source.slice(failedIdx, failedIdx + 500);
    assert.ok(failedIdx >= 0);
    assert.doesNotMatch(block, /ext\._recordingSession = null/);
    assert.match(block, /ext\._currentSegment = null/);
});

test('force stop clears the state when the service is already gone', async () => {
    const source = await import('node:fs/promises')
        .then(fs => fs.readFile(
            'usr/share/gnome-shell/extensions/big-shot@communitybig.org/extension.js',
            'utf8'));
    const idx = source.indexOf('async forceStopRecording()');
    const block = source.slice(idx, idx + 1200);
    assert.ok(idx >= 0);
    // Returning early on a missing owner stranded the user in stop-failed,
    // which blocks every new recording.
    assert.match(block, /if \(!owner\) \{[\s\S]*?this\._onFinalStop\(\);/);
});

test('the stop watchdog stays quiet while pausing', async () => {
    const source = await import('node:fs/promises')
        .then(fs => fs.readFile(
            'usr/share/gnome-shell/extensions/big-shot@communitybig.org/extension.js',
            'utf8'));
    const idx = source.indexOf('    _watchStopTimeout(settled) {');
    const block = source.slice(idx, idx + 1400);
    assert.ok(idx >= 0);
    assert.match(block, /_recordingState === 'pausing' \|\|[\s\S]*?=== 'paused'/);
});

test('pause judges the segment by the file, not by the stop return value', async () => {
    const source = await import('node:fs/promises')
        .then(fs => fs.readFile(
            'usr/share/gnome-shell/extensions/big-shot@communitybig.org/extension.js',
            'utf8'));
    const idx = source.indexOf('    async _stopCurrentSegmentForPause() {');
    const block = source.slice(idx, idx + 600);
    assert.ok(idx >= 0);
    // A false stop is benign — it only means the service no longer holds a
    // recorder for this sender. Failing the pause on it dropped a healthy
    // session into stop-failed.
    assert.doesNotMatch(block, /return Array\.isArray\(result\)/);
    assert.match(block, /await this\._stopSegmentAsync\(\);\s*\n\s*return true;/);
});

test('the panel keeps one stop control, not two', async () => {
    const source = await import('node:fs/promises')
        .then(fs => fs.readFile(
            'usr/share/gnome-shell/extensions/big-shot@communitybig.org/parts/partindicator.js',
            'utf8'));
    // The shell's screenRecording indicator sits next to ours and already
    // stops the recording; our button is the Force stop escape hatch only.
    const createIdx = source.indexOf('this._stopButton = new St.Button({');
    assert.ok(createIdx >= 0);
    assert.match(source.slice(createIdx, createIdx + 220), /visible: false,/);
    const updateIdx = source.indexOf('    _updateStopButton() {');
    assert.ok(updateIdx >= 0);
    assert.match(source.slice(updateIdx, updateIdx + 200),
        /this\._stopButton\.visible = this\._stopFailed;/);
});

const readExtensionSource = () => import('node:fs/promises')
    .then(fs => fs.readFile(
        'usr/share/gnome-shell/extensions/big-shot@communitybig.org/extension.js',
        'utf8'));

test('the native startup retry is not swallowed by the re-entrancy guard', async () => {
    const source = await readExtensionSource();
    const idx = source.indexOf('screenshotUI._startScreencast = function (...args) {');
    const block = source.slice(idx, idx + 1200);
    assert.ok(idx >= 0);
    // Native _startScreencast(nRetries) retries a startup crash through
    // this._startScreencast(nRetries + 1), which re-enters this patch.
    const retryIdx = block.indexOf("typeof args[0] === 'number' && args[0] > 0");
    const guardIdx = block.indexOf("ext._recordingStartPromise !== null");
    assert.ok(retryIdx >= 0);
    assert.ok(retryIdx < guardIdx, 'the retry escape must come before the guard');
});

test('a late service shutdown does not tear down a resumed session', async () => {
    const source = await readExtensionSource();
    const idx = source.indexOf('    _shouldIgnorePauseStopFailure() {');
    const block = source.slice(idx, idx + 600);
    assert.ok(idx >= 0);
    assert.match(block, /_recordingState === 'resuming'/);
});

test('pause refuses up front when the native stop method is missing', async () => {
    const source = await readExtensionSource();
    const idx = source.indexOf('    async _pauseRecordingAsync() {');
    const block = source.slice(idx, idx + 1200);
    assert.ok(idx >= 0);
    const guardIdx = block.indexOf('if (!this._origStopScreencastAsync) {');
    const pausingIdx = block.indexOf("this._recordingState = 'pausing';");
    assert.ok(guardIdx >= 0);
    assert.ok(guardIdx < pausingIdx, 'refuse before entering the pausing state');
    // No stop was sent, so the recording must not be declared stop-failed.
    assert.doesNotMatch(block, /throw new Error\('StopScreencast returned false'\)/);
});

test('one stuck stop produces a single failure notification', async () => {
    const source = await readExtensionSource();
    const idx = source.indexOf('    _notifyRecordingStopFailure() {');
    const block = source.slice(idx, idx + 600);
    assert.ok(idx >= 0);
    assert.match(block, /if \(this\._stopFailureNotified\)\s*\n\s*return;/);
    // Cleared when the session ends, or the next failure stays silent.
    const stopIdx = source.indexOf('    _onFinalStop() {');
    assert.match(source.slice(stopIdx, stopIdx + 900),
        /this\._stopFailureNotified = false;/);
});

test('force stop clears the shell indicator when the service is gone', async () => {
    const source = await readExtensionSource();
    const idx = source.indexOf('async forceStopRecording()');
    const block = source.slice(idx, idx + 900);
    assert.ok(idx >= 0);
    const ownerIdx = block.indexOf('if (!owner) {');
    assert.match(block.slice(ownerIdx, ownerIdx + 900),
        /this\._setScreencastInProgress\(false\);/);
});

test('a window-mode startup timeout does not silently go idle', async () => {
    const source = await readExtensionSource();
    const idx = source.indexOf('    async _startWindowScreencast(ui) {');
    const block = source.slice(idx, idx + 4000);
    assert.ok(idx >= 0);
    // The service's pending start survives the timeout, so idle here can
    // orphan a recording with no way to stop it.
    assert.match(block, /if \(this\._isStartupTimeout\(e\)\) \{[\s\S]*?'stop-failed'/);
});
