/**
 * Convert `?` placeholders to Postgres `$1`, `$2`, …
 * Assumes `?` does not appear inside string literals in SQL.
 */
function sqlToPostgres(sql) {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

function normalizeRow(row) {
  if (!row || typeof row !== 'object') return row;
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (v instanceof Date) row[k] = v.toISOString();
  }
  return row;
}

function normalizeRows(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((r) => normalizeRow(r));
}

function databaseLabelFromUrl(databaseUrl) {
  if (!databaseUrl) return '(PostgreSQL)';
  try {
    const u = new URL(databaseUrl);
    const host = u.hostname || 'localhost';
    const db = u.pathname?.replace(/^\//, '') || '(database)';
    return `PostgreSQL ${host}/${db}`;
  } catch {
    return '(PostgreSQL)';
  }
}

function requireDatabaseUrl() {
  const databaseUrl = (process.env.DATABASE_URL || '').trim();
  if (!databaseUrl) {
    const err = new Error(
      'DATABASE_URL is required. Set a PostgreSQL connection string (e.g. postgres://user:pass@localhost:5432/dbname). SQLite is no longer supported.'
    );
    err.code = 'DATABASE_URL_MISSING';
    throw err;
  }
  try {
    const u = new URL(databaseUrl);
    const scheme = (u.protocol || '').replace(/:$/, '').toLowerCase();
    if (scheme !== 'postgres' && scheme !== 'postgresql') {
      const err = new Error(
        `DATABASE_URL must use postgres:// or postgresql:// scheme (got "${scheme || 'unknown'}").`
      );
      err.code = 'DATABASE_URL_INVALID';
      throw err;
    }
  } catch (e) {
    if (e && e.code === 'DATABASE_URL_INVALID') throw e;
    const err = new Error(
      `DATABASE_URL is not a valid URL: ${e instanceof Error ? e.message : String(e)}`
    );
    err.code = 'DATABASE_URL_INVALID';
    throw err;
  }
  return databaseUrl;
}

function migratePostgresDDL() {
  return `
    CREATE TABLE IF NOT EXISTS job_posts (
      id SERIAL PRIMARY KEY,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by INTEGER,
      updated_by INTEGER
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_job_posts_code_lower ON job_posts (LOWER(code));

    CREATE TABLE IF NOT EXISTS job_titles (
      id SERIAL PRIMARY KEY,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by INTEGER,
      updated_by INTEGER
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_job_titles_code_lower ON job_titles (LOWER(code));

    CREATE TABLE IF NOT EXISTS employees (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      employee_code TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'employee',
      base_salary_monthly_cents INTEGER NOT NULL,
      overtime_hourly_rate_cents INTEGER NOT NULL DEFAULT 0,
      tax_rate_bps INTEGER NOT NULL DEFAULT 1500,
      retirement_rate_bps INTEGER NOT NULL DEFAULT 500,
      job_post_id INTEGER,
      job_title_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by INTEGER,
      updated_by INTEGER,
      CONSTRAINT employees_role_check CHECK (role IN ('employee', 'admin')),
      CONSTRAINT employees_base_check CHECK (base_salary_monthly_cents > 0),
      CONSTRAINT employees_ot_check CHECK (overtime_hourly_rate_cents >= 0),
      CONSTRAINT employees_tax_check CHECK (tax_rate_bps >= 0 AND tax_rate_bps <= 10000),
      CONSTRAINT employees_ret_check CHECK (retirement_rate_bps >= 0 AND retirement_rate_bps <= 10000)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_username_lower ON employees (LOWER(username));
    CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_email_lower ON employees (LOWER(email));
    CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_employee_code_lower ON employees (LOWER(employee_code));

    CREATE TABLE IF NOT EXISTS payroll_entries (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      year INTEGER NOT NULL,
      month INTEGER NOT NULL,
      overtime_hours DOUBLE PRECISION NOT NULL DEFAULT 0,
      bonus_cents INTEGER NOT NULL DEFAULT 0,
      other_deduction_cents INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by INTEGER,
      updated_by INTEGER,
      CONSTRAINT payroll_year_check CHECK (year >= 2000 AND year <= 2100),
      CONSTRAINT payroll_month_check CHECK (month >= 1 AND month <= 12),
      CONSTRAINT payroll_ot_check CHECK (overtime_hours >= 0),
      CONSTRAINT payroll_bonus_check CHECK (bonus_cents >= 0),
      CONSTRAINT payroll_other_check CHECK (other_deduction_cents >= 0),
      UNIQUE (employee_id, year, month)
    );

    CREATE TABLE IF NOT EXISTS payslip_signatures (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      year INTEGER NOT NULL,
      month INTEGER NOT NULL,
      signature_text TEXT NOT NULL,
      signed_at TIMESTAMPTZ NOT NULL,
      ip_address TEXT,
      pdf_path TEXT,
      pdf_generated_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by INTEGER,
      updated_by INTEGER,
      UNIQUE (employee_id, year, month)
    );

    CREATE INDEX IF NOT EXISTS idx_payroll_employee_period ON payroll_entries(employee_id, year, month);
    CREATE INDEX IF NOT EXISTS idx_payroll_year_month ON payroll_entries(year, month);
    CREATE INDEX IF NOT EXISTS idx_signatures_year_month ON payslip_signatures(year, month);
    CREATE INDEX IF NOT EXISTS idx_signatures_employee_id ON payslip_signatures(employee_id);
    CREATE INDEX IF NOT EXISTS idx_employees_username ON employees(username);
    CREATE INDEX IF NOT EXISTS idx_employees_email ON employees(email);
    CREATE INDEX IF NOT EXISTS idx_employees_employee_code ON employees(employee_code);
  `;
}

/** Split multi-statement DDL for drivers that run one statement per query. */
function splitSqlStatements(ddl) {
  return ddl
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('--'));
}

