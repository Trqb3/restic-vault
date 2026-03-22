#!/usr/bin/env tsx
/**
 * Emergency admin user creation script.
 *
 * Usage (dev):
 *   npm run create-admin --workspace=backend -- <username> <password>
 *
 * Usage (production container):
 *   resticvault-create-admin <username> <password>
 *   # or directly:
 *   docker exec -it resticvault node dist/scripts/create-admin.js <username> <password>
 */

import 'dotenv/config';
import { getDb } from '../src/db/index.js';
import bcrypt from 'bcrypt';

const username = process.argv[2] as string | undefined;
const password = process.argv[3] as string | undefined;

if (!username || !password) {
  console.error('Usage: create-admin <username> <password>');
  console.error('Example: tsx scripts/create-admin.ts admin MySecurePassword123');
  process.exit(1);
}

if (username.length < 2 || username.length > 64 || !/^[a-zA-Z0-9_\-.]+$/.test(username)) {
  console.error('Error: Username must be 2–64 characters, alphanumeric, underscores, hyphens or dots only.');
  process.exit(1);
}

if (password.length < 8) {
  console.error('Error: Password must be at least 8 characters.');
  process.exit(1);
}

async function main() {
  try {
    // getDb() auto-runs migrations so the DB is always ready
    const db = getDb();

    const existing = db
      .prepare('SELECT id, role FROM users WHERE username = ?')
      .get(username) as { id: number; role: string } | undefined;

    const hash = await bcrypt.hash(password!, 12);

    if (existing) {
      // Update existing user to admin and reset password
      db.prepare('UPDATE users SET password_hash = ?, role = ? WHERE username = ?')
        .run(hash, 'admin', username);
      console.log(`✓ Updated existing user "${username}" — role set to admin, password reset.`);
    } else {
      // Create new admin user
      db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
        .run(username, hash, 'admin');
      console.log(`✓ Created admin user "${username}" successfully.`);
    }

    console.log(`\nYou can now log in at your ResticVault instance with:`);
    console.log(`  Username: ${username}`);
    console.log(`  Password: (the password you provided)`);
  } catch (err) {
    console.error('Error:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
