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
	def test_cleanup_keeps_unobserved_emergency_exit_as_a_reported_issue(self) -> None:
		child = pty_harness.PTYChild.__new__(pty_harness.PTYChild)
		child.node_exit_code = None
		child.scenario = "input"
		child.stopped = False
		child.pid = 4242
		child.termination_attempts = []
		child.wait_exit = mock.Mock(side_effect=AssertionError("supervisor exit marker was not observed"))
		child.pump = mock.Mock()
		child.mode_error = mock.Mock(return_value=None)
		with mock.patch.object(pty_harness.os, "kill") as kill:
			issues = child.cleanup()

		self.assertEqual(kill.call_args_list, [
			mock.call(4242, signal.SIGTERM),
			mock.call(4242, signal.SIGKILL),
		])
		self.assertEqual(len(issues), 1)
		self.assertIn("supervisor did not report its exit", issues[0])
		self.assertFalse(child.termination_attempts[-1]["exitObserved"])
		self.assertEqual(child.termination_attempts[-1]["pid"], 4242)

	def test_release_requests_supervisor_to_reap_owned_application_child(self) -> None:
		with tempfile.TemporaryDirectory(prefix="pty-supervisor-reap-") as temporary:
			root = Path(temporary)
			application = root / "wait-for-cleanup.js"
			application.write_text("process.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n", encoding="utf-8")
			case_directory = root / "case"
			case_directory.mkdir()
			child = pty_harness.PTYChild("cleanup-request", case_directory, application=application)
			try:
				issues = child.release_supervisor()
				self.assertEqual(issues, [])
				self.assertTrue(child.application_reaped)
				self.assertIsNone(child.node_exit_code)
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
