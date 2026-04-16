import fs from "node:fs";
import path from "node:path";

const requestedVersion = process.argv.slice(2).find((arg) => arg !== "--");
const packageJson = JSON.parse(
	fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
);
const version = requestedVersion ?? packageJson.version;
const changelogPath = path.join(process.cwd(), "CHANGELOG.md");

if (!fs.existsSync(changelogPath)) {
	console.log("See CHANGELOG.md for release details.");
	process.exit(0);
}

const changelog = fs.readFileSync(changelogPath, "utf8");
const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sectionPattern = new RegExp(
	`^##\\s+${escapedVersion}\\b[\\s\\S]*?(?=^##\\s+|\\Z)`,
	"m",
);
const match = changelog.match(sectionPattern);

if (!match) {
	console.log("See CHANGELOG.md for release details.");
	process.exit(0);
}

const lines = match[0].trim().split("\n");
lines.shift();
const body = lines.join("\n").trim();
console.log(body || "See CHANGELOG.md for release details.");
