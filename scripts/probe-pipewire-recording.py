#!/usr/bin/env python3
"""Test encoding a synthetic PipeWire source; never capture a screen or microphone."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import time

ENCODERS = {
    'openh264enc': 'openh264enc',
    'nvh264enc': 'nvh264enc',
    'nvh265enc': 'nvh265enc',
}
SOURCE_CAPS = {
    None: 'video/x-raw,width=2560,height=1440,framerate=30/1',
    'BGRx': 'video/x-raw,width=2560,height=1440,framerate=30/1,format=BGRx',
    'BGRA': 'video/x-raw,width=2560,height=1440,framerate=30/1,format=BGRA',
    'NV12': 'video/x-raw,width=2560,height=1440,framerate=30/1,format=NV12',
    'Y444': 'video/x-raw,width=2560,height=1440,framerate=30/1,format=Y444',
}
NODE_NAME = 'bigshot-synthetic-probe'


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--encoder', choices=tuple(ENCODERS), default='nvh264enc')
    parser.add_argument('--source-format', choices=tuple(key for key in SOURCE_CAPS if key is not None))
    parser.add_argument('--unconstrained-encoder', action='store_true',
                        help='Reproduce the pre-fix negotiation; the test process may crash')
    return parser.parse_args(argv)


def producer_command(source_format):
    # Values reaching GStreamer come from literal templates, never CLI text.
    try:
        caps = SOURCE_CAPS[source_format]
    except (KeyError, TypeError) as error:
        raise ValueError('Unsupported source format') from error
    return [
        'gst-launch-1.0', '-q', 'videotestsrc', 'is-live=true', '!', caps, '!',
        'pipewiresink', 'mode=provide',
        f'stream-properties=properties,node.name={NODE_NAME},media.class=Video/Source',
    ]


def recording_command(encoder_choice, node_id, unconstrained=False):
    try:
        encoder = ENCODERS[encoder_choice]
    except (KeyError, TypeError) as error:
        raise ValueError('Unsupported encoder') from error
    if not isinstance(node_id, int) or isinstance(node_id, bool) or not 0 < node_id <= 0xFFFFFFFF:
        raise ValueError('Invalid synthetic PipeWire node ID')
    if not isinstance(unconstrained, bool):
        raise ValueError('Invalid unconstrained-encoder flag')
    script = Path(__file__).with_name('probe-recording-eos.js')
    command = ['timeout', '-k', '2s', '12s', 'gjs', '-m', str(script), encoder, str(node_id)]
    if unconstrained:
        command.append('unconstrained')
    return command


def find_synthetic_node(producer):
    for _ in range(30):
        graph = json.loads(subprocess.check_output(['pw-dump'], text=True))
        node = next((item['id'] for item in graph
                     if item.get('info', {}).get('props', {}).get('node.name') == NODE_NAME), None)
        if node is not None:
            return node
        if producer.poll() is not None:
            raise RuntimeError('Synthetic producer exited before publishing its node')
        time.sleep(0.1)
    raise RuntimeError('Synthetic PipeWire source not found')


def stop_producer(producer):
    producer.terminate()
    try:
        producer.wait(timeout=2)
    except subprocess.TimeoutExpired:
        producer.kill()
        producer.wait()


def main(argv=None):
    args = parse_args(argv)
    producer = subprocess.Popen(producer_command(args.source_format),
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
    try:
        node = find_synthetic_node(producer)
        command = recording_command(args.encoder, node, args.unconstrained_encoder)
        result = subprocess.run(command, stdin=subprocess.DEVNULL)
        print(f'Synthetic PipeWire probe result: {result.returncode}', flush=True)
        return 0 if result.returncode == 0 else 1
    finally:
        stop_producer(producer)


if __name__ == '__main__':
    sys.exit(main())
