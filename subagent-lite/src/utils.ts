/**
 * Small shared helpers extracted from the reference implementation
 * (pi-subagents src/shared/utils.ts and src/shared/formatters.ts).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** pi's global agent dir: PI_CODING_AGENT_DIR env or ~/.pi/agent. */
export function getAgentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR;
	const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
	if (configured === "~") return home;
	if (configured?.startsWith("~/") || configured?.startsWith("~\\")) return path.join(home, configured.slice(2));
	return configured || path.join(home, ".pi", "agent");
}

/**
 * pi's interactive TUI appends a turn-timing footer to final text; strip it so
 * child output stays clean.
 */
const PI_TURN_TIMING_FOOTER = /(?:\r?\n)*\x1b\[38;2;136;136;136m✻ Turn took [^()\r\n]+ \(Total time [^·\r\n]+ · \d+ turns?\)\x1b\[0m[ \t]*$/u;

function stripPiTurnTimingFooter(text: string): string {
	return text.replace(PI_TURN_TIMING_FOOTER, "");
}

/**
 * The child's final output: the text of the most recent assistant message that
 * is not an error message. (Simplified from the reference getFinalOutput:
 * the acceptance-report early-returns are irrelevant without that feature.)
 */
export function getFinalOutput(messages: Array<{ role?: unknown; content?: unknown; errorMessage?: unknown; stopReason?: unknown }>): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg || msg.role !== "assistant") continue;
		const hasAssistantError = (typeof msg.errorMessage === "string" && msg.errorMessage.length > 0) || msg.stopReason === "error";
		if (hasAssistantError) continue;
		if (!Array.isArray(msg.content)) continue;
		const text = msg.content
			.flatMap((part) => {
				if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "text") return [];
				const value = (part as { text?: unknown }).text;
				return typeof value === "string" ? [stripPiTurnTimingFooter(value)] : [];
			})
			.join("\n");
		if (text.trim().length > 0) return text;
	}
	return "";
}

export function hasEmptyTerminalAssistantResponse(messages: Array<{ role?: unknown; content?: unknown; stopReason?: unknown; errorMessage?: unknown; usage?: { output?: number } }>): boolean {
	const lastAssistant = messages.findLast((message) => message.role === "assistant");
	return lastAssistant?.role === "assistant"
		&& Array.isArray(lastAssistant.content)
		&& ((lastAssistant.content.length === 0 && (lastAssistant.usage?.output ?? 0) === 0)
			|| (messages.at(-1) === lastAssistant
				&& lastAssistant.stopReason === "stop"
				&& !lastAssistant.errorMessage
				&& lastAssistant.content.length > 0
				// Token accounting can be nonzero even when no response text was emitted.
				&& lastAssistant.content.every((part) => typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" && (part as { text?: unknown }).text === "")));
}

/** Extract text content from various message content formats. */
export function extractTextFromContent(content: unknown): string {
	if (!content) return "";
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const texts: string[] = [];
	for (const part of content) {
		if (part && typeof part === "object") {
			if ("type" in part && part.type === "text" && "text" in part) {
				texts.push(String((part as { text: unknown }).text));
			} else if ("type" in part && part.type === "tool_result" && "content" in part) {
				const inner = extractTextFromContent((part as { content: unknown }).content);
				if (inner) texts.push(inner);
			} else if ("text" in part) {
				texts.push(String((part as { text: unknown }).text));
			}
		}
	}
	return texts.join("\n");
}

/** Format duration in human-readable form. */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

/** Shorten a path by replacing the home directory with ~. */
export function shortenPath(p: string): string {
	const home = process.env.HOME;
	if (home && p.startsWith(home)) {
		return `~${p.slice(home.length)}`;
	}
	return p;
}

/** Truncate text to a maximum length with a visible marker. */
export function truncateText(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength)}\n\n[truncated ${text.length - maxLength} characters]`;
}
