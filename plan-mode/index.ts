/**
 * Plan Mode extension for pi.
 *
 * - Start in plan mode by default (configurable via ~/.pi/agent/plan-mode.json)
 * - Toggle with the configured shortcut (default ctrl+tab) or /plan
 * - While active: edit/write tools are deactivated, bash/powershell are
 *   restricted to a read-only allowlist, and a read-only "Plan contract" is
 *   injected into the system prompt
 * - plan_mode_question tool lets the model ask the user structured questions
 *   instead of guessing preferences
 * - State persists across session resume via a custom session entry
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	findBlockedCommandSegment,
	findBlockedPowerShellCommandSegment,
	readCommand,
	type SafeSubcommands,
} from "./src/bash-policy.ts";
import { PLAN_COMMANDS, loadConfig, saveDefaultOn, type PlanModeConfig } from "./src/config.ts";
import {
	PLAN_MODE_QUESTION_PARAMS,
	PLAN_MODE_QUESTION_TOOL_NAME,
	executePlanModeQuestion,
} from "./src/plan-question.ts";

const STATE_ENTRY_TYPE = "plan-mode-state";
const FOOTER_STATUS_KEY = "plan-mode";
const DISABLED_TOOLS = new Set(["edit", "write"]);

interface ExtensionState {
	enabled: boolean;
}

type SessionEntry = {
	type?: string;
	customType?: string;
	data?: unknown;
};

function restorePersistedState(entries: unknown[]): ExtensionState | undefined {
	const branch = entries as SessionEntry[];
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const candidate = branch[index];
		if (candidate?.type === "custom" && candidate.customType === STATE_ENTRY_TYPE) {
			if (candidate.data && typeof candidate.data === "object" && typeof (candidate.data as { enabled?: unknown }).enabled === "boolean") {
				return { enabled: (candidate.data as { enabled: boolean }).enabled };
			}
			return undefined;
		}
	}
	return undefined;
}

function planContract(shortcut: string): string {
	return `## Plan Mode (ACTIVE — read-only)

You are in plan mode. Explore and plan; do not modify anything.

- File-modifying tools (edit, write) are disabled. Bash and PowerShell are
  restricted to a read-only inspection allowlist: mutating commands (writes,
  redirects, package installs, git commit/push, ...) are blocked.
- Research the code with read-only tools until you can produce a complete,
  directly implementable plan.
- If a decision that materially affects the plan cannot be answered from the
  code, call plan_mode_question (1-3 questions, each with 2-4 options,
  recommended option first) instead of guessing user preferences.
- Present the final plan as markdown in your reply: goal, approach, exact
  files and symbols to change, step-by-step implementation, risks, and
  verification steps.
- Do not attempt to implement the plan. When it is ready, remind the user to
  toggle plan mode off (${shortcut} or /plan off) to start implementation.
  `;
}

export default function planModeExtension(pi: ExtensionAPI) {
	const config: PlanModeConfig = loadConfig();
	const state: ExtensionState = { enabled: false };
	let toolsBeforePlanMode: string[] | undefined;

	const shortcutLabel = () => config.toggleShortcut || "/plan";

	const updateUi = (ctx: ExtensionContext) => {
		ctx.ui.setStatus(FOOTER_STATUS_KEY, state.enabled ? "⏸ plan" : undefined);
	};

	const restrictTools = (names: string[]) => names.filter((name) => !DISABLED_TOOLS.has(name));

	const applyPlanMode = (
		ctx: ExtensionContext,
		next: boolean,
		options: { persist?: boolean; notify?: boolean } = {},
	) => {
		if (next === state.enabled) return;
		state.enabled = next;
		if (next) {
			const active = pi.getActiveTools();
			if (active.length > 0) {
				toolsBeforePlanMode = active;
				pi.setActiveTools(restrictTools(active));
			}
		} else {
			pi.setActiveTools(toolsBeforePlanMode ?? pi.getActiveTools());
			toolsBeforePlanMode = undefined;
		}
		if (options.persist) pi.appendEntry(STATE_ENTRY_TYPE, { enabled: next });
		updateUi(ctx);
		if (options.notify) {
			ctx.ui.notify(
				state.enabled
					? `Plan mode ON — read-only exploration. ${shortcutLabel()} or /plan off to exit.`
					: "Plan mode OFF — file editing enabled.",
				"info",
			);
		}
	};

	const togglePlanMode = (ctx: ExtensionContext) => {
		if (!ctx.isIdle()) {
			ctx.ui.notify("Wait for the current response to finish before toggling plan mode.", "warning");
			return;
		}
		applyPlanMode(ctx, !state.enabled, { persist: true, notify: true });
	};

	pi.registerTool({
		name: PLAN_MODE_QUESTION_TOOL_NAME,
		label: "Plan question",
		description:
			"Ask the user 1-3 structured questions, each with 2-4 options, through an interactive selector. " +
			"Use it whenever a decision that materially affects your plan (scope, tradeoffs, user preferences) " +
			"cannot be answered from the code. Never guess user preferences; ask instead.",
		parameters: PLAN_MODE_QUESTION_PARAMS,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => executePlanModeQuestion(params, ctx),
	});

	pi.registerCommand("plan", {
		description: "Toggle Plan mode (/plan on|off|status|default-on|default-off)",
		getArgumentCompletions: (prefix) =>
			PLAN_COMMANDS.filter((command) => command.startsWith(prefix)).map((command) => ({
				value: command,
				label: command,
				description: {
					on: "Enable plan mode (read-only)",
					off: "Disable plan mode",
					status: "Show plan mode status",
					"default-on": "Start in plan mode by default",
					"default-off": "Do not start in plan mode by default",
				}[command],
			})),
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase();
			if (!sub) {
				togglePlanMode(ctx);
				return;
			}
			switch (sub) {
				case "on":
				case "start":
					if (!ctx.isIdle()) {
						ctx.ui.notify("Wait for the current response to finish before toggling plan mode.", "warning");
						return;
					}
					applyPlanMode(ctx, true, { persist: true, notify: true });
					return;
				case "off":
				case "stop":
					if (!ctx.isIdle()) {
						ctx.ui.notify("Wait for the current response to finish before toggling plan mode.", "warning");
						return;
					}
					applyPlanMode(ctx, false, { persist: true, notify: true });
					return;
				case "status":
					ctx.ui.notify(
						`Plan mode: ${state.enabled ? "ON (read-only)" : "OFF"} · default: ${
							config.defaultOn ? "on" : "off"
						} · toggle: ${shortcutLabel()} · config: ~/.pi/agent/plan-mode.json`,
						"info",
					);
					return;
				case "default-on":
				case "default-off": {
					const defaultOn = sub === "default-on";
					if (saveDefaultOn(defaultOn)) {
						config.defaultOn = defaultOn;
						ctx.ui.notify(`Plan mode default set to ${defaultOn ? "on" : "off"} (saved to plan-mode.json).`, "info");
					} else {
						ctx.ui.notify("Failed to write ~/.pi/agent/plan-mode.json.", "error");
					}
					return;
				}
				default:
					ctx.ui.notify("Usage: /plan [on|off|status|default-on|default-off]", "warning");
			}
		},
	});

	if (config.toggleShortcut) {
		pi.registerShortcut(config.toggleShortcut, {
			description: "Toggle Plan mode",
			handler: (ctx) => togglePlanMode(ctx),
		});
	}

	pi.registerFlag("plan", {
		description: "Start in plan mode (overrides the defaultOn setting in plan-mode.json)",
		type: "boolean",
		default: false,
	});

	pi.on("session_start", (event, ctx) => {
		const persisted = restorePersistedState(ctx.sessionManager.getBranch());
		const forcedByFlag = pi.getFlag("plan") === true;
		const target = persisted ? persisted.enabled : forcedByFlag || config.defaultOn;
		state.enabled = !target; // force the transition below to run
		applyPlanMode(ctx, target, { persist: !persisted });
		if (state.enabled) {
			ctx.ui.notify(`Plan mode active (${event.reason}) — read-only. ${shortcutLabel()} or /plan off to exit.`, "info");
		}
	});

	pi.on("tool_call", (event, ctx) => {
		if (!state.enabled) return;
		if (event.toolName === "edit" || event.toolName === "write") {
			return {
				block: true,
				reason: `Plan mode is active: '${event.toolName}' is blocked. Explore read-only, write the plan into your reply, and toggle plan mode off (${shortcutLabel()} or /plan off) to modify files.`,
			};
		}
		if (event.toolName === "bash") {
			const blocked = findBlockedCommandSegment(readCommand(event.input), config.safeSubcommands as SafeSubcommands, ctx.cwd);
			if (blocked !== undefined) {
				return {
					block: true,
					reason: `Plan mode blocks bash commands outside its read-only inspection policy.\nBlocked command: ${blocked}\nUse read-only commands, or ask the user to toggle plan mode off (${shortcutLabel()}).`,
				};
			}
			return;
		}
		if (event.toolName === "powershell") {
			const blocked = findBlockedPowerShellCommandSegment(
				readCommand(event.input),
				config.safeSubcommands as SafeSubcommands,
				ctx.cwd,
			);
			if (blocked !== undefined) {
				return {
					block: true,
					reason: `Plan mode blocks PowerShell commands outside its read-only inspection policy.\nBlocked command: ${blocked}\nUse read-only commands, or ask the user to toggle plan mode off (${shortcutLabel()}).`,
				};
			}
		}
	});

	pi.on("before_agent_start", (event) => {
		if (!state.enabled) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${planContract(shortcutLabel())}` };
	});
}
