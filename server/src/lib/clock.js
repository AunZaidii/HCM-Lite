// The server's single source of "now". In production this is always the real time.
// Tests (NODE_ENV=test) can freeze it to check time rules (09:15 late, 5 h half day, month ends) without sleeping.
let fixed = null;

export const now = () => (fixed ? new Date(fixed.getTime()) : new Date());

export function setTestNow(value) {
  if (process.env.NODE_ENV !== 'test') throw new Error('The clock can only be changed in tests');
  fixed = value ? new Date(value) : null;
}

export const isTestClock = () => process.env.NODE_ENV === 'test';
