/**
 * Exercise recording EOS without capturing the desktop or real audio.
 * Run with an external deadline: timeout -k 2s 12s gjs -m scripts/probe-recording-eos.js
 * Arguments: encoder, optional synthetic PipeWire node ID, optional "unconstrained".
 */
import GLib from 'gi://GLib';
import Gst from 'gi://Gst';
import {exit} from 'system';

Gst.init(null);
const encoders = {
    openh264enc: 'openh264enc complexity=high multi-thread=4 ! h264parse',
    nvh264enc: 'nvh264enc rc-mode=constqp qp-const=23 ! h264parse',
    nvh265enc: 'nvh265enc rc-mode=constqp qp-const=25 ! h265parse',
};
const name = ARGV[0] || 'openh264enc';
if (!encoders[name])
    throw new Error(`Unsupported encoder: ${name}`);
const audioEncoder = ['fdkaacenc', 'avenc_aac', 'voaacenc']
    .find(element => Gst.ElementFactory.find(element));
if (!audioEncoder)
    throw new Error('No AAC encoder available');
const nodeId = ARGV[1] ? Number(ARGV[1]) : null;
if (nodeId !== null && (!Number.isInteger(nodeId) || nodeId <= 0))
    throw new Error('Invalid synthetic PipeWire node ID');
const source = nodeId === null
    ? 'videotestsrc is-live=true ! video/x-raw,width=2560,height=1440,framerate=1/1'
    : `pipewiresrc path=${nodeId} do-timestamp=true keepalive-time=1000 resend-last=true ! video/x-raw,max-framerate=30/1`;
const format = name.startsWith('nv') && ARGV[2] !== 'unconstrained'
    ? '! video/x-raw,format=NV12' : '';

const directory = GLib.dir_make_tmp('big-shot-eos-XXXXXX');
const output = GLib.build_filenamev([directory, 'synthetic.mp4']);
const loop = new GLib.MainLoop(null, false);
const pipeline = Gst.parse_launch([
    source,
    `! videoconvert chroma-mode=none dither=none matrix-mode=output-only n-threads=4 ${format} ! videorate skip-to-first=true`,
    `! video/x-raw,framerate=30/1 ! queue ! ${encoders[name]} ! queue ! mux.`,
    `audiotestsrc is-live=true ! audioconvert ! ${audioEncoder} ! queue ! mux.`,
    'mp4mux name=mux fragment-duration=500 fragment-mode=first-moov-then-finalise',
    `! filesink location="${output}"`,
].join(' '));
let success = false;
pipeline.get_bus().add_watch(GLib.PRIORITY_DEFAULT, (_bus, message) => {
    if (message.type === Gst.MessageType.ERROR) {
        printerr(String(message.parse_error()));
        loop.quit();
    } else if (message.type === Gst.MessageType.EOS) {
        success = true;
        print('EOS received');
        loop.quit();
    }
    return GLib.SOURCE_CONTINUE;
});
pipeline.set_state(Gst.State.PLAYING);
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2500, () => {
    print(`Sending EOS (${name}, synthetic 2560x1440 video and audio)`);
    print(`send_event returned ${pipeline.send_event(Gst.Event.new_eos())}`);
    return GLib.SOURCE_REMOVE;
});
loop.run();
pipeline.set_state(Gst.State.NULL);
print('NULL reached');
GLib.unlink(output);
GLib.rmdir(directory);
exit(success ? 0 : 1);
