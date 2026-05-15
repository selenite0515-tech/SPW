require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const bcrypt = require('bcrypt');
const pinoHttp = require('pino-http');
const cors = require('cors');
const archiver = require('archiver');

const { openDatabase, migrate } = require('./db');
const { computePayslip } = require('./payroll');
const { writePayslipPdf } = require('./payslipPdf');
const { logger } = require('./logger');
const {
  assertProductionPdfStorageConfigured,
  getPdfStorageMode,
  payslipBasename,
  s3ObjectKeyForBasename,
  pdfStorageRoot,
  resolveLocalPdfPath,
  putFileToS3,
  presignedPdfGetUrl,
  getObjectBodyStream,
} = require('./pdfStorage');

const PORT = Number(process.env.PORT) || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-change-me';
const NODE_ENV = process.env.NODE_ENV || 'development';
const PROJECT_ROOT = path.join(__dirname, '..');
const BULK_PRINT_MAX = 200;
const PRESIGN_TTL_SECONDS = Number(process.env.PRESIGNED_PDF_TTL_SECONDS) || 300;

/** @type {Awaited<ReturnType<typeof openDatabase>>} */
let db;
/** @type {ReturnType<typeof getPdfStorageMode>} */
let pdfMode;

function parseFrontendOrigins() {
  const raw = process.env.FRONTEND_ORIGIN || '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function payslipBasenameFromRow(sig) {
  const raw = (sig?.pdf_storage_key || sig?.pdf_path || '').trim();
  if (!raw) return null;
  const base = path.basename(raw);
  if (!/^emp_\d+_\d{4}_\d{1,2}\.pdf$/.test(base)) return null;
  return base;
}

function payslipPdfFileExists(sig) {
  const basename = payslipBasenameFromRow(sig);
  if (!basename) return false;
  if (pdfMode.mode === 's3') {
    return Boolean(sig?.pdf_generated_at);
  }
  const resolved = resolveLocalPdfPath(PROJECT_ROOT, basename);
  return Boolean(resolved && fs.existsSync(resolved));
}

function isAdminJobPostCode(code) {
  if (!code || typeof code !== 'string') return false;
  const u = code.trim().toUpperCase();
  return u === 'ADM' || u === 'ADMIN';
}

function sessionIsAdmin(req) {
  return Boolean(req.session && req.session.isAdmin);
}

const employeeSelectBase = `
  SELECT e.id, e.username, e.email, e.password_hash, e.full_name, e.employee_code, e.role,
         e.base_salary_monthly_cents, e.overtime_hourly_rate_cents, e.tax_rate_bps, e.retirement_rate_bps,
         e.job_post_id, e.job_title_id,
         jp.code AS job_post_code, jp.name AS job_post_name,
         jt.code AS job_title_code, jt.name AS job_title_name
  FROM employees e
  LEFT JOIN job_posts jp ON jp.id = e.job_post_id
  LEFT JOIN job_titles jt ON jt.id = e.job_title_id
`;

async function findEmployeeByLogin(identifier) {
  const row = await db.get(
    `${employeeSelectBase}
     WHERE LOWER(e.username) = LOWER(?) OR LOWER(e.email) = LOWER(?)`,
    [identifier, identifier]
  );
  return row || null;
}

async function getEmployeeById(id) {
  return db.get(`${employeeSelectBase} WHERE e.id = ?`, [id]);
}

function jobPostPayload(row) {
  if (!row?.job_post_id) return null;
  return { code: row.job_post_code, name: row.job_post_name };
}

function jobTitlePayload(row) {
  if (!row?.job_title_id) return null;
  return { code: row.job_title_code, name: row.job_title_name };
}

function parsePeriod(yearRaw, monthRaw) {
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  return { year, month };
}

function parseOptionalInt(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n)) return null;
  return n;
}

async function getPayrollEntryForEmployee(employeeId, year, month) {
  return (
    (await db.get(
      `SELECT overtime_hours, bonus_cents, other_deduction_cents FROM payroll_entries
       WHERE employee_id = ? AND year = ? AND month = ?`,
      [employeeId, year, month]
    )) || {
      overtime_hours: 0,
      bonus_cents: 0,
      other_deduction_cents: 0,
    }
  );
}

async function computeEmployeePayslip(employeeRow, year, month) {
  const entry = await getPayrollEntryForEmployee(employeeRow.id, year, month);
  return computePayslip({
    baseSalaryMonthlyCents: employeeRow.base_salary_monthly_cents,
    overtimeHourlyRateCents: employeeRow.overtime_hourly_rate_cents,
    taxRateBps: employeeRow.tax_rate_bps,
    retirementRateBps: employeeRow.retirement_rate_bps,
    overtimeHours: entry.overtime_hours,
    bonusCents: entry.bonus_cents,
    otherDeductionCents: entry.other_deduction_cents,
  });
}

