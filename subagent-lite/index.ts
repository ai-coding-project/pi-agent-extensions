/**
 * subagent-lite — minimal child-agent delegation for pi.
 *
 * Registers one tool (`subagent-lite`) that runs child agents synchronously or
 * in the background, and cleans up all live children when the session shuts
 * down (the parent process owns the child sessions; if it exits, background
 * runs end with it).
 */
import { registerSubagentTool } from "./src/tool.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
	try {
		// registerSubagentTool wires its own session_shutdown cleanup.
		registerSubagentTool(pi);
	} catch (error) {
		// A broken extension must not crash the host session; surface the problem.
		console.error("[subagent-lite] registration failed:", error instanceof Error ? error.message : error);
	}
}
