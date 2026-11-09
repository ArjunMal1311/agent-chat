import os
import stat
import tempfile
import textwrap
import unittest
from unittest import mock

from agentchat import runner
from agentchat.agents import Agent


def fake_claude(body):
    """A temporary `claude` executable; returns the folder to put first on PATH."""
    folder = tempfile.mkdtemp()
    path = os.path.join(folder, "claude")
    with open(path, "w") as fh:
        fh.write("#!/usr/bin/env python3\nimport sys, json, time\nsys.stdin.read()\n" + textwrap.dedent(body))
    os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC)
    return folder


def on_path(folder):
    return mock.patch.dict(os.environ, {"PATH": folder + os.pathsep + os.environ["PATH"]})


STREAM = """
print(json.dumps({"type": "system", "subtype": "hook_started"}), flush=True)
print("some hook noise", flush=True)
print(json.dumps({"type": "assistant", "message": {"content": [
    {"type": "tool_use", "name": "Read", "input": {"file_path": "/home/a/plans/gtm-plan.md"}}]}}), flush=True)
print(json.dumps({"type": "user", "message": {"content": [
    {"type": "tool_result", "is_error": True, "content": "boom   happened"}]}}), flush=True)
print(json.dumps({"type": "assistant", "message": {"content": [
    {"type": "tool_use", "name": "Bash", "input": {"command": "./socials   utils x tracking ideas"}}]}}), flush=True)
print(json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "final"}]}}), flush=True)
print(json.dumps({"type": "result", "subtype": "success", "is_error": False, "result": json.dumps(sys.argv[1:]),
    "total_cost_usd": 0.05, "duration_ms": 1500, "num_turns": 2,
    "usage": {"input_tokens": 3, "cache_creation_input_tokens": 100, "cache_read_input_tokens": 50, "output_tokens": 9},
    "modelUsage": {"claude-sonnet-5-5": {}}}), flush=True)
"""


class DescribeTests(unittest.TestCase):
    def test_tools_are_described_in_plain_words(self):
        self.assertEqual(runner.describe_tool("Read", {"file_path": "/a/b/c/gtm-plan.md"}), "Reading c/gtm-plan.md")
        self.assertEqual(runner.describe_tool("Grep", {"pattern": "seats"}), "Searching for “seats”")
        self.assertEqual(runner.describe_tool("Glob", {"pattern": "*.md"}), "Finding files *.md")
        self.assertEqual(runner.describe_tool("Bash", {"command": "./socials   utils\nx"}), "Running ./socials utils x")
        self.assertEqual(runner.describe_tool("Weird", {}), "Using Weird")
        self.assertEqual(len(runner.describe_tool("Bash", {"command": "x" * 500})), len("Running ") + 90)

    def test_events_become_steps_and_most_events_become_none(self):
        self.assertEqual(runner.describe_event({"type": "system", "subtype": "init"}), [])
        self.assertEqual(
            runner.describe_event({"type": "assistant", "message": {"content": [{"type": "text", "text": "hi"}]}}), []
        )
        failed = {"type": "user", "message": {"content": [{"type": "tool_result", "is_error": True, "content": [{"text": "no such file"}]}]}}
        self.assertEqual(runner.describe_event(failed), ["That step failed: no such file"])


class RunClaudeTests(unittest.TestCase):
    def test_steps_stream_out_and_the_result_is_read(self):
        agent = Agent("t", prompt="job", tools=["Read", "Bash(./socials utils x:*)"], model="haiku", timeout=20)
        steps = []
        with on_path(fake_claude(STREAM)):
            result = runner.run_claude(agent, "hello", on_step=steps.append)
        self.assertEqual(steps, ["Reading plans/gtm-plan.md", "That step failed: boom happened", "Running ./socials utils x tracking ideas"])
        self.assertEqual(result.usage["model"], "claude-sonnet-5-5")
        self.assertEqual(result.usage["in"], 153)
        self.assertEqual(result.usage["cost"], 0.05)
        self.assertEqual(result.usage["turns"], 2)
        argv = __import__("json").loads(result.text)  # the fake echoes the arguments it received
        for flag in ("-p", "--verbose", "--disable-slash-commands", "--strict-mcp-config", "--exclude-dynamic-system-prompt-sections"):
            self.assertIn(flag, argv)
        self.assertEqual(argv[argv.index("--model") + 1], "haiku")
        self.assertEqual(argv[argv.index("--allowedTools") + 1], "Read,Bash(./socials utils x:*)")
        self.assertEqual(argv[argv.index("--output-format") + 1], "stream-json")

    def test_rate_limit_reports_are_passed_on_and_not_treated_as_steps(self):
        body = (
            'print(json.dumps({"type": "rate_limit_event", "rate_limit_info": {"unifiedWindows": '
            '{"five_hour": {"utilization": 0.5, "resetsAt": 9, "status": "allowed"}}}}), flush=True)\n'
            'print(json.dumps({"type": "result", "is_error": False, "result": "ok"}), flush=True)'
        )
        reports, steps = [], []
        with on_path(fake_claude(body)):
            runner.run_claude(Agent("t", timeout=20), "hello", on_step=steps.append, on_limits=reports.append)
        self.assertEqual(steps, [])
        self.assertEqual(reports[0]["unifiedWindows"]["five_hour"]["utilization"], 0.5)

    def test_works_without_a_step_callback(self):
        with on_path(fake_claude(STREAM)):
            self.assertEqual(runner.run_claude(Agent("t", timeout=20), "hello").usage["out"], 9)

    def test_an_error_result_raises_with_its_message(self):
        body = 'print(json.dumps({"type": "result", "is_error": True, "result": "rate limited"}), flush=True)'
        with on_path(fake_claude(body)):
            with self.assertRaisesRegex(runner.RunError, "rate limited"):
                runner.run_claude(Agent("t", timeout=20), "hello")

    def test_no_result_raises_with_whatever_was_printed(self):
        with on_path(fake_claude('print("it broke badly")\nsys.exit(3)')):
            with self.assertRaisesRegex(runner.RunError, "it broke badly"):
                runner.run_claude(Agent("t", timeout=20), "hello")

    def test_a_run_that_takes_too_long_is_stopped(self):
        with on_path(fake_claude("time.sleep(30)")):
            with self.assertRaisesRegex(runner.RunError, "timed out after 1s"):
                runner.run_claude(Agent("t", timeout=1), "hello")

    def test_missing_claude_is_reported_plainly(self):
        empty = tempfile.mkdtemp()
        with mock.patch.dict(os.environ, {"PATH": empty}):
            with self.assertRaisesRegex(runner.RunError, "not found"):
                runner.run_claude(Agent("t", timeout=5), "hello")


if __name__ == "__main__":
    unittest.main()
