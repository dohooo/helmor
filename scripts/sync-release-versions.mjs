import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const packageJsonPath = path.join(root, "package.json");
const cargoTomlPath = path.join(root, "src-tauri", "Cargo.toml");
const tauriConfigPath = path.join(root, "src-tauri", "tauri.conf.json");

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const version = packageJson.version;

if (!version) {
	throw new Error("package.json version is missing");
}

const cargoToml = fs.readFileSync(cargoTomlPath, "utf8");
const nextCargoToml = cargoToml.replace(
	/^version = ".*"$/m,
	`version = "${version}"`,
);

if (cargoToml === nextCargoToml) {
	console.log(`Cargo.toml already matches ${version}`);
} else {
	fs.writeFileSync(cargoTomlPath, nextCargoToml);
	console.log(`Updated src-tauri/Cargo.toml to ${version}`);
}

const tauriConfig = JSON.parse(fs.readFileSync(tauriConfigPath, "utf8"));
tauriConfig.version = version;
fs.writeFileSync(
	tauriConfigPath,
	`${JSON.stringify(tauriConfig, null, "\t")}\n`,
);
console.log(`Updated src-tauri/tauri.conf.json to ${version}`);
