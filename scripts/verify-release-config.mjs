import fs from "node:fs";
import path from "node:path";

function fail(message) {
	console.error(message);
	process.exit(1);
}

const root = process.cwd();
const packageJson = JSON.parse(
	fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const tauriConfig = JSON.parse(
	fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"),
);
const cargoToml = fs.readFileSync(
	path.join(root, "src-tauri", "Cargo.toml"),
	"utf8",
);

const cargoVersionMatch = cargoToml.match(/^version = "(.*)"$/m);
if (!cargoVersionMatch) {
	fail("Unable to find version in src-tauri/Cargo.toml");
}

const versions = {
	package: packageJson.version,
	cargo: cargoVersionMatch[1],
	tauri: tauriConfig.version,
};

if (new Set(Object.values(versions)).size !== 1) {
	fail(
		`Release versions are out of sync: package=${versions.package}, cargo=${versions.cargo}, tauri=${versions.tauri}`,
	);
}

console.log(`Release configuration verified for version ${versions.package}`);
