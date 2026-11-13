import { z } from "zod";

// The shape of every JSON response the page reads from /api. `api()` checks each response against one of
// these, and lib/types.ts derives the TypeScript types from them, so the two cannot drift apart.

const num = z.number();

export const CacheSchema = z.object({
  last_at: num,
  ttl: num,
  warm_until: num.nullable(),
  last_read: num,
  last_write: num,
  last_hit: num.nullable(),
  hit: num.nullable(),
});

export const UsageSchema = z.object({
  runs: num,
  cost: num,
  tokens: num,
  out: num,
  seconds: num,
  model: z.string(),
  today_runs: num,
  today_cost: num,
  cache: CacheSchema.nullable(),
});

export const ChatSchema = z.object({
  name: z.string(),
  title: z.string(),
  goal: z.string(),
  approval: z.boolean(),
  model: z.string(),
  modelPicked: z.string(), // the model chosen in the chat's dropdown ("claude:sonnet", "codex:gpt-6-luna"); "" = the agent file's choice
  choices: z.array(z.object({ id: z.string(), label: z.string(), engine: z.string() })), // what that dropdown lists, Claude then Codex
  engine: z.string(),
  access: z.string(), // "read-only" | "workspace-write" | "danger-full-access" (Claude chats use only the first and last)
  tools: z.array(z.string()),
  usage: UsageSchema,
  notes: num,
  messages: num,
  summarized: z.boolean(),
  steps: z.array(z.string()),
  working: z.boolean(),
  detail: z.string(),
  unread: num,
  pending: num,
  last: z.object({ sender: z.string(), body: z.string(), kind: z.string(), created: num }).nullable(),
});

export const RunMetaSchema = z.object({
  model: z.string().optional(),
  cost: num.optional(),
  in: num.optional(),
  out: num.optional(),
  seconds: num.optional(),
  cache_read: num.optional(),
  steps: z.array(z.string()).optional(),
  post: z.object({ dir: z.string(), files: z.array(z.string()), caption: z.string(), slides: z.array(z.string()) }).optional(),
  relay: z
    .object({
      agent: z.string(),
      title: z.string(),
      id: num.nullable(),
      verdict: z.enum(["ok", "fix", "failed", "unchecked"]),
      draft: z.boolean().optional(),
    })
    .optional(),
});

export const MessageSchema = z.object({
  id: num,
  chat: z.string(),
  sender: z.string(),
  kind: z.enum(["text", "approval", "status"]),
  body: z.string(),
  status: z.string(),
  created: num,
  meta: RunMetaSchema.nullable(),
});

export const LimitWindowSchema = z.object({
  used: num,
  resets_at: num.nullable(),
  status: z.string().optional(),
  label: z.string().optional(),
});

export const LimitsSchema = z.object({
  windows: z.record(z.string(), LimitWindowSchema),
  updated: num.nullable(),
});

export const CodexLimitsSchema = z.object({
  plan: z.string().optional(),
  windows: z.array(LimitWindowSchema),
  updated: num.nullable().optional(),
  error: z.string().optional(),
});

export const AgentOptionsSchema = z.object({
  enabled: z.boolean(),
  tools: z.array(z.object({ id: z.string(), label: z.string() })),
  models: z.array(z.string()),
  cwd: z.string(),
});

// Whole responses, one per route the page calls.
export const ChatsResponse = z.object({ chats: z.array(ChatSchema) });
export const MessagesResponse = z.object({ chat: ChatSchema, messages: z.array(MessageSchema) });
export const LimitsResponse = z.object({ limits: LimitsSchema, codex: CodexLimitsSchema.nullable() });
export const LimitsRefreshResponse = z.object({ usage: z.object({ cost: num.optional() }).nullish(), limits: LimitsSchema });
export const CodexRefreshResponse = z.object({ codex: CodexLimitsSchema.nullable() });
export const ClearResponse = z.object({ deleted: num });
export const CreateAgentResponse = z.object({ name: z.string() });

/** For routes whose reply the page does not read (send, approve, compact, forget). */
export const Ignored = z.unknown();
