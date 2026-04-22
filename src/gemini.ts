/// <reference types="@cloudflare/workers-types" />

const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_API = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

export async function ask(prompt: string, apiKey: string): Promise<string> {
  const res = await fetch(`${GEMINI_API}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${err}`);
  }

  const data = await res.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };

  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? 'No response from AI.';
}

// ── Prompt builders ───────────────────────────────────────────────────────────

interface Lead {
  name: string;
  company: string | null;
  email: string | null;
  notes: string | null;
  show_name: string;
  created_at: string;
}

export function buildSummaryPrompt(showName: string, leads: Lead[]): string {
  const leadsText = leads.map((l, i) =>
    `${i + 1}. ${l.name}${l.company ? ` (${l.company})` : ''}${l.email ? ` <${l.email}>` : ''}${l.notes ? ` — Notes: ${l.notes}` : ''}`
  ).join('\n');

  return `You are a trade show intelligence assistant for DaGama. Analyze these ${leads.length} leads captured at "${showName}":

${leadsText}

Provide a concise analysis in this format:
1. **Key Observations** (2-3 bullet points about patterns, industries, or opportunities)
2. **Hot Prospects** (top 2-3 leads to prioritize and why)
3. **Recommended Actions** (2-3 specific next steps)

Keep it practical and under 300 words. Use plain text, not markdown headers.`;
}

export function buildFollowUpPrompt(lead: Lead, showName: string): string {
  return `Write a short, warm follow-up email for a trade show lead I met at ${showName}.

Contact details:
- Name: ${lead.name}
- Company: ${lead.company || 'unknown'}
- Email: ${lead.email || 'not provided'}
- My notes: ${lead.notes || 'none'}

Requirements:
- Friendly and professional tone
- Reference the trade show naturally
- 3-4 short paragraphs max
- Include a clear call to action (schedule a call or demo)
- Sign off as "The DaGama Team"
- Do NOT use placeholder brackets like [Your Name] — write it ready to send
- Subject line on the first line, then a blank line, then the email body`;
}
