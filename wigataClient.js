// Wrapper tipis untuk Wigata Intech Payment API.
// Fokus: token auth, create payment Virtual Account/QRIS, dan cek status payment.

const DEFAULT_BASE_URL = 'https://api-stg.wigataintech.com/monolithic';

const BASE_URL = process.env.WIGATA_BASE_URL || DEFAULT_BASE_URL;
const MERCHANT_ID = process.env.WIGATA_MERCHANT_ID;
const API_KEY = process.env.WIGATA_API_KEY;

const BANK_CODES = Object.freeze({
  PERMATA: '013',
  BRI: '002',
  MANDIRI: '008',
  BCA: '014',
  CIMB: '022',
  BNC: '490',
});

const TERMINAL_PAYMENT_STATUSES = new Set(['SUCCESS', 'FAILED', 'EXPIRED', 'CANCELLED']);

let tokenCache = {
  accessToken: null,
  refreshToken: null,
  accessExpiredAt: null,
};

function assertConfigured() {
  const missing = [];
  if (!MERCHANT_ID) missing.push('WIGATA_MERCHANT_ID');
  if (!API_KEY) missing.push('WIGATA_API_KEY');

  if (missing.length > 0) {
    throw new Error(`Konfigurasi Wigata belum lengkap: ${missing.join(', ')}`);
  }

  const isStagingUrl = /(^|[./-])stg[./-]|api-stg/i.test(BASE_URL);
  const isProductionKey = /^wigata_prd_/i.test(API_KEY);
  const isStagingKey = /^wigata_stg_/i.test(API_KEY);

  if (isProductionKey && isStagingUrl) {
    throw new Error('WIGATA_API_KEY production tidak cocok dengan WIGATA_BASE_URL staging. Pakai key staging atau ganti base URL ke production dari Wigata.');
  }

  if (isStagingKey && !isStagingUrl) {
    throw new Error('WIGATA_API_KEY staging tidak cocok dengan WIGATA_BASE_URL production. Pakai key production atau ganti base URL ke staging.');
  }
}

function isExpiringSoon(date, bufferMs = 60_000) {
  if (!date) return true;
  return Date.now() >= new Date(date).getTime() - bufferMs;
}

function normalizeAmount(amount) {
  const parsed = Number(amount);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('Amount harus berupa angka lebih dari 0');
  }
  return parsed;
}

function buildExpiredAt(expiredInHours) {
  if (expiredInHours === undefined || expiredInHours === null || expiredInHours === '') {
    return null;
  }

  const hours = Number(expiredInHours);
  if (!Number.isInteger(hours) || hours < 1 || hours > 24) {
    throw new Error('Expired time harus 1 sampai 24 jam');
  }

  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function buildClientReferenceId(prefix = 'PAY') {
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}-${Date.now()}-${random}`;
}

async function readJsonResponse(res) {
  const text = await res.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function requireOkResponse(res, json, fallbackMessage) {
  if (!res.ok || json.code === 'ERR_UNAUTHORIZED' || json.code?.startsWith?.('ERR_')) {
    const message = json.message || json.error || fallbackMessage || `HTTP ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.response = json;
    throw err;
  }
}

