/**
 * plan_mode_question tool.
 *
 * Lets the model ask the user 1-3 structured questions (each with 2-4
 * options) through the interactive selector, instead of guessing preferences
 * while planning. Parameter schema and result payload follow
 * @narumitw/pi-plan-mode's question tool (MIT); the questionnaire itself is
 * implemented with pi's native ctx.ui.select / ctx.ui.input dialogs.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const PLAN_MODE_QUESTION_TOOL_NAME = "plan_mode_question";

export type PlanModeQuestionOption = {
	label: string;
	description: string;
};

export type PlanModeQuestion = {
	id: string;
	header: string;
	question: string;
	options: PlanModeQuestionOption[];
};

export type PlanModeQuestionAnswer = {
	id: string;
	header: string;
	question: string;
	answer: string;
	wasCustom: boolean;
};

type PlanModeQuestionReason = "cancelled" | "ui_unavailable" | "invalid_input";

export type PlanModeQuestionResult = {
	content: [{ type: "text"; text: string }];
	details: {
		cancelled: boolean;
		reason?: PlanModeQuestionReason;
		questions: PlanModeQuestion[];
		answers?: PlanModeQuestionAnswer[];
	};
};

export const PLAN_MODE_QUESTION_PARAMS = {
	type: "object",
	additionalProperties: false,
	required: ["questions"],
	properties: {
		questions: {
			type: "array",
			minItems: 1,
			maxItems: 3,
			description: "Questions to show the user. Prefer 1 and do not exceed 3.",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["id", "header", "question", "options"],
				properties: {
					id: {
						type: "string",
						description: "Stable identifier for mapping answers (snake_case).",
					},
					header: {
						type: "string",
						description: "Short header label shown in the UI (12 or fewer chars).",
					},
					question: { type: "string", description: "Single-sentence prompt shown to the user." },
					options: {
						type: "array",
						minItems: 2,
						maxItems: 4,
						description:
							"Provide 2-4 mutually exclusive choices. Put the recommended option first when there is a clear default.",
						items: {
							type: "object",
							additionalProperties: false,
							required: ["label", "description"],
							properties: {
								label: { type: "string", description: "User-facing label (1-5 words)." },
								description: {
									type: "string",
									description: "One short sentence explaining impact/tradeoff if selected.",
								},
							},
						},
					},
				},
			},
		},
	},
} as const;

const CUSTOM_OPTION_LABEL = "✎ Other (type a custom answer)";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizePlanModeQuestionParams(input: unknown):
	| { ok: true; questions: PlanModeQuestion[] }
	| { ok: false; error: string } {
	if (!isRecord(input) || !Array.isArray(input.questions)) {
		return { ok: false, error: "questions must be an array" };
	}
	if (input.questions.length < 1 || input.questions.length > 3) {
		return { ok: false, error: "questions must contain 1-3 items" };
	}

	const questions: PlanModeQuestion[] = [];
	for (const [questionIndex, rawQuestion] of input.questions.entries()) {
		if (!isRecord(rawQuestion)) {
			return { ok: false, error: `question ${questionIndex + 1} must be an object` };
		}
		const id = stringField(rawQuestion.id);
		const header = stringField(rawQuestion.header);
		const question = stringField(rawQuestion.question);
		if (!id || !header || !question) {
			return { ok: false, error: `question ${questionIndex + 1} requires non-empty id, header, and question` };
		}
		if (!Array.isArray(rawQuestion.options)) {
			return { ok: false, error: `question ${questionIndex + 1} options must be an array` };
		}
		if (rawQuestion.options.length < 2 || rawQuestion.options.length > 4) {
			return { ok: false, error: `question ${questionIndex + 1} options must contain 2-4 items` };
		}
		const options: PlanModeQuestionOption[] = [];
		for (const [optionIndex, rawOption] of rawQuestion.options.entries()) {
			if (!isRecord(rawOption)) {
				return { ok: false, error: `question ${questionIndex + 1} option ${optionIndex + 1} must be an object` };
			}
			const label = stringField(rawOption.label);
			const description = stringField(rawOption.description);
			if (!label || !description) {
				return {
					ok: false,
					error: `question ${questionIndex + 1} option ${optionIndex + 1} requires a label and description`,
				};
			}
			options.push({ label, description });
		}
		questions.push({ id, header, question, options });
	}
	return { ok: true, questions };
}

function cancelled(questions: PlanModeQuestion[], reason: PlanModeQuestionReason, message: string): PlanModeQuestionResult {
	return {
		content: [{ type: "text", text: JSON.stringify({ cancelled: true, reason, message }, null, 2) }],
		details: { cancelled: true, reason, questions },
	};
}

function answered(questions: PlanModeQuestion[], answers: PlanModeQuestionAnswer[]): PlanModeQuestionResult {
	return {
		content: [{ type: "text", text: JSON.stringify({ cancelled: false, answers }, null, 2) }],
		details: { cancelled: false, questions, answers },
	};
}

/** Run the interactive questionnaire; returns undefined when the user cancels. */
async function askQuestions(
	questions: PlanModeQuestion[],
	ctx: ExtensionContext,
): Promise<PlanModeQuestionAnswer[] | undefined> {
	const answers: PlanModeQuestionAnswer[] = [];
	for (const [index, question] of questions.entries()) {
		if (ctx.signal?.aborted) return undefined;
		const optionStrings = question.options.map((option) => `${option.label} — ${option.description}`);
		const selection = await ctx.ui.select(
			`${question.header}: ${question.question}`,
			[...optionStrings, CUSTOM_OPTION_LABEL],
			{ signal: ctx.signal },
		);
		if (selection === undefined) return undefined;

		if (selection === CUSTOM_OPTION_LABEL) {
			const custom = await ctx.ui.input(question.header, question.question, { signal: ctx.signal });
			const answer = custom?.trim();
			if (!answer) return undefined;
			answers.push({ id: question.id, header: question.header, question: question.question, answer, wasCustom: true });
			continue;
		}

		const optionIndex = optionStrings.indexOf(selection);
		const option = optionIndex >= 0 ? question.options[optionIndex] : undefined;
		if (!option) return undefined;
		answers.push({
			id: question.id,
			header: question.header,
			question: question.question,
			answer: option.label,
			wasCustom: false,
		});
		if (index < questions.length - 1) continue;
	}
	return answers;
}

export async function executePlanModeQuestion(
	params: unknown,
	ctx: ExtensionContext,
): Promise<PlanModeQuestionResult> {
	const parsed = normalizePlanModeQuestionParams(params);
	if (!parsed.ok) {
		return cancelled([], "invalid_input", `Error: ${parsed.error}`);
	}
	if (!ctx.hasUI) {
		return cancelled(
			parsed.questions,
			"ui_unavailable",
			"Unable to ask structured questions because interactive UI is not available.",
		);
	}
	try {
		const answers = await askQuestions(parsed.questions, ctx);
		if (!answers) {
			return cancelled(parsed.questions, "cancelled", "User cancelled the question prompt.");
		}
		return answered(parsed.questions, answers);
	} catch (error) {
		return cancelled(
			parsed.questions,
			"cancelled",
			`Question prompt failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
