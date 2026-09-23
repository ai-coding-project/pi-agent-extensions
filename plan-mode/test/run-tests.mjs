/**
 * Test runner for the plan-mode extension.
 * Uses jiti (bundled with pi) to load TypeScript sources directly.
 *
 * Run: node test/run-tests.mjs
 */

import { createJiti } from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
import { homedir } from "node:os";
import assert from "node:assert";

const jiti = createJiti(import.meta.url);
let passed = 0;
let failed = 0;

function test(name, fn) {
	try {
		fn();
		passed += 1;
	} catch (error) {
		failed += 1;
		console.error(`✗ ${name}\n  ${error.message}`);
	}
}

// ---------- bash policy ----------
const policy = await jiti.import("../src/bash-policy.ts");
const safe = (cmd, safeSubcommands, cwd) => policy.findBlockedCommandSegment(cmd, safeSubcommands, cwd) === undefined;
const psSafe = (cmd, safeSubcommands, cwd) =>
	policy.findBlockedPowerShellCommandSegment(cmd, safeSubcommands, cwd) === undefined;

test("read-only commands are allowed", () => {
	for (const cmd of [
		"ls -la",
		"cat foo.txt | grep bar",
		"grep -rn 'pattern' src/",
		'find . -name "*.ts"',
		"pwd",
		"echo hello world",
		"wc -l file.txt",
		"ps aux",
		"jq . package.json",
		"rg 'pattern' .",
		"which node",
		"stat file.txt",
		"du -sh .",
		"date",
	]) {
		assert.ok(safe(cmd), `should be safe: ${cmd}`);
	}
});

test("mutating commands are blocked", () => {
	for (const cmd of [
		"rm -rf /",
		"touch newfile",
		"mkdir dir",
		"mv a b",
		"cp a b",
		"chmod +x script.sh",
		"kill 123",
		"sudo ls",
		"vim file.txt",
	]) {
		assert.ok(!safe(cmd), `should be blocked: ${cmd}`);
	}
});

test("shell syntax that cannot be parsed safely is blocked (fail closed)", () => {
	for (const cmd of [
		"ls > out.txt",
		"cat < input.txt",
		"echo $HOME",
		"echo `whoami`",
		"echo $(date)",
		"FOO=1 ls",
		'echo "hi',
		"echo hi &",
		"ls (1)",
	]) {
		assert.ok(!safe(cmd), `should be blocked: ${cmd}`);
	}
});

test("multi-segment commands: any unsafe segment blocks the whole command", () => {
	assert.ok(!safe("cat foo && rm -rf bar"));
	assert.ok(!safe("ls; rm x"));
	assert.ok(safe("cat foo && ls bar"));
});

test("dangerous arguments are blocked even for whitelisted commands", () => {
	for (const cmd of [
		"sed -i 's/a/b/' file.txt",
		"sed 's/a/b/' file.txt", // no -n: not a print-only script
		"find . -name x -delete",
		"find . -exec rm {} \\;",
		"sort -o out in",
		"date -s now",
		"fd -x rm",
		"rg --pre cmd pattern",
	]) {
		assert.ok(!safe(cmd), `should be blocked: ${cmd}`);
	}
});

test("structured safe commands", () => {
	for (const cmd of [
		"sed -n '1,5p' file.txt",
		"sed -n '10,20p' file.txt",
		"tsc --noEmit",
		"node --version",
		"python3 --version",
		"npm test",
		"npm run lint",
		"npm run typecheck",
		"npm audit",
		"npm list",
		"pytest",
		"pytest tests/",
		"cargo test",
		"go test ./...",
		"vitest run",
		"jest",
	]) {
		assert.ok(safe(cmd), `should be safe: ${cmd}`);
	}
	for (const cmd of [
		"npm install",
		"npm run dev",
		"npm audit fix",
		"node script.js",
		"tsc file.ts",
		"python -c 'print(1)'",
	]) {
		assert.ok(!safe(cmd), `should be blocked: ${cmd}`);
	}
});