/**
 * @param {object} employeeRow
 * @param {number} year
 * @param {number} month
 * @param {number | null} actorEmployeeId authenticated employee performing the write (null only for internal/test)
 */
async function generatePayslipPdfFile(employeeRow, year, month, actorEmployeeId) {
  const sig = await db.get(
    `SELECT signature_text, signed_at, ip_address FROM payslip_signatures
     WHERE employee_id = ? AND year = ? AND month = ?`,
    [employeeRow.id, year, month]
  );
  if (!sig) {
    const err = new Error('NO_SIGNATURE');
    err.code = 'NO_SIGNATURE';
    throw err;
  }

  const calc = await computeEmployeePayslip(employeeRow, year, month);
  const periodLabel = `${year}-${String(month).padStart(2, '0')}`;
  const basename = payslipBasename(employeeRow.id, year, month);
  const tmpPath = path.join(os.tmpdir(), `payslip-${employeeRow.id}-${year}-${month}-${Date.now()}.pdf`);

  await writePayslipPdf({
    outputPath: tmpPath,
    employee: {
      fullName: employeeRow.full_name,
      employeeCode: employeeRow.employee_code,
      jobTitleName: employeeRow.job_title_name || null,
    },
    period: { year, month, label: periodLabel },
    breakdown: calc,
    signature: {
      signatureText: sig.signature_text,
      signedAt: sig.signed_at,
      ipAddress: sig.ip_address || null,
    },
  });

  let sha256 = null;
  if (pdfMode.mode === 's3') {
    const objectKey = s3ObjectKeyForBasename(basename);
    const meta = await putFileToS3(pdfMode.client, objectKey, tmpPath);
    sha256 = meta.sha256;
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    await db.run(
      `UPDATE payslip_signatures
       SET pdf_path = ?, pdf_storage_key = ?, pdf_sha256 = ?, pdf_generated_at = NOW(), updated_at = NOW(), updated_by = ?
       WHERE employee_id = ? AND year = ? AND month = ?`,
      [basename, basename, sha256, actorEmployeeId, employeeRow.id, year, month]
    );
  } else {
    const destDir = pdfStorageRoot(PROJECT_ROOT);
    fs.mkdirSync(destDir, { recursive: true });
    const finalPath = path.join(destDir, basename);
    try {
      fs.renameSync(tmpPath, finalPath);
    } catch {
      fs.copyFileSync(tmpPath, finalPath);
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
    }
    try {
      const buf = fs.readFileSync(finalPath);
      sha256 = require('crypto').createHash('sha256').update(buf).digest('hex');
    } catch {
      sha256 = null;
    }
    await db.run(
      `UPDATE payslip_signatures
       SET pdf_path = ?, pdf_storage_key = ?, pdf_sha256 = ?, pdf_generated_at = NOW(), updated_at = NOW(), updated_by = ?
       WHERE employee_id = ? AND year = ? AND month = ?`,
      [basename, basename, sha256, actorEmployeeId, employeeRow.id, year, month]
    );
  }

  return { basename };
}

async function ensurePayslipPdfForDownload(employeeRow, year, month, actorEmployeeId) {
  const sig = await db.get(
    `SELECT id, pdf_path, pdf_storage_key, pdf_generated_at FROM payslip_signatures WHERE employee_id = ? AND year = ? AND month = ?`,
    [employeeRow.id, year, month]
  );
  if (!sig) {
    return { error: 'NOT_SIGNED' };
  }
  const basename = payslipBasenameFromRow(sig);
  if (!basename) {
    const gen = await generatePayslipPdfFile(employeeRow, year, month, actorEmployeeId);
    if (pdfMode.mode === 's3') {
      const key = s3ObjectKeyForBasename(gen.basename);
      const url = await presignedPdfGetUrl(pdfMode.client, key, PRESIGN_TTL_SECONDS);
      return { kind: 'redirect', url };
    }
    const absPath = resolveLocalPdfPath(PROJECT_ROOT, gen.basename);
    if (!absPath || !fs.existsSync(absPath)) {
      return { error: 'PDF_MISSING' };
    }
    return { kind: 'file', absPath };
  }

  if (pdfMode.mode === 's3') {
    if (!sig.pdf_generated_at) {
      await generatePayslipPdfFile(employeeRow, year, month, actorEmployeeId);
    }
    const key = s3ObjectKeyForBasename(basename);
    const url = await presignedPdfGetUrl(pdfMode.client, key, PRESIGN_TTL_SECONDS);
    return { kind: 'redirect', url };
  }

  const resolved = resolveLocalPdfPath(PROJECT_ROOT, basename);
  if (resolved && fs.existsSync(resolved)) {
    return { kind: 'file', absPath: resolved };
  }
  await generatePayslipPdfFile(employeeRow, year, month, actorEmployeeId);
  const absPath2 = resolveLocalPdfPath(PROJECT_ROOT, basename);
  if (!absPath2 || !fs.existsSync(absPath2)) {
    return { error: 'PDF_MISSING' };
  }
  return { kind: 'file', absPath: absPath2 };
}

