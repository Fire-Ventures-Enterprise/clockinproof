let adminMap = null
let currentPeriod = 'today'
let allSessionsData = []
let sessionStore = {}  // id → session object for modal lookup

// ── Shared helpers ───────────────────────────────────────────────────────────────

// Strip legacy prefixes and normalize auto_clockout_reason
function cleanReason(raw) {
  if (!raw) return ''
  return raw
    .replace(/^Admin clock-out:\s*/gi, '')
    .replace(/^Manually stopped by admin\s*:?\s*/gi, '')
    .replace(/^Worker left job site\s*:?\s*/gi, 'Left job site')
    .trim()
}

// Full human-readable guardrail label for a session
// Returns a SINGLE clean label — never double-prefixed
function autoClockoutLabel(s) {
  const r = cleanReason(s.auto_clockout_reason)
  if (s.drift_flag)                              return 'Auto Clock-Out: Left Geofence'
  if (r.toLowerCase().includes('end of day'))    return 'Auto Clock-Out: End of Day'
  if (r.toLowerCase().includes('max shift'))     return 'Auto Clock-Out: Max Shift'
  if (r.toLowerCase().includes('terminated'))    return 'Auto Clock-Out: Worker Terminated'
  if (r.toLowerCase().includes('suspended'))     return 'Auto Clock-Out: Worker Suspended'
  if (r.toLowerCase().includes('left'))          return 'Admin Clock-Out: Left Job Site'
  if (r.toLowerCase().includes('forgot'))        return 'Admin Clock-Out: Forgot to Clock Out'
  if (r.toLowerCase().includes('gps'))           return 'Admin Clock-Out: No GPS Signal'
  // If reason is blank (legacy "Manually stopped by admin"), show generic
  return r ? `Admin Clock-Out: ${r}` : 'Clocked Out by Manager'
}

// Returns true if notes string is system-generated (should never show in Notes block)
function isSystemNote(notes) {
  if (!notes || !notes.trim()) return true
  const l = notes.toLowerCase()
  return l.startsWith('admin clock-out') || l.startsWith('auto clocked out') ||
         l.startsWith('worker left job') || l.startsWith('manually stopped') ||
         l === 'admin clock-out'
}

// ── Admin Login ───────────────────────────────────────────────────────────────
async function adminLogin() {
  const pin = document.getElementById('admin-pin-input').value.trim()
  const errEl = document.getElementById('admin-login-error')
  const btn = document.querySelector('button[onclick="adminLogin()"]')

  if (!pin) {
    errEl.textContent = 'Please enter your PIN.'
    errEl.classList.remove('hidden')
    return
  }

  // Disable button to prevent double-click
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Checking...' }
  errEl.classList.add('hidden')

  let adminPin = '1965' // hard-coded fallback matching DB value
  try {
    const res = await fetch('/api/settings')
    if (res.ok) {
      const data = await res.json()
      adminPin = data.settings?.admin_pin || adminPin
    }
  } catch(e) {
    // Network error — use hardcoded fallback, still allow login
    console.warn('Could not fetch settings, using fallback PIN check')
  }

  // Re-enable button
  if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-unlock mr-2"></i>Access Dashboard' }

  if (pin === adminPin) {
    // SUCCESS — show dashboard immediately
    document.getElementById('admin-login').classList.add('hidden')
    document.getElementById('admin-dashboard').classList.remove('hidden')
    errEl.classList.add('hidden')
    // Start auto-refresh interval
    if (!window._adminRefreshInterval) {
      window._adminRefreshInterval = setInterval(refreshAll, 60000)
    }
    // Load data in background — don't await (don't block or risk hiding dashboard)
    refreshAll().catch(() => {})
    // Deep-link navigation
    const hash = window.location.hash.replace('#', '')
    if (hash && ['live','workers','sessions','map','calendar','settings','export','overrides'].includes(hash)) {
      showTab(hash)
    }
  } else {
    errEl.textContent = 'Incorrect PIN. Try again.'
    errEl.classList.remove('hidden')
    document.getElementById('admin-pin-input').focus()
    document.getElementById('admin-pin-input').select()
  }
}

function adminLogout() {
  document.getElementById('admin-login').classList.remove('hidden')
  document.getElementById('admin-dashboard').classList.add('hidden')
  document.getElementById('admin-pin-input').value = ''
}

document.getElementById('admin-pin-input').addEventListener('keyup', e => {
  if (e.key === 'Enter') adminLogin()
})

// ── Data Loading ──────────────────────────────────────────────────────────────
async function refreshAll() {
  document.getElementById('admin-last-updated').textContent = 'Updated: ' + new Date().toLocaleTimeString()
  await Promise.all([loadStats(), loadLive(), loadWorkers(), loadSessions()])
  // Silently refresh badges for overrides and disputes
  loadOverrides().catch(() => {})
  loadDisputes().catch(() => {})
  // Trigger server-side watchdog — auto-clocks out workers who left geofence / exceeded max shift
  // This ensures auto-clockout fires even if the worker's phone is offline
  runAdminWatchdog().catch(() => {})
}

async function runAdminWatchdog() {
  try {
    const res = await fetch('/api/sessions/watchdog')
    if (!res.ok) return
    const data = await res.json()
    const acted = (data.results || []).filter(r => r.action && r.action.startsWith('auto_clocked_out'))
    if (acted.length > 0) {
      // Workers were auto-clocked out — refresh live + stats immediately
      await Promise.all([loadLive(), loadStats(), loadWorkers()])
      // Show admin alert banner
      showGeofenceAlert(acted)
    }
    // Show drift warning banner for workers still outside geofence (not yet auto-clocked out)
    const drifted = (data.results || []).filter(r => r.drift_flag && !r.action)
    updateDriftBanner(drifted)
  } catch(e) { /* silent */ }
}

function showGeofenceAlert(actedWorkers) {
  let banner = document.getElementById('admin-geofence-alert')
  if (!banner) {
    banner = document.createElement('div')
    banner.id = 'admin-geofence-alert'
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;padding:12px 16px;background:#dc2626;color:#fff;font-size:13px;font-weight:600;display:flex;align-items:center;justify-content:space-between;box-shadow:0 2px 8px rgba(0,0,0,.3)'
    document.body.insertBefore(banner, document.body.firstChild)
  }
  const names = actedWorkers.map(w => w.worker_name).join(', ')
  const reasons = { auto_clocked_out: 'max shift', auto_clocked_out_eod: 'end of day', auto_clocked_out_drift: 'left job site' }
  const reasonText = actedWorkers.map(w => reasons[w.action] || 'auto clock-out').join('; ')
  banner.innerHTML = `<span>🚨 Auto Clock-Out: <strong>${names}</strong> — ${reasonText}</span><button onclick="document.getElementById('admin-geofence-alert').remove()" style="background:rgba(255,255,255,.2);border:none;color:#fff;padding:4px 12px;border-radius:8px;cursor:pointer;font-weight:700">✕ Dismiss</button>`
  // Auto-dismiss after 30 seconds
  setTimeout(() => { if (document.getElementById('admin-geofence-alert')) document.getElementById('admin-geofence-alert').remove() }, 30000)
}

function updateDriftBanner(driftedWorkers) {
  let banner = document.getElementById('admin-drift-banner')
  if (driftedWorkers.length === 0) {
    if (banner) banner.remove()
    return
  }
  if (!banner) {
    banner = document.createElement('div')
    banner.id = 'admin-drift-banner'
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9998;padding:10px 16px;background:#ea580c;color:#fff;font-size:13px;font-weight:600;display:flex;align-items:center;justify-content:space-between;box-shadow:0 2px 8px rgba(0,0,0,.2)'
    document.body.insertBefore(banner, document.body.firstChild)
  }
  const names = driftedWorkers.map(w => w.worker_name).join(', ')
  banner.innerHTML = `<span>⚠️ Outside Geofence: <strong>${names}</strong> — left the job site. Will auto clock-out if still away.</span><button onclick="document.getElementById('admin-drift-banner').remove()" style="background:rgba(255,255,255,.2);border:none;color:#fff;padding:4px 12px;border-radius:8px;cursor:pointer;font-weight:700">✕</button>`
}

async function loadStats() {
  try {
    const res = await fetch('/api/stats/summary?period=' + currentPeriod)
    const data = await res.json()
    const s = data.stats
    // Update all stat display elements (sidebar + navbar pills + cards)
    const w = s.total_workers || 0
    const n = s.currently_working || 0
    const h = (s.total_hours || 0).toFixed(1) + 'h'
    const p = '$' + (s.total_earnings || 0).toFixed(2)
    document.querySelectorAll('#stat-total-workers,#stat-total-workers-card').forEach(el => { if(el) el.textContent = w })
    document.querySelectorAll('#stat-working-now,#stat-working-now-card').forEach(el => { if(el) el.textContent = n })
    document.querySelectorAll('#stat-total-hours,#stat-total-hours-card').forEach(el => { if(el) el.textContent = h })
    document.querySelectorAll('#stat-total-payroll,#stat-total-payroll-card').forEach(el => { if(el) el.textContent = p })
    // Live badge on sidebar
    const liveBadge = document.getElementById('live-count-badge')
    if (liveBadge) {
      if (n > 0) { liveBadge.textContent = n; liveBadge.classList.remove('hidden') }
      else liveBadge.classList.add('hidden')
    }
  } catch(e) { console.error(e) }
}

// ── Worker Detail Drawer ──────────────────────────────────────────────────────
let _currentDrawerWorker = null  // store full worker object for edit modal

async function openWorkerDrawer(workerId) {
  const drawer = document.getElementById('worker-drawer')
  drawer.classList.remove('hidden')
  document.body.style.overflow = 'hidden'
  wdTab('sessions')  // default to sessions tab

  document.getElementById('wd-sessions').innerHTML = '<p class="text-gray-400 text-sm text-center py-6"><i class="fas fa-spinner fa-spin mr-2"></i>Loading...</p>'

  try {
    const [wRes, sRes] = await Promise.all([
      fetch('/api/workers'),
      fetch('/api/sessions/worker/' + workerId + '?limit=50')
    ])
    const wData = await wRes.json()
    const sData = await sRes.json()

    const worker = (wData.workers || []).find(w => w.id === workerId)
    const sessions = sData.sessions || []
    _currentDrawerWorker = worker

    if (worker) {
      document.getElementById('wd-name').textContent = worker.name
      document.getElementById('wd-phone').textContent = worker.phone

      // Pay display: hourly vs salary
      const payType = worker.pay_type || 'hourly'
      const rateEl = document.getElementById('wd-rate')
      if (payType === 'salary' && worker.salary_amount > 0) {
        rateEl.textContent = '$' + Number(worker.salary_amount).toLocaleString() + '/yr'
      } else {
        rateEl.textContent = '$' + (worker.hourly_rate||0).toFixed(2) + '/hr'
      }

      document.getElementById('wd-role').textContent = worker.job_title || worker.role || 'worker'
      document.getElementById('wd-total-sessions').textContent = sessions.length
      const totalH = sessions.reduce((s, x) => s + (x.total_hours || 0), 0)
      const totalE = sessions.reduce((s, x) => s + (x.earnings || 0), 0)
      document.getElementById('wd-total-hours').textContent = totalH.toFixed(1) + 'h'
      document.getElementById('wd-total-earned').textContent = '$' + totalE.toFixed(2)
      // Status badge — uses new worker_status field
      const ws = worker.worker_status || (worker.active ? 'active' : 'terminated')
      const wsConf2 = WS_CONFIG[ws] || WS_CONFIG['active']
      let statusBadge = ''
      if (worker.currently_clocked_in > 0) {
        statusBadge = '<span class="bg-green-100 text-green-700 text-xs px-2 py-0.5 rounded-full pulse font-medium flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-green-500 inline-block"></span>Working Now</span>'
      } else {
        statusBadge = `<span class="text-xs px-2 py-0.5 rounded-full font-medium ${wsConf2.bg} ${wsConf2.text}"><i class="fas ${wsConf2.icon} mr-1"></i>${wsConf2.label}</span>`
      }
      document.getElementById('wd-status-badge').innerHTML = statusBadge
      document.getElementById('wd-filter-sessions-btn').dataset.workerId = workerId

      // Invite link badge in drawer — always shows as active (link is permanent)
      const wdInviteBadge = document.getElementById('wd-invite-badge')
      if (wdInviteBadge) {
        wdInviteBadge.innerHTML = `<button onclick="closeWorkerDrawer();generateInviteLink(${workerId},'${worker.name.replace(/'/g,"\\'")}');"
          class="flex items-center gap-1 bg-green-50 hover:bg-green-100 border border-green-200 text-green-700 text-xs px-2 py-1 rounded-full font-medium transition-colors">
          <i class="fas fa-link text-green-500"></i> Send App Link
        </button>`
      }
      const wdActionBar = document.getElementById('wd-action-bar')
      if (wdActionBar) {
        const activeSession = sessions.find(s => s.status === 'active')
        if (worker.currently_clocked_in > 0 && activeSession) {
          wdActionBar.innerHTML = '<button'
            + ' onclick="closeWorkerDrawer();openAdminClockoutModal(' + activeSession.id + ')"'
            + ' class="w-full flex items-center justify-center gap-2 bg-red-600 hover:bg-red-700 text-white font-bold py-3 px-4 rounded-2xl text-sm transition-all shadow-lg shadow-red-200 active:scale-95">'
            + '<i class="fas fa-stop-circle"></i>'
            + ' Force Clock-Out \u2014 ' + worker.name
            + '</button>'
          wdActionBar.classList.remove('hidden')
        } else {
          wdActionBar.classList.add('hidden')
          wdActionBar.innerHTML = ''
        }
      }

      // ── Populate Profile tab ──
      document.getElementById('wd-p-phone').textContent     = worker.phone || '–'
      document.getElementById('wd-p-email').textContent     = worker.email || '–'
      document.getElementById('wd-p-address').textContent   = worker.home_address || '–'
      document.getElementById('wd-p-emergency').textContent = worker.emergency_contact || '–'
      document.getElementById('wd-p-title').textContent     = worker.job_title || '–'
      document.getElementById('wd-p-start').textContent     = worker.start_date
        ? new Date(worker.start_date + 'T00:00:00').toLocaleDateString('en-CA', {year:'numeric',month:'short',day:'numeric'})
        : '–'
      document.getElementById('wd-p-paytype').textContent   = payType === 'salary' ? 'Salary' : 'Hourly'
      document.getElementById('wd-p-comp').textContent      = payType === 'salary'
        ? '$' + Number(worker.salary_amount||0).toLocaleString() + ' / year'
        : '$' + (worker.hourly_rate||0).toFixed(2) + ' / hour'
      const notesBlock = document.getElementById('wd-p-notes-block')
      if (worker.worker_notes) {
        document.getElementById('wd-p-notes').textContent = worker.worker_notes
        notesBlock.classList.remove('hidden')
      } else {
        notesBlock.classList.add('hidden')
      }

      // ── Populate License tab ──
      document.getElementById('wd-l-number').textContent = worker.drivers_license_number || 'Not recorded'
      const frontEl = document.getElementById('wd-l-front')
      const backEl  = document.getElementById('wd-l-back')
      if (worker.license_front_b64) {
        frontEl.innerHTML = `<img src="${worker.license_front_b64}" class="w-full object-contain max-h-48 rounded-xl"/>`
      } else {
        frontEl.innerHTML = '<p class="text-gray-300 text-sm py-8"><i class="fas fa-image mr-1"></i>No image uploaded</p>'
      }
      if (worker.license_back_b64) {
        backEl.innerHTML = `<img src="${worker.license_back_b64}" class="w-full object-contain max-h-48 rounded-xl"/>`
      } else {
        backEl.innerHTML = '<p class="text-gray-300 text-sm py-8"><i class="fas fa-image mr-1"></i>No image uploaded</p>'
      }
    }

    if (sessions.length === 0) {
      document.getElementById('wd-sessions').innerHTML = '<p class="text-gray-400 text-sm text-center py-6">No sessions yet</p>'
      return
    }
    sessions.forEach(s => { if (s.id) sessionStore[s.id] = s })

    document.getElementById('wd-sessions').innerHTML = sessions.map(s => {
      const cin  = new Date(s.clock_in_time).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})
      const cout = s.clock_out_time ? new Date(s.clock_out_time).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) : null
      const isActive = s.status === 'active'
      const flags = []
      if (s.session_type === 'material_pickup') flags.push('<span class="bg-amber-100 text-amber-700 text-[10px] px-1.5 py-0.5 rounded-full">📦 Pickup</span>')
      if (s.session_type === 'emergency_job')   flags.push('<span class="bg-rose-100 text-rose-700 text-[10px] px-1.5 py-0.5 rounded-full">🚨 Emergency</span>')
      if (s.drift_flag)    flags.push('<span class="bg-orange-100 text-orange-700 text-[10px] px-1.5 py-0.5 rounded-full">\u26a0 Left Site</span>')
      if (s.away_flag)     flags.push('<span class="bg-yellow-100 text-yellow-700 text-[10px] px-1.5 py-0.5 rounded-full">\u23f0 Away</span>')
      if (s.auto_clockout) flags.push('<span class="bg-red-100 text-red-700 text-[10px] px-1.5 py-0.5 rounded-full">\ud83d\udd34 Auto Out</span>')
      const timeStr = cin + (cout ? ' \u2192 ' + cout : isActive ? ' (Active)' : '')
      const flagsHtml = flags.length ? '<div class="flex gap-1 mt-1 flex-wrap">' + flags.join('') + '</div>' : ''
      const earningsHtml = isActive
        ? '<span class="text-green-600 text-xs font-medium pulse">LIVE</span>'
        : '<p class="text-sm font-bold text-gray-800">' + (s.total_hours||0).toFixed(1) + 'h</p>'
          + '<p class="text-xs font-bold text-green-600">$' + (s.earnings||0).toFixed(2) + '</p>'
      return '<div class="bg-gray-50 border border-gray-100 rounded-xl p-3 hover:border-indigo-300 hover:shadow-sm transition-all cursor-pointer" onclick="closeWorkerDrawer();openSessionById(' + s.id + ')">'
        + '<div class="flex items-start justify-between gap-2">'
        + '<div class="flex-1 min-w-0">'
        + '<p class="text-xs font-semibold text-gray-700 truncate">' + (s.job_location || 'No location') + '</p>'
        + '<p class="text-[11px] text-gray-400 mt-0.5">' + timeStr + '</p>'
        + flagsHtml
        + '</div>'
        + '<div class="text-right flex-shrink-0">' + earningsHtml + '</div>'
        + '</div></div>'
    }).join('')

  } catch(e) {
    document.getElementById('wd-sessions').innerHTML = '<p class="text-red-400 text-sm text-center py-6">Error loading data</p>'
    console.error(e)
  }
}

function wdTab(tab) {
  ;['sessions','profile','status','license'].forEach(t => {
    document.getElementById('wd-tab-' + t)?.classList.toggle('hidden', t !== tab)
    const btn = document.getElementById('wdt-' + t)
    if (!btn) return
    if (t === tab) {
      btn.className = 'px-3 py-2 text-xs font-medium rounded-t-lg border-b-2 border-indigo-500 text-indigo-600 bg-white whitespace-nowrap'
    } else {
      btn.className = 'px-3 py-2 text-xs font-medium rounded-t-lg border-b-2 border-transparent text-gray-500 hover:text-gray-700 whitespace-nowrap'
    }
  })
  // Load status data when switching to status tab
  if (tab === 'status' && _currentDrawerWorker) {
    loadWorkerStatusTab(_currentDrawerWorker.id, _currentDrawerWorker.worker_status || (_currentDrawerWorker.active ? 'active' : 'terminated'))
  }
}

function closeWorkerDrawer() {
  document.getElementById('worker-drawer').classList.add('hidden')
  document.body.style.overflow = ''
}

// ── Worker Status Tab ─────────────────────────────────────────────────────────

// Status display config (colour + icon + label)
const WS_CONFIG = {
  active:      { label: 'Active',       icon: 'fa-check-circle',     bg: 'bg-green-100',  text: 'text-green-700',  border: 'border-green-400',  card: 'bg-green-50'  },
  on_holiday:  { label: 'On Holiday',   icon: 'fa-umbrella-beach',   bg: 'bg-blue-100',   text: 'text-blue-700',   border: 'border-blue-400',   card: 'bg-blue-50'   },
  sick_leave:  { label: 'Sick Leave',   icon: 'fa-thermometer-half', bg: 'bg-yellow-100', text: 'text-yellow-700', border: 'border-yellow-400', card: 'bg-yellow-50' },
  suspended:   { label: 'Suspended',    icon: 'fa-pause-circle',     bg: 'bg-orange-100', text: 'text-orange-700', border: 'border-orange-400', card: 'bg-orange-50' },
  terminated:  { label: 'Terminated',   icon: 'fa-user-slash',       bg: 'bg-red-100',    text: 'text-red-700',    border: 'border-red-400',    card: 'bg-red-50'    },
}

let _pendingWorkerStatus = null  // tracks which radio-style button is selected

function wsConf(status) {
  return WS_CONFIG[status] || WS_CONFIG['active']
}

function selectWorkerStatus(status) {
  _pendingWorkerStatus = status
  // Highlight selected button, reset others
  Object.keys(WS_CONFIG).forEach(s => {
    const btn = document.getElementById('wds-' + s)
    if (!btn) return
    const conf = wsConf(s)
    if (s === status) {
      btn.className = `flex items-center gap-3 p-3 rounded-xl border-2 ${conf.border} ${conf.card} transition-all text-left ring-2 ring-offset-1 ring-indigo-400`
    } else {
      btn.className = 'flex items-center gap-3 p-3 rounded-xl border-2 border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50 transition-all text-left'
    }
  })
  // Show / hide return date field
  const returnWrap = document.getElementById('wd-s-return-wrap')
  if (returnWrap) returnWrap.classList.toggle('hidden', !['on_holiday','sick_leave'].includes(status))
}

