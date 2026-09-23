/**
 * Test helpers: fake pi host, fake ExtensionContext, and a registration
 * helper. No real pi package or network is involved.
 */
import { FakeChildSession, type FakeSessionScript } from "./fake-factory.ts";
import type { FakeFactoryHandle } from "./fake-factory.ts";
import type { ChildSessionEvent } from "../../src/session.ts";

export interface SentMessage {
	message: { customType: string; content: string; display?: boolean };
	options?: { triggerTurn?: boolean };
}

export interface FakePi {
	registerTool(tool: unknown): void;
	sendMessage(message: { customType: string; content: string; display?: boolean }, options?: { triggerTurn?: boolean }): unknown;
	on(event: string, handler: (event?: unknown, ctx?: unknown) => void | Promise<void>): void;
}

export interface FakeHost {
	pi: FakePi;
	registeredTools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown>; [key: string]: unknown }>;
	sent: SentMessage[];
	shutdownHandlers: Array<(event?: unknown, ctx?: unknown) => void | Promise<void>>;
}

export function createFakeHost(): FakeHost {
	const registeredTools: FakeHost["registeredTools"] = [];
	const sent: SentMessage[] = [];
	const shutdownHandlers: FakeHost["shutdownHandlers"] = [];
	const pi: FakePi = {
		registerTool: (tool) => {
			registeredTools.push(tool as FakeHost["registeredTools"][number]);
		},
		sendMessage: (message, options) => {
			sent.push({ message, options });
		},
		on: (event, handler) => {
			if (event === "session_shutdown") shutdownHandlers.push(handler);
		},
	};
	return { pi, registeredTools, sent, shutdownHandlers };
}

export interface FakeToolContextOverrides {
	cwd?: string;
	sessionId?: string;
	model?: { provider: string; id: string } | undefined;
	thinkingLevel?: string;
	signal?: AbortSignal;
	modelRegistry?: unknown;
}

/** Structural ExtensionContext sufficient for the subagent-lite tool. */
export function createFakeContext(overrides: FakeToolContextOverrides = {}): Record<string, unknown> {
	return {
		cwd: overrides.cwd ?? "/tmp",
		model: overrides.model,
		thinkingLevel: overrides.thinkingLevel,
		sessionManager: {
			getSessionId: () => overrides.sessionId ?? "parent-session-id",
		},
		modelRegistry: overrides.modelRegistry ?? {},
		signal: overrides.signal,
		isIdle: () => true,
	};
}

export interface ToolCallResult {
	text: string;
	isError: boolean;
}

/** Extract the text output from a tool execute() result. */
export function resultText(result: unknown): ToolCallResult {
	const typed = result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
	const text = (typed.content ?? []).map((part) => part.text ?? "").join("\n");
	return { text, isError: typed.isError === true };
}

/** Assistant terminal message with text content. */
export function assistantText(text: string): { role: string; content: Array<{ type: string; text: string }>; stopReason: string; usage: Record<string, number> } {
	return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage: { input: 10, output: 5 } };
}

/** Events for a child run that answers with a single assistant message. */
export function completionEvents(text: string, errorMessage?: string): ChildSessionEvent[] {
	return [
		{ type: "turn_start" },
		{ type: "message_end", message: assistantText(text) },
		{ type: "agent_end" },
		{ type: "agent_settled" },
		...(errorMessage ? [{ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage } }] : []),
	];
}

export type { FakeChildSession, FakeSessionScript, FakeFactoryHandle };
