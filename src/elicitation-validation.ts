import type { ElicitationRequest, ElicitationResult } from "@anthropic-ai/claude-agent-sdk";
import {
	inspectElicitationForm,
	type ElicitationFormField,
	type ElicitationFormSupport,
	type SupportedStringFormat,
} from "./elicitation-schema.js";
import { InteractionValidationError } from "./question-validation.js";

type ElicitationContent = NonNullable<ElicitationResult["content"]>;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const INVALID_PERCENT_ESCAPE_PATTERN = /%(?![0-9a-f]{2})/iu;

export { inspectElicitationForm };
export type { ElicitationFormField, ElicitationFormSupport, SupportedStringFormat };

export function isHttpElicitationUrl(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0) return false;
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

export function validateElicitationResponse(
	request: ElicitationRequest,
	form: ElicitationFormSupport | undefined,
	canOpenUrl: boolean,
	response: ElicitationResult,
): ElicitationResult {
	if (!isRecord(response) || !isElicitationAction(response.action)) {
		throw new InteractionValidationError("Elicitation response must choose accept, decline, or cancel");
	}

	if (response.action !== "accept") {
		return {
			action: response.action,
			...(response._meta === undefined ? {} : { _meta: response._meta }),
		};
	}

	if (request.mode === "url") {
		if (!canOpenUrl) {
			throw new InteractionValidationError("This elicitation URL cannot be opened; decline or cancel the request");
		}
		if (response.content !== undefined && Object.keys(response.content).length > 0) {
			throw new InteractionValidationError("URL elicitation responses cannot include form content");
		}
		return {
			action: "accept",
			...(response._meta === undefined ? {} : { _meta: response._meta }),
		};
	}

	if (!form?.supported) {
		throw new InteractionValidationError(`Elicitation form is unsupported: ${form?.reason ?? "no supported schema was provided"}`);
	}
	const content = validateElicitationContent(form, response.content);
	return {
		action: "accept",
		content,
		...(response._meta === undefined ? {} : { _meta: response._meta }),
	};
}

function validateElicitationContent(
	form: Extract<ElicitationFormSupport, { supported: true }>,
	content: unknown,
): ElicitationContent {
	const values = content === undefined ? {} : content;
	if (!isRecord(values)) throw new InteractionValidationError("Form content must be an object");
	const fields = new Map(form.fields.map((field) => [field.name, field]));
	for (const key of Object.keys(values)) {
		if (!fields.has(key)) throw new InteractionValidationError(`Form content contains an unknown field: ${key}`);
	}

	for (const field of form.fields) {
		if (!Object.hasOwn(values, field.name)) {
			if (field.required) throw new InteractionValidationError(`Required form field is missing: ${field.name}`);
			continue;
		}
		validateFieldValue(field, values[field.name]);
	}
	return values as ElicitationContent;
}