async function loadWorkerStatusTab(workerId, currentStatus) {
  const logEl    = document.getElementById('wd-s-log')
  const badgeEl  = document.getElementById('wd-s-current-badge')
  const sinceEl  = document.getElementById('wd-s-since')
  if (!logEl) return

  // Highlight current status in selector
  selectWorkerStatus(currentStatus)

  // Current status badge
  const conf = wsConf(currentStatus)
  if (badgeEl) badgeEl.className = `text-xs px-3 py-1 rounded-full font-bold ${conf.bg} ${conf.text}`
  if (badgeEl) badgeEl.innerHTML = `<i class="fas ${conf.icon} mr-1"></i>${conf.label}`

  logEl.innerHTML = '<p class="text-gray-400 text-sm text-center py-4"><i class="fas fa-spinner fa-spin mr-2"></i>Loading audit trail...</p>'

  try {
    const res  = await fetch('/api/workers/' + workerId + '/status')
    const data = await res.json()

    // Update current status from server
    const serverStatus = data.current_status || currentStatus
    const sConf = wsConf(serverStatus)
    if (badgeEl) {
      badgeEl.className = `text-xs px-3 py-1 rounded-full font-bold ${sConf.bg} ${sConf.text}`
      badgeEl.innerHTML = `<i class="fas ${sConf.icon} mr-1"></i>${sConf.label}`
    }
    selectWorkerStatus(serverStatus)

    const log = data.log || []
    if (sinceEl) {
      if (log.length > 0) {
        const latest = log[0]
        const dt = new Date(latest.changed_at).toLocaleString([],{month:'short',day:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit'})
        sinceEl.textContent = `Since ${dt} · set by ${latest.changed_by}`
      } else {
        sinceEl.textContent = 'No status changes recorded yet'
      }
    }

    if (log.length === 0) {
      logEl.innerHTML = '<div class="text-center py-8 text-gray-300"><i class="fas fa-history text-3xl mb-2 block"></i><p class="text-sm">No status changes yet</p></div>'
      return
    }

    logEl.innerHTML = log.map(entry => {
      const dt   = new Date(entry.changed_at).toLocaleString([],{month:'short',day:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit'})
      const oConf = wsConf(entry.old_status || 'active')
      const nConf = wsConf(entry.new_status)
      const returnStr = entry.return_date
        ? `<p class="text-xs text-blue-600 mt-1"><i class="fas fa-calendar-check mr-1"></i>Expected return: ${new Date(entry.return_date + 'T00:00:00').toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'})}</p>`
        : ''
      return `
        <div class="bg-white border border-gray-100 rounded-xl p-3 shadow-sm">
          <div class="flex items-center gap-2 mb-2 flex-wrap">
            <span class="text-[10px] px-2 py-0.5 rounded-full font-medium ${oConf.bg} ${oConf.text}">
              <i class="fas ${oConf.icon} mr-0.5"></i>${oConf.label}
            </span>
            <i class="fas fa-arrow-right text-gray-300 text-[10px]"></i>
            <span class="text-[10px] px-2 py-0.5 rounded-full font-bold ${nConf.bg} ${nConf.text}">
              <i class="fas ${nConf.icon} mr-0.5"></i>${nConf.label}
            </span>
            <span class="ml-auto text-[10px] text-gray-400">${dt}</span>
          </div>
          <p class="text-xs text-gray-700 font-medium"><i class="fas fa-comment-alt mr-1 text-gray-300"></i>${entry.reason || '—'}</p>
          ${returnStr}
          <p class="text-[10px] text-gray-400 mt-1"><i class="fas fa-user mr-1"></i>By: ${entry.changed_by}</p>
        </div>`
    }).join('')
  } catch(e) {
    logEl.innerHTML = '<p class="text-red-400 text-sm text-center py-4">Error loading audit trail</p>'
    console.error(e)
  }
}

async function confirmWorkerStatusChange() {
  if (!_currentDrawerWorker) return
  const btn      = document.getElementById('wd-s-submit-btn')
  const reasonEl = document.getElementById('wd-s-reason')
  const errEl    = document.getElementById('wd-s-reason-error')
  const reason   = reasonEl ? reasonEl.value.trim() : ''
  const status   = _pendingWorkerStatus

  if (!status) { showAdminToast('Please select a status first', 'error'); return }

  if (!reason) {
    if (reasonEl) reasonEl.classList.add('border-red-400')
    if (errEl)    errEl.classList.remove('hidden')
    if (reasonEl) reasonEl.focus()
    return
  }
  if (errEl) errEl.classList.add('hidden')
  if (reasonEl) reasonEl.classList.remove('border-red-400')

  const returnDate = (document.getElementById('wd-s-return-date') || {}).value || ''

  btn.disabled = true
  btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1.5"></i>Saving...'

  try {
    const res = await fetch('/api/workers/' + _currentDrawerWorker.id + '/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, reason, return_date: returnDate, changed_by: 'admin' })
    })
    const data = await res.json()
    if (data.success) {
      const conf = wsConf(status)
      showAdminToast(`✅ ${_currentDrawerWorker.name} status → ${conf.label}`, 'success')
      // Clear form
      if (reasonEl) reasonEl.value = ''
      const rdEl = document.getElementById('wd-s-return-date')
      if (rdEl) rdEl.value = ''
      // Update in-memory worker object
      _currentDrawerWorker.worker_status = status
      _currentDrawerWorker.active = ['active','on_holiday','sick_leave'].includes(status) ? 1 : 0
      // Reload status tab + refresh worker list
      await loadWorkerStatusTab(_currentDrawerWorker.id, status)
      await loadWorkers()
      // Update the status badge in the drawer header
      const sbEl = document.getElementById('wd-status-badge')
      if (sbEl) sbEl.innerHTML = `<span class="text-xs px-2 py-0.5 rounded-full font-medium ${conf.bg} ${conf.text}"><i class="fas ${conf.icon} mr-1"></i>${conf.label}</span>`
    } else {
      showAdminToast(data.error || 'Failed to update status', 'error')
    }
  } catch(e) {
    showAdminToast('Connection error', 'error')
    console.error(e)
  } finally {
    btn.disabled = false
    btn.innerHTML = '<i class="fas fa-save mr-1.5"></i>Save Status Change'
  }
}

// ── Edit Worker Modal ─────────────────────────────────────────────────────────
function openEditWorkerModal(focusTab) {
  const w = _currentDrawerWorker
  if (!w) return
  document.getElementById('ew-worker-id').value  = w.id
  document.getElementById('ew-subtitle').textContent = 'Editing: ' + w.name
  document.getElementById('ew-name').value       = w.name || ''
  document.getElementById('ew-phone').value      = w.phone || ''
  document.getElementById('ew-email').value      = w.email || ''
  document.getElementById('ew-address').value    = w.home_address || ''
  document.getElementById('ew-emergency').value  = w.emergency_contact || ''
  document.getElementById('ew-pin').value        = ''  // don't prefill PIN
  document.getElementById('ew-job-title').value  = w.job_title || ''
  document.getElementById('ew-start-date').value = w.start_date || ''
  const pt = w.pay_type || 'hourly'
  document.getElementById('ew-pay-type').value   = pt
  document.getElementById('ew-rate').value       = w.hourly_rate || ''
  document.getElementById('ew-salary').value     = w.salary_amount || ''
  document.getElementById('ew-active').value     = String(w.active ?? 1)
  document.getElementById('ew-license-num').value = w.drivers_license_number || ''
  document.getElementById('ew-notes').value      = w.worker_notes || ''
  toggleEwPayType()

  // Preview existing license images
  const frontPrev = document.getElementById('ew-lic-front-preview')
  const backPrev  = document.getElementById('ew-lic-back-preview')
  document.getElementById('ew-lic-front-b64').value = ''
  document.getElementById('ew-lic-back-b64').value  = ''
  frontPrev.innerHTML = w.license_front_b64
    ? `<img src="${w.license_front_b64}" class="w-full h-full object-cover rounded-xl"/>`
    : '<i class="fas fa-camera text-amber-400 text-xl mb-1"></i><span class="text-xs text-amber-500">Tap to change</span>'
  backPrev.innerHTML = w.license_back_b64
    ? `<img src="${w.license_back_b64}" class="w-full h-full object-cover rounded-xl"/>`
    : '<i class="fas fa-camera text-amber-400 text-xl mb-1"></i><span class="text-xs text-amber-500">Tap to change</span>'

  document.getElementById('edit-worker-modal').classList.remove('hidden')
  // Scroll to license section if requested
  if (focusTab === 'license') {
    setTimeout(() => document.getElementById('ew-license-num')?.scrollIntoView({behavior:'smooth'}), 200)
  }
}

function closeEditWorkerModal() {
  document.getElementById('edit-worker-modal').classList.add('hidden')
}

function toggleEwPayType() {
  const t = document.getElementById('ew-pay-type')?.value
  document.getElementById('ew-hourly-block')?.classList.toggle('hidden', t === 'salary')
  document.getElementById('ew-salary-block')?.classList.toggle('hidden', t !== 'salary')
}

async function saveEditWorker() {
  const id      = document.getElementById('ew-worker-id').value
  const rawName = document.getElementById('ew-name').value.trim()
  const name    = rawName.replace(/\b\w/g, c => c.toUpperCase())
  if (!name) { showAdminToast('Name is required', 'error'); return }

  const payType = document.getElementById('ew-pay-type').value
  const pin     = document.getElementById('ew-pin').value.trim()

  const payload = {
    name,
    hourly_rate:             parseFloat(document.getElementById('ew-rate').value) || 0,
    salary_amount:           parseFloat(document.getElementById('ew-salary').value) || 0,
    role:                    'worker',
    active:                  parseInt(document.getElementById('ew-active').value),
    email:                   document.getElementById('ew-email').value.trim() || null,
    home_address:            document.getElementById('ew-address').value.trim() || null,
    emergency_contact:       document.getElementById('ew-emergency').value.trim() || null,
    job_title:               document.getElementById('ew-job-title').value.trim() || null,
    start_date:              document.getElementById('ew-start-date').value || null,
    pay_type:                payType,
    drivers_license_number:  document.getElementById('ew-license-num').value.trim() || null,
    license_front_b64:       document.getElementById('ew-lic-front-b64').value || '',
    license_back_b64:        document.getElementById('ew-lic-back-b64').value || '',
    worker_notes:            document.getElementById('ew-notes').value.trim() || null,
  }
  if (pin) payload.pin = pin

  try {
    const res = await fetch('/api/workers/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    if (res.ok) {
      showAdminToast('✅ Worker profile updated!', 'success')
      closeEditWorkerModal()
      await openWorkerDrawer(parseInt(id))
      await loadWorkers()
    } else {
      showAdminToast('Failed to save', 'error')
    }
  } catch(e) { showAdminToast('Error saving worker', 'error'); console.error(e) }
}

function openSessionById(id) {
  const s = sessionStore[id]
  if (!s) { console.warn('Session not found in store:', id); return }
  openSessionModal(s)
}

function filterSessionsByWorker() {
  const workerId = document.getElementById('wd-filter-sessions-btn').dataset.workerId
  closeWorkerDrawer()
  showTab('sessions')
  setTimeout(() => {
    const sel = document.getElementById('filter-worker')
    if (sel) { sel.value = workerId; loadSessions() }
  }, 100)
}

function filterSessionsByDate(workerId, dateStr) {
  showTab('sessions')
  setTimeout(() => {
    const dateEl = document.getElementById('filter-date')
    const workerEl = document.getElementById('filter-worker')
    if (dateEl) dateEl.value = dateStr
    if (workerEl) workerEl.value = workerId
    loadSessions()
  }, 100)
}

// ── Session Detail Modal ──────────────────────────────────────────────────────
function openSessionModal(s) {
  // s can be object or JSON string (from onclick attribute)
  if (typeof s === 'string') {
    try { s = JSON.parse(s.replace(/&quot;/g, '"')) } catch(e) { return }
  }
  const modal = document.getElementById('session-modal')
  modal.classList.remove('hidden')
  document.body.style.overflow = 'hidden'

  const cin  = new Date(s.clock_in_time)
  const cout = s.clock_out_time ? new Date(s.clock_out_time) : null
  const isActive = s.status === 'active'

  document.getElementById('sm-worker-name').textContent = s.worker_name || 'Worker'
  document.getElementById('sm-date').textContent = cin.toLocaleDateString([],{weekday:'long',year:'numeric',month:'long',day:'numeric'})

  const mapInLink = s.clock_in_lat
    ? `<a href="https://maps.google.com/?q=${s.clock_in_lat},${s.clock_in_lng}" target="_blank" class="text-blue-500 text-xs hover:underline"><i class="fas fa-external-link-alt mr-1"></i>Open in Maps</a>`
    : ''
  const mapOutLink = s.clock_out_lat
    ? `<a href="https://maps.google.com/?q=${s.clock_out_lat},${s.clock_out_lng}" target="_blank" class="text-blue-500 text-xs hover:underline"><i class="fas fa-external-link-alt mr-1"></i>Open in Maps</a>`
    : ''

  const flags = []
  if (s.session_type === 'material_pickup') flags.push('<span class="bg-amber-100 text-amber-700 px-2 py-1 rounded-full text-xs font-medium"><i class="fas fa-shopping-cart mr-1"></i>Material Pickup</span>')
  if (s.session_type === 'emergency_job')   flags.push('<span class="bg-rose-100 text-rose-700 px-2 py-1 rounded-full text-xs font-medium"><i class="fas fa-bolt mr-1"></i>Emergency Job</span>')
  if (s.drift_flag)    flags.push(`<span class="bg-orange-100 text-orange-700 px-2 py-1 rounded-full text-xs font-medium"><i class="fas fa-exclamation-triangle mr-1"></i>Left Job Site${s.drift_distance_meters ? ' (' + (s.drift_distance_meters >= 1000 ? (s.drift_distance_meters/1000).toFixed(1)+'km' : Math.round(s.drift_distance_meters)+'m') + ')' : ''}</span>`)
  if (s.away_flag)     flags.push('<span class="bg-yellow-100 text-yellow-700 px-2 py-1 rounded-full text-xs font-medium"><i class="fas fa-wifi mr-1"></i>Away / No GPS</span>')
  if (s.auto_clockout) {
    flags.push(`<span class="bg-red-100 text-red-700 px-2 py-1 rounded-full text-xs font-medium"><i class="fas fa-stop-circle mr-1"></i>${autoClockoutLabel(s)}</span>`)
  }

  document.getElementById('sm-body').innerHTML = `
    <!-- Time block -->
    <div class="grid grid-cols-2 gap-3">
      <div class="bg-green-50 rounded-2xl p-4">
        <p class="text-xs text-green-500 font-medium mb-1"><i class="fas fa-sign-in-alt mr-1"></i>Clock In</p>
        <p class="text-lg font-bold text-green-700">${cin.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</p>
        ${s.clock_in_address ? `<p class="text-xs text-green-600 mt-1 leading-tight">${s.clock_in_address}</p>` : ''}
        ${mapInLink}
      </div>
      <div class="${isActive ? 'bg-blue-50' : 'bg-red-50'} rounded-2xl p-4">
        <p class="text-xs ${isActive ? 'text-blue-500' : 'text-red-500'} font-medium mb-1"><i class="fas fa-sign-out-alt mr-1"></i>Clock Out</p>
        <p class="text-lg font-bold ${isActive ? 'text-blue-600' : 'text-red-700'}">${isActive ? 'Still working' : cout.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</p>
        ${s.clock_out_address && !isActive ? `<p class="text-xs text-red-600 mt-1 leading-tight">${s.clock_out_address}</p>` : ''}
        ${mapOutLink}
      </div>
    </div>

    <!-- Hours & Earnings -->
    ${!isActive ? `
    <div class="grid grid-cols-2 gap-3">
      <div class="bg-yellow-50 rounded-2xl p-4 text-center">
        <p class="text-2xl font-bold text-yellow-700">${(s.total_hours||0).toFixed(2)}h</p>
        <p class="text-xs text-yellow-500 mt-0.5">Hours Worked</p>
      </div>
      <div class="bg-purple-50 rounded-2xl p-4 text-center">
        <p class="text-2xl font-bold text-purple-700">$${(s.earnings||0).toFixed(2)}</p>
        <p class="text-xs text-purple-500 mt-0.5">Earnings</p>
      </div>
    </div>` : ''}

    <!-- Job Info -->
    ${s.job_location ? `
    <div class="bg-gray-50 rounded-2xl p-4 space-y-2">
      <div class="flex items-start gap-2">
        <i class="fas fa-map-marker-alt text-red-500 mt-0.5 flex-shrink-0"></i>
        <div>
          <p class="text-xs text-gray-400 font-medium">Job Location</p>
          <p class="text-sm font-semibold text-gray-800">${s.job_location}</p>
        </div>
      </div>
      ${s.job_description ? `
      <div class="flex items-start gap-2">
        <i class="fas fa-tools text-blue-400 mt-0.5 flex-shrink-0"></i>
        <div>
          <p class="text-xs text-gray-400 font-medium">Task Description</p>
          <p class="text-sm text-gray-700">${s.job_description}</p>
        </div>
      </div>` : ''}
    </div>` : ''}

    <!-- Guardrail Flags -->
    ${flags.length ? `
    <div>
      <p class="text-xs text-gray-400 font-medium mb-2"><i class="fas fa-shield-alt mr-1"></i>Guardrail Events</p>
      <div class="flex flex-wrap gap-2">${flags.join('')}</div>
    </div>` : ''}

    <!-- Notes (worker-entered notes only) -->
    ${!isSystemNote(s.notes) ? `
    <div class="bg-yellow-50 rounded-2xl p-4">
      <p class="text-xs text-yellow-500 font-medium mb-1"><i class="fas fa-sticky-note mr-1"></i>Notes</p>
      <p class="text-sm text-gray-700">${s.notes}</p>
    </div>` : ''}

    <!-- Action row -->
    <div class="flex gap-2 pt-2 flex-wrap">
      <button onclick="closeSessionModal();openWorkerDrawer(${s.worker_id})" class="flex-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-medium py-2.5 rounded-xl text-sm transition-colors">
        <i class="fas fa-user mr-1"></i>View Worker
      </button>
      <button onclick="closeSessionModal();filterSessionsByDateFromSession(${s.id})" class="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium py-2.5 rounded-xl text-sm transition-colors">
        <i class="fas fa-list mr-1"></i>Filter Sessions
      </button>
      ${isActive ? `<button onclick="closeSessionModal();openAdminClockoutModal(${s.id})" class="w-full bg-red-50 hover:bg-red-100 text-red-600 font-bold py-2.5 rounded-xl text-sm transition-colors border border-red-200"><i class="fas fa-stop-circle mr-1.5"></i>Admin Clock-Out</button>` : `<button onclick="closeSessionModal();openSessionEditModal(${s.id})" class="w-full bg-amber-50 hover:bg-amber-100 text-amber-700 font-bold py-2.5 rounded-xl text-sm transition-colors border border-amber-200"><i class="fas fa-edit mr-1.5"></i>Edit Session Times</button>`}
    </div>
  `
}

function closeSessionModal() {
  document.getElementById('session-modal').classList.add('hidden')
  document.body.style.overflow = ''
}

// ── Admin Clock-Out Modal ─────────────────────────────────────────────────────
let pendingClockoutSessionId = null

function openAdminClockoutModal(sessionId) {
  pendingClockoutSessionId = sessionId
  const s = sessionStore[sessionId]

  // Pre-fill info strip
  const infoEl = document.getElementById('aco-info')
  const labelEl = document.getElementById('aco-worker-label')
  document.getElementById('aco-note').value = ''

  if (s) {
    const start = new Date(s.clock_in_time)
    const hoursWorked = ((new Date() - start) / 3600000).toFixed(1)
    const est = (parseFloat(hoursWorked) * (s.hourly_rate || 0)).toFixed(2)
    labelEl.textContent = s.worker_name || 'Worker'
    infoEl.innerHTML = `
      <div class="flex justify-between text-sm mb-1">
        <span class="text-gray-500"><i class="fas fa-user mr-1 text-gray-400"></i>Worker</span>
        <span class="font-semibold text-gray-800">${s.worker_name || '–'}</span>
      </div>
      <div class="flex justify-between text-sm mb-1">
        <span class="text-gray-500"><i class="fas fa-map-marker-alt mr-1 text-red-400"></i>Job Site</span>
        <span class="font-medium text-gray-700 text-right max-w-[55%] truncate">${s.job_location || 'Unknown'}</span>
      </div>
      <div class="flex justify-between text-sm mb-1">
        <span class="text-gray-500"><i class="fas fa-sign-in-alt mr-1 text-green-500"></i>Clocked In</span>
        <span class="font-medium text-gray-700">${start.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</span>
      </div>
      <div class="flex justify-between text-sm mb-1">
        <span class="text-gray-500"><i class="fas fa-clock mr-1 text-yellow-500"></i>Hours So Far</span>
        <span class="font-bold text-yellow-700">${hoursWorked}h</span>
      </div>
      <div class="flex justify-between text-sm">
        <span class="text-gray-500"><i class="fas fa-dollar-sign mr-1 text-green-500"></i>Est. Earnings</span>
        <span class="font-bold text-green-700">$${est}</span>
      </div>
      ${s.drift_flag ? '<div class="mt-2 text-xs text-orange-600 bg-orange-50 rounded-lg px-2 py-1"><i class="fas fa-exclamation-triangle mr-1"></i>Worker is outside the geofence</div>' : ''}
      ${s.away_flag  ? '<div class="mt-2 text-xs text-yellow-600 bg-yellow-50 rounded-lg px-2 py-1"><i class="fas fa-wifi mr-1"></i>Worker GPS has gone silent</div>' : ''}
    `
  } else {
    labelEl.textContent = 'Session #' + sessionId
    infoEl.innerHTML = '<p class="text-sm text-gray-500">Session ID: ' + sessionId + '</p>'
  }

  document.getElementById('admin-clockout-modal').classList.remove('hidden')
  document.body.style.overflow = 'hidden'
}

function closeAdminClockoutModal() {
  document.getElementById('admin-clockout-modal').classList.add('hidden')
  document.body.style.overflow = ''
  pendingClockoutSessionId = null
  cancelAcoHold()   // always reset hold bar on close
  // Reset validation state
  const noteEl = document.getElementById('aco-note')
  const errEl  = document.getElementById('aco-note-error')
  if (noteEl) { noteEl.value = ''; noteEl.classList.remove('border-red-400') }
  if (errEl)  errEl.classList.add('hidden')
}

// Quick-reason chip helper — fills textarea AND clears error state
function pickAcoReason(text) {
  const noteEl = document.getElementById('aco-note')
  const errEl  = document.getElementById('aco-note-error')
  if (noteEl) { noteEl.value = text; noteEl.classList.remove('border-red-400') }
  if (errEl)  errEl.classList.add('hidden')
}

// ── Admin Clock-Out Hold-to-Confirm ───────────────────────────────────────────
let _acoHoldTimer = null
let _acoHoldFrame = null
let _acoHoldStart = null
const ACO_HOLD_MS  = 2000   // 2 seconds to confirm

function startAcoHold(e) {
  if (e) e.preventDefault()
  // Validate note FIRST — don't start hold if empty
  const noteEl = document.getElementById('aco-note')
  const errEl  = document.getElementById('aco-note-error')
  const note   = noteEl ? noteEl.value.trim() : ''
  if (!note) {
    if (noteEl) { noteEl.classList.add('border-red-400'); noteEl.focus() }
    if (errEl)  errEl.classList.remove('hidden')
    return
  }
  if (errEl) errEl.classList.add('hidden')
  if (noteEl) noteEl.classList.remove('border-red-400')

  _acoHoldStart = Date.now()
  const bar  = document.getElementById('aco-hold-bar')
  const lbl  = document.getElementById('aco-btn-label')

  function tick() {
    const elapsed = Date.now() - _acoHoldStart
    const pct     = Math.min(100, (elapsed / ACO_HOLD_MS) * 100)
    if (bar) bar.style.width = pct + '%'
    if (pct < 100) {
      _acoHoldFrame = requestAnimationFrame(tick)
    } else {
      // Held long enough — fire!
      cancelAcoHold()
      confirmAdminClockout()
    }
  }
  _acoHoldFrame = requestAnimationFrame(tick)
  if (lbl) lbl.textContent = 'Hold...'
}

function cancelAcoHold() {
  if (_acoHoldFrame) { cancelAnimationFrame(_acoHoldFrame); _acoHoldFrame = null }
  if (_acoHoldTimer) { clearTimeout(_acoHoldTimer); _acoHoldTimer = null }
  _acoHoldStart = null
  const bar = document.getElementById('aco-hold-bar')
  const lbl = document.getElementById('aco-btn-label')
  if (bar) bar.style.width = '0%'
  if (lbl) lbl.textContent = 'Hold to Clock Out'
}

async function confirmAdminClockout() {
  if (!pendingClockoutSessionId) return
  const btn    = document.getElementById('aco-confirm-btn')
  const noteEl = document.getElementById('aco-note')
  const errEl  = document.getElementById('aco-note-error')
  const note   = noteEl ? noteEl.value.trim() : ''

  // Final validation check
  if (!note) {
    if (noteEl) noteEl.classList.add('border-red-400')
    if (errEl)  errEl.classList.remove('hidden')
    if (noteEl) noteEl.focus()
    return
  }
  if (errEl) errEl.classList.add('hidden')

  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1.5"></i>Stopping...' }

  try {
    const res = await fetch('/api/sessions/' + pendingClockoutSessionId + '/admin-clockout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note })
    })
    const data = await res.json()

    if (data.success) {
      closeAdminClockoutModal()
      showAdminToast(`✅ ${data.message} · ${data.total_hours}h · $${(data.earnings||0).toFixed(2)}`, 'success')
      // Small delay so D1 write propagates before we re-read
      await new Promise(r => setTimeout(r, 400))
      // Sequential refresh: live first (removes the card), then sessions + stats
      await loadLive()
      await Promise.all([loadSessions(), loadStats()])
    } else {
      showAdminToast(data.error || 'Clock-out failed', 'error')
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-stop-circle mr-1.5"></i>Hold to Clock Out' }
    }
  } catch(e) {
    showAdminToast('Connection error', 'error')
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-stop-circle mr-1.5"></i>Hold to Clock Out' }
  }
}

// ── Bulk Drift Clock-Out Modal ────────────────────────────────────────────────
let pendingDriftedSessions = []

async function showBulkClockoutModal() {
  // Fetch current active sessions to get latest drifted list
  const res = await fetch('/api/sessions/active')
  const data = await res.json()
  pendingDriftedSessions = (data.sessions || []).filter(s => s.drift_flag && !s.auto_clockout)

  if (pendingDriftedSessions.length === 0) {
    showAdminToast('No workers currently outside the geofence', 'info')
    return
  }

  document.getElementById('bco-label').textContent =
    pendingDriftedSessions.length + ' worker' + (pendingDriftedSessions.length > 1 ? 's' : '') + ' outside the geofence'

  document.getElementById('bco-list').innerHTML = pendingDriftedSessions.map(s => {
    const dist = s.drift_distance_meters >= 1000
      ? (s.drift_distance_meters/1000).toFixed(1) + 'km'
      : Math.round(s.drift_distance_meters) + 'm'
    const hrs = ((new Date() - new Date(s.clock_in_time)) / 3600000).toFixed(1)
    return `<div class="flex items-center justify-between gap-2">
      <span class="font-medium text-gray-800">${s.worker_name}</span>
      <span class="text-orange-600 text-xs font-bold">${dist} away</span>
      <span class="text-gray-400 text-xs">${hrs}h</span>
    </div>`
  }).join('')

  document.getElementById('bulk-clockout-modal').classList.remove('hidden')
  document.body.style.overflow = 'hidden'
}

function closeBulkClockoutModal() {
  document.getElementById('bulk-clockout-modal').classList.add('hidden')
  document.body.style.overflow = ''
}

async function confirmBulkClockout() {
  const btn = document.getElementById('bco-confirm-btn')
  btn.disabled = true
  btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1.5"></i>Stopping...'

  try {
    const res = await fetch('/api/sessions/clockout-drifted', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'Worker left job site — stopped by admin' })
    })
    const data = await res.json()

    if (data.success) {
      closeBulkClockoutModal()
      showAdminToast(`✅ ${data.message} (${data.count} session${data.count !== 1 ? 's' : ''} closed)`, 'success')
      await Promise.all([loadLive(), loadSessions(), loadStats()])
    } else {
      showAdminToast('Bulk clock-out failed', 'error')
      btn.disabled = false
      btn.innerHTML = '<i class="fas fa-stop-circle mr-1.5"></i>Stop All'
    }
  } catch(e) {
    showAdminToast('Connection error', 'error')
    btn.disabled = false
    btn.innerHTML = '<i class="fas fa-stop-circle mr-1.5"></i>Stop All'
  }
}

