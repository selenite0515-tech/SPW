/// <reference types="vite/client" />

import './style.css';

interface User {
  id: number;
  username: string;
  email: string;
  fullName: string;
  employeeCode: string;
  role: string;
  isAdmin?: boolean;
  jobPost?: { code: string; name: string } | null;
  jobTitle?: { code: string; name: string } | null;
}

interface PayslipPeriod {
  year: number;
  month: number;
  payslip_signature_id: number | null;
  signed: number;
  pdf_generated_at: string | null;
}

const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

function apiUrl(path: string): string {
  if (!path.startsWith('/')) return `${API_BASE}/${path}`;
  return API_BASE ? `${API_BASE}${path}` : path;
}

let csrfToken = '';

function centsToUsd(cents: number): string {
  const n = Number(cents) / 100;
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
}

async function api<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };
  if (options.method && options.method !== 'GET' && csrfToken) {
    headers['X-CSRF-Token'] = csrfToken;
  }
  if (!headers['Content-Type'] && options.body && typeof options.body === 'string') {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(apiUrl(path), {
    credentials: 'include',
    headers,
    ...options,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text || 'Invalid JSON' };
  }
  if (!res.ok) {
    const err = new Error((data as { error?: string })?.error || res.statusText);
    (err as Error & { status: number; body: unknown }).status = res.status;
    (err as Error & { status: number; body: unknown }).body = data;
    throw err;
  }
  return data as T;
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el;
}

function show(el: HTMLElement, on: boolean): void {
  el.classList.toggle('hidden', !on);
}

function setError(el: HTMLElement, msg: string): void {
  if (!msg) {
    show(el, false);
    el.textContent = '';
    return;
  }
  el.textContent = msg;
  show(el, true);
}

function fillMonthSelect(sel: HTMLSelectElement): void {
  sel.innerHTML = '';
  for (let m = 1; m <= 12; m += 1) {
    const opt = document.createElement('option');
    opt.value = String(m);
    opt.textContent = new Date(2000, m - 1, 1).toLocaleString(undefined, { month: 'long' });
    sel.appendChild(opt);
  }
}

async function refreshCsrf(): Promise<void> {
  const data = await api<{ csrfToken: string }>('/api/csrf-token');
  csrfToken = data.csrfToken;
}