test("git allowlist with per-subcommand argument validation", () => {
	for (const cmd of [
		"git status",
		"git log --oneline -5",
		"git diff HEAD~1",
		"git show abc123",
		"git branch --list",
		"git branch -a",
		"git remote -v",
		"git remote get-url origin",
		"git remote show",
		"git ls-files",
		"git grep pattern",
		"git --no-pager log -1",
		"git -C . status",
	]) {
		assert.ok(safe(cmd, {}, process.cwd()), `should be safe: ${cmd}`);
	}
	for (const cmd of [
		"git push",
		"git pull",
		"git commit -m x",
		"git add .",
		"git checkout -b feature",
		"git branch -D feature",
		"git branch --move main",
		"git reset --hard",
		"git clone url",
		"git -C /tmp status", // -C outside cwd
		"git remote show origin", // contacts the network
		"git log --output out.txt",
		"git log --ext-diff",
		"git status --help",
	]) {
		assert.ok(!safe(cmd, {}, process.cwd()), `should be blocked: ${cmd}`);
	}
});

test("configured safeSubcommands extend the allowlist", () => {
	const config = { kubectl: ["get", "describe"] };
	assert.ok(safe("kubectl get pods", config));
	assert.ok(safe("kubectl describe pod web-0", config));
	assert.ok(!safe("kubectl delete pod web-0", config));
	assert.ok(!safe("kubectl get pods", {}));
	assert.ok(safe("git rev-parse HEAD", { git: ["rev-parse"] }));
	// prefix boundary must be respected
	assert.ok(!safe("kubectl getter", config));
});

test("PowerShell read-only allowlist", () => {
	for (const cmd of [
		"Get-ChildItem -Recurse",
		"Get-Content file.txt",
		"Get-Item ./foo",
		"Select-String -Path a.txt -Pattern x",
		"Get-Process -Name node",
		"Get-Service",
		"Write-Output 'hi'",
		"Format-Table",
		"git status",
	]) {
		assert.ok(psSafe(cmd), `should be safe: ${cmd}`);
	}
	for (const cmd of [
		"Remove-Item foo",
		"Set-Content -Path x -Value y",
		"New-Item file.txt",
		"Stop-Process -Name node",
		"Get-Process | Stop-Process",
		"Get-ChildItem; Remove-Item x",
		"$(Get-Date)",
		"Write-Host 'hi'",
		"--%",
	]) {
		assert.ok(!psSafe(cmd), `should be blocked: ${cmd}`);
	}
});

// ---------- plan_mode_question parameter normalization ----------
const question = await jiti.import("../src/plan-question.ts");

test("question params normalization accepts valid input", () => {
	const parsed = question.normalizePlanModeQuestionParams({
		questions: [
			{ id: "lib", header: "Library", question: "Which library?", options: [
				{ label: "A", description: "option A" },
				{ label: "B", description: "option B" },
			] },
		],
	});
	assert.ok(parsed.ok);
	assert.equal(parsed.questions.length, 1);
});

test("question params normalization rejects invalid input", () => {
	for (const input of [
		{},
		{ questions: [] },
		{ questions: [{ id: "x", header: "h", question: "q", options: [{ label: "a", description: "d" }] }] },
		{ questions: [{ id: "", header: "h", question: "q", options: [{ label: "a", description: "d" }, { label: "b", description: "d" }] }] },
		{ questions: [{ id: "x", header: "h", question: "q", options: [{ label: "a" }, { label: "b", description: "d" }] }] },
	]) {
		assert.ok(!question.normalizePlanModeQuestionParams(input).ok, `should reject: ${JSON.stringify(input)}`);
	}
});

// ---------- extension wiring (mock pi) ----------
const extension = await jiti.import("../index.ts");

function makeMockPi() {
	const mock = {
		tools: [],
		commands: {},
		shortcuts: [],
		flags: [],
		events: {},
		entries: [],
		activeTools: undefined,
		registerTool: (tool) => mock.tools.push(tool),
		registerCommand: (name, options) => (mock.commands[name] = options),
		registerShortcut: (shortcut, options) => mock.shortcuts.push([shortcut, options]),
		registerFlag: (name, options) => mock.flags.push([name, options]),
		getFlag: () => false,
		getActiveTools: () => mock._allTools,
		setActiveTools: (names) => (mock.activeTools = names),
		appendEntry: (type, data) => mock.entries.push([type, data]),
		on: (event, handler) => {
			(mock.events[event] ??= []).push(handler);
		},
		_allTools: ["read", "bash", "edit", "write", PLAN_QUESTION_NAME()],
	};
	function PLAN_QUESTION_NAME() {
		return "plan_mode_question";
	}
	return mock;
}