// ── Day Detail Modal ──────────────────────────────────────────────────────────
function openDayModal(dateStr) {
  const sessions = (calCurrentData.sessions_by_date || {})[dateStr] || []
  if (sessions.length === 0) return

  // Populate sessionStore
  sessions.forEach(s => { if (s.id) sessionStore[s.id] = s })

  const modal = document.getElementById('day-modal')
  modal.classList.remove('hidden')
  document.body.style.overflow = 'hidden'

  const d = new Date(dateStr + 'T12:00:00')
  const label = d.toLocaleDateString([],{weekday:'long',year:'numeric',month:'long',day:'numeric'})
  document.getElementById('dm-title').textContent = label
  document.getElementById('dm-sub').textContent = sessions.length + ' shift' + (sessions.length > 1 ? 's' : '') + ' recorded'

  const totalH = sessions.reduce((s, x) => s + (x.total_hours || 0), 0)
  const totalE = sessions.reduce((s, x) => s + (x.earnings || 0), 0)
  const workers = [...new Set(sessions.map(s => s.worker_name))].filter(Boolean)
  document.getElementById('dm-stats').innerHTML = `
    <div class="bg-white rounded-xl py-2 px-3">
      <p class="text-xl font-bold text-indigo-700">${sessions.length}</p>
      <p class="text-xs text-gray-400 mt-0.5">Shifts</p>
    </div>
    <div class="bg-white rounded-xl py-2 px-3">
      <p class="text-xl font-bold text-yellow-600">${totalH.toFixed(1)}h</p>
      <p class="text-xs text-gray-400 mt-0.5">Hours</p>
    </div>
    <div class="bg-white rounded-xl py-2 px-3">
      <p class="text-xl font-bold text-green-600">$${totalE.toFixed(2)}</p>
      <p class="text-xs text-gray-400 mt-0.5">Earned</p>
    </div>
  `

  document.getElementById('dm-sessions').innerHTML = sessions.map(s => {
    const cin  = new Date(s.clock_in_time).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})
    const cout = s.clock_out_time ? new Date(s.clock_out_time).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) : null
    const isActive = s.status === 'active'
    const flags = []
    if (s.session_type === 'material_pickup') flags.push('<span class="text-amber-600 text-[10px]">📦 Pickup</span>')
    if (s.session_type === 'emergency_job')   flags.push('<span class="text-rose-600 text-[10px]">🚨 Emergency</span>')
    if (s.drift_flag)    flags.push('<span class="text-orange-600 text-[10px]">⚠ Left Site</span>')
    if (s.away_flag)     flags.push('<span class="text-yellow-600 text-[10px]">⏰ Away</span>')
    if (s.auto_clockout) flags.push('<span class="text-red-600 text-[10px]">🔴 Auto Out</span>')

    return `<div class="bg-gray-50 border border-gray-100 rounded-xl p-4 hover:border-indigo-300 hover:shadow-sm transition-all cursor-pointer" onclick=\"closeDayModal();openSessionById(${s.id})\">
      <div class="flex items-start justify-between gap-3">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 mb-1.5">
            <span class="w-7 h-7 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-600 text-xs font-bold flex-shrink-0">${(s.worker_name||'?').charAt(0).toUpperCase()}</span>
            <span class="font-bold text-gray-800 text-sm">${s.worker_name || 'Unknown'}</span>
          </div>
          ${s.job_location ? `<p class="text-xs text-gray-500 mb-1 ml-9"><i class="fas fa-map-marker-alt text-red-400 mr-1"></i>${s.job_location}</p>` : ''}
          ${s.job_description ? `<p class="text-xs text-gray-400 mb-1 ml-9 truncate"><i class="fas fa-tools text-blue-300 mr-1"></i>${s.job_description}</p>` : ''}
          <p class="text-xs text-gray-400 ml-9">
            ${cin} → ${isActive ? '<span class="text-green-600 font-medium">Active</span>' : cout}
          </p>
          ${flags.length ? `<div class="flex gap-2 mt-1 ml-9">${flags.join(' · ')}</div>` : ''}
        </div>
        <div class="text-right flex-shrink-0">
          ${isActive
            ? `<span class="text-green-500 text-xs pulse">LIVE</span>`
            : `<p class="font-bold text-gray-800">${(s.total_hours||0).toFixed(1)}h</p>
               <p class="text-green-600 font-bold text-sm">$${(s.earnings||0).toFixed(2)}</p>`
          }
          <p class="text-gray-300 text-[10px] mt-1">tap for details</p>
        </div>
      </div>
    </div>`
  }).join('')
}

function closeDayModal() {
  document.getElementById('day-modal').classList.add('hidden')
  document.body.style.overflow = ''
}

async function loadLive() {
  try {
    const res = await fetch('/api/sessions/active')
    const data = await res.json()
    const el = document.getElementById('live-workers')
    const bulkBtn = document.getElementById('bulk-clockout-btn')
    
    if (!data.sessions || data.sessions.length === 0) {
      el.innerHTML = '<p class="text-gray-400 text-center py-8 col-span-full"><i class="fas fa-moon mr-2"></i>No workers currently clocked in</p>'
      if (bulkBtn) bulkBtn.classList.add('hidden')
      return
    }
    // Deduplicate live sessions by ID
    const liveSessions = (data.sessions || []).filter((s, i, arr) => arr.findIndex(x => x.id === s.id) === i)
    // Populate sessionStore for modal lookups
    liveSessions.forEach(s => { if (s.id) sessionStore[s.id] = s })

    // Show/hide bulk drift clock-out button
    const driftedCount = liveSessions.filter(s => s.drift_flag && !s.auto_clockout).length
    if (bulkBtn) {
      if (driftedCount > 0) {
        bulkBtn.classList.remove('hidden')
        document.getElementById('bulk-clockout-label').textContent =
          `Clock Out ${driftedCount} — Left Site`
      } else {
        bulkBtn.classList.add('hidden')
      }
    }

    el.innerHTML = liveSessions.map(s => {
      const start = new Date(s.clock_in_time)
      const now = new Date()
      const hoursWorked = ((now - start) / 3600000).toFixed(1)
      const estimatedEarnings = (parseFloat(hoursWorked) * (s.hourly_rate || 0)).toFixed(2)
      const hasLocation = s.clock_in_lat && s.clock_in_lng
      const isActive = !s.auto_clockout

      // Guardrail badges
      const badges = []
      if (s.session_type === 'material_pickup') badges.push(`<span class="bg-amber-100 text-amber-700 text-xs px-2 py-0.5 rounded-full font-medium"><i class="fas fa-shopping-cart mr-1"></i>Material Pickup</span>`)
      if (s.session_type === 'emergency_job')   badges.push(`<span class="bg-rose-100 text-rose-700 text-xs px-2 py-0.5 rounded-full font-medium"><i class="fas fa-bolt mr-1"></i>Emergency Job</span>`)
      if (s.drift_flag)    badges.push(`<span class="bg-orange-100 text-orange-700 text-xs px-2 py-0.5 rounded-full font-medium"><i class="fas fa-exclamation-triangle mr-1"></i>Left Site</span>`)
      if (s.away_flag)     badges.push(`<span class="bg-yellow-100 text-yellow-700 text-xs px-2 py-0.5 rounded-full font-medium"><i class="fas fa-wifi mr-1"></i>No GPS</span>`)
      if (s.auto_clockout) badges.push(`<span class="bg-red-100 text-red-700 text-xs px-2 py-0.5 rounded-full font-medium"><i class="fas fa-clock mr-1"></i>Auto Out</span>`)

      // Status badge
      const statusBadge = s.auto_clockout
        ? `<span class="bg-red-100 text-red-600 text-xs px-2 py-1 rounded-full font-medium"><i class="fas fa-stop-circle mr-1"></i>AUTO OUT</span>`
        : `<span class="bg-green-100 text-green-700 text-xs px-2 py-1 rounded-full font-medium pulse"><i class="fas fa-circle mr-1" style="font-size:6px"></i>LIVE</span>`

      const jobRow = s.job_location
        ? `<p class="text-xs text-gray-500 mt-1 truncate"><i class="fas fa-map-pin mr-1 text-gray-400"></i>${s.job_location}</p>`
        : ''

      const driftRow = s.drift_flag && s.drift_distance_meters
        ? `<p class="text-xs text-orange-600 mt-1"><i class="fas fa-route mr-1"></i>${s.drift_distance_meters >= 1000 ? (s.drift_distance_meters/1000).toFixed(1)+'km' : Math.round(s.drift_distance_meters)+'m'} from job site</p>`
        : ''

      // autoReason: only show if there's a meaningful reason beyond the badge
      const _cleanR = s.auto_clockout ? cleanReason(s.auto_clockout_reason) : ''
      const autoReason = (_cleanR && !s.drift_flag)
        ? `<p class="text-xs text-red-600 mt-1 italic"><i class="fas fa-info-circle mr-1"></i>${_cleanR}</p>`
        : ''

      // Admin clock-out button — only for active sessions
      const adminBtn = isActive
        ? `<button onclick="event.stopPropagation();openAdminClockoutModal(${s.id})"
            class="w-full mt-3 flex items-center justify-center gap-1.5 bg-red-50 hover:bg-red-100 text-red-600 font-semibold text-xs py-2 rounded-xl border border-red-200 hover:border-red-400 transition-all">
            <i class="fas fa-stop-circle"></i> Admin Clock-Out
          </button>`
        : ''
      
      return `<div class="border ${s.session_type === 'material_pickup' ? 'border-amber-300' : s.session_type === 'emergency_job' ? 'border-rose-300' : s.drift_flag ? 'border-orange-300' : s.away_flag ? 'border-yellow-300' : 'border-gray-100'} rounded-xl p-4 hover:shadow-md transition-shadow cursor-pointer hover:border-indigo-300 ${s.auto_clockout ? 'opacity-70' : ''}" onclick="openWorkerDrawer(${s.worker_id})">
        <div class="flex items-start justify-between mb-2">
          <div class="flex-1 min-w-0">
            <h4 class="font-bold text-gray-800">${s.worker_name}</h4>
            <p class="text-gray-500 text-xs">${s.worker_phone}</p>
            ${jobRow}${driftRow}${autoReason}
          </div>
          ${statusBadge}
        </div>
        ${badges.length ? `<div class="flex flex-wrap gap-1 mb-2">${badges.join('')}</div>` : ''}
        <div class="grid grid-cols-2 gap-2 mb-2">
          <div class="bg-blue-50 rounded-lg p-2 text-center">
            <p class="text-xs text-blue-500">Clock In</p>
            <p class="text-sm font-bold text-blue-700">${start.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</p>
          </div>
          <div class="bg-yellow-50 rounded-lg p-2 text-center">
            <p class="text-xs text-yellow-500">Hours</p>
            <p class="text-sm font-bold text-yellow-700">${hoursWorked}h</p>
          </div>
        </div>
        <div class="flex items-center justify-between text-xs mb-1">
          <span class="text-gray-500">
            ${hasLocation ? `<i class="fas fa-map-marker-alt text-red-500 mr-1"></i>GPS tracked` : '<i class="fas fa-map-marker-slash text-gray-400 mr-1"></i>No GPS'}
          </span>
          <span class="font-bold text-purple-600">~$${estimatedEarnings}</span>
        </div>
        ${adminBtn}
      </div>`
    }).join('')
  } catch(e) { console.error(e) }
}

// ── Workforce dropdown (sidebar) ─────────────────────────────────────────────
let _currentWorkersView = 'all'
let _workforceOpen = false

function toggleWorkforce(e) {
  if (e) e.stopPropagation()
  _workforceOpen = !_workforceOpen
  const menu    = document.getElementById('workers-submenu')
  const chevron = document.getElementById('workforce-chevron')
  const btn     = document.getElementById('workforce-btn')
  const icon    = document.getElementById('workforce-icon')
  if (!menu) return

  if (_workforceOpen) {
    menu.classList.remove('hidden')
    if (chevron) chevron.style.transform = 'rotate(180deg)'
    if (btn) {
      btn.classList.add('bg-indigo-50','text-indigo-700','tab-active')
      btn.classList.remove('text-gray-600')
    }
    if (icon) {
      icon.classList.remove('bg-blue-100','text-blue-600')
      icon.classList.add('bg-indigo-600','text-white')
    }
    // Show workers tab and render default view
    _showWorkersTabContent()
    _highlightWvBtn(_currentWorkersView)
  } else {
    menu.classList.add('hidden')
    if (chevron) chevron.style.transform = ''
    if (btn) {
      btn.classList.remove('bg-indigo-50','text-indigo-700','tab-active')
      btn.classList.add('text-gray-600')
    }
    if (icon) {
      icon.classList.add('bg-blue-100','text-blue-600')
      icon.classList.remove('bg-indigo-600','text-white')
    }
  }
}

function _showWorkersTabContent() {
  // Show only the workers tab panel without touching sidebar button highlights
  document.querySelectorAll('.tab-content').forEach(t => t.classList.add('hidden'))
  const tabEl = document.getElementById('tab-workers')
  if (tabEl) tabEl.classList.remove('hidden')
  // Render the current view
  if (_currentWorkersView === 'onsite') {
    renderOnsiteWorkers()
  } else if (_currentWorkersView === 'active') {
    setWorkerFilter('active')
  } else {
    setWorkerFilter('all')
  }
}

function _highlightWvBtn(view) {
  document.querySelectorAll('.wv-btn').forEach(el => {
    const v = el.id.replace('wv-','')
    if (v === view) {
      el.style.backgroundColor = 'rgb(238 242 255)'
      el.style.color = 'rgb(79 70 229)'
      el.style.fontWeight = '600'
    } else {
      el.style.backgroundColor = ''
      el.style.color = ''
      el.style.fontWeight = ''
    }
  })
}

function doShowWorkersView(view) {
  _currentWorkersView = view
  // Make sure workforce is open
  if (!_workforceOpen) {
    _workforceOpen = true
    const menu    = document.getElementById('workers-submenu')
    const chevron = document.getElementById('workforce-chevron')
    const btn     = document.getElementById('workforce-btn')
    const icon    = document.getElementById('workforce-icon')
    if (menu) menu.classList.remove('hidden')
    if (chevron) chevron.style.transform = 'rotate(180deg)'
    if (btn) { btn.classList.add('bg-indigo-50','text-indigo-700','tab-active'); btn.classList.remove('text-gray-600') }
    if (icon) { icon.classList.remove('bg-blue-100','text-blue-600'); icon.classList.add('bg-indigo-600','text-white') }
  }
  // Un-highlight all other tab-btns (nav items) but keep workforce-btn highlighted
  document.querySelectorAll('.tab-btn').forEach(t => {
    if (t.id !== 'workforce-btn') {
      t.classList.remove('tab-active')
      const ic = t.querySelector('#workforce-icon, span.w-8')
      if (ic && ic.id !== 'workforce-icon') {
        ic.classList.remove('bg-indigo-600','text-white')
      }
    }
  })
  // Show the workers tab panel
  document.querySelectorAll('.tab-content').forEach(t => t.classList.add('hidden'))
  const tabEl = document.getElementById('tab-workers')
  if (tabEl) tabEl.classList.remove('hidden')
  // Highlight selected sub-button
  _highlightWvBtn(view)
  // Update tab title + subtitle
  const titles = { onsite: ['Onsite Now','Workers currently clocked in'], active: ['Active Workers','Currently employed'], all: ['All Workers','Everyone on the team'] }
  const [title, sub] = titles[view] || titles.all
  const titleEl = document.getElementById('workers-tab-title')
  const subEl   = document.getElementById('workers-tab-subtitle')
  if (titleEl) titleEl.textContent = title
  if (subEl)   subEl.textContent   = sub
  // Show/hide filter pills
  const filterBar = document.getElementById('workers-filter-bar')
  if (filterBar) filterBar.classList.toggle('hidden', view === 'onsite')
  // Render
  if (view === 'onsite') {
    renderOnsiteWorkers()
  } else if (view === 'active') {
    setWorkerFilter('active')
  } else {
    setWorkerFilter('all')
  }
  // Close sidebar on mobile
  const sidebar = document.getElementById('admin-sidebar')
  if (sidebar && window.innerWidth < 1024) {
    sidebar.classList.add('-translate-x-full')
    const overlay = document.getElementById('sidebar-overlay')
    if (overlay) overlay.classList.add('hidden')
  }
}

function renderOnsiteWorkers() {
  const tbody   = document.getElementById('workers-tbody')
  const countEl = document.getElementById('workers-count')
  if (!tbody) return
  const onsite = _allWorkersData.filter(w => w.currently_clocked_in > 0)
  if (countEl) countEl.textContent = onsite.length + ' worker' + (onsite.length !== 1 ? 's' : '') + ' onsite'
  if (onsite.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-center py-10 text-gray-400">
      <i class="fas fa-hard-hat text-3xl block mb-2 opacity-30"></i>
      No workers currently onsite
    </td></tr>`
    return
  }
  const savedAll = _allWorkersData
  _allWorkersData = onsite
  _workerFilter = 'all'
  renderWorkersTable()
  _allWorkersData = savedAll
}

function updateOnsiteBadge(count) {
  const badge = document.getElementById('onsite-count-badge')
  if (!badge) return
  if (count > 0) { badge.textContent = count; badge.classList.remove('hidden') }
  else { badge.classList.add('hidden') }
}

// ── Worker filter state ──────────────────────────────────────────────────────
let _workerFilter = 'all'
let _allWorkersData = []

function setWorkerFilter(f) {
  _workerFilter = f
  // Update pill styles
  const filters = ['all','active','on_holiday','sick_leave','suspended','terminated']
  const confMap = { all: { border:'border-indigo-500', bg:'bg-indigo-50', text:'text-indigo-700' }, active: { border:'border-green-500', bg:'bg-green-50', text:'text-green-700' }, on_holiday: { border:'border-blue-500', bg:'bg-blue-50', text:'text-blue-700' }, sick_leave: { border:'border-yellow-500', bg:'bg-yellow-50', text:'text-yellow-700' }, suspended: { border:'border-orange-500', bg:'bg-orange-50', text:'text-orange-700' }, terminated: { border:'border-red-500', bg:'bg-red-50', text:'text-red-700' } }
  filters.forEach(v => {
    const btn = document.getElementById('wf-' + v)
    if (!btn) return
    if (v === f) {
      const c = confMap[v] || confMap.all
      btn.className = `text-xs px-3 py-1.5 rounded-full border-2 ${c.border} ${c.bg} ${c.text} font-semibold transition-all`
    } else {
      btn.className = 'text-xs px-3 py-1.5 rounded-full border-2 border-transparent bg-gray-100 text-gray-600 font-medium hover:border-gray-300 hover:bg-gray-200 transition-all'
    }
  })
  renderWorkersTable()
}

function renderWorkersTable() {
  const tbody = document.getElementById('workers-tbody')
  const countEl = document.getElementById('workers-count')
  if (!tbody) return

  const filtered = _workerFilter === 'all'
    ? _allWorkersData
    : _allWorkersData.filter(w => {
        const ws = w.worker_status || (w.active ? 'active' : 'terminated')
        return ws === _workerFilter
      })

  if (countEl) countEl.textContent = filtered.length + ' worker' + (filtered.length !== 1 ? 's' : '')

  if (filtered.length === 0) {
    const msg = _workerFilter === 'all' ? 'No workers registered' : 'No workers with this status'
    tbody.innerHTML = `<tr><td colspan="8" class="text-center py-10 text-gray-400"><i class="fas fa-users-slash text-3xl block mb-2 opacity-30"></i>${msg}</td></tr>`
    return
  }

  tbody.innerHTML = filtered.map(w => {
    const ws2  = w.worker_status || (w.active ? 'active' : 'terminated')
    const wsC2 = WS_CONFIG[ws2] || WS_CONFIG['active']
    const status = w.currently_clocked_in > 0
      ? '<span class="bg-green-100 text-green-700 text-xs px-2 py-1 rounded-full pulse font-medium flex items-center gap-1 justify-center"><span class="w-1.5 h-1.5 rounded-full bg-green-500 inline-block"></span>Working</span>'
      : `<span class="${wsC2.bg} ${wsC2.text} text-xs px-2 py-1 rounded-full font-medium"><i class="fas ${wsC2.icon} mr-1"></i>${wsC2.label}</span>`

    // Invite link — always active (permanent /join/:id URL)
    const canInvite = ['active','on_holiday','sick_leave'].includes(ws2)
    const linkBadge = canInvite
      ? `<span class="bg-green-50 text-green-600 border border-green-200 text-[10px] px-1.5 py-0.5 rounded-full font-medium whitespace-nowrap"><i class="fas fa-circle" style="font-size:5px"></i> Active</span>`
      : `<span class="bg-gray-100 text-gray-400 border border-gray-200 text-[10px] px-1.5 py-0.5 rounded-full font-medium whitespace-nowrap">Inactive</span>`
    const inviteBtn = canInvite
      ? `<button data-id="${w.id}" data-name="${w.name.replace(/"/g,'&quot;')}" onclick="generateInviteLink(+this.dataset.id, this.dataset.name)" class="text-emerald-600 hover:text-emerald-800 text-xs mr-2" title="Send app link"><i class="fas fa-link"></i></button>`
      : `<span class="text-gray-200 text-xs mr-2 cursor-not-allowed" title="Worker is ${wsC2.label}"><i class="fas fa-link"></i></span>`

    return `<tr class="border-b border-gray-50 hover:bg-indigo-50 cursor-pointer transition-colors" onclick="openWorkerDrawer(${w.id})">
      <td class="py-3 font-medium text-gray-800 pl-1">
        <span class="flex items-center gap-2">
          <span class="w-7 h-7 rounded-full ${wsC2.bg} flex items-center justify-center ${wsC2.text} text-xs font-bold flex-shrink-0">${w.name.charAt(0).toUpperCase()}</span>
          <span class="${ws2 === 'terminated' ? 'line-through text-gray-400' : ''}">${w.name}</span>
        </span>
      </td>
      <td class="py-3 text-gray-500 text-xs">${w.phone}</td>
      <td class="py-3 text-right font-medium text-green-600">$${(w.hourly_rate||0).toFixed(2)}</td>
      <td class="py-3 text-right text-gray-700">${(w.total_hours_all_time||0).toFixed(1)}h</td>
      <td class="py-3 text-right font-bold text-gray-800">$${(w.total_earnings_all_time||0).toFixed(2)}</td>
      <td class="py-3 text-center">${status}</td>
      <td class="py-3 text-center">${linkBadge}</td>
      <td class="py-3 text-right" onclick="event.stopPropagation()">
        ${inviteBtn}
        <button data-id="${w.id}" data-name="${w.name.replace(/"/g,'&quot;')}" data-rate="${w.hourly_rate}" onclick="editWorkerRate(+this.dataset.id, this.dataset.name, +this.dataset.rate)" class="text-indigo-600 hover:text-indigo-800 text-xs mr-2" title="Edit worker"><i class="fas fa-edit"></i></button>
        <button data-id="${w.id}" data-name="${w.name.replace(/"/g,'&quot;')}" onclick="openDeleteWorkerModal(+this.dataset.id, this.dataset.name)" class="text-red-400 hover:text-red-600 text-xs" title="Remove worker"><i class="fas fa-trash"></i></button>
      </td>
    </tr>`
  }).join('')
}

async function loadWorkers() {
  try {
    const res = await fetch('/api/workers')
    const data = await res.json()
    _allWorkersData = data.workers || []

    // Update onsite badge in sidebar
    const onsiteCount = _allWorkersData.filter(w => w.currently_clocked_in > 0).length
    updateOnsiteBadge(onsiteCount)

    // Populate the worker filter dropdown in Sessions tab
    const workerSelect = document.getElementById('filter-worker')
    if (workerSelect) {
      const currentVal = workerSelect.value
      workerSelect.innerHTML = '<option value="">All Workers</option>' +
        _allWorkersData.map(w => `<option value="${w.id}" ${currentVal == w.id ? 'selected' : ''}>${w.name}</option>`).join('')
    }

    renderWorkersTable()
    // If currently showing 'onsite' view, re-render that
    if (_currentWorkersView === 'onsite') renderOnsiteWorkers()
  } catch(e) { console.error(e) }
}

