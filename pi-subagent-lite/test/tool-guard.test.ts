/**
 * Recursion guard: a session id registered as a child (via the real
 * onSessionCreated path) cannot invoke the tool again.
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

test("a child session cannot spawn further subagents", async (t) => {
	const host = setup(t);
	// The child session id is deterministic so the nested call can impersonate it.
	// The child hangs so its id stays registered in the recursion guard for the
	// whole test; shutdown at the end releases it.
	const factory = createFakeFactory({ sessionId: "child-session-1", hang: true });
	registerSubagentTool(host.pi, { factory });
	const reply = await callTool(host, { ...basicParams, async: true });
	assert.equal(reply.isError, false);
	await new Promise((resolve) => setTimeout(resolve, 10));
	// The child's onSessionCreated path ran; from now on a call claiming to be
	// that session must be refused.
	assert.equal(factory.created[0]!.sessionId, "child-session-1");
	const nested = await callTool(host, basicParams, { sessionId: "child-session-1" });
	assert.equal(nested.isError, true);
	assert.equal(nested.text, "child agents cannot spawn sub-agents (single-level nesting)");
	// Cleanup: session shutdown aborts the hung child and releases its id.
	assert.equal(host.shutdownHandlers.length, 1);
	await host.shutdownHandlers[0]!();
	assert.equal(factory.created[0]!.aborted, true);
});

test("the parent session itself is never treated as a child", async (t) => {
	const host = setup(t);
	const factory = createFakeFactory({ sessionId: "child-session-2", events: completionEvents("ok") });
	registerSubagentTool(host.pi, { factory });
	await callTool(host, { ...basicParams, async: true });
	await new Promise((resolve) => setTimeout(resolve, 10));
	const parentCall = await callTool(host, basicParams, { sessionId: "parent-session-id" });
	assert.equal(parentCall.isError, false);
});

test("child ids are released after the run settles", async (t) => {
	const host = setup(t);
	const factory = createFakeFactory({ sessionId: "child-session-3", events: completionEvents("ok") });
	registerSubagentTool(host.pi, { factory });
	await callTool(host, { ...basicParams, async: true });
	await new Promise((resolve) => setTimeout(resolve, 20));
	// After the child settled, its id no longer guards the tool.
	const impersonation = await callTool(host, basicParams, { sessionId: "child-session-3" });
	assert.notEqual(impersonation.text, "child agents cannot spawn sub-agents (single-level nesting)");
});

const SHARED_IDS_KEY = Symbol.for("pi-subagent-lite:childSessionIds");

test("the guard set is process-global: live child ids land in the shared slot", async (t) => {
	const host = setup(t);
	const factory = createFakeFactory({ sessionId: "child-global-1", hang: true });
	registerSubagentTool(host.pi, { factory });
	await callTool(host, { ...basicParams, async: true });
	await new Promise((resolve) => setTimeout(resolve, 10));
	// pi reloads extensions without a module cache and child sessions reset the
	// extension factory cache, so a child gets a fresh copy of this module. The
	// guard must therefore live on globalThis, not in module state.
	const shared = (globalThis as Record<symbol, Set<string>>)[SHARED_IDS_KEY];
	assert.ok(shared instanceof Set);
	assert.equal(shared.has("child-global-1"), true);
	await host.shutdownHandlers[0]!();
	// dispose() does not await the run's own settle path; give it a moment to
	// release the child id from the shared slot.
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(shared.has("child-global-1"), false);
});

test("an id registered by a second module instance is still blocked", async (t) => {
	const host = setup(t);
	registerSubagentTool(host.pi, { factory: createFakeFactory({ hang: true }) });
	const shared = (globalThis as Record<symbol, Set<string>>)[SHARED_IDS_KEY];
	assert.ok(shared instanceof Set);
	// Simulate a grandchild session spawned by a child's own (fresh) module
	// instance: it registers its session id in the same globalThis slot.
	shared.add("second-instance-child");
	try {
		const nested = await callTool(host, basicParams, { sessionId: "second-instance-child" });
		assert.equal(nested.isError, true);
		assert.equal(nested.text, "child agents cannot spawn sub-agents (single-level nesting)");
	} finally {
		shared.delete("second-instance-child");
	}
});