const app = express();
if (process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', 1);
}

const origins = parseFrontendOrigins();
if (origins.length) {
  app.use(
    cors({
      origin: origins,
      credentials: true,
    })
  );
}

app.use(
  helmet({
    contentSecurityPolicy: NODE_ENV === 'production' ? undefined : false,
  })
);

app.use(
  pinoHttp({
    logger,
    autoLogging: { ignore: (req) => req.url === '/api/health' },
    serializers: {
      req(req) {
        return {
          method: req.method,
          url: req.url,
          remoteAddress: req.remoteAddress,
          remotePort: req.remotePort,
        };
      },
    },
  })
);

app.use(express.json({ limit: '512kb' }));
app.use(cookieParser());
app.use(
  session({
    name: 'sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts; try again later.' },
});

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId || !sessionIsAdmin(req)) {
    return res.status(403).json({ error: 'Admin only.' });
  }
  next();
}

function issueCsrf(req) {
  const crypto = require('crypto');
  const token = crypto.randomBytes(32).toString('hex');
  req.session.csrfToken = token;
  return token;
}

function verifyCsrf(req, res, next) {
  const header = req.get('x-csrf-token');
  if (!header || !req.session.csrfToken || header !== req.session.csrfToken) {
    return res.status(403).json({ error: 'Invalid or missing CSRF token.' });
  }
  next();
}

function isUniqueConstraintError(err) {
  if (!err) return false;
  if (err.code === '23505') return true;
  const msg = String(err.message || err);
  return msg.includes('UNIQUE') || msg.includes('unique constraint');
}

async function buildPayslipPayload(employeeRow, year, month, options = {}) {
  const viewerEmployeeId = options.viewerEmployeeId;
  const entry = await getPayrollEntryForEmployee(employeeRow.id, year, month);
  const calc = await computeEmployeePayslip(employeeRow, year, month);

  const sig = await db.get(
    `SELECT id, signature_text, signed_at, ip_address, pdf_path, pdf_storage_key, pdf_sha256, pdf_generated_at FROM payslip_signatures
     WHERE employee_id = ? AND year = ? AND month = ?`,
    [employeeRow.id, year, month]
  );

  const generatedAt = new Date().toISOString();
  const periodLabel = `${year}-${String(month).padStart(2, '0')}`;
  const mayDownloadPdf =
    Boolean(sig) &&
    viewerEmployeeId != null &&
    Number(viewerEmployeeId) === Number(employeeRow.id);

  return {
    period: { year, month, label: periodLabel },
    employee: {
      fullName: employeeRow.full_name,
      employeeCode: employeeRow.employee_code,
      jobPost: jobPostPayload(employeeRow),
      jobTitle: jobTitlePayload(employeeRow),
    },
    generatedAt,
    inputs: {
      overtimeHours: entry.overtime_hours,
      bonusCents: entry.bonus_cents,
      otherDeductionCents: entry.other_deduction_cents,
    },
    breakdown: {
      baseSalaryMonthlyCents: calc.baseSalaryMonthlyCents,
      overtimePayCents: calc.overtimePayCents,
      bonusCents: calc.bonusCents,
      grossCents: calc.grossCents,
      deductions: calc.deductions,
      netCents: calc.netCents,
    },
    signature: sig
      ? {
          payslipSignatureId: sig.id,
          signed: true,
          signatureText: sig.signature_text,
          signedAt: sig.signed_at,
          ipAddress: sig.ip_address || null,
          pdfReady: payslipPdfFileExists(sig),
          pdfGeneratedAt: sig.pdf_generated_at || null,
          pdfUrl: mayDownloadPdf ? `/api/payslip/${year}/${month}/pdf` : null,
        }
      : { signed: false, payslipSignatureId: null, pdfReady: false, pdfGeneratedAt: null, pdfUrl: null },
  };
}

