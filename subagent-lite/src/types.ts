/**
 * Shared types for subagent-lite.
 */

export type SystemPromptMode = "append" | "replace";

export type AgentScope = "user" | "project";

/** A child agent definition discovered from markdown or built inline. */
export interface AgentDefinition {
	name: string;
	description: string;
	/** Model reference as the agent names it (`provider/id`, optionally `:thinking`). */
	model?: string;
	thinking?: string;
	/** Explicit tool allowlist; undefined keeps pi's defaults. */
	tools?: string[];
	systemPrompt: string;
	systemPromptMode: SystemPromptMode;
	sourcePath?: string;
	scope: AgentScope | "inline";
}

export type RunStatus = "running" | "completed" | "failed" | "stopped" | "timeout";

export interface RunRecord {
	id: string;
	agent: string;
	task: string;
	status: RunStatus;
	startedAt: number;
	finishedAt?: number;
	finalOutput?: string;
	error?: string;
	model?: string;
	/** True when the run was launched in the background. */
	async: boolean;
	/** Set while the run is live; stopping it aborts the child. */
	controller?: RunController;
	/** Async runs notify the parent session on settlement. */
	notifyOnComplete: boolean;
}

/** Control surface exposed by a live run (modeled on the reference runner's register* handlers). */
export interface RunController {
	stop(): void;
}

export interface ChildUsage {
	input?: number;
	inputTokens?: number;
	output?: number;
	outputTokens?: number;
	cacheRead?: number;
	cacheReadTokens?: number;
	cacheWrite?: number;
	cacheWriteTokens?: number;
	cost?: { total?: number };
}

export interface ChildSessionExecuteResult {
	finalOutput: string;
	messageCount: number;
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number };
	toolCount: number;
	durationMs: number;
	modelId?: string;
	sessionId?: string;
	error?: string;
	interrupted?: boolean;
	timedOut?: boolean;
	stopped?: boolean;
}

/** Parameters accepted by the `subagent-lite` tool. */
export interface SubagentParams {
	agent?: string;
	task?: string;
	systemPrompt?: string;
	model?: string;
	thinking?: string;
	tools?: string[] | string;
	cwd?: string;
	async?: boolean;
	timeoutMs?: number;
	action?: "list" | "stop";
	id?: string;
}
