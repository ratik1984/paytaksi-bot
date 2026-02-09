import dotenv from 'dotenv';
dotenv.config();

import { startBot } from './src/bot.js';

startBot().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
