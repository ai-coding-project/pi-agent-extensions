/**
 * Parameter validation and agent resolution for the subagent-lite tool.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { registerSubagentTool } from "../src/tool.ts";
import { createFakeFactory } from "./support/fake-factory.ts";
import { createFakeHost, createFakeContext, resultText, type FakeHost } from "./support/fake-host.ts";
import { createIsolatedAgentDir, writeAgentFile } from "./support/isolated-agent-dir.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function setup(t: TestContext) {
	const agentDir = createIsolatedAgentDir(t as unknown as Parameters<typeof createIsolatedAgentDir>[0]);
	const host: FakeHost = createFakeHost();
	const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-lite-validation-"));
	writeAgentFile(agentDir, "agents/reviewer.md", "---\nname: reviewer\ndescription: Reviews code\n---\nYou review code.");
	return { host, projectDir };
}

function callTool(host: FakeHost, params: Record<string, unknown>, overrides: { cwd?: string; sessionId?: string; model?: { provider: string; id: string }; thinkingLevel?: string; signal?: AbortSignal; onUpdate?: unknown } = {}): Promise<{ text: string; isError: boolean }> {
	const tool = host.registeredTools[0]!;
	const execute = tool.execute as (id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) => Promise<unknown>;
	return execute("call-1", params, overrides.signal as AbortSignal | undefined, overrides.onUpdate, createFakeContext({ cwd: overrides.cwd, sessionId: overrides.sessionId, model: overrides.model, thinkingLevel: overrides.thinkingLevel })).then(resultText);
}

test("empty task is rejected", async (t) => {
	const { host, projectDir } = setup(t);
	registerSubagentTool(host.pi, { factory: createFakeFactory({ hang: true }) });
	const reply = await callTool(host, { task: "   ", systemPrompt: "Helper." }, { cwd: projectDir });
	assert.equal(reply.isError, true);
	assert.match(reply.text, /task is required/);
});

test("missing agent and systemPrompt is rejected", async (t) => {
	const { host, projectDir } = setup(t);
	registerSubagentTool(host.pi, { factory: createFakeFactory({ hang: true }) });
	const reply = await callTool(host, { task: "Do it" }, { cwd: projectDir });
	assert.equal(reply.isError, true);
	assert.match(reply.text, /either agent .* or systemPrompt/);
});

test("agent and systemPrompt together are rejected", async (t) => {
	const { host, projectDir } = setup(t);
	registerSubagentTool(host.pi, { factory: createFakeFactory({ hang: true }) });
	const reply = await callTool(host, { task: "Do it", agent: "reviewer", systemPrompt: "Inline." }, { cwd: projectDir });
	assert.equal(reply.isError, true);
	assert.match(reply.text, /mutually exclusive/);
});

test("unknown agent lists the available agents", async (t) => {
	const { host, projectDir } = setup(t);
	registerSubagentTool(host.pi, { factory: createFakeFactory({ hang: true }) });
	const reply = await callTool(host, { task: "Do it", agent: "nonexistent" }, { cwd: projectDir });
	assert.equal(reply.isError, true);
	assert.match(reply.text, /Unknown agent 'nonexistent'/);
	assert.match(reply.text, /Available agents: reviewer/);
});

test("nonexistent cwd is rejected", async (t) => {
	const { host, projectDir } = setup(t);
	registerSubagentTool(host.pi, { factory: createFakeFactory({ hang: true }) });
	const reply = await callTool(host, { task: "Do it", systemPrompt: "Helper.", cwd: path.join(projectDir, "does-not-exist") });
	assert.equal(reply.isError, true);
	assert.match(reply.text, /does not exist or is not a directory/);
});

test("a relative cwd resolves against the session cwd, not the process cwd", async (t) => {
	const { host } = setup(t);
	const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-lite-session-"));
	const processDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-lite-process-"));
	fs.mkdirSync(path.join(sessionDir, "sub"));
	fs.mkdirSync(path.join(processDir, "sub"));
	t.after(() => {
		fs.rmSync(sessionDir, { recursive: true, force: true });
		fs.rmSync(processDir, { recursive: true, force: true });
	});
	const factory = createFakeFactory({ events: [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop", usage: { input: 10, output: 5 } } }] });
	registerSubagentTool(host.pi, { factory });
	const previousCwd = process.cwd();
	process.chdir(processDir);
	try {
		// ctx.cwd (sessionDir) differs from process.cwd() (processDir); the
		// relative "sub" must resolve next to the session cwd.
		const reply = await callTool(host, { task: "Do it", systemPrompt: "Helper.", cwd: "sub" }, { cwd: sessionDir });
		assert.equal(reply.isError, false);
		assert.equal(factory.launches[0]!.cwd, path.join(sessionDir, "sub"));
	} finally {
		process.chdir(previousCwd);
	}
});

test("timeoutMs below 1 is rejected", async (t) => {
	const { host, projectDir } = setup(t);
	registerSubagentTool(host.pi, { factory: createFakeFactory({ hang: true }) });
	const reply = await callTool(host, { task: "Do it", systemPrompt: "Helper.", timeoutMs: 0 }, { cwd: projectDir });
	assert.equal(reply.isError, true);
	assert.match(reply.text, /timeoutMs/);
});

test("invalid model references are rejected before launch", async (t) => {
	const { host, projectDir } = setup(t);
	registerSubagentTool(host.pi, { factory: createFakeFactory({ hang: true }) });
	const missingBase = await callTool(host, { task: "Do it", systemPrompt: "Helper.", model: ":high" }, { cwd: projectDir });
	assert.equal(missingBase.isError, true);
	assert.match(missingBase.text, /missing model id/);
	const extraSlash = await callTool(host, { task: "Do it", systemPrompt: "Helper.", model: "a/b/c" }, { cwd: projectDir });
	assert.equal(extraSlash.isError, true);
	assert.match(extraSlash.text, /expected 'provider\/id'/);
});

test("inline systemPrompt mode replaces the child's system prompt", async (t) => {
	const { host, projectDir } = setup(t);
	const factory = createFakeFactory({ events: [{ type: "agent_settled" }] });
	registerSubagentTool(host.pi, { factory });
	await callTool(host, { task: "Do it", systemPrompt: "Inline prompt." }, { cwd: projectDir });
	assert.equal(factory.launches[0]!.systemPrompt, "Inline prompt.");
	assert.equal(factory.launches[0]!.systemPromptMode, "replace");
});

test("agent system prompt and mode come from the agent definition", async (t) => {
	const { host, projectDir } = setup(t);
	writeAgentFile(process.env.PI_CODING_AGENT_DIR!, "agents/appender.md", "---\nname: appender\ndescription: Appends\nsystemPromptMode: append\n---\nAppendix prompt.");
	const factory = createFakeFactory({ events: [{ type: "agent_settled" }] });
	registerSubagentTool(host.pi, { factory });
	await callTool(host, { task: "Do it", agent: "appender" }, { cwd: projectDir });
	const launch = factory.launches[0]!;
	assert.equal(launch.systemPrompt!.trim(), "Appendix prompt.");
	assert.equal(launch.systemPromptMode, "append");
});

test("agent tools are inherited when the call omits tools", async (t) => {
	const { host, projectDir } = setup(t);
	writeAgentFile(process.env.PI_CODING_AGENT_DIR!, "agents/limited.md", "---\nname: limited\ndescription: Limited tools\ntools:\n  - read\n  - grep\n---\nPrompt.");
	const factory = createFakeFactory({ events: [{ type: "agent_settled" }] });
	registerSubagentTool(host.pi, { factory });
	await callTool(host, { task: "Do it", agent: "limited" }, { cwd: projectDir });
	assert.deepEqual(factory.launches[0]!.tools, ["read", "grep"]);
});

test("call tools override agent tools", async (t) => {
	const { host, projectDir } = setup(t);
	writeAgentFile(process.env.PI_CODING_AGENT_DIR!, "agents/limited2.md", "---\nname: limited2\ndescription: Limited tools\ntools:\n  - read\n  - grep\n---\nPrompt.");
	const factory = createFakeFactory({ events: [{ type: "agent_settled" }] });
	registerSubagentTool(host.pi, { factory });
	await callTool(host, { task: "Do it", agent: "limited2", tools: ["bash"] }, { cwd: projectDir });
	assert.deepEqual(factory.launches[0]!.tools, ["bash"]);
});
