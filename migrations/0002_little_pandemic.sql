CREATE TABLE `graph_edges` (
	`id` text PRIMARY KEY NOT NULL,
	`snapshot_id` text,
	`from_node_key` text NOT NULL,
	`to_node_key` text NOT NULL,
	`edge_type` text NOT NULL,
	`metadata` text,
	`created_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`snapshot_id`) REFERENCES `graph_snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