function makeMockCtx(branch = []) {
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

test("extension registers tools, command, shortcut, flag and event handlers", () => {
	const pi = makeMockPi();
	extension.default(pi);
	assert.equal(pi.tools.length, 1);
	assert.equal(pi.tools[0].name, "plan_mode_question");
	assert.ok(pi.commands.plan);
	assert.ok(pi.shortcuts.some(([shortcut]) => shortcut === "ctrl+tab"));
	assert.ok(pi.flags.some(([name]) => name === "plan"));
	assert.ok(pi.events.session_start && pi.events.tool_call && pi.events.before_agent_start);
});

test("session_start applies defaultOn and restricts tools", () => {
	const pi = makeMockPi();
	extension.default(pi);
	pi.events.session_start[0]({ reason: "startup" }, makeMockCtx());
	assert.equal(pi.activeTools.includes("edit"), false);
	assert.equal(pi.activeTools.includes("write"), false);
	assert.equal(pi.activeTools.includes("bash"), true);
	assert.equal(pi.activeTools.includes("plan_mode_question"), true);
	assert.equal(pi.entries.at(-1)?.[0], "plan-mode-state");
	assert.equal(pi.entries.at(-1)?.[1].enabled, true);
});

test("session_start restores persisted state (plan mode off)", () => {
	const pi = makeMockPi();
	extension.default(pi);
	const branch = [{ type: "custom", customType: "plan-mode-state", data: { enabled: false } }];
	pi.events.session_start[0]({ reason: "resume" }, makeMockCtx(branch));
	assert.ok(pi.activeTools.includes("edit"));
	assert.equal(pi.entries.length, 0, "no new entry when restoring persisted state");
});

test("tool_call blocks edit/write and unsafe bash while plan mode is on", async () => {
	const pi = makeMockPi();
	extension.default(pi);
	pi.events.session_start[0]({ reason: "startup" }, makeMockCtx());
	const [handler] = pi.events.tool_call;
	assert.ok(handler({ toolName: "edit", input: {} }, makeMockCtx())?.block);
	assert.ok(handler({ toolName: "write", input: {} }, makeMockCtx())?.block);
	assert.ok(handler({ toolName: "bash", input: { command: "rm -rf /" } }, makeMockCtx())?.block);
	assert.ok(handler({ toolName: "bash", input: { command: "ls > x" } }, makeMockCtx())?.block);
	assert.equal(handler({ toolName: "bash", input: { command: "ls -la" } }, makeMockCtx()), undefined);
	assert.equal(handler({ toolName: "read", input: { path: "x" } }, makeMockCtx()), undefined);
});

test("before_agent_start injects the plan contract while enabled", () => {
	const pi = makeMockPi();
	extension.default(pi);
	pi.events.session_start[0]({ reason: "startup" }, makeMockCtx());
	const result = pi.events.before_agent_start[0]({ systemPrompt: "BASE" }, makeMockCtx());
	assert.ok(result.systemPrompt.startsWith("BASE"));
	assert.ok(result.systemPrompt.includes("Plan Mode (ACTIVE"));
});

test("/plan off restores tools and /plan status works", async () => {
	const pi = makeMockPi();
	extension.default(pi);
	const ctx = makeMockCtx();
	pi.events.session_start[0]({ reason: "startup" }, ctx);
	await pi.commands.plan.handler("off", ctx);
	assert.ok(pi.activeTools.includes("edit"));
	assert.equal(pi.entries.at(-1)?.[1].enabled, false);
	await pi.commands.plan.handler("status", ctx);
	await pi.commands.plan.handler("on", ctx);
	assert.equal(pi.activeTools.includes("edit"), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