const distDir = path.join(PROJECT_ROOT, '..', 'frontend', 'dist');
if (NODE_ENV === 'production' && fs.existsSync(distDir)) {
  app.use(express.static(distDir));
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/csrf-token', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Login first.' });
  }
  const token = issueCsrf(req);
  res.json({ csrfToken: token });
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { usernameOrEmail, password } = req.body || {};
  const id = typeof usernameOrEmail === 'string' ? usernameOrEmail.trim() : '';
  const pw = typeof password === 'string' ? password : '';
  if (!id || !pw) {
    return res.status(400).json({ error: 'Username or email and password are required.' });
  }
  const user = await findEmployeeByLogin(id);
  if (!user) {
    await bcrypt.hash(pw, 10);
    logger.warn({ event: 'login_failed', reason: 'unknown_user', identifierType: id.includes('@') ? 'email' : 'username' }, 'login failed');
    return res.status(401).json({ error: 'Invalid credentials.' });
  }
  const ok = await bcrypt.compare(pw, user.password_hash);
  if (!ok) {
    logger.warn({ event: 'login_failed', reason: 'bad_password' }, 'login failed');
    return res.status(401).json({ error: 'Invalid credentials.' });
  }
  req.session.userId = user.id;
  req.session.role = user.role;
  req.session.isAdmin = isAdminJobPostCode(user.job_post_code);
  issueCsrf(req);
  logger.info(
    { event: 'login_success', employeeId: user.id, role: user.role, isAdmin: req.session.isAdmin },
    'login success'
  );
  res.json({
    csrfToken: req.session.csrfToken,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      fullName: user.full_name,
      employeeCode: user.employee_code,
      role: user.role,
      isAdmin: Boolean(req.session.isAdmin),
      jobPost: jobPostPayload(user),
      jobTitle: jobTitlePayload(user),
    },
  });
});

app.post('/api/auth/logout', requireAuth, verifyCsrf, (req, res) => {
  const uid = req.session.userId;
  req.session.destroy(() => {
    res.clearCookie('sid');
    logger.info({ event: 'logout', employeeId: uid }, 'logout');
    res.json({ ok: true });
  });
});

app.get('/api/auth/me', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not logged in.' });
  }
  const user = await getEmployeeById(req.session.userId);
  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'Session invalid.' });
  }
  req.session.isAdmin = isAdminJobPostCode(user.job_post_code);
  res.json({
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      fullName: user.full_name,
      employeeCode: user.employee_code,
      role: user.role,
      isAdmin: Boolean(req.session.isAdmin),
      jobPost: jobPostPayload(user),
      jobTitle: jobTitlePayload(user),
    },
  });
});

app.get('/api/employee/payslip-periods', requireAuth, async (req, res) => {
  const user = await getEmployeeById(req.session.userId);
  if (!user || user.role !== 'employee') {
    return res.status(403).json({ error: 'Employees only.' });
  }
  const yearFilter = parseOptionalInt(req.query.year);
  const monthFilter = parseOptionalInt(req.query.month);
  const clauses = ['pe.employee_id = ?'];
  const params = [user.id];
  if (yearFilter != null) {
    clauses.push('pe.year = ?');
    params.push(yearFilter);
  }
  if (monthFilter != null) {
    clauses.push('pe.month = ?');
    params.push(monthFilter);
  }
  const where = clauses.join(' AND ');
  const rows = await db.all(
    `SELECT pe.year, pe.month, ps.id AS payslip_signature_id,
            CASE WHEN ps.id IS NULL THEN 0 ELSE 1 END AS signed,
            ps.pdf_generated_at
     FROM payroll_entries pe
     LEFT JOIN payslip_signatures ps
       ON ps.employee_id = pe.employee_id AND ps.year = pe.year AND ps.month = pe.month
     WHERE ${where}
     ORDER BY pe.year DESC, pe.month DESC`,
    params
  );
  res.json({ periods: rows });
});

app.get('/api/payslip', requireAuth, async (req, res) => {
  const period = parsePeriod(req.query.year, req.query.month);
  if (!period) {
    return res.status(400).json({ error: 'Invalid year or month.' });
  }
  const user = await getEmployeeById(req.session.userId);
  if (!user || user.role !== 'employee') {
    if (user && sessionIsAdmin(req)) {
      return res.status(403).json({ error: 'Admins use employee lookup to view payslips.' });
    }
    return res.status(404).json({ error: 'Employee not found.' });
  }
  res.json(await buildPayslipPayload(user, period.year, period.month, { viewerEmployeeId: user.id }));
});

