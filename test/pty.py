#!/usr/bin/env python3
"""Exercise the current Phi application through a real POSIX PTY."""

from __future__ import annotations

import json
import os
import signal
import sys
import tempfile
import termios
import traceback
from pathlib import Path
from typing import Callable

sys.dont_write_bytecode = True

from helpers.pty_harness import APP, AUTH_APP, ROOT, PTYChild, mode_snapshot


AUTH_TEST_KEY = b"phi_pty_test_saved_secret"
AUTH_CANCEL_PARTIAL = b"phi_pty_cancel_partial_secret"
MAX_FAILURE_MARKERS = 64 * 1024
MAX_FAILURE_OUTPUT = 32 * 1024


def write_private_file(path: Path, content: bytes) -> None:
	file_descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
	with os.fdopen(file_descriptor, "wb") as output:
		output.write(content)


def preserve_failure_artifact(
	name: str,
	scenario: str,
	child: PTYChild,
	issues: list[str],
	primary_error: dict[str, str] | None,
	snapshot: dict[str, object],
	*,
	phase: str,
	artifact_dir: Path | None = None,
) -> Path:
	if artifact_dir is None:
		artifact_root = ROOT / ".superpowers" / "pty-render-diagnostics"
		artifact_root.mkdir(mode=0o700, parents=True, exist_ok=True)
		os.chmod(artifact_root, 0o700)
		artifact_dir = Path(tempfile.mkdtemp(prefix=f"{scenario}-", dir=artifact_root))
		os.chmod(artifact_dir, 0o700)
	secret_values = (AUTH_TEST_KEY, AUTH_CANCEL_PARTIAL)

	def redact(data: bytes) -> bytes:
		for secret in secret_values:
			data = data.replace(secret, b"<redacted>")
		return data

	events = snapshot.get("supervisorEvents")
	if isinstance(events, list):
		snapshot["supervisorEvents"] = summarize_events(events[-128:])
	metadata = {
		"case": name,
		"scenario": scenario,
		"primaryError": primary_error,
		"issues": issues,
		phase: snapshot,
		"artifacts": {
			"markers": f"markers-{phase}.jsonl (tail, at most {MAX_FAILURE_MARKERS} bytes)",
			"terminalOutput": f"terminal-output-{phase}.bin (tail, at most {MAX_FAILURE_OUTPUT} bytes; synthetic keys redacted)",
		},
	}
	metadata_name = "failure.json" if phase == "before-cleanup" else "after-cleanup.json"
	write_private_file(artifact_dir / metadata_name, redact(json.dumps(metadata, ensure_ascii=False, indent=2).encode("utf-8")))
	try:
		marker_bytes = redact(child.markers_path.read_bytes())
	except OSError as error:
		marker_bytes = f"<could not read marker file: {type(error).__name__}: {error}>".encode()
	marker_tail = marker_bytes[-MAX_FAILURE_MARKERS:]
	write_private_file(artifact_dir / f"markers-{phase}.jsonl", marker_tail)
	output_bytes = redact(bytes(child.output))
	write_private_file(artifact_dir / f"terminal-output-{phase}.bin", output_bytes[-MAX_FAILURE_OUTPUT:])
	return artifact_dir


def check(issues: list[str], condition: bool, message: str) -> None:
	if not condition:
		issues.append(message)


def summarize_events(events: list[dict[str, object]]) -> list[dict[str, object]]:
	summaries: list[dict[str, object]] = []
	for event in events:
		summary = dict(event)
		content = summary.get("content")
		if isinstance(content, str) and len(content) > 256:
			summary["content"] = f"<{len(content)} characters>"
		pastes = summary.get("inlinePastes")
		if isinstance(pastes, list):
			summary["inlinePastes"] = [
				f"<{len(paste)} characters>" if isinstance(paste, str) and len(paste) > 256 else paste
				for paste in pastes
			]
		summaries.append(summary)
	return summaries


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