async function loadSessions() {
  try {
    const date = document.getElementById('filter-date').value
    const workerId = document.getElementById('filter-worker').value
    let url = '/api/sessions?limit=200'
    if (date) url += '&date=' + date
    if (workerId) url += '&worker_id=' + workerId

    const res = await fetch(url)
    const data = await res.json()
    allSessionsData = data.sessions || []
    // Deduplicate by session ID (guard against any edge-case double-fetch)
    const seen = new Set()
    allSessionsData = allSessionsData.filter(s => {
      if (seen.has(s.id)) return false
      seen.add(s.id); return true
    })
    // Populate sessionStore for modal lookups
    allSessionsData.forEach(s => { if (s.id) sessionStore[s.id] = s })
    const container = document.getElementById('sessions-by-day')

    if (allSessionsData.length === 0) {
      container.innerHTML = `<div class="text-center py-12 text-gray-400">
        <i class="fas fa-calendar-times text-4xl mb-3 block"></i>
        <p>No sessions found for this filter</p>
      </div>`
      return
    }

    // Group by day
    const groups = {}
    allSessionsData.forEach(s => {
      const key = new Date(s.clock_in_time).toISOString().split('T')[0]
      if (!groups[key]) groups[key] = []
      groups[key].push(s)
    })

    const today = new Date().toISOString().split('T')[0]
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0]

    container.innerHTML = Object.keys(groups).sort((a,b) => b.localeCompare(a)).map(key => {
      const sessions = groups[key]
      const d = new Date(key + 'T12:00:00')
      const dayLabel = key === today ? 'Today'
        : key === yesterday ? 'Yesterday'
        : d.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' })

      const dayHours = sessions.reduce((acc, x) => acc + (x.total_hours || 0), 0)
      const dayEarnings = sessions.reduce((acc, x) => acc + (x.earnings || 0), 0)
      const hasActive = sessions.some(sess => sess.status === 'active')
      const uniqueWorkers = [...new Set(sessions.map(sess => sess.worker_name))].filter(Boolean)

      const sessionsHTML = sessions.map(sess => {
        const clockIn = new Date(sess.clock_in_time).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})
        const clockOut = sess.clock_out_time ? new Date(sess.clock_out_time).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) : null
        const isActive = sess.status === 'active'
        const mapLink = sess.clock_in_lat
          ? `<a href="https://maps.google.com/?q=${sess.clock_in_lat},${sess.clock_in_lng}" target="_blank" class="text-blue-500 hover:text-blue-700 text-xs ml-2"><i class="fas fa-map-marker-alt mr-0.5"></i>Map</a>`
          : ''

        return `<div class="bg-gray-50 rounded-xl p-4 border ${sess.auto_clockout ? 'border-red-100' : 'border-gray-100'} hover:border-indigo-300 hover:shadow-md transition-all cursor-pointer" onclick="openSessionById(${sess.id})">
          <div class="flex items-start justify-between gap-2">
            <div class="flex-1">
              <!-- Worker name + status -->
              <div class="flex items-center gap-2 mb-2">
                <div class="w-7 h-7 bg-indigo-100 rounded-full flex items-center justify-center flex-shrink-0">
                  <span class="text-indigo-600 text-xs font-bold">${(sess.worker_name||'?').charAt(0).toUpperCase()}</span>
                </div>
                <span class="font-bold text-gray-800 text-sm">${sess.worker_name || '–'}</span>
                <span class="text-gray-400 text-xs">${sess.worker_phone || ''}</span>
                ${isActive ? `<span class="bg-green-100 text-green-700 text-xs px-2 py-0.5 rounded-full font-medium pulse ml-auto">● LIVE</span>`
                  : sess.auto_clockout ? (() => {
                      const lbl = autoClockoutLabel(sess)
                      const isGeo = lbl.includes('Geofence')
                      const isEod = lbl.includes('End of Day')
                      const isMax = lbl.includes('Max Shift')
                      const color = isGeo ? 'bg-orange-100 text-orange-700' : isEod ? 'bg-purple-100 text-purple-700' : isMax ? 'bg-blue-100 text-blue-700' : 'bg-red-100 text-red-600'
                      const icon  = isGeo ? 'fa-map-marker-slash' : isEod ? 'fa-moon' : isMax ? 'fa-business-time' : 'fa-stop-circle'
                      return `<span class="${color} text-xs px-2 py-0.5 rounded-full font-medium ml-auto"><i class="fas ${icon} mr-0.5"></i>${lbl.replace('Auto Clock-Out: ','').replace('Admin Clock-Out: ','')}</span>`
                    })() : ''}
              </div>
              <!-- Job location -->
              ${sess.job_location ? `
                <div class="flex items-start gap-1.5 mb-1.5 ml-9">
                  <i class="fas fa-map-marker-alt text-red-500 mt-0.5 text-xs flex-shrink-0"></i>
                  <p class="text-sm font-semibold text-gray-700">${sess.job_location}</p>
                </div>
              ` : ''}
              <!-- Admin clock-out reason — geofence deduction gets special treatment -->
              ${sess.auto_clockout && sess.geofence_exit_time ? `
                <div class="ml-9 mb-2 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2">
                  <p class="text-xs font-semibold text-orange-700 mb-1"><i class="fas fa-map-marker-slash mr-1"></i>Geofence Auto Clock-Out — Deduction Record</p>
                  <div class="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs text-gray-600">
                    <span class="text-gray-400">Left site at:</span>
                    <span class="font-medium text-orange-700">${new Date(sess.geofence_exit_time).toLocaleTimeString('en-CA',{hour:'2-digit',minute:'2-digit',hour12:true})}</span>
                    <span class="text-gray-400">Grace period:</span>
                    <span class="font-medium">${sess.geofence_deduction_min} min</span>
                    <span class="text-gray-400">Clocked out at:</span>
                    <span class="font-medium text-red-600">${sess.clock_out_time ? new Date(sess.clock_out_time).toLocaleTimeString('en-CA',{hour:'2-digit',minute:'2-digit',hour12:true}) : '—'}</span>
                    <span class="text-gray-400">Hours paid:</span>
                    <span class="font-medium text-gray-800">${(sess.total_hours||0).toFixed(2)}h</span>
                  </div>
                </div>` : sess.auto_clockout && cleanReason(sess.auto_clockout_reason) ? `
                <div class="ml-9 mb-1">
                  <span class="text-xs text-red-500 italic"><i class="fas fa-info-circle mr-1"></i>${cleanReason(sess.auto_clockout_reason)}</span>
                </div>` : ''}
              <!-- Time row -->
              <div class="flex items-center gap-3 ml-9 text-xs text-gray-500">
                <span><i class="fas fa-sign-in-alt text-green-500 mr-1"></i>${clockIn}</span>
                <span class="text-gray-300">→</span>
                ${isActive
                  ? `<span class="text-green-600 font-medium">Still working...</span>`
                  : `<span><i class="fas fa-sign-out-alt text-red-400 mr-1"></i>${clockOut}</span>`
                }
                ${mapLink}
              </div>
            </div>
            <!-- Earnings block -->
            <div class="text-right flex-shrink-0">
              ${isActive
                ? `<span class="text-green-500 text-xs font-medium">In progress</span>`
                : `<p class="text-base font-bold text-gray-800">${(sess.total_hours||0).toFixed(2)}h</p>
                   <p class="text-sm font-bold text-green-600">$${(sess.earnings||0).toFixed(2)}</p>`
              }
              <p class="text-xs text-gray-400 mt-1"><i class="fas fa-info-circle"></i></p>
            </div>
          </div>
        </div>`
      }).join('')

      return `<div class="border border-gray-200 rounded-2xl overflow-hidden">
        <!-- Day header -->
        <div class="bg-gray-50 border-b border-gray-200 px-5 py-3 flex items-center justify-between">
          <div>
            <p class="font-bold text-gray-800">${dayLabel}</p>
            <p class="text-xs text-gray-500 mt-0.5">${uniqueWorkers.join(', ')}</p>
          </div>
          <div class="text-right">
            ${hasActive
              ? `<span class="bg-green-100 text-green-700 text-sm px-3 py-1 rounded-full font-medium pulse">Active</span>`
              : `<p class="text-sm font-bold text-gray-700">${dayHours.toFixed(1)}h</p>
                 <p class="text-sm font-bold text-green-600">$${dayEarnings.toFixed(2)}</p>`
            }
          </div>
        </div>
        <!-- Sessions -->
        <div class="p-3 space-y-2">
          ${sessionsHTML}
        </div>
      </div>`
    }).join('')
  } catch(e) { console.error(e) }
}

async function loadMap() {
  const mapEl = document.getElementById('admin-map')
  
  if (!adminMap) {
    adminMap = L.map('admin-map', { attributionControl: false })
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(adminMap)
  } else {
    // Clear all previous markers
    adminMap.eachLayer(layer => {
      if (layer instanceof L.CircleMarker || layer instanceof L.Marker) adminMap.removeLayer(layer)
    })
  }
  // Remove any stale overlay
  document.querySelectorAll('#admin-map > div[style*="pointer-events:none"]').forEach(el => el.remove())

  // Map header — update label
  const mapHeader = document.getElementById('map-live-label')
  if (mapHeader) mapHeader.textContent = 'Live — Currently Onsite'

  try {
    // Only fetch ACTIVE sessions (workers currently clocked in)
    const res = await fetch('/api/sessions/active')
    const data = await res.json()
    
    const sessions = (data.sessions || []).filter(s => s.clock_in_lat && s.clock_in_lng)
    
    if (sessions.length === 0) {
      adminMap.setView([20, 0], 2)
      const overlay = document.createElement('div')
      overlay.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(255,255,255,0.9);padding:12px 20px;border-radius:12px;font-size:13px;color:#6b7280;pointer-events:none;z-index:999;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.1)'
      overlay.innerHTML = '<i class="fas fa-hard-hat" style="color:#9ca3af;margin-right:6px"></i>No workers currently onsite'
      document.getElementById('admin-map').appendChild(overlay)
      return
    }
    
    const bounds = []
    sessions.forEach(s => {
      // All markers are green — map only shows live workers
      const m = L.circleMarker([s.clock_in_lat, s.clock_in_lng], {
        color: '#16a34a', fillColor: '#22c55e', fillOpacity: 0.85, radius: 11, weight: 2
      }).addTo(adminMap)
      const hoursWorked = ((Date.now() - new Date(s.clock_in_time).getTime()) / 3600000).toFixed(1)
      m.bindPopup(`
        <div style="font-family:system-ui;min-width:160px">
          <div style="font-weight:700;font-size:13px;color:#111">${s.worker_name}</div>
          <div style="color:#6b7280;font-size:11px;margin-bottom:4px">${s.worker_phone || ''}</div>
          <div style="font-size:11px;color:#15803d;font-weight:600">🟢 Clocked in ${hoursWorked}h ago</div>
          <div style="font-size:11px;color:#6b7280">In: ${new Date(s.clock_in_time).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</div>
          ${s.job_location ? `<div style="font-size:11px;color:#6b7280;margin-top:2px">📍 ${s.job_location}</div>` : ''}
        </div>
      `)
      bounds.push([s.clock_in_lat, s.clock_in_lng])
    })
    
    if (bounds.length === 1) {
      adminMap.setView(bounds[0], 15)
    } else {
      adminMap.fitBounds(bounds, { padding: [50, 50] })
    }
  } catch(e) { console.error(e) }
}

// ── Workers Management ────────────────────────────────────────────────────────
function showAddWorkerModal() {
  // Reset all fields
  const ids = ['modal-name','modal-phone','modal-email','modal-address','modal-emergency',
                'modal-pin','modal-job-title','modal-start-date','modal-rate','modal-salary',
                'modal-license-num','modal-notes','modal-lic-front-b64','modal-lic-back-b64']
  ids.forEach(id => { const el = document.getElementById(id); if(el) el.value = '' })
  // Reset pay type
  const ptEl = document.getElementById('modal-pay-type')
  if (ptEl) { ptEl.value = 'hourly'; togglePayType() }
  // Reset license previews
  ;['modal-lic-front-preview','modal-lic-back-preview'].forEach((id, i) => {
    const el = document.getElementById(id)
    if (el) el.innerHTML = `<i class="fas fa-camera text-amber-400 text-2xl mb-1"></i><span class="text-xs text-amber-500 font-medium">Tap to upload ${i===0?'front':'back'}</span>`
  })
  document.getElementById('add-worker-modal').classList.remove('hidden')
}
function closeModal() { document.getElementById('add-worker-modal').classList.add('hidden') }

function togglePayType() {
  const t = document.getElementById('modal-pay-type')?.value
  document.getElementById('modal-hourly-block')?.classList.toggle('hidden', t === 'salary')
  document.getElementById('modal-salary-block')?.classList.toggle('hidden', t !== 'salary')
}

function previewLicense(input, previewId, hiddenId) {
  const file = input.files[0]
  if (!file) return
  // Warn if file is very large
  if (file.size > 3 * 1024 * 1024) {
    showAdminToast('Image too large — use under 3MB', 'error')
    return
  }
  const reader = new FileReader()
  reader.onload = e => {
    const b64 = e.target.result  // data:image/...;base64,...
    document.getElementById(hiddenId).value = b64
    const prev = document.getElementById(previewId)
    prev.innerHTML = `<img src="${b64}" class="w-full h-full object-cover rounded-xl"/>`
  }
  reader.readAsDataURL(file)
}

async function addWorker() {
  const rawName = document.getElementById('modal-name').value.trim()
  const name    = rawName.replace(/\b\w/g, c => c.toUpperCase())
  const phone = document.getElementById('modal-phone').value.trim()
  if (!name || !phone) { showAdminToast('Name and phone are required', 'error'); return }

  const payType = document.getElementById('modal-pay-type')?.value || 'hourly'
  const rate    = payType === 'hourly' ? (parseFloat(document.getElementById('modal-rate').value) || 0) : 0
  const salary  = payType === 'salary' ? (parseFloat(document.getElementById('modal-salary').value) || 0) : 0
  const pin     = document.getElementById('modal-pin').value.trim() || '0000'

  const payload = {
    name, phone,
    hourly_rate: rate,
    pin,
    email:                   document.getElementById('modal-email')?.value.trim() || null,
    home_address:            document.getElementById('modal-address')?.value.trim() || null,
    emergency_contact:       document.getElementById('modal-emergency')?.value.trim() || null,
    job_title:               document.getElementById('modal-job-title')?.value.trim() || null,
    start_date:              document.getElementById('modal-start-date')?.value || null,
    pay_type:                payType,
    salary_amount:           salary,
    drivers_license_number:  document.getElementById('modal-license-num')?.value.trim() || null,
    license_front_b64:       document.getElementById('modal-lic-front-b64')?.value || null,
    license_back_b64:        document.getElementById('modal-lic-back-b64')?.value || null,
    worker_notes:            document.getElementById('modal-notes')?.value.trim() || null,
  }

  try {
    // 1. Register (creates worker record with name + phone)
    const res = await fetch('/api/workers/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, phone, hourly_rate: rate, pin })
    })
    const data = await res.json()
    if (!data.worker) { showAdminToast(data.error || 'Could not add worker', 'error'); return }

    // 2. Update with full profile data
    await fetch('/api/workers/' + data.worker.id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, role: 'worker', active: 1 })
    })

    closeModal()
    showAdminToast('✅ ' + name + ' added successfully!', 'success')
    await loadWorkers()
  } catch(e) { showAdminToast('Error adding worker', 'error'); console.error(e) }
}

async function editWorkerRate(id, name, currentRate) {
  const newRate = prompt(`Update hourly rate for ${name} (current: $${currentRate}/hr):`, currentRate)
  if (newRate === null) return
  const rate = parseFloat(newRate)
  if (isNaN(rate)) { showAdminToast('Invalid rate', 'error'); return }
  
  try {
    await fetch('/api/workers/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, hourly_rate: rate, role: 'worker', active: 1 })
    })
    showAdminToast('Rate updated to $' + rate + '/hr', 'success')
    await loadWorkers()
  } catch(e) { showAdminToast('Error updating rate', 'error') }
}

// ── Delete Worker Modal ───────────────────────────────────────────────────────
let _pendingDeleteWorkerId   = null
let _pendingDeleteWorkerName = ''

function openDeleteWorkerModal(id, name) {
  _pendingDeleteWorkerId   = id
  _pendingDeleteWorkerName = name
  const nameEl = document.getElementById('dw-worker-name')
  if (nameEl) nameEl.textContent = name
  document.getElementById('delete-worker-modal').classList.remove('hidden')
  document.body.style.overflow = 'hidden'
}

function closeDeleteWorkerModal() {
  document.getElementById('delete-worker-modal').classList.add('hidden')
  document.body.style.overflow = ''
  _pendingDeleteWorkerId   = null
  _pendingDeleteWorkerName = ''
}

async function confirmDeleteWorker() {
  if (!_pendingDeleteWorkerId) return
  const btn = document.getElementById('dw-confirm-btn')
  btn.disabled = true
  btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1.5"></i>Deleting...'
  try {
    const res  = await fetch('/api/workers/' + _pendingDeleteWorkerId, { method: 'DELETE' })
    const data = await res.json().catch(() => ({}))
    if (res.ok) {
      closeDeleteWorkerModal()
      showAdminToast(_pendingDeleteWorkerName + ' removed permanently', 'success')
      await loadWorkers()
    } else {
      showAdminToast(data.error || 'Could not delete — they may have active sessions', 'error')
    }
  } catch(e) {
    showAdminToast('Connection error', 'error')
  } finally {
    btn.disabled = false
    btn.innerHTML = '<i class="fas fa-trash mr-1.5"></i>Delete Permanently'
  }
}

// ── Invite Link Management ────────────────────────────────────────────────────
// Opens invite modal with the permanent /join/:id link — no codes involved
async function generateInviteLink(id, name) {
  try {
    const res  = await fetch('/api/workers/' + id + '/invite')
    const data = await res.json()
    if (data.error) { showAdminToast('Error: ' + data.error, 'error'); return }

    const link        = data.join_link || ('https://app.clockinproof.com/join/' + id)
    const workerPhone = data.worker_phone || '?'

    const existing = document.getElementById('invite-modal')
    if (existing) existing.remove()

    const modal = document.createElement('div')
    modal.id = 'invite-modal'
    modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4'
    modal.style.background = 'rgba(0,0,0,0.55)'
    modal.innerHTML = `
      <div class="bg-white rounded-2xl shadow-2xl max-w-sm w-full p-6 slide-up">

        <!-- Header -->
        <div class="flex items-center gap-3 mb-4">
          <div class="w-11 h-11 bg-green-100 rounded-xl flex items-center justify-center flex-shrink-0">
            <i class="fas fa-link text-green-600 text-lg"></i>
          </div>
          <div class="flex-1 min-w-0">
            <h3 class="font-bold text-gray-800 text-base">${name} — App Link</h3>
            <p class="text-xs text-gray-400">${workerPhone}</p>
          </div>
          <span class="bg-green-100 text-green-700 text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 flex items-center gap-1">
            <span class="w-1.5 h-1.5 rounded-full bg-green-500 inline-block"></span>Always Active
          </span>
        </div>

        <!-- Info notice -->
        <div class="bg-blue-50 border border-blue-200 rounded-xl p-3 mb-4 flex items-start gap-2">
          <i class="fas fa-info-circle text-blue-500 mt-0.5 flex-shrink-0"></i>
          <p class="text-xs text-blue-700 leading-relaxed">This link works forever. Send it once — the worker taps it to open the app anytime.</p>
        </div>

        <!-- Link display -->
        <div class="bg-gray-50 border border-gray-200 rounded-xl p-3 mb-4">
          <p class="text-xs font-semibold text-gray-500 mb-1">Worker App Link</p>
          <p class="text-xs text-gray-700 break-all font-mono">${link}</p>
        </div>

        <!-- SMS status area -->
        <div id="invite-sms-status" class="hidden mb-3 p-3 rounded-xl text-sm font-medium"></div>

        <div class="space-y-2">
          <button id="invite-twilio-btn"
            onclick="sendInviteViaTwilio(${id}, '${name}')"
            class="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-3 rounded-xl text-sm flex items-center justify-center gap-2 transition-colors">
            <i class="fas fa-paper-plane"></i> Send SMS to ${workerPhone}
          </button>
          <button onclick="navigator.clipboard.writeText('${link}').then(()=>showAdminToast('Link copied!','success'))"
            class="w-full bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 font-semibold py-2.5 rounded-xl text-sm transition-colors">
            <i class="fas fa-copy mr-2"></i>Copy Link
          </button>
          <button onclick="(()=>{ const txt=encodeURIComponent('Hi ${name}! Tap this link to open your ClockInProof app:\\n${link}'); window.open('sms:${workerPhone}?body='+txt,'_blank') })()"
            class="w-full text-gray-500 hover:text-gray-700 py-2 text-xs font-medium border border-gray-200 rounded-xl transition-colors">
            <i class="fas fa-mobile-alt mr-1"></i>Open Native SMS App (mobile only)
          </button>
          <button onclick="document.getElementById('invite-modal').remove()"
            class="w-full text-gray-400 hover:text-gray-600 py-1.5 text-xs font-medium">
            Close
          </button>
        </div>
      </div>
    `
    document.body.appendChild(modal)
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove() })

  } catch(e) { showAdminToast('Error loading invite link', 'error') }
}

