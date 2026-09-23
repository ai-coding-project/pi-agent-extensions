/**
 * The `subagent-lite` tool: schema, dispatch, run table, and notifications.
 *
 * Glue layer owned by this extension. Concurrency rules:
 * - exactly one foreground run at a time (second call errors, suggests async);
 * - at most 16 active background runs;
 * - no nested subagents: a child session (identified by its session id in
 *   `childSessionIds`) cannot spawn its own subagents (single-level nesting).
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import type { AgentToolUpdateCallback, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { findAgent, listAgents, normalizeToolsInput } from "./agents.ts";
import { executeChildSession } from "./execute.ts";
import { formatCompletion, sendCompletion } from "./notify.ts";
import { childSessionFactory, type ChildSession, type ChildSessionFactory, type ChildSessionLaunch } from "./session.ts";
import { formatDuration, truncateText } from "./utils.ts";
import type { AgentDefinition, RunController, RunRecord, RunStatus, SubagentParams } from "./types.ts";

export const TOOL_NAME = "subagent-lite";
export const NOTIFY_CUSTOM_TYPE = "subagent-lite-notify";

export const MAX_ACTIVE_ASYNC = 16;
export const MAX_RUN_HISTORY = 50;
export const MAX_OUTPUT_CHARS = 50_000;
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Child session ids currently alive in this process.
 *
 * This MUST live on globalThis under a Symbol.for key: pi loads extensions via
 * jiti without a module cache, and our own child sessions reset the extension
 * factory cache so each child gets a fresh copy of this module (the same way a
 * separate process would). A plain module-level set would therefore be
 * per-instance and the single-level nesting guard would never fire in a real
 * child. The globalThis slot makes the set process-wide across all module
 * instances — the same pattern the reference implementation uses for theme
 * initialization.
 */
const CHILD_SESSION_IDS_KEY = Symbol.for("subagent-lite:childSessionIds");
const childSessionIds: Set<string> = ((globalThis as Record<symbol, Set<string>>)[CHILD_SESSION_IDS_KEY] ??= new Set<string>());

/** Split a known `:thinking` suffix from a model reference. (Copied semantics from the reference model-info.ts.) */
export function splitModelThinking(model: string): { baseModel: string; thinkingSuffix: string } {
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx === -1) return { baseModel: model, thinkingSuffix: "" };
	const suffix = THINKING_LEVELS.find((level) => level === model.substring(colonIdx + 1));
	if (!suffix) return { baseModel: model, thinkingSuffix: "" };
	return { baseModel: model.substring(0, colonIdx), thinkingSuffix: `:${suffix}` };
}

/**
 * Model precedence: explicit parameter > agent definition > parent's model.
 * Returns an error string for malformed input.
 */
export function resolveModelCandidate(params: SubagentParams, agent: AgentDefinition | undefined, parentModel: { provider: string; id: string } | undefined): { model?: string; error?: string } {
	const raw = params.model ?? agent?.model ?? (parentModel ? `${parentModel.provider}/${parentModel.id}` : undefined);
	if (raw === undefined) return {};
	const candidate = raw.trim();
	if (!candidate) return params.model !== undefined || agent?.model !== undefined ? { error: "model must not be empty" } : {};
	const { baseModel, thinkingSuffix } = splitModelThinking(candidate);
	if (!baseModel.trim()) return { error: `invalid model '${candidate}': missing model id before the thinking suffix` };
	if (candidate.includes("/") && baseModel.split("/").length > 2) {
		return { error: `invalid model '${candidate}': expected 'provider/id' (optionally ':thinking')` };
	}
	return { model: candidate };
}

export interface SubagentToolDeps {
	/** Overrides the child-session factory (test seam). */
	factory?: ChildSessionFactory;
	/** Overrides run-id generation (test seam). */
	newId?: () => string;
}

export interface SubagentRegistration {
	/** Abort live runs, dispose their children, and clear the run table. */
	dispose(): Promise<void>;
}

/** Minimal pi surface the dispatch needs (kept structural for tests). */
export interface SubagentHostPi {
	sendMessage: (message: { customType: string; content: string; display: boolean }, options?: { triggerTurn?: boolean }) => unknown;
}

/** Structural host surface for registration: satisfied by ExtensionAPI and by test fakes. */
export interface SubagentToolHost {
	registerTool: (tool: ToolDefinition) => void;
	sendMessage: SubagentHostPi["sendMessage"];
	on(event: "session_shutdown", handler: (event: unknown, ctx: unknown) => unknown): void;
}

