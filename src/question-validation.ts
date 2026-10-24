export interface AskUserQuestionOption {
	label: string;
	description?: string;
}

export interface AskUserQuestion {
	question: string;
	header?: string;
	options?: AskUserQuestionOption[];
	multiSelect?: boolean;
	[key: string]: unknown;
}

export type QuestionValue =
	| { kind: "choice"; label: string }
	| { kind: "choices"; labels: string[] }
	| { kind: "text"; text: string };

export class InteractionValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InteractionValidationError";
	}
}

export function parseAskUserQuestions(input: Record<string, unknown>): AskUserQuestion[] {
	const rawQuestions = input.questions;
	if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
		throw new InteractionValidationError("AskUserQuestion must contain at least one question");
	}

	const questions = rawQuestions as AskUserQuestion[];
	const seenQuestions = new Set<string>();
	for (const [index, question] of questions.entries()) {
		if (!isRecord(question)) {
			throw new InteractionValidationError(`Question ${index + 1} must be an object`);
		}
		if (typeof question.question !== "string" || question.question.trim().length === 0) {
			throw new InteractionValidationError(`Question ${index + 1} must include non-empty question text`);
		}
		if (seenQuestions.has(question.question)) {
			throw new InteractionValidationError(`Question text must be unique: ${question.question}`);
		}
		seenQuestions.add(question.question);

		if (question.header !== undefined && typeof question.header !== "string") {
			throw new InteractionValidationError(`Question ${index + 1} has an invalid header`);
		}
		if (question.multiSelect !== undefined && typeof question.multiSelect !== "boolean") {
			throw new InteractionValidationError(`Question ${index + 1} has an invalid multiSelect value`);
		}
		if (question.options !== undefined && !Array.isArray(question.options)) {
			throw new InteractionValidationError(`Question ${index + 1} options must be an array`);
		}

		const options = question.options ?? [];
		const seenLabels = new Set<string>();
		for (const [optionIndex, option] of options.entries()) {
			if (!isRecord(option) || typeof option.label !== "string" || option.label.trim().length === 0) {
				throw new InteractionValidationError(`Question ${index + 1} option ${optionIndex + 1} must include a label`);
			}
			if (option.description !== undefined && typeof option.description !== "string") {
				throw new InteractionValidationError(`Question ${index + 1} option ${optionIndex + 1} has an invalid description`);
			}
			if (seenLabels.has(option.label)) {
				throw new InteractionValidationError(`Question ${index + 1} has duplicate option label: ${option.label}`);
			}
			seenLabels.add(option.label);
		}
		if (question.multiSelect === true && options.length === 0) {
			throw new InteractionValidationError(`Question ${index + 1} cannot use multiSelect without options`);
		}
	}

	return questions;
}

export function validateQuestionAnswers(
	questions: readonly AskUserQuestion[],
	answers: unknown,
): Record<string, string | string[]> {
	if (!isRecord(answers)) {
		throw new InteractionValidationError("Question answers must be an object");
	}

	const expectedQuestions = new Set(questions.map((question) => question.question));
	for (const key of Object.keys(answers)) {
		if (!expectedQuestions.has(key)) {
			throw new InteractionValidationError(`Answer references an unknown question: ${key}`);
		}
	}

	const normalized: Record<string, string | string[]> = {};
	for (const question of questions) {
		if (!Object.hasOwn(answers, question.question)) {
			throw new InteractionValidationError(`A required answer is missing for: ${question.question}`);
		}

		const value = answers[question.question];
		if (!isRecord(value) || typeof value.kind !== "string") {
			throw new InteractionValidationError(`Answer for ${question.question} has an invalid type`);
		}

		const labels = new Set((question.options ?? []).map((option) => option.label));
		if (value.kind === "choice") {
			if (question.multiSelect === true) {
				throw new InteractionValidationError(`Question ${question.question} requires a multiple-choice answer`);
			}
			if (typeof value.label !== "string" || !labels.has(value.label)) {
				throw new InteractionValidationError(`Answer for ${question.question} must match an available option`);
			}
			normalized[question.question] = value.label;
			continue;
		}

		if (value.kind === "choices") {
			if (question.multiSelect !== true) {
				throw new InteractionValidationError(`Question ${question.question} accepts one choice`);
			}
			if (!Array.isArray(value.labels) || value.labels.length === 0) {
				throw new InteractionValidationError(`A required answer for ${question.question} cannot be empty`);
			}
			const selected = new Set<string>();
			for (const label of value.labels) {
				if (typeof label !== "string" || !labels.has(label)) {
					throw new InteractionValidationError(`Answer for ${question.question} must contain available option labels`);
				}
				if (selected.has(label)) {
					throw new InteractionValidationError(`Answer for ${question.question} contains a duplicate option`);
				}
				selected.add(label);
			}
			normalized[question.question] = [...value.labels];
			continue;
		}

		if (value.kind === "text") {
			if (question.multiSelect === true) {
				throw new InteractionValidationError(`Question ${question.question} requires option labels`);
			}
			if (typeof value.text !== "string" || value.text.trim().length === 0) {
				throw new InteractionValidationError(`A required answer for ${question.question} cannot be empty`);
			}
			normalized[question.question] = value.text;
			continue;
		}

		throw new InteractionValidationError(`Answer for ${question.question} uses an unsupported response type`);
	}

	return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