async function sendInviteViaTwilio(workerId, workerName) {
  const btn    = document.getElementById('invite-twilio-btn')
  const status = document.getElementById('invite-sms-status')

  btn.disabled = true
  btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Sending...'

  try {
    const res  = await fetch('/api/workers/' + workerId + '/invite/send-sms', { method: 'POST' })
    const data = await res.json()

    if (data.success) {
      status.className = 'mb-3 p-3 rounded-xl text-sm font-medium bg-green-50 border border-green-200 text-green-700'
      status.innerHTML = `<i class="fas fa-check-circle mr-2"></i>SMS sent to ${data.sent_to}!`
      status.classList.remove('hidden')
      btn.innerHTML = '<i class="fas fa-check mr-2"></i>SMS Sent!'
      btn.className = 'w-full bg-gray-200 text-gray-500 font-bold py-3 rounded-xl text-sm flex items-center justify-center gap-2 cursor-default'
      showAdminToast('✅ App link sent to ' + workerName, 'success')
    } else {
      let errMsg = data.error || 'SMS failed'
      if (data.twilio_code === 21211) errMsg = 'Invalid phone number format'
      else if (data.twilio_code === 21265) errMsg = 'Phone needs country code — save as +1XXXXXXXXXX'
      else if (data.twilio_code === 21608) errMsg = 'Unverified number on Twilio trial — verify at twilio.com or upgrade account'
      else if (data.twilio_code === 21219) errMsg = 'Phone not verified — upgrade Twilio or verify the number'
      else if (data.twilio_code === 20003) errMsg = 'Twilio auth failed — check Account SID & Auth Token in Settings'
      else if (data.twilio_missing)        errMsg = 'Twilio not set up — add credentials in Settings → Notifications'

      status.className = 'mb-3 p-3 rounded-xl text-sm font-medium bg-red-50 border border-red-200 text-red-700'
      status.innerHTML = `<i class="fas fa-exclamation-triangle mr-2"></i>${errMsg}`
      status.classList.remove('hidden')
      btn.disabled = false
      btn.innerHTML = '<i class="fas fa-redo mr-2"></i>Retry SMS'
    }
  } catch(e) {
    status.className = 'mb-3 p-3 rounded-xl text-sm font-medium bg-red-50 border border-red-200 text-red-700'
    status.innerHTML = '<i class="fas fa-times-circle mr-2"></i>Network error — check your connection'
    status.classList.remove('hidden')
    btn.disabled = false
    btn.innerHTML = '<i class="fas fa-paper-plane mr-2"></i>Retry SMS'
  }
}
// ── Export CSV ────────────────────────────────────────────────────────────────
function exportCSV() {
  if (!allSessionsData.length) { showAdminToast('No data to export', 'error'); return }
  const headers = ['Worker', 'Phone', 'Date', 'Clock In', 'Clock Out', 'Hours', 'Earnings', 'Location', 'Status']
  const rows = allSessionsData.map(s => [
    s.worker_name || '',
    s.worker_phone || '',
    new Date(s.clock_in_time).toLocaleDateString(),
    new Date(s.clock_in_time).toLocaleTimeString(),
    s.clock_out_time ? new Date(s.clock_out_time).toLocaleTimeString() : '',
    (s.total_hours || 0).toFixed(2),
    (s.earnings || 0).toFixed(2),
    s.clock_in_lat ? `${s.clock_in_lat},${s.clock_in_lng}` : '',
    s.status
  ])
  const csv = [headers, ...rows].map(r => r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = 'clockinproof-export-' + new Date().toISOString().split('T')[0] + '.csv'
  a.click()
  showAdminToast('CSV exported!', 'success')
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
function showTab(name) {
  // Destroy admin map when leaving the map tab to prevent sticky Leaflet
  if (name !== 'map' && adminMap) {
    adminMap.remove()
    adminMap = null
  }

  // Close workforce submenu if navigating away from workers
  if (name !== 'workers') {
    _workforceOpen = false
    const menu    = document.getElementById('workers-submenu')
    const chevron = document.getElementById('workforce-chevron')
    const btn     = document.getElementById('workforce-btn')
    const icon    = document.getElementById('workforce-icon')
    if (menu) menu.classList.add('hidden')
    if (chevron) chevron.style.transform = ''
    if (btn) { btn.classList.remove('bg-indigo-50','text-indigo-700','tab-active'); btn.classList.add('text-gray-600') }
    if (icon) { icon.classList.add('bg-blue-100','text-blue-600'); icon.classList.remove('bg-indigo-600','text-white') }
  }

  document.querySelectorAll('.tab-content').forEach(t => t.classList.add('hidden'))
  document.querySelectorAll('.tab-btn').forEach(t => {
    if (t.id === 'workforce-btn') return  // workforce manages its own highlight
    t.classList.remove('tab-active')
    const icon = t.querySelector('span.w-8')
    if (icon) {
      icon.classList.remove('bg-indigo-600','text-white')
    }
  })
  const tabEl = document.getElementById('tab-' + name)
  if (tabEl) tabEl.classList.remove('hidden')
  const btnEl = document.querySelector('[data-tab="' + name + '"]:not(#workforce-btn)')
  if (btnEl) btnEl.classList.add('tab-active')
  if (name === 'map') { loadMap(); setTimeout(() => { if (adminMap) adminMap.invalidateSize() }, 200) }
  if (name === 'calendar') loadCalendar()
  if (name === 'settings') loadSettings()
  if (name === 'export') initExportTab()
  if (name === 'overrides') loadOverrides()
  if (name === 'payroll') loadPayrollTab()
  if (name === 'accountant') { initAcctTab(); initQbTab() }
  if (name === 'quickbooks') initQbTabFull()
  if (name === 'job-sites') loadJobSites()
  if (name === 'disputes') loadDisputes()
  // Close sidebar on mobile after navigation
  const sidebar = document.getElementById('admin-sidebar')
  if (sidebar && window.innerWidth < 1024) {
    sidebar.classList.add('-translate-x-full')
    const overlay = document.getElementById('sidebar-overlay')
    if (overlay) overlay.classList.add('hidden')
  }
}

function toggleSidebar() {
  const sidebar = document.getElementById('admin-sidebar')
  const overlay = document.getElementById('sidebar-overlay')
  if (!sidebar) return
  if (sidebar.classList.contains('-translate-x-full')) {
    sidebar.classList.remove('-translate-x-full')
    if (overlay) overlay.classList.remove('hidden')
  } else {
    sidebar.classList.add('-translate-x-full')
    if (overlay) overlay.classList.add('hidden')
  }
}

function changePeriod(period) {
  currentPeriod = period
  // Sync navbar select
  const sel = document.getElementById('period-select')
  if (sel) sel.value = period
  // Sync sidebar footer period buttons
  document.querySelectorAll('.period-btn').forEach(b => {
    const active = b.dataset.period === period
    b.className = active
      ? 'period-btn flex-1 py-1.5 text-xs rounded-lg bg-indigo-600 text-white font-medium'
      : 'period-btn flex-1 py-1.5 text-xs rounded-lg bg-white border text-gray-600 font-medium'
  })
  loadStats()
}

// ── Calendar ──────────────────────────────────────────────────────────────────
let calYear = new Date().getFullYear()
let calMonth = new Date().getMonth() + 1  // 1-based
let calHolidays = []
let calSchedule = {}
let calCurrentData = {}  // stored for day modal drill-down

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']

function calPrevMonth() { calMonth--; if (calMonth < 1) { calMonth = 12; calYear-- } loadCalendar() }
function calNextMonth() { calMonth++; if (calMonth > 12) { calMonth = 1; calYear++ } loadCalendar() }
function calGoToday()   { calYear = new Date().getFullYear(); calMonth = new Date().getMonth() + 1; loadCalendar() }

async function loadCalendar() {
  document.getElementById('cal-month-label').textContent = MONTH_NAMES[calMonth - 1] + ' ' + calYear

  // Populate worker filter if empty
  const wSel = document.getElementById('cal-worker-filter')
  if (wSel && wSel.options.length <= 1) {
    try {
      const wr = await fetch('/api/workers')
      const wd = await wr.json()
      if (wd.workers) {
        wd.workers.forEach(w => {
          const opt = document.createElement('option')
          opt.value = w.id; opt.textContent = w.name
          wSel.appendChild(opt)
        })
      }
    } catch(e) {}
  }

  const workerId = document.getElementById('cal-worker-filter').value

  try {
    // Fetch calendar data + holidays in parallel
    const [calRes, holRes] = await Promise.all([
      fetch(`/api/calendar/${calYear}/${calMonth}${workerId ? '?worker_id=' + workerId : ''}`),
      fetch(`/api/holidays/${calYear}`)
    ])
    const calData = await calRes.json()
    const holData = await holRes.json()

    calSchedule = calData.settings || {}
    calHolidays = holData.holidays || []
    calCurrentData = calData  // save for day modal

    renderCalendar(calData)
    renderCalendarSummary(calData)
    renderHolidayList(calData)
  } catch(e) { console.error('Calendar error:', e) }
}

function renderCalendar(calData) {
  const sessionsByDate = calData.sessions_by_date || {}
  const workDays = (calData.settings?.work_days || [1,2,3,4,5])
  const today = new Date().toISOString().split('T')[0]

  // Get holiday dates as a set for fast lookup
  const holidayMap = {}
  calHolidays.forEach(h => { holidayMap[h.date] = h })

  // Build grid: first day of month
  const firstDay = new Date(calYear, calMonth - 1, 1).getDay()  // 0=Sun
  const daysInMonth = new Date(calYear, calMonth, 0).getDate()

  const container = document.getElementById('cal-days')
  let html = ''

  // Empty cells before first day
  for (let i = 0; i < firstDay; i++) {
    html += `<div class="min-h-[80px] rounded-xl bg-gray-50 opacity-40"></div>`
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${calYear}-${String(calMonth).padStart(2,'0')}-${String(d).padStart(2,'0')}`
    const dow = new Date(calYear, calMonth - 1, d).getDay()
    const isWeekend = !workDays.includes(dow)
    const isToday = dateStr === today
    const isHoliday = !!holidayMap[dateStr]
    const sessions = sessionsByDate[dateStr] || []
    const hasSessions = sessions.length > 0
    const totalHours = sessions.reduce((s, x) => s + (x.total_hours || 0), 0)
    const totalEarnings = sessions.reduce((s, x) => s + (x.earnings || 0), 0)
    const hasActive = sessions.some(s => s.status === 'active')

    let cellClass = 'min-h-[80px] rounded-xl p-2 border text-xs transition-all hover:shadow-sm '
    if (isToday)          cellClass += 'bg-yellow-50 border-yellow-400 ring-2 ring-yellow-300 '
    else if (isHoliday)   cellClass += 'bg-red-50 border-red-300 '
    else if (isWeekend)   cellClass += 'bg-gray-100 border-gray-200 '
    else if (hasSessions) cellClass += 'bg-green-50 border-green-300 '
    else                  cellClass += 'bg-blue-50 border-blue-100 '

    // Add clickable style if has sessions
    const clickAttr = hasSessions
      ? `onclick="openDayModal('${dateStr}')" style="cursor:pointer" class="${cellClass} hover:ring-2 hover:ring-indigo-300"`
      : `class="${cellClass} cursor-default"`

    const holiday = holidayMap[dateStr]

    html += `<div ${clickAttr}>
      <div class="flex items-start justify-between mb-1">
        <span class="font-bold text-sm ${isToday ? 'text-yellow-700' : isHoliday ? 'text-red-700' : isWeekend ? 'text-gray-400' : 'text-gray-700'}">${d}</span>
        ${isHoliday ? `<span class="text-red-500" title="${holiday.name}"><i class="fas fa-star" style="font-size:9px"></i></span>` : ''}
        ${hasActive ? `<span class="text-green-500 pulse"><i class="fas fa-circle" style="font-size:7px"></i></span>` : ''}
      </div>
      ${holiday ? `<p class="text-red-600 leading-tight mb-1" style="font-size:9px">${holiday.name.substring(0,18)}</p>` : ''}
      ${hasSessions ? `
        <div class="bg-white bg-opacity-70 rounded-lg px-1.5 py-1 mt-1">
          <p class="font-bold text-green-700">${totalHours.toFixed(1)}h</p>
          <p class="text-green-600">$${totalEarnings.toFixed(0)}</p>
          <p class="text-gray-400">${sessions.length} shift${sessions.length > 1 ? 's' : ''}</p>
        </div>
      ` : isWeekend ? `<p style="font-size:9px" class="text-gray-400 mt-1">Off</p>`
         : isHoliday ? `<p style="font-size:9px" class="text-red-400 mt-1">Stat Holiday</p>`
         : `<p style="font-size:9px" class="text-gray-300 mt-1">No shift</p>`}
    </div>`
  }

  container.innerHTML = html
}

function renderCalendarSummary(calData) {
  const sessionsByDate = calData.sessions_by_date || {}
  const workDays = calData.settings?.work_days || [1,2,3,4,5]
  const paidHours = calData.settings?.paid_hours_per_day || 7.5
  const daysInMonth = new Date(calYear, calMonth, 0).getDate()

  // Count workdays, holidays in month
  const holidayDates = new Set(calHolidays.map(h => h.date))
  let workdayCount = 0
  let statDayCount = 0
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${calYear}-${String(calMonth).padStart(2,'0')}-${String(d).padStart(2,'0')}`
    const dow = new Date(calYear, calMonth - 1, d).getDay()
    if (workDays.includes(dow)) {
      if (holidayDates.has(dateStr)) statDayCount++
      else workdayCount++
    }
  }

  let totalHours = 0, totalEarnings = 0, daysWorked = 0
  Object.values(sessionsByDate).forEach((sessions) => {
    const dayH = sessions.reduce((s, x) => s + (x.total_hours || 0), 0)
    const dayE = sessions.reduce((s, x) => s + (x.earnings || 0), 0)
    totalHours += dayH; totalEarnings += dayE; daysWorked++
  })

  const expectedHours = workdayCount * paidHours
  const coverage = expectedHours > 0 ? Math.min(100, Math.round((totalHours / expectedHours) * 100)) : 0

  document.getElementById('cal-summary').innerHTML = `
    <div class="bg-blue-50 rounded-xl p-3 text-center">
      <p class="text-2xl font-bold text-blue-700">${workdayCount}</p>
      <p class="text-xs text-blue-500 mt-0.5">Workdays</p>
    </div>
    <div class="bg-red-50 rounded-xl p-3 text-center">
      <p class="text-2xl font-bold text-red-600">${statDayCount}</p>
      <p class="text-xs text-red-500 mt-0.5">Stat Holidays</p>
    </div>
    <div class="bg-green-50 rounded-xl p-3 text-center">
      <p class="text-2xl font-bold text-green-700">${totalHours.toFixed(1)}h</p>
      <p class="text-xs text-green-500 mt-0.5">Hrs Worked (${daysWorked} days)</p>
    </div>
    <div class="bg-purple-50 rounded-xl p-3 text-center">
      <p class="text-2xl font-bold text-purple-700">$${totalEarnings.toFixed(0)}</p>
      <p class="text-xs text-purple-500 mt-0.5">Total Earned</p>
    </div>
  `
}

function renderHolidayList(calData) {
  const provinceHols = calHolidays.filter(h => {
    const d = new Date(h.date)
    return d.getFullYear() === calYear && d.getMonth() + 1 === calMonth
  })

  if (provinceHols.length === 0) {
    document.getElementById('cal-holidays').innerHTML = ''
    return
  }

  const html = `<div class="mt-2 border border-gray-200 rounded-2xl overflow-hidden">
    <div class="bg-red-50 border-b border-red-100 px-4 py-2.5 flex items-center gap-2">
      <i class="fas fa-star text-red-500 text-xs"></i>
      <h4 class="font-bold text-red-700 text-sm">Statutory Holidays in ${MONTH_NAMES[calMonth-1]}</h4>
    </div>
    <div class="divide-y divide-gray-100">
      ${provinceHols.map(h => `
        <div class="px-4 py-3 flex items-center justify-between">
          <div>
            <p class="font-medium text-gray-800 text-sm">${h.name}</p>
            <p class="text-xs text-gray-500">${new Date(h.date + 'T12:00:00').toLocaleDateString('en-US',{weekday:'long', month:'short', day:'numeric'})}</p>
          </div>
          <span class="bg-amber-100 text-amber-700 text-xs px-2.5 py-1 rounded-full font-semibold">
            ${h.stat_multiplier || 1.5}× pay
          </span>
        </div>
      `).join('')}
    </div>
  </div>`

  document.getElementById('cal-holidays').innerHTML = html
}

// ── Settings ──────────────────────────────────────────────────────────────────
const PROVINCE_DATA = {
  'CA': [
    {code:'ON', name:'Ontario'}, {code:'BC', name:'British Columbia'},
    {code:'AB', name:'Alberta'}, {code:'QC', name:'Quebec'},
    {code:'MB', name:'Manitoba'}, {code:'SK', name:'Saskatchewan'},
    {code:'NS', name:'Nova Scotia'}, {code:'NB', name:'New Brunswick'},
    {code:'PE', name:'Prince Edward Island'}, {code:'NL', name:'Newfoundland & Labrador'},
    {code:'NT', name:'Northwest Territories'}, {code:'YT', name:'Yukon'},
    {code:'NU', name:'Nunavut'}
  ],
  'US': [
    {code:'CA', name:'California'}, {code:'NY', name:'New York'},
    {code:'TX', name:'Texas'}, {code:'FL', name:'Florida'},
    {code:'WA', name:'Washington'}, {code:'OR', name:'Oregon'},
    {code:'MA', name:'Massachusetts'}, {code:'IL', name:'Illinois'},
    {code:'CO', name:'Colorado'}, {code:'AZ', name:'Arizona'},
    {code:'GA', name:'Georgia'}, {code:'NC', name:'North Carolina'}
  ],
  'AU': [
    {code:'NSW', name:'New South Wales'}, {code:'VIC', name:'Victoria'},
    {code:'QLD', name:'Queensland'}, {code:'WA', name:'Western Australia'},
    {code:'SA', name:'South Australia'}, {code:'TAS', name:'Tasmania'},
    {code:'ACT', name:'Australian Capital Territory'}, {code:'NT', name:'Northern Territory'}
  ],
  'GB': [ {code:'ENG', name:'England'}, {code:'WLS', name:'Wales'}, {code:'SCT', name:'Scotland'}, {code:'NIR', name:'Northern Ireland'} ],
  'NZ': [ {code:'NZ', name:'New Zealand'} ],
  'DE': [ {code:'DE', name:'Germany'} ],
  'FR': [ {code:'FR', name:'France'} ]
}

const STAT_MULTIPLIERS = {
  'CA-ON':1.5,'CA-BC':1.5,'CA-AB':1.5,'CA-QC':1.0,'CA-MB':1.5,'CA-SK':1.5,
  'CA-NS':1.5,'CA-NB':1.5,'CA-PE':1.5,'CA-NL':2.0,'CA-NT':1.5,'CA-YT':1.5,'CA-NU':1.5,
  'US-CA':1.5,'US-NY':1.5,'US-TX':1.5,'US-FL':1.5,'US-WA':1.5,'US-OR':1.5,
  'US-MA':1.5,'US-IL':1.5,'AU-NSW':2.0,'AU-VIC':2.0,'AU-QLD':2.0,'GB-ENG':1.0
}

const STAT_PAY_NOTES = {
  'CA-ON': 'Ontario: 1.5x for working on stat holidays + regular pay for the day off.',
  'CA-BC': 'BC: Must receive regular day pay for stat; 1.5x if working on the holiday.',
  'CA-AB': 'Alberta: General holidays — regular pay off or 1.5x if working.',
  'CA-QC': 'Quebec: Regular pay for the stat day; no premium for working (unless collective agreement).',
  'CA-MB': 'Manitoba: 1.5x for working on a general holiday.',
  'CA-SK': 'Saskatchewan: 1.5x for working on statutory holidays.',
  'CA-NL': 'Newfoundland: 2x pay for working on public holidays.',
  'US-CA': 'California: No state mandate; federal FLSA has no holiday premium. Industry standard 1.5x.',
  'US-NY': 'New York: No state mandate for holiday premium pay. 1.5x is common practice.',
  'US-TX': 'Texas: Follows federal FLSA — no holiday pay mandate. 1.5x by employer policy.',
  'AU-NSW': 'NSW: Double time for working on public holidays (penalty rates).',
  'AU-VIC': 'Victoria: Double time for public holiday work.',
  'GB-ENG': 'England: No legal right to extra pay on bank holidays (contract dependent).'
}

let currentSettings = {}
let activeDays = [1,2,3,4,5]

async function loadSettings() {
  try {
    const res = await fetch('/api/settings')
    const data = await res.json()
    currentSettings = data.settings || {}

    document.getElementById('s-app-name').value = currentSettings.app_name || 'ClockInProof'
    document.getElementById('s-hourly-rate').value = currentSettings.default_hourly_rate || '15.00'
    document.getElementById('s-admin-pin').value = currentSettings.admin_pin || '1234'
    document.getElementById('s-admin-email').value = currentSettings.admin_email || ''
    document.getElementById('s-city').value = currentSettings.city || ''
    document.getElementById('s-work-start').value = currentSettings.work_start || '08:00'
    document.getElementById('s-work-end').value = currentSettings.work_end || '16:00'
    document.getElementById('s-break-morning').value = currentSettings.break_morning_min || '15'
    document.getElementById('s-break-lunch').value = currentSettings.break_lunch_min || '30'
    document.getElementById('s-break-afternoon').value = currentSettings.break_afternoon_min || '15'
    document.getElementById('s-paid-hours').value = currentSettings.paid_hours_per_day || '7.5'
    document.getElementById('s-stat-multiplier').value = currentSettings.stat_pay_multiplier || '1.5'

    // GPS Fraud Prevention
    const fraudCheck = document.getElementById('s-gps-fraud-check')
    if (fraudCheck) fraudCheck.checked = currentSettings.gps_fraud_check !== '0'
    const geofenceEl = document.getElementById('s-geofence-radius')
    if (geofenceEl) geofenceEl.value = currentSettings.geofence_radius_meters || '300'

    // Shift Guardrails
    const autoClockoutEl = document.getElementById('s-auto-clockout')
    if (autoClockoutEl) autoClockoutEl.checked = currentSettings.auto_clockout_enabled !== '0'
    const maxShiftEl = document.getElementById('s-max-shift-hours')
    if (maxShiftEl) maxShiftEl.value = currentSettings.max_shift_hours || '10'
    const awayWarnEl = document.getElementById('s-away-warning-min')
    if (awayWarnEl) awayWarnEl.value = currentSettings.away_warning_min || '30'
    const geofenceExitEl = document.getElementById('s-geofence-exit-min')
    if (geofenceExitEl) geofenceExitEl.value = currentSettings.geofence_exit_clockout_min || '0'

    // Notification settings
    const notifyEmailEl = document.getElementById('s-notify-email')
    if (notifyEmailEl) notifyEmailEl.checked = currentSettings.notify_email !== '0'
    const notifySmsEl = document.getElementById('s-notify-sms')
    if (notifySmsEl) notifySmsEl.checked = currentSettings.notify_sms === '1'
    const adminPhoneEl = document.getElementById('s-admin-phone')
    if (adminPhoneEl) adminPhoneEl.value = currentSettings.admin_phone || ''
    const twilioSidEl = document.getElementById('s-twilio-sid')
    if (twilioSidEl) twilioSidEl.value = currentSettings.twilio_account_sid || ''
    const twilioTokenEl = document.getElementById('s-twilio-token')
    if (twilioTokenEl) twilioTokenEl.value = currentSettings.twilio_auth_token || ''
    const twilioFromEl = document.getElementById('s-twilio-from')
    if (twilioFromEl) twilioFromEl.value = currentSettings.twilio_from_number || ''
    const appHostEl = document.getElementById('s-app-host')
    if (appHostEl) appHostEl.value = currentSettings.app_host || ''
    const adminHostEl = document.getElementById('s-admin-host')
    if (adminHostEl) adminHostEl.value = currentSettings.admin_host || ''

    // Country dropdown
    const country = currentSettings.country_code || 'CA'
    document.getElementById('s-country').value = country
    updateProvinceList(currentSettings.province_code)

    // Timezone
    const tzSel = document.getElementById('s-timezone')
    if (tzSel) tzSel.value = currentSettings.timezone || 'America/Toronto'

    // Pay Period
    const payFreqEl = document.getElementById('s-pay-frequency')
    if (payFreqEl) payFreqEl.value = currentSettings.pay_frequency || 'biweekly'
    const payAnchorEl = document.getElementById('s-pay-anchor')
    if (payAnchorEl) payAnchorEl.value = currentSettings.pay_period_anchor || '2026-03-06'
    const showPayEl = document.getElementById('s-show-pay-workers')
    if (showPayEl) showPayEl.checked = currentSettings.show_pay_to_workers !== '0'
    // Accountant / QB
    const acctEmailEl = document.getElementById('s-accountant-email')
    if (acctEmailEl) acctEmailEl.value = currentSettings.accountant_email || ''
    const companyNameEl = document.getElementById('s-company-name')
    if (companyNameEl) companyNameEl.value = currentSettings.company_name || currentSettings.app_name || ''
    // QB OAuth credentials
    const qbClientIdEl = document.getElementById('s-qb-client-id')
    if (qbClientIdEl) qbClientIdEl.value = currentSettings.qb_client_id || ''
    const qbClientSecretEl = document.getElementById('s-qb-client-secret')
    if (qbClientSecretEl && currentSettings.qb_client_secret) qbClientSecretEl.placeholder = '••••••• (saved)'
    const qbEnvEl = document.getElementById('s-qb-environment')
    if (qbEnvEl) qbEnvEl.value = currentSettings.qb_environment || 'production'
    // Show redirect URI
    const adminHost = window.location.origin
    const redirectUriEl = document.getElementById('qb-redirect-uri-display')
    if (redirectUriEl) redirectUriEl.textContent = `${adminHost}/api/qb/callback`
    // Update QB status badges in settings tab
    updateQbSettingsStatus()

    // Work days
    activeDays = (currentSettings.work_days || '1,2,3,4,5').split(',').map(Number)
    document.querySelectorAll('.work-day-btn').forEach(btn => {
      const day = parseInt(btn.dataset.day)
      if (activeDays.includes(day)) {
        btn.className = 'work-day-btn px-3 py-2 text-xs rounded-xl border font-medium bg-indigo-600 text-white'
      } else {
        btn.className = 'work-day-btn px-3 py-2 text-xs rounded-xl border font-medium bg-gray-100 text-gray-500 hover:bg-indigo-50'
      }
    })

    updateStatPayInfo(country, currentSettings.province_code || 'ON')
  } catch(e) { console.error(e) }
}

function updateProvinceList(selectedProvince = null) {
  const country = document.getElementById('s-country').value
  const provSel = document.getElementById('s-province')
  const provinces = PROVINCE_DATA[country] || []
  provSel.innerHTML = provinces.map(p =>
    `<option value="${p.code}" ${(selectedProvince || currentSettings.province_code) === p.code ? 'selected' : ''}>${p.name}</option>`
  ).join('')
  // Auto-update stat multiplier when province changes
  const pcode = provSel.value
  const key = country + '-' + pcode
  const mult = STAT_MULTIPLIERS[key] || 1.5
  document.getElementById('s-stat-multiplier').value = mult
  updateStatPayInfo(country, pcode)
}

function updateStatPayInfo(country, province) {
  const key = country + '-' + province
  const note = STAT_PAY_NOTES[key] || `Standard stat pay: ${STAT_MULTIPLIERS[key] || 1.5}× for working on statutory holidays.`
  const mult = STAT_MULTIPLIERS[key] || 1.5
  document.getElementById('stat-pay-info').innerHTML = `
    <p><strong>Jurisdiction:</strong> ${key}</p>
    <p><strong>Rate:</strong> ${mult}× pay on statutory holidays</p>
    <p class="mt-1 italic">${note}</p>
  `
}

function toggleDay(day) {
  const idx = activeDays.indexOf(day)
  if (idx >= 0) activeDays.splice(idx, 1)
  else activeDays.push(day)
  activeDays.sort()
  document.querySelectorAll('.work-day-btn').forEach(btn => {
    const d = parseInt(btn.dataset.day)
    if (activeDays.includes(d)) {
      btn.className = 'work-day-btn px-3 py-2 text-xs rounded-xl border font-medium bg-indigo-600 text-white'
    } else {
      btn.className = 'work-day-btn px-3 py-2 text-xs rounded-xl border font-medium bg-gray-100 text-gray-500 hover:bg-indigo-50'
    }
  })
}

async function saveSettings() {
  const country = document.getElementById('s-country').value
  const province = document.getElementById('s-province').value
  const key = country + '-' + province
  const mult = document.getElementById('s-stat-multiplier').value

  const payload = {
    app_name: document.getElementById('s-app-name').value.trim(),
    default_hourly_rate: document.getElementById('s-hourly-rate').value,
    admin_pin: document.getElementById('s-admin-pin').value.trim(),
    admin_email: document.getElementById('s-admin-email').value.trim(),
    country_code: country,
    province_code: province,
    city: document.getElementById('s-city').value.trim(),
    timezone: document.getElementById('s-timezone').value,
    work_start: document.getElementById('s-work-start').value,
    work_end: document.getElementById('s-work-end').value,
    break_morning_min: document.getElementById('s-break-morning').value,
    break_lunch_min: document.getElementById('s-break-lunch').value,
    break_afternoon_min: document.getElementById('s-break-afternoon').value,
    paid_hours_per_day: document.getElementById('s-paid-hours').value,
    stat_pay_multiplier: mult,
    work_days: activeDays.join(','),
    gps_fraud_check: document.getElementById('s-gps-fraud-check')?.checked ? '1' : '0',
    geofence_radius_meters: document.getElementById('s-geofence-radius')?.value || '300',
    auto_clockout_enabled: document.getElementById('s-auto-clockout')?.checked ? '1' : '0',
    max_shift_hours: document.getElementById('s-max-shift-hours')?.value || '10',
    away_warning_min: document.getElementById('s-away-warning-min')?.value || '30',
    geofence_exit_clockout_min: document.getElementById('s-geofence-exit-min')?.value || '0',
    notify_email: document.getElementById('s-notify-email')?.checked ? '1' : '0',
    notify_sms: document.getElementById('s-notify-sms')?.checked ? '1' : '0',
    admin_phone: document.getElementById('s-admin-phone')?.value?.trim() || '',
    twilio_account_sid: document.getElementById('s-twilio-sid')?.value?.trim() || '',
    twilio_auth_token: document.getElementById('s-twilio-token')?.value?.trim() || '',
    twilio_from_number: document.getElementById('s-twilio-from')?.value?.trim() || '',
    app_host: document.getElementById('s-app-host')?.value?.trim() || '',
    admin_host: document.getElementById('s-admin-host')?.value?.trim() || '',
    pay_frequency: document.getElementById('s-pay-frequency')?.value || 'biweekly',
    pay_period_anchor: document.getElementById('s-pay-anchor')?.value || '2026-03-06',
    show_pay_to_workers: document.getElementById('s-show-pay-workers')?.checked ? '1' : '0',
    accountant_email: document.getElementById('s-accountant-email')?.value?.trim() || '',
    company_name: document.getElementById('s-company-name')?.value?.trim() || '',
    // QB OAuth credentials (only save non-empty values to avoid overwriting tokens)
    ...(document.getElementById('s-qb-client-id')?.value?.trim() ? { qb_client_id: document.getElementById('s-qb-client-id').value.trim() } : {}),
    ...(document.getElementById('s-qb-client-secret')?.value?.trim() && !document.getElementById('s-qb-client-secret').value.includes('•') ? { qb_client_secret: document.getElementById('s-qb-client-secret').value.trim() } : {}),
    qb_environment: document.getElementById('s-qb-environment')?.value || 'production'
  }

  try {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    if (res.ok) {
      showAdminToast('Settings saved! ✅', 'success')
      currentSettings = payload
    } else {
      showAdminToast('Failed to save settings', 'error')
    }
  } catch(e) { showAdminToast('Error saving settings', 'error') }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── Export Tab ────────────────────────────────────────────────────────────────
function getMonWeekStart(offsetWeeks = 0) {
  const d = new Date()
  const day = d.getDay()
  const diffToMon = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diffToMon + offsetWeeks * 7)
  return d.toISOString().split('T')[0]
}

function setExportWeek(offset) {
  const monDate = getMonWeekStart(offset)
  document.getElementById('export-week-date').value = monDate
  updateExportWeekLabel()
}

function updateExportWeekLabel() {
  const dateVal = document.getElementById('export-week-date').value
  if (!dateVal) { document.getElementById('export-week-label').textContent = '—'; return }
  const d = new Date(dateVal + 'T12:00:00')
  const day = d.getDay()
  const diffToMon = day === 0 ? -6 : 1 - day
  const mon = new Date(d); mon.setDate(d.getDate() + diffToMon)
  const fri = new Date(mon); fri.setDate(mon.getDate() + 4)
  const fmt = dt => dt.toLocaleDateString('en-CA', { weekday:'short', month:'short', day:'numeric' })
  document.getElementById('export-week-label').textContent = fmt(mon) + ' → ' + fmt(fri)
}

let _exportInited = false
async function initExportTab() {
  setExportWeek(0)  // default to current week
  if (!_exportInited) {
    _exportInited = true
    document.getElementById('export-week-date').addEventListener('change', updateExportWeekLabel)
  }

  // Populate worker dropdown
  try {
    const wRes = await fetch('/api/workers')
    const wData = await wRes.json()
    const sel = document.getElementById('export-worker-select')
    if (sel) {
      const workers = (wData.workers || []).filter(w => w.active)
      workers.sort((a,b) => a.name.localeCompare(b.name))
      workers.forEach(w => {
        const opt = document.createElement('option')
        opt.value = w.id
        opt.textContent = `👤 ${w.name} ($${(w.hourly_rate||0).toFixed(2)}/hr)`
        sel.appendChild(opt)
      })
      sel.addEventListener('change', () => {
        const badge = document.getElementById('export-worker-badge')
        if (!badge) return
        if (!sel.value) {
          badge.textContent = 'All Workers'
          badge.className = 'px-3 py-1.5 bg-indigo-50 text-indigo-700 text-xs font-bold rounded-full border border-indigo-200'
        } else {
          const opt = sel.options[sel.selectedIndex]
          badge.textContent = opt.textContent.replace('👤 ','')
          badge.className = 'px-3 py-1.5 bg-green-50 text-green-700 text-xs font-bold rounded-full border border-green-200'
        }
      })
    }
  } catch(e) {}

  // Load last email sent time
  try {
    const res = await fetch('/api/settings')
    const data = await res.json()
    const s = data.settings || {}
    if (s.last_weekly_email_sent) {
      document.getElementById('last-email-sent-info').textContent =
        'Last sent: ' + new Date(s.last_weekly_email_sent).toLocaleString()
    }
    if (s.admin_email) {
      document.getElementById('auto-email-config-status').innerHTML = `
        <i class="fas fa-check-circle text-green-500 mt-0.5 flex-shrink-0"></i>
        <span><strong>Email configured:</strong> Reports will be sent to <strong>${s.admin_email}</strong> every Friday night</span>
      `
    }
  } catch(e) {}
}

function getExportWorkerParam() {
  const sel = document.getElementById('export-worker-select')
  return sel && sel.value ? '&worker_id=' + sel.value : ''
}

function viewWeeklyReport() {
  const week = document.getElementById('export-week-date').value
  if (!week) { showAdminToast('Select a week first', 'error'); return }
  window.open('/api/export/weekly/html?week=' + week + getExportWorkerParam(), '_blank')
}

function downloadCSV() {
  const week = document.getElementById('export-week-date').value
  if (!week) { showAdminToast('Select a week first', 'error'); return }
  window.location.href = '/api/export/csv?week=' + week + getExportWorkerParam()
  showAdminToast('CSV download started!', 'success')
}

async function emailWeeklyReport() {
  const week = document.getElementById('export-week-date').value
  if (!week) { showAdminToast('Select a week first', 'error'); return }

  const workerSel = document.getElementById('export-worker-select')
  const workerId  = workerSel ? workerSel.value : ''
  const workerName = workerId ? workerSel.options[workerSel.selectedIndex].textContent.replace('👤 ','').split(' (')[0] : 'All Staff'

  const btn = document.getElementById('email-report-btn')
  btn.disabled = true
  btn.innerHTML = '<i class="fas fa-circle-notch fa-spin mr-1"></i>Sending...'

  const statusEl = document.getElementById('export-email-status')
  statusEl.className = 'rounded-xl p-4 mb-4 text-sm bg-blue-50 border border-blue-200 text-blue-700'
  statusEl.classList.remove('hidden')
  statusEl.innerHTML = `<i class="fas fa-circle-notch fa-spin mr-2"></i>Sending report for <strong>${workerName}</strong>...`

  try {
    const res = await fetch('/api/export/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ week, worker_id: workerId || null })
    })
    const data = await res.json()

    if (data.success) {
      statusEl.className = 'rounded-xl p-4 mb-4 text-sm bg-green-50 border border-green-200 text-green-800'
      statusEl.innerHTML = `<i class="fas fa-check-circle mr-2"></i><strong>Report sent for ${workerName}!</strong> ${data.message}`
      showAdminToast(`✅ Report sent — ${workerName}`, 'success')
      document.getElementById('last-email-sent-info').textContent = 'Last sent: ' + new Date().toLocaleString()
    } else {
      statusEl.className = 'rounded-xl p-4 mb-4 text-sm bg-amber-50 border border-amber-200 text-amber-800'
      statusEl.innerHTML = `
        <p class="font-semibold mb-1"><i class="fas fa-exclamation-triangle mr-2"></i>Email not yet configured</p>
        <p class="text-xs mb-2">${data.message || ''}</p>
        ${data.preview_url ? `<a href="${data.preview_url}" target="_blank" class="text-blue-600 underline text-xs font-medium"><i class="fas fa-external-link-alt mr-1"></i>View report in browser instead</a>` : ''}
      `
    }
  } catch(e) {
    statusEl.className = 'rounded-xl p-4 mb-4 text-sm bg-red-50 border border-red-200 text-red-700'
    statusEl.innerHTML = '<i class="fas fa-times-circle mr-2"></i>Failed to send. Check console for details.'
  }

  btn.disabled = false
  btn.innerHTML = '<i class="fas fa-paper-plane mr-1"></i>Send Email'
}

// ── GPS Override Management ───────────────────────────────────────────────────
let overrideHistoryVisible = false

async function loadOverrides() {
  try {
    const res = await fetch('/api/override/pending')
    const data = await res.json()
    const requests = data.requests || []
    const listEl = document.getElementById('overrides-list')
    const countEl = document.getElementById('overrides-count')
    const badge = document.getElementById('override-badge')

    countEl.textContent = requests.length
    if (requests.length > 0) {
      badge.textContent = requests.length
      badge.classList.remove('hidden')
    } else {
      badge.classList.add('hidden')
    }

    if (requests.length === 0) {
      listEl.innerHTML = '<p class="text-gray-400 text-center py-12"><i class="fas fa-check-circle text-green-400 text-3xl mb-3 block"></i>No pending override requests.</p>'
      return
    }

    listEl.innerHTML = requests.map(r => {
      const distM = Math.round(r.distance_meters || 0)
      const distTxt = distM >= 1000 ? (distM/1000).toFixed(1) + ' km' : distM + ' m'
      const reqTime = new Date(r.requested_at).toLocaleString()
      const gmapsWorker = (r.worker_lat && r.worker_lng) ? 'https://www.google.com/maps?q=' + r.worker_lat + ',' + r.worker_lng : null
      const gmapsJob   = (r.job_lat && r.job_lng)    ? 'https://www.google.com/maps?q=' + r.job_lat + ',' + r.job_lng   : null
      return `
      <div class="border-2 border-red-200 rounded-2xl p-5 mb-4 bg-red-50" id="override-card-${r.id}">
        <div class="flex items-start justify-between gap-3 mb-3">
          <div class="flex items-center gap-3">
            <div class="w-11 h-11 bg-red-100 rounded-2xl flex items-center justify-center flex-shrink-0">
              <i class="fas fa-user-slash text-red-500 text-lg"></i>
            </div>
            <div>
              <p class="font-bold text-gray-800">${r.worker_name || 'Worker'}</p>
              <p class="text-xs text-gray-500">${r.worker_phone || ''} &bull; ${reqTime}</p>
            </div>
          </div>
          <span class="bg-red-500 text-white text-xs font-bold px-2.5 py-1 rounded-full flex-shrink-0">BLOCKED</span>
        </div>
        <div class="bg-white rounded-xl border border-red-200 p-3 mb-3">
          <div class="flex items-center gap-2 mb-2">
            <i class="fas fa-exclamation-triangle text-red-500"></i>
            <span class="text-sm font-semibold text-red-700">Worker is ${distTxt} from job site</span>
          </div>
          <div class="grid grid-cols-2 gap-2 text-xs">
            <div class="bg-blue-50 rounded-lg p-2">
              <p class="text-gray-500 mb-0.5">Your location</p>
              <p class="font-medium text-gray-700">${r.worker_address ? r.worker_address.substring(0,50)+'...' : (r.worker_lat ? r.worker_lat.toFixed(5)+', '+r.worker_lng.toFixed(5) : 'No GPS')}</p>
              ${gmapsWorker ? '<a href="'+gmapsWorker+'" target="_blank" class="text-blue-500 hover:underline text-[11px]">View on map</a>' : ''}
            </div>
            <div class="bg-green-50 rounded-lg p-2">
              <p class="text-gray-500 mb-0.5">Job site entered</p>
              <p class="font-medium text-gray-700">${r.job_location}</p>
              ${gmapsJob ? '<a href="'+gmapsJob+'" target="_blank" class="text-blue-500 hover:underline text-[11px]">View on map</a>' : ''}
            </div>
          </div>
        </div>
        <div class="bg-white rounded-xl border border-gray-200 p-3 mb-3 text-xs text-gray-600">
          <span class="font-medium text-gray-700">Task: </span>${r.job_description || 'Not specified'}
        </div>
        <div class="mb-3">
          <input type="text" id="override-note-${r.id}" placeholder="Admin note (optional — e.g. verified by phone call)"
            class="w-full px-3 py-2.5 border border-gray-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
        </div>
        <div class="flex gap-3">
          <button onclick="approveOverride(${r.id})"
            class="flex-1 bg-green-500 hover:bg-green-600 text-white font-bold py-3 rounded-xl text-sm shadow-sm">
            Approve &amp; Clock In
          </button>
          <button onclick="denyOverride(${r.id})"
            class="flex-1 bg-red-500 hover:bg-red-600 text-white font-bold py-3 rounded-xl text-sm shadow-sm">
            Deny
          </button>
          <button onclick="resendNotify(${r.id})" title="Resend email/SMS notification"
            class="px-3 py-3 bg-amber-100 hover:bg-amber-200 text-amber-700 rounded-xl text-sm border border-amber-200">
            <i class="fas fa-bell"></i>
          </button>
        </div>
      </div>`
    }).join('')
  } catch(e) {
    showAdminToast('Failed to load override requests', 'error')
  }
}

async function approveOverride(id) {
  const noteEl = document.getElementById('override-note-' + id)
  const note = noteEl ? noteEl.value : ''
  if (!confirm('Approve this clock-in override? The worker will be clocked in immediately.')) return
  try {
    const res = await fetch('/api/override/' + id + '/approve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ admin_note: note || 'Approved by admin' })
    })
    const data = await res.json()
    if (data.success) {
      showAdminToast('Override approved — worker clocked in', 'success')
      loadOverrides()
      loadLive()
      loadStats()
    } else { showAdminToast(data.error || 'Failed to approve', 'error') }
  } catch(e) { showAdminToast('Connection error', 'error') }
}

