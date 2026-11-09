import tempfile
import threading
import time
import unittest

from agentchat.agents import Agent, parse
from agentchat.bus import Bus
from agentchat.hub import Hub, parse_json_object
from agentchat.store import Store


def wait_for(predicate, timeout=3.0):
    end = time.time() + timeout
    while time.time() < end:
        if predicate():
            return True
        time.sleep(0.02)
    return False


def make_hub(runner):
    agents = {
        "manager": Agent("manager", title="Manager"),
        "planner": Agent("planner", title="Planner", goal="Plans the day"),
        "networking": Agent("networking", title="Networking", approval=True),
    }
    return Hub(Store(), agents, Bus(), runner, tempfile.mkdtemp())


class ParsingTests(unittest.TestCase):
    def test_front_matter_is_parsed(self):
        agent = parse("---\ntitle: Planner\ngoal: Plan\ntools: Read, Grep\napproval: true\ntimeout: 60\n---\nDo the job.", "planner")
        self.assertEqual(agent.title, "Planner")
        self.assertEqual(agent.tools, ["Read", "Grep"])
        self.assertTrue(agent.approval)
        self.assertEqual(agent.timeout, 60)
        self.assertEqual(agent.prompt, "Do the job.")

    def test_file_without_front_matter_still_loads(self):
        agent = parse("Just a prompt", "solo")
        self.assertEqual(agent.name, "solo")
        self.assertEqual(agent.prompt, "Just a prompt")

    def test_json_object_is_found_inside_chatter(self):
        self.assertEqual(parse_json_object('Sure! {"agent": "planner", "task": "x"} done'), {"agent": "planner", "task": "x"})
        self.assertIsNone(parse_json_object("no json here"))
        self.assertIsNone(parse_json_object("{broken"))


SAMPLE_JSON = (
    '{"type":"result","is_error":false,"result":"Hi!","total_cost_usd":0.155,"duration_ms":3289,"num_turns":1,'
    '"usage":{"input_tokens":2,"cache_creation_input_tokens":38219,"cache_read_input_tokens":23971,"output_tokens":6,'
    '"cache_creation":{"ephemeral_1h_input_tokens":38219,"ephemeral_5m_input_tokens":0}},'
    '"modelUsage":{"claude-sonnet-5-5":{"costUSD":0.155}}}'
)


LIMIT_INFO = {
    "status": "allowed",
    "rateLimitType": "five_hour",
    "unifiedWindows": {
        "five_hour": {"utilization": 0.87, "resetsAt": 1794253800, "status": "allowed"},
        "seven_day": {"utilization": 0.15, "resetsAt": 1794708000, "status": "allowed"},
    },
}


class LimitsTests(unittest.TestCase):
    def test_a_report_is_normalised_and_saved(self):
        from agentchat.hub import normalize_limits

        self.assertEqual(
            normalize_limits(LIMIT_INFO),
            {
                "five_hour": {"used": 0.87, "resets_at": 1794253800, "status": "allowed"},
                "seven_day": {"used": 0.15, "resets_at": 1794708000, "status": "allowed"},
            },
        )
        self.assertEqual(normalize_limits({"status": "allowed"}), {})  # nothing usable in it
        single = normalize_limits({"rateLimitType": "seven_day", "utilization": 0.4, "resetsAt": 5})
        self.assertEqual(single, {"seven_day": {"used": 0.4, "resets_at": 5, "status": ""}})

    def test_a_partial_report_keeps_the_other_window_and_restarts_survive(self):
        path = tempfile.mkdtemp() + "/c.db"
        agents = {"planner": Agent("planner", title="Planner")}
        hub = Hub(Store(path), agents, Bus(), lambda a, p: "x", tempfile.mkdtemp())
        self.assertEqual(hub.limits(), {"windows": {}, "updated": None})
        hub.record_limits(LIMIT_INFO)
        hub.record_limits({"rateLimitType": "five_hour", "utilization": 0.9, "resetsAt": 1794253800})
        windows = hub.limits()["windows"]
        self.assertEqual(windows["five_hour"]["used"], 0.9)
        self.assertEqual(windows["seven_day"]["used"], 0.15)
        again = Hub(Store(path), agents, Bus(), lambda a, p: "x", tempfile.mkdtemp())
        self.assertEqual(again.limits()["windows"]["seven_day"]["used"], 0.15)
        self.assertIsNotNone(again.limits()["updated"])

    def test_limits_reported_during_a_run_are_recorded(self):
        def runner(agent, prompt, on_step=None, on_limits=None):
            on_limits(LIMIT_INFO)
            return "answer"

        hub = make_hub(runner)
        hub.send("planner", "hi")
        self.assertTrue(wait_for(lambda: (hub.store.last("planner") or {}).get("sender") == "planner"))
        self.assertEqual(hub.limits()["windows"]["five_hour"]["used"], 0.87)

    def test_refresh_runs_one_cheap_probe_and_records_limits(self):
        from agentchat.runner import RunResult

        seen = []

        def runner(agent, prompt, on_limits=None):
            seen.append((agent.model, prompt))
            on_limits(LIMIT_INFO)
            return RunResult("ok", {"cost": 0.02, "in": 40000, "out": 2})

        hub = make_hub(runner)
        usage = hub.refresh_limits()
        self.assertEqual(seen, [("haiku", "ok")])
        self.assertEqual(usage["cost"], 0.02)
        self.assertEqual(hub.limits()["windows"]["five_hour"]["used"], 0.87)


