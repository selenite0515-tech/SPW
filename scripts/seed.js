require('dotenv').config();
const bcrypt = require('bcrypt');
const { openDatabase, migrate } = require('../src/db');

const BCRYPT_ROUNDS = 12;

/**
 * Bootstrap seed runs without an authenticated user. Audit FKs `created_by` / `updated_by`
 * are intentionally NULL here (system/seed); the application sets them on real requests.
 */
async function seedPostgres(db) {
  const hashEmployee = await bcrypt.hash('DemoPass123!', BCRYPT_ROUNDS);
  const hashAdmin = await bcrypt.hash('AdminPass123!', BCRYPT_ROUNDS);

  await db.transaction(async (tx) => {
    await tx.run(`DELETE FROM payslip_signatures`);
    await tx.run(`DELETE FROM payroll_entries`);
    await tx.run(`DELETE FROM employees`);
    await tx.run(`DELETE FROM job_posts`);
    await tx.run(`DELETE FROM job_titles`);

    await tx.run(
      `INSERT INTO job_posts (code, name, created_by, updated_by) VALUES (?, ?, NULL, NULL)`,
      ['HQ', 'Headquarters']
    );
    await tx.run(
      `INSERT INTO job_posts (code, name, created_by, updated_by) VALUES (?, ?, NULL, NULL)`,
      ['OPS-NYC', 'Operations — NYC']
    );

    await tx.run(
      `INSERT INTO job_titles (code, name, created_by, updated_by) VALUES (?, ?, NULL, NULL)`,
      ['ADM', 'Administrator']
    );
    await tx.run(
      `INSERT INTO job_titles (code, name, created_by, updated_by) VALUES (?, ?, NULL, NULL)`,
      ['ENG-L2', 'Engineer II']
    );

    const postOps = await tx.get(`SELECT id FROM job_posts WHERE LOWER(code) = LOWER(?)`, ['OPS-NYC']);
    const postHq = await tx.get(`SELECT id FROM job_posts WHERE LOWER(code) = LOWER(?)`, ['HQ']);
    const titleEng = await tx.get(`SELECT id FROM job_titles WHERE LOWER(code) = LOWER(?)`, ['ENG-L2']);
    const titleAdm = await tx.get(`SELECT id FROM job_titles WHERE LOWER(code) = LOWER(?)`, ['ADM']);
    if (!postOps || !postHq || !titleEng || !titleAdm) {
      throw new Error('Seed failed: job post/title lookup failed.');
    }

    await tx.run(
      `INSERT INTO employees (
        username, email, password_hash, full_name, employee_code, role,
        base_salary_monthly_cents, overtime_hourly_rate_cents, tax_rate_bps, retirement_rate_bps,
        job_post_id, job_title_id, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, 'employee', ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      [
        'jdoe',
        'jane.doe@example.com',
        hashEmployee,
        'Jane Doe',
        'E001',
        520000,
        4500,
        1500,
        500,
        postOps.id,
        titleEng.id,
      ]
    );

    const empRow = await tx.get(`SELECT id FROM employees WHERE LOWER(employee_code) = LOWER(?)`, ['E001']);
    if (!empRow) throw new Error('Seed failed: demo employee not inserted.');

    await tx.run(
      `INSERT INTO employees (
        username, email, password_hash, full_name, employee_code, role,
        base_salary_monthly_cents, overtime_hourly_rate_cents,
        job_post_id, job_title_id, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, 'admin', 1, 0, ?, ?, NULL, NULL)`,
      ['admin', 'admin@example.local', hashAdmin, 'System Admin', 'ADM01', postHq.id, titleAdm.id]
    );

    const entries = [
      [2026, 3, 2.5, 10000, 0],
      [2026, 4, 0, 25000, 5000],
      [2026, 5, 4, 0, 0],
    ];
    for (const [y, m, ot, bonus, other] of entries) {
      await tx.run(
        `INSERT INTO payroll_entries (
           employee_id, year, month, overtime_hours, bonus_cents, other_deduction_cents,
           created_by, updated_by
         ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
        [empRow.id, y, m, ot, bonus, other]
      );
    }
  });
}

async function main() {
  const db = await openDatabase();
  await migrate(db);
  await seedPostgres(db);
  await db.close();

  console.log('Seed complete.');
  console.log('Database:', db.databaseLabel);
  console.log('Demo employee jdoe: job_post OPS-NYC (Operations — NYC), job_title ENG-L2 (Engineer II)');
  console.log('Demo admin: job_post HQ (Headquarters), job_title ADM (Administrator)');
  console.log('Demo employee: jdoe / jane.doe@example.com — password in README');
  console.log('Demo admin: admin — password in README');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
