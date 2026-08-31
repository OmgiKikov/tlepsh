import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { workbenchStateDirectory } from "../workbench/focus.js";

/**
 * One operator, one project, one server. Two `ahde serve` processes over the
 * same project would drive the same durable Workbench state through two
 * independent confirmation queues, so the second one fails closed unless the
 * operator says otherwise with `--allow-concurrent`.
 */

const LOCK_FILE = "serve.lock";

export interface ServeSessionLockRecord {
	pid: number;
	startedAt: string;
	host: string;
	port: number;
}

export interface ServeSessionLock {
	path: string;
	release(): void;
}

export class ServeSessionConflictError extends Error {
	readonly name = "ServeSessionConflictError";
	readonly holder: ServeSessionLockRecord | null;

	constructor(path: string, holder: ServeSessionLockRecord | null) {
		super(
			holder
				? `another ahde serve session (pid ${holder.pid}, started ${holder.startedAt}) already holds this project at ${path}; ` +
					"stop it or pass --allow-concurrent"
				: `another ahde serve session already holds this project at ${path}; stop it or pass --allow-concurrent`,
		);
		this.holder = holder;
	}
}

function readLock(path: string): ServeSessionLockRecord | null {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ServeSessionLockRecord>;
		if (typeof parsed.pid !== "number" || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0) return null;
		return {
			pid: parsed.pid,
			startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
			host: typeof parsed.host === "string" ? parsed.host : "",
			port: typeof parsed.port === "number" ? parsed.port : 0,
		};
	} catch {
		return null;
	}
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists and belongs to somebody else.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export interface AcquireServeSessionLockInput {
	stateRoot: string;
	projectId: string;
	host: string;
	port: number;
	now?: () => string;
}

/**
 * Take the project's serve lock, or throw with the holder named. A lock whose
 * process is gone is stale and is taken over once; anything else fails closed.
 */
export function acquireServeSessionLock(input: AcquireServeSessionLockInput): ServeSessionLock {
	const directory = workbenchStateDirectory(input.stateRoot, input.projectId, true);
	if (!directory) throw new Error("Workbench state root could not be created for the serve session lock");
	const path = join(directory, LOCK_FILE);
	const now = input.now ?? (() => new Date().toISOString());
	const record: ServeSessionLockRecord = {
		pid: process.pid,
		startedAt: now(),
		host: input.host,
		port: input.port,
	};

	const claim = (): boolean => {
		let handle: number;
		try {
			handle = openSync(path, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw error;
		}
		try {
			writeSync(handle, `${JSON.stringify(record)}\n`);
		} finally {
			closeSync(handle);
		}
		return true;
	};

	if (!claim()) {
		const holder = readLock(path);
		if (holder && processAlive(holder.pid)) throw new ServeSessionConflictError(path, holder);
		// Stale: the holder is gone. Take it over exactly once.
		rmSync(path, { force: true });
		if (!claim()) throw new ServeSessionConflictError(path, readLock(path));
	}

	let released = false;
	return {
		path,
		release(): void {
			if (released) return;
			released = true;
			const holder = readLock(path);
			// Never delete a lock a later session took over.
			if (holder && holder.pid !== process.pid) return;
			rmSync(path, { force: true });
		},
	};
}
