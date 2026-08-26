/**
 * Dashboard front-end. No framework, no build step — the server hands this file
 * to the browser unchanged.
 *
 * Data flow: fetch /api/report → render. The server pushes an SSE `update` event
 * whenever the underlying data changes (an upload, an inbox drop, a manual link),
 * and that simply triggers another fetch. One source of truth, always the server's.
 */

const state = {
  report: null,
  tab: 'matched',
  search: '',
  sort: {},
  day: null,
};

const $ = (sel) => document.querySelector(sel);

const fmtMoney = (n) =>
  (Number(n) || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const fmtSigned = (n) => (Number(n) > 0 ? `+${fmtMoney(n)}` : fmtMoney(n));

const fmtTime = (ms) => {
  if (ms === null || ms === undefined) return '—';
  // Timestamps are wall-clock values stored as UTC; render them verbatim so the
  // dashboard shows exactly what the exports said.
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
};

const fmtClock = (ms) => (ms === null || ms === undefined ? '—' : new Date(ms).toISOString().slice(11, 19));

const fmtDelta = (minutes) => {
  if (minutes === null || minutes === undefined) return '—';
  const abs = Math.abs(minutes);
  const sign = minutes < 0 ? '−' : '+';
  if (abs < 1) return `${sign}${Math.round(abs * 60)}s`;
  if (abs < 60) return `${sign}${abs.toFixed(1)}m`;
  return `${sign}${(abs / 60).toFixed(1)}h`;
};

const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  );

// ---------------------------------------------------------------------------
// Tab definitions — each knows how to fetch its rows and render its columns
// ---------------------------------------------------------------------------

