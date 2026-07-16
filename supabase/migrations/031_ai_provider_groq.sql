-- ============================================================
-- 031_ai_provider_groq.sql — Add Groq as a supported AI provider
--
-- The CHECK constraint on ai_configs.provider originally only allowed
-- 'openai' and 'anthropic'. Drop and recreate it to also permit 'groq',
-- which uses an OpenAI-compatible chat completions endpoint at
-- api.groq.com and gives 30 RPM / 14,400 RPD on the free tier.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_provider_check;

ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'groq'));
