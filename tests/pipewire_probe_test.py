"""Validate command boundaries and cleanup without creating media devices."""
import contextlib
import importlib.util
import io
from pathlib import Path
import subprocess
import unittest
from unittest.mock import Mock, patch


script = Path(__file__).resolve().parents[1] / 'scripts/probe-pipewire-recording.py'
spec = importlib.util.spec_from_file_location('pipewire_probe', script)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class PipeWireProbeTests(unittest.TestCase):
    def test_cli_rejects_pipeline_and_option_injection_before_starting_processes(self):
        payloads = ['NV12 ! filesink location=/tmp/unexpected', '--gst-plugin-load=/tmp/unexpected.so', ';echo unexpected']
        for option in ['--source-format', '--encoder']:
            for payload in payloads:
                with self.subTest(option=option, payload=payload):
                    with patch.object(probe.subprocess, 'Popen') as start:
                        with contextlib.redirect_stderr(io.StringIO()):
                            with self.assertRaises(SystemExit) as error:
                                probe.main([option + '=' + payload])
                        self.assertEqual(error.exception.code, 2)
                        start.assert_not_called()

    def test_builders_reject_unrecognized_values_even_without_argparse(self):
        for value in ['nvh264enc --help', 'BGRA ! fakesink', '--gst-plugin-load=/tmp/unexpected.so', []]:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    probe.producer_command(value)
                with self.assertRaises(ValueError):
                    probe.recording_command(value, 7)

    def test_only_known_formats_and_encoders_reach_the_command_arguments(self):
        for name in ['BGRx', 'BGRA', 'NV12', 'Y444']:
            args = probe.parse_args(['--source-format', name])
            command = probe.producer_command(args.source_format)
            self.assertEqual(command.count('!'), 2)
            self.assertEqual(command[5].split(',')[-1], 'format=' + name)
        for name in ['openh264enc', 'nvh264enc', 'nvh265enc']:
            command = probe.recording_command(name, 7)
            self.assertEqual(command[-2:], [name, '7'])
            self.assertEqual(probe.recording_command(name, 7, True)[-1], 'unconstrained')

    def test_node_ids_and_diagnostic_flag_fail_closed(self):
        for node in [None, True, False, 0, -1, 2 ** 32, 7.5, '7', '7 --help']:
            with self.subTest(node=node):
                with self.assertRaises(ValueError):
                    probe.recording_command('nvh264enc', node)
        with self.assertRaises(ValueError):
            probe.recording_command('nvh264enc', 7, 'unconstrained')

    def test_probe_error_still_terminates_the_synthetic_producer(self):
        producer = Mock()
        with patch.object(probe.subprocess, 'Popen', return_value=producer):
            with patch.object(probe, 'find_synthetic_node', return_value=7):
                with patch.object(probe.subprocess, 'run', side_effect=OSError('test failure')):
                    with self.assertRaises(OSError):
                        probe.main([])
        producer.terminate.assert_called_once_with()
        producer.wait.assert_called_once_with(timeout=2)

    def test_child_failure_is_reported_and_producer_is_cleaned_up(self):
        producer = Mock()
        with patch.object(probe.subprocess, 'Popen', return_value=producer):
            with patch.object(probe, 'find_synthetic_node', return_value=7):
                with patch.object(probe.subprocess, 'run', return_value=Mock(returncode=-11)):
                    with contextlib.redirect_stdout(io.StringIO()):
                        self.assertEqual(probe.main([]), 1)
        producer.terminate.assert_called_once_with()

    def test_cleanup_kills_only_its_own_producer_after_the_deadline(self):
        producer = Mock()
        producer.wait.side_effect = [subprocess.TimeoutExpired('producer', 2), 0]
        probe.stop_producer(producer)
        producer.terminate.assert_called_once_with()
        producer.kill.assert_called_once_with()
        self.assertEqual(producer.wait.call_count, 2)


if __name__ == '__main__':
    unittest.main()
