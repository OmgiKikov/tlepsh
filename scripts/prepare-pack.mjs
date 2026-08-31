import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modulesRoot = join(packageRoot, "node_modules");
const hiddenInstallLock = join(modulesRoot, ".package-lock.json");

/**
 * npm's hidden install lock can retain optional packages for another CPU even
 * though npm correctly skipped their directories. npm pack then tries to scan
 * those missing directories while collecting bundled dependencies and exits
 * without a diagnostic. The hidden lock is only an install cache: removing it
 * makes pack rebuild the dependency inventory from the directories that are
 * actually present.
 */
function discardStaleHiddenInstallLock() {
	if (!existsSync(hiddenInstallLock)) return;
	let lock;
	try {
		lock = JSON.parse(readFileSync(hiddenInstallLock, "utf8"));
	} catch {
		// A corrupt cache is no more authoritative than a stale one.
		unlinkSync(hiddenInstallLock);
		return;
	}
	const packagePaths = lock && typeof lock === "object" && lock.packages && typeof lock.packages === "object"
		? Object.keys(lock.packages)
		: [];
	// package-lock paths always use forward slashes, including on Windows.
	const modulesPrefix = "node_modules/";
	const hasMissingInstalledPackage = packagePaths.some((packagePath) => {
		if (packagePath === "" || !packagePath.startsWith(modulesPrefix)) return false;
		const absolute = resolve(packageRoot, packagePath);
		if (absolute !== modulesRoot && !absolute.startsWith(`${modulesRoot}${sep}`)) return false;
		return !existsSync(absolute);
	});
	if (hasMissingInstalledPackage) unlinkSync(hiddenInstallLock);
}

discardStaleHiddenInstallLock();
