-- The most a model accepts in one request (tokens, including the reply), learned from its errors.
ALTER TABLE ai_models ADD COLUMN token_limit INTEGER;
