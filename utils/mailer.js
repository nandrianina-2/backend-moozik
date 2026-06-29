// utils/mailer.js
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true, // true pour le port 465 (SSL)
  auth: {
    user: process.env.SMTP_USER, // ton adresse Gmail
    pass: process.env.SMTP_PASS, // mot de passe d'application Gmail (16 caractères, PAS le mot de passe du compte)
  },
});

exports.sendMail = async ({ to, subject, html }) => {
  await transporter.sendMail({
    from: `"Moozik" <${process.env.SMTP_USER}>`,
    to,
    subject,
    html,
  });
};