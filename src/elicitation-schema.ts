import { InteractionValidationError } from "./question-validation.js";

interface FormFieldBase {
	name: string;
	required: boolean;
	title?: string;
	description?: string;
}

export type ElicitationFormField =
	| (FormFieldBase & {
		type: "string";
		enum?: readonly string[];
		minLength?: number;
		maxLength?: number;
		format?: SupportedStringFormat;
	})
	| (FormFieldBase & {
		type: "number" | "integer";
		enum?: readonly number[];
		minimum?: number;
		maximum?: number;
		exclusiveMinimum?: number;
		exclusiveMaximum?: number;
		multipleOf?: number;
	})
	| (FormFieldBase & {
		type: "boolean";
		enum?: readonly boolean[];
	})
	| (FormFieldBase & {
		type: "array";
		itemEnum: readonly string[];
		minItems?: number;
		maxItems?: number;
		uniqueItems?: boolean;
	});

export type SupportedStringFormat = "date" | "date-time" | "email" | "uri" | "uri-reference";

export type ElicitationFormSupport =
	| {
		supported: true;
		title?: string;
		description?: string;
		required: readonly string[];
		fields: readonly ElicitationFormField[];
	}
	| {
		supported: false;
		reason: string;
		required: readonly string[];
		fields: readonly [];
	};

const ROOT_KEYS = new Set(["$schema", "type", "title", "description", "default", "required", "properties", "additionalProperties"]);
const COMMON_FIELD_KEYS = new Set(["type", "title", "description", "default", "enum"]);
const STRING_FORMATS = new Set<SupportedStringFormat>(["date", "date-time", "email", "uri", "uri-reference"]);

export function inspectElicitationForm(schema: unknown): ElicitationFormSupport {
	try {
		return parseElicitationForm(schema);
	} catch (error) {
		const reason = error instanceof Error ? error.message : "The form schema is unsupported";
		return { supported: false, reason, required: [], fields: [] };
	}
}

function parseElicitationForm(schema: unknown): ElicitationFormSupport {
	if (!isRecord(schema)) throw new InteractionValidationError("Form schema must be an object");
	assertKnownKeys(schema, ROOT_KEYS, "Form schema");
	if (schema.type !== "object") throw new InteractionValidationError("Form schema must declare type object");
	if (schema.title !== undefined && typeof schema.title !== "string") {
		throw new InteractionValidationError("Form schema title must be a string");
	}
	if (schema.description !== undefined && typeof schema.description !== "string") {
		throw new InteractionValidationError("Form schema description must be a string");
	}
	if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
		throw new InteractionValidationError("Form schema additionalProperties must be false when declared");
	}
	if (!isRecord(schema.properties)) throw new InteractionValidationError("Form schema properties must be a flat object");
	const required = parseRequired(schema.required, schema.properties);
	const fields = Object.entries(schema.properties).map(([name, definition]) => parseField(name, definition, required.includes(name)));
	if (fields.length === 0) throw new InteractionValidationError("Form schema must declare at least one field");
	return {
		supported: true,
		...(schema.title === undefined ? {} : { title: schema.title }),
		...(schema.description === undefined ? {} : { description: schema.description }),
		required,
		fields,
	};
}

function parseRequired(value: unknown, properties: Record<string, unknown>): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		throw new InteractionValidationError("Form schema required must be an array of field names");
	}
	const required = value as string[];
	if (new Set(required).size !== required.length) {
		throw new InteractionValidationError("Form schema required contains duplicate field names");
	}
	for (const name of required) {
		if (!Object.hasOwn(properties, name)) {
			throw new InteractionValidationError(`Required form field is not declared: ${name}`);
		}
	}
	return required;
}

