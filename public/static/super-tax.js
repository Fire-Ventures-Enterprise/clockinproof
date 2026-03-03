// CIP Super Admin — Tax Compliance Module
// Auto-extracted from src/index.tsx — do not edit manually

// ══════════════════════════════════════════════════════════════════════════════
// ── TAX COMPLIANCE MODULE ────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

let _taxSummary = null
let _taxLedgerPage = 1
let _activeTaxTab = 'monthly'

function fmtUSD(n) { return '$' + (n||0).toLocaleString('en-CA', {minimumFractionDigits:2,maximumFractionDigits:2}) }
function fmtCAD(n) { return 'CA$' + (n||0).toLocaleString('en-CA', {minimumFractionDigits:2,maximumFractionDigits:2}) }
function fmtRate(n) { return n ? n.toFixed(4) : '—' }

async function loadTax() {
  const year = document.getElementById('tax-year-select')?.value || new Date().getFullYear()
  // Update export link
  const exportLink = document.getElementById('tax-export-link')
  if (exportLink) exportLink.href = '/api/super/tax/export?year=' + year
  // Update Form 5472 CSV link
  const f5472 = document.getElementById('form5472-csv')
  if (f5472) f5472.href = '/api/super/tax/export?year=' + year

  try {
    const d = await api('/api/super/tax/summary?year=' + year)
    _taxSummary = d
    // KPI cards
    document.getElementById('tax-ytd-usd').textContent  = fmtUSD(d.ytd.gross_usd)
    document.getElementById('tax-ytd-cad').textContent  = fmtCAD(d.ytd.gross_cad)
    document.getElementById('tax-fees-usd').textContent = fmtUSD(d.ytd.fees_usd)
    document.getElementById('tax-net-usd').textContent  = fmtUSD(d.ytd.net_usd)
    document.getElementById('tax-pending-count').textContent = d.ytd.pending_count
    document.getElementById('tax-rate-today').textContent = d.latest_rate ? fmtRate(d.latest_rate.usd_cad) + ' (' + d.latest_rate.rate_date + ')' : 'No rate yet'

    // Alert banners + nav badge
    const t1135Banner = document.getElementById('tax-alert-t1135')
    const fbarBanner  = document.getElementById('tax-alert-fbar')
    const navBadge    = document.getElementById('tax-alert-badge')
    if (t1135Banner) t1135Banner.style.display = d.alerts.t1135_triggered ? 'block' : 'none'
    if (fbarBanner)  fbarBanner.style.display  = d.alerts.fbar_triggered  ? 'block' : 'none'
    if (navBadge) {
      if (d.alerts.t1135_triggered || d.alerts.fbar_triggered || d.ytd.pending_count > 0) {
        navBadge.style.display = 'inline'
        navBadge.textContent = d.ytd.pending_count > 0 ? d.ytd.pending_count : '!'
      } else { navBadge.style.display = 'none' }
    }

    // Threshold bars
    const t1135Bar = document.getElementById('tax-t1135-bar')
    const fbarBar  = document.getElementById('tax-fbar-bar')
    if (t1135Bar) {
      t1135Bar.style.width = d.alerts.t1135_pct + '%'
      t1135Bar.style.background = d.alerts.t1135_triggered ? '#ef4444' : '#818cf8'
    }
    if (fbarBar) {
      fbarBar.style.width = d.alerts.fbar_pct + '%'
      fbarBar.style.background = d.alerts.fbar_triggered ? '#ef4444' : '#60a5fa'
    }
    document.getElementById('tax-t1135-label').textContent = fmtCAD(d.ytd.gross_cad) + ' / CA$100,000'
    document.getElementById('tax-fbar-label').textContent  = fmtUSD(d.ytd.gross_usd) + ' / $10,000'

    // Render active sub-tab
    showTaxTab(_activeTaxTab, d)
  } catch(e) { showToast('❌ Failed to load tax data: ' + e.message, true) }
}

function showTaxTab(tab, data) {
  _activeTaxTab = tab
  const tabs = ['monthly','ledger','deadlines','forms','rates','audit']
  tabs.forEach(t => {
    const btn = document.getElementById('taxtab-' + t)
    const content = document.getElementById('taxtab-' + t + '-content')
    if (btn) { btn.className = t === tab ? 'btn btn-primary' : 'btn btn-ghost'; btn.style.fontSize = '12px'; btn.style.padding = '6px 14px' }
    if (content) content.style.display = t === tab ? 'block' : 'none'
  })

  const d = data || _taxSummary
  if (tab === 'monthly' && d)   renderTaxMonthly(d.monthly)
  if (tab === 'ledger')         loadTaxLedger()
  if (tab === 'deadlines' && d) renderTaxDeadlines(d.deadlines)
  if (tab === 'forms' && d)     renderTaxForms(d)
  if (tab === 'rates')          loadTaxRates()
  if (tab === 'audit')          loadTaxAudit()
}

