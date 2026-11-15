import { Router } from 'express';
import { rateLimit } from './rateLimit.js';

/**
 * Registro de atividade para o Painel Admin: quem fez o quê, quando, e o que deu errado.
 * Grava só o nome da ação, um detalhe curto (o nome da ficha, da campanha ou da mesa) e a mensagem de erro
 * que a pessoa viu. Nunca o corpo da requisição: nada de senhas, chaves, mensagens do chat ou anotações.
 */

const RETENTION_DAYS = 60;
const PRUNE_EVERY_MS = 6 * 60 * 60 * 1000;
const MAX_TEXT = 300;

const named = (body) => (typeof body?.name === 'string' ? body.name : null);

// [método, caminho depois de /api, ação, opções]. noisy: ações muito frequentes, gravadas só quando dão erro.
const ROUTES = [
  ['POST', /^\/auth\/register$/, 'Criou a conta'],
  ['POST', /^\/auth\/login$/, 'Entrou na conta'],
  ['POST', /^\/auth\/forgot$/, 'Pediu nova senha'],
  ['POST', /^\/auth\/reset$/, 'Criou nova senha pelo link'],
  ['POST', /^\/config\/test-key$/, 'Testou a chave do Gemini'],
  ['POST', /^\/characters\/preview$/, null],
  ['POST', /^\/characters\/import$/, 'Importou ficha em PDF', {
    detail: (body, req) => body?.character && `${body.character.name || 'sem nome'} (${body.source === 'ia' ? 'lida com IA' : 'modelo conhecido'}${req.query.ia === '1' ? ', pediu IA' : ''})`,
  }],
  ['POST', /^\/characters$/, 'Criou personagem', { detail: named }],
  ['PUT', /^\/characters\/\d+$/, 'Editou personagem', { detail: named }],
  ['POST', /^\/portraits$/, 'Enviou retrato'],
  ['POST', /^\/campaigns\/generate$/, 'Gerou campanha com IA'],
  ['POST', /^\/campaigns$/, 'Criou campanha (Mestre IA)', { detail: named }],
  ['POST', /^\/campaigns\/join$/, 'Entrou em campanha com um personagem'],
  ['PUT', /^\/campaigns\/\d+$/, 'Editou campanha', { detail: named }],
  ['DELETE', /^\/campaigns\/\d+$/, 'Apagou campanha'],
  ['POST', /^\/campaigns\/\d+\/roll$/, 'Rolou dados (Mestre IA)', { noisy: true }],
  ['PATCH', /^\/campaigns\/\d+\/characters\/\d+$/, 'Ajustou estado do personagem (Mestre IA)'],
  ['POST', /^\/campaigns\/\d+\/memories$/, 'Adicionou memória à campanha'],
  ['PATCH', /^\/memories\/\d+$/, 'Editou memória da campanha'],
  ['DELETE', /^\/memories\/\d+$/, 'Apagou memória da campanha'],
  ['POST', /^\/campaigns\/\d+\/session$/, 'Começou sessão (Mestre IA)'],
  ['POST', /^\/campaigns\/\d+\/session\/end$/, 'Encerrou sessão (Mestre IA)'],
  ['POST', /^\/chat$/, 'Mandou mensagem ao Mestre IA', { noisy: true }],
  ['POST', /^\/generate-image$/, 'Gerou imagem'],
  ['POST', /^\/visuals\/[\w-]+\/\d+\/retry$/, 'Pediu a imagem de novo'],
  ['POST', /^\/tables$/, 'Criou mesa', { detail: named }],
  ['POST', /^\/tables\/join$/, 'Pediu para entrar numa mesa', { detail: named }],
  ['PATCH', /^\/tables\/\d+$/, 'Editou mesa', { detail: named }],
  ['POST', /^\/tables\/\d+\/code$/, 'Trocou o código da mesa'],
  ['DELETE', /^\/tables\/\d+$/, 'Apagou mesa'],
  ['POST', /^\/tables\/\d+\/members\/\d+\/approve$/, 'Aprovou jogador na mesa'],
  ['DELETE', /^\/tables\/\d+\/members\/\d+$/, 'Tirou jogador da mesa'],
  ['POST', /^\/tables\/\d+\/leave$/, 'Saiu da mesa'],
  ['PUT', /^\/tables\/\d+\/character$/, 'Escolheu ficha na mesa'],
  ['DELETE', /^\/tables\/\d+\/character$/, 'Tirou a ficha da mesa'],
  ['POST', /^\/tables\/\d+\/messages$/, 'Mandou mensagem na mesa', { noisy: true }],
  ['POST', /^\/tables\/\d+\/roll$/, 'Rolou dados na mesa', { noisy: true }],
  ['PATCH', /^\/tables\/\d+\/party\/\d+$/, 'Mestre ajustou personagem na mesa', { noisy: true }],
  ['PUT', /^\/tables\/\d+\/party\/\d+\/sheet$/, 'Mestre editou ficha na mesa'],
  ['PUT', /^\/tables\/\d+\/initiative$/, 'Ajustou a iniciativa', { noisy: true }],
  ['POST', /^\/tables\/\d+\/initiative\/next$/, 'Passou o turno', { noisy: true }],
  ['POST', /^\/tables\/\d+\/library$/, 'Biblioteca da mesa: adicionou'],
  ['PATCH', /^\/tables\/\d+\/library\//, 'Biblioteca da mesa: editou'],
  ['DELETE', /^\/tables\/\d+\/library\//, 'Biblioteca da mesa: apagou'],
  ['POST', /^\/tables\/\d+\/images$/, 'Mostrou imagem na mesa'],
  ['POST', /^\/tables\/\d+\/notes$/, 'Caderno do Mestre: anotou', { noisy: true }],
  ['PATCH', /^\/tables\/\d+\/notes\/\d+$/, 'Caderno do Mestre: editou', { noisy: true }],
  ['DELETE', /^\/tables\/\d+\/notes\/\d+$/, 'Caderno do Mestre: apagou', { noisy: true }],
  ['POST', /^\/templates$/, 'Meus modelos: criou', { detail: named }],
  ['POST', /^\/templates\/from-library$/, 'Meus modelos: guardou da Biblioteca', { detail: named }],
  ['PATCH', /^\/templates\/\d+$/, 'Meus modelos: editou', { detail: named }],
  ['DELETE', /^\/templates\/\d+$/, 'Meus modelos: apagou'],
  ['PATCH', /^\/admin\/users\/\d+$/, 'Admin: mudou o papel de uma conta'],
  ['POST', /^\/admin\/users\/\d+\/password-reset$/, 'Admin: gerou link de nova senha'],
  ['DELETE', /^\/admin\/users\/\d+$/, 'Admin: removeu uma conta'],
  ['DELETE', /^\/admin\/password-requests\/\d+$/, 'Admin: dispensou pedido de nova senha'],
  ['POST', /^\/client-error$/, null],
];

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

function describe(method, path) {
  const route = ROUTES.find(([m, pattern]) => m === method && pattern.test(path));
  if (route) return { action: route[2], ...(route[3] ?? {}) };
  // Rota nova que ainda não tem nome: grava assim mesmo, com os números trocados por ":id".
  return { action: `${method} ${path.replace(/\/\d+/g, '/:id')}` };
}

const clip = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
};

/** Grava uma linha. Falhar aqui nunca atrapalha a pessoa: só avisa no log do servidor. */
export async function recordActivity(db, { userId = null, action, detail = null, status, error = null, durationMs = null }, { console: toConsole = false } = {}) {
  const row = [userId, clip(action), clip(detail), status, clip(error), durationMs];
  if (toConsole) {
    console.log(`[atividade] conta ${userId ?? '-'} · ${row[1]}${row[2] ? ` · ${row[2]}` : ''} · ${status}${row[4] ? ` · ${row[4]}` : ''}${durationMs !== null ? ` · ${durationMs} ms` : ''}`);
  }
  try {
    await db.run(
      'INSERT INTO activity_log (user_id, action, detail, status, error, duration_ms) VALUES (?, ?, ?, ?, ?, ?)',
      ...row,
    );
  } catch (err) {
    console.warn(`Atividade não registrada: ${err.message}`);
  }
}

/**
 * Antes das rotas da API. Registra toda ação que muda algo (não as leituras), quando a resposta termina.
 * As rotas de login informam a conta em res.locals.activityUserId (ainda não há req.user ali).
 */
export function activityLog(db, { console: toConsole = false } = {}) {
  let lastPrune = 0;
  return (req, res, next) => {
    if (READS.has(req.method)) return next();
    const path = req.path;
    const info = describe(req.method, path);
    if (!info.action) return next();
    const started = Date.now();
    let body;
    const json = res.json.bind(res);
    res.json = (value) => {
      body = value;
      return json(value);
    };
    res.on('finish', () => {
      const status = res.statusCode;
      if (info.noisy && status < 400) return;
      let detail = null;
      try {
        detail = status < 400 && info.detail ? info.detail(body, req) : null;
      } catch {
        detail = null;
      }
      recordActivity(db, {
        userId: req.user?.id ?? res.locals.activityUserId ?? null,
        action: info.action,
        detail,
        status,
        error: status >= 400 ? (res.locals.errorMessage ?? body?.error ?? null) : null,
        durationMs: Date.now() - started,
      }, { console: toConsole });
      if (Date.now() - lastPrune > PRUNE_EVERY_MS) {
        lastPrune = Date.now();
        db.run(`DELETE FROM activity_log WHERE created_at < now() - interval '${RETENTION_DAYS} days'`)
          .catch((err) => console.warn(`Limpeza da atividade falhou: ${err.message}`));
      }
    });
    next();
  };
}

/**
 * Erros que acontecem na tela do jogador (no navegador), para o admin saber que algo quebrou no celular
 * de alguém. Só a mensagem do erro e onde aconteceu.
 */
export function clientErrorRoutes(db, { console: toConsole = false } = {}) {
  const router = Router();
  const limiter = rateLimit({ windowMs: 60 * 1000, max: 10, key: (req) => `u${req.user.id}`, message: 'Muitos avisos de erro seguidos.' });
  router.post('/', limiter, async (req, res) => {
    const message = clip(req.body?.message);
    if (!message) {
      res.status(204).end();
      return;
    }
    const where = clip([req.body?.view && `tela ${req.body.view}`, req.body?.source].filter(Boolean).join(' · '));
    await recordActivity(db, { userId: req.user.id, action: 'Erro na tela', detail: where, status: 0, error: message }, { console: toConsole });
    res.status(204).end();
  });
  return router;
}

/** Marca quando a conta usou o DataDice por último (no máximo uma gravação a cada 5 minutos por conta). */
export function touchLastSeen(db) {
  const recent = new Map();
  return (req, _res, next) => {
    const id = req.user?.id;
    const now = Date.now();
    if (id && (recent.get(id) ?? 0) < now - 5 * 60 * 1000) {
      recent.set(id, now);
      if (recent.size > 5000) recent.clear();
      db.run('UPDATE users SET last_seen_at = now() WHERE id = ?', id)
        .catch((err) => console.warn(`Último acesso não registrado: ${err.message}`));
    }
    next();
  };
}