function renderAppShell(): void {
  const app = $('app');
  app.innerHTML = `
    <header class="topbar">
      <div class="brand">Payslip Portal</div>
      <div id="auth-bar" class="auth-bar hidden"></div>
    </header>
    <main class="wrap">
      <section id="view-login" class="card">
        <h1>Employee login</h1>
        <p class="muted">Use your <strong>username or email</strong> and password.</p>
        <form id="form-login" class="stack">
          <label>Username or email<input type="text" name="usernameOrEmail" autocomplete="username" required /></label>
          <label>Password<input type="password" name="password" autocomplete="current-password" required /></label>
          <button type="submit">Sign in</button>
          <p id="login-error" class="error hidden"></p>
        </form>
      </section>
      <section id="view-app" class="hidden">
        <div class="card">
          <div class="row spread">
            <div>
              <h1 id="welcome-title">Welcome</h1>
              <p class="muted" id="welcome-sub"></p>
            </div>
            <button type="button" id="btn-logout" class="secondary">Log out</button>
          </div>
        </div>
        <div id="employee-panel" class="hidden">
          <div class="card">
            <h2>Your payslip periods</h2>
            <p class="muted small">Payroll periods with signing and print. Filter by year or month.</p>
            <div class="row">
              <label>Year <input type="number" id="flt-year" min="2000" max="2100" /></label>
              <label>Month <select id="flt-month"><option value="">Any</option></select></label>
              <button type="button" id="btn-reload-periods">Apply filter</button>
            </div>
            <div class="table-wrap">
              <table class="data-table" id="periods-table">
                <thead><tr><th></th><th>Period</th><th>Status</th><th>Actions</th></tr></thead>
                <tbody id="periods-body"></tbody>
              </table>
            </div>
            <p id="periods-error" class="error hidden"></p>
            <div class="row" style="margin-top:0.75rem">
              <button type="button" id="btn-print-selected" class="secondary">Print selected (ZIP)</button>
            </div>
          </div>
          <div id="payslip-card" class="card hidden">
            <p id="payslip-error" class="error hidden"></p>
            <div class="row spread">
              <div>
                <h2 id="payslip-period"></h2>
                <p class="muted" id="payslip-meta"></p>
              </div>
              <div class="pill" id="payslip-status"></div>
            </div>
            <table class="grid-table">
              <tbody>
                <tr><td>Base salary (monthly)</td><td class="num" id="line-base"></td></tr>
                <tr><td>Overtime pay</td><td class="num" id="line-ot"></td></tr>
                <tr><td>Bonus</td><td class="num" id="line-bonus"></td></tr>
                <tr class="strong"><td>Gross</td><td class="num" id="line-gross"></td></tr>
                <tr><td>Income tax (from gross)</td><td class="num neg" id="line-tax"></td></tr>
                <tr><td>Retirement (from gross)</td><td class="num neg" id="line-ret"></td></tr>
                <tr><td>Other deductions</td><td class="num neg" id="line-other"></td></tr>
                <tr class="strong"><td>Net pay</td><td class="num" id="line-net"></td></tr>
              </tbody>
            </table>
            <div id="sign-block" class="sign-block hidden">
              <h3>Digital attestation</h3>
              <p class="muted small">Type your <strong>full legal name</strong> exactly as on file.</p>
              <form id="form-sign" class="stack narrow">
                <label>Type your full name to sign<input type="text" id="sign-name" autocomplete="name" /></label>
                <button type="submit">Sign payslip</button>
                <p id="sign-error" class="error hidden"></p>
              </form>
            </div>
            <div id="signed-block" class="signed-banner hidden">
              <strong>Signed</strong><span id="signed-details"></span>
            </div>
            <p id="pdf-download-wrap" class="pdf-download hidden">
              <a id="pdf-download-link" class="secondary" href="#" download>Download signed payslip (PDF)</a>
            </p>
          </div>
        </div>
        <div id="admin-panel" class="hidden">
          <div class="card">
            <h2>Admin: payslips</h2>
            <p class="muted small">Access from job post <strong>ADM</strong> / ADMIN. Bulk ZIP capped at 200 payslips per request.</p>
            <div class="row">
              <label>Year <input type="number" id="adm-year" min="2000" max="2100" /></label>
              <label>Month <select id="adm-month"></select></label>
              <label>Name contains <input type="text" id="adm-q" placeholder="doe" /></label>
              <button type="button" id="adm-search">Search</button>
            </div>
            <div class="table-wrap">
              <table class="data-table">
                <thead><tr><th></th><th>Employee</th><th>Code</th><th>Period</th><th>PDF</th></tr></thead>
                <tbody id="adm-body"></tbody>
              </table>
            </div>
            <p id="adm-error" class="error hidden"></p>
            <div class="row">
              <button type="button" id="adm-print-sel" class="secondary">Print selected (ZIP)</button>
              <button type="button" id="adm-print-filter" class="secondary">Print all in filter (ZIP)</button>
            </div>
            <details class="muted small" style="margin-top:0.75rem">
              <summary>Legacy JSON lookup by code</summary>
              <div class="row" style="margin-top:0.5rem">
                <label>Code <input type="text" id="admin-code" placeholder="E001" /></label>
                <label>Year <input type="number" id="admin-year" min="2000" max="2100" /></label>
                <label>Month <select id="admin-month"></select></label>
                <button type="button" id="admin-load">Load</button>
              </div>
              <pre id="admin-json" class="json-out hidden"></pre>
            </details>
          </div>
        </div>
      </section>
    </main>
  `;
}

const selectedSigIds = new Set<number>();
const adminSelectedSigIds = new Set<number>();

