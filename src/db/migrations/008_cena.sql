-- Ambiente da cena atual (tipo de lugar, hora do dia e nome), informado pelo Mestre IA a cada resposta.
-- Mostrado como uma faixa ilustrada no topo do chat, sem gerar imagem (vale no plano gratuito).
ALTER TABLE campaigns ADD COLUMN scene_json text;