def run_long_paste(child: PTYChild, issues: list[str]) -> None:
	paste = "paste-λ漢\n" * 2047 + "paste-λ漢-end"
	child.send(b"\x1b[200~" + paste.encode("utf-8") + b"\x1b[201~\r")
	event = child.wait_event("user-input")
	actual = event.get("content")
	actual_length = len(actual) if isinstance(actual, str) else None
	first_difference = next(
		(index for index, pair in enumerate(zip(paste, actual)) if pair[0] != pair[1]),
		min(len(paste), len(actual)),
	) if isinstance(actual, str) else None
	check(
		issues,
		actual == paste,
		f"long paste receipt differed: expected {len(paste)} chars, got {actual_length}, first difference={first_difference}",
	)
	check(issues, event.get("origin") == "human", "long paste did not produce a human input receipt")
	check(issues, event.get("inlinePastes") == [paste], "long bracketed paste was not retained as one inline paste")
	child.send(b"\x03")
	exit_event = child.wait_event("exit")
	check(issues, exit_event.get("code") == 0, "long-paste scenario did not close through Ctrl+C")
	check(issues, exit_event.get("queryCloseCalls") == 1, "long-paste scenario did not close the session query once")
	check(issues, child.wait_exit() == 0, "long-paste scenario process exit code was not 0")
	check(issues, not any(event.get("event") == "harness-error" for event in child.events), "long-paste scenario reported an app error")
	check(issues, child.mode_error(expect_restored=True) is None, "long-paste scenario did not restore exact terminal settings")


def run_resize(child: PTYChild, issues: list[str]) -> None:
	child.pump(0.12)
	old_length = len(child.output)
	child.set_size(9, 3)
	event = child.wait_event("terminal-size", lambda item: item.get("columns") == 9 and item.get("rows") == 3)
	check(issues, event.get("columns") == 9 and event.get("rows") == 3, "app did not observe the tiny PTY dimensions")
	child.wait_output_growth(old_length)
	child.send("tiny-screen λ\r".encode("utf-8"))
	input_event = child.wait_event("user-input", lambda item: item.get("content") == "tiny-screen λ")
	check(issues, input_event.get("origin") == "human", "tiny-terminal input did not produce a human receipt")
	old_length = len(child.output)
	child.set_size(37, 11)
	event = child.wait_event("terminal-size", lambda item: item.get("columns") == 37 and item.get("rows") == 11)
	check(issues, event.get("columns") == 37 and event.get("rows") == 11, "app did not observe the expanded PTY dimensions")
	child.wait_output_growth(old_length)
	child.send(b"\x03")
	exit_event = child.wait_event("exit")
	check(issues, exit_event.get("code") == 0, "tiny-resize scenario did not close through Ctrl+C")
	check(issues, exit_event.get("queryCloseCalls") == 1, "tiny-resize scenario did not close the session query once")
	check(issues, child.wait_exit() == 0, "tiny-resize scenario process exit code was not 0")
	check(issues, not any(event.get("event") == "harness-error" for event in child.events), "tiny-resize scenario reported an app error")
	check(issues, child.mode_error(expect_restored=True) is None, "tiny-resize scenario did not restore exact terminal settings")


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
	child.wait_event("dialog-open", lambda event: event.get("requestId") == "pty-visible-cancel")
	child.send(b"\x1b[200~modal paste must be discarded\x1b[201~")
	child.send(b"\x03")
	cancelled = child.wait_event("dialog-result", lambda event: event.get("requestId") == "pty-visible-cancel")
	check(issues, cancelled.get("action") == "cancel", "Ctrl+C did not cancel the visible native request")
	check(issues, not any(event.get("event") == "exit" for event in child.events), "Ctrl+C closed Phi after cancelling the visible request")
	check(issues, b"modal paste must be discarded" not in child.output, "visible dialog rendered its bracketed paste into the composer")
	child.send(b"continued after cancellation\r")
	continued = child.wait_event("user-input", lambda event: event.get("content") == "continued after cancellation")
	check(issues, continued.get("origin") == "human", "input was not accepted after visible-request cancellation")
	check(issues, continued.get("inlinePastes") == [], "cancelled dialog paste metadata reached the next input")
	child.wait_event("dialogs-complete")
	child.send(b"\x03")
	exit_event = child.wait_event("exit")
	check(issues, exit_event.get("code") == 0, "dialog scenario did not close through Ctrl+C")
	check(issues, exit_event.get("queryCloseCalls") == 1, "dialog scenario did not close the session query once")
	check(issues, child.wait_exit() == 0, "dialog scenario process exit code was not 0")
	check(issues, child.mode_error(expect_restored=True) is None, "dialog scenario did not restore exact terminal settings")


