const bcrypt = require('bcryptjs');

const SALT_ROUNDS = 10;

async function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

// Generate a hash for initial setup
async function generateHash(password) {
  const hash = await hashPassword(password);
  console.log(`Password hash for "${password}": ${hash}`);
  return hash;
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateHash
};
