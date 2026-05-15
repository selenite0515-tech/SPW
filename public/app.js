/** @typedef {{ csrfToken: string, user: { id:number, username:string, email:string, fullName:string, employeeCode:string, role:string, jobPost?:{code:string,name:string}|null, jobTitle?:{code:string,name:string}|null }}} LoginResponse */

const $ = (id) => document.getElementById(id);

let csrfToken = '';

function centsToUsd(cents) {
  const n = Number(cents) / 100;
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.method && options.method !== 'GET' && csrfToken) {
    headers['X-CSRF-Token'] = csrfToken;
  }
  const res = await fetch(path, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    ...options,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text || 'Invalid JSON' };
  }
  if (!res.ok) {
    const err = new Error(data?.error || res.statusText);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

function fillMonthSelect(sel) {
  sel.innerHTML = '';
  for (let m = 1; m <= 12; m += 1) {
    const opt = document.createElement('option');
    opt.value = String(m);
    opt.textContent = new Date(2000, m - 1, 1).toLocaleString(undefined, { month: 'long' });
    sel.appendChild(opt);
  }
}

function show(el, on) {
  el.classList.toggle('hidden', !on);
}

function setError(el, msg) {
  if (!msg) {
    show(el, false);
    el.textContent = '';
    return;
  }
  el.textContent = msg;
  show(el, true);
}

async function refreshCsrf() {
  const data = await api('/api/csrf-token');
  csrfToken = data.csrfToken;
}

async function bootstrap() {
  fillMonthSelect($('sel-month'));
  fillMonthSelect($('admin-month'));
  const now = new Date();
  $('sel-year').value = String(now.getFullYear());
  $('sel-month').value = String(now.getMonth() + 1);
  $('admin-year').value = String(now.getFullYear());
  $('admin-month').value = String(now.getMonth() + 1);

  try {
    const me = await api('/api/auth/me');
    await enterApp(me.user);
  } catch {
    show($('view-login'), true);
    show($('view-app'), false);
  }
}

async function enterApp(user) {
  show($('view-login'), false);
  show($('view-app'), true);
  show($('auth-bar'), true);
  $('auth-bar').textContent = `${user.fullName} · ${user.role}`;

  $('welcome-title').textContent = `Hello, ${user.fullName}`;
  const jobBits = [];
  if (user.jobPost) jobBits.push(`${user.jobPost.name} (${user.jobPost.code})`);
  if (user.jobTitle) jobBits.push(`${user.jobTitle.name} (${user.jobTitle.code})`);
  const jobLine = jobBits.length ? ` · ${jobBits.join(' · ')}` : '';
  $('welcome-sub').textContent =
    user.role === 'admin'
      ? `You are signed in as an administrator.${jobLine}`
      : `Select a period to view your payslip. Amounts are calculated on the server.${jobLine}`;

  const isAdmin = user.role === 'admin';
  const isEmployee = user.role === 'employee';
  show($('employee-panel'), isEmployee);
  show($('admin-panel'), isAdmin);

  if (isEmployee) {
    await refreshCsrf();
  }
  if (isAdmin) {
    await refreshCsrf();
  }
}

$('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const usernameOrEmail = String(fd.get('usernameOrEmail') || '').trim();
  const password = String(fd.get('password') || '');
  setError($('login-error'), '');
  try {
    /** @type {LoginResponse} */
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ usernameOrEmail, password }),
    });
    csrfToken = data.csrfToken;
    await enterApp(data.user);
  } catch (err) {
    setError($('login-error'), err.message || 'Login failed');
  }
});

$('btn-logout').addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST', body: JSON.stringify({}) });
  } catch {
    /* still clear UI */
  }
  csrfToken = '';
  show($('view-login'), true);
  show($('view-app'), false);
  show($('auth-bar'), false);
  show($('payslip-card'), false);
});

$('btn-load-payslip').addEventListener('click', async () => {
  setError($('payslip-error'), '');
  const year = $('sel-year').value;
  const month = $('sel-month').value;
  try {
    const p = await api(`/api/payslip?year=${encodeURIComponent(year)}&month=${encodeURIComponent(month)}`);
    renderPayslip(p);
  } catch (err) {
    setError($('payslip-error'), err.message || 'Could not load payslip');
    show($('payslip-card'), false);
  }
});

