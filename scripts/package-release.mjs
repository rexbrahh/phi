#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";

const root = process.cwd();
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
assert.equal(pkg.name, "phi");
assert.equal(pkg.version, "1.0.0");
assert.equal(pkg.private, true);
assert.equal(pkg.bin?.phi, "dist/src/cli.js");
assert.equal(lock.version, pkg.version);
assert.equal(lock.packages?.[""]?.version, pkg.version);

const packageName = `${pkg.name}-${pkg.version}`;
const releaseDir = join(root, "dist/release");
const archive = join(releaseDir, `${packageName}.tar.gz`);
const included = ["package.json", "package-lock.json", "README.md"];
const license = (await readdir(root)).find((name) => /^licen[cs]e(?:\.(?:md|txt))?$/iu.test(name));
if (license) included.push(license);

const staging = await mkdtemp(join(tmpdir(), "phi-release-"));
const packageRoot = join(staging, packageName);
try {
	await mkdir(packageRoot, { recursive: true });
	for (const file of included) await cp(join(root, file), join(packageRoot, file));
	await cp(join(root, "dist/src"), join(packageRoot, "dist/src"), { recursive: true });
	assert((await stat(join(packageRoot, "dist/src/cli.js"))).mode & 0o111);

	await mkdir(releaseDir, { recursive: true });
	execFileSync("tar", ["-czf", archive, "-C", staging, packageName], { stdio: "inherit" });
	const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
		.trim()
		.split("\n")
		.map((entry) => entry.replace(/\/$/u, ""));
	const expected = new Set([packageName]);
	expected.add(`${packageName}/dist`);
	for (const file of included) expected.add(`${packageName}/${file}`);
	const walk = async (directory) => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			const name = relative(packageRoot, path).split(sep).join("/");
			expected.add(`${packageName}/${name}`);
			if (entry.isDirectory()) await walk(path);
		}
	};
	await walk(join(packageRoot, "dist"));
	assert.deepEqual(entries.sort(), [...expected].sort(), "release archive contents differ from the package allowlist");

	const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
	const checksum = `${digest}  ${basename(archive)}\n`;
	await writeFile(join(releaseDir, "SHA256SUMS"), checksum);
	process.stdout.write(`${archive}\n${checksum}`);
} finally {
	await rm(staging, { recursive: true, force: true });
}
