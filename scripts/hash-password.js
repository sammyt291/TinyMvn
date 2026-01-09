#!/usr/bin/env node

const bcrypt = require('bcryptjs');

const password = process.argv[2];

if (!password) {
  console.log('Usage: node hash-password.js <password>');
  console.log('Example: node hash-password.js mysecretpassword');
  process.exit(1);
}

const SALT_ROUNDS = 10;

bcrypt.hash(password, SALT_ROUNDS, (err, hash) => {
  if (err) {
    console.error('Error hashing password:', err);
    process.exit(1);
  }
  
  console.log('\nPassword Hash Generated');
  console.log('=======================');
  console.log(`Password: ${password}`);
  console.log(`Hash: ${hash}`);
  console.log('\nAdd this to your config.json users array:');
  console.log(JSON.stringify({
    username: 'your-username',
    password: hash
  }, null, 2));
});
