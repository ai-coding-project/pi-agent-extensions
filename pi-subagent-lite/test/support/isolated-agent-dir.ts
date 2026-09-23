/**
 * Creates a throwaway agent dir and points PI_CODING_AGENT_DIR at it for the
 * duration of the calling test (restored via t.after()). Each test FILE runs in
 * its own node --test worker process, so leakage across files is impossible.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function createIsolatedAgentDir(t?: { after?: (fn: () => void) => unknown }): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-lite-test-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	t?.after?.(() => {
		delete process.env.PI_CODING_AGENT_DIR;
	});
	return dir;
}

/** Write an agent definition file (creating parent dirs) inside the given agent dir. */
export function writeAgentFile(agentDir: string, relativePath: string, content: string): void {
	const filePath = path.join(agentDir, relativePath);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

/** Write a file (creating parent dirs) inside a project tree. */
export function writeProjectFile(projectDir: string, relativePath: string, content: string): void {
	writeAgentFile(projectDir, relativePath, content);
}
