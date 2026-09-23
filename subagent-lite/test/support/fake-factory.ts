/**
 * Scriptable fake child-session factory for tests. Implements the structural
 * ChildSession/ChildSessionFactory contracts without loading the real pi
 * package.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ChildSession, ChildSessionEvent, ChildSessionFactory, ChildSessionLaunch } from "../../src/session.ts";

export interface FakeSessionScript {
	sessionId?: string;
	modelId?: string;
	/** Events emitted (in order) once prompt() is called, before it settles. */
	events?: ChildSessionEvent[];
	/** When true, prompt() never settles until abort() is called or release() is invoked. */
	hang?: boolean;
	/** When true, abort() settles a hung prompt (like a responsive real session). */
	abortResolvesPrompt?: boolean;
	/** prompt() throws/rejects with this error. */
	promptError?: Error;
	/** Message count reported before the prompt runs (the baseline). */
	baselineMessageCount?: number;
	/** Small delay before emitting events and settling the prompt. */
	delayMs?: number;
}

export class FakeChildSession implements ChildSession {
	readonly script: FakeSessionScript;
	readonly listeners = new Set<(event: ChildSessionEvent) => void>();
	#disposed = false;
	#aborted = false;
	#prompted: string | undefined;
	#release: (() => void) | undefined;

	constructor(script: FakeSessionScript) {
		this.script = script;
	}

	get sessionId(): string {
		return this.script.sessionId ?? "fake-child-session";
	}

	get modelId(): string | undefined {
		return this.script.modelId;
	}

	get messages(): readonly AgentMessage[] {
		return Array.from({ length: this.script.baselineMessageCount ?? 0 }) as AgentMessage[];
	}

	get prompted(): string | undefined {
		return this.#prompted;
	}

	get disposed(): boolean {
		return this.#disposed;
	}

	get aborted(): boolean {
		return this.#aborted;
	}

	/** Resolve a hung prompt without going through abort(). */
	release(): void {
		this.#release?.();
	}

	subscribe(listener: (event: ChildSessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: ChildSessionEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	async prompt(text: string): Promise<void> {
		this.#prompted = text;
		if (this.script.delayMs) await new Promise((resolve) => setTimeout(resolve, this.script.delayMs));
		for (const event of this.script.events ?? []) this.emit(event);
		if (this.script.hang) {
			await new Promise<void>((resolve) => {
				this.#release = resolve;
			});
			return;
		}
		if (this.script.promptError) throw this.script.promptError;
	}

	async abort(): Promise<void> {
		this.#aborted = true;
		if (this.script.abortResolvesPrompt !== false) this.#release?.();
	}

	async dispose(): Promise<void> {
		this.#disposed = true;
	}
}

export interface FakeFactoryHandle extends ChildSessionFactory {
	readonly created: FakeChildSession[];
	readonly launches: ChildSessionLaunch[];
	/** Rejects the next create() call with this error. */
	failNextCreate(error: Error): void;
}

/** A factory whose create() returns sessions scripted per launch (scripts cycle). */
export function createFakeFactory(scripts: FakeSessionScript | FakeSessionScript[]): FakeFactoryHandle {
	const scriptList = Array.isArray(scripts) ? scripts : [scripts];
	const created: FakeChildSession[] = [];
	const launches: ChildSessionLaunch[] = [];
	let callIndex = 0;
	let failure: Error | undefined;
	const factory: FakeFactoryHandle = {
		get created() {
			return created;
		},
		get launches() {
			return launches;
		},
		failNextCreate(error: Error) {
			failure = error;
		},
		async create(launch: ChildSessionLaunch): Promise<ChildSession> {
			launches.push(launch);
			if (failure) throw failure;
			const script = scriptList[Math.min(callIndex, scriptList.length - 1)]!;
			callIndex++;
			const session = new FakeChildSession(script);
			created.push(session);
			return session;
		},
		async dispose(): Promise<void> {
			await Promise.allSettled(created.map((session) => session.dispose()));
		},
	};
	return factory;
}
