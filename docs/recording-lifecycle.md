# Recording stop and pause investigation

## Confirmed defects

GNOME Shell 50.4 `ScreenshotUI.stopScreencast()` clears
`_screencastInProgress` **before** awaiting `StopScreencastAsync()`. On failure,
the old Big Shot completion handler could treat the cleared flag as proof of
EOS, finalize a segment, and merge/delete files while the recorder still held
them open. A false D-Bus result and a rejected request were not distinguished
from confirmed completion.

Pausing also stopped the indicator clock before the service confirmed EOS.
When the request timed out, the error handler returned to `recording` and
restarted the clock. This creates the appearance of an automatic resume.
Overlapping pause, resume, and final-stop requests could issue multiple
physical stops or reopen paused editing after final stop.

An unresolved startup timeout is not evidence that an encoder failed cleanly:
the service may still be starting. Do not advance the encoder cascade after
such a timeout when no recording can be recovered.

## Changes

- Acknowledge final stop only after a successful service reply.
- Keep one physical segment-stop promise and serialize final stop with startup,
  pause, and resume. Ignore callbacks from a finalized recording generation.
- Preserve files and expose `stop-failed` when the outcome is unknown. Do not
  resume, merge, delete, or report a saved recording in that state.
- Show a separate stop button. After the grace period, provide an explicit
  Force stop action targeting the recording service's current unique D-Bus
  owner. It terminates that service, not GNOME Shell; the last fragment may be
  incomplete. This also affects any other recording hosted by the same service.
- Retain the NVENC `constqp` fix from PR #18.
- Negotiate NV12 explicitly for both NVENC encoders and normalize odd output
  dimensions. Unconstrained format negotiation from a synthetic PipeWire
  provider reproducibly crashed the NVENC copy path in GStreamer 1.28.6.

## Observations and limits

The affected session used GNOME Shell 50.4, GStreamer 1.28.6, NVIDIA driver
610.57.04, and an RTX 3050 Laptop with an external 2K monitor. The installed
extension still used `rc-mode=cqp`; the stuck recorder had loaded OpenH264 and
FDK AAC. Its D-Bus property query and stop calls timed out while its output
descriptor remained open and grew. The descriptor referenced a deleted segment.
These observations establish an unresponsive recording service and premature
file finalization; they do not identify its internal blocked stack.

Synthetic EOS tests passed with NVENC and OpenH264, regular/sparse frames,
synthetic mixed audio, and a temporary PulseAudio null-sink monitor. No real
screen or microphone was captured. The underlying service stall was **not**
reproduced by these tests. The fix corrects the confirmed state/file lifecycle
bugs and provides recovery; normal recording on the actual monitor still needs
interactive validation after loading the new extension.

Further synthetic PipeWire tests found a **separate startup crash**, with
SIGSEGV in libc called from `libgstnvcodec.so` on the encoder queue thread.
It repeated with a fresh virtual provider. Explicit NV12 negotiation passed
three rounds each of H.264 and H.265; removing it reproduced the crash again.
BGRx and BGRA providers passed both with and without NV12. This localizes the
new failure to source-format negotiation; it is not proof that it caused the
original stop timeout, nor evidence of a kernel defect. The NV12 change avoids
the observed encoder path without disabling hardware encoding.

## Validation

`node --test tests/*.test.js` includes behavioral tests for delayed/failed EOS,
false stop replies, duplicate requests, overlapping pause/stop and resume/stop,
late callbacks, safe force-stop targeting, and final-stop/edit races.

For synthetic GStreamer validation, run from the actual graphical host:

```sh
timeout -k 2s 12s gjs -m scripts/probe-recording-eos.js openh264enc
timeout -k 2s 12s gjs -m scripts/probe-recording-eos.js nvh264enc
```

Success requires both `EOS received` and `NULL reached`. The external deadline
is essential because synchronous GStreamer calls can block the JS main loop.
The probe creates a private temporary directory and removes its synthetic file
on normal completion. Do not share a GStreamer registry between a container
without GPU access and the graphical host; use `GST_REGISTRY` with a separate
temporary path when probing in an isolated environment.

To exercise actual PipeWire buffers with a temporary virtual video source and
synthetic audio, run one probe at a time:

```sh
python scripts/probe-pipewire-recording.py --encoder nvh264enc
python scripts/probe-pipewire-recording.py --encoder nvh265enc
python scripts/probe-pipewire-recording.py --encoder nvh264enc --source-format BGRx
```

`--unconstrained-encoder` recreates the old raw-format negotiation and may
crash only the test process. The provider is terminated on completion or error.
No real desktop, webcam, or audio device is captured.

## Successful real-session recordings reviewed

Three recordings made on the current installed system extension on 2026-10-16
were inspected locally. They show a plain screen capture, a webcam overlay,
and a webcam recording with pause/resume and live annotation, respectively.
Full decoding completed without errors. All contain H.264 video at 1920x1080,
30 fps, with strictly increasing video DTS:

| Scenario | Duration | Video frames |
| --- | ---: | ---: |
| Screen without webcam | 15.466667 s | 464 |
| Screen with webcam | 18.000000 s | 540 |
| Webcam, pause/resume, annotation | 22.366667 s | 671 |

None of the three files contains an audio stream. The third file carries an
FFmpeg muxer tag and spans two recording-service instances in the session
logs, consistent with pause/resume segment merging. The reviewed logs show
service termination and no stop timeout for these runs; they still show NVENC
startup failures on the old loaded extension.

These are successful baseline observations after recovery of the previously
unresponsive service. They do **not** demonstrate that the pending local
extension patch has been loaded, and they do not exercise the original
audio-enabled stalled recording. Raw videos, frames, and private session logs
are not included in this repository or PR.

In the graphical session, verify start/stop, start/pause/resume/stop, quick
repeated clicks, stop while pausing, and stop while resuming. Check that files
play and that no service keeps writing after stop. A force stop is recovery,
not proof that ordinary EOS is reliable.
