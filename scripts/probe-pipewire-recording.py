#!/usr/bin/env python3
"""Test encoding a synthetic PipeWire source; never capture a screen or microphone."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--encoder', choices=['openh264enc', 'nvh264enc', 'nvh265enc'], default='nvh264enc')
parser.add_argument('--source-format', choices=['BGRx', 'BGRA', 'NV12', 'Y444'])
parser.add_argument('--unconstrained-encoder', action='store_true', help='Reproduce the pre-fix negotiation; the test process may crash')
args = parser.parse_args()
caps = 'video/x-raw,width=2560,height=1440,framerate=30/1'
if args.source_format:
    caps += ',format=' + args.source_format
node_name = 'bigshot-synthetic-probe'
producer = subprocess.Popen([
    'gst-launch-1.0', '-q', 'videotestsrc', 'is-live=true', '!', caps, '!',
    'pipewiresink', 'mode=provide',
    f'stream-properties=properties,node.name={node_name},media.class=Video/Source',
], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
try:
    node = None
    for _ in range(30):
        graph = json.loads(subprocess.check_output(['pw-dump'], text=True))
        node = next((item['id'] for item in graph
                     if item.get('info', {}).get('props', {}).get('node.name') == node_name), None)
        if node is not None:
            break
        if producer.poll() is not None:
            raise RuntimeError('Synthetic producer exited before publishing its node')
        time.sleep(0.1)
    if node is None:
        raise RuntimeError('Synthetic PipeWire source not found')
    script = Path(__file__).with_name('probe-recording-eos.js')
    command = ['timeout', '-k', '2s', '12s', 'gjs', '-m', str(script), args.encoder, str(node)]
    if args.unconstrained_encoder:
        command.append('unconstrained')
    result = subprocess.run(command, stdin=subprocess.DEVNULL)
    print(f'Synthetic PipeWire probe result: {result.returncode}', flush=True)
    sys.exit(0 if result.returncode == 0 else 1)
finally:
    producer.terminate()
    try:
        producer.wait(timeout=2)
    except subprocess.TimeoutExpired:
        producer.kill()
        producer.wait()
