import type { z } from "zod";
import type {
  AgentOptionsSchema,
  CacheSchema,
  ChatSchema,
  CodexLimitsSchema,
  LimitWindowSchema,
  LimitsSchema,
  MessageSchema,
  RunMetaSchema,
  UsageSchema,
} from "./schemas";

// Derived from the schemas in ./schemas.ts: edit the schema, not these.
export type Cache = z.infer<typeof CacheSchema>;
export type Usage = z.infer<typeof UsageSchema>;
export type Chat = z.infer<typeof ChatSchema>;
export type RunMeta = z.infer<typeof RunMetaSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type LimitWindow = z.infer<typeof LimitWindowSchema>;
export type Limits = z.infer<typeof LimitsSchema>;
export type CodexLimits = z.infer<typeof CodexLimitsSchema>;
export type AgentOptions = z.infer<typeof AgentOptionsSchema>;
