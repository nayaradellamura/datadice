-- Versão da ordem de iniciativa: cada alteração soma 1. O Mestre envia a versão que viu; se alguém
-- mudou a ordem nesse meio-tempo (ex.: um jogador rolou iniciativa), o servidor recusa e a tela recarrega.
ALTER TABLE campaign_initiative ADD COLUMN version integer NOT NULL DEFAULT 0;
