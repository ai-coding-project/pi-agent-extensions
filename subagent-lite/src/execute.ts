/**
 * Run one in-process child session to completion.
 *
 * Adapted from the reference implementation's
 * `src/runs/background/run-child-session.ts`: the state machine, final-drain
 * timing, abort settling, and usage reconciliation are kept; steering,
 * watchdogs, transcripts, tool timeouts, and the detached-runner machinery are
 * removed. The control surface (stop/interrupt/timeout) is returned as a
 * handle instead of being registered by a runner.
 */
import { projectChildLifecycle, type ChildLifecycleState } from "./child-lifecycle.ts";
import { childSessionHasQueuedMessages, type ChildSession, type ChildSessionEvent, type ChildSessionFactory, type ChildSessionLaunch } from "./session.ts";
import { extractTextFromContent, getFinalOutput, hasEmptyTerminalAssistantResponse } from "./utils.ts";
import type { ChildUsage } from "./types.ts";

export const FINAL_STOP_GRACE_MS = 1000;
export const HARD_FINISH_MS = 3000;
export const ABORT_SETTLE_MS = 3000;

export interface ExecuteChildSessionInput {
	factory: ChildSessionFactory;
	launch: ChildSessionLaunch;
	prompt: string;
	/** Optional run timeout; the child is aborted and the run marked timed out when it elapses. */
	timeoutMs?: number;
	timeoutMessage?: string;
	stopMessage?: string;
	/** Called once the child session exists (before its first prompt); the caller can wire recursive-spawn guards here. */
	onSessionCreated?: (session: ChildSession) => void;
	/** Assistant text previews forwarded while the run is live. */
	onAssistantPreview?: (text: string) => void;
}

export interface ExecuteChildSessionResult {
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

export interface ExecuteChildSessionHandle {
	promise: Promise<ExecuteChildSessionResult>;
	/** Abort the child and mark the run stopped. */
	stop(): void;
	/** Abort the child and mark the run interrupted (external signal). */
	interrupt(): void;
}

type Usage = ExecuteChildSessionResult["usage"];

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

type UsageMessage = { role?: unknown; timestamp?: unknown; usage?: object };

const usageFields = ["input", "output", "cacheRead", "cacheWrite", "cost"] as const;
type UsageField = typeof usageFields[number];

const aliases: Record<Exclude<UsageField, "cost">, readonly string[]> = {
	input: ["input", "inputTokens"],
	output: ["output", "outputTokens"],
	cacheRead: ["cacheRead", "cacheReadTokens"],
	cacheWrite: ["cacheWrite", "cacheWriteTokens"],
};

function validNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function fieldValue(usage: object | undefined, field: UsageField): number | undefined {
	if (!usage) return undefined;
	const values = usage as Record<string, unknown>;
	if (field === "cost") {
		const direct = validNumber(values.cost);
		if (direct !== undefined) return direct;
		const cost = values.cost;
		return cost && typeof cost === "object" && !Array.isArray(cost)
			? validNumber((cost as { total?: unknown }).total)
			: undefined;
	}
	for (const name of aliases[field]) {
		const value = validNumber(values[name]);
		if (value !== undefined) return value;
	}
	return undefined;
}

function validTimestamp(message: UsageMessage): string | number | undefined {
	const value = message.timestamp;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.length > 0) return value;
	return undefined;
}

/**
 * Replace streaming-accumulated usage with per-message usage from the child's
 * own message list, deduplicating retried assistant turns by timestamp.
 * (Copied from the reference usage-reconciliation.ts.)
 */
