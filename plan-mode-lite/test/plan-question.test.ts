/**
 * plan_mode_question parameter normalization tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePlanModeQuestionParams } from "../src/plan-question.ts";

test("question params normalization accepts valid input", () => {
	const parsed = normalizePlanModeQuestionParams({
		questions: [
			{
				id: "lib",
				header: "Library",
				question: "Which library?",
				options: [
					{ label: "A", description: "option A" },
					{ label: "B", description: "option B" },
				],
			},
		],
	});
	assert.ok(parsed.ok);
	assert.equal(parsed.questions.length, 1);
	assert.equal(parsed.questions[0]!.id, "lib");
});

test("question params normalization rejects invalid input", () => {
	for (const input of [
		{},
		{ questions: [] },
		{ questions: [{ id: "x", header: "h", question: "q", options: [{ label: "a", description: "d" }] }] },
		{
			questions: [
				{ id: "", header: "h", question: "q", options: [{ label: "a", description: "d" }, { label: "b", description: "d" }] },
			],
		},
		{ questions: [{ id: "x", header: "h", question: "q", options: [{ label: "a" }, { label: "b", description: "d" }] }] },
	]) {
		assert.ok(!normalizePlanModeQuestionParams(input).ok, `should reject: ${JSON.stringify(input)}`);
	}
});
