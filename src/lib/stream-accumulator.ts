/**
 * Accumulates Claude CLI stream-json lines and produces partial
 * SessionMessageRecord snapshots for real-time rendering.
 *
 * Collects full assistant/user events (tool calls, tool results, text, thinking)
 * so intermediate steps are visible during streaming.
 *
 * Enhanced with block-level tracking for content_block_start/delta/stop events,
 * enabling tool_use visibility during streaming and tool progress indicators.
 */
import type { SessionMessageRecord } from "./api";

// ---------------------------------------------------------------------------
// Streaming block types (internal)
// ---------------------------------------------------------------------------

type StreamingTextBlock = {
	kind: "text";
	blockIndex: number;
	text: string;
};

type StreamingThinkingBlock = {
	kind: "thinking";
	blockIndex: number;
	text: string;
};

type StreamingToolUseBlock = {
	kind: "tool_use";
	blockIndex: number;
	toolUseId: string;
	toolName: string;
	/** Accumulated partial JSON input text */
	inputJsonText: string;
	/** Parsed input (set when content_block_stop arrives) */
	parsedInput: Record<string, unknown> | null;
	/** Execution status */
	status: "pending" | "streaming_input" | "running" | "done" | "error";
};

type StreamingBlock =
	| StreamingTextBlock
	| StreamingThinkingBlock
	| StreamingToolUseBlock;

// ---------------------------------------------------------------------------
// StreamAccumulator
// ---------------------------------------------------------------------------

export class StreamAccumulator {
	/** Collected full message events (assistant + user) for rendering. */
	private collectedMessages: SessionMessageRecord[] = [];

	/** Block-level tracking for structured streaming content. */
	private blocks = new Map<number, StreamingBlock>();

	/**
	 * Fallback flat accumulators — used when stream_event arrives without
	 * content_block_start/delta/stop structure (legacy backends or plain deltas).
	 */
	private fallbackDeltaText = "";
	private fallbackDeltaThinking = "";
	/** Whether we've seen at least one content_block_start event. */
	private hasBlockStructure = false;

	private lineCount = 0;

	addLine(line: string): void {
		this.lineCount++;
		try {
			const value = JSON.parse(line) as Record<string, unknown>;
			const type = value.type as string | undefined;

			// ------------------------------------------------------------------
			// Stream events (Claude API streaming)
			// ------------------------------------------------------------------
			if (type === "stream_event") {
				this.handleStreamEvent(value);
				return;
			}

			// ------------------------------------------------------------------
			// Tool progress (Claude SDK)
			// ------------------------------------------------------------------
			if (type === "tool_progress") {
				this.handleToolProgress(value);
				return;
			}

			// ------------------------------------------------------------------
			// Full assistant message — store and reset blocks
			// ------------------------------------------------------------------
			if (type === "assistant") {
				this.finalizeBlocks();
				this.collectedMessages.push(
					this.jsonToMessage(line, value, "assistant"),
				);
				return;
			}

			// User message (tool results) — store for rendering
			if (type === "user") {
				this.collectedMessages.push(this.jsonToMessage(line, value, "user"));
				return;
			}

			// Result message — store so the adapter can render duration/cost
			if (type === "result") {
				this.collectedMessages.push(
					this.jsonToMessage(line, value, "assistant"),
				);
				return;
			}

			// Error message — store so the adapter can render error label
			if (type === "error") {
				this.collectedMessages.push(this.jsonToMessage(line, value, "error"));
				return;
			}

			// Codex: item.completed with agent_message or command_execution
			if (type === "item.completed") {
				this.handleCodexItemCompleted(line, value);
				return;
			}

			// Codex: turn.completed — capture usage summary
			if (type === "turn.completed") {
				this.collectedMessages.push(
					this.jsonToMessage(line, value, "assistant"),
				);
				return;
			}

			// System messages (task_started etc.) — skip, adapter filters them anyway
		} catch {
			// ignore non-JSON lines
		}
	}

	// ------------------------------------------------------------------
	// Stream event handling
	// ------------------------------------------------------------------

