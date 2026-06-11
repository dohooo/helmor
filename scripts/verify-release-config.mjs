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

// Guard the macOS updater release contract. `bundle.createUpdaterArtifacts`
// is what tells Tauri to emit the signed `.app.tar.gz` + signature that
// publish.yml feeds into `latest.json` and updater-dry-run.yml validates;
// shipped macOS users' in-app auto-update depends on it. It is a shared,
// top-level flag — a platform that does not want updater artifacts (e.g. a
// Windows NSIS bundle) must opt out inside its own `bundle.<os>` block rather
// than flipping this global off, which would silently break macOS releases.
if (tauriConfig.bundle?.createUpdaterArtifacts !== true) {
	fail(
		"src-tauri/tauri.conf.json: bundle.createUpdaterArtifacts must be `true`. " +
			"The macOS release + auto-update pipeline depends on signed updater artifacts; " +
			"disable updater artifacts per-bundle (bundle.<os>), never via this global flag.",
	);
}

console.log(`Release configuration verified for version ${versions.package}`);
