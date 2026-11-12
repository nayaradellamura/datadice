import { signToken } from '../src/services/auth.js';

export const SECRET = 'segredo-de-teste-com-bem-mais-de-32-caracteres';
// Formato de chave do Google, mas falsa: nos testes o Gemini é sempre substituído.
export const GEMINI_KEY = 'AIzaChaveDeTesteFalsa_0123456789abcdefgh';

let counter = 0;

/**
 * Cria um usuário direto no banco (sem o bcrypt, que deixaria os testes lentos) e devolve o token dele.
 * O hash é só um marcador: login por senha é testado à parte, em auth.test.js.
 */
export async function addUser(db, { name = 'Jogadora', email, role = 'player' } = {}) {
  counter += 1;
  const { id } = await db.run(
    `INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, 'hash-de-teste', ?) RETURNING id`,
    name, email ?? `jogador${counter}@teste.dev`, role,
  );
  return { id, role, token: signToken({ id, role }, SECRET) };
}

export const authHeaders = (token, { key = GEMINI_KEY } = {}) => ({
  'content-type': 'application/json',
  authorization: `Bearer ${token}`,
  ...(key ? { 'x-gemini-key': key } : {}),
});
