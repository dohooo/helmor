const KEY_LABELS: Record<string, string> = {
	Mod: "command",
	Meta: "command",
	Command: "command",
	Cmd: "command",
	Alt: "option",
	Option: "option",
	Control: "control",
	Ctrl: "control",
	Shift: "shift",
	Escape: "Esc",
	Enter: "enter",
	Return: "enter",
	Backspace: "delete",
	Delete: "delete",
	Space: "space",
	ArrowUp: "↑",
	ArrowDown: "↓",
	ArrowLeft: "←",
	ArrowRight: "→",
	Comma: ",",
	Period: ".",
	Slash: "/",
	Minus: "-",
	Equal: "=",
	"˙": "H",
	"¬": "L",
};

const INLINE_KEY_LABELS: Record<string, string> = {
	Mod: "⌘",
	Meta: "⌘",
	Command: "⌘",
	Cmd: "⌘",
	Alt: "⌥",
	Option: "⌥",
	Control: "⌃",
	Ctrl: "⌃",
	Shift: "⇧",
	Escape: "Esc",
	Enter: "↩",
	Return: "↩",
	Backspace: "⌫",
	Delete: "⌫",
	Space: "Space",
	ArrowUp: "↑",
	ArrowDown: "↓",
	ArrowLeft: "←",
	ArrowRight: "→",
	Comma: ",",
	Period: ".",
	Slash: "/",
	Minus: "-",
	Equal: "=",
	"˙": "H",
	"¬": "L",
};

const CODE_KEY_LABELS: Record<string, string> = {
	Backquote: "`",
	Backslash: "\\",
	BracketLeft: "[",
	BracketRight: "]",
	Comma: ",",
	Equal: "=",
	Minus: "-",
	Period: ".",
	Quote: "'",
	Semicolon: ";",
	Slash: "/",
};

const MODIFIER_KEYS = new Set([
	"Alt",
	"Control",
	"Meta",
	"OS",
	"Shift",
	"Hyper",
	"Super",
]);

export function shortcutToKeys(hotkey: string | null): string[] {
	if (!hotkey) return [];
	return hotkey
		.split("+")
		.map((part) => part.trim())
		.filter(Boolean)
		.map((part) => KEY_LABELS[part] ?? part);
}

export function shortcutToInlineLabel(hotkey: string | null): string {
	return shortcutToInlineParts(hotkey).join("");
}

export function shortcutToInlineParts(hotkey: string | null): string[] {
	if (!hotkey) return [];
	return hotkey
		.split("+")
		.map((part) => part.trim())
		.filter(Boolean)
		.map((part) => INLINE_KEY_LABELS[part] ?? part);
}

export function normalizeShortcutEvent(event: KeyboardEvent): string | null {
	const key = getShortcutKey(event);
	if (!key) return null;

	const parts: string[] = [];
	if (event.metaKey) parts.push("Mod");
	if (event.ctrlKey) parts.push("Control");
	if (event.altKey) parts.push("Alt");
	if (event.shiftKey) parts.push("Shift");

	parts.push(key);
	return parts.join("+");
}

function getShortcutKey(event: KeyboardEvent): string | null {
	if (MODIFIER_KEYS.has(event.key)) return null;

	if (event.code.startsWith("Key")) {
		return event.code.slice(3).toUpperCase();
	}
	if (event.code.startsWith("Digit")) {
		return event.code.slice(5);
	}
	if (CODE_KEY_LABELS[event.code]) {
		return CODE_KEY_LABELS[event.code];
	}

	const key = normalizeSpecialKey(event.key);
	if (key.length === 1 && /[a-z]/i.test(key)) {
		return key.toUpperCase();
	}
	return key || null;
}

function normalizeSpecialKey(key: string): string {
	switch (key) {
		case " ":
		case "Spacebar":
			return "Space";
		case "Esc":
			return "Escape";
		case "Return":
			return "Enter";
		default:
			return key;
	}
}
