// Builds the §2 baseline in the qa_ui schema for the manual/browser UI checks (never touches real data).
import { qa } from './helpers.js';
const ctx = await qa('qa_ui', { clock: '2026-10-26T09:05' });
await ctx.as(ctx.tok.hr).post('/announcements', { title: '<script>alert(1)</script> XSS test', body: '<img src=x onerror=alert(2)> body', audience: 'all' });
console.log(JSON.stringify({ tokens: Object.keys(ctx.tok), temp: 'not printed' }));
await ctx.close();