async function denyOverride(id) {
  const noteEl = document.getElementById('override-note-' + id)
  const note = noteEl ? noteEl.value : ''
  if (!confirm('Deny this clock-in override? The worker will not be clocked in.')) return
  try {
    const res = await fetch('/api/override/' + id + '/deny', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ admin_note: note || 'Denied by admin' })
    })
    const data = await res.json()
    if (data.success) {
      showAdminToast('Override denied', 'info')
      loadOverrides()
    } else { showAdminToast(data.error || 'Failed to deny', 'error') }
  } catch(e) { showAdminToast('Connection error', 'error') }
}

async function showOverrideHistory() {
  overrideHistoryVisible = !overrideHistoryVisible
  const histEl = document.getElementById('overrides-history')
  if (!overrideHistoryVisible) { histEl.classList.add('hidden'); return }
  histEl.classList.remove('hidden')
  try {
    const res = await fetch('/api/override/all')
    const data = await res.json()
    const requests = data.requests || []
    const listEl = document.getElementById('overrides-history-list')
    if (requests.length === 0) {
      listEl.innerHTML = '<p class="text-gray-400 text-sm text-center py-4">No override history yet.</p>'
      return
    }
    const statusColor = { approved: 'text-green-600 bg-green-100', denied: 'text-red-600 bg-red-100', pending: 'text-amber-600 bg-amber-100' }
    listEl.innerHTML = requests.map(r => {
      const distM = Math.round(r.distance_meters || 0)
      const distTxt = distM >= 1000 ? (distM/1000).toFixed(1)+' km' : distM+'m'
      const sc = statusColor[r.status] || 'text-gray-600 bg-gray-100'
      return `<div class="flex items-center justify-between bg-gray-50 rounded-xl px-4 py-3 border border-gray-200 text-sm">
        <div>
          <span class="font-semibold text-gray-800">${r.worker_name || 'Worker'}</span>
          <span class="text-gray-500 ml-2 text-xs">${r.job_location} &bull; ${distTxt} away</span>
          <p class="text-xs text-gray-400 mt-0.5">${new Date(r.requested_at).toLocaleString()}${r.override_note ? ' &bull; ' + r.override_note : ''}</p>
        </div>
        <span class="text-xs font-bold px-2.5 py-1 rounded-full flex-shrink-0 ${sc}">${r.status.toUpperCase()}</span>
      </div>`
    }).join('')
  } catch(e) { showAdminToast('Failed to load history', 'error') }
}

// Poll for pending override badge every 60s
async function resendNotify(id) {
  try {
    const res = await fetch('/api/override/' + id + '/notify', { method: 'POST' })
    const data = await res.json()
    if (data.email_sent && data.sms_sent) {
      showAdminToast('Email + SMS sent to admin', 'success')
    } else if (data.email_sent) {
      showAdminToast('Email alert sent to admin', 'success')
    } else if (data.sms_sent) {
      showAdminToast('SMS alert sent to admin', 'success')
    } else if (data.errors && data.errors.length > 0) {
      showAdminToast('Notify failed: ' + data.errors[0], 'error')
    } else {
      showAdminToast('No channels configured — add email/Twilio in Settings', 'info')
    }
  } catch(e) { showAdminToast('Connection error', 'error') }
}

setInterval(async () => {
  try {
    const res = await fetch('/api/override/pending')
    const data = await res.json()
    const count = (data.requests || []).length
    const badge = document.getElementById('override-badge')
    if (!badge) return
    if (count > 0) { badge.textContent = count; badge.classList.remove('hidden') }
    else { badge.classList.add('hidden') }
  } catch(e) {}
}, 60000)

// ── Payroll Totals Tab ────────────────────────────────────────────────────────
async function loadPayrollTab() {
  const listEl = document.getElementById('payroll-workers-list')
  const ptPayroll = document.getElementById('pt-total-payroll')
  const ptHours   = document.getElementById('pt-total-hours')
  const ptWorkers = document.getElementById('pt-total-workers')
  if (!listEl) return
  listEl.innerHTML = '<p class="text-gray-400 text-center py-8"><i class="fas fa-spinner fa-spin mr-2"></i>Loading...</p>'
  try {
    const res  = await fetch('/api/stats/summary?period=' + currentPeriod)
    const data = await res.json()
    const stats = data.stats || {}

    if (ptPayroll) ptPayroll.textContent = '$' + (stats.total_earnings || 0).toFixed(2)
    if (ptHours)   ptHours.textContent   = (stats.total_hours || 0).toFixed(1) + 'h'
    if (ptWorkers) ptWorkers.textContent = stats.total_workers || 0

    // Get per-worker breakdown via sessions
    const sRes  = await fetch('/api/sessions?limit=500')
    const sData = await sRes.json()
    const sessions = sData.sessions || []

    // Group by worker
    const byWorker = {}
    sessions.forEach(sess => {
      if (!byWorker[sess.worker_id]) byWorker[sess.worker_id] = {
        name: sess.worker_name, phone: sess.worker_phone, sessions: [], hours: 0, earnings: 0
      }
      byWorker[sess.worker_id].sessions.push(sess)
      byWorker[sess.worker_id].hours    += sess.total_hours || 0
      byWorker[sess.worker_id].earnings += sess.earnings    || 0
    })

    const workers = Object.values(byWorker).sort((a, b) => b.earnings - a.earnings)
    if (!workers.length) {
      listEl.innerHTML = '<p class="text-gray-400 text-center py-8">No payroll data for this period</p>'
      return
    }

    listEl.innerHTML = workers.map(w => `
      <div class="bg-white border border-gray-100 rounded-2xl p-4 hover:shadow-md transition-shadow">
        <div class="flex items-center justify-between gap-3">
          <div class="flex items-center gap-3 flex-1 min-w-0">
            <div class="w-10 h-10 bg-indigo-100 rounded-full flex items-center justify-center flex-shrink-0">
              <span class="text-indigo-700 font-bold text-sm">${w.name.charAt(0).toUpperCase()}</span>
            </div>
            <div class="min-w-0">
              <p class="font-semibold text-gray-800 truncate">${w.name}</p>
              <p class="text-xs text-gray-400">${w.phone} · ${w.sessions.length} shift${w.sessions.length !== 1 ? 's' : ''}</p>
            </div>
          </div>
          <div class="text-right flex-shrink-0">
            <p class="text-xl font-bold text-green-700">$${w.earnings.toFixed(2)}</p>
            <p class="text-xs text-gray-400">${w.hours.toFixed(1)}h worked</p>
          </div>
        </div>
        <!-- Mini bar showing proportion of total earnings -->
        <div class="mt-3 h-1.5 bg-gray-100 rounded-full overflow-hidden">
          <div class="h-full bg-gradient-to-r from-indigo-400 to-purple-500 rounded-full" style="width:${Math.min(100,(w.earnings/(stats.total_earnings||1))*100).toFixed(1)}%"></div>
        </div>
        <div class="mt-2 flex gap-3 text-[11px] text-gray-400">
          <span><i class="fas fa-clock mr-1"></i>${w.hours.toFixed(1)} hrs</span>
          <span><i class="fas fa-calendar mr-1"></i>${w.sessions.length} sessions</span>
          <span class="ml-auto text-indigo-600 font-medium">${((w.earnings/(stats.total_earnings||1))*100).toFixed(1)}% of payroll</span>
        </div>
      </div>
    `).join('')
  } catch(e) {
    if (listEl) listEl.innerHTML = '<p class="text-red-400 text-center py-8">Error loading payroll data</p>'
    console.error(e)
  }
}

// ── Accountant Weekly Summary Tab ─────────────────────────────────────────────
let acctWeekOffset = 0

function getMondayOf(offset = 0) {
  const d = new Date()
  const day = d.getDay()
  const diff = d.getDate() - (day === 0 ? 6 : day - 1)
  d.setDate(diff + offset * 7)
  d.setHours(0, 0, 0, 0)
  return d
}

function setAcctWeek(offset) {
  acctWeekOffset = offset
  const monday = getMondayOf(offset)
  const friday = new Date(monday); friday.setDate(monday.getDate() + 6)
  const fmt = d => d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
  const dateInput = document.getElementById('acct-week-date')
  const label     = document.getElementById('acct-week-label')
  if (dateInput) dateInput.value = monday.toISOString().split('T')[0]
  if (label) label.textContent = fmt(monday) + ' – ' + fmt(friday)
}

function initAcctTab() {
  setAcctWeek(0)
}

async function loadAcctPreview() {
  const dateInput = document.getElementById('acct-week-date')
  const previewEl = document.getElementById('acct-preview')
  if (!previewEl || !dateInput?.value) return

  previewEl.innerHTML = '<p class="text-gray-400 text-center py-8"><i class="fas fa-spinner fa-spin mr-2"></i>Loading preview...</p>'

  try {
    const res  = await fetch('/api/export/weekly?week=' + dateInput.value)
    const data = await res.json()
    const workers = data.workers || []

    if (!workers.length) {
      previewEl.innerHTML = '<p class="text-gray-400 text-center py-8">No shifts recorded for this week</p>'
      return
    }

    previewEl.innerHTML = `
      <div class="bg-amber-50 border border-amber-200 rounded-2xl p-4 mb-4">
        <p class="text-sm font-semibold text-amber-800"><i class="fas fa-info-circle mr-1"></i>Preview: ${workers.length} worker${workers.length !== 1 ? 's' : ''} — ${data.label || ''}</p>
      </div>
    ` + workers.map(w => `
      <div class="bg-white border border-gray-100 rounded-2xl p-4 mb-3">
        <div class="flex items-center gap-3 mb-3">
          <div class="w-10 h-10 bg-amber-100 rounded-full flex items-center justify-center flex-shrink-0">
            <span class="text-amber-700 font-bold text-sm">${w.worker_name.charAt(0)}</span>
          </div>
          <div class="flex-1">
            <p class="font-bold text-gray-800">${w.worker_name}</p>
            <p class="text-xs text-gray-400">${w.worker_phone}</p>
          </div>
          <div class="text-right">
            <p class="text-lg font-bold text-green-700">$${(w.total_earnings || 0).toFixed(2)}</p>
            <p class="text-xs text-gray-400">${(w.total_hours || 0).toFixed(1)}h</p>
          </div>
        </div>
        <div class="space-y-1">
          ${(w.sessions || []).map(s => {
            const cin  = new Date(s.clock_in_time)
            const cout = s.clock_out_time ? new Date(s.clock_out_time) : null
            return `<div class="flex items-center justify-between text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-1.5">
              <span><i class="fas fa-calendar mr-1 text-gray-400"></i>${cin.toLocaleDateString([],{weekday:'short',month:'short',day:'numeric'})}</span>
              <span>${cin.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})} → ${cout ? cout.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) : 'Active'}</span>
              <span class="font-semibold text-gray-700">${(s.total_hours||0).toFixed(1)}h · $${(s.earnings||0).toFixed(2)}</span>
            </div>`
          }).join('')}
        </div>
      </div>
    `).join('')
  } catch(e) {
    if (previewEl) previewEl.innerHTML = '<p class="text-red-400 text-center py-8">Error loading preview</p>'
    console.error(e)
  }
}

async function sendAcctSummary() {
  const emailEl  = document.getElementById('acct-email')
  const dateEl   = document.getElementById('acct-week-date')
  const statusEl = document.getElementById('acct-send-status')
  const btn      = document.getElementById('acct-send-btn')
  if (!emailEl?.value) { showAdminToast('Enter accountant email first', 'error'); return }
  if (!dateEl?.value)  { showAdminToast('Select a week first', 'error'); return }

  btn.disabled = true
  btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>Sending...'
  if (statusEl) { statusEl.className = 'mt-4 rounded-xl p-4 text-sm bg-blue-50 border border-blue-200 text-blue-700'; statusEl.innerHTML = '<i class="fas fa-circle-notch fa-spin mr-2"></i>Sending weekly summary...'; statusEl.classList.remove('hidden') }

  try {
    const res  = await fetch('/api/report/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ week: dateEl.value, to: emailEl.value })
    })
    const data = await res.json()
    if (data.success) {
      if (statusEl) { statusEl.className = 'mt-4 rounded-xl p-4 text-sm bg-green-50 border border-green-200 text-green-700'; statusEl.innerHTML = `<i class="fas fa-check-circle mr-2"></i><strong>Sent!</strong> Weekly summary emailed to ${emailEl.value}` }
      showAdminToast('✅ Weekly summary sent to accountant!', 'success')
    } else {
      if (statusEl) { statusEl.className = 'mt-4 rounded-xl p-4 text-sm bg-red-50 border border-red-200 text-red-700'; statusEl.innerHTML = '<i class="fas fa-times-circle mr-2"></i>' + (data.error || 'Send failed') }
      showAdminToast(data.error || 'Send failed', 'error')
    }
  } catch(e) {
    if (statusEl) { statusEl.className = 'mt-4 rounded-xl p-4 text-sm bg-red-50 border border-red-200 text-red-700'; statusEl.innerHTML = '<i class="fas fa-times-circle mr-2"></i>Connection error' }
    showAdminToast('Connection error', 'error')
  } finally {
    btn.disabled = false
    btn.innerHTML = '<i class="fas fa-paper-plane mr-1"></i>Send'
  }
}

// ─── QUICKBOOKS PAYROLL EXPORT ────────────────────────────────────────────────

let qbPayPeriods = []

async function initQbTab() {
  // Pre-fill accountant email from settings
  const emailEl = document.getElementById('qb-acct-email')
  if (emailEl && currentSettings && currentSettings.accountant_email) {
    emailEl.value = currentSettings.accountant_email
  }

  // Load pay periods
  try {
    const res  = await fetch('/api/pay-periods')
    const data = await res.json()
    qbPayPeriods = data.periods || []
    renderQbPeriodList()
    // Default to most recent completed period; if none, use current month
    const today = new Date().toISOString().split('T')[0]
    const past = qbPayPeriods.filter(p => p.end <= today)
    const current = qbPayPeriods.find(p => p.start <= today && p.end >= today)
    if (past.length) {
      setQbPeriod(past[past.length - 1].start, past[past.length - 1].end)
    } else if (current) {
      setQbPeriod(current.start, current.end)
    } else {
      // No past or current pay periods — default to this month
      setQbCustomRange('this_month')
    }
  } catch(e) {
    console.error('Failed to load pay periods', e)
    // Fallback to this month
    setQbCustomRange('this_month')
  }
}

