/**
 * Child agent discovery from markdown definition files.
 *
 * Discovery model (simplified from the reference pi-subagents agents.ts):
 * - user:    agents directory under the global agent dir, recursive
 * - project: agents directory under the project .pi dir, recursive
 * Project definitions win when both define the same agent name.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter, parseFrontmatterList } from "./frontmatter.ts";
import { getAgentDir } from "./utils.ts";
import type { AgentDefinition } from "./types.ts";

export interface AgentDiscoveryResult {
	agents: AgentDefinition[];
	warnings: string[];
}

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function listMarkdownFiles(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	const entries = fs.readdirSync(dir, { recursive: true, withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		if (!entry.name.endsWith(".md")) continue;
		files.push(path.join(entry.parentPath ?? dir, entry.name));
	}
	return files.sort();
}

/** Parse one agent markdown file; throws with a readable message on invalid input. */
function parseAgentFile(filePath: string, scope: AgentDefinition["scope"]): AgentDefinition {
	const content = fs.readFileSync(filePath, "utf8");
	const { frontmatter, body } = parseFrontmatter(content);
	const fileName = path.basename(filePath, ".md");
	const name = frontmatter.name?.trim() || fileName;
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
		throw new Error(`invalid agent name '${name}'`);
	}
	const rawThinking = frontmatter.thinking?.trim();
	if (rawThinking !== undefined && !THINKING_LEVELS.includes(rawThinking as (typeof THINKING_LEVELS)[number])) {
		throw new Error(`invalid thinking level '${rawThinking}'`);
	}
	const systemPromptMode = frontmatter.systemPromptMode === "append" ? "append" : "replace";
	const frontmatterTools = parseFrontmatterList(frontmatter.tools);
	return {
		name,
		description: frontmatter.description?.trim() ?? "",
		...(frontmatter.model?.trim() ? { model: frontmatter.model.trim() } : {}),
		...(rawThinking ? { thinking: rawThinking } : {}),
		...(frontmatterTools !== undefined && frontmatterTools.length > 0 ? { tools: frontmatterTools } : {}),
		systemPrompt: body,
		systemPromptMode,
		sourcePath: filePath,
		scope,
	};
}

function loadAgentsFromDir(dir: string, scope: AgentDefinition["scope"], warnings: string[]): AgentDefinition[] {
	const agents: AgentDefinition[] = [];
	for (const filePath of listMarkdownFiles(dir)) {
		try {
			agents.push(parseAgentFile(filePath, scope));
		} catch (error) {
			warnings.push(`Skipped agent file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return agents;
}

/** Discover user and project agents; on name conflicts the project definition wins. */
export function listAgents(cwd: string): AgentDiscoveryResult {
	const warnings: string[] = [];
	const userDir = path.join(getAgentDir(), "agents");
	const projectDir = path.join(path.resolve(cwd), ".pi", "agents");
	const userAgents = loadAgentsFromDir(userDir, "user", warnings);
	const projectAgents = loadAgentsFromDir(projectDir, "project", warnings);
	const byName = new Map<string, AgentDefinition>();
	for (const agent of userAgents) if (!byName.has(agent.name)) byName.set(agent.name, agent);
	for (const agent of projectAgents) byName.set(agent.name, agent);
	return { agents: [...byName.values()], warnings };
}

export function findAgent(cwd: string, name: string): AgentDefinition | undefined {
	return listAgents(cwd).agents.find((agent) => agent.name === name);
}

/** Normalize a tools override from the tool call: CSV string or string array. */
export function normalizeToolsInput(tools: string[] | string | undefined): string[] | undefined {
	if (tools === undefined) return undefined;
	const list = typeof tools === "string" ? tools.split(",") : tools;
	const cleaned = list.map((tool) => tool.trim()).filter(Boolean);
	return cleaned.length > 0 ? cleaned : undefined;
}
