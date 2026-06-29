// middleware/mvola.js
const axios = require('axios');

const MVOLA_URL = 'https://devapi.mvola.mg'; // prod: api.mvola.mg
const MVOLA_KEY = process.env.MVOLA_API_KEY;
const MVOLA_SECRET = process.env.MVOLA_API_SECRET;
const MVOLA_MERCHANT = process.env.MVOLA_MERCHANT_NUMBER; // ex: 0343500004

// Obtenir le token MVola
const getMvolaToken = async () => {
  const res = await axios.post(`${MVOLA_URL}/token`, 
    'grant_type=client_credentials&scope=EXT_INT_MVOLA_SCOPE',
    {
      headers: {
        'Authorization': `Basic ${Buffer.from(`${MVOLA_KEY}:${MVOLA_SECRET}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cache-Control': 'no-cache',
      }
    }
  );
  return res.data.access_token;
};

// Initier un paiement
const initMvolaPaiement = async ({ amount, phoneNumber, reference, description }) => {
  const token = await getMvolaToken();
  const correlationId = `MOOZIK-${Date.now()}`;

  const res = await axios.post(
    `${MVOLA_URL}/mvola/mm/transactions/type/merchantpay/1.0.0/`,
    {
      amount: String(amount),
      currency: 'Ar',
      descriptionText: description || 'Pourboire MOOZIK',
      requestingOrganisationTransactionReference: reference,
      debitParty: [{ key: 'msisdn', value: phoneNumber }],
      creditParty: [{ key: 'msisdn', value: MVOLA_MERCHANT }],
      metadata: [
        { key: 'partnerName', value: 'MOOZIK' },
        { key: 'fc', value: 'USD' },
        { key: 'amountFc', value: '1' },
      ],
      requestDate: new Date().toISOString(),
    },
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'correlationID': correlationId,
        'UserLanguage': 'mg',
        'UserAccountIdentifier': `msisdn;${MVOLA_MERCHANT}`,
        'partnerName': 'MOOZIK',
        'X-Callback-URL': `${process.env.BACKEND_URL}/push/mvola-callback`,
      }
    }
  );
  return { ...res.data, correlationId };
};

module.exports = { initMvolaPaiement };