function renderQbPeriodList() {
  const container = document.getElementById('qb-period-list')
  if (!container || !qbPayPeriods.length) return
  const today = new Date().toISOString().split('T')[0]
  container.innerHTML = qbPayPeriods.map((p, i) => {
    const isCurrent = p.start <= today && p.end >= today
    const isPast    = p.end < today
    const isFuture  = p.start > today
    const cls = isCurrent
      ? 'bg-indigo-600 text-white border-indigo-600 cursor-pointer'
      : isPast
        ? 'bg-white border-gray-200 text-gray-700 hover:bg-indigo-50 hover:border-indigo-300 cursor-pointer'
        : 'bg-gray-50 border-gray-200 text-gray-400 hover:bg-gray-100 cursor-pointer'
    return `<button onclick="setQbPeriod('${p.start}','${p.end}')"
      class="px-3 py-1.5 rounded-xl border text-xs font-medium transition-all ${cls}">
      ${isCurrent ? '▶ ' : isFuture ? '⏳ ' : ''}${p.label}
    </button>`
  }).join('')
}

function setQbPeriod(start, end) {
  const startEl = document.getElementById('qb-start')
  const endEl   = document.getElementById('qb-end')
  if (startEl) startEl.value = start
  if (endEl)   endEl.value   = end
  const label = document.getElementById('qb-period-label')
  if (label) {
    const fmtDate = d => new Date(d + 'T00:00:00').toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
    label.textContent = `${fmtDate(start)} → ${fmtDate(end)}`
  }
  loadQbPreview()
}

function setQbCustomRange(preset) {
  const today = new Date()
  let start, end
  if (preset === 'this_week') {
    const d = new Date(today)
    const day = d.getDay()
    d.setDate(d.getDate() - (day === 0 ? 6 : day - 1))
    start = d.toISOString().split('T')[0]
    const fri = new Date(d); fri.setDate(d.getDate() + 6)
    end = fri.toISOString().split('T')[0]
  } else if (preset === 'last_week') {
    const d = new Date(today)
    const day = d.getDay()
    d.setDate(d.getDate() - (day === 0 ? 6 : day - 1) - 7)
    start = d.toISOString().split('T')[0]
    const fri = new Date(d); fri.setDate(d.getDate() + 6)
    end = fri.toISOString().split('T')[0]
  } else if (preset === 'this_month') {
    start = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0]
    end   = new Date(today.getFullYear(), today.getMonth() + 1, 0).toISOString().split('T')[0]
  } else if (preset === 'last_month') {
    start = new Date(today.getFullYear(), today.getMonth() - 1, 1).toISOString().split('T')[0]
    end   = new Date(today.getFullYear(), today.getMonth(), 0).toISOString().split('T')[0]
  }
  if (start && end) setQbPeriod(start, end)
}

async function loadQbPreview() {
  const start = document.getElementById('qb-start')?.value
  const end   = document.getElementById('qb-end')?.value
  const el    = document.getElementById('qb-preview')
  if (!el || !start || !end) return

  el.innerHTML = '<p class="text-gray-400 text-center py-8"><i class="fas fa-spinner fa-spin mr-2"></i>Loading...</p>'

  try {
    // Use dedicated /api/export/period endpoint with exact start + end dates
    const res    = await fetch(`/api/export/period?start=${start}&end=${end}`)
    const data   = await res.json()
    const workers = data.workers || []

    if (!workers.length) {
      el.innerHTML = '<div class="text-center py-10 text-gray-400"><i class="fas fa-calendar-times text-3xl mb-3 block text-gray-200"></i><p class="text-sm">No completed shifts in this period</p></div>'
      return
    }

    const totalGross = workers.reduce((a, w) => a + (w.total_earnings || 0), 0)
    const totalHours = workers.reduce((a, w) => a + (w.total_hours || 0), 0)

    el.innerHTML = `
      <div class="grid grid-cols-3 gap-3 mb-4">
        <div class="bg-green-50 border border-green-100 rounded-2xl p-3 text-center">
          <p class="text-xl font-bold text-green-700">$${totalGross.toFixed(2)}</p>
          <p class="text-xs text-green-500 mt-0.5">Total Gross</p>
        </div>
        <div class="bg-blue-50 border border-blue-100 rounded-2xl p-3 text-center">
          <p class="text-xl font-bold text-blue-700">${totalHours.toFixed(1)}h</p>
          <p class="text-xs text-blue-500 mt-0.5">Total Hours</p>
        </div>
        <div class="bg-purple-50 border border-purple-100 rounded-2xl p-3 text-center">
          <p class="text-xl font-bold text-purple-700">${workers.length}</p>
          <p class="text-xs text-purple-500 mt-0.5">Employees</p>
        </div>
      </div>
      <div class="space-y-2">
        ${workers.map(w => `
          <div class="flex items-center gap-3 p-3 bg-gray-50 rounded-xl border border-gray-100">
            <div class="w-9 h-9 bg-indigo-100 rounded-full flex items-center justify-center flex-shrink-0">
              <span class="text-indigo-700 font-bold text-sm">${(w.worker_name||'?').charAt(0)}</span>
            </div>
            <div class="flex-1">
              <p class="font-semibold text-gray-800 text-sm">${w.worker_name}</p>
              <p class="text-xs text-gray-400">${(w.sessions||[]).length} shifts · ${(w.total_hours||0).toFixed(1)}h</p>
            </div>
            <div class="text-right">
              <p class="font-bold text-green-700">$${(w.total_earnings||0).toFixed(2)}</p>
              <p class="text-xs text-gray-400">gross</p>
            </div>
          </div>
        `).join('')}
      </div>
      <p class="text-xs text-gray-400 mt-3 text-center">
        <i class="fas fa-info-circle mr-1"></i>
        Employee names in QB files must match exactly as shown above
      </p>
    `
  } catch(e) {
    el.innerHTML = '<p class="text-red-400 text-center py-8 text-sm"><i class="fas fa-exclamation-triangle mr-2"></i>Error loading preview</p>'
  }
}

function downloadQbFile(type) {
  const start = document.getElementById('qb-start')?.value
  const end   = document.getElementById('qb-end')?.value
  if (!start || !end) { showAdminToast('Select a pay period first', 'error'); return }

  let url
  if (type === 'iif')      url = `/api/export/qb-iif?start=${start}&end=${end}`
  else if (type === 'csv') url = `/api/export/qb-csv?start=${start}&end=${end}`
  else                     url = `/api/export/csv?week=${start}&end=${end}`  // detail CSV

  const a = document.createElement('a')
  a.href = url
  a.download = ''
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  showAdminToast(`✅ ${type.toUpperCase()} file downloading...`, 'success')
}

async function sendQbToAccountant() {
  const start   = document.getElementById('qb-start')?.value
  const end     = document.getElementById('qb-end')?.value
  const emailEl = document.getElementById('qb-acct-email')
  const statusEl= document.getElementById('qb-send-status')
  const btn     = document.getElementById('qb-send-btn')
  const fmt     = document.querySelector('input[name="qb-fmt"]:checked')?.value || 'both'

  if (!start || !end)    { showAdminToast('Select a pay period first', 'error'); return }
  if (!emailEl?.value)   { showAdminToast('Enter accountant email first', 'error'); return }

  btn.disabled = true
  btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Sending...'
  if (statusEl) { statusEl.className = 'mt-3 rounded-xl p-3 text-sm bg-blue-50 border border-blue-200 text-blue-700'; statusEl.innerHTML = '<i class="fas fa-circle-notch fa-spin mr-2"></i>Sending payroll report...'; statusEl.classList.remove('hidden') }

  try {
    const res  = await fetch('/api/export/email-accountant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start, end, format: fmt, to: emailEl.value })
    })
    const data = await res.json()

    if (data.success) {
      if (statusEl) {
        statusEl.className = 'mt-3 rounded-xl p-3 text-sm bg-green-50 border border-green-200 text-green-700'
        statusEl.innerHTML = `<i class="fas fa-check-circle mr-2"></i><strong>Sent!</strong> Payroll report emailed to ${data.sent_to?.join(', ')}` +
          (data.formats_attached?.length ? `<br><span class="text-xs">Attached: ${data.formats_attached.join(', ')}</span>` : '')
      }
      showAdminToast('✅ Payroll report sent to accountant!', 'success')

      // Auto-save accountant email to settings
      if (currentSettings) {
        currentSettings.accountant_email = emailEl.value
        await fetch('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountant_email: emailEl.value })
        })
      }
    } else {
      const msg = data.error || 'Send failed'
      if (statusEl) { statusEl.className = 'mt-3 rounded-xl p-3 text-sm bg-red-50 border border-red-200 text-red-700'; statusEl.innerHTML = `<i class="fas fa-times-circle mr-2"></i>${msg}` }
      showAdminToast(msg, 'error')
    }
  } catch(e) {
    if (statusEl) { statusEl.className = 'mt-3 rounded-xl p-3 text-sm bg-red-50 border border-red-200 text-red-700'; statusEl.innerHTML = '<i class="fas fa-times-circle mr-2"></i>Connection error' }
    showAdminToast('Connection error', 'error')
  } finally {
    btn.disabled = false
    btn.innerHTML = '<i class="fas fa-paper-plane mr-2"></i>Send Payroll Report to Accountant'
  }
}

// ─────────────────────────────────────────────────────────────────────────────

// Helper: set an input value by id (avoids single-quote issues in onclick attrs)
function setVal(id, val) {
  const el = document.getElementById(id)
  if (el) el.value = val
}

// Helper: filter sessions tab to a specific session's date + worker
function filterSessionsByDateFromSession(sessionId) {
  const sess = sessionStore[sessionId]
  if (!sess) return
  const dateStr = new Date(sess.clock_in_time).toISOString().split('T')[0]
  showTab('sessions')
  setTimeout(() => {
    const dateEl = document.getElementById('filter-date')
    const workerEl = document.getElementById('filter-worker')
    if (dateEl) dateEl.value = dateStr
    if (workerEl) workerEl.value = sess.worker_id
    loadSessions()
  }, 100)
}

function showAdminToast(msg, type = 'info') {
  const t = document.getElementById('admin-toast')
  t.textContent = msg
  t.className = `fixed bottom-6 right-6 px-5 py-3 rounded-xl shadow-xl z-50 text-sm font-medium text-white
    ${type === 'error' ? 'bg-red-600' : type === 'success' ? 'bg-green-600' : 'bg-gray-800'}`
  t.classList.remove('hidden')
  setTimeout(() => t.classList.add('hidden'), 3500)
}

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE 1 — SESSION TIME EDITOR
// ═══════════════════════════════════════════════════════════════════════════════

let editingSessionId = null
let editingSessionData = null

function openSessionEditModal(sessionId) {
  const s = allSessionsData ? allSessionsData.find(x => x.id === sessionId) : null
  if (!s && !sessionId) return

  editingSessionId = sessionId
  editingSessionData = s

  // Fetch fresh session data if not in store
  fetch('/api/sessions?limit=500')
    .then(r => r.json())
    .then(data => {
      const sess = (data.sessions || []).find(x => x.id === sessionId)
      if (!sess) { showAdminToast('Session not found', 'error'); return }
      editingSessionData = sess

      document.getElementById('sem-worker-label').textContent = sess.worker_name || 'Worker'

      // Convert UTC timestamps to local datetime-local format
      const toLocal = (dt) => {
        if (!dt) return ''
        const d = new Date(dt)
        const pad = n => String(n).padStart(2,'0')
        return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
      }
      document.getElementById('sem-clock-in').value  = toLocal(sess.clock_in_time)
      document.getElementById('sem-clock-out').value = toLocal(sess.clock_out_time)
      document.getElementById('sem-reason').value    = ''
      document.getElementById('sem-new-hours').classList.add('hidden')

      document.getElementById('session-edit-modal').classList.remove('hidden')
      document.body.style.overflow = 'hidden'

      // Live preview of new hours
      const preview = () => {
        const inVal  = document.getElementById('sem-clock-in').value
        const outVal = document.getElementById('sem-clock-out').value
        const el     = document.getElementById('sem-new-hours')
        if (inVal && outVal) {
          const h = Math.round(((new Date(outVal) - new Date(inVal)) / 3600000) * 100) / 100
          const rate = sess.hourly_rate || 0
          if (h > 0) {
            el.textContent = `New total: ${h.toFixed(2)}h → $${(h * rate).toFixed(2)} earnings`
            el.classList.remove('hidden')
          } else {
            el.textContent = '⚠ Clock-out must be after clock-in'
            el.classList.remove('hidden')
          }
        } else {
          el.classList.add('hidden')
        }
      }
      document.getElementById('sem-clock-in').addEventListener('input', preview)
      document.getElementById('sem-clock-out').addEventListener('input', preview)
    })
    .catch(() => showAdminToast('Failed to load session', 'error'))
}

function closeSessionEditModal() {
  document.getElementById('session-edit-modal').classList.add('hidden')
  document.body.style.overflow = ''
  editingSessionId = null
  editingSessionData = null
}

async function confirmSessionEdit() {
  const btn = document.getElementById('sem-confirm-btn')
  const reason = document.getElementById('sem-reason').value.trim()
  if (!reason) { showAdminToast('Please enter a reason for the edit', 'error'); return }

  const inVal  = document.getElementById('sem-clock-in').value
  const outVal = document.getElementById('sem-clock-out').value

  if (!inVal) { showAdminToast('Clock-in time is required', 'error'); return }

  // Validate out > in if out provided
  if (outVal && new Date(outVal) <= new Date(inVal)) {
    showAdminToast('Clock-out must be after clock-in', 'error'); return
  }

  btn.disabled = true
  btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>Saving...'

  try {
    const toISO = (localStr) => localStr ? new Date(localStr).toISOString() : null
    const res = await fetch(`/api/sessions/${editingSessionId}/edit`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clock_in_time:  toISO(inVal),
        clock_out_time: toISO(outVal) || null,
        reason
      })
    })
    const data = await res.json()
    if (data.success) {
      showAdminToast(`✅ Session updated — ${data.new_hours}h / $${data.new_earnings.toFixed(2)}`, 'success')
      closeSessionEditModal()
      loadSessions()
      loadStats()
    } else {
      showAdminToast(data.error || 'Save failed', 'error')
      btn.disabled = false
      btn.innerHTML = '<i class="fas fa-save mr-1.5"></i>Save Changes'
    }
  } catch(e) {
    showAdminToast('Connection error', 'error')
    btn.disabled = false
    btn.innerHTML = '<i class="fas fa-save mr-1.5"></i>Save Changes'
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE 2 — JOB SITES MANAGER
// ═══════════════════════════════════════════════════════════════════════════════

let editingSiteId = null

async function loadJobSites() {
  try {
    const res  = await fetch('/api/job-sites')
    const data = await res.json()
    const sites = data.sites || []
    const el = document.getElementById('job-sites-list')
    if (!el) return

    if (sites.length === 0) {
      el.innerHTML = '<p class="text-gray-400 text-sm text-center py-8"><i class="fas fa-map-marker-alt text-3xl mb-3 block text-gray-300"></i>No job sites added yet. Click "Add Site" to get started.</p>'
      return
    }

    el.innerHTML = sites.map(s => `
      <div class="flex items-center justify-between bg-gray-50 border border-gray-200 rounded-2xl p-4 hover:border-emerald-300 transition-colors group">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-10 h-10 bg-emerald-100 rounded-xl flex items-center justify-center flex-shrink-0">
            <i class="fas fa-map-marker-alt text-emerald-600"></i>
          </div>
          <div class="min-w-0">
            <p class="font-semibold text-gray-800 text-sm">${s.name}</p>
            <p class="text-xs text-gray-500 truncate">${s.address}</p>
            ${s.lat ? `<a href="https://maps.google.com/?q=${s.lat},${s.lng}" target="_blank" class="text-xs text-blue-500 hover:underline"><i class="fas fa-external-link-alt mr-1"></i>View on map</a>` : ''}
          </div>
        </div>
        <div class="flex gap-2 flex-shrink-0 ml-3">
          <button onclick="openEditSiteModal(${s.id},'${encodeURIComponent(s.name)}','${encodeURIComponent(s.address)}')"
            class="text-xs bg-white border border-gray-200 hover:border-amber-400 text-gray-600 hover:text-amber-600 px-3 py-1.5 rounded-lg transition-colors">
            <i class="fas fa-edit mr-1"></i>Edit
          </button>
          <button onclick="deleteSite(${s.id},'${s.name.replace(/'/g,'\\\'')}')"
            class="text-xs bg-white border border-gray-200 hover:border-red-400 text-gray-600 hover:text-red-600 px-3 py-1.5 rounded-lg transition-colors">
            <i class="fas fa-trash-alt mr-1"></i>Remove
          </button>
        </div>
      </div>
    `).join('')
  } catch(e) {
    showAdminToast('Failed to load job sites', 'error')
  }
}

function openAddSiteModal() {
  editingSiteId = null
  document.getElementById('site-modal-title').textContent = 'Add Job Site'
  document.getElementById('site-name').value    = ''
  document.getElementById('site-address').value = ''
  document.getElementById('site-save-btn').innerHTML = '<i class="fas fa-save mr-1.5"></i>Save Site'
  document.getElementById('site-modal').classList.remove('hidden')
  document.body.style.overflow = 'hidden'
  setTimeout(() => document.getElementById('site-name').focus(), 200)
}

function openEditSiteModal(id, name, address) {
  editingSiteId = id
  document.getElementById('site-modal-title').textContent = 'Edit Job Site'
  document.getElementById('site-name').value    = decodeURIComponent(name)
  document.getElementById('site-address').value = decodeURIComponent(address)
  document.getElementById('site-save-btn').innerHTML = '<i class="fas fa-save mr-1.5"></i>Update Site'
  document.getElementById('site-modal').classList.remove('hidden')
  document.body.style.overflow = 'hidden'
}

function closeSiteModal() {
  document.getElementById('site-modal').classList.add('hidden')
  document.body.style.overflow = ''
  editingSiteId = null
}

async function saveSite() {
  const name    = document.getElementById('site-name').value.trim()
  const address = document.getElementById('site-address').value.trim()
  if (!name)    { showAdminToast('Site name is required', 'error'); return }
  if (!address) { showAdminToast('Address is required', 'error'); return }

  const btn = document.getElementById('site-save-btn')
  btn.disabled = true
  btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1.5"></i>Saving...'

  try {
    const url    = editingSiteId ? `/api/job-sites/${editingSiteId}` : '/api/job-sites'
    const method = editingSiteId ? 'PUT' : 'POST'
    const res    = await fetch(url, {
      method, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, address })
    })
    const data = await res.json()
    if (data.success || data.id) {
      showAdminToast(editingSiteId ? '✅ Site updated' : '✅ Site added', 'success')
      closeSiteModal()
      loadJobSites()
    } else {
      showAdminToast(data.error || 'Save failed', 'error')
    }
  } catch(e) {
    showAdminToast('Connection error', 'error')
  } finally {
    btn.disabled = false
    btn.innerHTML = editingSiteId ? '<i class="fas fa-save mr-1.5"></i>Update Site' : '<i class="fas fa-save mr-1.5"></i>Save Site'
  }
}

async function deleteSite(id, name) {
  if (!confirm(`Remove "${name}" from job sites? Workers will no longer see it in the dropdown.`)) return
  try {
    const res = await fetch(`/api/job-sites/${id}`, { method: 'DELETE' })
    const data = await res.json()
    if (data.success) {
      showAdminToast('Site removed', 'info')
      loadJobSites()
    }
  } catch(e) {
    showAdminToast('Failed to remove site', 'error')
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE 3 — ISSUE REPORTS (DISPUTES)
// ═══════════════════════════════════════════════════════════════════════════════

async function loadDisputes() {
  try {
    const res  = await fetch('/api/disputes?status=pending')
    const data = await res.json()
    const disputes = data.disputes || []
    const listEl  = document.getElementById('disputes-list')
    const badge   = document.getElementById('disputes-badge')
    const countBadge = document.getElementById('disputes-count-badge')

    // Update sidebar badge
    if (badge) {
      if (disputes.length > 0) { badge.textContent = disputes.length; badge.classList.remove('hidden') }
      else badge.classList.add('hidden')
    }
    if (countBadge) {
      countBadge.textContent = disputes.length > 0 ? `${disputes.length} pending` : 'All clear'
      countBadge.className = disputes.length > 0
        ? 'bg-rose-100 text-rose-700 text-sm font-bold px-3 py-1 rounded-full'
        : 'bg-green-100 text-green-700 text-sm font-bold px-3 py-1 rounded-full'
    }

    if (!listEl) return
    if (disputes.length === 0) {
      listEl.innerHTML = '<p class="text-gray-400 text-sm text-center py-8"><i class="fas fa-check-circle text-green-400 text-3xl mb-3 block"></i>No pending issue reports.</p>'
      return
    }

    listEl.innerHTML = disputes.map(d => {
      const sessionDate = d.clock_in_time ? new Date(d.clock_in_time).toLocaleDateString([], {weekday:'short', month:'short', day:'numeric'}) : '—'
      const hours   = d.total_hours  ? d.total_hours.toFixed(2) + 'h'   : '—'
      const earn    = d.earnings     ? '$' + d.earnings.toFixed(2) : '—'
      return `
      <div class="border-2 border-rose-200 rounded-2xl p-5 bg-rose-50" id="dispute-card-${d.id}">
        <div class="flex items-start justify-between gap-3 mb-3">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 bg-rose-100 rounded-2xl flex items-center justify-center flex-shrink-0">
              <i class="fas fa-flag text-rose-500"></i>
            </div>
            <div>
              <p class="font-bold text-gray-800">${d.worker_name || 'Worker'}</p>
              <p class="text-xs text-gray-500">${sessionDate} &bull; ${hours} &bull; ${earn}</p>
              ${d.job_location ? `<p class="text-xs text-gray-500 mt-0.5"><i class="fas fa-map-marker-alt text-red-400 mr-1"></i>${d.job_location}</p>` : ''}
            </div>
          </div>
          <span class="bg-rose-500 text-white text-xs font-bold px-2.5 py-1 rounded-full flex-shrink-0">REPORT</span>
        </div>
        <div class="bg-white border border-rose-200 rounded-xl p-3 mb-3">
          <p class="text-xs text-gray-500 font-medium mb-1"><i class="fas fa-comment-alt mr-1 text-rose-400"></i>Worker's message</p>
          <p class="text-sm text-gray-800">${d.message}</p>
        </div>
        <div class="mb-3">
          <input type="text" id="dispute-response-${d.id}" placeholder="Optional response to worker (will be shown to them)"
            class="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-rose-400"/>
        </div>
        <div class="flex gap-2 flex-wrap">
          <button onclick="resolveDispute(${d.id}, 'resolved')" class="flex-1 bg-green-500 hover:bg-green-600 text-white font-bold py-2.5 rounded-xl text-sm">
            <i class="fas fa-check mr-1"></i>Resolve
          </button>
          <button onclick="openSessionEditModal(${d.session_id})" class="flex-1 bg-amber-500 hover:bg-amber-600 text-white font-bold py-2.5 rounded-xl text-sm">
            <i class="fas fa-edit mr-1"></i>Edit Session
          </button>
          <button onclick="resolveDispute(${d.id}, 'dismissed')" class="px-4 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-600 rounded-xl text-sm border border-gray-200">
            Dismiss
          </button>
        </div>
      </div>`
    }).join('')
  } catch(e) {
    showAdminToast('Failed to load issue reports', 'error')
  }
}

async function resolveDispute(id, status) {
  const responseEl = document.getElementById('dispute-response-' + id)
  const admin_response = responseEl ? responseEl.value.trim() : ''
  const label = status === 'resolved' ? 'resolve' : 'dismiss'
  if (!confirm(`${label.charAt(0).toUpperCase() + label.slice(1)} this issue report?`)) return
  try {
    const res = await fetch(`/api/disputes/${id}/resolve`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, admin_response })
    })
    const data = await res.json()
    if (data.success) {
      showAdminToast(`Report ${status}`, 'success')
      loadDisputes()
    }
  } catch(e) {
    showAdminToast('Connection error', 'error')
  }
}

async function loadDisputeHistory() {
  try {
    const el = document.getElementById('disputes-history')
    if (!el) return
    el.classList.toggle('hidden')
    if (el.classList.contains('hidden')) return

    const res  = await fetch('/api/disputes?status=resolved')
    const data = await res.json()
    const disputes = data.disputes || []
    if (disputes.length === 0) { el.innerHTML = '<p class="text-xs text-gray-400 text-center py-3">No resolved reports.</p>'; return }

    el.innerHTML = disputes.map(d => {
      const sc = d.status === 'resolved' ? 'text-green-600 bg-green-100' : 'text-gray-500 bg-gray-100'
      return `<div class="bg-gray-50 rounded-xl px-4 py-3 border border-gray-200 text-sm">
        <div class="flex items-center justify-between mb-1">
          <span class="font-semibold text-gray-800">${d.worker_name}</span>
          <span class="text-xs font-bold px-2 py-0.5 rounded-full ${sc}">${d.status.toUpperCase()}</span>
        </div>
        <p class="text-xs text-gray-600">${d.message}</p>
        ${d.admin_response ? `<p class="text-xs text-blue-600 mt-1"><i class="fas fa-reply mr-1"></i>${d.admin_response}</p>` : ''}
        <p class="text-xs text-gray-400 mt-1">${new Date(d.created_at).toLocaleString()}</p>
      </div>`
    }).join('')
  } catch(e) { /* silent */ }
}


