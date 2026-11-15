-- "Esqueci minha senha" na tela de login: o pedido fica pendente no Painel Admin até o admin gerar o link
-- (ou dispensar). Um pedido por conta; pedir de novo só atualiza a hora.
CREATE TABLE password_reset_requests (
  user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
