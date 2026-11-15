import { AI_PROVIDERS, api, bindEyeToggle, h, settings } from './api.js';
import { renderUsage } from './usage.js';

const el = (id) => document.getElementById(id);

// Outras IAs: onde pegar a chave, o que avisar e os modelos conhecidos (a lista completa vem da chave).
const OTHER = {
  openai: {
    site: 'OpenAI',
    link: 'https://platform.openai.com/api-keys',
    note: 'Usa a sua chave de API da OpenAI, cobrada à parte da assinatura do ChatGPT.',
    models: [['gpt-5.4-mini', 'gpt-5.4-mini (padrão, mais barato)']],
  },
  anthropic: {
    site: 'Anthropic',
    link: 'https://platform.claude.com/settings/keys',
    note: 'Usa a sua chave de API da Anthropic, cobrada à parte da assinatura do Claude.',
    models: [
      ['claude-opus-5-5', 'Opus 5.5 (padrão, o melhor)'],
      ['claude-sonnet-5-5', 'Sonnet 5.5 (equilibrado)'],
      ['claude-haiku-5-5', 'Haiku 5.5 (mais barato)'],
    ],
  },
  openrouter: {
    site: 'OpenRouter',
    link: 'https://openrouter.ai/settings/keys',
    note: 'Uma chave para vários modelos. Os marcados "(grátis)" não custam nada, mas têm limite de uso. Toque em "Carregar lista" e escolha um.',
    models: [],
  },
};
const GEMINI_NOTE = 'Grátis, com limite diário. A chave é criada com a sua conta Google.';

function setOtherStatus(state, message) {
  const status = el('settings-other-status');
  status.className = `key-status ${state}`;
  status.textContent = message;
  status.hidden = !message;
}

/** Preenche a lista de modelos: os conhecidos (ou os que a chave trouxe) e o que já estava escolhido. */
function fillModels(provider, loaded = null) {
  const select = el('settings-model');
  const saved = settings.model(provider);
  const list = loaded
    ? loaded.map((item) => [item.id, item.free ? `${item.id} (grátis)` : item.id])
    : [...(OTHER[provider]?.models ?? [])];
  if (saved && !list.some(([id]) => id === saved)) list.unshift([saved, saved]);
  if (!list.length) list.push(['', 'Toque em "Carregar lista"']);
  select.replaceChildren(...list.map(([id, label]) => h('option', { value: id }, label)));
  select.value = saved && list.some(([id]) => id === saved) ? saved : list[0][0];
  if (select.value) settings.setModel(provider, select.value);
}

/** Mostra os campos da IA escolhida. A chave do Gemini continua lá (para as imagens). */
function renderProvider() {
  const provider = settings.provider;
  const other = provider !== 'gemini';
  el('settings-provider').value = provider;
  el('settings-provider-note').textContent = other ? OTHER[provider].note : GEMINI_NOTE;
  el('settings-other').hidden = !other;
  el('settings-key-title').textContent = other ? 'Chave do Gemini (opcional, só para imagens)' : 'Chave do Gemini';
  if (!other) return;
  el('settings-other-title').textContent = `Chave do ${AI_PROVIDERS[provider]}`;
  el('settings-other-key').value = settings.otherKey(provider);
  el('settings-other-link').href = OTHER[provider].link;
  el('settings-other-link').textContent = `Obter chave no site da ${OTHER[provider].site} ↗`;
  fillModels(provider);
  setOtherStatus('', '');
}

async function loadModels() {
  const provider = settings.provider;
  if (!settings.otherKey(provider)) {
    setOtherStatus('fail', 'Cole a sua chave antes de carregar a lista.');
    return false;
  }
  el('settings-models-load').disabled = true;
  try {
    const { models } = await api('/config/models', { method: 'POST', body: {}, gemini: true });
    if (models.length) fillModels(provider, models);
    return true;
  } catch (err) {
    setOtherStatus('fail', `Não deu para carregar a lista. ${err.message}`);
    return false;
  } finally {
    el('settings-models-load').disabled = false;
  }
}

function setStatus(state, message) {
  const status = el('settings-status');
  status.className = `key-status ${state}`;
  status.textContent = message;
  status.hidden = !message;
}

/** Abas das Configurações: "Chave e imagens" e "Consumo IA". */
function showTab(tab) {
  for (const button of document.querySelectorAll('.settings-tabs button')) {
    const active = button.dataset.tab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  }
  el('settings-pane-key').hidden = tab !== 'key';
  el('settings-pane-usage').hidden = tab !== 'usage';
  if (tab === 'usage') renderUsage();
}

export function openSettings({ reason, tab = 'key' } = {}) {
  const dialog = el('settings-dialog');
  // Um aviso (ex.: falta a chave) sempre abre na aba da chave.
  showTab(reason ? 'key' : tab);
  el('settings-key').value = settings.apiKey;
  el('settings-images').checked = settings.imagesEnabled;
  renderProvider();
  const other = settings.provider !== 'gemini';
  if (reason) (other ? setOtherStatus : setStatus)('warn', reason);
  if (!dialog.open) dialog.showModal();
  if (!settings.textKey) el(other ? 'settings-other-key' : 'settings-key').focus();
}

export function initSettings() {
  const keyInput = el('settings-key');
  const toggle = el('settings-key-toggle');

  el('settings-open').addEventListener('click', () => openSettings());
  for (const button of document.querySelectorAll('.settings-tabs button')) {
    button.addEventListener('click', () => showTab(button.dataset.tab));
  }
  document.addEventListener('open-settings', () => openSettings());
  document.addEventListener('need-gemini-key', () =>
    openSettings({ reason: settings.textKey ? 'Confira a chave e o modelo da IA.' : `Cole sua chave do ${settings.providerLabel} para jogar.` }));

  // Outras IAs: escolher, colar a chave, escolher o modelo e testar.
  el('settings-provider').addEventListener('change', (event) => {
    settings.provider = event.target.value;
    renderProvider();
  });
  const otherInput = el('settings-other-key');
  otherInput.addEventListener('input', () => {
    settings.setOtherKey(settings.provider, otherInput.value);
    setOtherStatus('', '');
  });
  const showOther = bindEyeToggle(el('settings-other-toggle'), otherInput, 'chave');
  el('settings-model').addEventListener('change', (event) => settings.setModel(settings.provider, event.target.value));
  el('settings-models-load').addEventListener('click', loadModels);
  el('settings-other-test').addEventListener('click', async () => {
    settings.setOtherKey(settings.provider, otherInput.value);
    otherInput.value = settings.otherKey(settings.provider);
    if (!settings.textKey) {
      setOtherStatus('fail', 'Cole a sua chave antes de testar.');
      return;
    }
    el('settings-other-test').disabled = true;
    setOtherStatus('testing', 'Testando...');
    try {
      // OpenRouter não tem modelo padrão: carrega a lista antes, para haver o que testar.
      if (!settings.model(settings.provider) && !(await loadModels())) return;
      const result = await api('/config/test-key', { method: 'POST', body: {}, gemini: true });
      setOtherStatus('ok', `Conectado. ${result.message}`);
    } catch (err) {
      setOtherStatus('fail', `Falha na chave. ${err.message}`);
    } finally {
      el('settings-other-test').disabled = false;
    }
  });
  el('settings-dialog').addEventListener('close', () => showOther(false));

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
      // Este botão testa sempre a chave do Gemini, mesmo com outra IA escolhida.
      const provider = settings.provider;
      settings.provider = 'gemini';
      let result;
      try {
        result = await api('/config/test-key', { method: 'POST', body: {}, gemini: true });
      } finally {
        settings.provider = provider;
      }
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