const TABS = [
  {
    id: 'matched',
    label: 'Matched',
    rows: (r) => r.matches,
    count: (r) => r.matches.length,
    columns: [
      { key: 'confidence', label: 'Status', sort: (m) => m.confidence, render: renderConfidence },
      {
        key: 'purchase',
        label: 'Purchase',
        sort: (m) => m.purchase.event,
        render: (m) => `
          <div class="primary-cell">${esc(purchaseTitle(m.purchase))}</div>
          <div class="sub-cell">${esc(purchaseDetail(m.purchase))}</div>
          <div class="sub-cell">${esc(m.purchase.account || '')} ${posStamp(m)}</div>`,
      },
      {
        key: 'ptime',
        label: 'Purchased',
        sort: (m) => m.purchase.purchasedAt ?? 0,
        render: (m) => `<div class="mono">${fmtTime(m.purchase.purchasedAt)}</div>`,
      },
      {
        key: 'charge',
        label: 'Card charge',
        sort: (m) => m.charge.description,
        render: (m) => `
          <div class="primary-cell">${esc(m.charge.description || '(no description)')}</div>
          <div class="sub-cell">${esc(m.charge.cardName || '')} ${m.charge.last4 ? `· ••${esc(m.charge.last4)}` : ''}</div>
          <div class="sub-cell">${esc(m.charge.status)}${m.charge.type === 'card_settlement' ? ' · settled' : ''}</div>`,
      },
      {
        key: 'ctime',
        label: 'Charged',
        sort: (m) => m.charge.occurredAt ?? 0,
        render: (m) => `<div class="mono">${fmtTime(m.charge.occurredAt)}</div>`,
      },
      { key: 'delta', label: 'Δ time', num: true, sort: (m) => Math.abs(m.deltaMinutes ?? 1e9), render: (m) => fmtDelta(m.deltaMinutes) },
      { key: 'amount', label: 'Amount', num: true, sort: (m) => m.purchase.amount, render: (m) => fmtMoney(m.purchase.amount) },
      {
        key: 'diff',
        label: 'Δ amount',
        num: true,
        sort: (m) => Math.abs(m.amountDiff),
        render: (m) =>
          m.amountDiff === 0
            ? '<span class="pill muted">exact</span>'
            : `<span class="${m.amountDiff > 0 ? 'neg' : 'pos'}">${fmtSigned(m.amountDiff)}</span>`,
      },
      {
        key: 'actions',
        label: '',
        actions: true,
        render: (m) => `
          <button class="btn tiny" data-act="detail-match" data-id="${esc(m.id)}">Details</button>
          <button class="btn tiny" data-act="unlink" data-purchase="${esc(m.purchase.id)}">Unlink</button>`,
      },
    ],
    search: (m) =>
      [m.purchase.event, m.purchase.label, m.purchase.vendor, m.purchase.account, m.purchase.venue, m.purchase.poId, m.purchase.id,
       m.charge.description, m.charge.cardName, m.charge.last4, m.charge.id, m.purchase.amount],
  },
  {
    id: 'purchases',
    label: 'Purchases w/o charge',
    rows: (r) => r.unmatchedPurchases,
    count: (r) => r.unmatchedPurchases.length,
    columns: [
      {
        key: 'event',
        label: 'Purchase',
        sort: (p) => p.event,
        render: (p) => `
          <div class="primary-cell">${esc(purchaseTitle(p))}</div>
          <div class="sub-cell">${esc(purchaseDetail(p))}</div>
          <div class="sub-cell">${esc(p.account || '')}</div>`,
      },
      { key: 'time', label: 'Purchased', sort: (p) => p.purchasedAt ?? 0, render: (p) => `<div class="mono">${fmtTime(p.purchasedAt)}</div>` },
      {
        key: 'card',
        label: 'Card',
        sort: (p) => p.last4,
        render: (p) =>
          p.last4
            ? `<span class="mono">••${esc(p.last4)}</span> <span class="sub-cell">${esc(p.brand || '')}</span>`
            : `<span class="pill muted">no card on file</span>${p.paymentState ? ` <span class="pill ${p.paymentState.toLowerCase() === 'paid' ? 'review' : 'muted'}">POS: ${esc(p.paymentState)}</span>` : ''}`,
      },
      { key: 'amount', label: 'Amount', num: true, sort: (p) => p.amount, render: (p) => fmtMoney(p.amount) },
      { key: 'reason', label: 'Why unmatched', sort: (p) => p.reason, render: (p) => `<div class="reason">${esc(p.reason)}</div>` },
      {
        key: 'actions',
        label: '',
        actions: true,
        render: (p) => `
          <button class="btn tiny" data-act="link-purchase" data-id="${esc(p.id)}">Find charge</button>
          <button class="btn tiny ghost" data-act="ignore" data-kind="purchase" data-id="${esc(p.id)}">Ignore</button>`,
      },
    ],
    search: (p) => [p.event, p.label, p.vendor, p.paymentState, p.account, p.venue, p.poId, p.id, p.last4, p.amount, p.reason],
  },
  {
    id: 'charges',
    label: 'Charges w/o purchase',
    rows: (r) => r.unmatchedCharges,
    count: (r) => r.unmatchedCharges.length,
    columns: [
      {
        key: 'desc',
        label: 'Charge',
        sort: (c) => c.description,
        render: (c) => `
          <div class="primary-cell">${esc(c.description || '(no description)')}</div>
          <div class="sub-cell">${esc(c.cardName || '')}${c.cardGroup ? ` · ${esc(c.cardGroup)}` : ''}</div>`,
      },
      { key: 'time', label: 'Charged', sort: (c) => c.occurredAt ?? 0, render: (c) => `<div class="mono">${fmtTime(c.occurredAt)}</div>` },
      { key: 'card', label: 'Card', sort: (c) => c.last4, render: (c) => `<span class="mono">••${esc(c.last4)}</span>` },
      { key: 'status', label: 'Status', sort: (c) => c.status, render: (c) => `<span class="pill ${c.status === 'settled' ? 'exact' : 'muted'}">${esc(c.status)}</span>` },
      { key: 'amount', label: 'Amount', num: true, sort: (c) => c.amount, render: (c) => fmtMoney(c.amount) },
      { key: 'reason', label: 'Why unmatched', sort: (c) => c.reason, render: (c) => `<div class="reason">${esc(c.reason)}</div>` },
      {
        key: 'actions',
        label: '',
        actions: true,
        render: (c) => `
          <button class="btn tiny" data-act="link-charge" data-id="${esc(c.id)}">Find purchase</button>
          <button class="btn tiny ghost" data-act="ignore" data-kind="charge" data-id="${esc(c.id)}">Ignore</button>`,
      },
    ],
    search: (c) => [c.description, c.cardName, c.cardGroup, c.last4, c.id, c.amount, c.status, c.reason],
  },
  {
    id: 'declines',
    label: 'Declines & reversals',
    rows: (r) => [...r.declines, ...r.reversals],
    count: (r) => r.declines.length + r.reversals.length,
    columns: [
      {
        key: 'kind',
        label: 'Type',
        sort: (c) => c.type,
        render: (c) =>
          c.type === 'card_decline'
            ? '<span class="pill bad">declined</span>'
            : `<span class="pill review">${esc(c.status)}</span>`,
      },
      { key: 'desc', label: 'Charge', sort: (c) => c.description, render: (c) => `
          <div class="primary-cell">${esc(c.description)}</div>
          <div class="sub-cell">${esc(c.cardName || '')}</div>` },
      { key: 'time', label: 'When', sort: (c) => c.occurredAt ?? 0, render: (c) => `<div class="mono">${fmtTime(c.occurredAt)}</div>` },
      { key: 'card', label: 'Card', sort: (c) => c.last4, render: (c) => `<span class="mono">••${esc(c.last4)}</span>` },
      { key: 'amount', label: 'Amount', num: true, sort: (c) => c.amount, render: (c) => fmtMoney(c.amount) },
      { key: 'reason', label: 'Reason', sort: (c) => c.declineReason, render: (c) => `<div class="reason">${esc(c.declineReason || '—')}</div>` },
    ],
    search: (c) => [c.description, c.cardName, c.last4, c.amount, c.declineReason, c.status],
  },
  {
    id: 'credits',
    label: 'Refunds & credits',
    rows: (r) => r.credits,
    count: (r) => r.credits.length,
    columns: [
      { key: 'desc', label: 'Credit', sort: (c) => c.description, render: (c) => `
          <div class="primary-cell">${esc(c.description)}</div>
          <div class="sub-cell">${esc(c.cardName || '')}</div>` },
      { key: 'time', label: 'When', sort: (c) => c.occurredAt ?? 0, render: (c) => `<div class="mono">${fmtTime(c.occurredAt)}</div>` },
      { key: 'card', label: 'Card', sort: (c) => c.last4, render: (c) => `<span class="mono">••${esc(c.last4)}</span>` },
      { key: 'amount', label: 'Amount', num: true, sort: (c) => c.amount, render: (c) => `<span class="pos">${fmtMoney(c.amount)}</span>` },
    ],
    search: (c) => [c.description, c.cardName, c.last4, c.amount],
  },
  {
    id: 'zero',
    label: 'No charge expected',
    rows: (r) => r.zeroAmountPurchases,
    count: (r) => r.zeroAmountPurchases.length,
    columns: [
      { key: 'event', label: 'Purchase', sort: (p) => p.event, render: (p) => `
          <div class="primary-cell">${esc(p.event || '(no event)')}</div>
          <div class="sub-cell">${esc(p.account || '')}${p.tags ? ` · ${esc(p.tags)}` : ''}</div>` },
      { key: 'time', label: 'Purchased', sort: (p) => p.purchasedAt ?? 0, render: (p) => `<div class="mono">${fmtTime(p.purchasedAt)}</div>` },
      { key: 'qty', label: 'Qty', num: true, sort: (p) => p.qty, render: (p) => p.qty },
      { key: 'amount', label: 'Amount', num: true, sort: (p) => p.amount, render: (p) => fmtMoney(p.amount) },
      { key: 'status', label: 'Fulfilment', sort: (p) => p.refundStatus, render: (p) => `<span class="pill muted">${esc(p.refundStatus || p.status || '—')}</span>` },
    ],
    search: (p) => [p.event, p.account, p.tags, p.amount],
  },
];

