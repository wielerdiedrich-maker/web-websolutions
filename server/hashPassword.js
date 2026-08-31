#!/usr/bin/env node
// Usage: node server/hashPassword.js "YourStrongPassword"
const bcrypt = require('bcryptjs');

const password = process.argv[2];
if (!password) {
  console.error('Usage: node server/hashPassword.js "YourStrongPassword"');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 12);
console.log('\nAdd this to your .env file:\n');
console.log(`ADMIN_PASSWORD_HASH=${hash}\n`);
