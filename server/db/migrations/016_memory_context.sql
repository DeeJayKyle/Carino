-- Memories belong to personal life or to work, so the two can be kept apart. Existing memories are personal.
ALTER TABLE memories ADD COLUMN context TEXT NOT NULL DEFAULT 'personal';   -- personal | work
CREATE INDEX idx_memories_context ON memories(user_id, context, status);
