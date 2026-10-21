CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"role" text NOT NULL,
	"reply_to_id" uuid,
	"content" text DEFAULT '' NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"error_detail" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"started_at" timestamp with time zone,
	"provider" text,
	"model" text,
	"system_prompt" text,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"finish_reason" text,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_reply_to_id_unique" UNIQUE("reply_to_id"),
	CONSTRAINT "messages_session_id_seq_unique" UNIQUE("session_id","seq"),
	CONSTRAINT "messages_role_check" CHECK ("messages"."role" IN ('user', 'assistant')),
	CONSTRAINT "messages_status_check" CHECK ("messages"."status" IN ('generating', 'completed', 'failed')),
	CONSTRAINT "messages_attempt_check" CHECK ("messages"."attempt" >= 1),
	CONSTRAINT "messages_user_row_check" CHECK ("messages"."role" <> 'user' OR ("messages"."status" = 'completed' AND "messages"."reply_to_id" IS NULL AND "messages"."error_code" IS NULL AND "messages"."error_detail" IS NULL AND "messages"."started_at" IS NULL AND "messages"."provider" IS NULL AND "messages"."model" IS NULL AND "messages"."system_prompt" IS NULL AND "messages"."prompt_tokens" IS NULL AND "messages"."completion_tokens" IS NULL AND "messages"."finish_reason" IS NULL AND "messages"."latency_ms" IS NULL)),
	CONSTRAINT "messages_assistant_row_check" CHECK ("messages"."role" <> 'assistant' OR ("messages"."reply_to_id" IS NOT NULL AND "messages"."started_at" IS NOT NULL AND "messages"."provider" IS NOT NULL AND "messages"."model" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_id_messages_id_fk" FOREIGN KEY ("reply_to_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_one_generating_per_session" ON "messages" USING btree ("session_id") WHERE "messages"."status" = 'generating';