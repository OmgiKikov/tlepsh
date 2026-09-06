import { execFile, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const templates = fileURLToPath(new URL("../templates/python-agent/", import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const input = (version: number) => [
	{ v: version, type: "hello", tools: [], model: {}, workspace: ".", world: null },
	{ v: version, type: "user", turn: 1, text: "first" },
	{ v: version, type: "user", turn: 2, text: "second" },
	{ v: version, type: "cancel" },
].map(frame => JSON.stringify(frame)).join("\n") + "\n";

function functionRun(source: string, version = 2, wireVersion = version) {
	const root = mkdtempSync(join(tmpdir(), "ahde-python-function-"));
	roots.push(root);
	cpSync(join(templates, "function_bridge.py"), join(root, "function_bridge.py"));
	writeFileSync(join(root, "customer.py"), source);
	const result = spawnSync("python3", ["function_bridge.py", "customer:respond"], {
		cwd: root, encoding: "utf8", timeout: 10_000,
		env: { ...process.env, AHDE_PROTOCOL: String(version), PYTHONDONTWRITEBYTECODE: "1" }, input: input(wireVersion),
	});
	expect(result.error).toBeUndefined();
	expect(readFileSync(join(root, "customer.py"), "utf8")).toBe(source);
	return { ...result, frames: result.stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) };
}

describe("packaged Python function bridge", () => {
	it.each([1, 2])("runs the original function for both turns under protocol %i without inventing usage", version => {
		const result = functionRun('print("import diagnostic")\ncount = 0\ndef respond(text):\n    global count\n    count += 1\n    print("call diagnostic")\n    return f"{text}:{count}"\n', version);
		expect(result.status).toBe(0);
		expect(result.frames).toEqual([
			{ v: version, type: "assistant", turn: 1, text: "first:1" },
			{ v: version, type: "assistant", turn: 2, text: "second:2" },
		]);
		expect(result.stderr).toContain("import diagnostic");
		expect(result.stderr).toContain("call diagnostic");
	});
	it("preserves one event loop for an async client's repeated turns", () => {
		const result = functionRun('import asyncio\nclient_loop = None\nasync def respond(text):\n    global client_loop\n    loop = asyncio.get_running_loop()\n    if client_loop is not None and client_loop is not loop:\n        raise RuntimeError("client loop changed")\n    client_loop = loop\n    await asyncio.sleep(0)\n    return text\n');
		expect(result.status).toBe(0);
		expect(result.frames.map(frame => frame.text)).toEqual(["first", "second"]);
	});
	it.each([
		["def respond(text):\n    raise RuntimeError('provider unavailable')\n", "provider unavailable"],
		["def respond(text):\n    return {'output': text}\n", "must return a string"],
		["def respond(text, required):\n    return text\n", "required"],
	])("reports execution failures as errors, never answers (%s)", (source, expected) => {
		const result = functionRun(source);
		expect(result.status).toBe(1);
		expect(result.frames).toHaveLength(1);
		expect(result.frames[0]).toMatchObject({ v: 2, type: "error", message: expect.stringContaining(expected) });
	});
	it("rejects a mixed protocol before invoking the function", () => {
		const result = functionRun('def respond(text):\n    print("FUNCTION CALLED")\n    return text\n', 2, 1);
		expect(result.status).toBe(1);
		expect(result.stderr).not.toContain("FUNCTION CALLED");
		expect(result.frames[0]).toMatchObject({ v: 2, type: "error", message: expect.stringContaining("version") });
	});
});

describe("packaged Python HTTP bridge", () => {
	it.each([1, 2])("uses the selected protocol %i with an actual local HTTP service", async version => {
		const requests: unknown[] = [];
		const server = createServer((request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				const body = JSON.parse(Buffer.concat(chunks).toString());
				requests.push(body);
				response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ output: `reply:${body.input}` }));
			});
		});
		await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("missing HTTP port");
		try {
			const output = await new Promise<{ stdout: string; stderr: string }>((done, reject) => {
				const child = execFile("python3", [join(templates, "http_bridge.py")], {
					env: { ...process.env, AHDE_PROTOCOL: String(version), AHDE_BRIDGE_URL: `http://127.0.0.1:${address.port}` }, timeout: 10_000,
				}, (error, stdout, stderr) => error ? reject(error) : done({ stdout, stderr }));
				child.stdin!.end(input(version));
			});
			expect(requests).toEqual([{ input: "first" }, { input: "second" }]);
			expect(output.stdout.trim().split("\n").map(line => JSON.parse(line))).toEqual([
				{ v: version, type: "assistant", turn: 1, text: "reply:first" },
				{ v: version, type: "assistant", turn: 2, text: "reply:second" },
			]);
		} finally { await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); }
	});
	it("reports a missing endpoint in the selected version", () => {
		const result = spawnSync("python3", [join(templates, "http_bridge.py")], {
			env: { ...process.env, AHDE_PROTOCOL: "2", AHDE_BRIDGE_URL: "" }, encoding: "utf8", timeout: 10_000,
		});
		expect(result.status).toBe(1);
		expect(JSON.parse(result.stdout)).toMatchObject({ v: 2, type: "error" });
	});
});
