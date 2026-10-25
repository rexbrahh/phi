"""Focused regression tests for PTY supervisor setup failures."""

from __future__ import annotations

import errno
import os
import select
import signal
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import pty_harness


class SupervisorSetupTests(unittest.TestCase):
	def test_missing_cleanup_marker_routes_through_owned_supervisor(self) -> None:
		child = pty_harness.PTYChild.__new__(pty_harness.PTYChild)
		child.node_exit_code = None
		child.application_reaped = False
		child.scenario = "input"
		child.stopped = False
		child.pid = 4242
		child.supervisor_pid = 4343
		child.cleanup_request_sent = False
		child.termination_attempts = []
		child.wait_application_reaped = mock.Mock(side_effect=AssertionError("supervisor reap marker was not observed"))
		child.pump = mock.Mock()
		child.mode_error = mock.Mock(return_value=None)
		with tempfile.TemporaryDirectory(prefix="pty-cleanup-request-") as temporary:
			child.supervisor_command_path = Path(temporary) / "request"
			with mock.patch.object(pty_harness.os, "waitid", return_value=None), mock.patch.object(pty_harness.os, "kill") as kill:
				issues = child.cleanup()

			self.assertEqual(kill.call_args_list, [mock.call(4343, signal.SIGUSR1)])
			self.assertNotIn(4242, [call.args[0] for call in kill.call_args_list])
			self.assertEqual(child.supervisor_command_path.read_text(encoding="utf-8"), "cleanup\n")
		self.assertEqual(len(issues), 1)
		self.assertIn("supervisor reap marker was not observed", issues[0])
		self.assertTrue(child.cleanup_request_sent)
		self.assertTrue(child.termination_attempts[-1]["sent"])
		self.assertEqual(child.termination_attempts[-1]["pid"], 4343)

	def test_terminate_and_reap_does_not_signal_reaped_or_non_child_pid(self) -> None:
		for name, wait_result in (
			("already reaped", (4242, 0)),
			("not a child", ChildProcessError()),
		):
			with self.subTest(name=name):
				with mock.patch.object(pty_harness.os, "waitpid", side_effect=[wait_result]), mock.patch.object(pty_harness.os, "kill") as kill:
					attempts = pty_harness._terminate_and_reap(4242)

				kill.assert_not_called()
				self.assertEqual(attempts, {"SIGCONT": False, "SIGTERM": False, "SIGKILL": False})

	def test_cleanup_reports_supervisor_confirmed_sigkill(self) -> None:
		child = pty_harness.PTYChild.__new__(pty_harness.PTYChild)
		child.events = [{
			"event": "application-reaped-after-cleanup-request",
			"pid": 4242,
			"termination": {"SIGCONT": True, "SIGTERM": True, "SIGKILL": True},
		}]
		child.supervisor_event = 0
		child.node_exit_code = None
		child.application_reaped = False
		child.forced_application_termination = False
		child.scenario = "input"
		child.stopped = False
		child.pid = 4242
		child.termination_attempts = []
		child.pump = mock.Mock()
		child.mode_error = mock.Mock(return_value=None)

		child._poll_child()
		issues = child.cleanup()

		self.assertTrue(child.application_reaped)
		self.assertTrue(child.forced_application_termination)
		self.assertEqual(
			[(attempt["signal"], attempt["sent"]) for attempt in child.termination_attempts],
			[("SIGCONT", True), ("SIGTERM", True), ("SIGKILL", True)],
		)
		self.assertEqual(len(issues), 1)
		self.assertIn("emergency SIGKILL was required", issues[0])

	def test_release_requests_supervisor_to_reap_owned_application_child(self) -> None:
		with tempfile.TemporaryDirectory(prefix="pty-supervisor-reap-") as temporary:
			root = Path(temporary)
			application = root / "wait-for-cleanup.js"
			application.write_text(
				"process.on('SIGTERM', () => {});\n"
				"require('node:fs').appendFileSync(process.env.PHI_PTY_MARKERS, '{\"event\":\"ignore-term-ready\"}\\n');\n"
				"setInterval(() => {}, 1000);\n",
				encoding="utf-8",
			)
			case_directory = root / "case"
			case_directory.mkdir()
			child = pty_harness.PTYChild("cleanup-request", case_directory, application=application)
			try:
				child.wait_event("ignore-term-ready")
				issues = child.release_supervisor()
				self.assertEqual(issues, [])
				self.assertTrue(child.application_reaped)
				self.assertTrue(child.forced_application_termination)
				self.assertIsNone(child.node_exit_code)
				self.assertTrue(any(
					attempt.get("role") == "application"
					and attempt.get("signal") == "SIGKILL"
					and attempt.get("sent") is True
					for attempt in child.termination_attempts
				))
				self.assertTrue(any(
					event.get("event") == "application-reaped-after-cleanup-request"
					for event in child.events
				))
			finally:
				for descriptor in (child.master, child.slave):
					try:
						os.close(descriptor)
					except OSError:
						pass

	def test_setpgid_eacces_requires_expected_child_group(self) -> None:
		child_pid = 4242
		with mock.patch.object(
			pty_harness.os,
			"setpgid",
			side_effect=OSError(errno.EACCES, "child already executed"),
		), mock.patch.object(pty_harness.os, "getpgid", return_value=child_pid) as getpgid:
			pty_harness._set_child_process_group(child_pid)
		getpgid.assert_called_once_with(child_pid)

		with mock.patch.object(
			pty_harness.os,
			"setpgid",
			side_effect=OSError(errno.EACCES, "child already executed"),
		), mock.patch.object(pty_harness.os, "getpgid", return_value=child_pid + 1) as getpgid:
			with self.assertRaises(OSError) as raised:
				pty_harness._set_child_process_group(child_pid)
		self.assertEqual(raised.exception.errno, errno.EACCES)
		getpgid.assert_called_once_with(child_pid)

	def test_setup_error_terminates_and_reaps_only_owned_child(self) -> None:
		ready_read, ready_write = os.pipe()
		child_pid = os.fork()
		if child_pid == 0:
			os.close(ready_read)
			signal.signal(signal.SIGTERM, signal.SIG_IGN)
			os.write(ready_write, b"ready")
			os.close(ready_write)
			while True:
				signal.pause()

		real_kill = os.kill
		kill_targets: list[tuple[int, int]] = []

		def record_kill(target: int, sent_signal: int) -> None:
			kill_targets.append((target, sent_signal))
			real_kill(target, sent_signal)

		try:
			os.close(ready_write)
			ready, _, _ = select.select([ready_read], [], [], 1.0)
			self.assertTrue(ready, "owned child did not become ready within one second")
			self.assertEqual(os.read(ready_read, 5), b"ready")
			os.close(ready_read)
			with tempfile.TemporaryDirectory(prefix="pty-setup-error-") as temporary:
				started = time.monotonic()
				with mock.patch.object(
					pty_harness.os,
					"setpgid",
					side_effect=OSError(errno.EINVAL, "forced setup failure"),
				), mock.patch.object(pty_harness.os, "kill", side_effect=record_kill):
					with self.assertRaises(OSError) as raised:
						pty_harness._setup_application_child(
							child_pid,
							-1,
							Path(temporary) / "node.pid",
						)
				elapsed = time.monotonic() - started
			self.assertEqual(raised.exception.errno, errno.EINVAL)
			self.assertLess(elapsed, 2.0, "setup-error cleanup exceeded its two-second bound")
			self.assertTrue(kill_targets, "setup-error cleanup did not signal its child")
			self.assertEqual({target for target, _ in kill_targets}, {child_pid})
			with self.assertRaises(ChildProcessError):
				os.waitpid(child_pid, os.WNOHANG)
		finally:
			try:
				os.close(ready_read)
			except OSError:
				pass
			try:
				real_kill(child_pid, signal.SIGKILL)
			except ProcessLookupError:
				pass
			try:
				os.waitpid(child_pid, 0)
			except ChildProcessError:
				pass


if __name__ == "__main__":
	unittest.main()
