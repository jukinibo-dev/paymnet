const state = {
  method: 'VIRTUAL_ACCOUNT',
  paymentId: null,
  pollTimer: null,
};

const els = {
  credentialBadge: document.querySelector('#credentialBadge'),
  methodButtons: document.querySelectorAll('[data-method]'),
  bankField: document.querySelector('#bankField'),
  form: document.querySelector('#paymentForm'),
  submitButton: document.querySelector('#submitButton'),
  emptyState: document.querySelector('#emptyState'),
  paymentResult: document.querySelector('#paymentResult'),
  statusTitle: document.querySelector('#statusTitle'),
  statusBadge: document.querySelector('#statusBadge'),
  qrisBox: document.querySelector('#qrisBox'),
  qrisImage: document.querySelector('#qrisImage'),
  qrisContent: document.querySelector('#qrisContent'),
  vaBox: document.querySelector('#vaBox'),
  vaNumber: document.querySelector('#vaNumber'),
  copyVa: document.querySelector('#copyVa'),
  paymentId: document.querySelector('#paymentId'),
  referenceId: document.querySelector('#referenceId'),
  paymentMethod: document.querySelector('#paymentMethod'),
  paymentTotal: document.querySelector('#paymentTotal'),
  expiredAt: document.querySelector('#expiredAt'),
  paymentLink: document.querySelector('#paymentLink'),
  rawResponse: document.querySelector('#rawResponse'),
};

function formatRupiah(value) {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

function formatDate(value) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('id-ID', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

async function requestJson(url, options) {
  const res = await fetch(url, options);
  const json = await res.json().catch(() => ({}));

  if (!res.ok || json.ok === false) {
    const hint = json.hint ? ` (${json.hint})` : '';
    throw new Error(`${json.message || `HTTP ${res.status}`}${hint}`);
  }

  return json;
}

function setMethod(method) {
  state.method = method;

  els.methodButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.method === method);
  });

  els.bankField.classList.toggle('hidden', method !== 'VIRTUAL_ACCOUNT');
}

function setStatus(status) {
  const normalized = String(status || 'IDLE').toLowerCase();
  els.statusBadge.className = `status ${normalized}`;
  els.statusBadge.textContent = status || 'IDLE';
  els.statusTitle.textContent = status ? `Status ${status}` : 'Belum ada pembayaran';
}

function showError(message) {
  els.emptyState.classList.remove('hidden');
  els.paymentResult.classList.add('hidden');
  els.emptyState.textContent = message;
  setStatus('FAILED');
}

function renderPayment(payment, raw) {
  const metadata = payment.metadata || {};
  const va = metadata.virtual_account || {};
  const qris = metadata.qris || {};
  const paymentLink = metadata.payment_link?.link || '';

  els.emptyState.classList.add('hidden');
  els.paymentResult.classList.remove('hidden');
  setStatus(payment.status);

  els.qrisBox.classList.toggle('hidden', payment.payment_method !== 'QRIS');
  els.vaBox.classList.toggle('hidden', payment.payment_method !== 'VIRTUAL_ACCOUNT');

  if (payment.payment_method === 'QRIS') {
    els.qrisImage.src = qris.qr_data_uri || qris.qr_url || '';
    els.qrisImage.classList.toggle('hidden', !els.qrisImage.src);
    els.qrisContent.value = qris.qr_content || '';
  }

  if (payment.payment_method === 'VIRTUAL_ACCOUNT') {
    els.vaNumber.textContent = va.va_number || '-';
  }

  els.paymentId.textContent = payment.id || '-';
  els.referenceId.textContent = payment.client_reference_id || '-';
  els.paymentMethod.textContent = payment.payment_method || '-';
  els.paymentTotal.textContent = formatRupiah(payment.total || payment.amount);
  els.expiredAt.textContent = formatDate(payment.expired_at || va.expired_at);

  if (paymentLink) {
    els.paymentLink.href = paymentLink;
    els.paymentLink.textContent = paymentLink;
  } else {
    els.paymentLink.removeAttribute('href');
    els.paymentLink.textContent = '-';
  }

  els.rawResponse.textContent = JSON.stringify(raw || payment, null, 2);
}

async function pollPaymentStatus() {
  if (!state.paymentId) return;

  try {
    const response = await requestJson(`/api/payments/${encodeURIComponent(state.paymentId)}`);
    renderPayment(response.data, response.raw);

    if (response.isTerminal) {
      window.clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  } catch (err) {
    window.clearInterval(state.pollTimer);
    state.pollTimer = null;
    showError(`Gagal cek status: ${err.message}`);
  }
}

function startPolling(paymentId) {
  state.paymentId = paymentId;
  window.clearInterval(state.pollTimer);
  state.pollTimer = window.setInterval(pollPaymentStatus, 5000);
}

function getFormPayload() {
  const formData = new FormData(els.form);
  return {
    amount: Number(formData.get('amount')),
    bankCode: formData.get('bankCode'),
    descriptionName: formData.get('descriptionName'),
    statementDescriptor: formData.get('statementDescriptor'),
    clientReferenceId: formData.get('clientReferenceId') || undefined,
    expiredInHours: Number(formData.get('expiredInHours') || 1),
    generatePaymentLink: formData.get('generatePaymentLink') === 'on',
    addPaymentFeeToSurcharge: formData.get('addPaymentFeeToSurcharge') === 'on',
  };
}

async function handleSubmit(event) {
  event.preventDefault();

  const endpoint =
    state.method === 'QRIS' ? '/api/payments/qris' : '/api/payments/virtual-account';

  els.submitButton.disabled = true;
  els.submitButton.textContent = 'Creating...';
  setStatus('PENDING');

  try {
    const response = await requestJson(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(getFormPayload()),
    });

    renderPayment(response.data, response.raw);
    startPolling(response.data.id);
  } catch (err) {
    showError(`Gagal membuat payment: ${err.message}`);
  } finally {
    els.submitButton.disabled = false;
    els.submitButton.textContent = 'Create Payment';
  }
}

async function loadConfig() {
  try {
    const response = await requestJson('/api/config');
    els.credentialBadge.textContent = response.data.hasCredential ? 'Config ready' : 'Credential missing';
    els.credentialBadge.classList.toggle('ok', response.data.hasCredential);
    els.credentialBadge.classList.toggle('error', !response.data.hasCredential);
  } catch {
    els.credentialBadge.textContent = 'Config unavailable';
    els.credentialBadge.classList.add('error');
  }
}

els.methodButtons.forEach((button) => {
  button.addEventListener('click', () => setMethod(button.dataset.method));
});

els.form.addEventListener('submit', handleSubmit);

els.copyVa.addEventListener('click', async () => {
  const value = els.vaNumber.textContent.trim();
  if (!value || value === '-') return;
  await navigator.clipboard.writeText(value);
  els.copyVa.textContent = 'Copied';
  window.setTimeout(() => {
    els.copyVa.textContent = 'Copy VA';
  }, 1200);
});

setMethod(state.method);
loadConfig();