function reconcileAttemptUsage(live: Usage, messages: readonly UsageMessage[], baseline: number): Usage {
	if (!Number.isInteger(baseline) || baseline < 0 || messages.length < baseline) return { ...live };

	const persisted: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	const complete: Record<UsageField, boolean> = { input: true, output: true, cacheRead: true, cacheWrite: true, cost: true };
	let previous: UsageMessage | undefined;
	for (let index = baseline; index < messages.length; index++) {
		const message = messages[index]!;
		if (message.role === "assistant") {
			const timestamp = validTimestamp(message);
			const duplicate = previous?.role === "assistant" && timestamp !== undefined && validTimestamp(previous) === timestamp;
			if (!duplicate) {
				persisted.turns++;
				for (const field of usageFields) {
					const value = fieldValue(message.usage, field);
					if (value === undefined) complete[field] = false;
					else persisted[field] += value;
				}
			}
		}
		previous = message;
	}
	if (persisted.turns === 0) return { ...live };

	const reconciled = { ...live, turns: persisted.turns };
	for (const field of usageFields) {
		if (complete[field] && Number.isFinite(persisted[field])) reconciled[field] = persisted[field];
	}
	return reconciled;
}

function assistantStartsToolCall(message: { content?: unknown }): boolean {
	return Array.isArray(message.content)
		&& message.content.some((part) => (part as { type?: string }).type === "toolCall");
}

function isTerminalAssistantStop(message: { stopReason?: unknown; content?: unknown }): boolean {
	return message.stopReason === "stop" && !assistantStartsToolCall(message);
}

