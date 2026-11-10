// Immutable version-one retirement contract. Extend through a new migration;
// never broaden these targets or change a deployed checksum in place.
export type HeartbeatPrefixIndexExecutor = {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
};

const SPECS = [
  { candidate: "heartbeats_student_id_idx", replacement: "heartbeats_student_timestamp_idx", column: "student_id" },
  { candidate: "heartbeats_student_email_idx", replacement: "heartbeats_email_timestamp_idx", column: "student_email" },
] as const;
const NAMES: readonly string[] = SPECS.flatMap(spec => [spec.candidate, spec.replacement]);
const LOCK = "schoolpilot:heartbeat-prefix-index-retirement-v1";
const STATEMENT_TIMEOUT = "8min";
const LOCK_TIMEOUT = "15s";

export const HEARTBEAT_PREFIX_INDEX_CATALOG_SQL = `
/* heartbeat_prefix_index_retirement_v1_catalog */
SELECT idx.relname::text AS index_name, idx_ns.nspname::text AS index_schema,
  idx.oid::text AS index_oid, idx.relkind::text AS relation_kind,
  table_class.relkind::text AS table_kind, table_ns.nspname::text AS table_schema,
  table_class.relname::text AS table_name, i.indrelid::text AS table_oid,
  pg_catalog.to_regclass('public.heartbeats')::oid::text AS expected_table_oid,
  am.amname::text AS access_method, pg_catalog.pg_get_indexdef(i.indexrelid) AS index_definition,
  i.indislive, i.indisready, i.indisvalid, i.indisunique, i.indisprimary, i.indisexclusion,
  EXISTS (SELECT 1 FROM pg_catalog.pg_constraint constraint_owner WHERE constraint_owner.conindid=idx.oid) AS is_constraint_owned,
  i.indpred IS NULL AND i.indexprs IS NULL AS is_plain,
  i.indnkeyatts::integer AS key_count, i.indnatts::integer AS total_column_count,
  ARRAY(SELECT attribute.attname::text FROM unnest(i.indkey::smallint[]) WITH ORDINALITY key_column(attnum, position)
    JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid=i.indrelid AND attribute.attnum=key_column.attnum
    WHERE key_column.position<=i.indnkeyatts ORDER BY key_column.position) AS key_columns,
  ARRAY(SELECT pg_catalog.format_type(attribute.atttypid,attribute.atttypmod)
    FROM unnest(i.indkey::smallint[]) WITH ORDINALITY key_column(attnum, position)
    JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid=i.indrelid AND attribute.attnum=key_column.attnum
    WHERE key_column.position<=i.indnkeyatts ORDER BY key_column.position) AS key_types,
  ARRAY(SELECT opclass_ns.nspname::text||'.'||opclass.opcname::text
    FROM unnest(i.indclass::oid[]) WITH ORDINALITY key_class(opclass_oid, position)
    JOIN pg_catalog.pg_opclass opclass ON opclass.oid=key_class.opclass_oid
    JOIN pg_catalog.pg_namespace opclass_ns ON opclass_ns.oid=opclass.opcnamespace
    WHERE key_class.position<=i.indnkeyatts ORDER BY key_class.position) AS key_opclasses,
  ARRAY(SELECT opclass.opcdefault AND opclass.opcmethod=idx.relam AND opclass.opcintype=attribute.atttypid
    FROM unnest(i.indkey::smallint[],i.indclass::oid[]) WITH ORDINALITY key_class(attnum,opclass_oid,position)
    JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid=i.indrelid AND attribute.attnum=key_class.attnum
    JOIN pg_catalog.pg_opclass opclass ON opclass.oid=key_class.opclass_oid
    WHERE key_class.position<=i.indnkeyatts ORDER BY key_class.position) AS key_default_opclasses,
  ARRAY(SELECT key_collation.collation_oid=attribute.attcollation AND attribute.attcollation=attribute_type.typcollation
    FROM unnest(i.indkey::smallint[],i.indcollation::oid[]) WITH ORDINALITY key_collation(attnum,collation_oid,position)
    JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid=i.indrelid AND attribute.attnum=key_collation.attnum
    JOIN pg_catalog.pg_type attribute_type ON attribute_type.oid=attribute.atttypid
    WHERE key_collation.position<=i.indnkeyatts ORDER BY key_collation.position) AS key_default_collations,
  ARRAY(SELECT sort_option.option::integer FROM unnest(i.indoption::smallint[]) WITH ORDINALITY sort_option(option,position)
    WHERE sort_option.position<=i.indnkeyatts ORDER BY sort_option.position) AS key_options
FROM pg_catalog.pg_class idx
JOIN pg_catalog.pg_namespace idx_ns ON idx_ns.oid=idx.relnamespace
LEFT JOIN pg_catalog.pg_index i ON i.indexrelid=idx.oid
LEFT JOIN pg_catalog.pg_class table_class ON table_class.oid=i.indrelid
LEFT JOIN pg_catalog.pg_namespace table_ns ON table_ns.oid=table_class.relnamespace
LEFT JOIN pg_catalog.pg_am am ON am.oid=idx.relam
WHERE idx_ns.nspname='public' AND idx.relname=ANY($1::text[])
`;

