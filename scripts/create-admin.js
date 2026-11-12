// Cria (ou atualiza) a conta admin. Uso: npm run admin
// A senha é digitada sem aparecer na tela e nunca fica salva em arquivo.
import 'dotenv/config';
import { createInterface } from 'node:readline';
import { openDb } from '../src/db/connection.js';
import { ensureAdmin } from '../src/services/auth.js';

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Mostra só a pergunta; o que for digitado não aparece.
      rl._writeToOutput = (text) => { if (text.includes(question)) process.stdout.write(text); };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

if (!process.stdin.isTTY) {
  console.error('Rode este comando num terminal (PowerShell ou Prompt de Comando): npm run admin');
  process.exit(1);
}

const db = await openDb({ connectionString: process.env.DATABASE_URL, max: 1 });

console.log('Criar conta admin do DataDice');
console.log('Se este banco veio de antes do login, a conta admin fica com os personagens e campanhas que já existem.\n');
const name = await ask('Seu nome: ');
const email = await ask('E-mail: ');
const password = await ask('Senha (mínimo 8 caracteres): ', { hidden: true });
const confirm = await ask('Repita a senha: ', { hidden: true });

if (password !== confirm) {
  console.error('As senhas não conferem. Nada foi alterado.');
  process.exit(1);
}

try {
  const { created } = await ensureAdmin(db, { name, email, password });
  console.log(created ? '\nConta admin criada.' : '\nConta admin atualizada.');
  console.log('Abra o DataDice e entre com esse e-mail e senha.');
} catch (err) {
  console.error(`\nNão foi possível criar a conta: ${err.message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
