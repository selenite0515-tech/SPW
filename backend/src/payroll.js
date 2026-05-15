/**
 * Server-side payslip calculation.
 * Gross = monthly base + (overtime_hours × hourly overtime rate) + bonus
 * Deductions = income tax (gross × tax_rate) + retirement (gross × retirement_rate) + other (fixed cents for period)
 * Net = gross − sum(deductions)
 *
 * Rates are per-employee (basis points: 1500 = 15%).
 */

function computePayslip({
  baseSalaryMonthlyCents,
  overtimeHourlyRateCents,
  taxRateBps,
  retirementRateBps,
  overtimeHours,
  bonusCents,
  otherDeductionCents,
}) {
  const base = Math.floor(Number(baseSalaryMonthlyCents) || 0);
  const otRate = Math.floor(Number(overtimeHourlyRateCents) || 0);
  const otHours = Math.max(0, Number(overtimeHours) || 0);
  const bonus = Math.max(0, Math.floor(Number(bonusCents) || 0));
  const otherDed = Math.max(0, Math.floor(Number(otherDeductionCents) || 0));

  const overtimePayCents = Math.floor(otHours * otRate);
  const grossCents = base + overtimePayCents + bonus;

  const taxCents = Math.floor((grossCents * Math.min(10000, Math.max(0, taxRateBps))) / 10000);
  const retirementCents = Math.floor(
    (grossCents * Math.min(10000, Math.max(0, retirementRateBps))) / 10000
  );
  const totalDeductionsCents = taxCents + retirementCents + otherDed;
  const netCents = grossCents - totalDeductionsCents;

  return {
    baseSalaryMonthlyCents: base,
    overtimeHours: otHours,
    overtimeHourlyRateCents: otRate,
    overtimePayCents,
    bonusCents: bonus,
    grossCents,
    deductions: {
      incomeTaxCents: taxCents,
      retirementCents,
      otherCents: otherDed,
      totalCents: totalDeductionsCents,
    },
    netCents,
  };
}

module.exports = { computePayslip };
