CREATE TABLE `agent_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text,
	`agent_id` text NOT NULL,
	`action_type` text NOT NULL,
	`target` text NOT NULL,
	`payload` text,
	`outcome` text NOT NULL,
	`notes` text,
	`occurred_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
