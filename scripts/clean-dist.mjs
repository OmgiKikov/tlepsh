import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
if (manifest.name !== "ahde") throw new Error("refusing to clean dist outside the AHDE package root");

const output = resolve(packageRoot, "dist");
if (output === packageRoot || dirname(output) !== packageRoot || !output.endsWith("/dist")) {
	throw new Error(`refusing unsafe build output path: ${output}`);
}
if (existsSync(output)) rmSync(output, { recursive: true, force: true });