async function requestNewToken() {
  assertConfigured();

  const res = await fetch(`${BASE_URL}/api/v1/access-token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Merchant-ID': MERCHANT_ID,
      'X-API-Key': API_KEY,
    },
    body: JSON.stringify({ grant_type: 'client_credentials' }),
  });

  const json = await readJsonResponse(res);
  requireOkResponse(res, json, 'Gagal generate access token');

  tokenCache = {
    accessToken: json.data.access_token,
    refreshToken: json.data.refresh_token,
    accessExpiredAt: json.data.access_expired_at,
  };

  return tokenCache.accessToken;
}

async function refreshTokenIfPossible() {
  assertConfigured();

  if (!tokenCache.refreshToken) {
    return requestNewToken();
  }

  const res = await fetch(`${BASE_URL}/api/v1/access-token/refresh`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Merchant-ID': MERCHANT_ID,
    },
    body: JSON.stringify({ refresh_token: tokenCache.refreshToken }),
  });

  const json = await readJsonResponse(res);
  if (!res.ok || json.code !== 'OK') {
    return requestNewToken();
  }

  tokenCache = {
    accessToken: json.data.access_token,
    refreshToken: json.data.refresh_token || tokenCache.refreshToken,
    accessExpiredAt: json.data.access_expired_at,
  };

  return tokenCache.accessToken;
}

async function getAccessToken() {
  if (!tokenCache.accessToken) {
    return requestNewToken();
  }

  if (isExpiringSoon(tokenCache.accessExpiredAt)) {
    return refreshTokenIfPossible();
  }

  return tokenCache.accessToken;
}

async function authedRequest(path, options = {}, retried = false) {
  const token = await getAccessToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'X-Merchant-ID': MERCHANT_ID,
      ...(options.headers || {}),
    },
  });

  const json = await readJsonResponse(res);

  if (res.status === 401 && !retried) {
    await refreshTokenIfPossible();
    return authedRequest(path, options, true);
  }

  requireOkResponse(res, json, 'Request ke Wigata gagal');
  return json;
}

function buildPaymentPayload({
  amount,
  paymentMethod,
  bankCode,
  descriptionName,
  statementDescriptor,
  clientReferenceId,
  expiredInHours,
  addPaymentFeeToSurcharge = false,
  generatePaymentLink = true,
}) {
  const expiredAt = buildExpiredAt(expiredInHours);
  const payload = {
    client_reference_id: clientReferenceId || buildClientReferenceId(paymentMethod === 'QRIS' ? 'QRIS' : 'VA'),
    currency: 'IDR',
    amount: normalizeAmount(amount),
    payment_method: paymentMethod,
    statement_descriptor: statementDescriptor || descriptionName || 'Pembayaran',
    config: {
      add_payment_payment_fee_to_surcharge: Boolean(addPaymentFeeToSurcharge),
    },
  };

  if (expiredAt) {
    payload.expired_at = expiredAt;
  }

  if (process.env.WIGATA_CALLBACK_URL) {
    payload.callback_url = process.env.WIGATA_CALLBACK_URL;
  }

  if (generatePaymentLink) {
    payload.payment_link = {
      generate: true,
    };

    if (process.env.PAYMENT_SUCCESS_REDIRECT_URL) {
      payload.payment_link.success_redirect_url = process.env.PAYMENT_SUCCESS_REDIRECT_URL;
    }
    if (process.env.PAYMENT_FAILED_REDIRECT_URL) {
      payload.payment_link.failed_redirect_url = process.env.PAYMENT_FAILED_REDIRECT_URL;
    }
    if (process.env.PAYMENT_EXPIRED_REDIRECT_URL) {
      payload.payment_link.expired_redirect_url = process.env.PAYMENT_EXPIRED_REDIRECT_URL;
    }
  }

  if (paymentMethod === 'VIRTUAL_ACCOUNT') {
    if (!bankCode) {
      throw new Error('Bank wajib dipilih untuk Virtual Account');
    }

    payload.payment_method_option = {
      bank_code: bankCode,
      description_name: descriptionName || 'Pembayaran',
    };
  }

  return payload;
}

async function createPayment(input) {
  const payload = buildPaymentPayload(input);
  return authedRequest('/api/v1/payment', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

function createVirtualAccountPayment(input) {
  return createPayment({
    ...input,
    paymentMethod: 'VIRTUAL_ACCOUNT',
  });
}

function createQrisPayment(input) {
  return createPayment({
    ...input,
    paymentMethod: 'QRIS',
  });
}

function getPaymentById(id) {
  if (!id) throw new Error('Payment ID wajib diisi');
  return authedRequest(`/api/v1/payment/${encodeURIComponent(id)}`, { method: 'GET' });
}

function getAvailablePaymentMethods() {
  return authedRequest('/api/v1/payment/available-method', { method: 'GET' });
}

module.exports = {
  BANK_CODES,
  TERMINAL_PAYMENT_STATUSES,
  createPayment,
  createVirtualAccountPayment,
  createQrisPayment,
  getPaymentById,
  getAvailablePaymentMethods,
};