	private handleStreamEvent(value: Record<string, unknown>): void {
		const event = value.event as Record<string, unknown> | undefined;
		if (!event) return;

		const eventType = event.type as string | undefined;

		// Structured block events (content_block_start/delta/stop)
		if (eventType === "content_block_start") {
			this.hasBlockStructure = true;
			this.handleBlockStart(event);
			return;
		}

		if (eventType === "content_block_delta") {
			if (this.hasBlockStructure) {
				this.handleBlockDelta(event);
			} else {
				// Fallback: plain delta without block structure
				this.handleLegacyDelta(event);
			}
			return;
		}

		if (eventType === "content_block_stop") {
			this.handleBlockStop(event);
			return;
		}

		// Legacy/simple delta format (no eventType, just delta object)
		const delta = event.delta as Record<string, unknown> | undefined;
		if (delta && !eventType) {
			if (typeof delta.text === "string") {
				if (this.hasBlockStructure) {
					this.appendToLastTextBlock(delta.text as string);
				} else {
					this.fallbackDeltaText += delta.text;
				}
			}
			if (typeof delta.thinking === "string") {
				if (this.hasBlockStructure) {
					this.appendToLastThinkingBlock(delta.thinking as string);
				} else {
					this.fallbackDeltaThinking += delta.thinking;
				}
			}
		}
	}

	private handleBlockStart(event: Record<string, unknown>): void {
		const index = event.index as number;
		const contentBlock = event.content_block as Record<string, unknown>;
		if (!contentBlock) return;
		const blockType = contentBlock.type as string;

		if (blockType === "text") {
			this.blocks.set(index, {
				kind: "text",
				blockIndex: index,
				text: "",
			});
		} else if (blockType === "thinking") {
			this.blocks.set(index, {
				kind: "thinking",
				blockIndex: index,
				text: "",
			});
		} else if (blockType === "tool_use") {
			this.blocks.set(index, {
				kind: "tool_use",
				blockIndex: index,
				toolUseId: String(contentBlock.id ?? ""),
				toolName: String(contentBlock.name ?? "unknown"),
				inputJsonText: "",
				parsedInput: null,
				status: "pending",
			});
		}
	}

	private handleBlockDelta(event: Record<string, unknown>): void {
		const index = event.index as number;
		const delta = event.delta as Record<string, unknown>;
		if (!delta) return;
		const block = this.blocks.get(index);
		if (!block) return;

		const deltaType = delta.type as string | undefined;

		if (block.kind === "text" && deltaType === "text_delta") {
			block.text += delta.text as string;
		} else if (block.kind === "thinking" && deltaType === "thinking_delta") {
			block.text += delta.thinking as string;
		} else if (block.kind === "tool_use" && deltaType === "input_json_delta") {
			block.inputJsonText += delta.partial_json as string;
			block.status = "streaming_input";
		}
	}

	private handleBlockStop(event: Record<string, unknown>): void {
		const index = event.index as number;
		const block = this.blocks.get(index);
		if (!block) return;

		if (block.kind === "tool_use") {
			// Try to parse the accumulated JSON
			if (block.inputJsonText) {
				try {
					block.parsedInput = JSON.parse(block.inputJsonText) as Record<
						string,
						unknown
					>;
				} catch {
					// Keep raw text — will be shown as argsText
				}
			}
			block.status = "running";
		}
	}

	private handleLegacyDelta(event: Record<string, unknown>): void {
		const delta = event.delta as Record<string, unknown> | undefined;
		if (!delta) return;
		if (typeof delta.text === "string") {
			this.fallbackDeltaText += delta.text;
		}
		if (typeof delta.thinking === "string") {
			this.fallbackDeltaThinking += delta.thinking;
		}
	}

	/** Append text to the last text block, or create one. */
	private appendToLastTextBlock(text: string): void {
		for (const block of [...this.blocks.values()].reverse()) {
			if (block.kind === "text") {
				block.text += text;
				return;
			}
		}
		// No text block exists — create one
		const idx = this.blocks.size;
		this.blocks.set(idx, { kind: "text", blockIndex: idx, text });
	}