app.get('/api/payslip/:year/:month/pdf', requireAuth, async (req, res) => {
  try {
    const user = await getEmployeeById(req.session.userId);
    if (!user || user.role !== 'employee') {
      if (user && sessionIsAdmin(req)) {
        return res.status(403).json({ error: 'Download this PDF while signed in as the employee.' });
      }
      return res.status(404).json({ error: 'Employee not found.' });
    }
    const period = parsePeriod(req.params.year, req.params.month);
    if (!period) {
      return res.status(400).json({ error: 'Invalid year or month.' });
    }
    const result = await ensurePayslipPdfForDownload(user, period.year, period.month, user.id);
    if (result.error === 'NOT_SIGNED') {
      return res.status(404).json({
        error: 'Payslip is not signed for this period; the PDF is created after digital attestation.',
      });
    }
    if (result.error === 'PDF_MISSING') {
      return res.status(500).json({ error: 'PDF is not available.' });
    }
    logger.info(
      {
        event: 'payslip_pdf_served',
        employeeId: user.id,
        year: period.year,
        month: period.month,
        storage: pdfMode.mode,
      },
      'payslip PDF served'
    );
    if (result.kind === 'redirect' && result.url) {
      return res.redirect(302, result.url);
    }
    if (result.kind === 'file' && result.absPath) {
      const downloadName = `payslip-${period.year}-${String(period.month).padStart(2, '0')}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
      return res.sendFile(result.absPath, (err) => {
        if (err) {
          logger.error({ err, event: 'payslip_pdf_send_error', employeeId: user.id }, 'could not send PDF');
          if (!res.headersSent) {
            res.status(500).json({ error: 'Could not send PDF.' });
          }
        }
      });
    }
    return res.status(500).json({ error: 'Unexpected PDF response.' });
  } catch (e) {
    logger.error({ err: e, event: 'payslip_pdf_route_error' }, 'PDF route error');
    if (!res.headersSent) {
      res.status(500).json({ error: 'PDF generation failed.' });
    }
  }
});

app.post('/api/payslip/sign', requireAuth, verifyCsrf, async (req, res) => {
  try {
    const user = await getEmployeeById(req.session.userId);
    if (!user || user.role !== 'employee') {
      return res.status(403).json({ error: 'Only employees may sign payslips.' });
    }
    const period = parsePeriod(req.body?.year, req.body?.month);
    if (!period) {
      return res.status(400).json({ error: 'Invalid year or month.' });
    }
    const sigText = typeof req.body?.signatureFullName === 'string' ? req.body.signatureFullName.trim() : '';
    if (!sigText || sigText.length > 200) {
      return res.status(400).json({ error: 'Typed full name signature is required (max 200 chars).' });
    }
    const expected = user.full_name.trim().replace(/\s+/g, ' ');
    const got = sigText.replace(/\s+/g, ' ');
    if (got.toLowerCase() !== expected.toLowerCase()) {
      return res.status(400).json({
        error:
          'Signature must exactly match your full name on file (case-insensitive). This attests you reviewed the payslip.',
      });
    }

    const existing = await db.get(
      `SELECT id FROM payslip_signatures WHERE employee_id = ? AND year = ? AND month = ?`,
      [user.id, period.year, period.month]
    );
    if (existing) {
      return res.status(409).json({ error: 'This payslip period is already signed.' });
    }

    const ip = req.ip || req.connection?.remoteAddress || null;
    const signedAt = new Date().toISOString();

    try {
      await db.run(
        `INSERT INTO payslip_signatures (
           employee_id, year, month, signature_text, signed_at, ip_address,
           created_by, updated_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [user.id, period.year, period.month, got, signedAt, ip, user.id, user.id]
      );
    } catch (e) {
      if (isUniqueConstraintError(e)) {
        return res.status(409).json({ error: 'This payslip period is already signed.' });
      }
      throw e;
    }

    logger.info(
      {
        event: 'payslip_signed',
        employeeId: user.id,
        year: period.year,
        month: period.month,
        ip: ip || undefined,
      },
      'payslip signed'
    );

    try {
      await generatePayslipPdfFile(user, period.year, period.month, user.id);
      logger.info(
        {
          event: 'payslip_pdf_generated',
          employeeId: user.id,
          year: period.year,
          month: period.month,
        },
        'payslip PDF generated after sign'
      );
    } catch (e) {
      logger.error({ err: e, event: 'payslip_pdf_generation_failed', employeeId: user.id }, 'PDF generation failed after sign');
    }

    res.json({
      ok: true,
      signature: { signatureText: got, signedAt, ipAddress: ip },
    });
  } catch (e) {
    logger.error({ err: e, event: 'payslip_sign_error' }, 'sign error');
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error.' });
    }
  }
});

