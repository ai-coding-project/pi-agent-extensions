/**
 * Tests for agent discovery: user/project directories, precedence, and
 * malformed-definition handling.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { listAgents, findAgent, normalizeToolsInput, THINKING_LEVELS } from "../src/agents.ts";
import { createIsolatedAgentDir, writeAgentFile, writeProjectFile } from "./support/isolated-agent-dir.ts";

function setup(t: TestContext): { agentDir: string; projectDir: string } {
	const agentDir = createIsolatedAgentDir(t as unknown as Parameters<typeof createIsolatedAgentDir>[0]);
	const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-lite-project-"));
	return { agentDir, projectDir };
}

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

test("discovery reads user agents from <agentDir>/agents", (t) => {
	const { agentDir, projectDir } = setup(t);
	writeAgentFile(agentDir, "agents/worker.md", "---\nname: worker\ndescription: Does work\nmodel: openai/gpt-5.1:high\ntools: read, bash\n---\nYou are a worker.");
	const { agents, warnings } = listAgents(projectDir);
	assert.equal(warnings.length, 0);
	assert.equal(agents.length, 1);
	const worker = agents[0]!;
	assert.equal(worker.name, "worker");
	assert.equal(worker.description, "Does work");
	assert.equal(worker.model, "openai/gpt-5.1:high");
	assert.deepEqual(worker.tools, ["read", "bash"]);
	assert.equal(worker.systemPrompt.trim(), "You are a worker.");
	assert.equal(worker.systemPromptMode, "replace");
	assert.equal(worker.scope, "user");
});

test("discovery reads project agents from <cwd>/.pi/agents and they win on conflict", (t) => {
	const { agentDir, projectDir } = setup(t);
	writeAgentFile(agentDir, "agents/helper.md", "---\nname: helper\ndescription: user version\n---\nUser prompt.");
	writeProjectFile(projectDir, ".pi/agents/helper.md", "---\nname: helper\ndescription: project version\n---\nProject prompt.");
	const { agents } = listAgents(projectDir);
	assert.equal(agents.length, 1);
	assert.equal(agents[0]!.scope, "project");
	assert.equal(agents[0]!.description, "project version");
	assert.equal(agents[0]!.systemPrompt.trim(), "Project prompt.");
});

test("discovery recurses into subdirectories and defaults the name to the filename", (t) => {
	const { agentDir, projectDir } = setup(t);
	writeAgentFile(agentDir, "agents/team/reviewer.md", "---\ndescription: Reviews\n---\nPrompt.");
	const { agents } = listAgents(projectDir);
	const reviewer = agents.find((agent) => agent.name === "reviewer");
	assert.ok(reviewer);
	assert.ok(reviewer.sourcePath!.endsWith("team/reviewer.md"));
});

test("malformed agent files are skipped with a warning", (t) => {
	const { agentDir, projectDir } = setup(t);
	writeAgentFile(agentDir, "agents/broken.md", "---\nname: broken\nthinking: ultra\n---\nBad thinking level.");
	writeAgentFile(agentDir, "agents/good.md", "---\nname: good\ndescription: Fine\n---\nPrompt.");
	const { agents, warnings } = listAgents(projectDir);
	assert.deepEqual(agents.map((agent) => agent.name), ["good"]);
	assert.equal(warnings.length, 1);
	assert.ok(warnings[0]!.includes("broken.md"));
});

test("invalid agent names are rejected", (t) => {
	const { agentDir, projectDir } = setup(t);
	writeAgentFile(agentDir, "agents/bad name.md", "---\nname: bad name\n---\nPrompt.");
	const { agents, warnings } = listAgents(projectDir);
	assert.equal(agents.length, 0);
	assert.equal(warnings.length, 1);
});

test("systemPromptMode append is honored", (t) => {
	const { agentDir, projectDir } = setup(t);
	writeAgentFile(agentDir, "agents/appender.md", "---\nname: appender\ndescription: Appends\nsystemPromptMode: append\n---\nExtra prompt.");
	const { agents } = listAgents(projectDir);
	assert.equal(agents[0]!.systemPromptMode, "append");
});

test("findAgent returns undefined for unknown names", (t) => {
	const { agentDir, projectDir } = setup(t);
	writeAgentFile(agentDir, "agents/known.md", "---\nname: known\ndescription: Known\n---\nPrompt.");
	assert.ok(findAgent(projectDir, "known"));
	assert.equal(findAgent(projectDir, "unknown"), undefined);
});

test("normalizeToolsInput accepts arrays and CSV strings", () => {
	assert.deepEqual(normalizeToolsInput("read, bash"), ["read", "bash"]);
	assert.deepEqual(normalizeToolsInput(["read", "bash"]), ["read", "bash"]);
	assert.deepEqual(normalizeToolsInput("  read  ,  "), ["read"]);
	assert.equal(normalizeToolsInput(undefined), undefined);
	assert.equal(normalizeToolsInput(",, "), undefined);
});

test("THINKING_LEVELS match the reference set", () => {
	assert.deepEqual([...THINKING_LEVELS], ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
});
