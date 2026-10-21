import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

/**
 * Find the StubHub event ID for a Ticketmaster event.
 *
 * Runs a small Claude agent with web search restricted to stubhub.com: it looks for
 * the StubHub event page for this exact show (name + venue + date + time) and reports
 * the URL. We never take its word for it: the URL must be one the search actually
 * returned, and a date in the URL slug must match the event's local date. Anything
 * that fails those checks comes back as a candidate for the user to confirm, not as
 * the mapping ID.
 *
 * Needs ANTHROPIC_API_KEY. One lookup is one Claude request with up to 5 searches.
 */

export const runtime = 'nodejs';
export const maxDuration = 120;

const MODEL = 'claude-opus-5-5';
const STUBHUB_EVENT_RE = /^https?:\/\/(?:www\.)?stubhub\.com\/[^?#]*\/event\/(\d{5,})/i;

interface LookupBody {
  name?: string;
  venue?: string;
  city?: string;
  state?: string;
  localDate?: string; // YYYY-MM-DD, venue local
  localTime?: string; // HH:MM[:SS], venue local
  tmUrl?: string;
}

interface AgentAnswer {
  found: boolean;
  url: string | null;
  stubhubEventName?: string | null;
  notes?: string | null;
}

/** StubHub slugs end in the event date, e.g. ".../oasis-las-vegas-tickets-8-21-2027/event/1612..." */
function slugDate(url: string): string | null {
  const m = url.match(/-(\d{1,2})-(\d{1,2})-(\d{4})\/event\//);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

/** Last JSON object in the agent's text. */
function parseAnswer(text: string): AgentAnswer | null {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const candidates = fenced.length ? fenced : [text.slice(text.lastIndexOf('{'))];
  for (const c of candidates.reverse()) {
    try {
      const obj = JSON.parse(c.trim());
      if (obj && typeof obj === 'object' && 'found' in obj) return obj as AgentAnswer;
    } catch { /* try the next one */ }
  }
  return null;
}

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'StubHub lookup is not set up: ANTHROPIC_API_KEY is missing on the server.' }, { status: 500 });
  }
  const body = (await req.json().catch(() => ({}))) as LookupBody;
  if (!body.name || !body.localDate) {
    return NextResponse.json({ error: 'Event name and date are required.' }, { status: 400 });
  }

  const where = [body.venue, body.city, body.state].filter(Boolean).join(', ');
  const when = `${body.localDate}${body.localTime ? ` at ${body.localTime.slice(0, 5)}` : ''} (venue local time)`;
  const prompt = `Find the StubHub event page for this exact event:

Event: ${body.name}
Venue: ${where || 'unknown'}
Date: ${when}${body.tmUrl ? `\nTicketmaster page: ${body.tmUrl}` : ''}

Search stubhub.com. StubHub event pages look like https://www.stubhub.com/<slug>/event/<numeric id>/ and the slug usually ends with the date as M-D-YYYY. The page must be for the same performer or teams, the same venue, and the same date. Tours have many dates and venues, and some days have two shows, so check the date, the city and, when there are two shows, the time.

When you are done, reply with only this JSON:
\`\`\`json
{"found": true or false, "url": "<StubHub event page URL exactly as it appeared in the search results, or null>", "stubhubEventName": "<name on StubHub or null>", "notes": "<one short sentence on how sure you are and why>"}
\`\`\`
Use found=false if no page matches on venue and date. Do not guess an ID.`;

  const client = new Anthropic();
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: prompt }];
  const seenUrls = new Set<string>();
  let finalText = '';

  try {
    // A server-tool turn can pause; resume it a couple of times before giving up.
    for (let turn = 0; turn < 3; turn++) {
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low' },
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5, allowed_domains: ['stubhub.com'] }],
        messages,
      });

      for (const block of response.content) {
        if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
          for (const r of block.content) if (r.type === 'web_search_result') seenUrls.add(r.url.split(/[?#]/)[0].replace(/\/$/, ''));
        } else if (block.type === 'text') {
          finalText += block.text;
        }
      }

      if (response.stop_reason === 'refusal') {
        return NextResponse.json({ found: false, error: 'The lookup was declined. Enter the StubHub ID by hand.' });
      }
      if (response.stop_reason !== 'pause_turn') break;
      messages.push({ role: 'assistant', content: response.content });
    }
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      return NextResponse.json({ error: 'Too many lookups right now. Try again in a minute.' }, { status: 429 });
    }
    if (err instanceof Anthropic.APIError) {
      return NextResponse.json({ error: `Lookup failed (${err.status}). Enter the StubHub ID by hand.` }, { status: 502 });
    }
    throw err;
  }

  const answer = parseAnswer(finalText);
  const searchUrl = `https://www.stubhub.com/search?q=${encodeURIComponent(body.name)}`;
  if (!answer || !answer.found || !answer.url) {
    return NextResponse.json({ found: false, searchUrl, notes: answer?.notes ?? 'No matching StubHub event found.' });
  }

  const url = answer.url.trim();
  const id = url.match(STUBHUB_EVENT_RE)?.[1] ?? null;
  const normalized = url.split(/[?#]/)[0].replace(/\/$/, '');
  const fromSearch = seenUrls.has(normalized);
  const date = slugDate(url);
  const dateOk = date === null || date === body.localDate;

  if (!id || !fromSearch || !dateOk) {
    // Show it, but make the user confirm it.
    return NextResponse.json({
      found: false,
      candidate: id ? { id, url, name: answer.stubhubEventName ?? null } : null,
      searchUrl,
      notes: !id
        ? 'The page found is not a StubHub event page.'
        : !fromSearch
          ? 'The link was not in the search results, so it could not be checked. Open it and confirm before using it.'
          : `The StubHub page is for ${date}, not ${body.localDate}. Open it and confirm before using it.`,
    });
  }

  return NextResponse.json({
    found: true,
    stubhubId: id,
    url,
    stubhubEventName: answer.stubhubEventName ?? null,
    notes: answer.notes ?? null,
  });
}