app.post('/api/employee/payslips/print-zip', requireAuth, verifyCsrf, async (req, res) => {
  try {
    const user = await getEmployeeById(req.session.userId);
    if (!user || user.role !== 'employee') {
      return res.status(403).json({ error: 'Employees only.' });
    }
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((n) => Number(n)).filter((n) => Number.isInteger(n)) : [];
    if (!ids.length) {
      return res.status(400).json({ error: 'ids array required.' });
    }
    if (ids.length > BULK_PRINT_MAX) {
      return res.status(413).json({ error: `Too many payslips (max ${BULK_PRINT_MAX}).` });
    }
    const placeholders = ids.map(() => '?').join(',');
    const rows = await db.all(
      `SELECT ps.id AS payslip_signature_id, ps.employee_id, ps.year, ps.month, e.employee_code, e.full_name
       FROM payslip_signatures ps
       JOIN employees e ON e.id = ps.employee_id
       WHERE ps.id IN (${placeholders}) AND ps.employee_id = ? AND e.role = 'employee'`,
      [...ids, user.id]
    );
    if (rows.length !== ids.length) {
      return res.status(400).json({ error: 'Invalid selection or payslips not found.' });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="my-payslips.zip"');

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => {
      logger.error({ err, event: 'employee_zip_error' }, 'zip archive error');
      if (!res.headersSent) res.status(500).end();
      else res.destroy(err);
    });
    archive.pipe(res);

    for (const row of rows) {
      const opened = await openPayslipPdfReadStream(user, row.year, row.month, user.id);
      if (opened.error || !opened.stream) continue;
      const name = `payslip-${row.year}-${String(row.month).padStart(2, '0')}.pdf`;
      archive.append(opened.stream, { name });
    }
    await archive.finalize();
    logger.info({ event: 'employee_bulk_print', count: rows.length, employeeId: user.id }, 'employee zip print');
  } catch (e) {
    logger.error({ err: e, event: 'employee_bulk_print_error' }, 'employee zip print failed');
    if (!res.headersSent) res.status(500).json({ error: 'Print failed.' });
  }
});

app.get('/api/admin/employee/:code/payslip', requireAuth, requireAdmin, async (req, res) => {
  const code = String(req.params.code || '').trim();
  if (!code) {
    return res.status(400).json({ error: 'Employee code required.' });
  }
  const period = parsePeriod(req.query.year, req.query.month);
  if (!period) {
    return res.status(400).json({ error: 'Invalid year or month.' });
  }
  const employee = await db.get(
    `${employeeSelectBase}
     WHERE LOWER(e.employee_code) = LOWER(?) AND e.role = 'employee'`,
    [code]
  );
  if (!employee) {
    return res.status(404).json({ error: 'Employee not found.' });
  }
  res.json(
    await buildPayslipPayload(employee, period.year, period.month, { viewerEmployeeId: req.session.userId })
  );
});

async function openPayslipPdfReadStream(employeeRow, year, month, actorEmployeeId) {
  const sig = await db.get(
    `SELECT id, pdf_path, pdf_storage_key, pdf_generated_at FROM payslip_signatures WHERE employee_id = ? AND year = ? AND month = ?`,
    [employeeRow.id, year, month]
  );
  if (!sig) {
    return { error: 'NOT_SIGNED' };
  }
  let basename = payslipBasenameFromRow(sig);
  if (!basename || !sig.pdf_generated_at) {
    await generatePayslipPdfFile(employeeRow, year, month, actorEmployeeId);
    basename = payslipBasename(employeeRow.id, year, month);
  }
  if (pdfMode.mode === 's3') {
    const key = s3ObjectKeyForBasename(basename);
    const stream = await getObjectBodyStream(pdfMode.client, key);
    return { stream };
  }
  const absPath = resolveLocalPdfPath(PROJECT_ROOT, basename);
  if (!absPath || !fs.existsSync(absPath)) {
    return { error: 'PDF_MISSING' };
  }
  return { stream: fs.createReadStream(absPath) };
}

function buildAdminSignatureWhereClause(year, month, q) {
  const parts = [`e.role = 'employee'`];
  const params = [];
  if (year != null) {
    params.push(year);
    parts.push(`ps.year = ?`);
  }
  if (month != null) {
    params.push(month);
    parts.push(`ps.month = ?`);
  }
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    parts.push(`LOWER(e.full_name) LIKE ?`);
  }
  return { whereSql: parts.join(' AND '), params };
}