def run_kitty(child: PTYChild, issues: list[str]) -> None:
	active = child.wait_event("kitty-protocol-active", lambda event: event.get("active") is True)
	check(issues, active.get("active") is True, "fake terminal did not activate Kitty keyboard input")
	check(issues, child.responded_kitty_queries == 1, "fake terminal did not answer one Kitty capability query")
	child.send(b"\x1b[955;1u\x1b[128578;1u\x1b[13;1u")
	event = child.wait_event("user-input", lambda item: item.get("content") == "λ🙂")
	check(issues, event.get("origin") == "human", "Kitty Unicode keys did not produce a human input receipt")
	check(issues, event.get("inlinePastes") == [], "Kitty Unicode keys were marked as a paste")
	check(issues, b"\x1b[>7u" in child.output and b"\x1b[?u" in child.output, "app did not request Kitty keyboard flags")
	child.send(b"\x03")
	exit_event = child.wait_event("exit")
	check(issues, exit_event.get("code") == 0, "Kitty scenario did not close through Ctrl+C")
	check(issues, exit_event.get("queryCloseCalls") == 1, "Kitty scenario did not close the session query once")
	check(issues, child.wait_exit() == 0, "Kitty scenario process exit code was not 0")
	check(issues, b"\x1b[<u" in child.output, "app did not pop Kitty keyboard flags on exit")
	check(issues, child.mode_error(expect_restored=True) is None, "Kitty scenario did not restore exact terminal settings")


def run_repeat_interrupt_exit(child: PTYChild, issues: list[str]) -> None:
	child.send(b"unsent draft")
	draft = child.wait_event("draft", lambda event: event.get("content") == "unsent draft")
	check(issues, draft.get("content") == "unsent draft", "composer did not retain the unsent draft")
	child.send(b"\x03")
	first_interrupt = child.wait_event("interrupt", lambda event: event.get("count") == 1)
	check(issues, first_interrupt.get("count") == 1, "first Ctrl+C did not interrupt foreground work once")
	check(issues, not any(event.get("event") == "exit" for event in child.events), "first interrupt closed Phi")
	child.send(b"\x03")
	second_interrupt = child.wait_event("interrupt", lambda event: event.get("count") == 2)
	check(issues, second_interrupt.get("count") == 2, "second Ctrl+C did not interrupt foreground work")
	child.wait_event("foreground-idle")
	check(issues, not any(event.get("event") == "exit" for event in child.events), "repeated interrupts closed Phi before user exit")
	child.send(b"\x03")
	child.wait_event("exit-confirmation", lambda event: event.get("visible") is True)
	confirmation_event = len(child.events)
	child.send(b"\x1b")
	child.wait_event("exit-confirmation", lambda event: event.get("visible") is False, since=confirmation_event)
	child.send(b"\r")
	submitted = child.wait_event("user-input", lambda event: event.get("content") == "unsent draft")
	check(issues, submitted.get("origin") == "human", "cancelled exit confirmation did not preserve a submit-ready draft")
	check(issues, submitted.get("inlinePastes") == [], "draft submission carried stale paste metadata")
	child.send(b"\x03\x03")
	exit_event = child.wait_event("exit")
	check(issues, exit_event.get("code") == 0, f"repeated exit returned {exit_event.get('code')}, expected 0")
	check(issues, exit_event.get("interruptCalls") == 2, "repeated exit changed the two accepted interrupt calls")
	check(issues, exit_event.get("queryCloseCalls") == 1, "repeated Ctrl+C closed the session query more than once")
	check(issues, child.wait_exit() == 0, "repeated-exit process exit code was not 0")
	check(issues, not any(event.get("event") == "harness-error" for event in child.events), "repeated-interrupt scenario reported an app error")
	check(issues, child.mode_error(expect_restored=True) is None, "repeated interrupt and exit did not restore exact terminal settings")


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
	check(issues, b"Could not start Phi: PTY initialization failure" in child.output, "initialization failure diagnostic was not visible in PTY output")
	check(issues, child.mode_error(expect_restored=True) is None, "initialization failure did not restore exact terminal settings")


