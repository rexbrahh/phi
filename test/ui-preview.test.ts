import assert from "node:assert/strict";
import test from "node:test";
import { boundedPreviewValue } from "../src/state-utils.js";

test("UI value previews bound output without invoking serializers or reading later fields", () => {
	let serializerCalled = false;
	let lateFieldRead = false;
	const input: Record<string, unknown> = {
		command: "echo safe",
		details: { path: "/repo" },
		toJSON: () => {
			serializerCalled = true;
			return "serialized";
		},
	};
	for (let index = 0; index < 20; index += 1) input[`field${index}`] = `value-${index}`;
	Object.defineProperty(input, "lateField", {
		enumerable: true,
		get: () => {
			lateFieldRead = true;
			return "late";
		},
	});

	const preview = boundedPreviewValue(input);
	const largeStringPreview = boundedPreviewValue("x".repeat(20_000));

	assert.match(preview, /command/);
	assert.match(preview, /  details: \{\n    path: \/repo\n  \}/);
	assert.ok(preview.length <= 8_192);
	assert.ok(preview.split("\n").length <= 12);
	assert.ok(largeStringPreview.length <= 8_192);
	assert.ok(largeStringPreview.split("\n").length <= 12);
	assert.equal(serializerCalled, false);
	assert.equal(lateFieldRead, false);
});