class UsageParsingTests(unittest.TestCase):
    def test_usage_is_read_from_claude_json_even_with_hook_noise(self):
        from agentchat.runner import parse_claude_output

        result = parse_claude_output("hook said something\n" + SAMPLE_JSON + "\n")
        self.assertEqual(result.text, "Hi!")
        self.assertEqual(result.usage["model"], "claude-sonnet-5-5")
        self.assertEqual(result.usage["in"], 2 + 38219 + 23971)
        self.assertEqual(result.usage["out"], 6)
        self.assertEqual(result.usage["cost"], 0.155)
        self.assertEqual(result.usage["seconds"], 3.3)
        self.assertEqual((result.usage["cache_read"], result.usage["cache_write"], result.usage["cache_ttl"]), (23971, 38219, 3600))

    def test_cache_window_is_one_hour_five_minutes_or_none(self):
        from agentchat.runner import extract_usage

        five = extract_usage({"usage": {"cache_creation": {"ephemeral_5m_input_tokens": 9, "ephemeral_1h_input_tokens": 0}}})
        none = extract_usage({"usage": {"cache_read_input_tokens": 500}})
        self.assertEqual((five["cache_ttl"], none["cache_ttl"], none["cache_read"]), (300, 0, 500))

    def test_error_results_and_garbage_raise(self):
        from agentchat.runner import RunError, parse_claude_output

        with self.assertRaises(RunError):
            parse_claude_output('{"is_error": true, "result": "rate limited"}')
        with self.assertRaises(RunError):
            parse_claude_output("not json at all")


