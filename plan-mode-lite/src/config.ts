/**
 * Configuration for the plan-mode extension.
 *
 * Loaded from ~/.pi/agent/plan-mode-lite.json. If that file does not exist, the
 * legacy ~/.pi/agent/pi-plan-mode-lite.json (from @narumitw/pi-plan-mode) is read
 * as a migration fallback so existing toggleShortcut / safeSubcommands keep
 * working.
 *
 * The configuration directory defaults to ~/.pi/agent and can be overridden
 * with the PLAN_MODE_CONFIG_DIR environment variable (used by tests).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SafeSubcommands } from "./bash-policy.ts";

export interface PlanModeConfig {
	/** Enter plan mode automatically at session start. Default: true. */
	defaultOn: boolean;
	/** Keyboard shortcut used to toggle plan mode. Default: "ctrl+tab". */
	toggleShortcut: string;
	/** Extra read-only subcommands to allow, e.g. { "kubectl": ["get", "describe"] }. */
	safeSubcommands: SafeSubcommands;
}

export const DEFAULT_CONFIG: PlanModeConfig = {
	defaultOn: true,
	toggleShortcut: "ctrl+tab",
	safeSubcommands: {},
};

export const PLAN_COMMANDS = ["on", "off", "status", "default-on", "default-off"] as const;

function configDir(): string {
	return process.env.PLAN_MODE_CONFIG_DIR ?? join(homedir(), ".pi", "agent");
}

function stringRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readConfigFile(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return stringRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export function configPath(): string {
	return join(configDir(), "plan-mode-lite.json");
}

export function loadConfig(): PlanModeConfig {
	const dir = configDir();
	const own = readConfigFile(join(dir, "plan-mode-lite.json"));
	const legacy = own ? undefined : readConfigFile(join(dir, "pi-plan-mode-lite.json"));
	const raw = own ?? legacy ?? {};
	const safeSubcommands: SafeSubcommands = {};
	if (stringRecord(raw.safeSubcommands)) {
		for (const [command, subcommands] of Object.entries(raw.safeSubcommands)) {
			if (Array.isArray(subcommands) && subcommands.every((s) => typeof s === "string")) {
				safeSubcommands[command] = subcommands.map((s) => s.trim()).filter((s) => s.length > 0);
			}
		}
	}
	return {
		defaultOn: typeof raw.defaultOn === "boolean" ? raw.defaultOn : DEFAULT_CONFIG.defaultOn,
		toggleShortcut:
			typeof raw.toggleShortcut === "string" && raw.toggleShortcut.trim()
				? raw.toggleShortcut.trim()
				: DEFAULT_CONFIG.toggleShortcut,
		safeSubcommands,
	};
}

/** Persist `defaultOn` to the plan-mode-lite.json config file (used by /plan default-on|off). */
export function saveDefaultOn(defaultOn: boolean): boolean {
	try {
		const path = configPath();
		const raw = readConfigFile(path) ?? {};
		const next = { ...raw, defaultOn };
		mkdirSync(configDir(), { recursive: true });
		writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
		return true;
	} catch {
		return false;
	}
}
