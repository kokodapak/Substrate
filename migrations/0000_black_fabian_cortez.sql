CREATE TABLE `access_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text,
	`pattern` text NOT NULL,
	`domain` text DEFAULT 'any',
	`action` text,
	`created_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE `files_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`type` text,
	`allowed` integer DEFAULT 0,
	`snapshot_id` text,
	`discovered_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`snapshot_id`) REFERENCES `graph_snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `findings` (
	`id` text PRIMARY KEY NOT NULL,
	`rule_id` text,
	`snapshot_id` text,
	`severity` text,
	`title` text NOT NULL,
	`detail` text NOT NULL,
	`recommended_action` text NOT NULL,
	`status` text DEFAULT 'open',
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`rule_id`) REFERENCES `rules`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`snapshot_id`) REFERENCES `graph_snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `graph_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`snapshot_id` text,
	`domain` text NOT NULL,
	`node_key` text NOT NULL,
	`node_data` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`snapshot_id`) REFERENCES `graph_snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `graph_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`graph_data` text NOT NULL,
	`domains` text DEFAULT '["services","files_configs"]',
	`created_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE `rules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`severity` text,
	`enabled` integer DEFAULT 1,
	`condition_source` text NOT NULL,
	`recommended_action` text NOT NULL,
	`built_in` integer DEFAULT 1,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE `services` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text,
	`status` text,
	`image` text,
	`ports` text DEFAULT '[]',
	`env_key_names` text DEFAULT '[]',
	`snapshot_id` text,
	`discovered_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`snapshot_id`) REFERENCES `graph_snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `state_events` (
	`id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`domain` text NOT NULL,
	`payload` text NOT NULL,
	`occurred_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE `state_snapshots` (
	`id` text PRIMARY KEY DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	`snapshot_data` text NOT NULL,
	`last_scan_at` text NOT NULL,
	`service_count` integer DEFAULT 0,
	`finding_count` integer DEFAULT 0,
	`critical_count` integer DEFAULT 0,
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`finding_id` text,
	`priority` integer NOT NULL,
	`title` text NOT NULL,
	`context` text NOT NULL,
	`reasoning` text NOT NULL,
	`status` text DEFAULT 'pending',
	`claimed_by` text,
	`claimed_at` text,
	`lock_expires_at` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`finding_id`) REFERENCES `findings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `access_rules_source_pattern_domain_unique` ON `access_rules` (`source`,`pattern`,`domain`);--> statement-breakpoint
CREATE UNIQUE INDEX `findings_rule_id_snapshot_id_unique` ON `findings` (`rule_id`,`snapshot_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `graph_nodes_snapshot_id_node_key_unique` ON `graph_nodes` (`snapshot_id`,`node_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_finding_id_unique` ON `tasks` (`finding_id`);