interface DispatchContext {
	cwd: string;
	parentModel?: { provider: string; id: string };
	parentThinkingLevel?: string;
	signal?: AbortSignal;
	onUpdate?: AgentToolUpdateCallback;
	pi: SubagentHostPi;
}

function jsonOutput(value: unknown): { content: [{ type: "text"; text: string }]; details: undefined; isError?: boolean } {
	return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: undefined };
}

function textOutput(text: string, isError = false): { content: [{ type: "text"; text: string }]; details: undefined; isError?: boolean } {
	return { content: [{ type: "text", text }], details: undefined, ...(isError ? { isError: true } : {}) };
}

function truncateForList(value: string | undefined, maxLength: number): string | undefined {
	if (!value) return undefined;
	return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function runToListEntry(run: RunRecord) {
	return {
		id: run.id,
		agent: run.agent,
		task: truncateForList(run.task, 120),
		status: run.status,
		async: run.async,
		model: run.model,
		startedAt: new Date(run.startedAt).toISOString(),
		finishedAt: run.finishedAt === undefined ? undefined : new Date(run.finishedAt).toISOString(),
		error: truncateForList(run.error, 200),
		outputPreview: truncateForList(run.finalOutput, 200),
	};
}

export function registerSubagentTool(pi: SubagentToolHost, deps: SubagentToolDeps = {}): SubagentRegistration {
	const runs = new Map<string, RunRecord>();
	const factory = deps.factory ?? childSessionFactory();
	const newId = deps.newId ?? (() => randomUUID().slice(0, 8));
	let foregroundActive = false;
	let shuttingDown = false;

	/** Abort live runs, dispose their children, and clear the run table; idempotent. */
	const dispose = async (): Promise<void> => {
		shuttingDown = true;
		for (const run of runs.values()) {
			if (run.status === "running") {
				run.status = "failed";
				run.finishedAt = Date.now();
				run.error = run.error ?? "Session shut down while the subagent was running.";
				run.controller?.stop();
				run.controller = undefined;
			}
		}
		await factory.dispose();
	};

	// The tool owns its cleanup: live children must not outlive the session.
	pi.on("session_shutdown", async () => {
		try {
			await dispose();
		} catch {
			// Shutdown must not fail because a child refused to settle.
		}
	});

	const activeAsyncCount = (): number => [...runs.values()].filter((run) => run.async && run.status === "running").length;

	const evictOverflow = (): void => {
		while (runs.size > MAX_RUN_HISTORY) {
			const oldestFinished = [...runs.values()].find((run) => run.status !== "running");
			const victim = oldestFinished ?? [...runs.values()][0];
			if (!victim) break;
			runs.delete(victim.id);
		}
	};

	const describeAvailableAgents = (cwd: string): string => {
		try {
			const { agents } = listAgents(cwd);
			return agents.length > 0 ? agents.map((agent) => agent.name).join(", ") : "(none)";
		} catch {
			return "(discovery failed)";
		}
	};

	/** Run one child to settlement: update the run record, notify on async completion, release recursion-guard ids. */
	const runChild = async (run: RunRecord, launch: ChildSessionLaunch, prompt: string, timeoutMs: number, ctx: DispatchContext): Promise<void> => {
		const trackedChildIds = new Set<string>();
		const controller: RunController = {
			stop: () => handle?.stop(),
		};
		run.controller = controller;
		let handle: ReturnType<typeof executeChildSession> | undefined;
		try {
			handle = executeChildSession({
				factory,
				launch,
				prompt,
				timeoutMs,
				timeoutMessage: `Subagent timed out after ${formatDuration(timeoutMs)}.`,
				onSessionCreated: (session: ChildSession) => {
					childSessionIds.add(session.sessionId);
					trackedChildIds.add(session.sessionId);
				},
				onAssistantPreview: ctx.onUpdate
					? (text) => ctx.onUpdate?.({ content: [{ type: "text", text: `[${run.agent}] ${text.slice(0, 200)}` }], details: undefined })
					: undefined,
			});
			if (ctx.signal) {
				ctx.signal.addEventListener("abort", () => handle?.interrupt(), { once: true });
			}
			const result = await handle.promise;
			// A dispose() during shutdown already settled the record with the shutdown
			// verdict; do not overwrite it with a late completion, and do not notify —
			// the parent session is going away and can no longer receive the notice.
			if (shuttingDown) return;
			if (run.status === "running") {
				const status: RunStatus = result.stopped || result.interrupted ? "stopped" : result.timedOut ? "timeout" : result.error ? "failed" : "completed";
				run.status = status;
				run.finishedAt = Date.now();
			}
			run.finalOutput = result.finalOutput;
			run.error = run.error ?? result.error;
			run.model = result.modelId ?? run.model;
			run.controller = undefined;
			if (run.async) {
				sendCompletion(ctx.pi, formatCompletion({ run, result }));
			}
		} finally {
			for (const id of trackedChildIds) childSessionIds.delete(id);
			if (run.status === "running") {
				run.status = "failed";
				run.finishedAt = Date.now();
				run.error = run.error ?? "Subagent run ended without a result.";
				run.controller = undefined;
			}
		}
	};

	const execute = async (_toolCallId: string, params: SubagentParams, signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback | undefined, ctx: ExtensionContext): Promise<ReturnType<typeof textOutput>> => {
		const dispatch: DispatchContext = {
			cwd: ctx.cwd,
			parentModel: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
			parentThinkingLevel: ctx.thinkingLevel,
			signal,
			onUpdate,
			pi: pi as unknown as SubagentHostPi,
		};

		// Recursion guard: refuse when this very session is one of our children.
		let ownSessionId: string | undefined;
		try {
			ownSessionId = ctx.sessionManager.getSessionId();
		} catch {
			ownSessionId = undefined;
		}
		if (ownSessionId !== undefined && childSessionIds.has(ownSessionId)) {
			return textOutput("child agents cannot spawn sub-agents (single-level nesting)", true);
		}

		// Utility actions.
		if (params.action === "list") {
			return jsonOutput({ activeCount: [...runs.values()].filter((run) => run.status === "running").length, runs: [...runs.values()].reverse().map(runToListEntry) });
		}
		if (params.action === "stop") {
			if (!params.id) return textOutput("stop requires the id of a running background subagent", true);
			const run = runs.get(params.id)
				?? [...runs.values()].filter((candidate) => candidate.id.startsWith(params.id!)).at(-1);
			if (!run) {
				const running = [...runs.values()].filter((candidate) => candidate.status === "running").map((candidate) => candidate.id);
				return textOutput(`No subagent run matches id '${params.id}'.${running.length > 0 ? ` Active run ids: ${running.join(", ")}.` : " No runs are active."}`, true);
			}
			if (run.status !== "running" || !run.controller) {
				return textOutput(`Run '${run.id}' already finished (status: ${run.status}).`, true);
			}
			run.controller.stop();
			return textOutput(`Stopping background subagent run '${run.id}'. A completion notice follows when it settles.`);
		}

		// Validation.
		const task = params.task?.trim() ?? "";
		if (!task) return textOutput("task is required (the prompt for the child agent)", true);
		const hasAgent = params.agent !== undefined && params.agent.trim() !== "";
		const hasInlinePrompt = params.systemPrompt !== undefined && params.systemPrompt.trim() !== "";
		if (!hasAgent && !hasInlinePrompt) {
			return textOutput("either agent (a discovered agent name) or systemPrompt (an inline system prompt) is required", true);
		}
		if (hasAgent && hasInlinePrompt) {
			return textOutput("agent and systemPrompt are mutually exclusive; provide exactly one of the two", true);
		}

		let agent: AgentDefinition | undefined;
		if (hasAgent) {
			agent = findAgent(ctx.cwd, params.agent!.trim());
			if (!agent) {
				return textOutput(`Unknown agent '${params.agent!.trim()}'. Available agents: ${describeAvailableAgents(ctx.cwd)}.`, true);
			}
		}

		const modelSelection = resolveModelCandidate(params, agent, dispatch.parentModel);
		if (modelSelection.error) return textOutput(modelSelection.error, true);
		const { thinkingSuffix } = splitModelThinking(modelSelection.model ?? "");
		const thinking = params.thinking ?? agent?.thinking ?? (thinkingSuffix ? thinkingSuffix.slice(1) : undefined) ?? dispatch.parentThinkingLevel;

		const tools = normalizeToolsInput(params.tools) ?? agent?.tools;
		// A relative cwd resolves against the session's cwd (ctx.cwd), not the
		// process cwd: the two differ when the session runs in another directory.
		const childCwd = path.resolve(ctx.cwd, params.cwd ?? ".");
		if (!fs.existsSync(childCwd) || !fs.statSync(childCwd).isDirectory()) {
			return textOutput(`cwd '${childCwd}' does not exist or is not a directory`, true);
		}
		const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		if (!Number.isFinite(timeoutMs) || timeoutMs < 1) return textOutput("timeoutMs must be a number of milliseconds >= 1", true);

		const systemPrompt = hasInlinePrompt ? params.systemPrompt!.trim() : agent!.systemPrompt;
		const systemPromptMode = hasInlinePrompt ? "replace" as const : agent!.systemPromptMode;
		const launch = {
			cwd: childCwd,
			...(modelSelection.model !== undefined ? { model: modelSelection.model } : {}),
			...(thinking !== undefined ? { thinkingLevel: thinking } : {}),
			...(tools !== undefined ? { tools } : {}),
			ambientExtensions: true,
			hooks: [],
			...(systemPrompt !== undefined ? { systemPrompt } : {}),
			systemPromptMode,
			parentProviderRegistry: ctx.modelRegistry,
		};

		const run: RunRecord = {
			id: newId(),
			agent: agent?.name ?? "inline",
			task,
			status: "running",
			startedAt: Date.now(),
			async: params.async === true,
			notifyOnComplete: params.async === true,
			...(modelSelection.model !== undefined ? { model: modelSelection.model } : {}),
		};
		runs.set(run.id, run);
		evictOverflow();

		// Background path.
		if (run.async) {
			if (activeAsyncCount() > MAX_ACTIVE_ASYNC) {
				runs.delete(run.id);
				return textOutput(`Too many active background subagent runs (${MAX_ACTIVE_ASYNC} max). Stop one or wait for completion.`, true);
			}
			void runChild(run, launch, task, timeoutMs, dispatch);
			return textOutput(`Started background subagent run '${run.id}' (${run.agent}). A completion notice will arrive when it settles; use action "stop" with id '${run.id}' to stop it, or action "list" to see runs.`);
		}

		// Foreground path: one at a time.
		if (foregroundActive) {
			runs.delete(run.id);
			return textOutput("Another foreground subagent run is already active in this session. Use async: true to run in the background instead.", true);
		}
		foregroundActive = true;
		try {
			await runChild(run, launch, task, timeoutMs, dispatch);
		} finally {
			foregroundActive = false;
		}

		// stopped/timeout/failed runs did not produce a usable answer; mark the tool result as an error.
		const failed = run.status !== "completed";
		const summaryLines = [
			`Subagent ${run.agent} ${run.status} in ${formatDuration((run.finishedAt ?? Date.now()) - run.startedAt)}.`,
			`Run id: ${run.id}${run.model ? ` · Model: ${run.model}` : ""}`,
			"",
		];
		const body = truncateText(run.finalOutput?.trim() ? run.finalOutput : "", MAX_OUTPUT_CHARS);
		const output = [...summaryLines, body || "(no output)", ...(run.error ? ["", `Error: ${run.error}`] : [])].join("\n");
		return textOutput(output, failed);
	};

	pi.registerTool({
		name: TOOL_NAME,
		label: "Subagent (lite)",
		description: [
			"Delegate a task to a child agent.",
			"Pick a child with `agent` (a discovered agent name) or provide an inline `systemPrompt`; exactly one of the two.",
			"`task` is the prompt for the child.",
			"Runs synchronously and returns the child's final output by default; set `async: true` to run in the background (a completion notice arrives automatically, `action: \"stop\"` stops a run, `action: \"list\"` shows runs).",
			"Children cannot spawn further subagents.",
		].join(" "),
		parameters: Type.Object({
			agent: Type.Optional(Type.String({ description: "Name of a discovered child agent (from ~/.pi/agent/agents or <cwd>/.pi/agents). Use instead of systemPrompt." })),
			task: Type.Optional(Type.String({ description: "The prompt/task for the child agent." })),
			systemPrompt: Type.Optional(Type.String({ description: "Inline system prompt for the child (replaces its default). Use instead of agent." })),
			model: Type.Optional(Type.String({ description: "Model as 'provider/id', optionally with a ':thinking' suffix. Defaults to the agent's model, else the parent's model." })),
			thinking: Type.Optional(Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)), { description: "Thinking level override for the child." })),
			tools: Type.Optional(Type.Union([Type.Array(Type.String()), Type.String()], { description: "Tool allowlist for the child (array or comma-separated). Defaults to the agent's tools, else pi's defaults." })),
			cwd: Type.Optional(Type.String({ description: "Working directory for the child. Defaults to the current working directory." })),
			async: Type.Optional(Type.Boolean({ description: "Run in the background and notify this session on completion. Default false." })),
			timeoutMs: Type.Optional(Type.Number({ minimum: 1, description: `Run timeout in milliseconds. Default ${DEFAULT_TIMEOUT_MS} (30 minutes).` })),
			action: Type.Optional(Type.Union([Type.Literal("list"), Type.Literal("stop")], { description: "Utility action: list recent runs, or stop a running background run (requires id). Mutually exclusive with task." })),
			id: Type.Optional(Type.String({ description: "Run id (or unique prefix) for the stop action." })),
		}, { additionalProperties: false }),
		execute,
	});

	return { dispose };
}

