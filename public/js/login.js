import { api, bindEyeToggle, session, showError } from './api.js';

const el = (id) => document.getElementById(id);

/** Mostra a tela de login e resolve quando o jogador entrar ou criar a conta. */
export async function requireLogin() {
  // Link de nova senha (gerado pelo admin): #nova-senha=<código>. O código sai da barra de endereço na hora.
  const resetToken = /^#nova-senha=([\w-]{20,100})$/.exec(location.hash)?.[1];
  if (resetToken) {
    history.replaceState(null, '', location.pathname + location.search);
    session.clear();
  }
  // "Ver como" (aberto pelo Painel Admin): #ver-como=<token>. O token sai da barra de endereço na hora
  // e fica só nesta aba.
  const viewToken = /^#ver-como=([\w-]+\.[\w-]+\.[\w-]+)$/.exec(location.hash)?.[1];
  if (viewToken) {
    history.replaceState(null, '', location.pathname + location.search);
    session.startViewing(viewToken);
  }
  if (session.token) {
    const viewing = session.viewing;
    try {
      const user = await api('/auth/me');
      session.save(session.token, user);
      return user;
    } catch (err) {
      if (err.code !== 'auth') throw err;
      session.clear();
      // Acabou a hora do "Ver como": a aba volta para a conta do admin.
      if (viewing) {
        window.alert('O acesso "Ver como" acabou (dura 1 hora). Abra de novo pelo Painel Admin.');
        location.reload();
        await new Promise(() => {});
      }
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
    el('auth-forgot').hidden = register;
    el('auth-forgot-help').hidden = true;
    el('auth-forgot-status').hidden = true;
    form.elements.password.autocomplete = register ? 'new-password' : 'current-password';
    el('auth-submit').textContent = register ? 'Criar conta' : 'Entrar';
    showError(el('auth-error'), null);
  }

  const showPassword = bindEyeToggle(el('auth-password-toggle'), form.elements.password, 'senha');

  el('auth-forgot').addEventListener('click', () => {
    el('auth-forgot-help').hidden = !el('auth-forgot-help').hidden;
    if (!el('auth-forgot-help').hidden) form.elements.email.focus();
  });
  el('auth-forgot-send').addEventListener('click', async () => {
    const status = el('auth-forgot-status');
    showError(el('auth-error'), null);
    if (!form.elements.email.value.trim()) {
      showError(el('auth-error'), new Error('Digite o seu e-mail no campo acima.'));
      form.elements.email.focus();
      return;
    }
    el('auth-forgot-send').disabled = true;
    try {
      const { message } = await api('/auth/forgot', { method: 'POST', body: { email: form.elements.email.value } });
      status.textContent = message;
      status.hidden = false;
    } catch (err) {
      showError(el('auth-error'), err);
    } finally {
      el('auth-forgot-send').disabled = false;
    }
  });
  el('auth-tab-login').addEventListener('click', () => setMode('login'));
  el('auth-tab-register').addEventListener('click', () => setMode('register'));
  setMode('login');
  form.elements.email.focus();

  return new Promise((resolve) => {
    if (resetToken) showReset(resetToken, resolve);

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

/** Tela de nova senha. Ao salvar, já entra na conta. */
function showReset(token, resolve) {
  const resetForm = el('reset-form');
  const authForm = el('auth-form');
  const toggle = (resetting) => {
    resetForm.hidden = !resetting;
    authForm.hidden = resetting;
    document.querySelector('.auth-switch').hidden = resetting;
  };
  toggle(true);
  resetForm.elements.password.focus();
  el('reset-cancel').addEventListener('click', () => toggle(false), { once: true });
  resetForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const { password, confirm } = resetForm.elements;
    if (password.value !== confirm.value) {
      showError(el('reset-error'), new Error('As duas senhas não são iguais.'));
      return;
    }
    el('reset-submit').disabled = true;
    try {
      const result = await api('/auth/reset', { method: 'POST', body: { token, password: password.value } });
      session.save(result.token, result.user);
      password.value = '';
      confirm.value = '';
      el('auth-screen').hidden = true;
      resolve(result.user);
    } catch (err) {
      showError(el('reset-error'), err);
    } finally {
      el('reset-submit').disabled = false;
    }
  });
}

export function logout() {
  // No "Ver como", "Sair" só fecha a visualização (o login do admin continua nas outras abas).
  const viewing = session.viewing;
  session.clear();
  if (viewing) window.close();
  location.reload();
}

// Link de nova senha colado numa aba que já estava com o DataDice aberto: recarrega para abrir a tela certa.
window.addEventListener('hashchange', () => {
  if (location.hash.startsWith('#nova-senha=')) location.reload();
});
