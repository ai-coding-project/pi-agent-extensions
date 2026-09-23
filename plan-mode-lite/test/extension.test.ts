/**
 * Extension wiring tests with a mock pi host. PLAN_MODE_CONFIG_DIR is pointed
 * at a fresh temp directory so loadConfig() deterministically returns the
 * defaults instead of the developer's real ~/.pi/agent/plan-mode-lite.json.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import planModeExtension from "../index.ts";

process.env.PLAN_MODE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "plan-mode-test-"));

type MockCtx = {
	cwd: string;
	isIdle: () => boolean;
	sessionManager: { getBranch: () => unknown[] };
	ui: {
		notify: (message: string, level?: string) => void;
		setStatus: (key: string, value?: string) => void;
	};
};

type Handler = (event: any, ctx: MockCtx) => any;

interface MockPi {
	tools: Array<{ name: string }>;
	commands: Record<string, { handler: (args: string, ctx: MockCtx) => Promise<void> | void }>;
	shortcuts: Array<[string, unknown]>;
	flags: Array<[string, unknown]>;
	events: Record<string, Handler[]>;
	entries: Array<[string, unknown]>;
	activeTools: string[] | undefined;
	_allTools: string[];
	registerTool: (tool: { name: string }) => void;
	registerCommand: (name: string, options: { handler: (args: string, ctx: MockCtx) => Promise<void> | void }) => void;
	registerShortcut: (shortcut: string, options: unknown) => void;
	registerFlag: (name: string, options: unknown) => void;
	getFlag: (name: string) => boolean;
	getActiveTools: () => string[];
	setActiveTools: (names: string[]) => void;
	appendEntry: (type: string, data: unknown) => void;
	on: (event: string, handler: Handler) => void;
}

function makeMockPi(): MockPi {
	const mock: MockPi = {
		tools: [],
		commands: {},
		shortcuts: [],
		flags: [],
		events: {},
		entries: [],
		activeTools: undefined,
		_allTools: ["read", "bash", "edit", "write", "plan_mode_question"],
		registerTool: (tool) => {
			mock.tools.push(tool);
		},
		registerCommand: (name, options) => {
			mock.commands[name] = options;
		},
		registerShortcut: (shortcut, options) => {
			mock.shortcuts.push([shortcut, options]);
		},
		registerFlag: (name, options) => {
			mock.flags.push([name, options]);
		},
		getFlag: () => false,
		getActiveTools: () => mock._allTools,
		setActiveTools: (names) => {
			mock.activeTools = names;
		},
		appendEntry: (type, data) => {
			mock.entries.push([type, data]);
		},
		on: (event, handler) => {
			(mock.events[event] ??= []).push(handler);
		},
	};
	return mock;
}

function makeMockCtx(branch: unknown[] = []): MockCtx {
	return {
		cwd: "/tmp",
		isIdle: () => true,
		sessionManager: { getBranch: () => branch },
		ui: {
			notify: () => {},
			setStatus: () => {},
		},
	};
}

function load(): MockPi {
	const pi = makeMockPi();
	planModeExtension(pi as unknown as ExtensionAPI);
	return pi;
}

function firstHandler(pi: MockPi, name: string): Handler {
	return pi.events[name]![0]!;
}

function lastEntry(pi: MockPi): { type: string; data: { enabled?: boolean } } {
	const entry = pi.entries.at(-1)!;
	return { type: entry[0] as string, data: entry[1] as { enabled?: boolean } };
}

test("extension registers tools, command, shortcut, flag and event handlers", () => {
	const pi = load();
	assert.equal(pi.tools.length, 1);
	assert.equal(pi.tools[0]!.name, "plan_mode_question");
	assert.ok(pi.commands.plan);
	assert.ok(pi.shortcuts.some(([shortcut]) => shortcut === "ctrl+tab"));
	assert.ok(pi.flags.some(([name]) => name === "plan"));
	assert.ok(pi.events.session_start && pi.events.tool_call && pi.events.before_agent_start);
});

test("session_start applies defaultOn and restricts tools", () => {
	const pi = load();
	firstHandler(pi, "session_start")({ reason: "startup" }, makeMockCtx());
	assert.equal(pi.activeTools!.includes("edit"), false);
	assert.equal(pi.activeTools!.includes("write"), false);
	assert.equal(pi.activeTools!.includes("bash"), true);
	assert.equal(pi.activeTools!.includes("plan_mode_question"), true);
	assert.equal(lastEntry(pi).type, "plan-mode-state");
	assert.equal(lastEntry(pi).data.enabled, true);
});

test("session_start restores persisted state (plan mode off)", () => {
	const pi = load();
	const branch = [{ type: "custom", customType: "plan-mode-state", data: { enabled: false } }];
	firstHandler(pi, "session_start")({ reason: "resume" }, makeMockCtx(branch));
	assert.ok(pi.activeTools!.includes("edit"));
	assert.equal(pi.entries.length, 0, "no new entry when restoring persisted state");
});

test("tool_call blocks edit/write and unsafe bash while plan mode is on", () => {
	const pi = load();
	firstHandler(pi, "session_start")({ reason: "startup" }, makeMockCtx());
	const handler = firstHandler(pi, "tool_call");
	assert.ok(handler({ toolName: "edit", input: {} }, makeMockCtx())?.block);
	assert.ok(handler({ toolName: "write", input: {} }, makeMockCtx())?.block);
	assert.ok(handler({ toolName: "bash", input: { command: "rm -rf /" } }, makeMockCtx())?.block);
	assert.ok(handler({ toolName: "bash", input: { command: "ls > x" } }, makeMockCtx())?.block);
	assert.equal(handler({ toolName: "bash", input: { command: "ls -la" } }, makeMockCtx()), undefined);
	assert.equal(handler({ toolName: "read", input: { path: "x" } }, makeMockCtx()), undefined);
});

test("before_agent_start injects the plan contract while enabled", () => {
	const pi = load();
	firstHandler(pi, "session_start")({ reason: "startup" }, makeMockCtx());
	const result = firstHandler(pi, "before_agent_start")({ systemPrompt: "BASE" }, makeMockCtx());
	assert.ok(result.systemPrompt.startsWith("BASE"));
	assert.ok(result.systemPrompt.includes("Plan Mode (ACTIVE"));
});

test("/plan off restores tools and /plan status works", async () => {
	const pi = load();
	const ctx = makeMockCtx();
	firstHandler(pi, "session_start")({ reason: "startup" }, ctx);
	await pi.commands.plan!.handler("off", ctx);
	assert.ok(pi.activeTools!.includes("edit"));
	assert.equal(lastEntry(pi).data.enabled, false);
	await pi.commands.plan!.handler("status", ctx);
	await pi.commands.plan!.handler("on", ctx);
	assert.equal(pi.activeTools!.includes("edit"), false);
});
