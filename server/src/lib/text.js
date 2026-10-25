// "contains" pattern for ILIKE where the user's % and _ are literal characters, not wildcards.
export const containsPattern = (q) => `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// Neutralise spreadsheet formulas (CSV injection): a cell starting with = + - @ tab or CR is prefixed with '.
export const csvSafe = (v) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
export const csvSafeRows = (rows) => rows.map((r) => r.map(csvSafe));
