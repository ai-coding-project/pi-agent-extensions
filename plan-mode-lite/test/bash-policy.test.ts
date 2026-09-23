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

test("configured safeSubcommands trust only the matching segment (no chaining bypass)", () => {
	const config: SafeSubcommands = { git: ["status"], kubectl: ["get"] };
	for (const cmd of [
		"git status; rm -rf /tmp/pwned",
		"git status > /tmp/pwned",
		"git status | sh",
		"git status && rm x",
		"kubectl get pods; rm x",
		"kubectl get pods && touch /tmp/pwned",
	]) {
		assert.ok(!safe(cmd, config), `should be blocked: ${cmd}`);
	}
	for (const cmd of ["git status", "git status | head", "kubectl get pods"]) {
		assert.ok(safe(cmd, config), `should be safe: ${cmd}`);
	}
	assert.ok(!psSafe("kubectl get pods; Remove-Item x", config));
	assert.ok(psSafe("kubectl get pods", config));
});

test("clustered short options cannot smuggle dangerous flags", () => {
	for (const cmd of [
		"sort -fo /tmp/evil in.txt", // -f -o /tmp/evil: writes output
		"sort -ro /tmp/evil in.txt",
		"sort -oout /tmp/evil",
		"sort -rT /tmp in.txt", // -r -T /tmp
		"tree -Co /tmp/evil", // -C -o /tmp/evil
		"date -su 20200101", // -u -s
		"date -s20200101", // attached value form
		"date -Rs 20200101",
		"fd -Hx rm", // -H -x rm: executes rm per result
		"fd -HX rm",
	]) {
		assert.ok(!safe(cmd), `should be blocked: ${cmd}`);
	}
	for (const cmd of [
		"sort -r in.txt",
		"sort -k2n in.txt",
		"date -u",
		"date -I",
		"date -Iseconds", // -I takes the rest as value, not the -s flag
		"date '+%s'",
		"fd -t x", // separated value form stays allowed
		"tree -C",
	]) {
		assert.ok(safe(cmd), `should be safe: ${cmd}`);
	}
});

test("read-only -i flags and equals-sign arguments are safe (no false positives)", () => {
	for (const cmd of [
		"grep -i pattern file.txt",
		"git grep -i pattern",
		"diff -i a.txt b.txt",
		"cat a=b.txt",
		"grep foo=bar file.txt",
		"find . -name 'x=y'",
	]) {
		assert.ok(safe(cmd), `should be safe: ${cmd}`);
	}
	for (const cmd of [
		"sed -i 's/a/b/' f.txt",
		"sed -ni '2p' f.txt",
		"sed --in-place f.txt",
		"FOO=1 ls",
		"FOO=1 BAR=2 grep -i x f",
	]) {
		assert.ok(!safe(cmd), `should be blocked: ${cmd}`);
	}
});

test("N>/dev/null redirects are stripped and allowed", () => {
	for (const cmd of [
		"ls missing-dir 2>/dev/null",
		"rg -c '' f.txt 2>/dev/null",
		"ls foo 1>/dev/null",
		"ls foo 2> /dev/null", // space before the target
		"ls a 2>/dev/null && ls b",
		"ls a; ls b 2>/dev/null",
		"uniq f 2>/dev/null", // stripped: not counted as a positional arg
		"git remote get-url origin 2>/dev/null",
		"find . -name x 2>/dev/null",
		"ls 2>/dev/null 2>/dev/null", // repeated discards
		'echo "2>/dev/null"', // quoted text is an argument, not a redirect
	]) {
		assert.ok(safe(cmd), `should be safe: ${cmd}`);
	}
});

test("every other redirect shape stays blocked (fail closed)", () => {
	for (const cmd of [
		"ls > out.txt",
		"ls out 2>/tmp/evil", // target is not /dev/null
		"ls out 2>/dev/nullx", // /dev/null as a prefix of a longer path
		"ls out 2>>/dev/null", // append form
		"ls out 2>&1", // fd duplication
		"ls out >/dev/null", // bare ">" without an fd number
		"echo foo2>/dev/null", // digits glued to a word are not an fd redirect
		"ls out 2>/dev/null > /tmp/evil", // a second unsafe redirect
		"cat foo 2>/dev/null && rm bar", // one discard cannot vouch for the rest
	]) {
		assert.ok(!safe(cmd), `should be blocked: ${cmd}`);
	}
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
