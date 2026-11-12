-- Self-healing: a model that just failed rests until retry_after; fail_count backs off further.
ALTER TABLE ai_models ADD COLUMN retry_after TEXT;
ALTER TABLE ai_models ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0;
