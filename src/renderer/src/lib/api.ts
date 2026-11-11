import type { z } from "zod";

/**
 * Call the local API and check the reply against `schema`. A reply that does not match throws a message that
 * names the route and the first bad field, instead of letting a wrong shape break the UI somewhere later.
 * Pass a body to POST it as JSON.
 */
export async function api<S extends z.ZodType>(path: string, schema: S, body?: unknown): Promise<z.infer<S>> {
  const options: RequestInit = body
    ? { method: "POST", headers: { "Content-Type": "application/json", "X-Agent-Chat": "1" }, body: JSON.stringify(body) }
    : {};
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || res.statusText);
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? issue.path.join(".") : "response";
    throw new Error(`Unexpected reply from ${path}: ${where}: ${issue?.message ?? "invalid"}`);
  }
  return parsed.data;
}
