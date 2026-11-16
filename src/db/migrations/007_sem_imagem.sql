-- 'none': elemento da Biblioteca sem imagem (ilustrações desligadas ou chave sem geração de imagens).
-- Ele aparece com a descrição do Mestre, sem cara de erro.
-- As tabelas foram criadas com LIKE, então o nome da regra antiga varia: apaga toda regra sobre image_status.
DO $$
DECLARE
  rule record;
BEGIN
  FOR rule IN
    SELECT c.conrelid::regclass AS tbl, c.conname
    FROM pg_constraint c
    WHERE c.contype = 'c'
      AND c.conrelid IN ('npcs'::regclass, 'monsters'::regclass, 'locations'::regclass)
      AND pg_get_constraintdef(c.oid) LIKE '%image_status%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', rule.tbl, rule.conname);
  END LOOP;
END $$;

ALTER TABLE npcs ADD CONSTRAINT npcs_image_status_valid CHECK (image_status IN ('pending', 'ready', 'failed', 'none'));
ALTER TABLE monsters ADD CONSTRAINT monsters_image_status_valid CHECK (image_status IN ('pending', 'ready', 'failed', 'none'));
ALTER TABLE locations ADD CONSTRAINT locations_image_status_valid CHECK (image_status IN ('pending', 'ready', 'failed', 'none'));

-- As falhas do plano gratuito não eram erro de verdade: viram fichas sem imagem.
UPDATE npcs SET image_status = 'none', image_error = NULL WHERE image_status = 'failed' AND image_error LIKE '%plano gratuito%';
UPDATE monsters SET image_status = 'none', image_error = NULL WHERE image_status = 'failed' AND image_error LIKE '%plano gratuito%';
UPDATE locations SET image_status = 'none', image_error = NULL WHERE image_status = 'failed' AND image_error LIKE '%plano gratuito%';
