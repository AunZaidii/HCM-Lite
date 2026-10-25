import { env } from './config/env.js';
import { app } from './app.js';
import { bootstrapEnvAdmin } from './modules/auth.routes.js';

try {
  await bootstrapEnvAdmin();
} catch (err) {
  console.error('Admin bootstrap skipped:', err.message);
}

app.listen(env.PORT, () => console.log(`HCM Lite API on http://localhost:${env.PORT}/api`));
