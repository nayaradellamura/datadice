-- Registro de atividade para o Painel Admin: o que cada conta fez e o que deu erro.
-- Guarda só o nome da ação, um detalhe curto (ex.: nome da ficha) e a mensagem de erro. Nunca o conteúdo
-- das mensagens, senhas ou chaves. Some junto com a conta e é apagado depois de 60 dias.
CREATE TABLE activity_log (
  id bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  user_id integer REFERENCES users(id) ON DELETE CASCADE,
  action text NOT NULL,
  detail text,
  status integer NOT NULL,
  error text,
  duration_ms integer
);
CREATE INDEX activity_log_created ON activity_log (created_at DESC);
CREATE INDEX activity_log_user ON activity_log (user_id, created_at DESC);

-- Quando a conta usou o DataDice por último (atualizado no máximo a cada 5 minutos).
ALTER TABLE users ADD COLUMN last_seen_at timestamptz;
