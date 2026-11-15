import { api, bindEyeToggle, h, settings } from './api.js';
import { narration, narrationSupported, portugueseVoices, speak } from './narrator.js';
import { renderUsage } from './usage.js';

const el = (id) => document.getElementById(id);

/**
 * Configurações, aba "IA e imagens": uma seção para a IA do Mestre (uma chave, a da IA escolhida)
 * e uma para as imagens (só pede outra chave quando a IA das imagens não é a mesma do Mestre).
 * As chaves ficam só neste navegador.
 */
const PROVIDERS = {
  gemini: {
    name: 'Gemini',
    site: 'Google AI Studio',
    link: 'https://aistudio.google.com/app/apikey',
    note: 'Grátis, com limite diário. A chave é criada com a sua conta Google.',
    more: [
      'O Mestre usa a inteligência artificial do Google com a sua chave.',
      'O plano gratuito tem um limite de pedidos por dia, que volta por volta das 5h (horário de Brasília).',
    ],
  },
  openai: {
    name: 'ChatGPT (OpenAI)',
    site: 'site da OpenAI',
    link: 'https://platform.openai.com/api-keys',
    note: 'Usa a sua chave de API da OpenAI, cobrada à parte da assinatura do ChatGPT.',
    models: [['gpt-5.4-mini', 'gpt-5.4-mini (padrão, mais barato)']],
    more: ['A chave de API é paga pelo uso, direto para a OpenAI. O ChatGPT Plus não vale aqui.'],
  },
  anthropic: {
    name: 'Claude (Anthropic)',
    site: 'site da Anthropic',
    link: 'https://platform.claude.com/settings/keys',
    note: 'Usa a sua chave de API da Anthropic, cobrada à parte da assinatura do Claude.',
    models: [
      ['claude-opus-5-5', 'Opus 5.5 (padrão, o melhor)'],
      ['claude-sonnet-5-5', 'Sonnet 5.5 (equilibrado)'],
      ['claude-haiku-5-5', 'Haiku 5.5 (mais barato)'],
    ],
    more: ['A chave de API é paga pelo uso, direto para a Anthropic. O Claude Pro não vale aqui.'],
  },
  openrouter: {
    name: 'OpenRouter',
    site: 'OpenRouter',
    link: 'https://openrouter.ai/settings/keys',
    note: 'Uma chave para centenas de modelos (Llama, Mistral, DeepSeek, Grok...). Os marcados "(grátis)" não custam nada, com limite de uso.',
    models: [],
    more: ['Toque em "Ver todos" para escolher o modelo. Os grátis aparecem primeiro.'],
  },
};

const keyOf = (provider) => (provider === 'gemini' ? settings.apiKey : settings.otherKey(provider));
function setKeyOf(provider, value) {
  if (provider === 'gemini') settings.apiKey = value;
  else settings.setOtherKey(provider, value);
}

function setStatus(state, message) {
  // Chave testada e aceita: oferece ir direto para o jogo (sem levar a pessoa sozinha para outra tela).
  el('ai-play').hidden = state !== 'ok';
  const status = el('ai-status');
  status.className = `key-status ${state}`;
  status.textContent = message;
  status.hidden = !message;
}

/** Lista de modelos: os conhecidos (ou os que a chave trouxe) e o que já estava escolhido. */
function fillModels(provider, loaded = null) {
  const select = el('ai-model');
  const saved = settings.model(provider);
  const list = loaded
    ? loaded.map((item) => [item.id, item.free ? `${item.id} (grátis)` : item.id])
    : [...(PROVIDERS[provider].models ?? [])];
  if (saved && !list.some(([id]) => id === saved)) list.unshift([saved, saved]);
  if (!list.length) list.push(['', 'Toque em "Ver todos"']);
  select.replaceChildren(...list.map(([id, label]) => h('option', { value: id }, label)));
  select.value = saved && list.some(([id]) => id === saved) ? saved : list[0][0];
  if (select.value) settings.setModel(provider, select.value);
}

/** Imagens: Gemini ou OpenAI. Pede a chave só se ela ainda não está em "IA do Mestre". */
function renderImages() {
  const on = el('settings-images').checked;
  if (el('acc-img-note')) renderNotes();
  const image = settings.imageProvider;
  el('img-options').hidden = !on;
  el('img-off-note').hidden = on;
  for (const button of document.querySelectorAll('[data-image-provider]')) {
    const active = button.dataset.imageProvider === image;
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', String(active));
  }
  const sameKey = image === settings.provider;
  const whose = image === 'openai' ? 'da OpenAI' : 'do Gemini';
  el('img-key-field').hidden = sameKey;
  el('img-key-label').textContent = `Chave ${whose} (para as imagens)`;
  const keyInput = el('img-key');
  if (document.activeElement !== keyInput) keyInput.value = keyOf(image);
  // Uma linha só: quanto custa.
  el('img-note').textContent = image === 'openai'
    ? 'Cobrado por imagem na sua conta da OpenAI.'
    : 'Precisa de faturamento ativo no Gemini (cerca de US$ 0,03 por imagem).';
}

