import { NextResponse } from 'next/server';

export async function POST() {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) {
    return NextResponse.json({ success: false, error: 'DISCORD_WEBHOOK_URL not set' }, { status: 400 });
  }

  const evt = 'Test Event · Test Venue · Today';
  const embeds = [
    {
      color: 0x2ecc71,
      title: '🟢 New Standard Seats (1) — TEST',
      description: `SEC 100 Row A · Seats 1,2 · 2 seats · $150.00\n${evt}`,
    },
    {
      color: 0xe74c3c,
      title: '🔴 Price Drops (1) — TEST',
      description: `🔵 STD SEC 100 Row A · Seats 1,2 · 2 seats · $200.00 → $150.00 (-25%)\n${evt}`,
    },
    {
      color: 0xf1c40f,
      title: '🟡 Resale Undercut (1) — TEST',
      description: `SEC 100 Row B · Seats 3,4 · 2 seats · $60.00 vs section low $100.00 (-40%)\n${evt}`,
    },
  ];

  const results: number[] = [];
  for (const embed of embeds) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
    results.push(r.status);
  }

  return NextResponse.json({ success: true, statuses: results });
}
