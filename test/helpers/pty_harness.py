"""Bounded POSIX PTY process and termios controls for the PTY acceptance test."""

from __future__ import annotations

import errno
import fcntl
import json
import os
import select
import shutil
import signal
import struct
import termios
import time
from pathlib import Path
from typing import Callable


ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / "dist" / "test" / "pty-app.js"
AUTH_APP = ROOT / "dist" / "test" / "pty-auth.js"
PATH_PREFIX = "/opt/homebrew/bin"
DA_QUERY = b"\x1b[c"
DA_REPLY = b"\x1b[?1;2c"
KITTY_PROTOCOL_QUERY = b"\x1b[?u"
KITTY_PROTOCOL_REPLY = b"\x1b[?7u"
TIMEOUT = 5.0
SETUP_TERMINATION_GRACE = 0.25


def mode_snapshot(attributes: list[object]) -> dict[str, bool]:
	local = int(attributes[3])
	return {
		"canonical": bool(local & termios.ICANON),
		"echo": bool(local & termios.ECHO),
		"raw": not bool(local & termios.ICANON) and not bool(local & termios.ECHO),
	}


def _set_child_process_group(child_pid: int) -> None:
	try:
		os.setpgid(child_pid, child_pid)
	except OSError as error:
		if error.errno != errno.EACCES or os.getpgid(child_pid) != child_pid:
			raise


def _wait_child_until(child_pid: int, deadline: float) -> bool:
	while True:
		try:
			waited_pid, _ = os.waitpid(child_pid, os.WNOHANG)
		except InterruptedError:
			continue
		except ChildProcessError:
			return True
		if waited_pid == child_pid:
			return True
		remaining = deadline - time.monotonic()
		if remaining <= 0:
			return False
		time.sleep(min(0.01, remaining))


def _terminate_and_reap(child_pid: int) -> None:
	if child_pid <= 0:
		raise ValueError(f"expected an owned child PID, received {child_pid}")
	try:
		os.kill(child_pid, signal.SIGTERM)
	except ProcessLookupError:
		pass
	if _wait_child_until(child_pid, time.monotonic() + SETUP_TERMINATION_GRACE):
		return
	try:
		os.kill(child_pid, signal.SIGKILL)
	except ProcessLookupError:
		pass
	while True:
		try:
			waited_pid, _ = os.waitpid(child_pid, 0)
		except InterruptedError:
			continue
		except ChildProcessError:
			return
		if waited_pid == child_pid:
			return


def _setup_application_child(child_pid: int, slave_fd: int, pid_path: Path) -> None:
	try:
		_set_child_process_group(child_pid)
		signal.signal(signal.SIGTTOU, signal.SIG_IGN)
		os.tcsetpgrp(slave_fd, child_pid)
		pid_path.write_text(f"{child_pid}\n", encoding="utf-8")
	except BaseException:
		_terminate_and_reap(child_pid)
		raise