function renderPayslip(p) {
  show($('payslip-card'), true);
  $('payslip-period').textContent = `Payslip · ${p.period.label}`;
  const jp = p.employee.jobPost;
  const jt = p.employee.jobTitle;
  const jobSuffix =
    jp || jt
      ? ` · ${[jp ? `${jp.name} (${jp.code})` : null, jt ? `${jt.name} (${jt.code})` : null].filter(Boolean).join(' · ')}`
      : '';
  $('payslip-meta').textContent = `Generated at ${new Date(p.generatedAt).toLocaleString()} · Employee ${p.employee.employeeCode}${jobSuffix}`;

  const b = p.breakdown;
  $('line-base').textContent = centsToUsd(b.baseSalaryMonthlyCents);
  $('line-ot').textContent = centsToUsd(b.overtimePayCents);
  $('line-bonus').textContent = centsToUsd(b.bonusCents);
  $('line-gross').textContent = centsToUsd(b.grossCents);
  $('line-tax').textContent = `−${centsToUsd(b.deductions.incomeTaxCents)}`;
  $('line-ret').textContent = `−${centsToUsd(b.deductions.retirementCents)}`;
  $('line-other').textContent = `−${centsToUsd(b.deductions.otherCents)}`;
  $('line-net').textContent = centsToUsd(b.netCents);

  const signed = p.signature.signed;
  $('payslip-status').textContent = signed ? 'Signed' : 'Awaiting signature';
  $('payslip-status').style.borderColor = signed ? 'rgba(52,211,153,0.5)' : '';

  show($('sign-block'), !signed);
  show($('signed-block'), signed);
  $('sign-ip-note').textContent = '(and IP address where available)';

  $('form-sign').dataset.year = String(p.period.year);
  $('form-sign').dataset.month = String(p.period.month);
  $('sign-name').value = '';

  if (signed) {
    $('signed-details').textContent = ` · ${p.signature.signatureText} · ${new Date(p.signature.signedAt).toLocaleString()}${
      p.signature.ipAddress ? ` · IP ${p.signature.ipAddress}` : ''
    }`;
  }

  const pdfWrap = $('pdf-download-wrap');
  const pdfLink = $('pdf-download-link');
  if (signed && p.signature.pdfUrl) {
    pdfLink.href = p.signature.pdfUrl;
    pdfLink.setAttribute('download', '');
    show(pdfWrap, true);
  } else {
    show(pdfWrap, false);
    pdfLink.removeAttribute('href');
  }
  setError($('sign-error'), '');
}

$('form-sign').addEventListener('submit', async (e) => {
  e.preventDefault();
  const year = Number($('form-sign').dataset.year);
  const month = Number($('form-sign').dataset.month);
  const signatureFullName = $('sign-name').value.trim();
  setError($('sign-error'), '');
  try {
    await api('/api/payslip/sign', {
      method: 'POST',
      body: JSON.stringify({ year, month, signatureFullName }),
    });
    const p = await api(`/api/payslip?year=${encodeURIComponent(year)}&month=${encodeURIComponent(month)}`);
    renderPayslip(p);
  } catch (err) {
    setError($('sign-error'), err.message || 'Could not sign');
  }
});

$('admin-load').addEventListener('click', async () => {
  setError($('admin-error'), '');
  const code = $('admin-code').value.trim();
  const year = $('admin-year').value;
  const month = $('admin-month').value;
  if (!code) {
    setError($('admin-error'), 'Enter employee code');
    return;
  }
  try {
    const data = await api(
      `/api/admin/employee/${encodeURIComponent(code)}/payslip?year=${encodeURIComponent(year)}&month=${encodeURIComponent(month)}`
    );
    $('admin-json').textContent = JSON.stringify(data, null, 2);
    show($('admin-json'), true);
  } catch (err) {
    show($('admin-json'), false);
    setError($('admin-error'), err.message || 'Lookup failed');
  }
});

bootstrap();
