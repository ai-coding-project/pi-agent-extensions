/**
 * Model candidate resolution: precedence and thinking-suffix parsing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveModelCandidate, splitModelThinking } from "../src/tool.ts";
import type { AgentDefinition } from "../src/types.ts";

const parentModel = { provider: "anthropic", id: "claude-opus-4-5" };

function agentWith(model?: string): AgentDefinition | undefined {
	return { name: "a", description: "", systemPrompt: "p", systemPromptMode: "replace", scope: "user", ...(model ? { model } : {}) };
}

test("explicit parameter wins over agent and parent", () => {
	const result = resolveModelCandidate({ model: "openai/gpt-5.1" }, agentWith("google/gemini-3-pro"), parentModel);
	assert.equal(result.model, "openai/gpt-5.1");
});

test("agent model wins over the parent model", () => {
	const result = resolveModelCandidate({}, agentWith("google/gemini-3-pro"), parentModel);
	assert.equal(result.model, "google/gemini-3-pro");
});

test("the parent model is used when nothing else is set", () => {
	const result = resolveModelCandidate({}, undefined, parentModel);
	assert.equal(result.model, "anthropic/claude-opus-4-5");
});

test("no model is returned when no source defines one", () => {
	const result = resolveModelCandidate({}, undefined, undefined);
	assert.equal(result.model, undefined);
	assert.equal(result.error, undefined);
});

test("thinking suffixes are split and preserved", () => {
	assert.deepEqual(splitModelThinking("openai/gpt-5.1:high"), { baseModel: "openai/gpt-5.1", thinkingSuffix: ":high" });
	assert.deepEqual(splitModelThinking("openai/gpt-5.1"), { baseModel: "openai/gpt-5.1", thinkingSuffix: "" });
	// Unknown suffixes are part of the model id.
	assert.deepEqual(splitModelThinking("openai/gpt-5.1:2025-01"), { baseModel: "openai/gpt-5.1:2025-01", thinkingSuffix: "" });
});

test("a bare thinking suffix is invalid", () => {
	const result = resolveModelCandidate({ model: ":high" }, undefined, undefined);
	assert.match(result.error!, /missing model id/);
});

test("provider/id/id is invalid", () => {
	const result = resolveModelCandidate({ model: "a/b/c" }, undefined, undefined);
	assert.match(result.error!, /expected 'provider\/id'/);
});

test("an empty explicit model is invalid", () => {
	const result = resolveModelCandidate({ model: "  " }, undefined, undefined);
	assert.match(result.error!, /model must not be empty/);
});