class PTYChild:
	def __init__(self, scenario: str, directory: Path, application: Path = APP) -> None:
		self.scenario = scenario
		self.directory = directory
		self.application = application
		self.cwd = directory / "cwd"
		self.cwd.mkdir()
		self.home = directory / "home"
		self.home.mkdir()
		self.phi_home = directory / "phi-home"
		self.phi_home.mkdir(mode=0o700)
		self.config = directory / "config"
		self.config.mkdir()
		self.markers_path = directory / "markers.jsonl"
		self.start_gate = directory / "start"
		self.failure_gate = directory / "fail-initialization"
		self.finish_gate = directory / "finish-supervisor"
		self.node_pid_path = directory / "node.pid"
		self.master, self.slave = os.openpty()
		self.set_size(80, 24)
		self.original = termios.tcgetattr(self.slave)
		self.mode_history: dict[str, dict[str, bool]] = {"before": mode_snapshot(self.original)}
		self.output = bytearray()
		self.events: list[dict[str, object]] = []
		self.marker_line = 0
		self.supervisor_event = 0
		self.responded_queries = 0
		self.responded_kitty_queries = 0
		self.stop_signal: int | None = None
		self.continued_observed = False
		self.continued_source: str | None = None
		self.post_resume_input_observed = False
		self.supervisor_pid = os.fork()
		if self.supervisor_pid == 0:
			self._supervise()
		os.set_blocking(self.master, False)
		self.stopped = False
		self.node_exit_code: int | None = None
		self.start_gate.write_text("start\n", encoding="utf-8")
		deadline = time.monotonic() + TIMEOUT
		while not self.node_pid_path.exists() and time.monotonic() < deadline:
			self.pump(0.01)
		if not self.node_pid_path.exists():
			self.release_supervisor()
			raise AssertionError(f"PTY supervisor did not report its application child: {self.events}")
		self.pid = int(self.node_pid_path.read_text(encoding="utf-8"))

	def _record_supervisor(self, event: str, **detail: object) -> None:
		with self.markers_path.open("a", encoding="utf-8") as output:
			output.write(f"{json.dumps({'event': event, **detail})}\n")

	def _supervise(self) -> None:
		try:
			os.close(self.master)
			os.setsid()
			fcntl.ioctl(self.slave, termios.TIOCSCTTY, 0)
			node_pid = os.fork()
			if node_pid == 0:
				self._exec_node()
			_setup_application_child(node_pid, self.slave, self.node_pid_path)
			stopped = False
			terminal_restored_while_stopped = False
			while True:
				status = os.waitid(os.P_PID, node_pid, os.WEXITED | os.WSTOPPED | os.WCONTINUED | os.WNOHANG)
				if status is not None and status.si_pid:
					if status.si_code == os.CLD_STOPPED:
						stopped = True
						terminal_restored_while_stopped = termios.tcgetattr(self.slave) == self.original
						self._record_supervisor("process-stopped", signal=status.si_status)
					elif status.si_code == os.CLD_CONTINUED:
						stopped = False
						terminal_restored_while_stopped = False
						self._record_supervisor("process-continued", source="kernel-wait-event")
					else:
						break
					continue
				if stopped and terminal_restored_while_stopped and mode_snapshot(termios.tcgetattr(self.slave))["raw"]:
					stopped = False
					terminal_restored_while_stopped = False
					self._record_supervisor("process-continued", source="termios-transition")
					continue
				time.sleep(0.01)
			os.tcsetpgrp(self.slave, os.getpgrp())
			if status.si_code == os.CLD_EXITED:
				code = status.si_status
			else:
				code = 128 + status.si_status
			self._record_supervisor("process-exited", code=code)
			while not self.finish_gate.exists():
				time.sleep(0.01)
			os._exit(0)
		except BaseException as error:
			self._record_supervisor("supervisor-error", message=str(error))
			os._exit(127)

	def _exec_node(self) -> None:
		try:
			os.setpgid(0, 0)
			for target in (0, 1, 2):
				os.dup2(self.slave, target)
			if self.slave > 2:
				os.close(self.slave)
			environment = {
				"PATH": f"{PATH_PREFIX}:/usr/bin:/bin:/usr/sbin:/sbin",
				"HOME": str(self.home),
				"TMPDIR": str(self.directory),
				"LANG": os.environ.get("LANG", "C.UTF-8"),
				"TERM": "xterm-256color",
				"PI_PROGRAM_STATUS": "0",
				"PHI_HOME": str(self.phi_home),
				"CLAUDE_CONFIG_DIR": str(self.config),
				"PHI_PTY_MARKERS": str(self.markers_path),
				"PHI_PTY_START_GATE": str(self.start_gate),
				"PHI_PTY_FAILURE_GATE": str(self.failure_gate),
				"PHI_PTY_CWD": str(self.cwd),
			}
			node = shutil.which("node", path=environment["PATH"])
			if not node:
				raise RuntimeError("node was not found on the test PATH")
			os.execvpe(node, [node, str(self.application), self.scenario], environment)
		except BaseException as error:
			os.write(2, f"PTY child launch failed: {error}\n".encode())
			os._exit(127)

	def set_size(self, columns: int, rows: int) -> None:
		fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))

	def send(self, data: bytes) -> None:
		deadline = time.monotonic() + TIMEOUT
		offset = 0
		while offset < len(data):
			try:
				written = os.write(self.master, data[offset : offset + 4096])
			except InterruptedError:
				continue
			except BlockingIOError:
				remaining = deadline - time.monotonic()
				if remaining <= 0:
					raise TimeoutError(f"PTY input timed out after {offset}/{len(data)} bytes")
				try:
					readable, writable, _ = select.select([self.master], [self.master], [], remaining)
				except InterruptedError:
					continue
				if readable:
					self.pump(0)
				if not writable and not readable:
					raise TimeoutError(f"PTY input timed out after {offset}/{len(data)} bytes")
				continue
			if written <= 0:
				raise TimeoutError(f"PTY input stopped after {offset}/{len(data)} bytes")
			offset += written
			if len(data) > 4096 and offset < len(data):
				self.pump(0)

	def _read_events(self) -> None:
		if not self.markers_path.exists():
			return
		lines = self.markers_path.read_text(encoding="utf-8").splitlines()
		while self.marker_line < len(lines):
			line = lines[self.marker_line]
			try:
				event = json.loads(line)
			except json.JSONDecodeError:
				return
			self.events.append(event)
			self.marker_line += 1

	def _answer_device_attribute_queries(self) -> None:
		if self.scenario == "kitty":
			kitty_query_count = self.output.count(KITTY_PROTOCOL_QUERY)
			while self.responded_kitty_queries < kitty_query_count:
				self.responded_kitty_queries += 1
				self.send(KITTY_PROTOCOL_REPLY)
		query_count = self.output.count(DA_QUERY)
		while self.responded_queries < query_count:
			os.write(self.master, DA_REPLY)
			self.responded_queries += 1

	def _poll_child(self) -> None:
		while self.supervisor_event < len(self.events):
			event = self.events[self.supervisor_event]
			self.supervisor_event += 1
			if event.get("event") == "process-stopped":
				self.stop_signal = int(event["signal"])
				self.stopped = True
			elif event.get("event") == "process-continued":
				self.continued_observed = True
				source = event.get("source")
				self.continued_source = source if isinstance(source, str) else None
				self.stopped = False
			elif event.get("event") == "process-exited":
				self.node_exit_code = int(event["code"])

	def pump(self, timeout: float = 0.02) -> None:
		try:
			readable, _, _ = select.select([self.master], [], [], timeout)
		except (OSError, ValueError):
			readable = []
		if readable:
			while True:
				try:
					chunk = os.read(self.master, 65536)
				except BlockingIOError:
					break
				except OSError:
					break
				if not chunk:
					break
				self.output.extend(chunk)
				self._answer_device_attribute_queries()
		self._read_events()
		self._poll_child()

	def wait_event(
		self,
		name: str,
		predicate: Callable[[dict[str, object]], bool] | None = None,
		*,
		since: int = 0,
		timeout: float = TIMEOUT,
	) -> dict[str, object]:
		deadline = time.monotonic() + timeout
		while time.monotonic() < deadline:
			for event in self.events[since:]:
				if event.get("event") == name and (predicate is None or predicate(event)):
					return event
			self.pump(min(0.02, max(0, deadline - time.monotonic())))
		if self.node_exit_code is not None:
			raise AssertionError(f"child exited before marker {name!r}: {self.exit_code()}")
		self._read_events()
		for event in self.events[since:]:
			if event.get("event") == name and (predicate is None or predicate(event)):
				return event
		raise AssertionError(f"timed out waiting for marker {name!r}; markers={self.events[since:]}")

	def wait_output(self, text: str, *, timeout: float = TIMEOUT) -> None:
		expected = text.encode("utf-8")
		deadline = time.monotonic() + timeout
		while time.monotonic() < deadline:
			if expected in self.output:
				return
			self.pump(min(0.02, max(0, deadline - time.monotonic())))
		raise AssertionError(f"timed out waiting for visible terminal text {text!r}")

	def wait_output_growth(self, old_length: int, *, timeout: float = TIMEOUT) -> None:
		deadline = time.monotonic() + timeout
		while time.monotonic() < deadline:
			if len(self.output) > old_length:
				return
			self.pump(min(0.02, max(0, deadline - time.monotonic())))
		raise AssertionError("terminal did not repaint after the PTY window size changed")

	def wait_raw_mode(self, *, raw: bool, timeout: float = TIMEOUT) -> None:
		deadline = time.monotonic() + timeout
		while time.monotonic() < deadline:
			if mode_snapshot(termios.tcgetattr(self.slave))["raw"] is raw:
				return
			self.pump(0.005)
		raise AssertionError(f"terminal raw mode did not become {raw}")

	def wait_stopped(self, *, timeout: float = TIMEOUT) -> int:
		deadline = time.monotonic() + timeout
		while time.monotonic() < deadline:
			self.pump(0.02)
			if self.stopped:
				if self.stop_signal is None:
					raise AssertionError("supervisor did not report the child's stop signal")
				return self.stop_signal
			if self.node_exit_code is not None:
				raise AssertionError(f"child exited instead of suspending: {self.exit_code()}")
		raise AssertionError("child did not stop after Ctrl+Z")

	def wait_continued(self, *, timeout: float = TIMEOUT) -> None:
		deadline = time.monotonic() + timeout
		while time.monotonic() < deadline:
			self.pump(0.02)
			if self.continued_observed:
				return
			if self.node_exit_code is not None:
				raise AssertionError(f"child exited before the supervisor observed SIGCONT: {self.exit_code()}")
		raise AssertionError("supervisor did not observe the child continue after SIGCONT")

	def wait_exit(self, *, timeout: float = TIMEOUT) -> int:
		deadline = time.monotonic() + timeout
		while time.monotonic() < deadline:
			self.pump(0.02)
			if self.node_exit_code is not None:
				return self.exit_code()
		raise AssertionError("child did not exit within the bounded wait")

	def exit_code(self) -> int:
		if self.node_exit_code is None:
			raise AssertionError("child has not exited")
		return self.node_exit_code

	def mode_error(self, *, expect_restored: bool) -> str | None:
		current = termios.tcgetattr(self.slave)
		mode = mode_snapshot(current)
		if not expect_restored:
			if not mode["raw"] or mode["echo"] or mode["canonical"]:
				return f"expected raw/no-echo mode, observed {mode}"
			return None
		if current != self.original:
			changed = [name for index, name in enumerate(("iflag", "oflag", "cflag", "lflag", "ispeed", "ospeed", "cc")) if current[index] != self.original[index]]
			return f"terminal settings were not restored exactly; changed fields={changed}, mode={mode}"
		return None

	def cleanup(self) -> list[str]:
		issues: list[str] = []
		if self.node_exit_code is None:
			if self.scenario == "initialization-failure":
				self.failure_gate.write_text("fail\n", encoding="utf-8")
			if self.stopped:
				try:
					os.kill(self.pid, signal.SIGCONT)
					time.sleep(0.03)
				except ProcessLookupError:
					pass
			try:
				os.kill(self.pid, signal.SIGTERM)
			except ProcessLookupError:
				pass
			try:
				self.wait_exit(timeout=1.5)
			except AssertionError:
				try:
					os.kill(self.pid, signal.SIGKILL)
				except ProcessLookupError:
					pass
				self.wait_exit(timeout=1.0)
				issues.append("emergency SIGKILL was required; graceful cleanup is unverified")
		for _ in range(3):
			self.pump(0.01)
		mode_issue = self.mode_error(expect_restored=True)
		if mode_issue:
			issues.append(mode_issue)
		return issues

	def release_supervisor(self) -> None:
		self.finish_gate.write_text("finish\n", encoding="utf-8")
		deadline = time.monotonic() + 2.0
		while time.monotonic() < deadline:
			pid, _ = os.waitpid(self.supervisor_pid, os.WNOHANG)
			if pid == self.supervisor_pid:
				return
			time.sleep(0.01)
		try:
			os.kill(self.supervisor_pid, signal.SIGKILL)
		except ProcessLookupError:
			pass
		os.waitpid(self.supervisor_pid, 0)
