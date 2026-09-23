/**
 * Background (async) subagent-lite runs: immediate reply, completion
 * notifications via pi.sendMessage, the stop action, concurrency, and the
 * list action.
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
	return execute("call-1", params, overrides.signal as AbortSignal | undefined, overrides.onUpdate, createFakeContext(overrides)).then(resultText);
}

const basicParams = { task: "Do the thing", systemPrompt: "You are a helper." };

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 10));
}

test("async run returns an id immediately and completes in the background", async (t) => {
	const host = setup(t);
	const factory = createFakeFactory({ events: completionEvents("Background answer") });
	registerSubagentTool(host.pi, { factory });
	const reply = await callTool(host, { ...basicParams, async: true });
	assert.equal(reply.isError, false);
	const idMatch = reply.text.match(/run '([a-f0-9]{8})'/);
	assert.ok(idMatch, reply.text);
	const id = idMatch![1]!;
	await flush();
	assert.equal(host.sent.length, 1);
	assert.equal(host.sent[0]!.message.customType, "subagent-lite-notify");
	assert.equal(host.sent[0]!.options?.triggerTurn, true);
	assert.ok(host.sent[0]!.message.content.includes("Background answer"), host.sent[0]!.message.content);
	assert.ok(host.sent[0]!.message.content.includes("completed"));
	// The run settled into history.
	const list = await callTool(host, { action: "list" });
	assert.ok(list.text.includes(`"${id}"`));
	assert.ok(list.text.includes('"completed"'));
});

test("async run that fails notifies with the error", async (t) => {
	const host = setup(t);
	const factory = createFakeFactory({
		events: [
			{ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "boom happened" } },
		],
	});
	registerSubagentTool(host.pi, { factory });
	await callTool(host, { ...basicParams, async: true });
	await flush();
	assert.equal(host.sent.length, 1);
	assert.ok(host.sent[0]!.message.content.includes("boom happened"), host.sent[0]!.message.content);
	assert.ok(host.sent[0]!.message.content.includes("failed"));
});

test("stop action aborts a running background run and notifies 'stopped'", async (t) => {
	const host = setup(t);
	const factory = createFakeFactory({ hang: true });
	registerSubagentTool(host.pi, { factory });
	const reply = await callTool(host, { ...basicParams, async: true });
	const id = reply.text.match(/run '([a-f0-9]{8})'/)![1]!;
	const stopReply = await callTool(host, { action: "stop", id });
	assert.equal(stopReply.isError, false);
	await flush();
	assert.equal(factory.created[0]!.aborted, true);
	assert.equal(host.sent.length, 1);
	assert.ok(host.sent[0]!.message.content.includes("stopped"), host.sent[0]!.message.content);
	// Stopping again reports the run already finished.
	const again = await callTool(host, { action: "stop", id });
	assert.equal(again.isError, true);
	assert.ok(again.text.includes("already finished"), again.text);
});

test("stop with an unknown id lists active run ids", async (t) => {
	const host = setup(t);
	const factory = createFakeFactory({ hang: true });
	registerSubagentTool(host.pi, { factory });
	const reply = await callTool(host, { ...basicParams, async: true });
	const id = reply.text.match(/run '([a-f0-9]{8})'/)![1]!;
	const missing = await callTool(host, { action: "stop", id: "ffffffff" });
	assert.equal(missing.isError, true);
	assert.ok(missing.text.includes("No subagent run matches id 'ffffffff'"), missing.text);
	assert.ok(missing.text.includes(id), missing.text);
	// Prefix matching works for stop.
	const prefixStop = await callTool(host, { action: "stop", id: id.slice(0, 4) });
	assert.equal(prefixStop.isError, false);
	await flush();
});

test("stop without an id is a validation error", async (t) => {
	const host = setup(t);
	registerSubagentTool(host.pi, { factory: createFakeFactory({ hang: true }) });
	const reply = await callTool(host, { action: "stop" });
	assert.equal(reply.isError, true);
	assert.ok(reply.text.includes("stop requires the id"), reply.text);
});

test("two async runs are supported concurrently", async (t) => {
	const host = setup(t);
	const factory = createFakeFactory([
		{ sessionId: "child-a", events: completionEvents("Answer A") },
		{ sessionId: "child-b", events: completionEvents("Answer B") },
	]);
	registerSubagentTool(host.pi, { factory });
	const first = await callTool(host, { ...basicParams, async: true });
	const second = await callTool(host, { ...basicParams, async: true });
	assert.equal(first.isError, false);
	assert.equal(second.isError, false);
	await flush();
	assert.equal(host.sent.length, 2);
	const contents = host.sent.map((entry) => entry.message.content);
	assert.ok(contents.some((content) => content.includes("Answer A")));
	assert.ok(contents.some((content) => content.includes("Answer B")));
	// Both children share the process; both get disposed after settling.
	assert.ok(factory.created.every((session) => session.disposed));
});

test("list shows running and finished runs with key fields", async (t) => {
	const host = setup(t);
	const factory = createFakeFactory({ hang: true });
	registerSubagentTool(host.pi, { factory });
	const reply = await callTool(host, { ...basicParams, async: true });
	const id = reply.text.match(/run '([a-f0-9]{8})'/)![1]!;
	const list = JSON.parse((await callTool(host, { action: "list" })).text) as { activeCount: number; runs: Array<Record<string, unknown>> };
	assert.equal(list.activeCount, 1);
	assert.equal(list.runs.length, 1);
	const entry = list.runs[0]!;
	assert.equal(entry.id, id);
	assert.equal(entry.agent, "inline");
	assert.equal(entry.task, "Do the thing");
	assert.equal(entry.status, "running");
	assert.equal(entry.async, true);
	assert.ok(typeof entry.startedAt === "string");
});

test("run history is capped at 50 entries with oldest eviction", async (t) => {
	const host = setup(t);
	const factory = createFakeFactory({ events: completionEvents("quick") });
	registerSubagentTool(host.pi, { factory });
	for (let index = 0; index < 55; index++) {
		await callTool(host, { ...basicParams, async: true });
	}
	await flush();
	const list = JSON.parse((await callTool(host, { action: "list" })).text) as { runs: unknown[] };
	assert.equal(list.runs.length, 50);
});

test("session_shutdown aborts live runs and disposes the factory", async (t) => {
	const host = setup(t);
	const factory = createFakeFactory({ hang: true });
	registerSubagentTool(host.pi, { factory });
	await callTool(host, { ...basicParams, async: true });
	assert.equal(host.shutdownHandlers.length, 1);
	await host.shutdownHandlers[0]!();
	assert.equal(factory.created[0]!.aborted, true);
	assert.equal(factory.created[0]!.disposed, true);
});

test("session_shutdown mutes the late completion notification", async (t) => {
	const host = setup(t);
	const factory = createFakeFactory({ hang: true, events: completionEvents("late answer") });
	registerSubagentTool(host.pi, { factory });
	await callTool(host, { ...basicParams, async: true });
	await host.shutdownHandlers[0]!();
	assert.equal(factory.created[0]!.aborted, true);
	assert.equal(host.sent.length, 0);
	// The stopped child settles shortly after shutdown; no notice may reach the
	// parent session (it is already shutting down).
	await flush();
	assert.equal(host.sent.length, 0);
});
