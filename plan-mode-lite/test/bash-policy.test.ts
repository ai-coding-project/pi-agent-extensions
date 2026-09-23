/**
 * Read-only bash / PowerShell policy tests (port of the original run-tests.mjs
 * policy cases to node:test).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	findBlockedCommandSegment,
	findBlockedPowerShellCommandSegment,
	type SafeSubcommands,
} from "../src/bash-policy.ts";

const safe = (cmd: string, safeSubcommands: SafeSubcommands = {}, cwd?: string) =>
	findBlockedCommandSegment(cmd, safeSubcommands, cwd) === undefined;
const psSafe = (cmd: string, safeSubcommands: SafeSubcommands = {}) =>
	findBlockedPowerShellCommandSegment(cmd, safeSubcommands) === undefined;

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
	for (const cmd of ["npm install", "npm run dev", "npm audit fix", "node script.js", "tsc file.ts", "python -c 'print(1)'"]) {
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
	const config: SafeSubcommands = { kubectl: ["get", "describe"] };
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