const tabById = (id) => TABS.find((t) => t.id === id) ?? TABS[0];

/** What to call a purchase: the event when we have one, else the PO. */
function purchaseTitle(p) {
  return p.label || p.event || (p.poId ? `PO ${p.poId}` : `Purchase ${p.id}`);
}

/** Second line: venue and seats, or the vendor the order was bought from. */
function purchaseDetail(p) {
  const parts = [];
  if (p.venue) parts.push(p.venue);
  if (p.seats) parts.push(p.seats);
  if (!parts.length && p.vendor) parts.push(p.vendor);
  if (!parts.length && p.qty) parts.push(`${p.qty} tickets`);
  return parts.join(' · ');
}

/** Flag a match your POS still thinks is unpaid. */
function posStamp(m) {
  if (m.flags?.includes('pos-says-unpaid')) return '<span class="pill review">POS says unpaid</span>';
  if (m.flags?.includes('pos-says-refund-needed')) return '<span class="pill review">POS: refund needed</span>';
  return '';
}

function renderConfidence(m) {
  const cls = { exact: 'exact', likely: 'likely', review: 'review', manual: 'manual' }[m.confidence] ?? 'muted';
  const flag = m.ambiguous ? ' <span class="pill review" title="More than one charge fit equally well">ambiguous</span>' : '';
  return `<span class="pill ${cls}">${esc(m.confidence)}</span>${flag}`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderKpis(r) {
  const t = r.totals;
  const cards = [
    { label: 'Purchases', value: fmtMoney(t.purchaseTotal), sub: `${t.purchaseCount} orders`, cls: 'accent' },
    { label: 'Card charges', value: fmtMoney(t.chargeTotal), sub: `${t.chargeCount} captured`, cls: 'accent' },
    {
      label: 'Matched',
      value: `${t.matchedCount}`,
      sub: `${fmtMoney(t.matchedPurchaseTotal)} · ${t.matchRate}% of rows`,
      cls: 'good',
    },
    {
      label: 'Purchases w/o charge',
      value: fmtMoney(t.unmatchedPurchaseTotal),
      sub: `${t.unmatchedPurchaseCount} orders`,
      cls: t.unmatchedPurchaseCount ? 'warn' : 'good',
    },
    {
      label: 'Charges w/o purchase',
      value: fmtMoney(t.unmatchedChargeTotal),
      sub: `${t.unmatchedChargeCount} charges`,
      cls: t.unmatchedChargeCount ? 'bad' : 'good',
    },
    {
      label: 'Net exposure',
      value: fmtSigned(t.netExposure),
      sub: 'unmatched charges − unmatched purchases',
      cls: t.netExposure === 0 ? 'good' : 'bad',
    },
    {
      label: 'Needs review',
      value: `${t.needsReviewCount}`,
      sub: 'matches with a caveat',
      cls: t.needsReviewCount ? 'warn' : 'good',
    },
    {
      label: 'Declines',
      value: `${t.declineCount}`,
      sub: `${fmtMoney(t.declineTotal)} attempted`,
      cls: t.declineCount ? 'violet' : 'good',
    },
  ];

  $('#kpis').innerHTML = cards
    .map(
      (c) => `<div class="kpi ${c.cls}">
        <div class="label">${c.label}</div>
        <div class="value">${c.value}</div>
        <div class="sub">${c.sub}</div>
      </div>`,
    )
    .join('');
}

function renderTabs(r) {
  $('#tabs').innerHTML = TABS.map((t) => {
    const n = t.count(r);
    return `<button class="tab ${t.id === state.tab ? 'active' : ''}" data-tab="${t.id}">
      ${t.label}<span class="count">${n}</span>
    </button>`;
  }).join('');
}

function visibleRows() {
  const tab = tabById(state.tab);
  let rows = tab.rows(state.report) ?? [];

  const q = state.search.trim().toLowerCase();
  if (q) {
    rows = rows.filter((row) =>
      tab
        .search(row)
        .filter((v) => v !== null && v !== undefined && v !== '')
        .some((v) => String(v).toLowerCase().includes(q)),
    );
  }

  const sort = state.sort[state.tab];
  if (sort) {
    const col = tab.columns.find((c) => c.key === sort.key);
    if (col?.sort) {
      rows = rows.slice().sort((a, b) => {
        const av = col.sort(a);
        const bv = col.sort(b);
        const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
        return sort.dir === 'asc' ? cmp : -cmp;
      });
    }
  }
  return rows;
}

function renderTable() {
  const tab = tabById(state.tab);
  const rows = visibleRows();
  const total = (tab.rows(state.report) ?? []).length;

  $('#row-count').textContent =
    rows.length === total ? `${total} rows` : `${rows.length} of ${total} rows`;

  if (rows.length === 0) {
    $('#view').innerHTML = `<div class="empty">
      <strong>${total === 0 ? emptyTitle(tab.id) : 'Nothing matches that filter'}</strong>
      ${total === 0 ? emptyHint(tab.id) : 'Try a different search term.'}
    </div>`;
    return;
  }

  const sort = state.sort[state.tab];
  const head = tab.columns
    .map((c) => {
      const arrow = sort?.key === c.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
      return `<th class="${c.num ? 'num' : ''}" data-sort="${c.key}">${c.label}${arrow}</th>`;
    })
    .join('');

  const body = rows
    .map(
      (row) =>
        `<tr>${tab.columns
          .map((c) => `<td class="${c.num ? 'num' : ''} ${c.actions ? 'actions' : ''}">${c.render(row)}</td>`)
          .join('')}</tr>`,
    )
    .join('');

  $('#view').innerHTML = `<div class="table-wrap"><table>
    <thead><tr>${head}</tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

function emptyTitle(tabId) {
  return {
    matched: 'No matches yet',
    purchases: 'Every purchase has a charge',
    charges: 'Every charge has a purchase',
    declines: 'No declines or reversals',
    credits: 'No refunds or credits',
    zero: 'No zero-amount purchases',
  }[tabId] ?? 'Nothing here';
}

function emptyHint(tabId) {
  if (tabId === 'matched') return 'Import a purchase export and a card transaction export to get started.';
  if (tabId === 'purchases' || tabId === 'charges') return 'Nothing is out of balance for this day.';
  return 'Nothing to show for this day.';
}

function renderDays(r) {
  const select = $('#day-select');
  const options = [
    `<option value="all"${r.day === 'all' ? ' selected' : ''}>All days</option>`,
    ...r.days.map(
      (d) =>
        `<option value="${d.day}"${r.day === d.day ? ' selected' : ''}>${d.day} · ${d.purchases}p / ${d.charges}c</option>`,
    ),
  ];
  select.innerHTML = options.join('');
}

/**
 * Warn when the two feeds do not cover the same days. Without this, exporting a
 * week of purchases against one day of card activity reads as a week of unpaid
 * orders — a reporting gap that looks exactly like missing money.
 */
function renderCoverage(r) {
  const el = document.getElementById('coverage');
  if (!el) return;
  const gaps = [];
  const list = (days) => (days.length > 3 ? `${days.slice(0, 3).join(', ')} and ${days.length - 3} more` : days.join(', '));

  if (r.coverage?.daysMissingCharges?.length) {
    gaps.push(
      `No card transactions imported for ${list(r.coverage.daysMissingCharges)} — purchases on those days cannot match anything yet.`,
    );
  }
  if (r.coverage?.daysMissingPurchases?.length) {
    gaps.push(
      `No purchases imported for ${list(r.coverage.daysMissingPurchases)} — charges on those days cannot match anything yet.`,
    );
  }

  const win = r.coverage?.misalignedWindows;
  if (win && r.coverage.purchaseRange && r.coverage.chargeRange) {
    const span = (range) => `${fmtTime(range.from)} → ${fmtTime(range.to)}`;
    const bits = [];
    if (win.purchasesOutside) bits.push(`${win.purchasesOutside} of ${win.purchaseCount} purchases`);
    if (win.chargesOutside) bits.push(`${win.chargesOutside} of ${win.chargeCount} charges`);
    gaps.push(
      `The two exports cover different windows — purchases ${span(r.coverage.purchaseRange)}, ` +
        `card transactions ${span(r.coverage.chargeRange)}. ` +
        `${bits.join(' and ')} fall outside the other file entirely and cannot match anything. ` +
        `Export the same window on both sides to compare like with like.`,
    );
  }

  el.hidden = gaps.length === 0;
  el.innerHTML = gaps.map((g) => `<div>${esc(g)}</div>`).join('');
}

function renderSubtitle(r) {
  const when = new Date(r.generatedAt).toLocaleTimeString();
  const scope = r.day === 'all' ? 'all days' : r.day;
  $('#subtitle').textContent =
    `${r.counts.purchases} purchases · ${r.counts.charges} card transactions · showing ${scope} · updated ${when}`;
  $('#export-btn').href = `/api/export?day=${encodeURIComponent(r.day)}`;
}

function renderSettings(r) {
  $('#opt-amountTolerance').value = r.settings.amountTolerance;
  $('#opt-timeWindowMinutes').value = r.settings.timeWindowMinutes;
  $('#opt-chargeTimeOffsetMinutes').value = r.settings.chargeTimeOffsetMinutes;
  $('#opt-requireLast4').checked = Boolean(r.settings.requireLast4);
}

function render() {
  if (!state.report) return;
  renderKpis(state.report);
  renderCoverage(state.report);
  renderTabs(state.report);
  renderDays(state.report);
  renderSubtitle(state.report);
  renderTable();
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function refresh() {
  const day = state.day ?? 'all';
  const res = await fetch(`/api/report?day=${encodeURIComponent(day)}`);
  if (!res.ok) {
    toast('Could not load the report.', 'error');
    return;
  }
  const report = await res.json();
  const first = state.report === null;
  state.report = report;
  state.day = report.day;
  if (first) renderSettings(report);
  render();
}

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function uploadFiles(fileList) {
  const files = [...fileList].filter(
    (f) => /\.(csv|xlsx)$/i.test(f.name) || f.type === 'text/csv',
  );
  if (files.length === 0) {
    toast('Only .csv and .xlsx files can be imported.', 'error');
    return;
  }
  const payload = await Promise.all(
    files.map(async (f) => {
      // Spreadsheets go over as bytes; CSVs stay text so the payload is readable.
      if (/\.xlsx$/i.test(f.name)) {
        const buffer = await f.arrayBuffer();
        let binary = '';
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return { filename: f.name, base64: btoa(binary) };
      }
      return { filename: f.name, text: await f.text() };
    }),
  );
  try {
    const result = await post('/api/import', { files: payload });
    for (const entry of result.imported) {
      toast(
        `${entry.filename}: ${entry.rows} ${entry.kind === 'purchases' ? 'purchases' : 'transactions'} (${entry.added} new, ${entry.updated} updated)`,
        'success',
      );
    }
    for (const err of result.errors ?? []) toast(`${err.filename}: ${err.error}`, 'error');
    await refresh();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

function openModal(title, html) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = `<div class="modal-body">${html}</div>`;
  $('#modal').hidden = false;
}

function closeModal() {
  $('#modal').hidden = true;
}

function detailRow(label, value) {
  return `<div><span>${esc(label)}</span><b>${esc(value ?? '—')}</b></div>`;
}

function openMatchDetail(matchId) {
  const m = state.report.matches.find((x) => x.id === matchId);
  if (!m) return;
  openModal(
    'Matched transaction',
    `<div class="context">
      <div class="detail-grid">
        ${detailRow('Event', m.purchase.event)}
        ${detailRow('Venue', m.purchase.venue)}
        ${detailRow('Seats', m.purchase.seats)}
        ${detailRow('Qty', m.purchase.qty)}
        ${detailRow('Account', m.purchase.account)}
        ${detailRow('PO id', m.purchase.poId)}
        ${detailRow('Purchase id', m.purchase.id)}
        ${detailRow('Purchased', fmtTime(m.purchase.purchasedAt))}
        ${detailRow('Purchase amount', fmtMoney(m.purchase.amount))}
        ${detailRow('Purchase card', m.purchase.last4 ? `••${m.purchase.last4}` : 'not recorded')}
        ${detailRow('Tags', m.purchase.tags)}
      </div>
    </div>
    <div class="context">
      <div class="detail-grid">
        ${detailRow('Descriptor', m.charge.description)}
        ${detailRow('Card name', m.charge.cardName)}
        ${detailRow('Card group', m.charge.cardGroup)}
        ${detailRow('Card', `••${m.charge.last4}`)}
        ${detailRow('Charge id', m.charge.id)}
        ${detailRow('Type', m.charge.type)}
        ${detailRow('Status', m.charge.status)}
        ${detailRow('Authorized', fmtTime(m.charge.authorizedAt))}
        ${detailRow('Posted', fmtTime(m.charge.postedAt))}
        ${detailRow('Charge amount', fmtMoney(m.charge.amount))}
        ${detailRow('Order id', m.charge.orderId)}
        ${detailRow('Reference', m.charge.referenceNumber)}
      </div>
    </div>
    <div class="detail-grid">
      ${detailRow('Match type', m.method)}
      ${detailRow('Confidence', m.confidence)}
      ${detailRow('Time apart', fmtDelta(m.deltaMinutes))}
      ${detailRow('Amount difference', fmtMoney(m.amountDiff))}
    </div>`,
  );
}

function openLinkForPurchase(purchaseId) {
  const p = state.report.unmatchedPurchases.find((x) => x.id === purchaseId);
  if (!p) return;

  const rows = p.candidates.length
    ? p.candidates
        .map(
          (c) => `<tr>
            <td>
              <div class="primary-cell">${esc(c.description)}</div>
              <div class="sub-cell">${esc(c.cardName || '')} · ${esc(c.status)}</div>
            </td>
            <td class="mono">${fmtTime(c.occurredAt)}</td>
            <td class="mono">••${esc(c.last4)}${c.last4Agree ? ' <span class="pill exact">same card</span>' : ''}</td>
            <td class="num">${fmtMoney(c.amount)}</td>
            <td class="num">${c.amountDiff === 0 ? '<span class="pill muted">exact</span>' : fmtSigned(c.amountDiff)}</td>
            <td class="num">${fmtDelta(c.deltaMinutes)}</td>
            <td class="actions">
              <button class="btn tiny primary" data-act="confirm-link" data-purchase="${esc(p.id)}" data-charge="${esc(c.id)}">Link</button>
            </td>
          </tr>`,
        )
        .join('')
    : `<tr><td colspan="7" class="reason">No unmatched charge is close enough to suggest. Import more card transactions, or widen the matching rules.</td></tr>`;

  openModal(
    'Link this purchase to a charge',
    `<div class="context">
      <div class="detail-grid">
        ${detailRow('Event', p.event)}
        ${detailRow('Account', p.account)}
        ${detailRow('Purchased', fmtTime(p.purchasedAt))}
        ${detailRow('Amount', fmtMoney(p.amount))}
        ${detailRow('Card', p.last4 ? `••${p.last4}` : 'not recorded')}
        ${detailRow('PO id', p.poId)}
      </div>
    </div>
    <div class="table-wrap" style="border-radius:8px;border-top:1px solid var(--line)">
      <table>
        <thead><tr><th>Charge</th><th>When</th><th>Card</th><th class="num">Amount</th><th class="num">Δ amount</th><th class="num">Δ time</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`,
  );
}

function openLinkForCharge(chargeId) {
  const c = state.report.unmatchedCharges.find((x) => x.id === chargeId);
  if (!c) return;

  const rows = c.candidates.length
    ? c.candidates
        .map(
          (p) => `<tr>
            <td>
              <div class="primary-cell">${esc(p.event)}</div>
              <div class="sub-cell">${esc(p.account || '')}</div>
            </td>
            <td class="mono">${fmtTime(p.purchasedAt)}</td>
            <td class="mono">${p.last4 ? `••${esc(p.last4)}` : '—'}${p.last4Agree ? ' <span class="pill exact">same card</span>' : ''}</td>
            <td class="num">${fmtMoney(p.amount)}</td>
            <td class="num">${p.amountDiff === 0 ? '<span class="pill muted">exact</span>' : fmtSigned(p.amountDiff)}</td>
            <td class="num">${fmtDelta(p.deltaMinutes)}</td>
            <td class="actions">
              <button class="btn tiny primary" data-act="confirm-link" data-purchase="${esc(p.id)}" data-charge="${esc(c.id)}">Link</button>
            </td>
          </tr>`,
        )
        .join('')
    : `<tr><td colspan="7" class="reason">No unmatched purchase is close enough to suggest. This may be a charge from a source you do not import — or the purchase feed has not caught up yet.</td></tr>`;

  openModal(
    'Link this charge to a purchase',
    `<div class="context">
      <div class="detail-grid">
        ${detailRow('Descriptor', c.description)}
        ${detailRow('Card name', c.cardName)}
        ${detailRow('Card', `••${c.last4}`)}
        ${detailRow('When', fmtTime(c.occurredAt))}
        ${detailRow('Amount', fmtMoney(c.amount))}
        ${detailRow('Status', c.status)}
      </div>
    </div>
    <div class="table-wrap" style="border-radius:8px;border-top:1px solid var(--line)">
      <table>
        <thead><tr><th>Purchase</th><th>When</th><th>Card</th><th class="num">Amount</th><th class="num">Δ amount</th><th class="num">Δ time</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`,
  );
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 6000);
}

function wireEvents() {
  $('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    state.tab = btn.dataset.tab;
    render();
  });

  $('#view').addEventListener('click', async (e) => {
    const th = e.target.closest('th[data-sort]');
    if (th) {
      const key = th.dataset.sort;
      const current = state.sort[state.tab];
      state.sort[state.tab] =
        current?.key === key ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' };
      renderTable();
      return;
    }
    await handleAction(e);
  });

  $('#modal').addEventListener('click', async (e) => {
    if (e.target === $('#modal')) closeModal();
    await handleAction(e);
  });
  $('#modal-close').addEventListener('click', closeModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });

  $('#search').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderTable();
  });

  $('#day-select').addEventListener('change', (e) => {
    state.day = e.target.value;
    refresh();
  });

  $('#import-btn').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', async (e) => {
    await uploadFiles(e.target.files);
    e.target.value = '';
  });

  $('#settings-btn').addEventListener('click', () => {
    const panel = $('#settings-panel');
    panel.hidden = !panel.hidden;
  });
  $('#settings-close').addEventListener('click', () => {
    $('#settings-panel').hidden = true;
  });
  $('#settings-save').addEventListener('click', async () => {
    try {
      await post('/api/settings', {
        amountTolerance: Number($('#opt-amountTolerance').value),
        timeWindowMinutes: Number($('#opt-timeWindowMinutes').value),
        chargeTimeOffsetMinutes: Number($('#opt-chargeTimeOffsetMinutes').value),
        requireLast4: $('#opt-requireLast4').checked,
      });
      toast('Matching rules updated.', 'success');
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#reset-btn').addEventListener('click', async () => {
    if (!confirm('Delete all imported purchases, charges and manual links? This cannot be undone.')) return;
    try {
      await post('/api/reset');
      toast('All data cleared.', 'success');
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // Drag and drop anywhere on the page.
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth += 1;
    $('#drop-overlay').hidden = false;
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) $('#drop-overlay').hidden = true;
  });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('#drop-overlay').hidden = true;
    if (e.dataTransfer?.files?.length) await uploadFiles(e.dataTransfer.files);
  });
}

async function handleAction(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const { act } = btn.dataset;

  try {
    if (act === 'detail-match') openMatchDetail(btn.dataset.id);
    else if (act === 'link-purchase') openLinkForPurchase(btn.dataset.id);
    else if (act === 'link-charge') openLinkForCharge(btn.dataset.id);
    else if (act === 'confirm-link') {
      await post('/api/link', { purchaseId: btn.dataset.purchase, chargeId: btn.dataset.charge });
      closeModal();
      toast('Linked.', 'success');
      await refresh();
    } else if (act === 'unlink') {
      await post('/api/unlink', { purchaseId: btn.dataset.purchase });
      toast('Unlinked — it will be re-matched automatically if it still fits.', 'success');
      await refresh();
    } else if (act === 'ignore') {
      await post('/api/ignore', { kind: btn.dataset.kind, id: btn.dataset.id, ignored: true });
      toast('Ignored.', 'success');
      await refresh();
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

/** Live updates. Reconnects on its own if the server restarts. */
function connectLive() {
  const source = new EventSource('/api/stream');
  const indicator = $('#live');

  source.addEventListener('open', () => indicator.classList.remove('off'));
  source.addEventListener('update', () => refresh());
  source.addEventListener('error', () => {
    indicator.classList.add('off');
    // EventSource retries by itself; this only reflects the state in the UI.
  });
}

wireEvents();
connectLive();
refresh();
