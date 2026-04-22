/// <reference types="@cloudflare/workers-types" />

interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
}
interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
}

export async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  try {
    const update = await request.json() as any;
    
    // Handle incoming messages
    if (update.message) {
      const message = update.message;
      const chatId = message.chat.id;
      const text = message.text || '';
      
      // Simple echo for now
      await sendMessage(chatId, `You said: ${text}`, env);
    }
    
    return new Response('OK', { status: 200 });
  } catch (error) {
    console.error('Error:', error);
    return new Response('Error', { status: 500 });
  }
}

async function sendMessage(chatId: number, text: string, env: Env): Promise<void> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text
    })
  });
}