// ── Admin Job Site Address Autocomplete (Nominatim) ───────────────────────────
let siteAcTimer = null

async function filterSiteAddressSuggestions(val) {
  const box = document.getElementById('site-address-suggestions')
  if (!box) return
  clearTimeout(siteAcTimer)
  if (!val || val.length < 4) { box.classList.add('hidden'); return }

  box.innerHTML = '<div class="px-4 py-3 text-xs text-gray-400"><i class="fas fa-circle-notch fa-spin mr-2"></i>Searching addresses...</div>'
  box.classList.remove('hidden')

  siteAcTimer = setTimeout(async () => {
    try {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(val)}&format=json&limit=6&addressdetails=1&accept-language=en`
      const res  = await fetch(url, { headers: { 'Accept-Language': 'en' } })
      const data = await res.json()

      if (!data || data.length === 0) {
        box.innerHTML = '<div class="px-4 py-3 text-xs text-gray-400">No suggestions found. Try a more specific address.</div>'
        return
      }

      box.innerHTML = data.map(r => {
        const addr = r.address || {}
        const short = [
          addr.house_number, addr.road,
          addr.city || addr.town || addr.village || addr.municipality,
          addr.state,
          addr.country_code?.toUpperCase()
        ].filter(Boolean).join(', ')

        return `<button
          class="w-full text-left px-4 py-3 hover:bg-emerald-50 text-sm text-gray-700 border-b border-gray-100 last:border-0 flex items-start gap-3"
          onmousedown="event.preventDefault()"
          onclick="selectSiteAddress('${short.replace(/'/g,"\\'").replace(/"/g,'&quot;')}')">
          <i class="fas fa-map-marker-alt text-red-400 mt-0.5 flex-shrink-0 text-xs"></i>
          <span>${short}</span>
        </button>`
      }).join('')
    } catch(_) {
      box.innerHTML = '<div class="px-4 py-3 text-xs text-red-400">Could not fetch suggestions. Check connection.</div>'
    }
  }, 350)
}

function selectSiteAddress(address) {
  const input = document.getElementById('site-address')
  if (input) input.value = address
  const box = document.getElementById('site-address-suggestions')
  if (box) box.classList.add('hidden')
}

// ═══════════════════════════════════════════════════════════════════════════
// QUICKBOOKS OAUTH INTEGRATION
// ═══════════════════════════════════════════════════════════════════════════

let qbStatus = null  // cache: {connected, token_valid, company_name, ...}
let qbEmployees = []  // QB employee list
let qbWorkers = []   // Our workers with mapping status

// ── Update status badges in the Settings tab QB section ──────────────────
async function updateQbSettingsStatus() {
  try {
    const res = await fetch('/api/qb/status')
    if (!res.ok) return
    qbStatus = await res.json()
    const dot = document.getElementById('qb-status-dot')
    const text = document.getElementById('qb-status-text')
    const company = document.getElementById('qb-company-name-display')
    const connectBtn = document.getElementById('qb-connect-btn')
    const disconnectBtn = document.getElementById('qb-disconnect-btn')
    const badge = document.getElementById('qb-nav-badge')

    if (qbStatus.connected && qbStatus.token_valid) {
      if (dot) dot.className = 'w-3 h-3 rounded-full bg-green-500 flex-shrink-0'
      if (text) text.textContent = '✅ Connected to QuickBooks'
      if (company) company.textContent = qbStatus.company_name || `Realm: ${qbStatus.realm_id}`
      if (connectBtn) connectBtn.style.display = 'none'
      if (disconnectBtn) disconnectBtn.style.display = ''
      if (badge) { badge.textContent = '●'; badge.className = 'ml-auto text-[10px] text-white font-bold bg-green-500 px-1.5 py-0.5 rounded-full' }
    } else if (qbStatus.connected && !qbStatus.token_valid) {
      if (dot) dot.className = 'w-3 h-3 rounded-full bg-yellow-500 flex-shrink-0'
      if (text) text.textContent = '⚠️ Token expired — reconnect needed'
      if (company) company.textContent = qbStatus.company_name || ''
      if (connectBtn) { connectBtn.style.display = ''; connectBtn.textContent = 'Reconnect' }
      if (disconnectBtn) disconnectBtn.style.display = 'none'
      if (badge) { badge.textContent = '!'; badge.className = 'ml-auto text-[10px] text-white font-bold bg-yellow-500 px-1.5 py-0.5 rounded-full' }
    } else {
      if (dot) dot.className = 'w-3 h-3 rounded-full bg-gray-300 flex-shrink-0'
      if (text) text.textContent = qbStatus.has_client_id ? 'Not connected — click Connect to authorize' : 'Enter Client ID & Secret in Settings, then click Connect'
      if (company) company.textContent = ''
      if (connectBtn) connectBtn.style.display = ''
      if (disconnectBtn) disconnectBtn.style.display = 'none'
      if (badge) badge.className = 'ml-auto text-[10px] text-white font-bold bg-gray-400 px-1.5 py-0.5 rounded-full hidden'
    }
  } catch (e) { console.warn('QB status check failed:', e) }
}

// ── Connect: open OAuth popup ─────────────────────────────────────────────
function qbConnect() {
  const popup = window.open('/api/qb/connect', 'QuickBooks Connect',
    'width=600,height=700,scrollbars=yes,resizable=yes')
  if (!popup) {
    showAdminToast('Popup blocked — allow popups for this site then try again', 'error')
    return
  }
  // Listen for callback message
  const handler = async (e) => {
    if (e.data?.type !== 'qb_oauth') return
    window.removeEventListener('message', handler)
    if (e.data.success) {
      showAdminToast('✅ QuickBooks connected successfully!', 'success')
      await updateQbSettingsStatus()
      if (document.getElementById('tab-quickbooks')?.classList.contains('block')) {
        initQbTabFull()
      }
    } else {
      showAdminToast(`QB connection failed: ${e.data.msg || e.data.error || 'unknown error'}`, 'error')
    }
  }
  window.addEventListener('message', handler)
}

// ── Disconnect ────────────────────────────────────────────────────────────
async function qbDisconnect() {
  if (!confirm('Disconnect QuickBooks? Saved tokens will be cleared. Your QB data stays intact.')) return
  try {
    const res = await fetch('/api/qb/disconnect', { method: 'POST' })
    const data = await res.json()
    if (data.success) {
      showAdminToast('Disconnected from QuickBooks', 'info')
      qbStatus = null
      await updateQbSettingsStatus()
      initQbTabFull()
    }
  } catch (e) { showAdminToast('Disconnect error: ' + e.message, 'error') }
}

// ── Full QB tab initialization ────────────────────────────────────────────
async function initQbTabFull() {
  try {
    const res = await fetch('/api/qb/status')
    if (!res.ok) return
    qbStatus = await res.json()
  } catch { qbStatus = { connected: false } }

  const statusCard = document.getElementById('qb-tab-status-card')
  const statusIcon = document.getElementById('qb-tab-status-icon')
  const statusTitle = document.getElementById('qb-tab-status-title')
  const statusSub = document.getElementById('qb-tab-status-sub')
  const connectBtn = document.getElementById('qb-tab-connect-btn')
  const disconnectBtn = document.getElementById('qb-tab-disconnect-btn')
  const setupSteps = document.getElementById('qb-setup-steps')
  const mappingSection = document.getElementById('qb-mapping-section')
  const syncSection = document.getElementById('qb-sync-section')
  const logSection = document.getElementById('qb-log-section')

  if (qbStatus.connected && qbStatus.token_valid) {
    // Connected & healthy
    if (statusCard) { statusCard.className = 'rounded-2xl border-2 border-green-200 bg-green-50 p-5 mb-6 flex items-center gap-4' }
    if (statusIcon) statusIcon.innerHTML = '<i class="fas fa-check-circle text-green-600"></i>'
    if (statusTitle) statusTitle.textContent = '✅ Connected to QuickBooks'
    if (statusSub) statusSub.textContent = qbStatus.company_name ? `Company: ${qbStatus.company_name}` : `Realm ID: ${qbStatus.realm_id}`
    if (connectBtn) connectBtn.className = connectBtn.className.replace('hidden', '') + ' hidden'
    if (disconnectBtn) disconnectBtn.classList.remove('hidden')
    if (setupSteps) setupSteps.classList.add('hidden')
    if (mappingSection) mappingSection.classList.remove('hidden')
    if (syncSection) syncSection.classList.remove('hidden')
    if (logSection) logSection.classList.remove('hidden')
    // Load data
    loadQbMapping()
    loadQbSyncLog()
    setQbSyncPeriod('last_period')
  } else if (qbStatus.connected && !qbStatus.token_valid) {
    if (statusCard) { statusCard.className = 'rounded-2xl border-2 border-yellow-200 bg-yellow-50 p-5 mb-6 flex items-center gap-4' }
    if (statusIcon) statusIcon.innerHTML = '<i class="fas fa-exclamation-triangle text-yellow-500"></i>'
    if (statusTitle) statusTitle.textContent = '⚠️ Token Expired'
    if (statusSub) statusSub.textContent = 'Your QuickBooks access token has expired. Please reconnect.'
    if (connectBtn) { connectBtn.classList.remove('hidden'); connectBtn.textContent = '🔄 Reconnect to QuickBooks' }
    if (disconnectBtn) disconnectBtn.classList.add('hidden')
    if (setupSteps) setupSteps.classList.add('hidden')
  } else {
    if (statusCard) { statusCard.className = 'rounded-2xl border-2 border-gray-200 bg-gray-50 p-5 mb-6 flex items-center gap-4' }
    if (statusIcon) statusIcon.innerHTML = '<i class="fas fa-unlink text-gray-400"></i>'
    if (statusTitle) statusTitle.textContent = qbStatus.has_client_id ? 'Not connected — authorize ClockInProof in QuickBooks' : 'Setup Required — enter Client ID & Secret in Settings'
    if (statusSub) statusSub.textContent = qbStatus.has_client_id ? 'Click Connect to open the QuickBooks authorization window' : 'Go to Settings → QuickBooks Direct Connect section'
    if (connectBtn) {
      connectBtn.classList.remove('hidden')
      connectBtn.textContent = qbStatus.has_client_id ? '🔗 Connect to QuickBooks' : '⚙️ Go to Settings'
      if (!qbStatus.has_client_id) {
        connectBtn.onclick = () => showTab('settings')
      } else {
        connectBtn.onclick = qbConnect
      }
    }
    if (disconnectBtn) disconnectBtn.classList.add('hidden')
    if (setupSteps) setupSteps.classList.remove('hidden')
    if (mappingSection) mappingSection.classList.add('hidden')
    if (syncSection) syncSection.classList.add('hidden')
    if (logSection) logSection.classList.add('hidden')
  }
}

// ── Load employee mapping ─────────────────────────────────────────────────
async function loadQbMapping() {
  const list = document.getElementById('qb-mapping-list')
  if (!list) return
  list.innerHTML = '<p class="text-gray-400 text-sm text-center py-4"><i class="fas fa-spinner fa-spin mr-2"></i>Loading QB employees…</p>'

  try {
    const [empRes, workerRes] = await Promise.all([
      fetch('/api/qb/employees'),
      fetch('/api/qb/workers')
    ])
    if (!empRes.ok) {
      const err = await empRes.json()
      list.innerHTML = `<p class="text-red-500 text-sm p-4"><i class="fas fa-exclamation-circle mr-2"></i>${err.error || 'Failed to load QB employees'}</p>`
      return
    }
    const empData = await empRes.json()
    const workerData = await workerRes.json()
    qbEmployees = empData.employees || []
    qbWorkers = workerData.workers || []

    if (!qbWorkers.length) {
      list.innerHTML = '<p class="text-gray-400 text-sm text-center py-4">No active workers found. Add workers first.</p>'
      return
    }

    // Build employee dropdown options
    const empOptions = qbEmployees.map(e => 
      `<option value="${e.id}" data-name="${e.name}">${e.name} ${e.display_name && e.display_name !== e.name ? '('+e.display_name+')' : ''}</option>`
    ).join('')

    list.innerHTML = qbWorkers.map(w => {
      const isMapped = !!w.qb_employee_id
      // Try to auto-suggest a QB employee with matching name
      const suggested = qbEmployees.find(e => e.name.toLowerCase().includes(w.name.toLowerCase().split(' ')[0]) || w.name.toLowerCase().includes(e.name.toLowerCase().split(' ')[0]))
      return `
      <div class="flex items-center gap-3 p-3 rounded-xl border ${isMapped ? 'border-green-200 bg-green-50' : 'border-gray-100 bg-white'}" id="qb-worker-row-${w.id}">
        <div class="w-9 h-9 rounded-xl bg-indigo-100 flex items-center justify-center flex-shrink-0 text-indigo-600 font-bold text-sm">
          ${(w.name || '?').charAt(0).toUpperCase()}
        </div>
        <div class="flex-1 min-w-0">
          <p class="font-semibold text-gray-800 text-sm truncate">${w.name}</p>
          <p class="text-xs text-gray-400">${w.job_title || w.phone || ''}</p>
        </div>
        <div class="flex items-center gap-2 flex-shrink-0">
          ${isMapped ? `
            <span class="text-xs text-green-700 font-medium bg-green-100 px-2 py-0.5 rounded-full">
              <i class="fas fa-check mr-1"></i>Linked: ${w.qb_employee_name}
            </span>
            <button onclick="qbUnmapWorker(${w.id})" class="text-xs text-red-400 hover:text-red-600 px-2 py-1 rounded-lg hover:bg-red-50 transition-colors">
              <i class="fas fa-unlink"></i> Unlink
            </button>
          ` : `
            <div class="flex flex-col gap-1">
              <label class="text-xs text-gray-400">Link to QuickBooks employee:</label>
              <div class="flex items-center gap-2">
                <select id="qb-emp-select-${w.id}"
                  class="text-sm border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-green-400 max-w-[200px]">
                  <option value="">— Select QB employee —</option>
                  ${empOptions}
                </select>
                <button onclick="qbMapWorker(${w.id})" 
                  class="px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-xs font-bold rounded-lg transition-colors whitespace-nowrap">
                  <i class="fas fa-link mr-1"></i>Link
                </button>
              </div>
              ${suggested ? `<p class="text-xs text-indigo-500"><i class="fas fa-lightbulb mr-1"></i>Suggested: ${suggested.name}</p>` : ''}
            </div>
          `}
        </div>
      </div>`
    }).join('')

    if (!qbEmployees.length) {
      list.insertAdjacentHTML('beforeend', `
        <div class="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-700">
          <i class="fas fa-info-circle mr-1"></i>
          No QB employees found. Make sure employees are set up in your QuickBooks Online company.
        </div>`)
    }
  } catch (e) {
    list.innerHTML = `<p class="text-red-500 text-sm p-4"><i class="fas fa-exclamation-circle mr-2"></i>${e.message}</p>`
  }
}

async function qbMapWorker(workerId) {
  const select = document.getElementById(`qb-emp-select-${workerId}`)
  if (!select?.value) { showAdminToast('Please select a QB employee', 'error'); return }
  const opt = select.options[select.selectedIndex]
  const empName = opt.dataset.name || opt.text
  try {
    const res = await fetch('/api/qb/map', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ worker_id: workerId, qb_employee_id: select.value, qb_employee_name: empName })
    })
    const data = await res.json()
    if (data.success) {
      showAdminToast(`✅ Mapped to ${empName}`, 'success')
      loadQbMapping()
    } else {
      showAdminToast(data.error || 'Mapping failed', 'error')
    }
  } catch (e) { showAdminToast(e.message, 'error') }
}

async function qbUnmapWorker(workerId) {
  if (!confirm('Remove this QB mapping?')) return
  try {
    await fetch(`/api/qb/map/${workerId}`, { method: 'DELETE' })
    showAdminToast('Mapping removed', 'info')
    loadQbMapping()
  } catch (e) { showAdminToast(e.message, 'error') }
}

// Auto-match workers to QB employees by name similarity
async function qbAutoMap() {
  if (!qbWorkers.length || !qbEmployees.length) {
    showAdminToast('Load mapping first', 'error'); return
  }
  let matched = 0
  for (const w of qbWorkers) {
    if (w.qb_employee_id) continue // already mapped
    const match = qbEmployees.find(e => 
      e.name.toLowerCase() === w.name.toLowerCase() ||
      e.name.toLowerCase().includes(w.name.toLowerCase().split(' ')[0]) ||
      w.name.toLowerCase().includes(e.name.toLowerCase().split(' ')[0])
    )
    if (match) {
      try {
        const res = await fetch('/api/qb/map', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ worker_id: w.id, qb_employee_id: match.id, qb_employee_name: match.name })
        })
        const data = await res.json()
        if (data.success) matched++
      } catch (e) {}
    }
  }
  if (matched > 0) {
    showAdminToast(`✅ Auto-matched ${matched} worker(s)`, 'success')
    loadQbMapping()
  } else {
    showAdminToast('No automatic matches found — please link manually', 'info')
  }
}

// ── Set sync date range ───────────────────────────────────────────────────
async function setQbSyncPeriod(type) {
  const startEl = document.getElementById('qb-sync-start')
  const endEl = document.getElementById('qb-sync-end')
  if (!startEl || !endEl) return

  const today = new Date()
  const fmt = d => d.toISOString().split('T')[0]

  if (type === 'this_month') {
    startEl.value = fmt(new Date(today.getFullYear(), today.getMonth(), 1))
    endEl.value = fmt(today)
    return
  }

  // Load pay periods
  try {
    if (!qbPayPeriods.length) {
      const res = await fetch('/api/pay-periods')
      const data = await res.json()
      qbPayPeriods = data.periods || []
    }
    const todayStr = fmt(today)
    const past = qbPayPeriods.filter(p => p.end <= todayStr)
    const current = qbPayPeriods.find(p => p.start <= todayStr && p.end >= todayStr)

    if (type === 'last_period' && past.length > 0) {
      const last = past[past.length - 1]
      startEl.value = last.start
      endEl.value = last.end
    } else if (type === 'this_period' && current) {
      startEl.value = current.start
      endEl.value = current.end
    } else {
      // Fallback to this month
      startEl.value = fmt(new Date(today.getFullYear(), today.getMonth(), 1))
      endEl.value = fmt(today)
    }
  } catch {
    startEl.value = fmt(new Date(today.getFullYear(), today.getMonth(), 1))
    endEl.value = fmt(today)
  }
}

// ── Run sync ──────────────────────────────────────────────────────────────
async function runQbSync(dryRun) {
  const start = document.getElementById('qb-sync-start')?.value
  const end = document.getElementById('qb-sync-end')?.value
  const resultsEl = document.getElementById('qb-sync-results')

  if (!start || !end) { showAdminToast('Please select a date range', 'error'); return }
  if (!resultsEl) return

  resultsEl.classList.remove('hidden')
  resultsEl.className = 'rounded-2xl border border-gray-200 bg-gray-50 p-4 text-sm'
  resultsEl.innerHTML = `<p class="text-gray-500 text-center py-4"><i class="fas fa-spinner fa-spin mr-2"></i>${dryRun ? 'Running preview…' : 'Pushing to QuickBooks…'}</p>`

  try {
    const res = await fetch('/api/qb/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start, end, dry_run: dryRun })
    })
    const data = await res.json()

    if (!res.ok || data.error) {
      resultsEl.className = 'rounded-2xl border border-red-200 bg-red-50 p-4 text-sm'
      resultsEl.innerHTML = `<p class="text-red-600 font-semibold"><i class="fas fa-exclamation-circle mr-2"></i>${data.error || 'Sync failed'}</p>`
      return
    }

    const isSuccess = data.errors === 0
    resultsEl.className = `rounded-2xl border p-4 text-sm ${isSuccess ? 'border-green-200 bg-green-50' : 'border-yellow-200 bg-yellow-50'}`

    let html = `
      <div class="flex items-center gap-2 mb-3">
        <span class="text-lg">${dryRun ? '👁️' : (isSuccess ? '✅' : '⚠️')}</span>
        <span class="font-bold text-gray-800">${dryRun ? 'Preview Results' : (isSuccess ? 'Sync Complete!' : 'Sync Completed with Errors')}</span>
        <span class="ml-auto text-xs text-gray-500">${data.period}</span>
      </div>
      <div class="grid grid-cols-3 gap-3 mb-3">
        <div class="text-center p-2 bg-white rounded-xl border border-gray-100">
          <p class="text-xl font-bold text-indigo-600">${data.total_sessions}</p>
          <p class="text-xs text-gray-500">Sessions Found</p>
        </div>
        <div class="text-center p-2 bg-white rounded-xl border border-gray-100">
          <p class="text-xl font-bold text-green-600">${data.pushed}</p>
          <p class="text-xs text-gray-500">${dryRun ? 'Would Push' : 'Pushed'}</p>
        </div>
        <div class="text-center p-2 bg-white rounded-xl border border-gray-100">
          <p class="text-xl font-bold text-red-500">${data.errors}</p>
          <p class="text-xs text-gray-500">Errors</p>
        </div>
      </div>`

    if (data.unmapped_workers?.length > 0) {
      html += `
        <div class="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-3 text-xs text-amber-700">
          <i class="fas fa-exclamation-triangle mr-1"></i>
          <strong>Unmapped workers (sessions skipped):</strong> ${data.unmapped_workers.join(', ')}
          <br>Go to the Employee Mapping section above to map these workers.
        </div>`
    }

    if (data.results?.length > 0) {
      html += `<div class="space-y-1 max-h-48 overflow-y-auto mt-2">`
      data.results.forEach(r => {
        const icon = r.status === 'success' ? '✅' : r.status === 'dry_run' ? '👁️' : r.status === 'skipped' ? '⏭️' : '❌'
        const color = r.status === 'success' ? 'text-green-700' : r.status === 'error' ? 'text-red-600' : 'text-gray-500'
        html += `<div class="flex items-center gap-2 text-xs ${color}">
          <span>${icon}</span>
          <span class="font-medium">${r.worker}</span>
          <span class="text-gray-400">Session #${r.session_id}</span>
          ${r.qb_id ? `<span class="ml-auto text-green-600 font-mono">QB:${r.qb_id}</span>` : ''}
          ${r.reason ? `<span class="ml-auto text-gray-400">${r.reason}</span>` : ''}
        </div>`
      })
      html += `</div>`
    }

    if (!dryRun && isSuccess && data.pushed > 0) {
      html += `
        <div class="mt-3 p-3 bg-green-100 rounded-xl text-xs text-green-800">
          <i class="fas fa-info-circle mr-1"></i>
          Hours are now in QuickBooks! Go to <strong>QuickBooks → Payroll → Run Payroll</strong> and the time will be pre-populated.
        </div>`
      loadQbSyncLog()
    }

    resultsEl.innerHTML = html
  } catch (e) {
    resultsEl.className = 'rounded-2xl border border-red-200 bg-red-50 p-4 text-sm'
    resultsEl.innerHTML = `<p class="text-red-600"><i class="fas fa-exclamation-circle mr-2"></i>${e.message}</p>`
  }
}

// ── Sync history log ──────────────────────────────────────────────────────
async function loadQbSyncLog() {
  const logEl = document.getElementById('qb-sync-log')
  if (!logEl) return
  try {
    const res = await fetch('/api/qb/sync-log')
    const data = await res.json()
    const logs = data.logs || []
    if (!logs.length) {
      logEl.innerHTML = '<p class="text-gray-400 text-xs text-center py-2">No syncs yet</p>'
      return
    }
    logEl.innerHTML = logs.map(l => {
      const d = new Date(l.synced_at)
      const dateStr = d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      const isOk = l.status === 'success'
      return `
        <div class="flex items-center gap-3 p-3 rounded-xl border ${isOk ? 'border-green-100 bg-green-50' : 'border-yellow-100 bg-yellow-50'}">
          <span class="text-base">${isOk ? '✅' : '⚠️'}</span>
          <div class="flex-1 min-w-0">
            <p class="text-xs font-semibold text-gray-700">${l.pay_period_start} → ${l.pay_period_end}</p>
            <p class="text-xs text-gray-500">${l.worker_count} workers · ${l.time_activity_count} activities ${l.error_message ? '· ' + l.error_message : ''}</p>
          </div>
          <span class="text-xs text-gray-400 flex-shrink-0">${dateStr}</span>
        </div>`
    }).join('')
  } catch (e) {
    logEl.innerHTML = `<p class="text-xs text-red-400 text-center py-2">${e.message}</p>`
  }
}

// ── Boot: check QB status on page load ───────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  setTimeout(updateQbSettingsStatus, 1500)

  // Close modals with ESC key
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return
    // Delete worker modal
    const dwModal = document.getElementById('delete-worker-modal')
    if (dwModal && !dwModal.classList.contains('hidden')) { closeDeleteWorkerModal(); return }
    // Admin clock-out modal
    const acoModal = document.getElementById('admin-clockout-modal')
    if (acoModal && !acoModal.classList.contains('hidden')) { closeAdminClockoutModal(); return }
    // Bulk clock-out modal
    const bcoModal = document.getElementById('bulk-clockout-modal')
    if (bcoModal && !bcoModal.classList.contains('hidden')) { closeBulkClockoutModal(); return }
    // Session modal
    const smModal = document.getElementById('session-modal')
    if (smModal && !smModal.classList.contains('hidden')) { closeSessionModal(); return }
    // Worker drawer
    const drawer = document.getElementById('worker-drawer')
    if (drawer && !drawer.classList.contains('hidden')) { closeWorkerDrawer(); return }
  })
})

