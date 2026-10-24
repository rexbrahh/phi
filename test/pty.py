#!/usr/bin/env python3
"""Exercise the current Phi application through a real POSIX PTY."""

from __future__ import annotations

import json
import os
import signal
import sys
import tempfile
import termios
from pathlib import Path
from typing import Callable

sys.dont_write_bytecode = True

from helpers.pty_harness import APP, PTYChild, mode_snapshot


def check(issues: list[str], condition: bool, message: str) -> None:
	if not condition:
		issues.append(message)


def run_input(child: PTYChild, issues: list[str]) -> None:
	child.send(b"single-line\r")
	first = child.wait_event("user-input", lambda event: event.get("content") == "single-line")
	check(issues, first.get("origin") == "human", "single-line Enter did not produce a human input")
	child.send(b"first line\n")
	child.send(b"second line\r")
	second = child.wait_event("user-input", lambda event: event.get("content") == "first line\nsecond line")
	check(issues, second.get("origin") == "human", "multiline Enter did not produce a human input")
	child.send(b"\x03")
	exit_event = child.wait_event("exit")
	check(issues, exit_event.get("code") == 0, f"Ctrl+C returned {exit_event.get('code')}, expected 0")
	check(issues, exit_event.get("queryCloseCalls") == 1, "session query was not closed exactly once")
	check(issues, child.wait_exit() == 0, "process exit code was not 0")
	check(issues, child.mode_error(expect_restored=True) is None, "Ctrl+C did not restore exact terminal settings")


def run_paste(child: PTYChild, issues: list[str]) -> None:
	paste = "first pasted line\nsecond pasted line"
	child.send(b"\x1b[200~" + paste.encode() + b"\x1b[201~\r")
	event = child.wait_event("user-input", lambda item: item.get("content") == paste)
	check(issues, event.get("inlinePastes") == [paste], "bracketed paste was not retained as one inline paste")
	child.send(b"\x03")
	exit_event = child.wait_event("exit")
	check(issues, exit_event.get("code") == 0, "paste scenario did not close through Ctrl+C")
	check(issues, exit_event.get("queryCloseCalls") == 1, "paste scenario did not close the session query once")
	check(issues, child.wait_exit() == 0, "paste scenario process exit code was not 0")
	check(issues, child.mode_error(expect_restored=True) is None, "paste scenario did not restore exact terminal settings")


def run_resize(child: PTYChild, issues: list[str]) -> None:
	child.pump(0.12)
	old_length = len(child.output)
	child.set_size(37, 11)
	event = child.wait_event("terminal-size", lambda item: item.get("columns") == 37 and item.get("rows") == 11)
	check(issues, event.get("columns") == 37 and event.get("rows") == 11, "app did not observe the resized PTY dimensions")
	child.wait_output_growth(old_length)
	child.send(b"\x03")
	exit_event = child.wait_event("exit")
	check(issues, exit_event.get("code") == 0, "resize scenario did not close through Ctrl+C")
	check(issues, exit_event.get("queryCloseCalls") == 1, "resize scenario did not close the session query once")
	check(issues, child.wait_exit() == 0, "resize scenario process exit code was not 0")
	check(issues, child.mode_error(expect_restored=True) is None, "resize scenario did not restore exact terminal settings")


def run_escape(child: PTYChild, issues: list[str]) -> None:
	child.send(b"\x14")
	child.wait_event("active-view", lambda event: event.get("panel") == "tasks")
	child.wait_output("Tasks · Ctrl+T")
	child.send(b"\x1b")
	child.wait_event("active-view", lambda event: event.get("panel") == "transcript")
	check(issues, not any(event.get("event") == "interrupt" for event in child.events), "Escape interrupted before closing the task inspector")
	child.send(b"\x1b")
	child.wait_event("interrupt", lambda event: event.get("count") == 1)
	child.wait_event("foreground-idle")
	child.send(b"\x03")
	exit_event = child.wait_event("exit")
	check(issues, exit_event.get("code") == 0, "Escape scenario did not close through Ctrl+C after the interrupt")
	check(issues, exit_event.get("queryCloseCalls") == 1, "Escape scenario did not close the session query once")
	check(issues, child.wait_exit() == 0, "Escape scenario process exit code was not 0")
	check(issues, child.mode_error(expect_restored=True) is None, "Escape scenario did not restore exact terminal settings")


def run_dialog(child: PTYChild, issues: list[str]) -> None:
	for request_id, key, expected in (("pty-cancel", b"c", "cancel"), ("pty-decline", b"d", "decline")):
		child.wait_event("dialog-open", lambda event: event.get("requestId") == request_id)
		child.wait_output(f"https://example.invalid/{request_id}")
		child.send(key)
		result = child.wait_event("dialog-result", lambda event: event.get("requestId") == request_id)
		check(issues, result.get("action") == expected, f"{request_id} returned {result.get('action')}, expected {expected}")
	child.wait_event("dialogs-complete")
	child.send(b"\x03")
	exit_event = child.wait_event("exit")
	check(issues, exit_event.get("code") == 0, "dialog scenario did not close through Ctrl+C")
	check(issues, exit_event.get("queryCloseCalls") == 1, "dialog scenario did not close the session query once")
	check(issues, child.wait_exit() == 0, "dialog scenario process exit code was not 0")
	check(issues, child.mode_error(expect_restored=True) is None, "dialog scenario did not restore exact terminal settings")


