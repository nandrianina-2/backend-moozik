// test-smtp.js — script de diagnostic isolé, à lancer avec : node test-smtp.js
require('dotenv').config();
const nodemailer = require('nodemailer');

console.log('── Diagnostic SMTP ──');
console.log('SMTP_USER :', JSON.stringify(process.env.SMTP_USER));
console.log('SMTP_PASS length :', process.env.SMTP_PASS?.length);
console.log('SMTP_PASS (masqué) :', process.env.SMTP_PASS?.replace(/./g, '*'));
console.log('SMTP_PASS has space :', process.env.SMTP_PASS?.includes(' '));
console.log('SMTP_PASS has quotes :', /['"]/.test(process.env.SMTP_PASS || ''));
console.log('──────────────────────');

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

transporter.verify((err, success) => {
  if (err) {
    console.error('❌ ÉCHEC de connexion SMTP :');
    console.error(err.message);
    process.exit(1);
  } else {
    console.log('✅ Connexion SMTP réussie ! Les identifiants sont valides.');
    process.exit(0);
  }
});
