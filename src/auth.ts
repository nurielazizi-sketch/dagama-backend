/// <reference types="@cloudflare/workers-types" />

interface Env {
  DB: D1Database;
}
interface Env {
  DB: D1Database;
}

export async function handleLogin(request: Request, env: Env): Promise<Response> {
  if (request.method === 'POST') {
    const body = await request.json() as any;
    const { email, password } = body;

    if (!email || !password) {
      return new Response(JSON.stringify({ error: 'Email and password required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // TODO: Validate credentials against database
    // For now, just return a mock token
    const token = btoa(`${email}:${Date.now()}`);

    return new Response(JSON.stringify({ token, email }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  return new Response('Method not allowed', { status: 405 });
}

export async function handleRegister(request: Request, env: Env): Promise<Response> {
  if (request.method === 'POST') {
    const body = await request.json() as any;
    const { email, password, name } = body;

    if (!email || !password || !name) {
      return new Response(JSON.stringify({ error: 'Email, password, and name required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // TODO: Store user in database
    const token = btoa(`${email}:${Date.now()}`);

    return new Response(JSON.stringify({ token, email, name }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  return new Response('Method not allowed', { status: 405 });
}