import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';

if (!process.env.GEMINI_API_KEY) {
  console.error('Configure a GEMINI_API_KEY no arquivo .env.');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const pager = await ai.models.list();
for await (const model of pager) {
  if (model.supportedActions?.includes('generateContent')) {
    console.log(model.name.replace('models/', ''));
  }
}
