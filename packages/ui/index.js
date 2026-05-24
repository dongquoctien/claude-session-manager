import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the static web UI directory (served by the agent). */
export const publicDir = path.join(__dirname, 'public');