app.get('/api/admin/payslips', requireAuth, requireAdmin, async (req, res) => {
  const year = parseOptionalInt(req.query.year);
  const month = parseOptionalInt(req.query.month);
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const page = Math.max(1, parseOptionalInt(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, parseOptionalInt(req.query.pageSize) || 20));
  const { whereSql, params: baseParams } = buildAdminSignatureWhereClause(year, month, q);
  const countRow = await db.get(
    `SELECT COUNT(*)::int AS c
     FROM payslip_signatures ps
     JOIN employees e ON e.id = ps.employee_id
     WHERE ${whereSql}`,
    baseParams
  );
  const lim = pageSize;
  const off = (page - 1) * lim;
  const rows = await db.all(
    `SELECT ps.id AS payslip_signature_id, ps.employee_id, ps.year, ps.month,
            ps.pdf_generated_at, ps.pdf_storage_key, ps.pdf_path,
            e.full_name, e.employee_code
     FROM payslip_signatures ps
     JOIN employees e ON e.id = ps.employee_id
     WHERE ${whereSql}
     ORDER BY ps.year DESC, ps.month DESC, e.full_name ASC
     LIMIT ? OFFSET ?`,
    [...baseParams, lim, off]
  );
  res.json({
    total: countRow?.c ?? 0,
    page,
    pageSize: lim,
    items: rows,
  });
});

async function collectSignatureRowsForBulkPrint(body) {
  const ids = Array.isArray(body?.ids) ? body.ids.map((n) => Number(n)).filter((n) => Number.isInteger(n)) : [];
  const items = Array.isArray(body?.items) ? body.items : [];
  const filter = body?.filter && typeof body.filter === 'object' ? body.filter : null;

  const modes = [ids.length > 0, items.length > 0, Boolean(filter)].filter(Boolean);
  if (modes.length !== 1) {
    const err = new Error('Specify exactly one of: ids, items, or filter.');
    err.code = 'BAD_BULK_BODY';
    throw err;
  }

  if (ids.length > 0) {
    if (ids.length > BULK_PRINT_MAX) {
      const err = new Error(`Too many payslips (max ${BULK_PRINT_MAX}).`);
      err.code = 'PAYLOAD_TOO_LARGE';
      throw err;
    }
    const placeholders = ids.map(() => '?').join(',');
    return db.all(
      `SELECT ps.id AS payslip_signature_id, ps.employee_id, ps.year, ps.month, e.employee_code, e.full_name
       FROM payslip_signatures ps
       JOIN employees e ON e.id = ps.employee_id
       WHERE ps.id IN (${placeholders}) AND e.role = 'employee'`,
      ids
    );
  }

  if (items.length > 0) {
    if (items.length > BULK_PRINT_MAX) {
      const err = new Error(`Too many payslips (max ${BULK_PRINT_MAX}).`);
      err.code = 'PAYLOAD_TOO_LARGE';
      throw err;
    }
    const rows = [];
    for (const it of items) {
      const employeeId = Number(it?.employeeId);
      const period = parsePeriod(it?.year, it?.month);
      if (!Number.isInteger(employeeId) || !period) continue;
      const row = await db.get(
        `SELECT ps.id AS payslip_signature_id, ps.employee_id, ps.year, ps.month, e.employee_code, e.full_name
         FROM payslip_signatures ps
         JOIN employees e ON e.id = ps.employee_id
         WHERE ps.employee_id = ? AND ps.year = ? AND ps.month = ? AND e.role = 'employee'`,
        [employeeId, period.year, period.month]
      );
      if (row) rows.push(row);
    }
    return rows;
  }

  const fy = parseOptionalInt(filter.year);
  const fm = parseOptionalInt(filter.month);
  const fq = typeof filter.q === 'string' ? filter.q.trim() : '';
  const { whereSql, params: baseParams } = buildAdminSignatureWhereClause(fy, fm, fq);
  const rows = await db.all(
    `SELECT ps.id AS payslip_signature_id, ps.employee_id, ps.year, ps.month, e.employee_code, e.full_name
     FROM payslip_signatures ps
     JOIN employees e ON e.id = ps.employee_id
     WHERE ${whereSql}
     ORDER BY ps.year DESC, ps.month DESC, e.full_name ASC
     LIMIT ?`,
    [...baseParams, BULK_PRINT_MAX + 1]
  );
  if (rows.length > BULK_PRINT_MAX) {
    const err = new Error(`Too many payslips for filter (max ${BULK_PRINT_MAX}). Narrow year/month/name.`);
    err.code = 'PAYLOAD_TOO_LARGE';
    throw err;
  }
  return rows;
}