export const HEARTBEAT_PREFIX_INDEX_RETIREMENT_CONTRACT = `
heartbeat-prefix-index-retirement-v1
${JSON.stringify(SPECS)}
all replacements: valid/live/ready, exact public.heartbeats identity, plain nonunique unconstrained btree;
exact text/timestamp keys; no INCLUDE/expression/predicate; default pg_catalog opclasses, collation, ASC NULLS LAST.
candidates: same exact structural contract; invalid/live/ready flags may reflect an interrupted concurrent DROP.
all four names attested in one catalog snapshot before any DROP; identities rechecked before each fixed DROP.
only DROP INDEX CONCURRENTLY IF EXISTS public.heartbeats_student_id_idx;
only DROP INDEX CONCURRENTLY IF EXISTS public.heartbeats_student_email_idx;
no row changes, table rewrite, CASCADE or nonconcurrent fallback.
lock=${LOCK}; statement_timeout=${STATEMENT_TIMEOUT}; lock_timeout=${LOCK_TIMEOUT}; restore original session values.
${HEARTBEAT_PREFIX_INDEX_CATALOG_SQL}`;

type State = { oid: string; live: boolean; ready: boolean; valid: boolean };
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === "string"); }
function booleans(value: unknown): value is boolean[] { return Array.isArray(value) && value.every(item => typeof item === "boolean"); }
function numbers(value: unknown): value is number[] { return Array.isArray(value) && value.every(item => Number.isInteger(item)); }
function same<T>(actual: T[], expected: readonly T[]) { return actual.length===expected.length && actual.every((item,index)=>item===expected[index]); }
function unexpected(name: string): never { throw new Error(`Unexpected catalog definition for public.${name}; refusing heartbeat index retirement`); }