function parseField(name: string, definition: unknown, required: boolean): ElicitationFormField {
	if (!isRecord(definition)) throw new InteractionValidationError(`Field ${name} must use a flat object schema`);
	if (typeof definition.title === "string" || definition.title === undefined) {
		// Title is an annotation used by the form renderer.
	} else {
		throw new InteractionValidationError(`Field ${name} title must be a string`);
	}
	if (typeof definition.description === "string" || definition.description === undefined) {
		// Description is an annotation used by the form renderer.
	} else {
		throw new InteractionValidationError(`Field ${name} description must be a string`);
	}

	const common = {
		name,
		required,
		...(typeof definition.title === "string" ? { title: definition.title } : {}),
		...(typeof definition.description === "string" ? { description: definition.description } : {}),
	};
	if (typeof definition.type !== "string") throw new InteractionValidationError(`Field ${name} must declare a supported type`);

	if (definition.type === "string") {
		assertKnownKeys(definition, new Set([...COMMON_FIELD_KEYS, "minLength", "maxLength", "format", "pattern"]), `String field ${name}`);
		if (definition.pattern !== undefined) {
			throw new InteractionValidationError(`Field ${name} uses an unsupported pattern constraint`);
		}
		const minLength = readNonNegativeInteger(definition.minLength, `Field ${name} minLength`);
		const maxLength = readNonNegativeInteger(definition.maxLength, `Field ${name} maxLength`);
		if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
			throw new InteractionValidationError(`Field ${name} has minLength greater than maxLength`);
		}
		const format = readStringFormat(definition.format, name);
		const enumeration = readEnum(definition.enum, "string", name);
		return {
			...common,
			type: "string",
			...(enumeration === undefined ? {} : { enum: enumeration as string[] }),
			...(minLength === undefined ? {} : { minLength }),
			...(maxLength === undefined ? {} : { maxLength }),
			...(format === undefined ? {} : { format }),
		};
	}

	if (definition.type === "number" || definition.type === "integer") {
		assertKnownKeys(
			definition,
			new Set([...COMMON_FIELD_KEYS, "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]),
			`Numeric field ${name}`,
		);
		const minimum = readFiniteNumber(definition.minimum, `Field ${name} minimum`);
		const maximum = readFiniteNumber(definition.maximum, `Field ${name} maximum`);
		const exclusiveMinimum = readFiniteNumber(definition.exclusiveMinimum, `Field ${name} exclusiveMinimum`);
		const exclusiveMaximum = readFiniteNumber(definition.exclusiveMaximum, `Field ${name} exclusiveMaximum`);
		const multipleOf = readFiniteNumber(definition.multipleOf, `Field ${name} multipleOf`);
		if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
			throw new InteractionValidationError(`Field ${name} has minimum greater than maximum`);
		}
		if (exclusiveMinimum !== undefined && exclusiveMaximum !== undefined && exclusiveMinimum >= exclusiveMaximum) {
			throw new InteractionValidationError(`Field ${name} has conflicting exclusive bounds`);
		}
		if (multipleOf !== undefined && multipleOf <= 0) {
			throw new InteractionValidationError(`Field ${name} multipleOf must be greater than zero`);
		}
		const enumeration = readEnum(definition.enum, definition.type, name);
		return {
			...common,
			type: definition.type,
			...(enumeration === undefined ? {} : { enum: enumeration as number[] }),
			...(minimum === undefined ? {} : { minimum }),
			...(maximum === undefined ? {} : { maximum }),
			...(exclusiveMinimum === undefined ? {} : { exclusiveMinimum }),
			...(exclusiveMaximum === undefined ? {} : { exclusiveMaximum }),
			...(multipleOf === undefined ? {} : { multipleOf }),
		};
	}

	if (definition.type === "boolean") {
		assertKnownKeys(definition, COMMON_FIELD_KEYS, `Boolean field ${name}`);
		const enumeration = readEnum(definition.enum, "boolean", name);
		return {
			...common,
			type: "boolean",
			...(enumeration === undefined ? {} : { enum: enumeration as boolean[] }),
		};
	}

	if (definition.type === "array") {
		if (definition.enum !== undefined) {
			throw new InteractionValidationError(`Array field ${name} uses an unsupported enum constraint`);
		}
		assertKnownKeys(
			definition,
			new Set([...COMMON_FIELD_KEYS, "items", "minItems", "maxItems", "uniqueItems"]),
			`Array field ${name}`,
		);
		if (!isRecord(definition.items)) throw new InteractionValidationError(`Array field ${name} needs an item schema`);
		assertKnownKeys(definition.items, new Set(["type", "enum", "title", "description", "default"]), `Array field ${name} item`);
		if (definition.items.type !== "string") {
			throw new InteractionValidationError(`Array field ${name} must contain strings`);
		}
		const itemEnum = readEnum(definition.items.enum, "string", `${name} item`);
		if (!itemEnum || itemEnum.length === 0) {
			throw new InteractionValidationError(`Array field ${name} must declare string enum items`);
		}
		const minItems = readNonNegativeInteger(definition.minItems, `Field ${name} minItems`);
		const maxItems = readNonNegativeInteger(definition.maxItems, `Field ${name} maxItems`);
		if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
			throw new InteractionValidationError(`Field ${name} has minItems greater than maxItems`);
		}
		if (definition.uniqueItems !== undefined && typeof definition.uniqueItems !== "boolean") {
			throw new InteractionValidationError(`Field ${name} uniqueItems must be a boolean`);
		}
		return {
			...common,
			type: "array",
			itemEnum: itemEnum as string[],
			...(minItems === undefined ? {} : { minItems }),
			...(maxItems === undefined ? {} : { maxItems }),
			...(definition.uniqueItems === undefined ? {} : { uniqueItems: definition.uniqueItems }),
		};
	}

	throw new InteractionValidationError(`Field ${name} uses unsupported type ${definition.type}`);
}

function readEnum(value: unknown, type: "string" | "number" | "integer" | "boolean", name: string): unknown[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length === 0) {
		throw new InteractionValidationError(`Field ${name} enum must contain at least one value`);
	}
	for (const item of value) {
		const valid = type === "string"
			? typeof item === "string"
			: type === "boolean"
				? typeof item === "boolean"
				: typeof item === "number" && Number.isFinite(item) && (type !== "integer" || Number.isInteger(item));
		if (!valid) throw new InteractionValidationError(`Field ${name} enum values do not match type ${type}`);
	}
	if (new Set(value).size !== value.length) {
		throw new InteractionValidationError(`Field ${name} enum contains duplicate values`);
	}
	return value;
}

function readStringFormat(value: unknown, name: string): SupportedStringFormat | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !STRING_FORMATS.has(value as SupportedStringFormat)) {
		throw new InteractionValidationError(`Field ${name} uses an unsupported format`);
	}
	return value as SupportedStringFormat;
}

function readNonNegativeInteger(value: unknown, description: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new InteractionValidationError(`${description} must be a non-negative integer`);
	}
	return value;
}

function readFiniteNumber(value: unknown, description: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new InteractionValidationError(`${description} must be a finite number`);
	}
	return value;
}

function assertKnownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, description: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new InteractionValidationError(`${description} constraint ${key} is unsupported`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