/** Mostra a IA escolhida: chave, modelo (quando há), link e explicações (no "Saiba mais"). */
function render() {
  const provider = settings.provider;
  const info = PROVIDERS[provider];
  el('ai-provider').value = provider;
  el('ai-key-label').textContent = `Chave do ${info.name}`;
  el('ai-key').value = keyOf(provider);
  el('ai-model-field').hidden = provider === 'gemini';
  if (provider !== 'gemini') fillModels(provider);
  el('ai-link').href = info.link;
  el('ai-link').textContent = `Obter chave ↗`;
  el('ai-more').replaceChildren(...[info.note, ...info.more, 'A chave fica salva só neste navegador. O servidor não a guarda.'].map((text) => h('li', {}, text)));
  setStatus('', '');
  renderImages();
  renderNotes();
}

/** O que aparece ao lado do título de cada acordeão (fechado, dá para ver como está sem abrir). */
function renderNotes() {
  el('acc-ai-note').textContent = `${PROVIDERS[settings.provider].name.replace(/ \(.*\)$/, '')} · ${keyOf(settings.provider) ? 'chave colocada' : 'falta a chave'}`;
  el('acc-img-note').textContent = settings.imagesEnabled ? (settings.imageProvider === 'openai' ? 'OpenAI' : 'Gemini') : 'Desligado';
  el('acc-narration-note').textContent = !narrationSupported ? 'Indisponível' : narration.auto ? 'Automática' : 'Só no "Ouvir"';
}

async function loadModels() {
  const provider = settings.provider;
  if (!keyOf(provider)) {
    setStatus('fail', 'Cole a sua chave antes de ver os modelos.');
    return false;
  }
  el('ai-models-load').disabled = true;
  try {
    const { models } = await api('/config/models', { method: 'POST', body: {}, gemini: true });
    if (models.length) fillModels(provider, models);
    return true;
  } catch (err) {
    setStatus('fail', `Não deu para carregar os modelos. ${err.message}`);
    return false;
  } finally {
    el('ai-models-load').disabled = false;
  }
}

/** Narração: liga a leitura automática e escolhe a voz e a velocidade. */
function renderNarration() {
  if (!narrationSupported) {
    for (const id of ['narration-auto', 'narration-voice', 'narration-rate', 'narration-test']) el(id).disabled = true;
    el('narration-note').hidden = false;
    el('narration-note').textContent = 'Este navegador não tem leitura em voz alta. No celular, use o Chrome ou o Safari atualizados.';
    return;
  }
  el('narration-auto').checked = narration.auto;
  // Velocidade salva que não existe mais na lista (ex.: 1.15 antiga): fica na mais próxima.
  const rates = [...el('narration-rate').options].map((option) => Number(option.value));
  const closest = rates.reduce((best, rate) => (Math.abs(rate - narration.rate) < Math.abs(best - narration.rate) ? rate : best), 1);
  el('narration-rate').value = String(closest);
  const voices = portugueseVoices();
  const select = el('narration-voice');
  select.replaceChildren(...(voices.length
    ? voices.map((voice) => h('option', { value: voice.name }, `${voice.name.replace(/^(Microsoft|Google)\s+/, '').replace(/\s*-\s*Portuguese.*$/i, '')}${/^pt[-_]PT/i.test(voice.lang) ? ' (Portugal)' : ''}`))
    : [h('option', { value: '' }, 'Voz padrão do aparelho')]));
  select.value = voices.some((voice) => voice.name === narration.voice) ? narration.voice : (voices[0]?.name ?? '');
  el('narration-note').hidden = voices.length > 0;
  el('narration-note').textContent = 'Nenhuma voz em português encontrada neste aparelho; será usada a voz padrão.';
}

/** Abas das Configurações: "IA e imagens" e "Consumo IA". */
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

