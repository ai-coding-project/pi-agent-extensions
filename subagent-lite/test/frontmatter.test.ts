/**
 * Tests for the frontmatter parser (copied verbatim from the reference
 * pi-subagents src/agents/frontmatter.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter, parseFrontmatterList } from "../src/frontmatter.ts";

test("parseFrontmatter extracts simple key/value pairs", () => {
	const { frontmatter, body } = parseFrontmatter("---\nname: reviewer\ndescription: Reviews code\n---\n\nBody here.");
	assert.equal(frontmatter.name, "reviewer");
	assert.equal(frontmatter.description, "Reviews code");
	assert.equal(body.trim(), "Body here.");
});

test("parseFrontmatter returns empty frontmatter when delimiters are missing", () => {
	const { frontmatter, body } = parseFrontmatter("no frontmatter here");
	assert.deepEqual(frontmatter, {});
	assert.equal(body, "no frontmatter here");
});

test("parseFrontmatter does not terminate on a fenced delimiter", () => {
	const content = "---\nname: a\n---\n```\n---\nnot frontmatter\n```\n";
	const { frontmatter, body } = parseFrontmatter(content);
	assert.equal(frontmatter.name, "a");
	assert.ok(body.includes("not frontmatter"));
});

test("parseFrontmatter supports folded block scalars via >", () => {
	const content = "---\ndescription: >\n  first line\n  second line\n---\nbody";
	const { frontmatter } = parseFrontmatter(content);
	assert.equal(frontmatter.description, "first line second line");
});

test("parseFrontmatter preserves literal block scalars via |", () => {
	const content = "---\nsystemPrompt: |\n  line one\n  line two\n---\nbody";
	const { frontmatter } = parseFrontmatter(content);
	assert.equal(frontmatter.systemPrompt, "line one\nline two");
});

test("parseFrontmatter handles quoted values", () => {
	const content = "---\nname: \"quoted: name\"\n---\n";
	const { frontmatter } = parseFrontmatter(content);
	assert.equal(frontmatter.name, "quoted: name");
});

test("parseFrontmatterList parses dash lists", () => {
	assert.deepEqual(parseFrontmatterList("read\n- bash\n- edit"), ["read", "bash", "edit"]);
});

test("parseFrontmatterList parses comma-separated lists", () => {
	assert.deepEqual(parseFrontmatterList("read, bash, edit"), ["read", "bash", "edit"]);
});

test("parseFrontmatterList returns undefined for absent values", () => {
	assert.equal(parseFrontmatterList(undefined), undefined);
});

test("parseFrontmatter accepts a dash list at the same indent as its key", () => {
	const content = "---\nname: worker\ntools:\n- read\n- grep\n---\nbody";
	const { frontmatter } = parseFrontmatter(content);
	assert.equal(frontmatter.tools, "- read\n- grep");
	assert.deepEqual(parseFrontmatterList(frontmatter.tools), ["read", "grep"]);
});

test("parseFrontmatter still terminates literal blocks at a same-indent list item", () => {
	const content = "---\ndesc: |\n  text line\n- not part\n---\nbody";
	const { frontmatter, body } = parseFrontmatter(content);
	assert.equal(frontmatter.desc, "text line");
	assert.equal(body, "body");
});

test("parseFrontmatterList strips one pair of surrounding quotes from items", () => {
	assert.deepEqual(parseFrontmatterList('- "read"\n- \'grep\''), ["read", "grep"]);
	assert.deepEqual(parseFrontmatterList('"read", \'edit\''), ["read", "edit"]);
	// Unbalanced or inner quotes stay intact.
	assert.deepEqual(parseFrontmatterList('- "read'), ['"read']);
});
