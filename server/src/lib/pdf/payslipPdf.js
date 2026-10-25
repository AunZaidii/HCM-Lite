import PDFDocument from 'pdfkit';

const money = (n) => `PKR ${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Streams a one-page payslip PDF. Nothing is stored; the payslip row is the source of truth.
export function renderPayslipPdf(stream, { payslip: p, companyName, monthLabel }) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.pipe(stream);
  const s = p.employeeSnapshot;

  doc.rect(0, 0, doc.page.width, 90).fill('#1f2a44');
  doc.fill('#ffffff').fontSize(20).text(companyName, 50, 28);
  doc.fontSize(11).text(`Payslip — ${monthLabel}`, 50, 56);
  doc.fill('#111827');

  doc.moveDown(3);
  const info = [
    ['Employee', `${s.name} (${s.code})`],
    ['Department', s.department || '-'],
    ['Designation', s.designation || '-'],
    ['Working days in month', String(p.workingDays)],
    ['Employed working days', `${p.employedWorkingDays} (proration ${p.prorationFactor})`],
    ['Status', p.runStatus === 'finalized' ? 'Finalized' : 'DRAFT'],
  ];
  let y = 115;
  for (const [k, v] of info) {
    doc.fontSize(10).fillColor('#6b7280').text(k, 50, y).fillColor('#111827').text(v, 220, y);
    y += 18;
  }

  const table = (title, rows, startY) => {
    doc.fontSize(12).fillColor('#0f766e').text(title, 50, startY);
    let ty = startY + 20;
    for (const [k, v, bold] of rows) {
      doc.fontSize(10).fillColor('#111827').font(bold ? 'Helvetica-Bold' : 'Helvetica').text(k, 60, ty).text(v, 350, ty, { width: 190, align: 'right' });
      ty += 18;
    }
    doc.font('Helvetica');
    return ty + 10;
  };

  y = table('Earnings', [
    ['Basic', money(p.basic)],
    ['House rent allowance (40%)', money(p.hra)],
    ['Medical allowance (10%)', money(p.medical)],
    ['Gross (1.5 × basic)', money(p.gross), true],
    ['Prorated gross', money(p.proratedGross), true],
  ], y + 15);

  y = table('Deductions', [
    [`Absent days: ${p.absentDays} · Unpaid leave: ${p.unpaidLeaveDays} · Half days: ${p.halfDays} (×0.5)`, ''],
    ...(Number(p.latePenaltyDays) > 0 ? [[`Late penalty (${p.lateCount} lates): ${p.latePenaltyDays} day(s)`, '']] : []),
    [`Deduction days ${p.deductionDays} × per day ${money(p.perDayRate)}`, money(p.deductionAmount)],
    ['Income tax (slab on gross × 12, monthly)', money(p.tax)],
  ], y);

  doc.rect(50, y, doc.page.width - 100, 36).fill('#ecfdf5');
  doc.fill('#065f46').fontSize(14).font('Helvetica-Bold').text('Net pay', 60, y + 11).text(money(p.netPay), 350, y + 11, { width: 190, align: 'right' });
  doc.font('Helvetica').fill('#6b7280').fontSize(8)
    .text('System-generated payslip from HCM Lite. Tax slab is illustrative.', 50, doc.page.height - 70);
  doc.end();
}