async function runPostgresDdl(pool, ddl) {
  for (const statement of splitSqlStatements(ddl)) {
    await pool.query(statement);
  }
}

async function columnExists(pool, tableName, columnName) {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [tableName, columnName]
  );
  return rows.length > 0;
}

async function addColumnIfMissing(pool, tableName, columnName, sqlType) {
  if (await columnExists(pool, tableName, columnName)) return;
  await pool.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${sqlType}`);
}

async function constraintExists(pool, constraintName) {
  const { rows } = await pool.query(`SELECT 1 FROM pg_constraint WHERE conname = $1`, [constraintName]);
  return rows.length > 0;
}

async function addForeignKeyIfMissing(pool, constraintName, tableName, columnName, refTable, onDelete) {
  if (await constraintExists(pool, constraintName)) return;
  const onDel = onDelete ? ` ON DELETE ${onDelete}` : '';
  await pool.query(
    `ALTER TABLE ${tableName} ADD CONSTRAINT ${constraintName} FOREIGN KEY (${columnName}) REFERENCES ${refTable}(id)${onDel}`
  );
}

async function migratePostgresSchemaPatches(pool) {
  await addColumnIfMissing(pool, 'payslip_signatures', 'pdf_path', 'TEXT');
  await addColumnIfMissing(pool, 'payslip_signatures', 'pdf_generated_at', 'TIMESTAMPTZ');
  await addColumnIfMissing(pool, 'payslip_signatures', 'pdf_storage_key', 'TEXT');
  await addColumnIfMissing(pool, 'payslip_signatures', 'pdf_sha256', 'TEXT');

  await addColumnIfMissing(pool, 'employees', 'job_post_id', 'INTEGER');
  await addColumnIfMissing(pool, 'employees', 'job_title_id', 'INTEGER');
  await addColumnIfMissing(pool, 'employees', 'updated_at', 'TIMESTAMPTZ NOT NULL DEFAULT NOW()');
  await addColumnIfMissing(pool, 'employees', 'created_by', 'INTEGER');
  await addColumnIfMissing(pool, 'employees', 'updated_by', 'INTEGER');

  await addColumnIfMissing(pool, 'payroll_entries', 'created_at', 'TIMESTAMPTZ NOT NULL DEFAULT NOW()');
  await addColumnIfMissing(pool, 'payroll_entries', 'updated_at', 'TIMESTAMPTZ NOT NULL DEFAULT NOW()');
  await addColumnIfMissing(pool, 'payroll_entries', 'created_by', 'INTEGER');
  await addColumnIfMissing(pool, 'payroll_entries', 'updated_by', 'INTEGER');

  await addColumnIfMissing(pool, 'payslip_signatures', 'created_at', 'TIMESTAMPTZ NOT NULL DEFAULT NOW()');
  await addColumnIfMissing(pool, 'payslip_signatures', 'updated_at', 'TIMESTAMPTZ NOT NULL DEFAULT NOW()');
  await addColumnIfMissing(pool, 'payslip_signatures', 'created_by', 'INTEGER');
  await addColumnIfMissing(pool, 'payslip_signatures', 'updated_by', 'INTEGER');

  await addColumnIfMissing(pool, 'job_posts', 'created_at', 'TIMESTAMPTZ NOT NULL DEFAULT NOW()');
  await addColumnIfMissing(pool, 'job_posts', 'updated_at', 'TIMESTAMPTZ NOT NULL DEFAULT NOW()');
  await addColumnIfMissing(pool, 'job_posts', 'created_by', 'INTEGER');
  await addColumnIfMissing(pool, 'job_posts', 'updated_by', 'INTEGER');

  await addColumnIfMissing(pool, 'job_titles', 'created_at', 'TIMESTAMPTZ NOT NULL DEFAULT NOW()');
  await addColumnIfMissing(pool, 'job_titles', 'updated_at', 'TIMESTAMPTZ NOT NULL DEFAULT NOW()');
  await addColumnIfMissing(pool, 'job_titles', 'created_by', 'INTEGER');
  await addColumnIfMissing(pool, 'job_titles', 'updated_by', 'INTEGER');

  await addForeignKeyIfMissing(pool, 'employees_job_post_id_fkey', 'employees', 'job_post_id', 'job_posts', 'SET NULL');
  await addForeignKeyIfMissing(pool, 'employees_job_title_id_fkey', 'employees', 'job_title_id', 'job_titles', 'SET NULL');

  await addForeignKeyIfMissing(pool, 'employees_created_by_fkey', 'employees', 'created_by', 'employees', 'SET NULL');
  await addForeignKeyIfMissing(pool, 'employees_updated_by_fkey', 'employees', 'updated_by', 'employees', 'SET NULL');

  await addForeignKeyIfMissing(pool, 'job_posts_created_by_fkey', 'job_posts', 'created_by', 'employees', 'SET NULL');
  await addForeignKeyIfMissing(pool, 'job_posts_updated_by_fkey', 'job_posts', 'updated_by', 'employees', 'SET NULL');
  await addForeignKeyIfMissing(pool, 'job_titles_created_by_fkey', 'job_titles', 'created_by', 'employees', 'SET NULL');
  await addForeignKeyIfMissing(pool, 'job_titles_updated_by_fkey', 'job_titles', 'updated_by', 'employees', 'SET NULL');

  await addForeignKeyIfMissing(
    pool,
    'payroll_entries_created_by_fkey',
    'payroll_entries',
    'created_by',
    'employees',
    'SET NULL'
  );
  await addForeignKeyIfMissing(
    pool,
    'payroll_entries_updated_by_fkey',
    'payroll_entries',
    'updated_by',
    'employees',
    'SET NULL'
  );

  await addForeignKeyIfMissing(
    pool,
    'payslip_signatures_created_by_fkey',
    'payslip_signatures',
    'created_by',
    'employees',
    'SET NULL'
  );
  await addForeignKeyIfMissing(
    pool,
    'payslip_signatures_updated_by_fkey',
    'payslip_signatures',
    'updated_by',
    'employees',
    'SET NULL'
  );
}

/**
 * Idempotent data migration: ensure ADM admin job post exists and link admin users.
 * Also backfill pdf_storage_key from legacy pdf_path (basename).
 */
async function migrateDataPatches(pool) {
  await pool.query(`
    INSERT INTO job_posts (code, name, created_by, updated_by)
    SELECT 'ADM', 'Administration (HQ)', NULL, NULL
    WHERE NOT EXISTS (SELECT 1 FROM job_posts WHERE LOWER(code) = 'adm')
  `);

  await pool.query(`
    UPDATE employees e
    SET job_post_id = jp.id, updated_at = NOW()
    FROM job_posts jp
    WHERE LOWER(jp.code) = 'adm'
      AND e.role = 'admin'
      AND (e.job_post_id IS DISTINCT FROM jp.id)
  `);

  await pool.query(`
    UPDATE payslip_signatures
    SET pdf_storage_key = pdf_path
    WHERE pdf_path IS NOT NULL
      AND TRIM(pdf_path) <> ''
      AND (pdf_storage_key IS NULL OR TRIM(pdf_storage_key) = '')
  `);
}

function createPostgresFacade(pool, databaseLabel) {
  const prepareParams = (params) => (Array.isArray(params) ? params : []);

  return {
    kind: 'postgres',
    databaseLabel,
    __pool: pool,
    async exec(sql) {
      await pool.query(sql);
    },
    async get(sql, params = []) {
      const text = sqlToPostgres(sql);
      const r = await pool.query(text, prepareParams(params));
      const row = r.rows[0];
      return row ? normalizeRow({ ...row }) : undefined;
    },
    async all(sql, params = []) {
      const text = sqlToPostgres(sql);
      const r = await pool.query(text, prepareParams(params));
      return normalizeRows(r.rows.map((row) => ({ ...row })));
    },
    async run(sql, params = []) {
      const text = sqlToPostgres(sql);
      const r = await pool.query(text, prepareParams(params));
      return { changes: r.rowCount, lastInsertRowid: null };
    },
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tx = {
          get: async (s, p = []) => {
            const t = sqlToPostgres(s);
            const res = await client.query(t, prepareParams(p));
            const row = res.rows[0];
            return row ? normalizeRow({ ...row }) : undefined;
          },
          all: async (s, p = []) => {
            const t = sqlToPostgres(s);
            const res = await client.query(t, prepareParams(p));
            return normalizeRows(res.rows.map((row) => ({ ...row })));
          },
          run: async (s, p = []) => {
            const t = sqlToPostgres(s);
            const res = await client.query(t, prepareParams(p));
            return { changes: res.rowCount, lastInsertRowid: null };
          },
        };
        await work(tx);
        await client.query('COMMIT');
      } catch (e) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* ignore */
        }
        throw e;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
    async ping() {
      const client = await pool.connect();
      try {
        await client.query('SELECT 1');
      } finally {
        client.release();
      }
    },
  };
}

/**
 * @returns {Promise<{ kind: 'postgres', databaseLabel: string, exec: Function, get: Function, all: Function, run: Function, transaction: Function, close: Function }>}
 */
async function openDatabase() {
  const databaseUrl = requireDatabaseUrl();
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: databaseUrl });
  const databaseLabel = databaseLabelFromUrl(databaseUrl);
  return createPostgresFacade(pool, databaseLabel);
}

async function verifyDatabaseConnection(pool) {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
}

async function migrate(db) {
  if (db.kind !== 'postgres') {
    throw new Error('migrate() expects a PostgreSQL database facade.');
  }
  const pool = db.__pool;
  await runPostgresDdl(pool, migratePostgresDDL());
  await migratePostgresSchemaPatches(pool);
  await migrateDataPatches(pool);
}

module.exports = {
  openDatabase,
  migrate,
  verifyDatabaseConnection,
  requireDatabaseUrl,
};