function renderTaxMonthly(monthly) {
  const tbody = document.getElementById('tax-monthly-tbody')
  if (!tbody) return
  if (!monthly?.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:30px;color:#475569">No transactions yet — click "Sync Stripe" to import</td></tr>'
    return
  }
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  tbody.innerHTML = monthly.map(m => {
    const [y, mo] = m.month.split('-')
    const label = (months[parseInt(mo)-1] || mo) + ' ' + y
    return `<tr style="border-bottom:1px solid #1e293b">
      <td style="padding:10px 12px;color:#e2e8f0;font-weight:600">${label}</td>
      <td style="padding:10px 12px;text-align:right;color:#34d399;font-weight:600">${fmtUSD(m.usd_revenue)}</td>
      <td style="padding:10px 12px;text-align:right;color:#94a3b8">${fmtRate(m.avg_rate)}</td>
      <td style="padding:10px 12px;text-align:right;color:#818cf8;font-weight:600">${fmtCAD(m.cad_revenue)}</td>
      <td style="padding:10px 12px;text-align:right;color:#64748b">${m.tx_count}</td>
    </tr>`
  }).join('')
}

async function loadTaxLedger() {
  const year   = document.getElementById('tax-year-select')?.value || new Date().getFullYear()
  const cat    = document.getElementById('tax-cat-filter')?.value || ''
  const status = document.getElementById('tax-status-filter')?.value || ''
  const tbody  = document.getElementById('tax-ledger-tbody')
  if (!tbody) return
  tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:30px;color:#475569"><i class="fas fa-spinner fa-spin"></i></td></tr>'
  try {
    const d = await api(`/api/super/tax/transactions?year=${year}&page=${_taxLedgerPage}&category=${cat}&status=${status}`)
    const txs = d.transactions || []
    if (!txs.length) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:30px;color:#475569">No transactions found</td></tr>'
      return
    }
    const catColors = { eci:'color:#34d399', fee:'color:#f87171', refund:'color:#f59e0b', manual:'color:#818cf8' }
    tbody.innerHTML = txs.map(t => {
      const isNeg = t.usd_amount < 0
      const usdColor = isNeg ? 'color:#f87171' : 'color:#34d399'
      const statusPill = t.status === 'reconciled'
        ? '<span style="background:#065f46;color:#6ee7b7;font-size:10px;font-weight:700;padding:2px 7px;border-radius:20px">✓ RECONCILED</span>'
        : '<span style="background:#78350f;color:#fcd34d;font-size:10px;font-weight:700;padding:2px 7px;border-radius:20px">PENDING</span>'
      return `<tr style="border-bottom:1px solid #1e293b">
        <td style="padding:8px 12px;color:#94a3b8;font-size:12px">${t.date}</td>
        <td style="padding:8px 12px;color:#e2e8f0;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${t.description||''}">${t.description||'—'}</td>
        <td style="padding:8px 12px;color:#64748b;font-size:12px">${t.processor||'—'}</td>
        <td style="padding:8px 12px;font-size:11px;font-weight:700;text-transform:uppercase;${catColors[t.category]||'color:#94a3b8'}">${t.category||'—'}</td>
        <td style="padding:8px 12px;text-align:right;font-weight:600;${usdColor}">${fmtUSD(t.usd_amount)}</td>
        <td style="padding:8px 12px;text-align:right;color:#475569;font-size:11px">${t.exchange_rate ? t.exchange_rate.toFixed(4) : '—'}</td>
        <td style="padding:8px 12px;text-align:right;color:#818cf8;font-size:12px">${t.cad_amount ? fmtCAD(t.cad_amount) : '—'}</td>
        <td style="padding:8px 12px;text-align:center">${statusPill}</td>
        <td style="padding:8px 12px;text-align:right;display:flex;gap:4px;justify-content:flex-end">
          ${t.status === 'pending' ? `<button onclick="reconcileTx(${t.id})" class="btn btn-ghost" style="font-size:11px;padding:3px 8px" title="Mark reconciled"><i class="fas fa-check"></i></button>` : ''}
          <button onclick="deleteTx(${t.id})" class="btn btn-danger" style="font-size:11px;padding:3px 8px" title="Delete"><i class="fas fa-trash"></i></button>
        </td>
      </tr>`
    }).join('')
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:30px;color:#ef4444">${e.message}</td></tr>`
  }
}

