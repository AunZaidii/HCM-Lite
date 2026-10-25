// Entry for serverless hosts (Vercel): exports the Express app instead of calling listen(). Local/Render use src/server.js.
import { app } from './src/app.js';
import { bootstrapEnvAdmin } from './src/modules/auth.routes.js';

bootstrapEnvAdmin().catch((err) => console.error('Admin bootstrap skipped:', err.message));

export default app;