	/** Append thinking to the last thinking block, or create one. */
	private appendToLastThinkingBlock(text: string): void {
		for (const block of [...this.blocks.values()].reverse()) {
			if (block.kind === "thinking") {
				block.text += text;
				return;
			}
		}
		const idx = this.blocks.size;
		this.blocks.set(idx, { kind: "thinking", blockIndex: idx, text });
	}

	// ------------------------------------------------------------------
	// Tool progress
	// ------------------------------------------------------------------

	private handleToolProgress(value: Record<string, unknown>): void {
		const toolUseId = value.tool_use_id as string | undefined;
		if (!toolUseId) return;
		for (const block of this.blocks.values()) {
			if (block.kind === "tool_use" && block.toolUseId === toolUseId) {
				block.status = "running";
				break;
			}
		}
	}

	// ------------------------------------------------------------------
	// Codex: item.completed
	// ------------------------------------------------------------------

	private handleCodexItemCompleted(
		line: string,
		value: Record<string, unknown>,
	): void {
		const item = value.item as Record<string, unknown> | undefined;
		if (!item) return;

		if (item.type === "agent_message" && typeof item.text === "string") {
			// Accumulate text for partial display
			this.fallbackDeltaText += `${item.text}\n\n`;
			this.collectedMessages.push(this.jsonToMessage(line, value, "assistant"));
			return;
		}

		if (item.type === "command_execution") {
			// Synthesize tool_use("Bash") + tool_result so it renders
			// through the same pipeline as Claude tool calls
			const command = (item.command as string) ?? "";
			const output = (item.output as string) ?? "";
			const exitCode = (item.exit_code as number) ?? 0;
			const syntheticId = `codex-cmd-${this.lineCount}`;

			const syntheticAssistant = {
				type: "assistant",
				message: {
					type: "message",
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: syntheticId,
							name: "Bash",
							input: { command },
						},
					],
				},
			};
			this.collectedMessages.push(
				this.jsonToMessage(
					JSON.stringify(syntheticAssistant),
					syntheticAssistant,
					"assistant",
				),
			);