function renderTaxDeadlines(deadlines) {
  const grid = document.getElementById('tax-deadlines-grid')
  if (!grid) return
  const now = new Date()
  if (!deadlines?.length) {
    grid.innerHTML = '<p style="color:#64748b;font-size:13px">Load tax summary first to see deadlines.</p>'
    return
  }
  const statusColors = {
    pending: { bg:'#1e293b', border:'#334155', label:'UPCOMING', lc:'#94a3b8' },
    filed:   { bg:'#065f46', border:'#059669', label:'FILED ✓',  lc:'#6ee7b7' },
    overdue: { bg:'#7f1d1d', border:'#dc2626', label:'OVERDUE',  lc:'#fca5a5' }
  }
  grid.innerHTML = deadlines.map(d => {
    const due = new Date(d.due_date)
    const daysLeft = Math.ceil((due - now) / 86400000)
    const isPast = daysLeft < 0
    const effectiveStatus = d.status === 'filed' ? 'filed' : (isPast ? 'overdue' : 'pending')
    const sc = statusColors[effectiveStatus]
    const urgency = daysLeft <= 14 && effectiveStatus !== 'filed' ? 'border-color:#f59e0b!important' : ''
    return `<div class="card" style="padding:16px;background:${sc.bg};border-color:${sc.border};${urgency}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">
        <div style="font-size:14px;font-weight:700;color:#e2e8f0">${d.form_type}</div>
        <span style="background:${sc.border};color:${sc.lc};font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px">${sc.label}</span>
      </div>
      <div style="font-size:12px;color:#94a3b8;margin-bottom:4px"><i class="fas fa-calendar" style="width:14px"></i> Due: ${d.due_date}</div>
      ${d.extended_date ? `<div style="font-size:12px;color:#64748b;margin-bottom:4px"><i class="fas fa-calendar-plus" style="width:14px"></i> Extended: ${d.extended_date}</div>` : ''}
      ${d.status !== 'filed' ? `<div style="font-size:12px;font-weight:700;color:${daysLeft <= 14 ? '#f59e0b' : '#64748b'};margin-bottom:10px">${isPast ? '⚠️ OVERDUE' : daysLeft + ' days remaining'}</div>` : `<div style="font-size:12px;color:#34d399;margin-bottom:10px">Filed: ${d.filed_date||'—'}${d.filed_by ? ' by ' + d.filed_by : ''}</div>`}
      ${d.status !== 'filed' ? `<button onclick="markDeadlineFiled(${d.id})" class="btn btn-success" style="font-size:11px;padding:4px 10px;width:100%"><i class="fas fa-check"></i> Mark as Filed</button>` : `<button onclick="resetDeadline(${d.id})" class="btn btn-ghost" style="font-size:11px;padding:4px 10px;width:100%"><i class="fas fa-undo"></i> Reset to Pending</button>`}
    </div>`
  }).join('')
}

function renderTaxForms(d) {
  const year = document.getElementById('tax-year-select')?.value || new Date().getFullYear()
  const ytd = d.ytd
  const alerts = d.alerts

  // Form 5472
  const f5472 = document.getElementById('form5472-data')
  if (f5472) f5472.innerHTML = `
    <div>📋 <strong>Entity:</strong> Wyoming LLC (Foreign-Owned SMLLC)</div>
    <div>🗓 <strong>Fiscal Year:</strong> ${year} (Jan 1 – Dec 31)</div>
    <div>💰 <strong>Gross US Revenue (ECI):</strong> ${fmtUSD(ytd.gross_usd)}</div>
    <div>💸 <strong>Processor Fees (Deductible):</strong> ${fmtUSD(ytd.fees_usd)}</div>
    <div>🔄 <strong>Refunds/Chargebacks:</strong> ${fmtUSD(Math.abs(ytd.refunds_usd||0))}</div>
    <div>✅ <strong>Net Reportable Income:</strong> ${fmtUSD(ytd.net_usd)}</div>
    <div>📝 <strong>Ownership:</strong> 100% (Single-Member)</div>
    <div style="margin-top:8px;padding:8px;background:#0f172a;border-radius:6px;font-size:11px;color:#64748b">
      Filed with pro-forma Form 1120 — due April 15 each year (extension: October 15 via Form 7004)
    </div>`

  // T1135
  const t1135 = document.getElementById('formt1135-data')
  if (t1135) t1135.innerHTML = `
    <div>🍁 <strong>Reporting Currency:</strong> CAD</div>
    <div>💰 <strong>YTD CAD Equivalent:</strong> ${fmtCAD(ytd.gross_cad)}</div>
    <div>⚠️ <strong>Threshold:</strong> CA$100,000</div>
    <div style="margin-top:8px;padding:8px;background:${alerts.t1135_triggered ? '#7c2d12' : '#0f172a'};border-radius:6px">
      <strong style="color:${alerts.t1135_triggered ? '#fb923c' : '#34d399'}">${alerts.t1135_triggered ? '🚨 T1135 REQUIRED — File with Canadian return' : '✅ Below threshold — T1135 not required yet'}</strong>
    </div>`

  // FBAR
  const fbar = document.getElementById('fbar-data')
  if (fbar) fbar.innerHTML = `
    <div>🏦 <strong>YTD USD Revenue:</strong> ${fmtUSD(ytd.gross_usd)}</div>
    <div>⚠️ <strong>Threshold:</strong> $10,000 USD</div>
    <div>📅 <strong>Due:</strong> April 15 (auto-extended to Oct 15)</div>
    <div style="margin-top:8px;padding:8px;background:${alerts.fbar_triggered ? '#1e3a5f' : '#0f172a'};border-radius:6px">
      <strong style="color:${alerts.fbar_triggered ? '#60a5fa' : '#34d399'}">${alerts.fbar_triggered ? '⚠️ FBAR REQUIRED — File at bsaefiling.fincen.treas.gov' : '✅ Below $10K threshold — FBAR not required'}</strong>
    </div>`
}

