import type { PendingElicitation } from "@/features/conversation/pending-elicitation";

export type ElicitationResponseHandler = (
	elicitation: PendingElicitation,
	action: "accept" | "decline" | "cancel",
	content?: Record<string, unknown>,
) => void;

type ElicitationEnumOption = {
	value: string;
	label: string;
	description: string;
};

type ElicitationBaseField = {
	key: string;
	label: string;
	description: string;
	required: boolean;
};

export type ElicitationBooleanField = ElicitationBaseField & {
	kind: "boolean";
	defaultValue: boolean | null;
};

export type ElicitationStringField = ElicitationBaseField & {
	kind: "string";
	format: "email" | "uri" | "date" | "date-time" | null;
	minLength: number | null;
	maxLength: number | null;
	defaultValue: string;
};

export type ElicitationNumberField = ElicitationBaseField & {
	kind: "number" | "integer";
	minimum: number | null;
	maximum: number | null;
	defaultValue: string;
};

export type ElicitationSingleSelectField = ElicitationBaseField & {
	kind: "single-select";
	options: ElicitationEnumOption[];
	defaultValue: string | null;
	allowOther: boolean;
};

export type ElicitationMultiSelectField = ElicitationBaseField & {
	kind: "multi-select";
	options: ElicitationEnumOption[];
	minItems: number | null;
	maxItems: number | null;
	defaultValue: string[];
};

export type ElicitationFormField =
	| ElicitationBooleanField
	| ElicitationStringField
	| ElicitationNumberField
	| ElicitationSingleSelectField
	| ElicitationMultiSelectField;

export type ElicitationFormViewModel = {
	kind: "form";
	elicitationId: string;
	serverName: string;
	message: string;
	fields: ElicitationFormField[];
};

export type ElicitationUrlViewModel = {
	kind: "url";
	elicitationId: string;
	serverName: string;
	message: string;
	url: string;
	host: string | null;
};

export type UnsupportedElicitationViewModel = {
	kind: "unsupported";
	elicitationId: string;
	serverName: string;
	message: string;
	reason: string;
};

export type ElicitationViewModel =
	| ElicitationFormViewModel
	| ElicitationUrlViewModel
	| UnsupportedElicitationViewModel;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function readNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

function readStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string")
		: [];
}

function normalizeEnumOptions(
	schema: Record<string, unknown>,
): ElicitationEnumOption[] {
	if (Array.isArray(schema.oneOf)) {
		return schema.oneOf
			.map((option) => {
				if (!isRecord(option)) {
					return null;
				}

				const value = readString(option.const);
				if (!value) {
					return null;
				}

				return {
					value,
					label: readString(option.title) ?? value,
					description: readString(option.description) ?? "",
				} satisfies ElicitationEnumOption;
			})
			.filter((option): option is ElicitationEnumOption => option !== null);
	}

	const enumValues = readStringArray(schema.enum);
	const enumNames = readStringArray(schema.enumNames);
	return enumValues.map((value, index) => ({
		value,
		label: enumNames[index] ?? value,
		description: "",
	}));
}

function normalizeMultiSelectOptions(
	schema: Record<string, unknown>,
): ElicitationEnumOption[] {
	const items = isRecord(schema.items) ? schema.items : null;
	if (!items) {
		return [];
	}

	if (Array.isArray(items.anyOf)) {
		return items.anyOf
			.map((option) => {
				if (!isRecord(option)) {
					return null;
				}

				const value = readString(option.const);
				if (!value) {
					return null;
				}

				return {
					value,
					label: readString(option.title) ?? value,
					description: readString(option.description) ?? "",
				} satisfies ElicitationEnumOption;
			})
			.filter((option): option is ElicitationEnumOption => option !== null);
	}

	return readStringArray(items.enum).map((value) => ({
		value,
		label: value,
		description: "",
	}));
}

