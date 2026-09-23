/**
 * Completion notification delivered back into the parent session.
 *
 * Adapted from the reference implementation's `src/runs/background/notify.ts`
 * (`formatSingleCompletion`): keep the status + agent + result-preview shape,
 * drop workflow/schedule/watchdog/handoff blocks.
 */
import { formatDuration } from "./utils.ts";
import type { ChildSessionExecuteResult, RunRecord } from "./types.ts";
import type { SubagentHostPi } from "./tool.ts";

export interface SubagentNotifyDetails {
	run: RunRecord;
	result: ChildSessionExecuteResult;
}

/** Status word for a settled run. */
export function statusWord(status: RunRecord["status"]): string {
	switch (status) {
		case "completed": return "completed";
		case "failed": return "failed";
		case "stopped": return "stopped";
		case "timeout": return "timed out";
		case "running": return "still running";
	}
}

function formatTokens(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

function formatResultPreview(result: ChildSessionExecuteResult, maxLength = 2_000): string {
	const preview = result.finalOutput.length > maxLength ? `${result.finalOutput.slice(0, maxLength)}\n[output truncated]` : result.finalOutput;
	return preview.trim() ? preview : "(no output)";
}

/** Single-run completion notice, modeled on the reference formatSingleCompletion. */
export function formatCompletion(details: SubagentNotifyDetails): string {
	const { run, result } = details;
	const usageLine = result.usage.turns > 0
		? `Duration: ${formatDuration(result.durationMs)} · Tokens: in ${formatTokens(result.usage.input)} / out ${formatTokens(result.usage.output)} · Tools: ${result.toolCount}`
		: `Duration: ${formatDuration(result.durationMs)} · Tools: ${result.toolCount}`;
	return [
		`Background task ${statusWord(run.status)}: **${run.agent}**${run.task ? ` — ${run.task}` : ""}`,
		"",
		formatResultPreview(result),
		...(result.error ? ["", `Error: ${result.error}`] : []),
		"",
		usageLine,
		`Run id: ${run.id}${run.model ? ` · Model: ${run.model}` : ""}`,
	].join("\n");
}

/** One-shot async completion notification: never throws into the run loop. */
export function sendCompletion(pi: SubagentHostPi, content: string): void {
	try {
		// Defaults: deliverAs=steer + triggerTurn=true, matching the reference's
		// completion notification; steer queues while the parent is streaming.
		pi.sendMessage({ customType: "subagent-lite-notify", content, display: true }, { triggerTurn: true });
	} catch {
		// The child already settled; a failed notification must not crash the caller.
	}
}