class StoreTests(unittest.TestCase):
    def test_usage_is_saved_with_a_message_and_totalled(self):
        store = Store()
        store.add("planner", "planner", "a", meta={"model": "m", "cost": 0.10, "in": 1000, "out": 50, "seconds": 2.0})
        store.add("planner", "planner", "b", meta={"model": "m", "cost": 0.05, "in": 500, "out": 25, "seconds": 1.0})
        store.add("planner", "you", "no usage on my own messages")
        self.assertEqual(store.last("planner")["meta"], None)
        self.assertEqual(store.messages("planner")[0]["meta"]["cost"], 0.10)
        total = store.usage("planner")
        self.assertEqual((total["runs"], total["cost"], total["tokens"], total["out"]), (2, 0.15, 1575, 75))
        self.assertEqual((total["today_runs"], total["today_cost"]), (2, 0.15))
        self.assertEqual(store.usage("nobody")["runs"], 0)

    def test_cache_status_is_warm_inside_the_window_and_cold_after_it(self):
        store = Store()
        self.assertIsNone(store.usage("planner")["cache"])  # no runs yet
        store.add("planner", "planner", "a", meta={"cost": 0.1, "in": 1000, "out": 5, "cache_read": 400, "cache_write": 600, "cache_ttl": 3600})
        cache = store.usage("planner")["cache"]
        self.assertEqual((cache["ttl"], cache["last_read"], cache["last_write"]), (3600, 400, 600))
        self.assertAlmostEqual(cache["last_hit"], 0.4)
        self.assertAlmostEqual(cache["hit"], 0.4)
        self.assertGreater(cache["warm_until"], time.time() + 3000)  # warm: about an hour left
        # a run made two hours ago leaves the cache cold
        store.db.execute("update usage_log set created = created - 7200")
        store.db.commit()
        self.assertLess(store.usage("planner")["cache"]["warm_until"], time.time())

    def test_a_pure_read_run_keeps_the_last_known_window_and_overall_hit_rate(self):
        store = Store()
        store.add("planner", "planner", "a", meta={"cost": 0.1, "in": 1000, "out": 5, "cache_read": 0, "cache_write": 1000, "cache_ttl": 3600})
        store.add("planner", "planner", "b", meta={"cost": 0.1, "in": 1000, "out": 5, "cache_read": 1000, "cache_write": 0, "cache_ttl": 0})
        cache = store.usage("planner")["cache"]
        self.assertEqual(cache["ttl"], 3600)  # taken from the run that wrote to the cache
        self.assertAlmostEqual(cache["last_hit"], 1.0)
        self.assertAlmostEqual(cache["hit"], 0.5)

    def test_old_usage_without_cache_data_is_unknown_not_cold(self):
        store = Store()
        store.add("planner", "planner", "a", meta={"cost": 0.1, "in": 1000, "out": 5})
        cache = store.usage("planner")["cache"]
        self.assertIsNone(cache["warm_until"])

    def test_usage_table_from_before_the_cache_columns_is_upgraded(self):
        import sqlite3

        path = tempfile.mkdtemp() + "/u.db"
        old = sqlite3.connect(path)
        old.executescript(
            "create table usage_log(id integer primary key autoincrement, chat text not null, created real not null,"
            " cost real not null default 0, tokens_in integer not null default 0, tokens_out integer not null default 0,"
            " seconds real not null default 0, model text not null default '');"
            "insert into usage_log(chat,created,cost,tokens_in,tokens_out) values('planner',1.0,0.2,900,100);"
        )
        old.commit()
        old.close()
        store = Store(path)
        usage = store.usage("planner")
        self.assertEqual((usage["runs"], usage["cost"]), (1, 0.2))
        self.assertIsNone(usage["cache"]["warm_until"])
        store.add("planner", "planner", "new", meta={"cost": 0.1, "in": 10, "out": 1, "cache_ttl": 3600})
        self.assertEqual(store.usage("planner")["cache"]["ttl"], 3600)

    def test_clearing_a_chat_keeps_usage_totals(self):
        store = Store()
        store.add("planner", "you", "hi")
        store.add("planner", "planner", "answer", meta={"model": "m", "cost": 0.2, "in": 900, "out": 100, "seconds": 1.0})
        store.add("manager", "you", "other chat")
        store.mark_read("planner")
        self.assertEqual(store.clear("planner"), 2)
        self.assertEqual(store.messages("planner"), [])
        self.assertEqual(len(store.messages("manager")), 1)
        total = store.usage("planner")
        self.assertEqual((total["runs"], total["cost"], total["tokens"]), (1, 0.2, 1000))

    def test_usage_already_on_messages_is_copied_into_the_log_once(self):
        import sqlite3

        path = tempfile.mkdtemp() + "/mid.db"
        mid = sqlite3.connect(path)
        mid.executescript(
            "create table messages(id integer primary key autoincrement, chat text not null, sender text not null,"
            " kind text not null default 'text', body text not null, status text not null default '', created real not null,"
            " meta text not null default '');"
            "insert into messages(chat,sender,body,created,meta) values('planner','planner','r',1.0,"
            "'{\"cost\": 0.5, \"in\": 10, \"out\": 5}');"
        )
        mid.commit()
        mid.close()
        self.assertEqual(Store(path).usage("planner")["runs"], 1)
        self.assertEqual(Store(path).usage("planner")["runs"], 1)  # opening again must not double count

    def test_old_database_without_the_meta_column_is_upgraded(self):
        import sqlite3

        path = tempfile.mkdtemp() + "/old.db"
        old = sqlite3.connect(path)
        old.executescript(
            "create table messages(id integer primary key autoincrement, chat text not null, sender text not null,"
            " kind text not null default 'text', body text not null, status text not null default '', created real not null);"
            "insert into messages(chat,sender,body,created) values('planner','planner','old reply',1.0);"
        )
        old.commit()
        old.close()
        store = Store(path)
        self.assertEqual(store.messages("planner")[0]["body"], "old reply")
        self.assertIsNone(store.messages("planner")[0]["meta"])
        store.add("planner", "planner", "new", meta={"cost": 0.01})
        self.assertEqual(store.usage("planner")["runs"], 1)
    def test_unread_counts_only_agent_messages_until_read(self):
        store = Store()
        store.add("planner", "you", "hi")
        store.add("planner", "planner", "hello")
        store.add("planner", "you", "ok", kind="status")
        self.assertEqual(store.unread("planner"), 1)
        store.mark_read("planner")
        self.assertEqual(store.unread("planner"), 0)

    def test_pending_counts_only_unresolved_drafts(self):
        store = Store()
        first = store.add("networking", "networking", "draft one", kind="approval", status="pending")
        store.add("networking", "networking", "draft two", kind="approval", status="pending")
        store.add("networking", "networking", "plain text")
        self.assertEqual(store.pending("networking"), 2)
        store.resolve(first["id"], "approved")
        self.assertEqual(store.pending("networking"), 1)

    def test_one_run_at_a_time_per_chat(self):
        store = Store()
        self.assertTrue(store.try_start("planner"))
        self.assertFalse(store.try_start("planner"))
        store.finish("planner")
        self.assertTrue(store.try_start("planner"))


