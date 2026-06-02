/**
 * gen-admin-hash.js
 *
 * Generates a bcrypt hash for your admin password.
 * Run once to get the value to put in ADMIN_PASSWORD_HASH.
 *
 * Usage:
 *   node scripts/gen-admin-hash.js
 *
 * Then enter your desired password when prompted.
 */

import bcrypt from 'bcryptjs';
import readline from 'readline';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('Enter admin password: ', async (password) => {
  rl.close();
  if (!password || password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }
  const hash = await bcrypt.hash(password, 12);
  console.log('\nAdd this to your .env.local and Vercel environment variables:\n');
  console.log(`ADMIN_PASSWORD_HASH=${hash}`);
  console.log('');
});
