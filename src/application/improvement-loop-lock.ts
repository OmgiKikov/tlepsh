import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { z } from "zod";
import { resolveContainedArtifactPath } from "../storage/paths.js";

const OwnerSchema = z.strictObject({ pid: z.number().int().positive(), host: z.string().min(1), nonce: z.uuid() });
type Owner = z.infer<typeof OwnerSchema>;

function ownerAt(path: string): Owner {
	const entry = lstatSync(path);
	if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 1_024) throw new Error("invalid improvement loop ownership claim");
	return OwnerSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

function dead(owner: Owner): boolean {
	if (owner.host !== hostname()) return false;
	try { process.kill(owner.pid, 0); return false; }
	catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

function claim(path: string, owner: Owner): boolean {
	let fd: number;
	try { fd = openSync(path, "wx", 0o600); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
	try { writeSync(fd, `${JSON.stringify(owner)}\n`); }
	finally { closeSync(fd); }
	return true;
}

function releaseOwned(path: string, owner: Owner): void {
	try { if (ownerAt(path).nonce === owner.nonce) unlinkSync(path); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/** One process owns a loop's budget read/reserve/write sequence, including explicit resume. */
export function acquireImprovementLoopOwnership(runsRoot: string, loopId: string): () => void {
	if (!/^loop_[a-z0-9]{6,32}$/.test(loopId)) throw new Error("invalid improvement loop id");
	const path = resolveContainedArtifactPath(runsRoot, "loops", `${loopId}.lock`);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const owner: Owner = { pid: process.pid, host: hostname(), nonce: randomUUID() };
	if (!claim(path, owner)) {
		const stale = ownerAt(path);
		if (!dead(stale)) throw new Error(`improvement loop ${loopId} is already running in another invocation`);
		// Only one stale-owner recovery may unlink the old claim. Without this
		// second exclusive claim, two recoverers can unlink each other's fresh lock.
		const recoveryPath = `${path}.recover-${stale.nonce}`;
		if (!claim(recoveryPath, owner)) {
			throw new Error(`improvement loop ${loopId} ownership recovery is in progress or was interrupted; inspect ${recoveryPath} before retrying`);
		}
		try {
			const current = ownerAt(path);
			if (current.nonce !== stale.nonce || !dead(current)) throw new Error(`improvement loop ${loopId} ownership changed during recovery`);
			unlinkSync(path);
			if (!claim(path, owner)) throw new Error(`improvement loop ${loopId} was resumed by another invocation`);
		} finally { releaseOwned(recoveryPath, owner); }
	}
	return () => releaseOwned(path, owner);
}