			const resultContent =
				exitCode === 0 ? output : `Exit code: ${exitCode}\n${output}`;
			const syntheticResult = {
				type: "user",
				message: {
					content: [
						{
							type: "tool_result",
							tool_use_id: syntheticId,
							content: resultContent,
						},
					],
				},
			};
			this.collectedMessages.push(
				this.jsonToMessage(
					JSON.stringify(syntheticResult),
					syntheticResult,
					"user",
				),
			);
		}
	}

	// ------------------------------------------------------------------
	// Block finalization
	// ------------------------------------------------------------------

	/** Clear blocks when a full assistant message arrives (it supersedes them). */
	private finalizeBlocks(): void {
		this.blocks.clear();
		this.hasBlockStructure = false;
		this.fallbackDeltaText = "";
		this.fallbackDeltaThinking = "";
	}

	// ------------------------------------------------------------------
	// Public API (signatures unchanged)
	// ------------------------------------------------------------------

	/**
	 * Returns all collected messages plus a trailing partial message
	 * from accumulated blocks/deltas (if any new content since last full message).
	 */
	toMessages(
		contextKey: string,
		sessionId: string,
		assistantMessageId?: string,
	): SessionMessageRecord[] {
		const messages = [...this.collectedMessages];
		const partialId = assistantMessageId ?? `${contextKey}:stream-partial`;

		// Prefer block-level partial if we have structured blocks
		if (this.blocks.size > 0) {
			messages.push(
				this.buildPartialFromBlocks(contextKey, sessionId, partialId),
			);
			return messages;
		}

		// Fallback: flat delta accumulation
		const trimmedText = this.fallbackDeltaText.trim();
		const trimmedThinking = this.fallbackDeltaThinking.trim();
		if (trimmedText || trimmedThinking) {
			messages.push(
				this.buildPartialMessage(
					contextKey,
					sessionId,
					trimmedText,
					trimmedThinking,
					partialId,
				),
			);
		}

		return messages;
	}

	/** Legacy single-message API — returns just a partial for backward compat. */
	toPartialMessage(
		contextKey: string,
		sessionId: string,
		assistantMessageId?: string,
	): SessionMessageRecord {
		const messages = this.toMessages(contextKey, sessionId, assistantMessageId);
		return (
			messages[messages.length - 1] ??
			this.buildPartialMessage(
				contextKey,
				sessionId,
				"...",
				"",
				assistantMessageId ?? `${contextKey}:stream-partial`,
			)
		);
	}

	// ------------------------------------------------------------------
	// Partial message builders
	// ------------------------------------------------------------------

	/**
	 * Build a partial message from structured blocks.
	 * Produces Claude API content format so parseAssistantParts can parse it.
	 */
	private buildPartialFromBlocks(
		_contextKey: string,
		sessionId: string,
		partialId: string,
	): SessionMessageRecord {
		const sortedBlocks = [...this.blocks.values()].sort(
			(a, b) => a.blockIndex - b.blockIndex,
		);

		const contentBlocks: Record<string, unknown>[] = [];
		for (const block of sortedBlocks) {
			if (block.kind === "text") {
				contentBlocks.push({ type: "text", text: block.text || "..." });
			} else if (block.kind === "thinking") {
				if (block.text) {
					contentBlocks.push({ type: "thinking", thinking: block.text });
				}
			} else if (block.kind === "tool_use") {
				contentBlocks.push({
					type: "tool_use",
					id: block.toolUseId,
					name: block.toolName,
					input: block.parsedInput ?? {},
					// Metadata for downstream: streaming status + raw JSON text
					__streaming_status: block.status,
					__input_json_text: block.inputJsonText,
				});
			}
		}

		// Must have at least one content block
		if (contentBlocks.length === 0) {
			contentBlocks.push({ type: "text", text: "..." });
		}

		const parsed = {
			type: "assistant",
			message: {
				type: "message",
				role: "assistant",
				content: contentBlocks,
			},
			__streaming: true,
		};

		return {
			id: partialId,
			sessionId,
			role: "assistant",
			content: JSON.stringify(parsed),
			contentIsJson: true,
			parsedContent: parsed,
			createdAt: new Date().toISOString(),
			sentAt: null,
			cancelledAt: null,
			model: null,
			sdkMessageId: null,
			lastAssistantMessageId: null,
			turnId: null,
			isResumableMessage: null,
			attachmentCount: 0,
		};
	}

	/** Flat partial message (legacy fallback). */
	private buildPartialMessage(
		_contextKey: string,
		sessionId: string,
		text: string,
		thinking: string,
		partialId: string,
	): SessionMessageRecord {
		const displayText = text || "...";

		if (thinking) {
			const parsed = {
				type: "assistant",
				message: {
					type: "message",
					role: "assistant",
					content: [
						{ type: "thinking", thinking },
						{ type: "text", text: displayText },
					],
				},
			};
			return {
				id: partialId,
				sessionId,
				role: "assistant",
				content: JSON.stringify(parsed),
				contentIsJson: true,
				parsedContent: parsed,
				createdAt: new Date().toISOString(),
				sentAt: null,
				cancelledAt: null,
				model: null,
				sdkMessageId: null,
				lastAssistantMessageId: null,
				turnId: null,
				isResumableMessage: null,
				attachmentCount: 0,
			};
		}

		return {
			id: partialId,
			sessionId,
			role: "assistant",
			content: displayText,
			contentIsJson: false,
			createdAt: new Date().toISOString(),
			sentAt: null,
			cancelledAt: null,
			model: null,
			sdkMessageId: null,
			lastAssistantMessageId: null,
			turnId: null,
			isResumableMessage: null,
			attachmentCount: 0,
		};
	}

	// ------------------------------------------------------------------
	// Helpers
	// ------------------------------------------------------------------

	private jsonToMessage(
		raw: string,
		_parsed: Record<string, unknown>,
		role: string,
	): SessionMessageRecord {
		const parsed = _parsed;
		return {
			id: `stream:${this.lineCount}:${role}`,
			sessionId: "",
			role,
			content: raw,
			contentIsJson: true,
			parsedContent: parsed,
			createdAt: new Date().toISOString(),
			sentAt: null,
			cancelledAt: null,
			model: null,
			sdkMessageId: null,
			lastAssistantMessageId: null,
			turnId: null,
			isResumableMessage: null,
			attachmentCount: 0,
		};
	}
}