def run_auth_save_restart(child: PTYChild, issues: list[str]) -> None:
	child.send(AUTH_TEST_KEY + b"\r")
	saved = child.wait_event("auth-login-saved")
	check(issues, saved.get("code") == 0, "auth login did not return success")
	check(issues, saved.get("apiKeyMatches") is True, "auth login did not save the synthetic key")
	check(issues, saved.get("authSource") == "saved", "saved key was not selected as the auth source")
	run_app = child.wait_event("run-app")
	check(issues, run_app.get("authSource") == "saved", "restart did not use saved auth")
	check(issues, run_app.get("apiKeyMatches") is True, "restart did not pass the saved key to the injected app")
	check(issues, run_app.get("parentEnvironmentUnchanged") is True, "restart mutated the parent environment")
	check(issues, run_app.get("backendQueries") == 0, "auth PTY test started a backend query")
	restarted = child.wait_event("auth-restart-complete")
	check(issues, restarted.get("code") == 0, "saved auth restart did not complete")
	check(issues, restarted.get("promptCalls") == 1, "saved auth restart prompted a second time")
	check(issues, restarted.get("runAppCalls") == 1, "saved auth restart did not call the injected app exactly once")
	check(issues, AUTH_TEST_KEY not in child.output, "synthetic key appeared in PTY output")
	check(issues, child.wait_exit() == 0, "auth save/restart wrapper did not exit successfully")
	check(issues, child.mode_error(expect_restored=True) is None, "auth save/restart did not restore exact terminal settings")


def run_auth_cancel(child: PTYChild, issues: list[str]) -> None:
	child.send(AUTH_CANCEL_PARTIAL)
	child.send(b"\x1b")
	cancelled = child.wait_event("auth-login-cancelled")
	check(issues, cancelled.get("code") == 1, "auth login cancellation did not return the cancellation code")
	check(issues, cancelled.get("authSource") == "missing", "cancelled auth created a saved auth source")
	check(issues, cancelled.get("saved") is False, "cancelled auth wrote a credential")
	check(issues, cancelled.get("runAppCalls") == 0, "cancelled auth reached the injected app")
	check(issues, not any(event.get("event") == "run-app" for event in child.events), "cancelled auth started an app")
	check(issues, AUTH_CANCEL_PARTIAL not in child.output, "partial key appeared in PTY output")
	check(issues, child.wait_exit() == 0, "auth cancellation wrapper did not exit successfully")
	check(issues, child.mode_error(expect_restored=True) is None, "auth cancellation did not restore exact terminal settings")


def run_sigterm(child: PTYChild, issues: list[str]) -> None:
	os.kill(child.pid, signal.SIGTERM)
	exit_event = child.wait_event("exit")
	check(issues, exit_event.get("code") == 143, f"SIGTERM returned {exit_event.get('code')}, expected 143")
	check(issues, exit_event.get("queryCloseCalls") == 1, "SIGTERM did not close the session query exactly once")
	check(issues, child.wait_exit() == 143, "SIGTERM process exit code was not 143")
	check(issues, child.mode_error(expect_restored=True) is None, "SIGTERM did not restore exact terminal settings")


