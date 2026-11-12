import { api, bindEyeToggle, session, showError } from './api.js';

const el = (id) => document.getElementById(id);

/** Mostra a tela de login e resolve quando o jogador entrar ou criar a conta. */
export async function requireLogin() {
  if (session.token) {
    try {
      const user = await api('/auth/me');
      session.save(session.token, user);
      return user;
    } catch (err) {
      if (err.code !== 'auth') throw err;
      session.clear();
    }
  }

  const { registration_code_required: codeRequired } = await api('/auth/config').catch(() => ({}));
  document.body.dataset.auth = 'out';
  el('auth-screen').hidden = false;
  const form = el('auth-form');
  let mode = 'login';

  function setMode(next) {
    mode = next;
    const register = mode === 'register';
    el('auth-tab-login').classList.toggle('active', !register);
    el('auth-tab-register').classList.toggle('active', register);
    el('auth-tab-login').setAttribute('aria-selected', String(!register));
    el('auth-tab-register').setAttribute('aria-selected', String(register));
    el('auth-name-field').hidden = !register;
    el('auth-code-field').hidden = !(register && codeRequired);
    el('auth-hint').hidden = !register;
    form.elements.password.autocomplete = register ? 'new-password' : 'current-password';
    el('auth-submit').textContent = register ? 'Criar conta' : 'Entrar';
    showError(el('auth-error'), null);
  }

  const showPassword = bindEyeToggle(el('auth-password-toggle'), form.elements.password, 'senha');

  el('auth-tab-login').addEventListener('click', () => setMode('login'));
  el('auth-tab-register').addEventListener('click', () => setMode('register'));
  setMode('login');
  form.elements.email.focus();

  return new Promise((resolve) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const { elements } = form;
      const body = { email: elements.email.value, password: elements.password.value };
      if (mode === 'register') Object.assign(body, { name: elements.name.value, code: elements.code.value });
      el('auth-submit').disabled = true;
      try {
        const result = await api(`/auth/${mode}`, { method: 'POST', body });
        session.save(result.token, result.user);
        elements.password.value = '';
        showPassword(false);
        el('auth-screen').hidden = true;
        resolve(result.user);
      } catch (err) {
        showError(el('auth-error'), err);
      } finally {
        el('auth-submit').disabled = false;
      }
    });
  });
}

export function logout() {
  session.clear();
  location.reload();
}
