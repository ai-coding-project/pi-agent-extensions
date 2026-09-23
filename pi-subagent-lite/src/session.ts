/**
 * In-process child sessions.
 *
 * A child is a pi `AgentSession` created inside this (parent) process. This is
 * an adapted copy of the reference implementation's
 * `src/runs/shared/child-session.ts` with the detached-runner, herdr, and
 * required-extension machinery removed; the session-creation edge-case handling
 * (serial launches, extension cache reset, provider registration flush,
 * provider inheritance, graceful shutdown) is kept.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "./utils.ts";

const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";

export interface ChildSessionEvent {
	type: string;
	[key: string]: unknown;
}

export interface ChildSessionExtensionError {
	extensionPath: string;
	event: string;
	error: unknown;
}

export interface ChildHookExtension {
	name: string;
	factory: (pi: ExtensionAPI) => void;
}

export interface ChildSessionLaunch {
	cwd: string;
	/** Model reference as the agent config names it (`provider/id`, optionally `:thinking`). */
	model?: string;
	/** Explicit thinking level; wins over a suffix embedded in `model`. */
	thinkingLevel?: string;
	/** Explicit tool allowlist; undefined keeps pi's defaults. */
	tools?: string[];
	/** Discover the ambient extensions (agent dir, project, settings) the way a `pi` process would. */
	ambientExtensions: boolean;
	/** Inline extension hooks loaded into the child in addition to discovered extensions. */
	hooks: ChildHookExtension[];
	/** Replace (`systemPrompt`) or extend (`appendSystemPrompt`) the child's system prompt. */
	systemPrompt?: string;
	systemPromptMode?: "replace" | "append";
	/** Process-local provider source owned by the invoking parent (pi's `ctx.modelRegistry`). */
	parentProviderRegistry?: ParentProviderRegistry;
	onExtensionError?: (error: ChildSessionExtensionError) => void;
}

export interface ChildSession {
	subscribe(listener: (event: ChildSessionEvent) => void): () => void;
	/** Resolves when the run ends, including after abort. */
	prompt(text: string): Promise<void>;
	abort(): Promise<void>;
	/** Emits `session_shutdown` to the child's extensions and disposes the session; resolves once that shutdown work is done. */
	dispose(): Promise<void>;
	/** True while Pi still has queued input that has not started a turn. */
	hasQueuedMessages?(): boolean;
	readonly messages: readonly AgentMessage[];
	readonly sessionId: string;
	readonly modelId: string | undefined;
}

export function childSessionHasQueuedMessages(session: ChildSession | undefined): boolean {
	try {
		return session?.hasQueuedMessages?.() === true;
	} catch {
		return false;
	}
}

export interface ChildSessionFactory {
	create(launch: ChildSessionLaunch): Promise<ChildSession>;
	/** Abort and dispose every live child. */
	dispose(): Promise<void>;
}

export type PiCodingAgentModule = typeof import("@earendil-works/pi-coding-agent");

export interface DefaultChildSessionFactoryOptions {
	/**
	 * Loads the pi package the sessions are created from. The default resolves
	 * the running host package by absolute path so a child cannot resolve an
	 * extension-owned copy.
	 */
	loadPiCodingAgent?: () => Promise<PiCodingAgentModule>;
	/** Upper bound on a disposed child's `session_shutdown` handlers before the session is dropped anyway. */
	shutdownTimeoutMs?: number;
}

type ModelRuntimeInstance = Awaited<ReturnType<PiCodingAgentModule["ModelRuntime"]["create"]>>;

export type ParentProviderRegistry = Pick<ModelRuntimeInstance, "getRegisteredProviderIds" | "getRegisteredProviderConfig" | "getRegisteredNativeProvider">;

// ---------------------------------------------------------------------------
// Host package resolution (copied from the reference pi-spawn.ts + child-session.ts)
// ---------------------------------------------------------------------------

function findPiPackageRootFromEntry(entryPoint: string): string | undefined {
	let dir = path.dirname(entryPoint);
	while (dir !== path.dirname(dir)) {
		const packageJsonPath = path.join(dir, "package.json");
		if (fs.existsSync(packageJsonPath)) {
			const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as { name?: unknown };
			if (pkg.name === PI_CODING_AGENT_PACKAGE) return dir;
		}
		dir = path.dirname(dir);
	}
	return undefined;
}