def main() -> int:
	missing = [str(path) for path in (APP, AUTH_APP) if not path.is_file()]
	if missing:
		print(f"Missing compiled PTY helper(s): {', '.join(missing)}; run `npm run build` first", file=sys.stderr)
		return 2
	cases: list[tuple[str, str, Callable[[PTYChild, list[str]], None], Path]] = [
		("Enter and multiline input", "input", run_input, APP),
		("bracketed paste", "paste", run_paste, APP),
		("long bracketed paste", "paste", run_long_paste, APP),
		("tiny and resized PTY", "resize", run_resize, APP),
		("Escape precedence", "escape", run_escape, APP),
		("native dialog cancel and decline", "dialog", run_dialog, APP),
		("Kitty Unicode keyboard negotiation", "kitty", run_kitty, APP),
		("repeated interrupt and exit with a draft", "repeat-interrupt-exit", run_repeat_interrupt_exit, APP),
		("suspend and resume", "suspend", run_suspend, APP),
		("SDK initialization failure cleanup", "initialization-failure", run_initialization_failure, APP),
		("SIGTERM cleanup", "sigterm", run_sigterm, APP),
		("hidden auth save and restart", "save-restart", run_auth_save_restart, AUTH_APP),
		("hidden auth cancellation", "cancel", run_auth_cancel, AUTH_APP),
	]
	results: list[dict[str, object]] = []
	for name, scenario, action, application in cases:
		with tempfile.TemporaryDirectory(prefix="phi-pty-case-") as temporary:
			child = PTYChild(scenario, Path(temporary), application=application)
			issues: list[str] = []
			modes = child.mode_history
			primary_error: dict[str, str] | None = None
			before_cleanup: dict[str, object] | None = None
			failure_artifact: str | None = None
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
				primary_error = {
					"type": type(error).__name__,
					"message": str(error),
					"traceback": traceback.format_exc(),
				}
				issues.append(f"{type(error).__name__}: {error}")
				try:
					before_cleanup = child.diagnostic_snapshot()
				except BaseException as snapshot_error:
					issues.append(f"pre-cleanup diagnostic capture failed: {type(snapshot_error).__name__}: {snapshot_error}")
				if before_cleanup is not None:
					try:
						failure_artifact = str(preserve_failure_artifact(
							name,
							scenario,
							child,
							issues,
							primary_error,
							before_cleanup,
							phase="before-cleanup",
						))
					except BaseException as artifact_error:
						issues.append(f"pre-cleanup failure artifact write failed: {type(artifact_error).__name__}: {artifact_error}")
			finally:
				if issues and before_cleanup is None:
					try:
						before_cleanup = child.diagnostic_snapshot()
					except BaseException as snapshot_error:
						issues.append(f"pre-cleanup diagnostic capture failed: {type(snapshot_error).__name__}: {snapshot_error}")
				if issues and failure_artifact is None and before_cleanup is not None:
					try:
						failure_artifact = str(preserve_failure_artifact(
							name,
							scenario,
							child,
							issues,
							primary_error,
							before_cleanup,
							phase="before-cleanup",
						))
					except BaseException as artifact_error:
						issues.append(f"pre-cleanup failure artifact write failed: {type(artifact_error).__name__}: {artifact_error}")
				try:
					issues.extend(child.cleanup())
				except BaseException as cleanup_error:
					issues.append(f"cleanup raised {type(cleanup_error).__name__}: {cleanup_error}")
				try:
					actual = termios.tcgetattr(child.slave)
					modes["after"] = mode_snapshot(actual)
					modes["exactlyRestored"] = actual == child.original
				except BaseException as terminal_error:
					actual = None
					issues.append(f"post-cleanup terminal inspection failed: {type(terminal_error).__name__}: {terminal_error}")
				try:
					issues.extend(child.release_supervisor())
				except BaseException as supervisor_error:
					issues.append(f"supervisor release raised {type(supervisor_error).__name__}: {supervisor_error}")
				try:
					after_cleanup = child.diagnostic_snapshot()
				except BaseException as snapshot_error:
					after_cleanup = {"error": f"{type(snapshot_error).__name__}: {snapshot_error}"}
				if issues or failure_artifact:
					try:
						failure_artifact = str(preserve_failure_artifact(
							name,
							scenario,
							child,
							issues,
							primary_error,
							after_cleanup,
							phase="after-cleanup",
							artifact_dir=Path(failure_artifact) if failure_artifact else None,
						))
					except BaseException as artifact_error:
						issues.append(f"failure artifact write failed: {type(artifact_error).__name__}: {artifact_error}")
				for descriptor in (child.master, child.slave):
					try:
						os.close(descriptor)
					except OSError:
						pass
				results.append({
					"name": name,
					"passed": not issues,
					"issues": issues,
					"exitCode": child.exit_code() if child.node_exit_code is not None else None,
					"events": len(child.events),
					"terminalModes": modes,
					"continuedSource": child.continued_source if scenario == "suspend" else None,
					"postResumeInputObserved": child.post_resume_input_observed if scenario == "suspend" else None,
					"failureArtifact": failure_artifact,
				})
		status = "PASS" if results[-1]["passed"] else "FAIL"
		print(f"{status}: {name}")
		for issue in results[-1]["issues"]:
			print(f"  {issue}")
		if results[-1]["failureArtifact"]:
			print(f"  failure_artifact={results[-1]['failureArtifact']}")
		if not results[-1]["passed"] and not results[-1]["failureArtifact"]:
			print(f"  markers={json.dumps(summarize_events(child.events), ensure_ascii=False)}")
			tail = child.output[-800:].replace(AUTH_TEST_KEY, b"<redacted>").replace(AUTH_CANCEL_PARTIAL, b"<redacted>")
			print(f"  terminal_output_tail={tail.decode('utf-8', errors='replace')!r}")
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