/** section: 'ai' abre já no acordeão da IA (ex.: botão "Colocar a chave" do Início). */
export function openSettings({ reason, tab = 'key', section = null } = {}) {
  const dialog = el('settings-dialog');
  // Um aviso (ex.: falta a chave) sempre abre na aba da chave.
  showTab(reason || section ? 'key' : tab);
  el('settings-images').checked = settings.imagesEnabled;
  render();
  renderNarration();
  // Todos começam fechados; um aviso (ex.: falta a chave) abre o da IA.
  const openAi = Boolean(reason) || section === 'ai';
  for (const acc of document.querySelectorAll('.settings-acc')) acc.open = openAi && acc.id === 'acc-ai';
  if (reason) setStatus('warn', reason);
  if (!dialog.open) dialog.showModal();
  if (openAi && !settings.textKey) el('ai-key').focus();
}

export function initSettings() {
  el('settings-open').addEventListener('click', () => openSettings());
  for (const button of document.querySelectorAll('.settings-tabs button')) {
    button.addEventListener('click', () => showTab(button.dataset.tab));
  }
  document.addEventListener('open-settings', (event) => openSettings({ section: event.detail?.section ?? null }));
  document.addEventListener('need-gemini-key', () =>
    openSettings({ reason: settings.textKey ? 'Confira a chave e o modelo da IA.' : `Cole sua chave do ${settings.providerLabel} para jogar.` }));

  // IA do Mestre.
  el('ai-provider').addEventListener('change', (event) => {
    settings.provider = event.target.value;
    render();
  });
  const keyInput = el('ai-key');
  // A chave é salva assim que é digitada; o teste confirma se a empresa aceita.
  keyInput.addEventListener('input', () => {
    setKeyOf(settings.provider, keyInput.value);
    setStatus('', '');
    renderImages();
    renderNotes();
  });
  const showKey = bindEyeToggle(el('ai-key-toggle'), keyInput, 'chave');
  el('ai-play').addEventListener('click', () => {
    el('settings-dialog').close();
    document.dispatchEvent(new CustomEvent('show-view', { detail: 'game' }));
  });
  el('ai-model').addEventListener('change', (event) => settings.setModel(settings.provider, event.target.value));
  el('ai-models-load').addEventListener('click', loadModels);
  el('ai-test').addEventListener('click', async () => {
    const provider = settings.provider;
    setKeyOf(provider, keyInput.value);
    keyInput.value = keyOf(provider); // mostra a chave já limpa (sem espaços, aspas ou prefixo)
    if (!keyOf(provider)) {
      setStatus('fail', 'Cole a sua chave antes de testar.');
      return;
    }
    el('ai-test').disabled = true;
    setStatus('testing', 'Testando...');
    try {
      // OpenRouter não tem modelo padrão: carrega a lista antes, para haver o que testar.
      if (provider !== 'gemini' && !settings.model(provider) && !(await loadModels())) return;
      const result = await api('/config/test-key', { method: 'POST', body: {}, gemini: true });
      setStatus('ok', `Conectado. ${result.message}`);
    } catch (err) {
      setStatus('fail', `Falha na chave. ${err.message}`);
    } finally {
      el('ai-test').disabled = false;
    }
  });

  // Imagens.
  el('settings-images').addEventListener('change', (event) => {
    settings.imagesEnabled = event.target.checked;
    renderImages();
  });
  for (const button of document.querySelectorAll('[data-image-provider]')) {
    button.addEventListener('click', () => {
      settings.imageProvider = button.dataset.imageProvider;
      renderImages();
    });
  }
  el('img-key').addEventListener('input', (event) => {
    setKeyOf(settings.imageProvider, event.target.value);
    renderImages();
  });
  const showImageKey = bindEyeToggle(el('img-key-toggle'), el('img-key'), 'chave');

  el('settings-dialog').addEventListener('close', () => {
    showKey(false);
    showImageKey(false);
  });

  // Narração.
  el('narration-auto').addEventListener('change', (event) => {
    narration.auto = event.target.checked;
    renderNotes();
  });
  el('narration-voice').addEventListener('change', (event) => { narration.voice = event.target.value; });
  // Trocou a velocidade: já toca o exemplo nela, para a pessoa ouvir a diferença.
  el('narration-rate').addEventListener('change', (event) => {
    narration.rate = Number(event.target.value);
    speak('Assim fica a velocidade da narração.', el('narration-test'));
  });
  el('narration-test').addEventListener('click', () =>
    speak('A porta da taverna range. Um anão de barba ruiva levanta os olhos da caneca e sorri: — Finalmente, aventureiros!', el('narration-test')));
  document.addEventListener('voices-changed', () => {
    if (el('settings-dialog').open) renderNarration();
  });
}
