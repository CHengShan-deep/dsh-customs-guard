/**
 * Plugin configuration: surfaced as the "自动审核" settings page.
 *
 * Only fields carrying `meta.volatile` are projected by the Host settings
 * form; `role('secret')` keeps the API key write-only (the client only learns
 * whether one is stored).
 *
 * `.volatile()` is a loader-added convenience that is not present on every
 * schemastery copy, so this module marks the meta flag directly.
 */

import z from '@deepseek-ai/schemastery';

/** Mark one schema node as settings-editable without a remount. */
export function volatile(schema) {
  schema.meta = { ...(schema.meta ?? {}), volatile: true };
  return schema;
}

export const Config = z.object({
  // Tool identity: shadow keeps the stock pwsh, replace takes the name over.
  mode: z.union(['shadow', 'replace']).default('shadow'),
  reviewMode: volatile(z.union(['rules', 'manual', 'hybrid', 'native']).default('hybrid')),
  // Non-secret flag: the settings page uses it to show `*****` and to know a
  // key exists without the renderer ever receiving the secret.
  apiKeySet: volatile(z.boolean().default(false)),
  provider: volatile(z.string().default('deepseek')),
  apiKey: volatile(z.string().role('secret')),
  baseURL: volatile(z.string()),
  model: volatile(z.string().default('deepseek-flash')),
  timeoutMs: volatile(z.number().step(1).min(1000).max(60000).default(8000)),
  shareCachePrefix: volatile(z.boolean().default(true)),
  // Extra OpenAI-compatible presets the user adds in the settings page.
  presets: volatile(z.array(z.object({
    name: z.string(),
    baseURL: z.string().default(''),
    model: z.string().default('')
  })).default([])),
  // When no human can approve (delegated sessions disable approvals), ask the
  // model instead of blocking every unclassified command.
  manualFallback: volatile(z.union(['model', 'allow', 'deny']).default('model')),
  // A delete/write the rules already allowed can still contradict the stated
  // intention. On by default: one model call is cheaper than a wrong deletion.
  scopedModelReview: volatile(z.boolean().default(true))
});

/**
 * Default endpoint per provider, verified against the live catalog:
 * - DeepSeek official lists `deepseek-flash` (DeepSeek-V4.1-Flash) at /v1/models.
 * - opencode serves OpenAI-compatible chat at /inference/openai/v1.
 */
export const PROVIDER_DEFAULTS = {
  deepseek: { baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-flash' },
  'opencode-go': { baseURL: 'https://opencode.ai/inference/openai/v1', model: 'deepseek-v4.1-flash' }
};
