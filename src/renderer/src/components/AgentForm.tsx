import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";

const DEFAULT_TOOLS = ["Read", "Grep", "Glob"];

export function AgentForm() {
  const { formOpen, closeForm, options, createAgent } = useStore();
  const [engine, setEngine] = useState<"claude" | "codex">("claude");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const errorBox = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!formOpen) return;
    form.current?.reset();
    setEngine("claude");
    setError("");
    form.current?.elements.namedItem("title") instanceof HTMLInputElement && (form.current.elements.namedItem("title") as HTMLInputElement).focus();
  }, [formOpen]);
  useEffect(() => {
    if (!options || !form.current) return;
    const cwd = form.current.elements.namedItem("cwd") as HTMLInputElement;
    if (!cwd.value) cwd.value = options.cwd || "";
    if (!options.enabled) setError("Adding agents from the app is not switched on here.");
  }, [options]);
  useEffect(() => {
    if (error) errorBox.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); // the form body scrolls
  }, [error]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && formOpen && closeForm();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [formOpen, closeForm]);

  if (!formOpen) return null;

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    const data = new FormData(e.currentTarget);
    const text = (k: string) => String(data.get(k) ?? "");
    const spec: Record<string, unknown> = {
      title: text("title"),
      goal: text("goal"),
      prompt: text("prompt"),
      engine,
      cwd: text("cwd"),
      approval: data.get("approval") === "on",
    };
    if (engine === "codex") {
      spec.sandbox = text("sandbox");
      spec.model = text("codexmodel");
    } else {
      spec.model = text("model");
      spec.tools = data.getAll("tool").map(String);
    }
    setSaving(true);
    try {
      await createAgent(spec);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div id="agent-modal" className="modal" onMouseDown={(e) => e.target === e.currentTarget && closeForm()}>
      <form ref={form} id="agent-form" className="modal-card" role="dialog" aria-modal="true" aria-labelledby="am-title" autoComplete="off" onSubmit={submit}>
        <header className="modal-head">
          <h2 id="am-title">New agent</h2>
          <button className="icon-btn" type="button" aria-label="Close" onClick={closeForm}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        <div className="modal-body">
          <label className="field"><span>Name</span><input name="title" maxLength={40} required placeholder="Code reviewer" /></label>
          <label className="field"><span>What it does <em>one line, shown in the list</em></span><input name="goal" maxLength={200} placeholder="Explains how the code works" /></label>
          <label className="field"><span>Instructions</span><textarea name="prompt" rows={6} required minLength={10} placeholder="Describe the job: who the agent is, what it should do, how it should answer." /></label>
          <div className="field">
            <span>Runs on</span>
            <div className="seg" role="radiogroup" aria-label="Runs on">
              {(["claude", "codex"] as const).map((v) => (
                <label key={v}>
                  <input type="radio" name="engine" value={v} checked={engine === v} onChange={() => setEngine(v)} />
                  <span>{v === "claude" ? "Claude" : "Codex"}</span>
                </label>
              ))}
            </div>
          </div>
          {engine === "claude" ? (
            <div className="group">
              <label className="field"><span>Model</span><select name="model"><option value="sonnet">Sonnet</option><option value="haiku">Haiku (cheaper, simpler)</option></select></label>
              <div className="field">
                <span>What it can do</span>
                <div className="checks">
                  {(options?.tools ?? []).map((t) => (
                    <label key={t.id} className="check">
                      <input type="checkbox" name="tool" value={t.id} defaultChecked={DEFAULT_TOOLS.includes(t.id)} />
                      <span>{t.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="group">
              <label className="field"><span>Access</span><select name="sandbox"><option value="read-only">Read only</option><option value="workspace-write">Can edit files in its folder</option></select></label>
              <label className="field"><span>Codex model <em>optional, leave empty for your default</em></span><input name="codexmodel" maxLength={60} /></label>
            </div>
          )}
          <label className="field"><span>Folder it works in</span><input name="cwd" maxLength={300} placeholder="~/projects/my-project" /></label>
          <label className="check"><input type="checkbox" name="approval" /><span>Its replies arrive as drafts I approve first</span></label>
          <p className="am-note">Agents made here can read and search but can’t run commands or post anything. For that, add a file to the <code>agents/</code> folder.</p>
          {error ? <div ref={errorBox} className="am-error" role="alert">{error}</div> : null}
        </div>
        <footer className="modal-foot">
          <button className="btn no" type="button" onClick={closeForm}>Cancel</button>
          <button className="btn ok" type="submit" disabled={saving || (options ? !options.enabled : false)}>{saving ? "Creating…" : "Create agent"}</button>
        </footer>
      </form>
    </div>
  );
}