async function loadTaxRates() {
  const tbody = document.getElementById('tax-rates-tbody')
  if (!tbody) return
  try {
    const d = await api('/api/super/tax/rates')
    const rates = d.rates || []
    if (!rates.length) {
      tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;padding:30px;color:#475569">No rates stored yet — click "Get Today\'s Rate"</td></tr>'
      return
    }
    tbody.innerHTML = rates.map(r => `<tr style="border-bottom:1px solid #1e293b">
      <td style="padding:8px 12px;color:#e2e8f0">${r.rate_date}</td>
      <td style="padding:8px 12px;text-align:right;color:#34d399;font-weight:600">${r.usd_cad.toFixed(4)}</td>
      <td style="padding:8px 12px;color:#64748b;font-size:12px">${r.source}</td>
    </tr>`).join('')
  } catch(e) { tbody.innerHTML = `<tr><td colspan="3" style="text-align:center;padding:30px;color:#ef4444">${e.message}</td></tr>` }
}

async function loadTaxAudit() {
  const tbody = document.getElementById('tax-audit-tbody')
  if (!tbody) return
  try {
    const d = await api('/api/super/tax/audit-log')
    const logs = d.logs || []
    if (!logs.length) {
      tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;padding:30px;color:#475569">No audit events yet</td></tr>'
      return
    }
    tbody.innerHTML = logs.map(l => `<tr style="border-bottom:1px solid #1e293b">
      <td style="padding:8px 12px;color:#64748b;font-size:12px;white-space:nowrap">${l.created_at}</td>
      <td style="padding:8px 12px;color:#818cf8;font-size:12px;font-weight:600">${l.action}</td>
      <td style="padding:8px 12px;color:#94a3b8;font-size:12px">${l.details||'—'}</td>
    </tr>`).join('')
  } catch(e) { tbody.innerHTML = `<tr><td colspan="3" style="text-align:center;padding:30px;color:#ef4444">${e.message}</td></tr>` }
}

async function syncStripe() {
  const btn = document.getElementById('stripe-sync-btn')
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Syncing...' }
  try {
    const d = await api('/api/super/tax/sync-stripe', { method: 'POST' })
    showToast(`✅ Stripe sync complete — ${d.added} new, ${d.skipped} already imported`)
    loadTax()
  } catch(e) { showToast('❌ Stripe sync failed: ' + e.message, true)
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-sync"></i> Sync Stripe' }
  }
}

async function fetchTodayRate() {
  const btn = document.getElementById('rate-fetch-btn')
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Fetching...' }
  try {
    const d = await api('/api/super/tax/fetch-rate', { method: 'POST' })
    showToast(`✅ Rate for ${d.date}: 1 USD = ${d.rate} CAD`)
    loadTax()
  } catch(e) { showToast('❌ ' + e.message, true)
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-exchange-alt"></i> Get Today\'s Rate' }
  }
}