def run_suspend(child: PTYChild, issues: list[str]) -> None:
	child.send(b"\x1a")
	stop_signal = child.wait_stopped()
	check(issues, stop_signal == signal.SIGTSTP, f"Ctrl+Z stopped with signal {stop_signal}, expected SIGTSTP")
	suspended = termios.tcgetattr(child.slave)
	child.mode_history["suspended"] = mode_snapshot(suspended)
	check(issues, child.mode_error(expect_restored=True) is None, "terminal was not restored while the process was suspended")
	os.kill(child.pid, signal.SIGCONT)
	child.wait_continued()
	check(issues, child.continued_observed, "supervisor did not observe the child continue after SIGCONT")
	check(
		issues,
		child.continued_source in {"kernel-wait-event", "termios-transition"},
		f"supervisor continuation marker had unknown source {child.continued_source!r}",
	)
	child.wait_raw_mode(raw=True)
	resumed = termios.tcgetattr(child.slave)
	child.mode_history["resumed"] = mode_snapshot(resumed)
	child.send(b"after resume\r")
	child.wait_event("user-input", lambda event: event.get("content") == "after resume")
	child.post_resume_input_observed = True
	child.send(b"\x03")
	exit_event = child.wait_event("exit")
	check(issues, exit_event.get("code") == 0, "resumed scenario did not close through Ctrl+C")
	check(issues, exit_event.get("queryCloseCalls") == 1, "resumed scenario did not close the session query once")
	check(issues, child.wait_exit() == 0, "resumed scenario process exit code was not 0")
	check(issues, child.mode_error(expect_restored=True) is None, "suspend/resume did not restore exact terminal settings on exit")


def run_initialization_failure(child: PTYChild, issues: list[str]) -> None:
	exit_event = child.wait_event("exit")
	check(issues, exit_event.get("code") == 1, f"initialization failure returned {exit_event.get('code')}, expected 1")
	check(issues, exit_event.get("queryCloseCalls") == 1, "failed session query was not closed exactly once")
	check(issues, child.wait_exit() == 1, "initialization failure process exit code was not 1")
	check(issues, child.mode_error(expect_restored=True) is None, "initialization failure did not restore exact terminal settings")


def run_sigterm(child: PTYChild, issues: list[str]) -> None:
	os.kill(child.pid, signal.SIGTERM)
	exit_event = child.wait_event("exit")
	check(issues, exit_event.get("code") == 143, f"SIGTERM returned {exit_event.get('code')}, expected 143")
	check(issues, exit_event.get("queryCloseCalls") == 1, "SIGTERM did not close the session query exactly once")
	check(issues, child.wait_exit() == 143, "SIGTERM process exit code was not 143")
	check(issues, child.mode_error(expect_restored=True) is None, "SIGTERM did not restore exact terminal settings")


def main() -> int:
	if not APP.is_file():
		print(f"Missing compiled PTY helper: {APP}; run `npm run build` first", file=sys.stderr)
		return 2
	cases: list[tuple[str, str, Callable[[PTYChild, list[str]], None]]] = [
		("Enter and multiline input", "input", run_input),
		("bracketed paste", "paste", run_paste),
		("PTY resize", "resize", run_resize),
		("Escape precedence", "escape", run_escape),
		("native dialog cancel and decline", "dialog", run_dialog),
		("suspend and resume", "suspend", run_suspend),
		("SDK initialization failure cleanup", "initialization-failure", run_initialization_failure),
		("SIGTERM cleanup", "sigterm", run_sigterm),
	]
	results: list[dict[str, object]] = []
	for name, scenario, action in cases:
		with tempfile.TemporaryDirectory(prefix="phi-pty-case-") as temporary:
			child = PTYChild(scenario, Path(temporary))
			issues: list[str] = []
			modes = child.mode_history
			try:
				child.wait_event("terminal-raw")
				modes["during"] = mode_snapshot(termios.tcgetattr(child.slave))
				raw_issue = child.mode_error(expect_restored=False)
				check(issues, raw_issue is None, raw_issue or "")
				if scenario == "initialization-failure":
					child.failure_gate.write_text("fail\n", encoding="utf-8")
				else:
					child.wait_event("app-ready")
				action(child, issues)
			except Exception as error:
				issues.append(f"{type(error).__name__}: {error}")
			finally:
				issues.extend(child.cleanup())
				actual = termios.tcgetattr(child.slave)
				modes["after"] = mode_snapshot(actual)
				modes["exactlyRestored"] = actual == child.original
				child.release_supervisor()
				results.append({
					"name": name,
					"passed": not issues,
					"issues": issues,
					"exitCode": child.exit_code() if child.node_exit_code is not None else None,
					"events": len(child.events),
					"terminalModes": modes,
					"continuedSource": child.continued_source if scenario == "suspend" else None,
					"postResumeInputObserved": child.post_resume_input_observed if scenario == "suspend" else None,
				})
				for descriptor in (child.master, child.slave):
					try:
						os.close(descriptor)
					except OSError:
						pass
		status = "PASS" if results[-1]["passed"] else "FAIL"
		print(f"{status}: {name}")
		for issue in results[-1]["issues"]:
			print(f"  {issue}")
		if not results[-1]["passed"]:
			print(f"  markers={json.dumps(child.events, ensure_ascii=False)}")
			print(f"  terminal_output_tail={child.output[-800:].decode('utf-8', errors='replace')!r}")
	passed = sum(bool(result["passed"]) for result in results)
	print(f"PTY scenarios: {passed}/{len(results)} passed")
	for result in results:
		print(f"  {result['name']}: {json.dumps(result['terminalModes'])}")
		if result["continuedSource"] is not None:
			print(
				f"    continuation source={result['continuedSource']}; "
				f"post-resume input observed={result['postResumeInputObserved']}"
			)
	return 0 if passed == len(results) else 1


if __name__ == "__main__":
	sys.exit(main())
