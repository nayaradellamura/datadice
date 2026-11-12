import { HttpError } from '../middleware/errorHandler.js';

/**
 * Tempo real das mesas (Server-Sent Events). Cada aba aberta numa mesa mantém uma conexão; quando algo
 * acontece, o servidor manda o evento só para quem pode vê-lo.
 *
 * Fica na memória deste processo: na hospedagem, rode UMA instância do servidor (o plano do Beta já é assim).
 */
// Conexões abertas ao mesmo tempo: por pessoa (somando todas as mesas e abas) e no servidor inteiro.
export const MAX_STREAMS_PER_USER = 8;
export const MAX_STREAMS_TOTAL = 2000;

export function createTableHub({ heartbeatMs = 25000, maxPerUser = MAX_STREAMS_PER_USER, maxTotal = MAX_STREAMS_TOTAL } = {}) {
  // campaignId -> Set<sub>; sub = { campaignId, userId, role, res, timer }
  const rooms = new Map();
  let total = 0;

  const alive = (res) => !res.writableEnded && !res.destroyed;

  // Uma conexão pode ter acabado de fechar (removida, aba fechada): nunca escreve depois do fim.
  function send(res, event, data) {
    if (!alive(res)) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function drop(sub) {
    const subs = rooms.get(sub.campaignId);
    if (!subs?.delete(sub)) return;
    total -= 1;
    clearTimeout(sub.timer);
    if (!subs.size) rooms.delete(sub.campaignId);
  }

  function end(sub) {
    drop(sub);
    if (alive(sub.res)) sub.res.end();
  }

  const allSubs = () => [...rooms.values()].flatMap((subs) => [...subs]);

  // Sinal de vida a cada 25 s (proxies cortam conexões caladas) e limpeza de conexões que morreram.
  const heartbeat = setInterval(() => {
    for (const sub of allSubs()) {
      if (alive(sub.res)) sub.res.write(': ping\n\n');
      else drop(sub);
    }
  }, heartbeatMs);
  heartbeat.unref();

  return {
    /**
     * Abre o canal para uma pessoa da mesa. expiresAt (ms): quando o login vence, o canal fecha e a
     * página precisa entrar de novo. Devolve a função que fecha.
     */
    subscribe(campaignId, { userId, role, expiresAt = null }, req, res) {
      // A pessoa fechou a aba enquanto a mesa era conferida: nada a abrir.
      if (req.destroyed || !alive(res)) return () => {};
      // Muitas abas da mesma pessoa (somando todas as mesas): fecha as mais antigas.
      const mine = allSubs().filter((sub) => sub.userId === userId);
      for (const old of mine.slice(0, Math.max(0, mine.length - maxPerUser + 1))) end(old);
      if (total >= maxTotal) throw new HttpError(503, 'O servidor está cheio agora. Tente de novo em alguns minutos.');

      res.status(200).set({
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        connection: 'keep-alive',
        // Proxies (nginx, Cloudflare) não podem segurar os eventos.
        'x-accel-buffering': 'no',
      });
      res.flushHeaders?.();
      res.write('retry: 3000\n\n');
      const sub = { campaignId, userId, role, res, timer: null };
      let subs = rooms.get(campaignId);
      if (!subs) rooms.set(campaignId, (subs = new Set()));
      subs.add(sub);
      total += 1;
      if (expiresAt) {
        // setTimeout aceita no máximo ~24 dias; o login dura 7.
        sub.timer = setTimeout(() => { send(res, 'expired', {}); end(sub); }, Math.max(0, Math.min(expiresAt - Date.now(), 2 ** 31 - 1)));
        sub.timer.unref?.();
      }
      const close = () => drop(sub);
      req.on('close', close);
      res.on('close', close);
      send(res, 'ready', { ok: true });
      return () => end(sub);
    },

    /** Manda um evento para quem estiver na mesa. filter(sub) decide quem recebe. */
    publish(campaignId, event, data, filter = () => true) {
      const subs = rooms.get(campaignId);
      if (!subs) return;
      for (const sub of [...subs]) {
        if (!filter(sub)) continue;
        send(sub.res, event, typeof data === 'function' ? data(sub) : data);
      }
    },

    /** Tira alguém da mesa na hora (removido pelo Mestre, mesa excluída). */
    kick(campaignId, userId = null) {
      const subs = rooms.get(campaignId);
      if (!subs) return;
      for (const sub of [...subs]) {
        if (userId !== null && sub.userId !== userId) continue;
        send(sub.res, 'kicked', {});
        end(sub);
      }
    },

    /** Quantas conexões abertas a mesa tem (ou o servidor todo, sem campaignId). Usado nos testes. */
    count(campaignId) {
      return campaignId === undefined ? total : rooms.get(campaignId)?.size ?? 0;
    },

    /** Fecha tudo (desligamento do servidor), senão as conexões abertas seguram o encerramento. */
    closeAll() {
      clearInterval(heartbeat);
      for (const sub of allSubs()) end(sub);
      rooms.clear();
      total = 0;
    },
  };
}
