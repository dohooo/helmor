// Helmor Team Cloud Sandbox — control-plane model catalog cache (WP5 / D2).
//
// The composer's model list (`list_agent_model_sections`) is CATALOG METADATA
// (section labels, model ids, status) — it must not require a container wake.
// The Worker answers it from this D1 cache BEFORE `ensureServe`, so with the
// container asleep the composer is usable and the team-readiness probe gets a
// millisecond answer; only a real @agent send (`/rpc-stream/*`) wakes the box.
//
// Cache discipline (no TTL):
//   - write-through on every LIVE pass of the RPC (cache miss → proxy → store),
//   - refresh on every container cold start (`ensureServe` reports it; the
//     Worker re-pulls the catalog in the background), so an image update is
//     picked up on the first real wake after it.
// Payload is metadata ONLY — never credentials (identity tokens live in the
// broker DOs and are validated out here by requiring a plain JSON array).

export const MODEL_CATALOG_RPC = "/rpc/list_agent_model_sections";
export const MODEL_CATALOG_HEADER = "x-helmor-model-catalog";

/** Validate a candidate cache payload: the RPC returns a JSON ARRAY of
 *  `AgentModelSection` objects. Anything else (error envelopes, partial JSON)
 *  is rejected so garbage never becomes the durable catalog. Returns the
 *  verbatim text on success (stored as-is; the desktop parses it). */
export function parseModelCatalogPayload(text: string): string | null {
	try {
		const parsed: unknown = JSON.parse(text);
		if (!Array.isArray(parsed)) return null;
		if (!parsed.every((s) => typeof s === "object" && s !== null)) return null;
		return text;
	} catch {
		return null;
	}
}

/** The cache-hit answer: byte-identical to the container's RPC response, plus
 *  a marker header so tests/e2e can PROVE the container was not consulted. */
export function cachedCatalogResponse(payload: string): Response {
	return new Response(payload, {
		headers: {
			"content-type": "application/json",
			[MODEL_CATALOG_HEADER]: "cached",
		},
	});
}

// Kept in sync with cloud/schema.sql. Also executed by `writeModelCatalog`
// (self-healing) so a pre-WP5 D1 that never re-ran schema.sql gains the table
// on the first write instead of erroring until the next provision.
const CREATE_MODEL_CATALOG_SQL = `CREATE TABLE IF NOT EXISTS model_catalog (
  sandbox_id TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

/** Read the cached catalog. `null` = miss (including "table doesn't exist yet"
 *  on a pre-WP5 D1 — treated as a plain miss, never an error). */
export async function readModelCatalog(
	db: D1Database,
	sandboxId: string,
): Promise<string | null> {
	try {
		const row = await db
			.prepare("SELECT payload FROM model_catalog WHERE sandbox_id = ?1")
			.bind(sandboxId)
			.first<{ payload: string }>();
		return row?.payload ?? null;
	} catch {
		return null;
	}
}

/** Upsert the cached catalog (one row per sandbox). Batched with the
 *  self-healing CREATE so it works on a D1 provisioned before WP5. */
export async function writeModelCatalog(
	db: D1Database,
	sandboxId: string,
	payload: string,
): Promise<void> {
	await db.batch([
		db.prepare(CREATE_MODEL_CATALOG_SQL),
		db
			.prepare(
				`INSERT INTO model_catalog (sandbox_id, payload, updated_at)
				 VALUES (?1, ?2, ?3)
				 ON CONFLICT(sandbox_id) DO UPDATE
				 SET payload = excluded.payload, updated_at = excluded.updated_at`,
			)
			.bind(sandboxId, payload, new Date().toISOString()),
	]);
}
