require('dotenv').config();

const path = require('path');
const cors = require('cors');
const express = require('express');
const {
  BANK_CODES,
  TERMINAL_PAYMENT_STATUSES,
  createVirtualAccountPayment,
  createQrisPayment,
  getPaymentById,
  getAvailablePaymentMethods,
} = require('./wigataClient');

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function sendError(res, err) {
  const status = err.status && err.status >= 400 ? err.status : 500;
  const message = err.message || 'Terjadi kesalahan';
  const hint =
    /merchant auth not found|invalid api key|invalid merchant/i.test(message)
      ? 'Cek WIGATA_MERCHANT_ID, WIGATA_API_KEY, dan WIGATA_BASE_URL. Credential staging harus dipakai dengan base URL staging.'
      : null;

  res.status(status).json({
    ok: false,
    message,
    hint,
    detail: err.response || null,
  });
}

function pickPaymentData(wigataResponse) {
  return wigataResponse.data || null;
}

function normalizeCreateBody(body) {
  return {
    amount: body.amount,
    bankCode: body.bankCode,
    descriptionName: body.descriptionName,
    statementDescriptor: body.statementDescriptor,
    clientReferenceId: body.clientReferenceId,
    expiredInHours: body.expiredInHours,
    addPaymentFeeToSurcharge: body.addPaymentFeeToSurcharge,
    generatePaymentLink: body.generatePaymentLink !== false,
  };
}

app.get('/api/config', (_req, res) => {
  res.json({
    ok: true,
    data: {
      banks: BANK_CODES,
      hasCredential: Boolean(process.env.WIGATA_MERCHANT_ID && process.env.WIGATA_API_KEY),
    },
  });
});

app.get('/api/payment-methods', async (_req, res) => {
  try {
    const response = await getAvailablePaymentMethods();
    res.json({ ok: true, data: response.data });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/payments/virtual-account', async (req, res) => {
  try {
    const response = await createVirtualAccountPayment(normalizeCreateBody(req.body));
    res.json({ ok: true, data: pickPaymentData(response), raw: response });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/payments/qris', async (req, res) => {
  try {
    const response = await createQrisPayment(normalizeCreateBody(req.body));
    res.json({ ok: true, data: pickPaymentData(response), raw: response });
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/payments/:id', async (req, res) => {
  try {
    const response = await getPaymentById(req.params.id);
    const data = pickPaymentData(response);
    res.json({
      ok: true,
      data,
      isTerminal: TERMINAL_PAYMENT_STATUSES.has(data?.status),
      raw: response,
    });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/wigata/callback', (req, res) => {
  console.log('[wigata callback]', JSON.stringify(req.body, null, 2));
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Wigata payment interface running at http://localhost:${PORT}`);
});