function validateFieldValue(field: ElicitationFormField, value: unknown): void {
	if (field.type === "string") {
		if (typeof value !== "string") throw new InteractionValidationError(`Field ${field.name} must be text`);
		const length = [...value].length;
		if (field.required && value.trim().length === 0) {
			throw new InteractionValidationError(`Required form field ${field.name} cannot be empty`);
		}
		if (field.minLength !== undefined && length < field.minLength) {
			throw new InteractionValidationError(`Field ${field.name} is shorter than minLength`);
		}
		if (field.maxLength !== undefined && length > field.maxLength) {
			throw new InteractionValidationError(`Field ${field.name} is longer than maxLength`);
		}
		if (field.enum && !field.enum.includes(value)) {
			throw new InteractionValidationError(`Field ${field.name} must match a declared enum value`);
		}
		if (field.format && !matchesFormat(value, field.format)) {
			throw new InteractionValidationError(`Field ${field.name} does not match format ${field.format}`);
		}
		return;
	}

	if (field.type === "number" || field.type === "integer") {
		if (typeof value !== "number" || !Number.isFinite(value)) {
			throw new InteractionValidationError(`Field ${field.name} must be a finite number`);
		}
		if (field.type === "integer" && !Number.isInteger(value)) {
			throw new InteractionValidationError(`Field ${field.name} must be an integer`);
		}
		if (field.enum && !field.enum.includes(value)) {
			throw new InteractionValidationError(`Field ${field.name} must match a declared enum value`);
		}
		if (field.minimum !== undefined && value < field.minimum) {
			throw new InteractionValidationError(`Field ${field.name} is below minimum`);
		}
		if (field.maximum !== undefined && value > field.maximum) {
			throw new InteractionValidationError(`Field ${field.name} is above maximum`);
		}
		if (field.exclusiveMinimum !== undefined && value <= field.exclusiveMinimum) {
			throw new InteractionValidationError(`Field ${field.name} must be above exclusiveMinimum`);
		}
		if (field.exclusiveMaximum !== undefined && value >= field.exclusiveMaximum) {
			throw new InteractionValidationError(`Field ${field.name} must be below exclusiveMaximum`);
		}
		if (field.multipleOf !== undefined && !isMultipleOf(value, field.multipleOf)) {
			throw new InteractionValidationError(`Field ${field.name} must be a multiple of ${field.multipleOf}`);
		}
		return;
	}

	if (field.type === "boolean") {
		if (typeof value !== "boolean") throw new InteractionValidationError(`Field ${field.name} must be true or false`);
		if (field.enum && !field.enum.includes(value)) {
			throw new InteractionValidationError(`Field ${field.name} must match a declared enum value`);
		}
		return;
	}

	if (field.type !== "array") throw new InteractionValidationError(`Field ${field.name} has an unsupported type`);
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new InteractionValidationError(`Field ${field.name} must be an array of strings`);
	}
	if (field.required && value.length === 0) {
		throw new InteractionValidationError(`Required form field ${field.name} cannot be empty`);
	}
	if (field.minItems !== undefined && value.length < field.minItems) {
		throw new InteractionValidationError(`Field ${field.name} has fewer than minItems`);
	}
	if (field.maxItems !== undefined && value.length > field.maxItems) {
		throw new InteractionValidationError(`Field ${field.name} has more than maxItems`);
	}
	if (field.uniqueItems && new Set(value).size !== value.length) {
		throw new InteractionValidationError(`Field ${field.name} must contain unique items`);
	}
	for (const item of value) {
		if (!field.itemEnum.includes(item)) {
			throw new InteractionValidationError(`Field ${field.name} contains an unknown enum item`);
		}
	}
}

function matchesFormat(value: string, format: SupportedStringFormat): boolean {
	if (INVALID_PERCENT_ESCAPE_PATTERN.test(value)) return false;
	switch (format) {
		case "date":
			return isCalendarDate(value);
		case "date-time":
			return isDateTime(value);
		case "email":
			return EMAIL_PATTERN.test(value);
		case "uri":
			return isUri(value);
		case "uri-reference":
			return isUriReference(value);
	}
}

function isCalendarDate(value: string): boolean {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
	if (!match) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	if (month < 1 || month > 12 || day < 1) return false;
	const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	return day <= (daysInMonth[month - 1] ?? 0);
}

function isDateTime(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return false;
	const date = value.slice(0, 10);
	if (!isCalendarDate(date)) return false;
	const time = value.slice(11, 19).split(":").map(Number);
	if (time.length !== 3 || (time[0] ?? 24) > 23 || (time[1] ?? 60) > 59 || (time[2] ?? 60) > 59) return false;
	return Number.isFinite(Date.parse(value));
}

function isUri(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol.length > 1 && /^[a-z][a-z0-9+.-]*:$/iu.test(url.protocol);
	} catch {
		return false;
	}
}

function isUriReference(value: string): boolean {
	try {
		new URL(value, "https://phi.invalid/");
		return true;
	} catch {
		return false;
	}
}

function isMultipleOf(value: number, divisor: number): boolean {
	const quotient = value / divisor;
	return Math.abs(quotient - Math.round(quotient)) <= Number.EPSILON * Math.max(1, Math.abs(quotient)) * 8;
}

function isElicitationAction(value: unknown): value is "accept" | "decline" | "cancel" {
	return value === "accept" || value === "decline" || value === "cancel";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
