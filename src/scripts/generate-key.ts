import crypto from 'node:crypto';

function generateRandomKey(): string {
  // Generate a random 32-byte key in hex format, prefixed with phi_
  return 'phi_' + crypto.randomBytes(32).toString('hex');
}

function scryptHash(secret: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(secret, salt, 64, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey.toString('hex'));
    });
  });
}

async function main() {
  const rawKey = generateRandomKey();
  const salt = crypto.randomBytes(16).toString('hex');
  const digest = await scryptHash(rawKey, salt);
  const keyHash = `scrypt$${salt}$${digest}`;
  const keyHint = `...${rawKey.slice(-6)}`;

  console.log('================================================================');
  console.log('                 PHI GATEWAY KEY GENERATOR                      ');
  console.log('================================================================');
  console.log('RAW BEARER TOKEN (SHOW ONLY ONCE, SAVE SECURELY):');
  console.log(rawKey);
  console.log('----------------------------------------------------------------');
  console.log('JSON CONFIG SNIPPET (Add to config/clients.json under "clients"):');
  console.log(JSON.stringify({
    client_id: "phi-backend",
    label: "PHI Backend",
    enabled: true,
    key_hash: keyHash,
    key_hint: keyHint,
    allowed_model_aliases: [
      "phi-parser",
      "phi-classifier",
      "phi-vision",
      "phi-audio-transcriber"
    ]
  }, null, 2));
  console.log('================================================================');
}

main().catch(error => {
  console.error('Failed to generate key:', error);
  process.exit(1);
});
