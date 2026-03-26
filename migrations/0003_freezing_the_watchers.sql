CREATE TABLE `satellites` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`agent_key_encrypted` text NOT NULL,
	`last_sync_at` text,
	`status` text DEFAULT 'offline',
	`created_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
ALTER TABLE findings ADD `satellite_id` text;--> statement-breakpoint
ALTER TABLE graph_snapshots ADD `satellite_id` text;--> statement-breakpoint
ALTER TABLE state_events ADD `satellite_id` text;--> statement-breakpoint
ALTER TABLE tasks ADD `satellite_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `satellites_name_unique` ON `satellites` (`name`);