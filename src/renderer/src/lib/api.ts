export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const options: RequestInit = body
    ? { method: "POST", headers: { "Content-Type": "application/json", "X-Agent-Chat": "1" }, body: JSON.stringify(body) }
    : {};
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any).error || res.statusText);
  return data as T;
}