app.post('/api/admin/payslips/bulk-print', requireAuth, requireAdmin, verifyCsrf, async (req, res) => {
  try {
    let rows;
    try {
      rows = await collectSignatureRowsForBulkPrint(req.body || {});
    } catch (e) {
      if (e && e.code === 'PAYLOAD_TOO_LARGE') {
        return res.status(413).json({ error: e.message });
      }
      if (e && e.code === 'BAD_BULK_BODY') {
        return res.status(400).json({ error: e.message });
      }
      throw e;
    }
    if (!rows.length) {
      return res.status(400).json({ error: 'No matching signed payslips.' });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="payslips.zip"');

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => {
      logger.error({ err, event: 'admin_zip_error' }, 'zip archive error');
      if (!res.headersSent) {
        res.status(500).end();
      } else {
        res.destroy(err);
      }
    });
    archive.pipe(res);

    const actorId = req.session.userId;
    for (const row of rows) {
      const employee = await getEmployeeById(row.employee_id);
      if (!employee || employee.role !== 'employee') continue;
      const opened = await openPayslipPdfReadStream(employee, row.year, row.month, actorId);
      if (opened.error || !opened.stream) continue;
      const name = `payslip-${row.employee_code}-${row.year}-${String(row.month).padStart(2, '0')}.pdf`;
      archive.append(opened.stream, { name });
    }
    await archive.finalize();
    logger.info({ event: 'admin_bulk_print', count: rows.length, actorId }, 'admin bulk print zip');
  } catch (e) {
    logger.error({ err: e, event: 'admin_bulk_print_error' }, 'admin bulk print failed');
    if (!res.headersSent) {
      res.status(500).json({ error: 'Bulk print failed.' });
    }
  }
});

app.post('/api/admin/payslips/presign-bulk', requireAuth, requireAdmin, verifyCsrf, async (req, res) => {
  try {
    if (pdfMode.mode !== 's3') {
      return res.status(400).json({ error: 'Presigned URLs are only used when S3 storage is configured.' });
    }
    let rows;
    try {
      rows = await collectSignatureRowsForBulkPrint(req.body || {});
    } catch (e) {
      if (e && e.code === 'PAYLOAD_TOO_LARGE') {
        return res.status(413).json({ error: e.message });
      }
      if (e && e.code === 'BAD_BULK_BODY') {
        return res.status(400).json({ error: e.message });
      }
      throw e;
    }
    const actorId = req.session.userId;
    const urls = [];
    for (const row of rows) {
      const employee = await getEmployeeById(row.employee_id);
      if (!employee || employee.role !== 'employee') continue;
      const sigRow = await db.get(
        `SELECT pdf_generated_at FROM payslip_signatures WHERE employee_id = ? AND year = ? AND month = ?`,
        [row.employee_id, row.year, row.month]
      );
      if (!sigRow) continue;
      if (!sigRow.pdf_generated_at) {
        await generatePayslipPdfFile(employee, row.year, row.month, actorId);
      }
      const basename = payslipBasename(row.employee_id, row.year, row.month);
      const key = s3ObjectKeyForBasename(basename);
      const url = await presignedPdfGetUrl(pdfMode.client, key, PRESIGN_TTL_SECONDS);
      urls.push({
        payslipSignatureId: row.payslip_signature_id,
        employeeId: row.employee_id,
        year: row.year,
        month: row.month,
        url,
        expiresInSeconds: PRESIGN_TTL_SECONDS,
      });
    }
    res.json({ urls });
  } catch (e) {
    logger.error({ err: e, event: 'admin_presign_bulk_error' }, 'admin presign bulk failed');
    res.status(500).json({ error: 'Presign failed.' });
  }
});

app.use((err, req, res, _next) => {
  req.log?.error({ err }, 'unhandled error');
  if (!req.log) {
    logger.error({ err }, 'unhandled error');
  }
  res.status(500).json({ error: 'Internal server error.' });
});

async function main() {
  if (SESSION_SECRET === 'dev-only-change-me' && NODE_ENV === 'production') {
    logger.warn('SESSION_SECRET is using the insecure default; set a strong secret in production.');
  }

  assertProductionPdfStorageConfigured();
  pdfMode = getPdfStorageMode();

  try {
    db = await openDatabase();
  } catch (e) {
    logger.fatal({ err: e }, 'database configuration failed');
    process.exit(1);
  }

  try {
    await migrate(db);
    await db.ping();
  } catch (e) {
    logger.fatal({ err: e }, 'database migration or connection failed');
    try {
      await db.close();
    } catch {
      /* ignore */
    }
    process.exit(1);
  }

  if (NODE_ENV === 'production' && fs.existsSync(distDir)) {
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      return res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, () => {
    logger.info(
      { port: PORT, database: db.databaseLabel, pdfStorage: pdfMode.mode, presignTtlSeconds: PRESIGN_TTL_SECONDS },
      'payslip app listening'
    );
  });
}

main().catch((e) => {
  logger.fatal({ err: e }, 'startup failed');
  process.exit(1);
});