async function saveManualRate() {
  const date = document.getElementById('rate-manual-date')?.value
  const val  = parseFloat(document.getElementById('rate-manual-val')?.value)
  if (!date || !val) { showToast('❌ Date and rate are required', true); return }
  await api('/api/super/tax/rates', { method: 'POST', body: JSON.stringify({ rate_date: date, usd_cad: val }) })
  showToast('✅ Rate saved: ' + date + ' = ' + val)
  loadTaxRates()
}

async function reconcileTx(id) {
  await api('/api/super/tax/reconcile/' + id, { method: 'POST', body: JSON.stringify({}) })
  showToast('✅ Marked as reconciled')
  loadTaxLedger()
}

async function deleteTx(id) {
  if (!confirm('Delete this transaction? This cannot be undone.')) return
  await api('/api/super/tax/transactions/' + id, { method: 'DELETE' })
  showToast('🗑 Transaction deleted')
  loadTaxLedger()
}

async function markDeadlineFiled(id) {
  const filedBy = prompt('Who filed this form? (Your name or initials)')
  if (filedBy === null) return
  const filedDate = new Date().toISOString().split('T')[0]
  await api('/api/super/tax/deadlines/' + id, { method: 'PUT', body: JSON.stringify({ status: 'filed', filed_date: filedDate, filed_by: filedBy }) })
  showToast('✅ Marked as filed')
  loadTax()
}

async function resetDeadline(id) {
  await api('/api/super/tax/deadlines/' + id, { method: 'PUT', body: JSON.stringify({ status: 'pending', filed_date: null, filed_by: null }) })
  showToast('↩ Reset to pending')
  loadTax()
}

// Add Manual Transaction Modal
function showAddTxModal() {
  const today = new Date().toISOString().split('T')[0]
  const modal = document.createElement('div')
  modal.id = 'add-tx-modal'
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px'
  modal.innerHTML = `<div style="background:#1e293b;border:1px solid #334155;border-radius:14px;padding:24px;width:100%;max-width:420px">
    <h3 style="font-size:16px;font-weight:700;color:#e2e8f0;margin-bottom:16px"><i class="fas fa-plus-circle" style="color:#818cf8;margin-right:8px"></i>Add Manual Transaction</h3>
    <div style="display:grid;gap:10px">
      <div><label style="font-size:11px;color:#64748b;display:block;margin-bottom:4px">Date</label><input type="date" id="ntx-date" class="input" value="${today}"></div>
      <div><label style="font-size:11px;color:#64748b;display:block;margin-bottom:4px">Description</label><input type="text" id="ntx-desc" class="input" placeholder="e.g. Stripe payout, manual adjustment"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div><label style="font-size:11px;color:#64748b;display:block;margin-bottom:4px">USD Amount</label><input type="number" id="ntx-usd" class="input" step="0.01" placeholder="e.g. 99.00"></div>
        <div><label style="font-size:11px;color:#64748b;display:block;margin-bottom:4px">Category</label>
          <select id="ntx-cat" class="input">
            <option value="eci">ECI Revenue</option>
            <option value="fee">Processor Fee</option>
            <option value="refund">Refund</option>
            <option value="manual">Manual / Other</option>
          </select>
        </div>
      </div>
      <div><label style="font-size:11px;color:#64748b;display:block;margin-bottom:4px">Notes (optional)</label><input type="text" id="ntx-notes" class="input" placeholder="Audit notes..."></div>
    </div>
    <div style="display:flex;gap:8px;margin-top:16px">
      <button onclick="saveNewTx()" class="btn btn-primary" style="flex:1"><i class="fas fa-save"></i> Save Transaction</button>
      <button onclick="document.getElementById('add-tx-modal').remove()" class="btn btn-ghost">Cancel</button>
    </div>
  </div>`
  document.body.appendChild(modal)
}

async function saveNewTx() {
  const date   = document.getElementById('ntx-date')?.value
  const desc   = document.getElementById('ntx-desc')?.value
  const usd    = parseFloat(document.getElementById('ntx-usd')?.value)
  const cat    = document.getElementById('ntx-cat')?.value
  const notes  = document.getElementById('ntx-notes')?.value
  if (!date || !desc || isNaN(usd)) { showToast('❌ Date, description, and amount are required', true); return }
  try {
    const r = await api('/api/super/tax/transactions', { method: 'POST', body: JSON.stringify({ date, description: desc, usd_amount: usd, category: cat, notes }) })
    showToast(`✅ Transaction saved${r.cad_amount ? ' — CAD: ' + fmtCAD(r.cad_amount) : ' (no rate on file for this date)'}`)
    document.getElementById('add-tx-modal')?.remove()
    loadTax()
  } catch(e) { showToast('❌ ' + e.message, true) }
}
