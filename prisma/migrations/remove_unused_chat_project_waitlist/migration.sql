-- Drop tables (order matters for foreign keys)
DROP TABLE IF EXISTS "approval_requests";
DROP TABLE IF EXISTS "chat_messages";
DROP TABLE IF EXISTS "chat_sessions";
DROP TABLE IF EXISTS "projects";
DROP TABLE IF EXISTS "waitlist";

-- Drop unused enums
DROP TYPE IF EXISTS "ApprovalType";
DROP TYPE IF EXISTS "ApprovalStatus";
DROP TYPE IF EXISTS "MessageRole";
DROP TYPE IF EXISTS "MessageStatus";