class HubTests(unittest.TestCase):
    def test_message_runs_agent_and_stores_reply(self):
        hub = make_hub(lambda agent, prompt: "here is your list")
        hub.send("planner", "what today")
        self.assertTrue(wait_for(lambda: (hub.store.last("planner") or {}).get("sender") == "planner"))
        last = hub.store.last("planner")
        self.assertEqual(last["body"], "here is your list")
        self.assertEqual(last["kind"], "text")
        self.assertTrue(wait_for(lambda: not hub.store.working("planner")[0]))

    def test_usage_from_the_runner_is_stored_with_the_reply(self):
        from agentchat.runner import RunResult

        usage = {"model": "claude-sonnet-5-5", "cost": 0.12, "in": 4000, "out": 60, "seconds": 2.5, "turns": 1}
        hub = make_hub(lambda agent, prompt: RunResult("answer", usage))
        hub.send("planner", "hi")
        self.assertTrue(wait_for(lambda: (hub.store.last("planner") or {}).get("sender") == "planner"))
        self.assertEqual(hub.store.last("planner")["meta"], usage)
        self.assertEqual(hub.store.usage("planner")["runs"], 1)

    def test_steps_are_live_while_working_and_kept_with_the_reply(self):
        from agentchat.runner import RunResult

        gate = threading.Event()

        def runner(agent, prompt, on_step=None):
            on_step("Reading plan.md")
            on_step("Running ./socials x")
            gate.wait(3)
            return RunResult("done", {"model": "m", "cost": 0.1, "in": 10, "out": 1, "seconds": 1.0})

        hub = make_hub(runner)
        hub.send("planner", "hi")
        self.assertTrue(wait_for(lambda: hub.live_steps("planner") == ["Reading plan.md", "Running ./socials x"]))
        self.assertEqual(hub.store.working("planner"), (True, "Running ./socials x"))
        gate.set()
        self.assertTrue(wait_for(lambda: (hub.store.last("planner") or {}).get("sender") == "planner"))
        self.assertEqual(hub.store.last("planner")["meta"]["steps"], ["Reading plan.md", "Running ./socials x"])
        self.assertEqual(hub.live_steps("planner"), [])
        self.assertEqual(hub.store.usage("planner")["runs"], 1)

    def test_a_reply_with_steps_but_no_usage_is_not_counted_as_a_run(self):
        def runner(agent, prompt, on_step=None):
            on_step("Reading plan.md")
            return "answer"

        hub = make_hub(runner)
        hub.send("planner", "hi")
        self.assertTrue(wait_for(lambda: (hub.store.last("planner") or {}).get("sender") == "planner"))
        self.assertEqual(hub.store.last("planner")["meta"], {"steps": ["Reading plan.md"]})
        self.assertEqual(hub.store.usage("planner")["runs"], 0)

    def test_remember_lines_are_saved_and_hidden(self):
        hub = make_hub(lambda agent, prompt: "Answer\nREMEMBER: likes short dms")
        hub.send("planner", "hi")
        self.assertTrue(wait_for(lambda: (hub.store.last("planner") or {}).get("sender") == "planner"))
        self.assertEqual(hub.store.last("planner")["body"], "Answer")
        self.assertIn("likes short dms", (hub.memory_dir / "planner.md").read_text())

    def test_memory_is_given_back_to_the_agent_next_time(self):
        seen = []

        def runner(agent, prompt):
            seen.append(prompt)
            return "ok\nREMEMBER: use lowercase" if len(seen) == 1 else "ok"

        hub = make_hub(runner)
        hub.send("planner", "first")
        self.assertTrue(wait_for(lambda: len(seen) == 1 and not hub.store.working("planner")[0]))
        hub.send("planner", "second")
        self.assertTrue(wait_for(lambda: len(seen) == 2))
        self.assertIn("use lowercase", seen[1])

    def test_approval_flow(self):
        hub = make_hub(lambda agent, prompt: "draft dm")
        hub.send("networking", "draft")
        self.assertTrue(wait_for(lambda: (hub.store.last("networking") or {}).get("kind") == "approval"))
        draft = hub.store.last("networking")
        self.assertEqual(draft["status"], "pending")
        hub.approve(draft["id"], "approved")
        self.assertEqual(hub.store.message(draft["id"])["status"], "approved")
        self.assertEqual(hub.store.last("networking")["kind"], "status")
        with self.assertRaises(ValueError):
            hub.approve(draft["id"], "declined")

    def test_clear_chat_and_forget_notes(self):
        hub = make_hub(lambda agent, prompt: "answer\nREMEMBER: a note")
        hub.send("planner", "hi")
        self.assertTrue(wait_for(lambda: (hub.store.last("planner") or {}).get("sender") == "planner"))
        self.assertTrue(wait_for(lambda: not hub.store.working("planner")[0]))
        self.assertEqual(hub.notes_count("planner"), 1)
        self.assertEqual(hub.clear_chat("planner"), 2)
        self.assertEqual(hub.store.messages("planner"), [])
        self.assertEqual(hub.notes_count("planner"), 1)  # clearing the chat keeps the notes
        hub.forget_notes("planner")
        self.assertEqual(hub.notes_count("planner"), 0)
        hub.forget_notes("planner")  # forgetting nothing is fine

    def test_clear_is_refused_while_the_agent_is_working_or_unknown(self):
        hub = make_hub(lambda agent, prompt: "x")
        hub.store.try_start("planner")
        with self.assertRaises(ValueError):
            hub.clear_chat("planner")
        with self.assertRaises(ValueError):
            hub.clear_chat("nobody")
        with self.assertRaises(ValueError):
            hub.forget_notes("nobody")

    def test_notes_are_capped_to_the_newest_ones(self):
        from agentchat.hub import MAX_NOTES

        hub = make_hub(lambda agent, prompt: "x")
        for i in range(MAX_NOTES + 5):
            hub._extract_memory("planner", f"answer\nREMEMBER: note {i}")
        lines = (hub.memory_dir / "planner.md").read_text().splitlines()
        self.assertEqual(len(lines), MAX_NOTES)
        self.assertEqual(lines[-1], f"- note {MAX_NOTES + 4}")
        self.assertEqual(lines[0], "- note 5")

    def test_runner_error_is_shown_in_the_chat(self):
        def runner(agent, prompt):
            raise RuntimeError("boom")

        hub = make_hub(runner)
        hub.send("planner", "hi")
        self.assertTrue(wait_for(lambda: (hub.store.last("planner") or {}).get("sender") == "planner"))
        self.assertTrue(hub.store.last("planner")["body"].startswith("Could not finish"))
        self.assertFalse(hub.store.working("planner")[0])

    def test_second_request_while_busy_gets_a_polite_reply(self):
        release = threading.Event()

        def runner(agent, prompt):
            release.wait(3)
            return "done"

        hub = make_hub(runner)
        hub.send("planner", "one")
        self.assertTrue(wait_for(lambda: hub.store.working("planner")[0]))
        hub.send("planner", "two")
        self.assertTrue(wait_for(lambda: any("still working" in m["body"] for m in hub.store.messages("planner"))))
        release.set()
        self.assertTrue(wait_for(lambda: not hub.store.working("planner")[0]))

    def test_manager_hands_work_to_an_agent(self):
        def runner(agent, prompt):
            if agent.name == "manager":
                return '{"agent": "planner", "task": "list today"}'
            return "today list"

        hub = make_hub(runner)
        hub.send("manager", "what do I do today")
        self.assertTrue(wait_for(lambda: any("has answered" in m["body"] for m in hub.store.messages("manager"))))
        planner = hub.store.messages("planner")
        self.assertEqual((planner[0]["sender"], planner[0]["body"]), ("manager", "list today"))
        self.assertEqual(planner[1]["body"], "today list")

    def test_manager_can_answer_itself_and_ignores_unknown_agents(self):
        hub = make_hub(lambda agent, prompt: '{"agent": "ghost", "task": "x"}')
        hub.send("manager", "hi")
        self.assertTrue(wait_for(lambda: (hub.store.last("manager") or {}).get("sender") == "manager"))
        self.assertEqual(hub.store.messages("planner"), [])

    def test_unknown_chat_and_empty_text_are_rejected(self):
        hub = make_hub(lambda agent, prompt: "x")
        with self.assertRaises(ValueError):
            hub.send("nobody", "hi")
        with self.assertRaises(ValueError):
            hub.send("planner", "   ")


if __name__ == "__main__":
    unittest.main()
