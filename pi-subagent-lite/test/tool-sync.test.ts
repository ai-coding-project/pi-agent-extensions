/**
 * Synchronous (foreground) subagent-lite runs against a fake child-session
 * factory: output capture, error folding, empty output, timeout, abort, the
 * foreground mutex, and onUpdate previews.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { registerSubagentTool } from "../src/tool.ts";
import { createFakeFactory } from "./support/fake-factory.ts";
import { createFakeHost, createFakeContext, resultText, completionEvents, type FakeHost } from "./support/fake-host.ts";
import { createIsolatedAgentDir } from "./support/isolated-agent-dir.ts";

function setup(t: TestContext) {
	createIsolatedAgentDir(t as unknown as Parameters<typeof createIsolatedAgentDir>[0]);
	const host: FakeHost = createFakeHost();
	return host;
}

function callTool(host: FakeHost, params: Record<string, unknown>, overrides: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
	const tool = host.registeredTools[0]!;
	const execute = tool.execute as (id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) => Promise<unknown>;
	return execute("call-1", params, (overrides.signal as AbortSignal | undefined) ?? undefined, overrides.onUpdate, createFakeContext(overrides)).then(resultText);
}

const basicParams = { task: "Do the thing", systemPrompt: "You are a helper." };

test("sync run returns the child's final output", async (t) => {
	const host = setup(t);
	const factory = createFakeFactory({ events: completionEvents("Final answer text") });
	registerSubagentTool(host.pi, { factory });
	const result = await callTool(host, basicParams);
	assert.equal(result.isError, false);
	assert.ok(result.text.includes("Final answer text"), result.text);
	assert.ok(result.text.includes("completed"));
});

test("sync run passes task and launch fields to the factory", async (t) => {
	const host = setup(t);
	const factory = createFakeFactory({ events: completionEvents("done") });
	registerSubagentTool(host.pi, { factory });
	await callTool(host, { task: "Read files", systemPrompt: "Helper prompt.", model: "openai/gpt-5.1:high", tools: "read, bash", timeoutMs: 5000 });
	const launch = factory.launches[0]!;
	assert.equal(factory.created[0]!.prompted, "Read files");
	assert.equal(launch.model, "openai/gpt-5.1:high");
	assert.equal(launch.thinkingLevel, "high");
	assert.deepEqual(launch.tools, ["read", "bash"]);
	assert.equal(launch.systemPrompt, "Helper prompt.");
	assert.equal(launch.systemPromptMode, "replace");
	assert.equal(launch.ambientExtensions, true);
});

test("sync run with a child error is marked failed and isError", async (t) => {
	const host = setup(t);
	const factory = createFakeFactory({
		events: [
			...completionEvents("partial answer"),
			{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "error", errorMessage: "provider exploded" } },
		],
	});
	registerSubagentTool(host.pi, { factory });
	const result = await callTool(host, basicParams);
	assert.equal(result.isError, true);
	assert.ok(result.text.includes("failed"));
	assert.ok(result.text.includes("provider exploded"), result.text);
});

test("sync run with an empty terminal response reports (no output)", async (t) => {
	const host = setup(t);
	const factory = createFakeFactory({ events: completionEvents("") });
	registerSubagentTool(host.pi, { factory });
	const result = await callTool(host, basicParams);
	assert.equal(result.isError, false);
	assert.ok(result.text.includes("(no output)"), result.text);
});

test("hung child run is aborted at the timeout with a partial output", async (t) => {
	const host = setup(t);
	const factory = createFakeFactory({
		hang: true,
		events: [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial progress" }], stopReason: "stop", usage: { input: 5, output: 2 } } }],
	});
	registerSubagentTool(host.pi, { factory });
	const result = await callTool(host, { ...basicParams, timeoutMs: 50 });
	assert.equal(result.isError, true);
	assert.ok(result.text.includes("timed out"), result.text);
	assert.ok(result.text.includes("partial progress"), result.text);
});

test("ctrl-c (abort signal) aborts the child and reports stopped", async (t) => {
	const host = setup(t);
	const factory = createFakeFactory({ hang: true });
	registerSubagentTool(host.pi, { factory });
	const controller = new AbortController();
	const pending = callTool(host, basicParams, { signal: controller.signal });
	await new Promise((resolve) => setTimeout(resolve, 20));
	controller.abort();
	const result = await pending;
	assert.equal(result.isError, true);
	assert.ok(result.text.includes("stopped"), result.text);
	assert.ok(factory.created[0]!.aborted);
	assert.ok(factory.created[0]!.disposed);
});

test("a second foreground run is rejected while one is active", async (t) => {
	const host = setup(t);
	const factory = createFakeFactory({ hang: true });
	registerSubagentTool(host.pi, { factory });
	const first = callTool(host, basicParams);
	await new Promise((resolve) => setTimeout(resolve, 20));
	const second = await callTool(host, basicParams);
	assert.equal(second.isError, true);
	assert.ok(second.text.includes("Another foreground subagent run"), second.text);
	assert.ok(second.text.includes("async: true"), second.text);
	factory.created[0]!.release();
	const firstResult = await first;
	assert.equal(firstResult.isError, false);
});

test("onUpdate forwards assistant previews prefixed with the agent name", async (t) => {
	const host = setup(t);
	const factory = createFakeFactory({ events: completionEvents("Hello from the child"), delayMs: 10 });
	registerSubagentTool(host.pi, { factory });
	const updates: string[] = [];
	await callTool(host, { task: "Hi", systemPrompt: "Helper." }, { onUpdate: (update: { content: Array<{ text: string }> }) => updates.push(update.content[0]!.text) });
	assert.ok(updates.some((text) => text.startsWith("[inline] Hello from the child")), JSON.stringify(updates));
});

test("long assistant previews are truncated to 200 characters", async (t) => {
	const host = setup(t);
	const longText = "x".repeat(500);
	const factory = createFakeFactory({ events: completionEvents(longText), delayMs: 10 });
	registerSubagentTool(host.pi, { factory });
	const updates: string[] = [];
	await callTool(host, { task: "Hi", systemPrompt: "Helper." }, { onUpdate: (update: { content: Array<{ text: string }> }) => updates.push(update.content[0]!.text) });
	const preview = updates.find((text) => text.includes("xxx"));
	assert.ok(preview);
	assert.ok(preview.length <= "[inline] ".length + 200 + 1);
});

test("sync run output is truncated at 50,000 characters", async (t) => {
	const host = setup(t);
	const factory = createFakeFactory({ events: completionEvents("y".repeat(60_000)) });
	registerSubagentTool(host.pi, { factory });
	const result = await callTool(host, basicParams);
	assert.ok(result.text.includes("[truncated"));
	assert.ok(result.text.length < 60_000);
});