export function executeChildSession(input: ExecuteChildSessionInput): ExecuteChildSessionHandle {
	// Control surface: the run installs handlers once its state machine exists;
	// the handle forwards external stop/interrupt requests to them.
	let stopHandler: (() => void) | undefined;
	let interruptHandler: (() => void) | undefined;

	const promise = new Promise<ExecuteChildSessionResult>((resolve) => {
		const startedAt = Date.now();
		const messages: Array<Record<string, unknown>> = [];
		const usage = emptyUsage();
		let model: string | undefined;
		let error: string | undefined;
		let assistantError: string | undefined;
		let interrupted = false;
		let timedOut = false;
		let stopped = false;
		let toolCount = 0;
		let session: ChildSession | undefined;
		let messageBaseline: number | undefined;
		let unsubscribe: (() => void) | undefined;
		let settled = false;
		let promptSettled = false;
		let forcedTermination = false;
		let cleanTerminalAssistantStopReceived = false;
		let agentSettledReceived = false;
		let queuedDrainHold = false;
		let compactionStartedReceived = false;
		let afterCompactionSettlement = false;
		let finalDrainTimer: NodeJS.Timeout | undefined;
		let finalHardFinishTimer: NodeJS.Timeout | undefined;
		let abortSettleTimer: NodeJS.Timeout | undefined;
		let runTimeoutTimer: NodeJS.Timeout | undefined;
		const childLifecycleState: ChildLifecycleState = { compactionRetryActive: false };
		const timeoutMessage = () => input.timeoutMessage ?? "Subagent timed out.";
		const stopMessage = () => input.stopMessage ?? "Subagent stopped.";

		const abortChild = (): void => {
			if (settled || promptSettled) return;
			// A hung session creation has no session to abort yet; the settle timer below is the only
			// thing that ends the run, and a session created afterwards is disposed by the launch block.
			void session?.abort().catch(() => {
				// The run settles through its prompt promise; abort failures are not separately actionable.
			});
			if (!abortSettleTimer) {
				abortSettleTimer = setTimeout(() => {
					abortSettleTimer = undefined;
					if (!settled && !promptSettled) settle(undefined, true);
				}, ABORT_SETTLE_MS);
				abortSettleTimer.unref?.();
			}
		};

		const clearFinalDrainTimers = (): void => {
			if (finalDrainTimer) {
				clearTimeout(finalDrainTimer);
				finalDrainTimer = undefined;
			}
			if (finalHardFinishTimer) {
				clearTimeout(finalHardFinishTimer);
				finalHardFinishTimer = undefined;
			}
		};

		// If the child emits its terminal event but its run never settles (a hook
		// is stuck), abort it after a short grace period and then finish without it.
		const observeQueuedDrainHold = (): boolean => {
			if (childSessionHasQueuedMessages(session)) queuedDrainHold = true;
			return queuedDrainHold;
		};
		function startFinalDrain(): void {
			if (promptSettled || finalDrainTimer || settled) return;
			if (observeQueuedDrainHold()) return;
			finalDrainTimer = setTimeout(() => {
				if (settled || promptSettled) return;
				if (observeQueuedDrainHold()) {
					finalDrainTimer = undefined;
					startFinalDrain();
					return;
				}
				forcedTermination = true;
				if (!cleanTerminalAssistantStopReceived && !agentSettledReceived && !error && !assistantError) {
					error = `Subagent session did not settle within ${FINAL_STOP_GRACE_MS}ms after its terminal event. Aborting it.`;
				}
				abortChild();
				finalHardFinishTimer = setTimeout(() => {
					if (settled || promptSettled) return;
					settle(undefined, true);
				}, HARD_FINISH_MS);
				finalHardFinishTimer.unref?.();
			}, FINAL_STOP_GRACE_MS);
			finalDrainTimer.unref?.();
		}
		const applyChildLifecycle = (action: ReturnType<typeof projectChildLifecycle>): void => {
			if (action === "cancel-drain") {
				cleanTerminalAssistantStopReceived = false;
				agentSettledReceived = false;
				clearFinalDrainTimers();
				return;
			}
			if (action === "start-drain") startFinalDrain();
		};

		const terminateForTimeout = (message: string): void => {
			if (settled || promptSettled || timedOut || stopped) return;
			timedOut = true;
			interrupted = false;
			error = message;
			abortChild();
		};

		const processEvent = (raw: ChildSessionEvent): void => {
			if (settled) return;
			const event = raw as ChildSessionEvent & { message?: Record<string, unknown>; willRetry?: unknown; [key: string]: unknown };
			if (event.type === "compaction_start") compactionStartedReceived = true;
			if (event.type === "compaction_end" && event.willRetry === true) {
				compactionStartedReceived = false;
				afterCompactionSettlement = false;
			}
			if (event.type === "turn_start" || event.type === "agent_start" || event.type === "auto_retry_start") {
				queuedDrainHold = false;
			}
			if (event.type === "agent_start" || event.type === "auto_retry_start") {
				compactionStartedReceived = false;
				afterCompactionSettlement = false;
			}
			const lifecycleAction = projectChildLifecycle(event, false, childLifecycleState);
			if (event.type === "agent_settled" && lifecycleAction === "start-drain") {
				agentSettledReceived = true;
				afterCompactionSettlement = compactionStartedReceived;
			}
			applyChildLifecycle(lifecycleAction);

			if (event.type === "tool_execution_start" && event.toolName) {
				toolCount += 1;
				return;
			}

			if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
				messages.push(event.message);
				const text = extractTextFromContent(event.message.content);
				if (event.type === "message_end" && event.message.role === "assistant" && text) {
					input.onAssistantPreview?.(text);
				}

				if (event.type !== "message_end" || event.message.role !== "assistant") return;
				if (event.message.model) model = event.message.model as string;
				if (event.message.errorMessage) assistantError = event.message.errorMessage as string;
				else if (assistantStartsToolCall(event.message) && event.message.stopReason === "toolUse") {
					// A recovered request can finish via a terminating tool, without a text stop.
					assistantError = undefined;
				}
				const eventUsage = event.message.usage as ChildUsage | undefined;
				if (eventUsage) {
					usage.turns++;
					usage.input += eventUsage.input ?? eventUsage.inputTokens ?? 0;
					usage.output += eventUsage.output ?? eventUsage.outputTokens ?? 0;
					usage.cacheRead += eventUsage.cacheRead ?? 0;
					usage.cacheWrite += eventUsage.cacheWrite ?? 0;
					usage.cost += eventUsage.cost?.total ?? 0;
				}
				if (isTerminalAssistantStop(event.message)) {
					if (!event.message.errorMessage && extractTextFromContent(event.message.content).trim()) assistantError = undefined;
					cleanTerminalAssistantStopReceived ||= !event.message.errorMessage;
					applyChildLifecycle(projectChildLifecycle(event, true, childLifecycleState));
				}
			}
		};

		/** Stops observing the child and returns when its extensions have shut down. */
		const finish = (): Promise<void> => {
			clearFinalDrainTimers();
			if (abortSettleTimer) {
				clearTimeout(abortSettleTimer);
				abortSettleTimer = undefined;
			}
			if (runTimeoutTimer) {
				clearTimeout(runTimeoutTimer);
				runTimeoutTimer = undefined;
			}
			unsubscribe?.();
			return Promise.resolve().then(() => session?.dispose()).catch(() => undefined);
		};

		/** The child run ended (or was forced to end); fold in the outcome once the child's shutdown work is done. */
		const settle = (promptError: unknown, forced = false): void => {
			if (settled) return;
			settled = true;
			const terminalUsage = session && messageBaseline !== undefined
				? reconcileAttemptUsage(usage, session.messages as unknown as UsageMessage[], messageBaseline)
				: usage;
			const closed = finish();
			const finalOutput = getFinalOutput(messages);
			let finalError = error ?? assistantError;
			const promptErrorMessage = promptError === undefined ? undefined : promptError instanceof Error ? promptError.message : String(promptError);
			if (!finalError && promptErrorMessage !== undefined) {
				finalError = promptErrorMessage;
			}
			const forcedDrainAfterFinalSuccess = (forced || forcedTermination) && (cleanTerminalAssistantStopReceived || agentSettledReceived) && !finalError;
			const forcedDrainAfterEmptyTerminal = forcedDrainAfterFinalSuccess && hasEmptyTerminalAssistantResponse(messages as unknown as Array<{ role?: unknown; content?: unknown; stopReason?: unknown; errorMessage?: unknown; usage?: { output?: number } }>);
			if (!finalError && forced && !forcedDrainAfterFinalSuccess && !interrupted && !timedOut && !stopped) {
				finalError = "Subagent session did not settle after it was aborted.";
			}
			void closed.then(() => {
				const result: ExecuteChildSessionResult = {
					finalOutput: (timedOut || stopped) && !finalOutput.trim() ? (stopped ? stopMessage() : error ?? timeoutMessage()) : finalOutput,
					messageCount: messages.length,
					usage: terminalUsage,
					toolCount,
					durationMs: Date.now() - startedAt,
					...(model !== undefined || session?.modelId !== undefined ? { modelId: model ?? session?.modelId } : {}),
					...(session !== undefined ? { sessionId: session.sessionId } : {}),
					...(stopped
						? { error: stopMessage() }
						: timedOut
							? { error: error ?? timeoutMessage() }
							: interrupted || (forcedDrainAfterFinalSuccess && !forcedDrainAfterEmptyTerminal)
								? {}
								: finalError !== undefined || promptError !== undefined ? { error: finalError } : {}),
					...(interrupted ? { interrupted: true } : {}),
					...(timedOut ? { timedOut: true } : {}),
					...(stopped ? { stopped: true } : {}),
				};
				resolve(result);
			});
		};

		if (input.timeoutMs !== undefined) {
			runTimeoutTimer = setTimeout(() => terminateForTimeout(timeoutMessage()), Math.max(1, input.timeoutMs));
			runTimeoutTimer.unref?.();
		}

		// Same guards as the reference runChildSession registerStop/registerInterrupt handlers.
		stopHandler = () => {
			if (settled || promptSettled || timedOut || stopped) return;
			stopped = true;
			interrupted = false;
			error = stopMessage();
			abortChild();
		};
		interruptHandler = () => {
			if (settled || promptSettled || timedOut || stopped) return;
			interrupted = true;
			if (!error) error = "Interrupted. Waiting for explicit next action.";
			abortChild();
		};

		void (async () => {
			try {
				const created = await input.factory.create(input.launch);
				if (settled) {
					await created.dispose().catch(() => undefined);
					return;
				}
				session = created;
				input.onSessionCreated?.(created);
				unsubscribe = created.subscribe(processEvent);
				if (interrupted || timedOut || stopped) abortChild();
				messageBaseline = created.messages.length;
				await created.prompt(input.prompt);
				promptSettled = true;
				settle(undefined);
			} catch (promptError) {
				promptSettled = true;
				settle(promptError ?? new Error("Child session failed."));
			}
		})();
	});

	return {
		promise,
		stop: () => stopHandler?.(),
		interrupt: () => interruptHandler?.(),
	};
}