function normalizeFormField(
	key: string,
	schema: unknown,
	requiredKeys: Set<string>,
): ElicitationFormField | null {
	if (!isRecord(schema)) {
		return null;
	}

	const label = readString(schema.title) ?? key;
	const description = readString(schema.description) ?? "";
	const required = requiredKeys.has(key);
	const type = readString(schema.type);

	if (type === "boolean") {
		return {
			kind: "boolean",
			key,
			label,
			description,
			required,
			defaultValue: readBoolean(schema.default),
		};
	}

	if (type === "string") {
		const options = normalizeEnumOptions(schema);
		if (options.length > 0) {
			return {
				kind: "single-select",
				key,
				label,
				description,
				required,
				options,
				defaultValue: readString(schema.default),
				allowOther: isRecord(schema) && schema["x-allow-other"] === true,
			};
		}

		const format = readString(schema.format);
		return {
			kind: "string",
			key,
			label,
			description,
			required,
			format:
				format === "email" ||
				format === "uri" ||
				format === "date" ||
				format === "date-time"
					? format
					: null,
			minLength: readNumber(schema.minLength),
			maxLength: readNumber(schema.maxLength),
			defaultValue: readString(schema.default) ?? "",
		};
	}

	if (type === "number" || type === "integer") {
		const defaultValue = readNumber(schema.default);
		return {
			kind: type,
			key,
			label,
			description,
			required,
			minimum: readNumber(schema.minimum),
			maximum: readNumber(schema.maximum),
			defaultValue: defaultValue === null ? "" : defaultValue.toString(),
		};
	}

	if (type === "array") {
		const options = normalizeMultiSelectOptions(schema);
		if (options.length === 0) {
			return null;
		}

		return {
			kind: "multi-select",
			key,
			label,
			description,
			required,
			options,
			minItems: readNumber(schema.minItems),
			maxItems: readNumber(schema.maxItems),
			defaultValue: readStringArray(schema.default),
		};
	}

	return null;
}

export function normalizeElicitation(
	elicitation: PendingElicitation,
): ElicitationViewModel {
	if (elicitation.mode === "url") {
		const url = elicitation.url?.trim();
		if (!url) {
			return {
				kind: "unsupported",
				elicitationId: elicitation.elicitationId,
				serverName: elicitation.serverName,
				message: elicitation.message,
				reason: "Missing URL for URL-mode elicitation.",
			};
		}

		let host: string | null = null;
		try {
			host = new URL(url).host;
		} catch {
			host = null;
		}

		return {
			kind: "url",
			elicitationId: elicitation.elicitationId,
			serverName: elicitation.serverName,
			message: elicitation.message,
			url,
			host,
		};
	}

	const schema = isRecord(elicitation.requestedSchema)
		? elicitation.requestedSchema
		: null;
	if (!schema || readString(schema.type) !== "object") {
		return {
			kind: "unsupported",
			elicitationId: elicitation.elicitationId,
			serverName: elicitation.serverName,
			message: elicitation.message,
			reason: "Unsupported form schema.",
		};
	}

	const properties = isRecord(schema.properties) ? schema.properties : null;
	if (!properties) {
		return {
			kind: "unsupported",
			elicitationId: elicitation.elicitationId,
			serverName: elicitation.serverName,
			message: elicitation.message,
			reason: "Form elicitation is missing properties.",
		};
	}

	const requiredKeys = new Set(readStringArray(schema.required));
	const entries = Object.entries(properties);
	const normalizedFields = entries
		.map(([key, value]) => normalizeFormField(key, value, requiredKeys))
		.filter((field): field is ElicitationFormField => field !== null);
	const supportedKeys = new Set(normalizedFields.map((field) => field.key));
	const unsupportedRequiredKeys = Array.from(requiredKeys).filter(
		(key) => key in properties && !supportedKeys.has(key),
	);

	if (unsupportedRequiredKeys.length > 0) {
		return {
			kind: "unsupported",
			elicitationId: elicitation.elicitationId,
			serverName: elicitation.serverName,
			message: elicitation.message,
			reason: "Form schema contains unsupported required fields.",
		};
	}

	if (normalizedFields.length === 0) {
		return {
			kind: "unsupported",
			elicitationId: elicitation.elicitationId,
			serverName: elicitation.serverName,
			message: elicitation.message,
			reason: "No supported fields were found in the form schema.",
		};
	}

	return {
		kind: "form",
		elicitationId: elicitation.elicitationId,
		serverName: elicitation.serverName,
		message: elicitation.message,
		fields: normalizedFields,
	};
}