async function loadPeriods(): Promise<void> {
  setError($('periods-error') as HTMLElement, '');
  const y = ($('flt-year') as HTMLInputElement).value;
  const m = ($('flt-month') as HTMLSelectElement).value;
  const qs = new URLSearchParams();
  if (y) qs.set('year', y);
  if (m) qs.set('month', m);
  const path = `/api/employee/payslip-periods${qs.toString() ? `?${qs}` : ''}`;
  const data = await api<{ periods: PayslipPeriod[] }>(path);
  const body = $('periods-body');
  body.innerHTML = '';
  selectedSigIds.clear();
  for (const p of data.periods) {
    const tr = document.createElement('tr');
    const periodLabel = `${p.year}-${String(p.month).padStart(2, '0')}`;
    const chkDisabled = !p.signed || !p.payslip_signature_id;
    tr.innerHTML = `
      <td><input type="checkbox" class="period-sel" data-year="${p.year}" data-month="${p.month}" data-sig="${p.payslip_signature_id ?? ''}" ${chkDisabled ? 'disabled' : ''} /></td>
      <td>${periodLabel}</td>
      <td>${p.signed ? 'Signed' : 'Unsigned'}</td>
      <td><button type="button" class="secondary btn-open-period" data-year="${p.year}" data-month="${p.month}">${p.signed ? 'Open' : 'Sign'}</button></td>
    `;
    body.appendChild(tr);
  }
  body.querySelectorAll('.btn-open-period').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const year = Number((btn as HTMLButtonElement).dataset.year);
      const month = Number((btn as HTMLButtonElement).dataset.month);
      await loadPayslipDetail(year, month);
    });
  });
  body.querySelectorAll('.period-sel').forEach((el) => {
    el.addEventListener('change', () => {
      const inp = el as HTMLInputElement;
      const id = Number(inp.dataset.sig);
      if (!id) return;
      if (inp.checked) selectedSigIds.add(id);
      else selectedSigIds.delete(id);
    });
  });
}

async function loadPayslipDetail(year: number, month: number): Promise<void> {
  setError($('payslip-error') as HTMLElement, '');
  const p = await api<Record<string, unknown>>(`/api/payslip?year=${encodeURIComponent(year)}&month=${encodeURIComponent(month)}`);
  renderPayslip(p);
}

function renderPayslip(p: Record<string, unknown>): void {
  show($('payslip-card'), true);
  const period = p.period as { year: number; month: number; label: string };
  const employee = p.employee as {
    fullName: string;
    employeeCode: string;
    jobPost?: { code: string; name: string } | null;
    jobTitle?: { code: string; name: string } | null;
  };
  $('payslip-period').textContent = `Payslip · ${period.label}`;
  const jp = employee.jobPost;
  const jt = employee.jobTitle;
  const jobSuffix =
    jp || jt
      ? ` · ${[jp ? `${jp.name} (${jp.code})` : null, jt ? `${jt.name} (${jt.code})` : null].filter(Boolean).join(' · ')}`
      : '';
  $('payslip-meta').textContent = `Generated at ${new Date(p.generatedAt as string).toLocaleString()} · Employee ${employee.employeeCode}${jobSuffix}`;

  const b = p.breakdown as Record<string, unknown>;
  const ded = b.deductions as Record<string, number>;
  $('line-base').textContent = centsToUsd(b.baseSalaryMonthlyCents as number);
  $('line-ot').textContent = centsToUsd(b.overtimePayCents as number);
  $('line-bonus').textContent = centsToUsd(b.bonusCents as number);
  $('line-gross').textContent = centsToUsd(b.grossCents as number);
  $('line-tax').textContent = `−${centsToUsd(ded.incomeTaxCents)}`;
  $('line-ret').textContent = `−${centsToUsd(ded.retirementCents)}`;
  $('line-other').textContent = `−${centsToUsd(ded.otherCents)}`;
  $('line-net').textContent = centsToUsd(b.netCents as number);

  const sig = p.signature as Record<string, unknown>;
  const signed = Boolean(sig.signed);
  $('payslip-status').textContent = signed ? 'Signed' : 'Awaiting signature';
  ( $('payslip-status') as HTMLElement ).style.borderColor = signed ? 'rgba(52,211,153,0.5)' : '';

  show($('sign-block'), !signed);
  show($('signed-block'), signed);
  ($('form-sign') as HTMLFormElement).dataset.year = String(period.year);
  ($('form-sign') as HTMLFormElement).dataset.month = String(period.month);
  ($('sign-name') as HTMLInputElement).value = '';

  if (signed) {
    $('signed-details').textContent = ` · ${sig.signatureText} · ${new Date(sig.signedAt as string).toLocaleString()}${
      sig.ipAddress ? ` · IP ${sig.ipAddress}` : ''
    }`;
  }

  const pdfWrap = $('pdf-download-wrap');
  const pdfLink = $('pdf-download-link') as HTMLAnchorElement;
  const pdfUrl = sig.pdfUrl as string | null;
  if (signed && pdfUrl) {
    pdfLink.href = apiUrl(pdfUrl);
    pdfLink.setAttribute('download', '');
    show(pdfWrap, true);
  } else {
    show(pdfWrap, false);
    pdfLink.removeAttribute('href');
  }
  setError($('sign-error') as HTMLElement, '');
}

