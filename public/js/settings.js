import { api, bindEyeToggle, settings } from './api.js';

const el = (id) => document.getElementById(id);

function setStatus(state, message) {
  const status = el('settings-status');
  status.className = `key-status ${state}`;
  status.textContent = message;
  status.hidden = !message;
}

export function openSettings({ reason } = {}) {
  const dialog = el('settings-dialog');
  el('settings-key').value = settings.apiKey;
  el('settings-images').checked = settings.imagesEnabled;
  if (reason) setStatus('warn', reason);
  if (!dialog.open) dialog.showModal();
  if (!settings.apiKey) el('settings-key').focus();
}

export function initSettings() {
  const keyInput = el('settings-key');
  const toggle = el('settings-key-toggle');

  el('settings-open').addEventListener('click', () => openSettings());
  document.addEventListener('open-settings', () => openSettings());
  document.addEventListener('need-gemini-key', () =>
    openSettings({ reason: 'Cole sua chave do Gemini para jogar.' }));

  // A chave é salva assim que é digitada; o teste confirma se o Google aceita.
  keyInput.addEventListener('input', () => {
    settings.apiKey = keyInput.value;
    setStatus('', '');
  });

  const showKey = bindEyeToggle(toggle, keyInput, 'chave');

  el('settings-images').addEventListener('change', (event) => {
    settings.imagesEnabled = event.target.checked;
  });

  el('settings-test').addEventListener('click', async () => {
    settings.apiKey = keyInput.value;
    keyInput.value = settings.apiKey; // mostra a chave já limpa (sem espaços, aspas ou prefixo)
    if (!settings.apiKey) {
      setStatus('fail', 'Cole a sua chave antes de testar.');
      return;
    }
    el('settings-test').disabled = true;
    setStatus('testing', 'Testando...');
    try {
      const result = await api('/config/test-key', { method: 'POST', body: {}, gemini: true });
      setStatus('ok', `Conectado. ${result.message}`);
    } catch (err) {
      setStatus('fail', `Falha na chave. ${err.message}`);
    } finally {
      el('settings-test').disabled = false;
    }
  });

  // Fechar o diálogo devolve o foco à página; a chave já está salva.
  el('settings-dialog').addEventListener('close', () => {
    showKey(false);
  });
}
