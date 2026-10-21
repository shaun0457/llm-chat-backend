CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"title" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"system_prompt" text,
	"next_seq" integer DEFAULT 1 NOT NULL,
	"last_activity_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "sessions_last_activity_at_id_idx" ON "sessions" USING btree ("last_activity_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);