function attest(value: unknown): [string, State] {
  if (!record(value) || typeof value.index_name!=="string" || !NAMES.includes(value.index_name)) throw new Error("Unexpected heartbeat index catalog row");
  const name=value.index_name;
  const spec=SPECS.find(item=>item.candidate===name || item.replacement===name);
  if (!spec) return unexpected(name);
  const columns=name===spec.candidate ? [spec.column] : [spec.column,"timestamp"];
  const definition=typeof value.index_definition==="string" ? value.index_definition.replace(/"/g,"").replace(/\s+/g," ").trim() : "";
  if (value.index_schema!=="public" || value.relation_kind!=="i" || value.table_kind!=="r"
    || value.table_schema!=="public" || value.table_name!=="heartbeats"
    || typeof value.index_oid!=="string" || !/^[1-9]\d*$/.test(value.index_oid)
    || typeof value.table_oid!=="string" || value.table_oid!==value.expected_table_oid
    || !/^[1-9]\d*$/.test(value.table_oid) || value.access_method!=="btree"
    || value.indisunique!==false || value.indisprimary!==false || value.indisexclusion!==false
    || value.is_constraint_owned!==false || value.is_plain!==true
    || value.key_count!==columns.length || value.total_column_count!==columns.length
    || !strings(value.key_columns) || !same(value.key_columns,columns)
    || !strings(value.key_types) || !same(value.key_types,columns.map(column=>column==="timestamp" ? "timestamp without time zone" : "text"))
    || !strings(value.key_opclasses) || !same(value.key_opclasses,columns.map(column=>column==="timestamp" ? "pg_catalog.timestamp_ops" : "pg_catalog.text_ops"))
    || !booleans(value.key_default_opclasses) || !same(value.key_default_opclasses,columns.map(()=>true))
    || !booleans(value.key_default_collations) || !same(value.key_default_collations,columns.map(()=>true))
    || !numbers(value.key_options) || !same(value.key_options,columns.map(()=>0))
    || definition!==`CREATE INDEX ${name} ON public.heartbeats USING btree (${columns.join(", ")})`
    || typeof value.indislive!=="boolean" || typeof value.indisready!=="boolean" || typeof value.indisvalid!=="boolean") return unexpected(name);
  if (name===spec.replacement && (!value.indislive || !value.indisready || !value.indisvalid)) return unexpected(name);
  return [name,{oid:value.index_oid,live:value.indislive,ready:value.indisready,valid:value.indisvalid}];
}

async function inspect(client: HeartbeatPrefixIndexExecutor): Promise<Map<string, State>> {
  const result=await client.query(HEARTBEAT_PREFIX_INDEX_CATALOG_SQL,[NAMES]);
  const states=new Map<string,State>();
  for (const row of result.rows) {
    const [name,state]=attest(row);
    if (states.has(name)) throw new Error("Duplicate heartbeat index catalog row");
    states.set(name,state);
  }
  for (const spec of SPECS) if (!states.has(spec.replacement)) throw new Error(`Required replacement public.${spec.replacement} is missing`);
  return states;
}

function sameIdentities(current: Map<string,State>, expected: Map<string,State>): void {
  if (current.size!==expected.size || [...expected].some(([name,state])=>current.get(name)?.oid!==state.oid)) {
    throw new Error("Heartbeat index identity changed after preflight; refusing retirement");
  }
}

/** Called by the serialized, nontransactional migration ledger. The additional
 * session lock also protects explicit local convergence. Never call in BEGIN.
 * Both replacement paths must pass before even the first expendable DROP. */
export async function retireHeartbeatPrefixIndexesOnline(client: HeartbeatPrefixIndexExecutor): Promise<void> {
  let originalStatement: string | undefined, originalLock: string | undefined;
  let lockHeld=false, statementChanged=false, lockChanged=false, failed=false;
  try {
    const statement=(await client.query("SHOW statement_timeout")).rows[0];
    const lock=(await client.query("SHOW lock_timeout")).rows[0];
    if (!record(statement) || typeof statement.statement_timeout!=="string" || !statement.statement_timeout
      || !record(lock) || typeof lock.lock_timeout!=="string" || !lock.lock_timeout) throw new Error("Could not capture heartbeat index migration timeouts");
    originalStatement=statement.statement_timeout; originalLock=lock.lock_timeout;
    const acquired=(await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",[LOCK])).rows[0];
    if (!record(acquired) || acquired.acquired!==true) throw new Error("Heartbeat index retirement is already running on another session");
    lockHeld=true;
    statementChanged=true; await client.query("SELECT set_config('statement_timeout', $1, false)",[STATEMENT_TIMEOUT]);
    lockChanged=true; await client.query("SELECT set_config('lock_timeout', $1, false)",[LOCK_TIMEOUT]);
    const expected=await inspect(client);
    for (const spec of SPECS) {
      if (!expected.has(spec.candidate)) continue;
      sameIdentities(await inspect(client),expected);
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS public.${spec.candidate}`);
      expected.delete(spec.candidate);
    }
    sameIdentities(await inspect(client),expected);
  } catch (error) { failed=true; throw error; }
  finally {
    const cleanupErrors: Error[]=[];
    if (lockHeld) {
      try {
        const released=(await client.query("SELECT pg_advisory_unlock(hashtext($1)) AS released",[LOCK])).rows[0];
        if (!record(released) || released.released!==true) throw new Error("Session advisory lock was not released");
      } catch (cause) { cleanupErrors.push(new Error("Failed to release heartbeat index retirement lock",{cause})); }
    }
    if (lockChanged && originalLock!==undefined) {
      try { await client.query("SELECT set_config('lock_timeout', $1, false)",[originalLock]); }
      catch (cause) { cleanupErrors.push(new Error("Failed to restore heartbeat index lock_timeout",{cause})); }
    }
    if (statementChanged && originalStatement!==undefined) {
      try { await client.query("SELECT set_config('statement_timeout', $1, false)",[originalStatement]); }
      catch (cause) { cleanupErrors.push(new Error("Failed to restore heartbeat index statement_timeout",{cause})); }
    }
    if (cleanupErrors.length) {
      if (failed) console.error("[migration] Heartbeat index retirement session cleanup failed; discard this client");
      else throw new AggregateError(cleanupErrors,"Heartbeat index retirement session cleanup failed");
    }
  }
}