async function enterApp(user: User): Promise<void> {
  show($('view-login'), false);
  show($('view-app'), true);
  show($('auth-bar'), true);
  const admin = Boolean(user.isAdmin);
  $('auth-bar').textContent = `${user.fullName} · ${user.role}${admin ? ' · admin (ADM post)' : ''}`;

  $('welcome-title').textContent = `Hello, ${user.fullName}`;
  const jobBits: string[] = [];
  if (user.jobPost) jobBits.push(`${user.jobPost.name} (${user.jobPost.code})`);
  if (user.jobTitle) jobBits.push(`${user.jobTitle.name} (${user.jobTitle.code})`);
  const jobLine = jobBits.length ? ` · ${jobBits.join(' · ')}` : '';
  $('welcome-sub').textContent = admin
    ? `Signed in with administrator access (job post ADM/ADMIN).${jobLine}`
    : `Select a period to view or sign your payslip.${jobLine}`;

  const isEmployee = user.role === 'employee';
  show($('employee-panel'), isEmployee);
  show($('admin-panel'), admin);

  if (isEmployee) {
    await refreshCsrf();
    const fltMonth = $('flt-month') as HTMLSelectElement;
    fillMonthSelect(fltMonth);
    fltMonth.insertAdjacentHTML('afterbegin', '<option value="">Any</option>');
    const now = new Date();
    ($('flt-year') as HTMLInputElement).value = String(now.getFullYear());
    await loadPeriods();
  }
  if (admin) {
    await refreshCsrf();
    const admMonth = $('adm-month') as HTMLSelectElement;
    fillMonthSelect(admMonth);
    admMonth.insertAdjacentHTML('afterbegin', '<option value="">Any</option>');
    fillMonthSelect($('admin-month') as HTMLSelectElement);
    ($('adm-year') as HTMLInputElement).value = String(new Date().getFullYear());
    ($('admin-year') as HTMLInputElement).value = String(new Date().getFullYear());
    await runAdminSearch();
  }
}

async function runAdminSearch(): Promise<void> {
  setError($('adm-error') as HTMLElement, '');
  const year = ($('adm-year') as HTMLInputElement).value;
  const month = ($('adm-month') as HTMLSelectElement).value;
  const q = ($('adm-q') as HTMLInputElement).value.trim();
  const qs = new URLSearchParams({ page: '1', pageSize: '50' });
  if (year) qs.set('year', year);
  if (month) qs.set('month', month);
  if (q) qs.set('q', q);
  const data = await api<{
    items: Array<{
      payslip_signature_id: number;
      employee_id: number;
      year: number;
      month: number;
      full_name: string;
      employee_code: string;
      pdf_generated_at: string | null;
    }>;
  }>(`/api/admin/payslips?${qs}`);
  const body = $('adm-body');
  body.innerHTML = '';
  adminSelectedSigIds.clear();
  for (const row of data.items) {
    const tr = document.createElement('tr');
    const pdfOk = Boolean(row.pdf_generated_at);
    tr.innerHTML = `
      <td><input type="checkbox" class="adm-sel" data-id="${row.payslip_signature_id}" ${pdfOk ? '' : 'disabled'} /></td>
      <td>${row.full_name}</td>
      <td>${row.employee_code}</td>
      <td>${row.year}-${String(row.month).padStart(2, '0')}</td>
      <td>${pdfOk ? 'ready' : 'pending'}</td>
    `;
    body.appendChild(tr);
  }
  body.querySelectorAll('.adm-sel').forEach((el) => {
    el.addEventListener('change', () => {
      const inp = el as HTMLInputElement;
      const id = Number(inp.dataset.id);
      if (inp.checked) adminSelectedSigIds.add(id);
      else adminSelectedSigIds.delete(id);
    });
  });
}