export function resolveInstalledPiPackageRoot(): string | undefined {
	try {
		return findPiPackageRootFromEntry(fileURLToPath(import.meta.resolve(PI_CODING_AGENT_PACKAGE)));
	} catch {
		return undefined;
	}
}

export function resolvePiPackageRoot(): string | undefined {
	try {
		const entry = process.argv[1];
		return entry ? findPiPackageRootFromEntry(fs.realpathSync(entry)) : undefined;
	} catch {
		// process.argv[1] probing is best-effort; callers can fall back to package resolution.
		return undefined;
	}
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveHostPackageEntry(root: string): string {
	const packageJsonPath = path.join(root, "package.json");
	const source = fs.readFileSync(packageJsonPath, "utf8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch (error) {
		throw new Error(`invalid host SDK manifest at ${packageJsonPath}: malformed JSON`, { cause: error });
	}
	if (!isUnknownRecord(parsed)) throw new Error(`invalid host SDK manifest at ${packageJsonPath}: expected a JSON object`);
	const pkg = parsed;
	if (pkg.name !== PI_CODING_AGENT_PACKAGE) {
		throw new Error(`refusing to load the host SDK from ${root}: package.json name is "${String(pkg.name ?? "(none)")}", expected "${PI_CODING_AGENT_PACKAGE}"`);
	}
	// The host package's root export is its main entry; fall back to the manifest main field.
	const main = typeof pkg.main === "string" ? pkg.main : "dist/index.js";
	if (!fs.existsSync(path.join(root, main))) {
		throw new Error(`host SDK manifest at ${packageJsonPath} has no resolvable root entry (${main})`);
	}
	return path.join(root, main);
}

/**
 * Load the host-owned pi-coding-agent module by absolute package entry so a
 * child cannot resolve an extension-owned copy. Precedence is the running host
 * (argv-based), then the install tree; the bare specifier is used only when no
 * root resolves.
 */
export async function loadHostPiCodingAgent(): Promise<PiCodingAgentModule> {
	const root = resolvePiPackageRoot() ?? resolveInstalledPiPackageRoot();
	if (root) {
		const entry = fs.realpathSync(resolveHostPackageEntry(root));
		return import(pathToFileURL(entry).href);
	}
	return import(PI_CODING_AGENT_PACKAGE);
}

// ---------------------------------------------------------------------------
// Provider plumbing (copied from the reference child-session.ts)
// ---------------------------------------------------------------------------

function inheritParentProviders(modelRuntime: ModelRuntimeInstance, parentProviders: ParentProviderRegistry, claimedProviderIds: ReadonlySet<string>, onError: ((error: ChildSessionExtensionError) => void) | undefined): boolean {
	let providerIds: readonly string[];
	try {
		providerIds = parentProviders.getRegisteredProviderIds();
	} catch (error) {
		onError?.({ extensionPath: "<parent-providers>", event: "inherit_provider", error });
		throw new Error(`Failed to enumerate parent providers: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
	let registered = false;
	for (const providerId of new Set(providerIds)) {
		if (claimedProviderIds.has(providerId)) continue;
		try {
			const native = parentProviders.getRegisteredNativeProvider(providerId);
			const config = native ? undefined : parentProviders.getRegisteredProviderConfig(providerId);
			if (native) modelRuntime.registerNativeProvider(native);
			else if (config) modelRuntime.registerProvider(providerId, config);
			else throw new Error(`Parent provider '${providerId}' has no registered native provider or config.`);
			registered = true;
		} catch (error) {
			onError?.({ extensionPath: `<parent-provider:${providerId}>`, event: "inherit_provider", error });
			throw new Error(`Failed to inherit parent provider '${providerId}': ${error instanceof Error ? error.message : String(error)}`, { cause: error });
		}
	}
	return registered;
}

/** Flush provider registrations queued by the extensions the child just loaded. */
function flushQueuedProviderRegistrations(loader: InstanceType<PiCodingAgentModule["DefaultResourceLoader"]>, modelRuntime: ModelRuntimeInstance, onError: ((error: ChildSessionExtensionError) => void) | undefined): { claimedProviderIds: Set<string>; registered: boolean } {
	const claimedProviderIds = new Set<string>();
	if (!("getExtensions" in loader) || typeof loader.getExtensions !== "function") return { claimedProviderIds, registered: false };
	const { runtime } = loader.getExtensions();
	let registered = false;
	for (const { name, config, extensionPath } of runtime.pendingProviderRegistrations ?? []) {
		claimedProviderIds.add(name);
		try {
			modelRuntime.registerProvider(name, config);
			registered = true;
		} catch (error) {
			onError?.({ extensionPath, event: "register_provider", error });
		}
	}
	if (Array.isArray(runtime.pendingProviderRegistrations)) runtime.pendingProviderRegistrations = [];
	for (const { provider, extensionPath } of runtime.pendingNativeProviderRegistrations ?? []) {
		claimedProviderIds.add(provider.id);
		try {
			modelRuntime.registerNativeProvider(provider);
			registered = true;
		} catch (error) {
			onError?.({ extensionPath, event: "register_provider", error });
		}
	}
	if (Array.isArray(runtime.pendingNativeProviderRegistrations)) runtime.pendingNativeProviderRegistrations = [];
	return { claimedProviderIds, registered };
}

/**
 * pi caches extension factories per process and clears that cache only when a
 * loader reloads a second time, so every child in one process would share each
 * extension's module state. Marking the child's loader as already loaded makes
 * its first `reload()` clear the cache, so the child gets its own instances the
 * way a separate process had them. The flag is a private field of pi's loader.
 */
function resetExtensionCacheOnReload(loader: object): boolean {
	if (!("loaded" in loader)) return false;
	(loader as { loaded: boolean }).loaded = true;
	return true;
}

// ---------------------------------------------------------------------------
// Default factory
// ---------------------------------------------------------------------------

/** One launch at a time, so parallel launches never interleave loader state. */
let loading: Promise<unknown> = Promise.resolve();

export function createDefaultChildSessionFactory(options: DefaultChildSessionFactoryOptions = {}): ChildSessionFactory {
	const loadPiCodingAgent = options.loadPiCodingAgent ?? loadHostPiCodingAgent;
	const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
	const live = new Set<ChildSession>();
	/** Extension shutdowns still running for disposed children; `dispose()` waits for them. */
	const shutdowns = new Set<Promise<void>>();
	return {
		async create(launch) {
			const pi = await loadPiCodingAgent();
			// Each launch gets an isolated runtime: providers inherited from the
			// parent (and queued by the child's own extensions) are registered into
			// it without polluting sibling sessions.
			const modelRuntime = await pi.ModelRuntime.create();
			const agentDir = getAgentDir();
			const settingsManager = pi.SettingsManager.create(launch.cwd, agentDir);
			// Children share Pi's global theme with the parent; reinitializing it
			// would overwrite the parent's active appearance. Initialize only when
			// no theme exists yet (e.g. headless test processes).
			const themeKey = Symbol.for("@earendil-works/pi-coding-agent:theme");
			const themeInitialized = Boolean((globalThis as Record<symbol, unknown>)[themeKey]);
			if (!themeInitialized && typeof pi.initTheme === "function") pi.initTheme(settingsManager.getTheme());
			const appendSystemPrompt = launch.systemPrompt !== undefined && launch.systemPromptMode === "append" ? [launch.systemPrompt] : undefined;
			const replaceSystemPrompt = launch.systemPrompt !== undefined && launch.systemPromptMode !== "append" ? launch.systemPrompt : undefined;
			const loader = new pi.DefaultResourceLoader({
				cwd: launch.cwd,
				agentDir,
				settingsManager,
				noExtensions: !launch.ambientExtensions,
				noSkills: false,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: false,
				extensionFactories: launch.hooks,
				...(replaceSystemPrompt !== undefined ? { systemPrompt: replaceSystemPrompt } : {}),
				...(appendSystemPrompt !== undefined ? { appendSystemPrompt } : {}),
			});
			const open = async () => {
				if (!resetExtensionCacheOnReload(loader) && launch.ambientExtensions) {
					launch.onExtensionError?.({ extensionPath: "<loader>", event: "load", error: new Error("pi's extension cache reset is unavailable; extensions loaded into this child share module state with other sessions in this process.") });
				}
				await loader.reload();
				const queued = flushQueuedProviderRegistrations(loader, modelRuntime, launch.onExtensionError);
				const inherited = launch.parentProviderRegistry
					? inheritParentProviders(modelRuntime, launch.parentProviderRegistry, queued.claimedProviderIds, launch.onExtensionError)
					: false;
				if (queued.registered || inherited) {
					try {
						await modelRuntime.refresh({ allowNetwork: false });
					} catch (error) {
						launch.onExtensionError?.({ extensionPath: "<provider-refresh>", event: "refresh_providers", error });
						throw new Error(`Failed to refresh child providers: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
					}
				}
				const sessionManager = pi.SessionManager.inMemory(launch.cwd);
				const resolvedModel = launch.model
					? pi.resolveCliModel({
						cliModel: launch.model,
						...(launch.thinkingLevel ? { cliThinking: launch.thinkingLevel as ThinkingLevel } : {}),
						modelRuntime,
					})
					: undefined;
				if (resolvedModel?.error) throw new Error(resolvedModel.error);
				const model = resolvedModel?.model;
				if (model) {
					// The resolved model must be usable (auth configured), not merely known.
					const available = await modelRuntime.getAvailable();
					const fullId = `${model.provider}/${model.id}`;
					if (!available.some((candidate) => candidate.provider === model.provider && candidate.id === model.id)) {
						const examples = available.slice(0, 5).map((candidate) => `${candidate.provider}/${candidate.id}`).join(", ");
						throw new Error(`Model '${fullId}' is not available (no usable auth). Available models include: ${examples || "(none)"}.`);
					}
				}
				const thinkingLevel: ThinkingLevel | undefined = (launch.thinkingLevel as ThinkingLevel | undefined) ?? resolvedModel?.thinkingLevel;
				const { session } = await pi.createAgentSession({
					cwd: launch.cwd,
					agentDir,
					modelRuntime,
					...(model ? { model } : {}),
					...(thinkingLevel ? { thinkingLevel } : {}),
					...(launch.tools ? { tools: launch.tools } : {}),
					resourceLoader: loader,
					sessionManager,
					settingsManager,
					sessionStartEvent: { type: "session_start", reason: "startup" },
				});
				try {
					await session.bindExtensions({
						mode: "print",
						onError: (error) => launch.onExtensionError?.({ extensionPath: error.extensionPath, event: error.event, error: error.error }),
					});
				} catch (error) {
					session.dispose();
					throw error;
				}
				return session;
			};
			const opened = loading.catch(() => {}).then(open);
			loading = opened;
			const session = await opened;
			let pending: Promise<void> | undefined;
			// pi's own hosts emit `session_shutdown` before disposing a session so the
			// extensions loaded into it release their watchers, servers, and timers.
			const shutdown = async (): Promise<void> => {
				try {
					const runner = session.extensionRunner;
					if (runner.hasHandlers("session_shutdown")) {
						await Promise.race([runner.emit({ type: "session_shutdown", reason: "quit" }), new Promise<void>((resolve) => setTimeout(resolve, shutdownTimeoutMs).unref?.())]);
					}
				} catch (error) {
					launch.onExtensionError?.({ extensionPath: "<session>", event: "session_shutdown", error });
				} finally {
					session.dispose();
				}
			};
			const child: ChildSession = {
				subscribe: (listener) => session.subscribe((event) => listener(event as unknown as ChildSessionEvent)),
				prompt: (text) => session.prompt(text),
				abort: () => session.abort(),
				hasQueuedMessages: () => session.agent?.hasQueuedMessages?.() === true,
				dispose: () => {
					if (!pending) {
						live.delete(child);
						const shutdownDone = shutdown();
						pending = shutdownDone;
						shutdowns.add(shutdownDone);
						void shutdownDone.finally(() => shutdowns.delete(shutdownDone));
					}
					return pending;
				},
				get messages() { return session.messages; },
				get sessionId() { return session.sessionId; },
				get modelId() { return session.model ? `${session.model.provider}/${session.model.id}` : undefined; },
			};
			live.add(child);
			return child;
		},
		async dispose() {
			const children = [...live];
			await Promise.allSettled(children.map((child) => child.abort()));
			for (const child of children) {
				try { void child.dispose(); } catch { /* best effort */ }
			}
			await Promise.allSettled([...shutdowns]);
		},
	};
}

let activeFactory: ChildSessionFactory | undefined;

/** The process-wide factory all runs use unless a run passes its own. */
export function childSessionFactory(): ChildSessionFactory {
	activeFactory ??= createDefaultChildSessionFactory();
	return activeFactory;
}

/**
 * Replace the process-wide factory. Tests install a scripted factory; passing
 * undefined restores the default on next use.
 */
export function setChildSessionFactory(factory: ChildSessionFactory | undefined): void {
	activeFactory = factory;
}

/** Abort and dispose every live in-process child. */
export async function disposeChildSessions(): Promise<void> {
	const factory = activeFactory;
	if (!factory) return;
	await factory.dispose();
}
