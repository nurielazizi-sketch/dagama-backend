/// <reference types="@cloudflare/workers-types" />

import { handleLogin, handleRegister, handleMe, handleStats, handleInsights } from './auth';
import { handleTelegramWebhook, handleSetupWebhook } from './telegram';
import type { Env } from './types';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // API routes
    if (path === '/api/auth/register') return addCors(await handleRegister(request, env));
    if (path === '/api/auth/login')    return addCors(await handleLogin(request, env));
    if (path === '/api/me')                  return addCors(await handleMe(request, env));
    if (path === '/api/stats')               return addCors(await handleStats(request, env));
    if (path === '/api/insights')            return addCors(await handleInsights(request, env));
    if (path === '/api/telegram/webhook')    return handleTelegramWebhook(request, env);
    if (path === '/api/telegram/setup')      return addCors(await handleSetupWebhook(request, env));

    // UI routes
    if (path === '/') {
      return new Response(LANDING_PAGE, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    if (path === '/login') {
      return new Response(LOGIN_PAGE, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    if (path === '/register') {
      return new Response(REGISTER_PAGE, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    if (path === '/dashboard') {
      return new Response(DASHBOARD_PAGE, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    return new Response('Not found', { status: 404 });
  }
};

function addCors(response: Response): Response {
  const res = new Response(response.body, response);
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.headers.set(k, v));
  return res;
}

const LANDING_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DaGama — Trade Show Intelligence Platform</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=Outfit:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    
    :root {
      --navy: #0F1419;
      --navy-light: #1a2235;
      --gold: #D4AF37;
      --gold-light: #E8C547;
      --slate-400: #94A3B8;
      --slate-500: #64748B;
      --slate-700: #334155;
      --slate-800: #1E293B;
      --white: #F5F5F5;
    }
    
    html { scroll-behavior: smooth; }
    
    body {
      font-family: 'Outfit', sans-serif;
      background: linear-gradient(135deg, var(--navy) 0%, #1a2844 100%);
      color: var(--white);
      line-height: 1.6;
      overflow-x: hidden;
    }
    
    body::before {
      content: '';
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: radial-gradient(circle at 20% 50%, rgba(212, 175, 55, 0.08) 0%, transparent 50%),
                  radial-gradient(circle at 80% 80%, rgba(212, 175, 55, 0.04) 0%, transparent 50%);
      pointer-events: none;
      z-index: 0;
    }
    
    /* HEADER */
    header {
      position: sticky;
      top: 0;
      z-index: 100;
      background: rgba(15, 20, 25, 0.92);
      backdrop-filter: blur(20px);
      border-bottom: 1px solid rgba(212, 175, 55, 0.1);
      padding: 1.25rem 2rem;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    }
    
    .header-container {
      max-width: 1400px;
      margin: 0 auto;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    
    .logo {
      font-size: 1.5rem;
      font-weight: 700;
      color: var(--gold);
      text-decoration: none;
      cursor: pointer;
      transition: all 0.3s ease;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    
    .logo:hover {
      text-shadow: 0 0 10px rgba(212, 175, 55, 0.5);
    }
    
    .compass {
      display: inline-block;
      font-size: 1.2rem;
      animation: spin 20s linear infinite;
    }
    
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    
    .cta-buttons { display: flex; gap: 1rem; align-items: center; }
    
    .btn-login {
      background: transparent;
      color: var(--slate-400);
      border: none;
      cursor: pointer;
      font-size: 0.95rem;
      font-weight: 500;
      transition: all 0.3s ease;
    }
    
    .btn-login:hover { color: var(--gold); }
    
    .btn-primary {
      padding: 0.75rem 2rem;
      background: linear-gradient(135deg, var(--gold), var(--gold-light));
      color: var(--navy);
      border: none;
      border-radius: 8px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s ease;
      box-shadow: 0 4px 15px rgba(212, 175, 55, 0.2);
    }
    
    .btn-primary:hover {
      transform: translateY(-3px);
      box-shadow: 0 8px 25px rgba(212, 175, 55, 0.35);
    }
    
    /* SPLIT HERO */
    .split-hero {
      min-height: 100vh;
      display: grid;
      grid-template-columns: 1fr 1fr;
      position: relative;
      z-index: 10;
      overflow: hidden;
    }
    
    .split-hero::before {
      content: '';
      position: absolute;
      top: 0;
      left: 50%;
      width: 2px;
      height: 100%;
      background: linear-gradient(180deg, transparent 0%, rgba(212, 175, 55, 0.2) 50%, transparent 100%);
      z-index: 5;
    }
    
    .hero-side {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 4rem 3rem;
      position: relative;
      transition: all 0.8s ease;
      cursor: pointer;
    }
    
    .hero-side::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: radial-gradient(circle at 50% 50%, rgba(212, 175, 55, 0.05) 0%, transparent 100%);
      opacity: 0;
      transition: opacity 0.8s ease;
      z-index: 1;
    }
    
    .hero-side:hover::before {
      opacity: 1;
    }
    
    .hero-side.active::before {
      opacity: 1;
    }
    
    .hero-content {
      text-align: center;
      z-index: 2;
      animation: fadeInUp 1s ease-out;
      transition: all 0.6s ease;
    }
    
    .hero-side.active .hero-content {
      transform: scale(1.05);
    }
    
    .hero-icon {
      font-size: 5rem;
      margin-bottom: 2rem;
      animation: float 3s ease-in-out infinite;
    }
    
    @keyframes float {
      0%, 100% { transform: translateY(0px); }
      50% { transform: translateY(-20px); }
    }
    
    .hero-side.active .hero-icon {
      animation: bounce 0.6s ease-out;
    }
    
    @keyframes bounce {
      0% { transform: scale(1) translateY(0); }
      50% { transform: scale(1.1) translateY(-30px); }
      100% { transform: scale(1) translateY(0); }
    }
    
    .hero-side h2 {
      font-family: 'Playfair Display', serif;
      font-size: clamp(2rem, 5vw, 3.5rem);
      font-weight: 900;
      margin-bottom: 1.5rem;
      background: linear-gradient(135deg, var(--white), var(--gold));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      transition: all 0.6s ease;
    }
    
    .hero-side.active h2 {
      -webkit-text-fill-color: var(--gold);
      color: var(--gold);
    }
    
    .hero-side p {
      font-size: 1.1rem;
      color: var(--slate-400);
      margin-bottom: 2rem;
      line-height: 1.8;
      max-width: 400px;
      transition: color 0.6s ease;
    }
    
    .hero-side.active p {
      color: var(--white);
    }
    
    .hero-features {
      list-style: none;
      text-align: left;
      margin-bottom: 2rem;
      max-width: 400px;
    }
    
    .hero-features li {
      margin-bottom: 0.8rem;
      color: var(--slate-400);
      font-size: 0.95rem;
      transition: all 0.3s ease;
      display: flex;
      align-items: center;
      gap: 0.8rem;
    }
    
    .hero-side.active .hero-features li {
      color: var(--white);
      transform: translateX(10px);
    }
    
    .hero-features li::before {
      content: '→';
      color: var(--gold);
      font-weight: bold;
      font-size: 1.2rem;
    }
    
    .btn-choose {
      padding: 1.2rem 3rem;
      background: linear-gradient(135deg, var(--gold), var(--gold-light));
      color: var(--navy);
      border: none;
      border-radius: 8px;
      font-weight: 700;
      font-size: 1rem;
      cursor: pointer;
      transition: all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
      box-shadow: 0 8px 25px rgba(212, 175, 55, 0.2);
      position: relative;
      overflow: hidden;
    }
    
    .btn-choose::before {
      content: '';
      position: absolute;
      top: 0;
      left: -100%;
      width: 100%;
      height: 100%;
      background: rgba(255, 255, 255, 0.3);
      transition: left 0.4s ease;
      z-index: 0;
    }
    
    .btn-choose:hover::before {
      left: 100%;
    }
    
    .btn-choose:hover {
      transform: translateY(-6px) scale(1.05);
      box-shadow: 0 12px 40px rgba(212, 175, 55, 0.4);
    }
    
    .hero-side:hover .btn-choose {
      transform: translateY(-6px) scale(1.05);
    }
    
    /* CONTENT SECTIONS - Hidden by default */
    .buyer-content,
    .exhibitor-content {
      max-width: 1400px;
      margin: 8rem auto;
      padding: 0 2rem;
      position: relative;
      z-index: 10;
      display: none;
    }
    
    .buyer-content.active,
    .exhibitor-content.active {
      display: block;
      animation: fadeInUp 0.8s ease-out;
    }
    
    .section-title {
      font-family: 'Playfair Display', serif;
      font-size: clamp(2rem, 6vw, 3.5rem);
      font-weight: 900;
      margin-bottom: 4rem;
      text-align: center;
      background: linear-gradient(135deg, var(--white), var(--gold));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      animation: fadeInUp 0.8s ease-out;
    }
    
    .features-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 2rem;
    }
    
    .feature {
      background: linear-gradient(135deg, rgba(30, 41, 59, 0.9), rgba(30, 41, 59, 0.6));
      border: 1px solid rgba(212, 175, 55, 0.15);
      border-radius: 16px;
      padding: 2.5rem;
      transition: all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
      backdrop-filter: blur(20px);
      position: relative;
      overflow: hidden;
      animation: fadeInUp 0.8s ease-out;
      animation-fill-mode: both;
    }
    
    .feature:nth-child(1) { animation-delay: 0s; }
    .feature:nth-child(2) { animation-delay: 0.1s; }
    .feature:nth-child(3) { animation-delay: 0.2s; }
    .feature:nth-child(4) { animation-delay: 0.1s; }
    .feature:nth-child(5) { animation-delay: 0.2s; }
    .feature:nth-child(6) { animation-delay: 0.3s; }
    
    .feature::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: linear-gradient(135deg, rgba(212, 175, 55, 0.1), transparent);
      opacity: 0;
      transition: opacity 0.4s ease;
      z-index: 1;
    }
    
    .feature:hover::before {
      opacity: 1;
    }
    
    .feature:hover {
      border-color: rgba(212, 175, 55, 0.4);
      transform: translateY(-12px);
      box-shadow: 0 20px 60px rgba(212, 175, 55, 0.2);
    }
    
    .feature > * { position: relative; z-index: 2; }
    
    .feature-icon {
      font-size: 2.5rem;
      margin-bottom: 1rem;
    }
    
    .feature h3 { 
      font-size: 1.3rem; 
      margin-bottom: 0.8rem;
      color: var(--white);
    }
    
    .feature p { 
      color: var(--slate-400); 
      font-size: 0.95rem;
      line-height: 1.7;
    }
    
    /* PRICING SECTION */
    .pricing-section {
      max-width: 1400px;
      margin: 8rem auto;
      padding: 0 2rem;
      text-align: center;
      position: relative;
      z-index: 10;
      display: none;
    }
    
    .pricing-section.active {
      display: block;
    }
    
    .pricing-subtitle { 
      color: var(--slate-400); 
      font-size: 1.15rem; 
      margin-bottom: 4rem;
      animation: fadeInUp 0.8s ease-out;
    }
    
    .pricing-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 2rem;
    }
    
    .pricing-card {
      background: linear-gradient(135deg, rgba(30, 41, 59, 0.9), rgba(30, 41, 59, 0.6));
      border: 1px solid rgba(212, 175, 55, 0.15);
      border-radius: 16px;
      padding: 3rem;
      transition: all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
      backdrop-filter: blur(20px);
      position: relative;
      animation: fadeInUp 0.8s ease-out;
      animation-fill-mode: both;
    }
    
    .pricing-card:nth-child(2) { 
      animation-delay: 0.1s;
      border-color: rgba(212, 175, 55, 0.3);
      background: linear-gradient(135deg, rgba(30, 41, 59, 1), rgba(30, 41, 59, 0.8));
    }
    
    .pricing-card:nth-child(3) { animation-delay: 0.2s; }
    
    .pricing-card:hover {
      border-color: rgba(212, 175, 55, 0.4);
      transform: translateY(-15px);
      box-shadow: 0 20px 60px rgba(212, 175, 55, 0.2);
    }
    
    .pricing-name { 
      font-size: 1.3rem; 
      font-weight: 700; 
      margin-bottom: 0.5rem;
      color: var(--white);
    }
    
    .pricing-price { 
      font-size: 2.8rem; 
      font-weight: 900; 
      background: linear-gradient(135deg, var(--gold), var(--gold-light));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 0.5rem;
    }
    
    .pricing-desc { 
      color: var(--slate-400); 
      font-size: 0.95rem; 
      margin-bottom: 2rem;
    }
    
    .pricing-features { 
      text-align: left; 
      margin-bottom: 2rem; 
      list-style: none;
    }
    
    .pricing-features li {
      color: var(--slate-400);
      margin-bottom: 0.75rem;
      padding-left: 1.5rem;
      position: relative;
      transition: all 0.3s ease;
    }
    
    .pricing-features li:hover {
      color: var(--gold);
      padding-left: 2rem;
    }
    
    .pricing-features li::before {
      content: '✓';
      position: absolute;
      left: 0;
      color: var(--gold);
      font-weight: bold;
    }
    
    .pricing-card button {
      width: 100%;
      padding: 1.2rem;
      background: linear-gradient(135deg, var(--gold), var(--gold-light));
      color: var(--navy);
      border: none;
      border-radius: 8px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s ease;
      box-shadow: 0 4px 15px rgba(212, 175, 55, 0.2);
    }
    
    .pricing-card button:hover {
      transform: translateY(-3px);
      box-shadow: 0 8px 25px rgba(212, 175, 55, 0.3);
    }
    
    /* BACK BUTTON */
    .back-button {
      max-width: 1400px;
      margin: 4rem auto 0;
      padding: 0 2rem;
      position: relative;
      z-index: 10;
    }
    
    .back-btn {
      padding: 0.75rem 1.5rem;
      background: transparent;
      color: var(--gold);
      border: 1px solid var(--gold);
      border-radius: 8px;
      cursor: pointer;
      font-weight: 600;
      transition: all 0.3s ease;
    }
    
    .back-btn:hover {
      background: var(--gold);
      color: var(--navy);
      transform: translateY(-2px);
    }
    
    .back-button { display: none; }
    .back-button.show { display: block; }
    
    /* FOOTER */
    footer {
      background: rgba(15, 20, 25, 0.95);
      border-top: 1px solid rgba(212, 175, 55, 0.1);
      padding: 4rem 2rem;
      margin-top: 8rem;
      text-align: center;
      position: relative;
      z-index: 10;
    }
    
    .footer-bottom { 
      color: var(--slate-600); 
      font-size: 0.9rem;
    }
    
    /* ANIMATIONS */
    @keyframes fadeInUp {
      from {
        opacity: 0;
        transform: translateY(40px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
    
    /* RESPONSIVE */
    @media (max-width: 768px) {
      .split-hero {
        grid-template-columns: 1fr;
      }
      
      .split-hero::before {
        left: 0;
        width: 100%;
        height: 2px;
      }
      
      .hero-side {
        min-height: 50vh;
      }
      
      .hero-icon { font-size: 3.5rem; }
      .hero-side h2 { font-size: 2rem; }
      
      .features-grid,
      .pricing-grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <header>
    <div class="header-container">
      <a href="/" class="logo">
        <span class="compass">🧭</span>
        DaGama
      </a>
      <div class="cta-buttons">
        <a href="/login" class="btn-login">Log in</a>
        <a href="/register" class="btn-primary">Get Started</a>
      </div>
    </div>
  </header>

  <!-- SPLIT HERO -->
  <section class="split-hero" id="heroSection">
    <!-- LEFT: EXHIBITOR -->
    <div class="hero-side" id="exhibitorChoice" onclick="chooseRole('exhibitor')">
      <div class="hero-content">
        <div class="hero-icon">👤</div>
        <h2>I'm Exhibiting</h2>
        <p>Capture every buyer that walks past your booth. Never lose a lead again.</p>
        <ul class="hero-features">
          <li>Capture buyer cards instantly</li>
          <li>Teams see activity in real-time</li>
          <li>Auto follow-up emails</li>
          <li>Your data in Google Sheets</li>
        </ul>
        <button class="btn-choose">Choose ShowBot →</button>
      </div>
    </div>

    <!-- RIGHT: BUYER -->
    <div class="hero-side" id="buyerChoice" onclick="chooseRole('buyer')">
      <div class="hero-content">
        <div class="hero-icon">📦</div>
        <h2>I'm Sourcing</h2>
        <p>Capture suppliers, products, and prices. Organize 400+ items in one place.</p>
        <ul class="hero-hero-features">
          <li>Photo suppliers and products</li>
          <li>Record prices and MOQs</li>
          <li>Voice notes for context</li>
          <li>Your data in Google Sheets</li>
        </ul>
        <button class="btn-choose">Choose SourceBot →</button>
      </div>
    </div>
  </section>

  <!-- EXHIBITOR CONTENT -->
  <div class="exhibitor-content" id="exhibitorContent">
    <h2 class="section-title">ShowBot: Never Lose a Buyer</h2>
    <div class="features-grid">
      <div class="feature">
        <div class="feature-icon">📸</div>
        <h3>Photo Business Cards</h3>
        <p>Your team takes a photo. DaGama extracts everything: name, email, phone, company.</p>
      </div>
      <div class="feature">
        <div class="feature-icon">🎤</div>
        <h3>Voice Notes</h3>
        <p>Record a 10-second note about the meeting. Transcribed and attached forever.</p>
      </div>
      <div class="feature">
        <div class="feature-icon">📊</div>
        <h3>Manager Dashboard</h3>
        <p>See what your entire team captured today. Real-time activity updates.</p>
      </div>
      <div class="feature">
        <div class="feature-icon">✉️</div>
        <h3>Auto Follow-ups</h3>
        <p>DaGama generates follow-up emails. You review and send. Done in seconds.</p>
      </div>
      <div class="feature">
        <div class="feature-icon">🌍</div>
        <h3>Works Everywhere</h3>
        <p>HKTDC, Canton Fair, Dubai, Frankfurt. Any show, any organizer.</p>
      </div>
      <div class="feature">
        <div class="feature-icon">🔐</div>
        <h3>Your Data. Always.</h3>
        <p>Everything goes to YOUR Google Sheet. Cancel anytime, keep everything.</p>
      </div>
    </div>

    <h2 class="section-title" style="margin-top: 6rem;">ShowBot Pricing</h2>
    <div class="pricing-section exhibitor-pricing active">
      <div class="pricing-grid">
        <div class="pricing-card">
          <div class="pricing-name">Single Show</div>
          <div class="pricing-price">49 USD</div>
          <div class="pricing-desc">Per show</div>
          <ul class="pricing-features">
            <li>Telegram bot for your team</li>
            <li>Capture unlimited cards</li>
            <li>Gemini AI extraction</li>
            <li>Voice notes</li>
            <li>Manager dashboard</li>
            <li>ExpenseBot included</li>
          </ul>
          <button onclick="window.location.href='/register'">Get Started</button>
        </div>
        <div class="pricing-card">
          <div class="pricing-name">3-Show Pack</div>
          <div class="pricing-price">129 USD</div>
          <div class="pricing-desc">Save 18 USD</div>
          <ul class="pricing-features">
            <li>3 shows at once</li>
            <li>Capture unlimited cards</li>
            <li>Gemini AI extraction</li>
            <li>Voice notes</li>
            <li>Manager dashboard</li>
            <li>ExpenseBot included</li>
          </ul>
          <button onclick="window.location.href='/register'">Get Started</button>
        </div>
        <div class="pricing-card">
          <div class="pricing-name">Team Plan</div>
          <div class="pricing-price">79 USD</div>
          <div class="pricing-desc">Per month</div>
          <ul class="pricing-features">
            <li>Unlimited shows</li>
            <li>Unlimited team members</li>
            <li>Gemini AI extraction</li>
            <li>Voice notes</li>
            <li>Full manager dashboard</li>
            <li>ExpenseBot included</li>
          </ul>
          <button onclick="window.location.href='/register'">Get Started</button>
        </div>
      </div>
    </div>
  </div>

  <!-- BUYER CONTENT -->
  <div class="buyer-content" id="buyerContent">
    <h2 class="section-title">SourceBot: Capture Every Supplier</h2>
    <div class="features-grid">
      <div class="feature">
        <div class="feature-icon">📷</div>
        <h3>Photo Suppliers & Products</h3>
        <p>Take photos of business cards, products, brochures. DaGama extracts everything.</p>
      </div>
      <div class="feature">
        <div class="feature-icon">💰</div>
        <h3>Price & MOQ Capture</h3>
        <p>Record prices and minimum order quantities with voice notes. Never forget details.</p>
      </div>
      <div class="feature">
        <div class="feature-icon">🎤</div>
        <h3>Voice Notes</h3>
        <p>Record context about products, pricing, lead time. Transcribed and organized.</p>
      </div>
      <div class="feature">
        <div class="feature-icon">📊</div>
        <h3>Compare Suppliers</h3>
        <p>All suppliers and prices in one Google Sheet. Easy to pivot and analyze.</p>
      </div>
      <div class="feature">
        <div class="feature-icon">📈</div>
        <h3>Team Collaboration</h3>
        <p>Your whole team captures. See what everyone found. Organize by priority.</p>
      </div>
      <div class="feature">
        <div class="feature-icon">🔐</div>
        <h3>Your Data. Always.</h3>
        <p>Everything goes to YOUR Google Sheet. Own your sourcing intelligence forever.</p>
      </div>
    </div>

    <h2 class="section-title" style="margin-top: 6rem;">SourceBot Pricing</h2>
    <div class="pricing-section buyer-pricing active">
      <div class="pricing-grid">
        <div class="pricing-card">
          <div class="pricing-name">Single Show</div>
          <div class="pricing-price">49 USD</div>
          <div class="pricing-desc">Per show</div>
          <ul class="pricing-features">
            <li>Telegram bot access</li>
            <li>Photo capture</li>
            <li>Gemini AI extraction</li>
            <li>Voice notes</li>
            <li>Google Sheet output</li>
            <li>ExpenseBot included</li>
          </ul>
          <button onclick="window.location.href='/register'">Get Started</button>
        </div>
        <div class="pricing-card">
          <div class="pricing-name">Canton Fair Bundle</div>
          <div class="pricing-price">99 USD</div>
          <div class="pricing-desc">All 3 phases</div>
          <ul class="pricing-features">
            <li>3 phases: 15 Apr - 5 Jun</li>
            <li>Photo capture</li>
            <li>Gemini AI extraction</li>
            <li>Voice notes</li>
            <li>Google Sheet output</li>
            <li>ExpenseBot included</li>
          </ul>
          <button onclick="window.location.href='/register'">Get Started</button>
        </div>
        <div class="pricing-card">
          <div class="pricing-name">Team Plan</div>
          <div class="pricing-price">79 USD</div>
          <div class="pricing-desc">Per month</div>
          <ul class="pricing-features">
            <li>Unlimited shows</li>
            <li>Unlimited team members</li>
            <li>Gemini AI extraction</li>
            <li>Voice notes</li>
            <li>Team analytics</li>
            <li>ExpenseBot included</li>
          </ul>
          <button onclick="window.location.href='/register'">Get Started</button>
        </div>
      </div>
    </div>
  </div>

  <!-- BACK BUTTON -->
  <div class="back-button" id="backButton">
    <button class="back-btn" onclick="goBack()">← Back to Choose</button>
  </div>

  <!-- FOOTER -->
  <footer>
    <div class="footer-bottom">
      <p>&copy; 2026 DaGama. Trade show intelligence for global buyers and sellers.</p>
    </div>
  </footer>

  <script>
    function chooseRole(role) {
      const heroSection = document.getElementById('heroSection');
      const exhibitorContent = document.getElementById('exhibitorContent');
      const buyerContent = document.getElementById('buyerContent');
      const backButton = document.getElementById('backButton');
      
      // Hide hero, show content
      heroSection.style.display = 'none';
      backButton.classList.add('show');
      
      if (role === 'exhibitor') {
        exhibitorContent.classList.add('active');
        buyerContent.classList.remove('active');
      } else {
        buyerContent.classList.add('active');
        exhibitorContent.classList.remove('active');
      }
      
      // Scroll to top
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    
    function goBack() {
      const heroSection = document.getElementById('heroSection');
      const exhibitorContent = document.getElementById('exhibitorContent');
      const buyerContent = document.getElementById('buyerContent');
      const backButton = document.getElementById('backButton');
      
      // Show hero, hide content
      heroSection.style.display = 'grid';
      exhibitorContent.classList.remove('active');
      buyerContent.classList.remove('active');
      backButton.classList.remove('show');
      
      // Scroll to top
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    
    // Add hover effects on hero sides
    const exhibitorChoice = document.getElementById('exhibitorChoice');
    const buyerChoice = document.getElementById('buyerChoice');
    
    exhibitorChoice.addEventListener('mouseenter', function() {
      this.classList.add('active');
    });
    
    exhibitorChoice.addEventListener('mouseleave', function() {
      this.classList.remove('active');
    });
    
    buyerChoice.addEventListener('mouseenter', function() {
      this.classList.add('active');
    });
    
    buyerChoice.addEventListener('mouseleave', function() {
      this.classList.remove('active');
    });
  </script>
</body>
</html>`;

const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Log In — DaGama</title>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=Outfit:wght@400;600&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      background: linear-gradient(135deg, #0F1419 0%, #1a2844 100%);
      color: #F5F5F5; 
      font-family: 'Outfit', sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container { 
      max-width: 420px; 
      width: 100%;
      padding: 2rem; 
      background: linear-gradient(135deg, rgba(30, 41, 59, 0.9), rgba(30, 41, 59, 0.6));
      border: 1px solid rgba(212, 175, 55, 0.15);
      border-radius: 16px;
      backdrop-filter: blur(20px);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
      animation: fadeInUp 0.8s ease-out;
    }
    h1 { 
      font-family: 'Playfair Display', serif;
      font-size: 2.5rem; 
      margin-bottom: 2rem; 
      text-align: center;
      background: linear-gradient(135deg, #F5F5F5, #D4AF37);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    input { 
      width: 100%; 
      padding: 1rem; 
      margin-bottom: 1.2rem; 
      background: rgba(51, 65, 85, 0.5);
      border: 1px solid rgba(212, 175, 55, 0.15);
      border-radius: 8px; 
      color: #F5F5F5;
      font-family: 'Outfit', sans-serif;
      transition: all 0.3s ease;
    }
    input:focus {
      outline: none;
      border-color: rgba(212, 175, 55, 0.4);
      background: rgba(51, 65, 85, 0.7);
      box-shadow: 0 0 20px rgba(212, 175, 55, 0.15);
    }
    input::placeholder { color: #94A3B8; }
    button { 
      width: 100%; 
      padding: 1rem; 
      background: linear-gradient(135deg, #D4AF37, #E8C547);
      color: #0F1419; 
      border: none; 
      border-radius: 8px; 
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s ease;
      box-shadow: 0 4px 15px rgba(212, 175, 55, 0.2);
    }
    button:hover { 
      transform: translateY(-3px);
      box-shadow: 0 8px 25px rgba(212, 175, 55, 0.3);
    }
    p { 
      text-align: center; 
      margin-top: 1.5rem;
      color: #94A3B8;
      font-size: 0.95rem;
    }
    a { 
      color: #D4AF37; 
      text-decoration: none;
      transition: color 0.3s ease;
    }
    a:hover { color: #E8C547; }
    @keyframes fadeInUp {
      from { opacity: 0; transform: translateY(30px); }
      to { opacity: 1; transform: translateY(0); }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Log In</h1>
    <div id="error" style="display:none;color:#f87171;background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.3);border-radius:8px;padding:0.75rem 1rem;margin-bottom:1.2rem;font-size:0.9rem;"></div>
    <input id="email" type="email" placeholder="Email address" />
    <input id="password" type="password" placeholder="Password" />
    <button id="btn" onclick="doLogin()">Log In</button>
    <p>No account? <a href="/register">Sign up</a></p>
  </div>
  <script>
    async function doLogin() {
      const email = document.getElementById('email').value.trim();
      const password = document.getElementById('password').value;
      const err = document.getElementById('error');
      const btn = document.getElementById('btn');
      err.style.display = 'none';
      if (!email || !password) { err.textContent = 'Please fill in all fields.'; err.style.display = 'block'; return; }
      btn.textContent = 'Logging in…'; btn.disabled = true;
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });
        const data = await res.json();
        if (!res.ok) { err.textContent = data.error || 'Login failed.'; err.style.display = 'block'; return; }
        localStorage.setItem('dagama_token', data.token);
        localStorage.setItem('dagama_user', JSON.stringify(data.user));
        window.location.href = '/dashboard';
      } catch (e) {
        err.textContent = 'Network error. Please try again.'; err.style.display = 'block';
      } finally {
        btn.textContent = 'Log In'; btn.disabled = false;
      }
    }
    document.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  </script>
</body>
</html>`;

const REGISTER_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign Up — DaGama</title>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=Outfit:wght@400;600&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      background: linear-gradient(135deg, #0F1419 0%, #1a2844 100%);
      color: #F5F5F5; 
      font-family: 'Outfit', sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container { 
      max-width: 420px; 
      width: 100%;
      padding: 2rem; 
      background: linear-gradient(135deg, rgba(30, 41, 59, 0.9), rgba(30, 41, 59, 0.6));
      border: 1px solid rgba(212, 175, 55, 0.15);
      border-radius: 16px;
      backdrop-filter: blur(20px);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
      animation: fadeInUp 0.8s ease-out;
    }
    h1 { 
      font-family: 'Playfair Display', serif;
      font-size: 2.5rem; 
      margin-bottom: 2rem; 
      text-align: center;
      background: linear-gradient(135deg, #F5F5F5, #D4AF37);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    input { 
      width: 100%; 
      padding: 1rem; 
      margin-bottom: 1.2rem; 
      background: rgba(51, 65, 85, 0.5);
      border: 1px solid rgba(212, 175, 55, 0.15);
      border-radius: 8px; 
      color: #F5F5F5;
      font-family: 'Outfit', sans-serif;
      transition: all 0.3s ease;
    }
    input:focus {
      outline: none;
      border-color: rgba(212, 175, 55, 0.4);
      background: rgba(51, 65, 85, 0.7);
      box-shadow: 0 0 20px rgba(212, 175, 55, 0.15);
    }
    input::placeholder { color: #94A3B8; }
    button { 
      width: 100%; 
      padding: 1rem; 
      background: linear-gradient(135deg, #D4AF37, #E8C547);
      color: #0F1419; 
      border: none; 
      border-radius: 8px; 
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s ease;
      box-shadow: 0 4px 15px rgba(212, 175, 55, 0.2);
    }
    button:hover { 
      transform: translateY(-3px);
      box-shadow: 0 8px 25px rgba(212, 175, 55, 0.3);
    }
    p { 
      text-align: center; 
      margin-top: 1.5rem;
      color: #94A3B8;
      font-size: 0.95rem;
    }
    a { 
      color: #D4AF37; 
      text-decoration: none;
      transition: color 0.3s ease;
    }
    a:hover { color: #E8C547; }
    @keyframes fadeInUp {
      from { opacity: 0; transform: translateY(30px); }
      to { opacity: 1; transform: translateY(0); }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Get Started</h1>
    <div id="error" style="display:none;color:#f87171;background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.3);border-radius:8px;padding:0.75rem 1rem;margin-bottom:1.2rem;font-size:0.9rem;"></div>
    <input id="name" type="text" placeholder="Full name" />
    <input id="email" type="email" placeholder="Email address" />
    <input id="password" type="password" placeholder="Password (min 8 characters)" />
    <button id="btn" onclick="doRegister()">Sign Up</button>
    <p>Already have an account? <a href="/login">Log in</a></p>
  </div>
  <script>
    async function doRegister() {
      const name = document.getElementById('name').value.trim();
      const email = document.getElementById('email').value.trim();
      const password = document.getElementById('password').value;
      const err = document.getElementById('error');
      const btn = document.getElementById('btn');
      err.style.display = 'none';
      if (!name || !email || !password) { err.textContent = 'Please fill in all fields.'; err.style.display = 'block'; return; }
      if (password.length < 8) { err.textContent = 'Password must be at least 8 characters.'; err.style.display = 'block'; return; }
      btn.textContent = 'Creating account…'; btn.disabled = true;
      try {
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, email, password })
        });
        const data = await res.json();
        if (!res.ok) { err.textContent = data.error || 'Registration failed.'; err.style.display = 'block'; return; }
        localStorage.setItem('dagama_token', data.token);
        localStorage.setItem('dagama_user', JSON.stringify(data.user));
        window.location.href = '/dashboard';
      } catch (e) {
        err.textContent = 'Network error. Please try again.'; err.style.display = 'block';
      } finally {
        btn.textContent = 'Sign Up'; btn.disabled = false;
      }
    }
    document.addEventListener('keydown', e => { if (e.key === 'Enter') doRegister(); });
  </script>
</body>
</html>`;

const DASHBOARD_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dashboard — DaGama</title>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=Outfit:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --navy: #0F1419; --navy-light: #1a2235; --gold: #D4AF37; --gold-light: #E8C547;
      --slate-400: #94A3B8; --slate-700: #334155; --slate-800: #1E293B; --white: #F5F5F5;
    }
    body { font-family: 'Outfit', sans-serif; background: linear-gradient(135deg, var(--navy) 0%, #1a2844 100%); color: var(--white); min-height: 100vh; }
    nav {
      display: flex; align-items: center; justify-content: space-between;
      padding: 1.2rem 2rem; border-bottom: 1px solid rgba(212,175,55,0.15);
      background: rgba(15,20,25,0.8); backdrop-filter: blur(20px); position: sticky; top: 0; z-index: 10;
    }
    .logo { font-family: 'Playfair Display', serif; font-size: 1.5rem; background: linear-gradient(135deg, #F5F5F5, #D4AF37); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
    .nav-right { display: flex; align-items: center; gap: 1rem; }
    .user-badge { background: rgba(212,175,55,0.1); border: 1px solid rgba(212,175,55,0.2); border-radius: 20px; padding: 0.4rem 1rem; font-size: 0.85rem; color: var(--gold); }
    .logout-btn { background: transparent; border: 1px solid rgba(212,175,55,0.3); color: var(--slate-400); border-radius: 8px; padding: 0.4rem 1rem; cursor: pointer; font-family: 'Outfit', sans-serif; font-size: 0.85rem; transition: all 0.2s; }
    .logout-btn:hover { border-color: var(--gold); color: var(--gold); }
    main { max-width: 1100px; margin: 0 auto; padding: 3rem 2rem; }
    .welcome { margin-bottom: 2.5rem; }
    .welcome h1 { font-family: 'Playfair Display', serif; font-size: 2rem; margin-bottom: 0.5rem; }
    .welcome p { color: var(--slate-400); }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1.5rem; margin-bottom: 3rem; }
    .stat-card {
      background: linear-gradient(135deg, rgba(30,41,59,0.9), rgba(30,41,59,0.6));
      border: 1px solid rgba(212,175,55,0.15); border-radius: 16px; padding: 1.5rem;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .stat-card:hover { transform: translateY(-4px); box-shadow: 0 8px 30px rgba(212,175,55,0.1); }
    .stat-label { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.1em; color: var(--slate-400); margin-bottom: 0.5rem; }
    .stat-value { font-size: 2.2rem; font-weight: 700; color: var(--gold); }
    .stat-sub { font-size: 0.85rem; color: var(--slate-400); margin-top: 0.3rem; }
    .section-title { font-size: 1.1rem; font-weight: 600; margin-bottom: 1.2rem; color: var(--white); }
    .empty-state {
      background: linear-gradient(135deg, rgba(30,41,59,0.6), rgba(30,41,59,0.3));
      border: 1px dashed rgba(212,175,55,0.2); border-radius: 16px; padding: 3rem;
      text-align: center; color: var(--slate-400);
    }
    .empty-state .icon { font-size: 2.5rem; margin-bottom: 1rem; }
    .empty-state p { font-size: 0.95rem; line-height: 1.6; }
    .coming-soon { display: inline-block; background: rgba(212,175,55,0.1); border: 1px solid rgba(212,175,55,0.2); color: var(--gold); border-radius: 12px; padding: 0.25rem 0.75rem; font-size: 0.75rem; font-weight: 600; margin-left: 0.5rem; vertical-align: middle; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
    main { animation: fadeIn 0.6s ease-out; }
  </style>
</head>
<body>
  <nav>
    <span class="logo">DaGama</span>
    <div class="nav-right">
      <span class="user-badge" id="user-badge">Loading…</span>
      <button class="logout-btn" onclick="logout()">Log out</button>
    </div>
  </nav>
  <main>
    <div class="welcome">
      <h1 id="welcome-msg">Welcome back</h1>
      <p>Your trade show intelligence hub</p>
    </div>
    <div class="stats">
      <div class="stat-card">
        <div class="stat-label">Trade Shows Tracked</div>
        <div class="stat-value">0</div>
        <div class="stat-sub">Connect your first show to get started</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Leads Captured</div>
        <div class="stat-value" id="stat-leads">—</div>
        <div class="stat-sub">Via Telegram bot</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">AI Insights</div>
        <div class="stat-value" id="stat-ai">0</div>
        <div class="stat-sub">Powered by Gemini</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Telegram Bot</div>
        <div class="stat-value" id="stat-bot" style="font-size:1rem;padding-top:0.5rem;">—</div>
        <div class="stat-sub">Connect via /api/telegram/setup</div>
      </div>
    </div>
    <div class="section-title">AI Insights <span class="coming-soon">Gemini</span></div>
    <div id="insights-box" class="empty-state">
      <div class="icon">🤖</div>
      <p>No insights yet.<br>Capture leads via the Telegram bot, then click below for AI analysis.</p>
    </div>
    <button id="insights-btn" onclick="loadInsights()" style="margin-top:1rem;background:linear-gradient(135deg,#D4AF37,#E8C547);color:#0F1419;border:none;border-radius:8px;padding:0.75rem 1.5rem;font-family:'Outfit',sans-serif;font-weight:600;cursor:pointer;transition:all 0.2s;">✨ Generate AI Insights</button>
  </main>
  <script>
    const token = localStorage.getItem('dagama_token');
    if (!token) { window.location.href = '/login'; }
    const user = JSON.parse(localStorage.getItem('dagama_user') || '{}');
    if (user.name) {
      document.getElementById('welcome-msg').textContent = 'Welcome back, ' + user.name.split(' ')[0];
      document.getElementById('user-badge').textContent = user.email;
    }
    fetch('/api/stats', { headers: { 'Authorization': 'Bearer ' + token } })
      .then(r => r.json())
      .then(data => {
        document.getElementById('stat-leads').textContent = data.leads ?? 0;
        document.getElementById('stat-bot').textContent = data.bot_connected ? 'Connected' : 'Not connected';
        if (data.bot_connected) document.getElementById('stat-bot').style.color = '#4ade80';
      })
      .catch(() => {});
    async function loadInsights() {
      const btn = document.getElementById('insights-btn');
      const box = document.getElementById('insights-box');
      btn.textContent = '🤖 Analyzing…'; btn.disabled = true;
      try {
        const res = await fetch('/api/insights', { headers: { 'Authorization': 'Bearer ' + token } });
        const data = await res.json();
        if (!res.ok) {
          box.innerHTML = '<div class="icon">⚠️</div><p>' + (data.error || 'Could not load insights.') + '</p>';
        } else {
          box.style.textAlign = 'left';
          box.innerHTML = '<div style="font-size:0.8rem;text-transform:uppercase;letter-spacing:0.1em;color:#94A3B8;margin-bottom:0.75rem;">📊 ' + data.show + ' — ' + data.lead_count + ' leads</div>' +
            '<p style="color:#F5F5F5;line-height:1.7;white-space:pre-wrap;">' + data.analysis + '</p>';
          document.getElementById('stat-ai').textContent = '1';
        }
      } catch (e) {
        box.innerHTML = '<div class="icon">❌</div><p>Network error. Please try again.</p>';
      } finally {
        btn.textContent = '✨ Generate AI Insights'; btn.disabled = false;
      }
    }
    function logout() {
      localStorage.removeItem('dagama_token');
      localStorage.removeItem('dagama_user');
      window.location.href = '/';
    }
  </script>
</body>
</html>`;