async function downloadZipFromApi(path: string, body: unknown, filename: string): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = res.statusText;
    try {
      const j = JSON.parse(text);
      msg = j.error || msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function wireEvents(): void {
  $('form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target as HTMLFormElement);
    const usernameOrEmail = String(fd.get('usernameOrEmail') || '').trim();
    const password = String(fd.get('password') || '');
    setError($('login-error') as HTMLElement, '');
    try {
      const data = await api<{ csrfToken: string; user: User }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ usernameOrEmail, password }),
      });
      csrfToken = data.csrfToken;
      await enterApp(data.user);
    } catch (err) {
      setError($('login-error') as HTMLElement, (err as Error).message || 'Login failed');
    }
  });

  $('btn-logout').addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST', body: JSON.stringify({}) });
    } catch {
      /* ignore */
    }
    csrfToken = '';
    show($('view-login'), true);
    show($('view-app'), false);
    show($('auth-bar'), false);
    show($('payslip-card'), false);
  });

  $('btn-reload-periods').addEventListener('click', () => loadPeriods().catch((err) => setError($('periods-error') as HTMLElement, err.message)));

  $('form-sign').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const year = Number(form.dataset.year);
    const month = Number(form.dataset.month);
    const signatureFullName = ($('sign-name') as HTMLInputElement).value.trim();
    setError($('sign-error') as HTMLElement, '');
    try {
      await api('/api/payslip/sign', {
        method: 'POST',
        body: JSON.stringify({ year, month, signatureFullName }),
      });
      const p = await api(`/api/payslip?year=${encodeURIComponent(year)}&month=${encodeURIComponent(month)}`);
      renderPayslip(p as Record<string, unknown>);
      await loadPeriods();
    } catch (err) {
      setError($('sign-error') as HTMLElement, (err as Error).message || 'Could not sign');
    }
  });

  $('btn-print-selected').addEventListener('click', async () => {
    setError($('periods-error') as HTMLElement, '');
    if (!selectedSigIds.size) {
      setError($('periods-error') as HTMLElement, 'Select at least one signed payslip.');
      return;
    }
    try {
      await refreshCsrf();
      await downloadZipFromApi('/api/employee/payslips/print-zip', { ids: [...selectedSigIds] }, 'my-payslips.zip');
    } catch (err) {
      setError($('periods-error') as HTMLElement, (err as Error).message);
    }
  });

  $('adm-search').addEventListener('click', () => runAdminSearch().catch((e) => setError($('adm-error') as HTMLElement, e.message)));

  $('adm-print-sel').addEventListener('click', async () => {
    setError($('adm-error') as HTMLElement, '');
    if (!adminSelectedSigIds.size) {
      setError($('adm-error') as HTMLElement, 'Select rows with ready PDFs.');
      return;
    }
    try {
      await refreshCsrf();
      await downloadZipFromApi('/api/admin/payslips/bulk-print', { ids: [...adminSelectedSigIds] }, 'payslips.zip');
    } catch (e) {
      setError($('adm-error') as HTMLElement, (e as Error).message);
    }
  });

  $('adm-print-filter').addEventListener('click', async () => {
    setError($('adm-error') as HTMLElement, '');
    const year = parseInt(($('adm-year') as HTMLInputElement).value, 10);
    const month = parseInt(($('adm-month') as HTMLSelectElement).value, 10);
    const q = ($('adm-q') as HTMLInputElement).value.trim();
    const filter: Record<string, unknown> = {};
    if (Number.isInteger(year)) filter.year = year;
    if (Number.isInteger(month)) filter.month = month;
    if (q) filter.q = q;
    try {
      await refreshCsrf();
      await downloadZipFromApi('/api/admin/payslips/bulk-print', { filter }, 'payslips-filtered.zip');
    } catch (e) {
      setError($('adm-error') as HTMLElement, (e as Error).message);
    }
  });

  $('admin-load').addEventListener('click', async () => {
    setError($('adm-error') as HTMLElement, '');
    const code = ($('admin-code') as HTMLInputElement).value.trim();
    const year = ($('admin-year') as HTMLInputElement).value;
    const month = ($('admin-month') as HTMLSelectElement).value;
    if (!code) {
      setError($('adm-error') as HTMLElement, 'Enter employee code');
      return;
    }
    try {
      const data = await api(
        `/api/admin/employee/${encodeURIComponent(code)}/payslip?year=${encodeURIComponent(year)}&month=${encodeURIComponent(month)}`
      );
      const pre = $('admin-json') as HTMLElement;
      pre.textContent = JSON.stringify(data, null, 2);
      show(pre, true);
    } catch (err) {
      show($('admin-json'), false);
      setError($('adm-error') as HTMLElement, (err as Error).message || 'Lookup failed');
    }
  });
}

async function bootstrap(): Promise<void> {
  renderAppShell();
  wireEvents();

  try {
    const me = await api<{ user: User }>('/api/auth/me');
    await enterApp(me.user);
  } catch {
    show($('view-login'), true);
    show($('view-app'), false);
  }
}

bootstrap().catch(console.error);
