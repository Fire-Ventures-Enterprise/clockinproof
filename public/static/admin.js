let adminMap = null
let currentPeriod = 'today'
let allSessionsData = []
let sessionStore = {}  // id → session object for modal lookup

// ── Admin Login ───────────────────────────────────────────────────────────────
async function adminLogin() {
  const pin = document.getElementById('admin-pin-input').value.trim()
  
  try {
    const res = await fetch('/api/settings')
    const data = await res.json()
    const adminPin = data.settings?.admin_pin || '1234'
    
    if (pin === adminPin) {
      document.getElementById('admin-login').classList.add('hidden')
      document.getElementById('admin-dashboard').classList.remove('hidden')
      await refreshAll()
      setInterval(refreshAll, 60000) // Auto-refresh every minute
      // Deep-link: if URL has #overrides (from notification tap), go straight there
      const hash = window.location.hash.replace('#', '')
      if (hash && ['live','workers','sessions','map','calendar','settings','export','overrides'].includes(hash)) {
        showTab(hash)
      }
    } else {
      document.getElementById('admin-login-error').textContent = 'Incorrect PIN. Try again.'
      document.getElementById('admin-login-error').classList.remove('hidden')
    }
  } catch(e) {
    // Fallback PIN check
    if (pin === '1234') {
      document.getElementById('admin-login').classList.add('hidden')
      document.getElementById('admin-dashboard').classList.remove('hidden')
      await refreshAll()
      const hash = window.location.hash.replace('#', '')
      if (hash && ['live','workers','sessions','map','calendar','settings','export','overrides'].includes(hash)) {
        showTab(hash)
      }
    }
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
async function openWorkerDrawer(workerId) {
  const drawer = document.getElementById('worker-drawer')
  drawer.classList.remove('hidden')
  document.body.style.overflow = 'hidden'

  // Reset
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

    if (worker) {
      document.getElementById('wd-name').textContent = worker.name
      document.getElementById('wd-phone').textContent = worker.phone
      document.getElementById('wd-rate').textContent = '$' + (worker.hourly_rate||0).toFixed(2) + '/hr'
      document.getElementById('wd-role').textContent = worker.role || 'worker'
      document.getElementById('wd-total-sessions').textContent = sessions.length
      const totalH = sessions.reduce((s, x) => s + (x.total_hours || 0), 0)
      const totalE = sessions.reduce((s, x) => s + (x.earnings || 0), 0)
      document.getElementById('wd-total-hours').textContent = totalH.toFixed(1) + 'h'
      document.getElementById('wd-total-earned').textContent = '$' + totalE.toFixed(2)
      const statusBadge = worker.currently_clocked_in > 0
        ? '<span class="bg-green-100 text-green-700 text-xs px-2 py-0.5 rounded-full pulse font-medium">● Working</span>'
        : worker.active
          ? '<span class="bg-gray-100 text-gray-600 text-xs px-2 py-0.5 rounded-full">Inactive</span>'
          : '<span class="bg-red-100 text-red-600 text-xs px-2 py-0.5 rounded-full">Disabled</span>'
      document.getElementById('wd-status-badge').innerHTML = statusBadge
      document.getElementById('wd-filter-sessions-btn').dataset.workerId = workerId

      // If worker is currently clocked in, show Force Clock-Out button
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
    }

    if (sessions.length === 0) {
      document.getElementById('wd-sessions').innerHTML = '<p class="text-gray-400 text-sm text-center py-6">No sessions yet</p>'
      return
    }
    // Populate sessionStore
    sessions.forEach(s => { if (s.id) sessionStore[s.id] = s })

    document.getElementById('wd-sessions').innerHTML = sessions.map(s => {
      const cin  = new Date(s.clock_in_time).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})
      const cout = s.clock_out_time ? new Date(s.clock_out_time).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) : null
      const isActive = s.status === 'active'
      const flags = []
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

function closeWorkerDrawer() {
  document.getElementById('worker-drawer').classList.add('hidden')
  document.body.style.overflow = ''
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
  if (s.drift_flag)    flags.push(`<span class="bg-orange-100 text-orange-700 px-2 py-1 rounded-full text-xs font-medium"><i class="fas fa-exclamation-triangle mr-1"></i>Left Job Site${s.drift_distance_meters ? ' (' + (s.drift_distance_meters >= 1000 ? (s.drift_distance_meters/1000).toFixed(1)+'km' : Math.round(s.drift_distance_meters)+'m') + ')' : ''}</span>`)
  if (s.away_flag)     flags.push('<span class="bg-yellow-100 text-yellow-700 px-2 py-1 rounded-full text-xs font-medium"><i class="fas fa-wifi mr-1"></i>Away / No GPS</span>')
  if (s.auto_clockout) flags.push(`<span class="bg-red-100 text-red-700 px-2 py-1 rounded-full text-xs font-medium"><i class="fas fa-clock mr-1"></i>Auto Clocked Out${s.auto_clockout_reason ? ': ' + s.auto_clockout_reason : ''}</span>`)

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

    <!-- Notes -->
    ${s.notes ? `
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
      ${isActive ? `<button onclick="closeSessionModal();openAdminClockoutModal(${s.id})" class="w-full bg-red-50 hover:bg-red-100 text-red-600 font-bold py-2.5 rounded-xl text-sm transition-colors border border-red-200"><i class="fas fa-stop-circle mr-1.5"></i>Admin Clock-Out</button>` : ''}
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
}

async function confirmAdminClockout() {
  if (!pendingClockoutSessionId) return
  const btn = document.getElementById('aco-confirm-btn')
  const note = document.getElementById('aco-note').value.trim() || 'Admin clock-out'
  btn.disabled = true
  btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1.5"></i>Stopping...'

  try {
    const res = await fetch('/api/sessions/' + pendingClockoutSessionId + '/admin-clockout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note })
    })
    const data = await res.json()

    if (data.success) {
      closeAdminClockoutModal()
      showAdminToast(`✅ ${data.message} · ${data.total_hours}h · $${data.earnings.toFixed(2)}`, 'success')
      // Refresh live, sessions, and stats
      await Promise.all([loadLive(), loadSessions(), loadStats()])
    } else {
      showAdminToast(data.error || 'Clock-out failed', 'error')
      btn.disabled = false
      btn.innerHTML = '<i class="fas fa-stop-circle mr-1.5"></i>Clock Out Now'
    }
  } catch(e) {
    showAdminToast('Connection error', 'error')
    btn.disabled = false
    btn.innerHTML = '<i class="fas fa-stop-circle mr-1.5"></i>Clock Out Now'
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
    // Populate sessionStore for modal lookups
    data.sessions.forEach(s => { if (s.id) sessionStore[s.id] = s })

    // Show/hide bulk drift clock-out button
    const driftedCount = data.sessions.filter(s => s.drift_flag && !s.auto_clockout).length
    if (bulkBtn) {
      if (driftedCount > 0) {
        bulkBtn.classList.remove('hidden')
        document.getElementById('bulk-clockout-label').textContent =
          `Clock Out ${driftedCount} — Left Site`
      } else {
        bulkBtn.classList.add('hidden')
      }
    }

    el.innerHTML = data.sessions.map(s => {
      const start = new Date(s.clock_in_time)
      const now = new Date()
      const hoursWorked = ((now - start) / 3600000).toFixed(1)
      const estimatedEarnings = (parseFloat(hoursWorked) * (s.hourly_rate || 0)).toFixed(2)
      const hasLocation = s.clock_in_lat && s.clock_in_lng
      const isActive = !s.auto_clockout

      // Guardrail badges
      const badges = []
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

      const autoReason = s.auto_clockout && s.auto_clockout_reason
        ? `<p class="text-xs text-red-600 mt-1 italic"><i class="fas fa-info-circle mr-1"></i>${s.auto_clockout_reason}</p>`
        : ''

      // Admin clock-out button — only for active sessions
      const adminBtn = isActive
        ? `<button onclick="event.stopPropagation();openAdminClockoutModal(${s.id})"
            class="w-full mt-3 flex items-center justify-center gap-1.5 bg-red-50 hover:bg-red-100 text-red-600 font-semibold text-xs py-2 rounded-xl border border-red-200 hover:border-red-400 transition-all">
            <i class="fas fa-stop-circle"></i> Admin Clock-Out
          </button>`
        : ''
      
      return `<div class="border ${s.drift_flag ? 'border-orange-300' : s.away_flag ? 'border-yellow-300' : 'border-gray-100'} rounded-xl p-4 hover:shadow-md transition-shadow cursor-pointer hover:border-indigo-300 ${s.auto_clockout ? 'opacity-70' : ''}" onclick="openWorkerDrawer(${s.worker_id})">
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

async function loadWorkers() {
  try {
    const res = await fetch('/api/workers')
    const data = await res.json()
    const tbody = document.getElementById('workers-tbody')

    // Populate the worker filter dropdown
    const workerSelect = document.getElementById('filter-worker')
    if (workerSelect && data.workers) {
      const currentVal = workerSelect.value
      workerSelect.innerHTML = '<option value="">All Workers</option>' +
        data.workers.map(w => `<option value="${w.id}" ${currentVal == w.id ? 'selected' : ''}>${w.name}</option>`).join('')
    }

    if (!data.workers || data.workers.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-center py-8 text-gray-400">No workers registered</td></tr>'
      return
    }
    
    tbody.innerHTML = data.workers.map(w => {
      const status = w.currently_clocked_in > 0
        ? '<span class="bg-green-100 text-green-700 text-xs px-2 py-1 rounded-full pulse">Working</span>'
        : w.active
          ? '<span class="bg-gray-100 text-gray-600 text-xs px-2 py-1 rounded-full">Inactive</span>'
          : '<span class="bg-red-100 text-red-600 text-xs px-2 py-1 rounded-full">Disabled</span>'
      
      return `<tr class="border-b border-gray-50 hover:bg-indigo-50 cursor-pointer transition-colors" onclick="openWorkerDrawer(${w.id})">
        <td class="py-3 font-medium text-gray-800 pl-1">
          <span class="flex items-center gap-2">
            <span class="w-7 h-7 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-600 text-xs font-bold flex-shrink-0">${w.name.charAt(0).toUpperCase()}</span>
            ${w.name}
          </span>
        </td>
        <td class="py-3 text-gray-500">${w.phone}</td>
        <td class="py-3 text-right font-medium text-green-600">$${(w.hourly_rate||0).toFixed(2)}</td>
        <td class="py-3 text-right text-gray-700">${(w.total_hours_all_time||0).toFixed(1)}h</td>
        <td class="py-3 text-right font-bold text-gray-800">$${(w.total_earnings_all_time||0).toFixed(2)}</td>
        <td class="py-3 text-center">${status}</td>
        <td class="py-3 text-right" onclick="event.stopPropagation()">
          <button data-id="${w.id}" data-name="${w.name.replace(/"/g,'&quot;')}"
            onclick="generateInviteLink(+this.dataset.id, this.dataset.name)"
            class="text-emerald-600 hover:text-emerald-800 text-xs mr-2" title="Generate invite link">
            <i class="fas fa-link"></i>
          </button>
          <button data-id="${w.id}" data-name="${w.name.replace(/"/g,'&quot;')}" data-rate="${w.hourly_rate}"
            onclick="editWorkerRate(+this.dataset.id, this.dataset.name, +this.dataset.rate)"
            class="text-indigo-600 hover:text-indigo-800 text-xs mr-2" title="Edit rate">
            <i class="fas fa-edit"></i>
          </button>
          <button data-id="${w.id}" data-name="${w.name.replace(/"/g,'&quot;')}"
            onclick="deleteWorker(+this.dataset.id, this.dataset.name)"
            class="text-red-500 hover:text-red-700 text-xs" title="Remove worker">
            <i class="fas fa-trash"></i>
          </button>
        </td>
      </tr>`
    }).join('')
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

        return `<div class="bg-gray-50 rounded-xl p-4 border border-gray-100 hover:border-indigo-300 hover:shadow-md transition-all cursor-pointer" onclick="openSessionById(${sess.id})">
          <div class="flex items-start justify-between gap-2">
            <div class="flex-1">
              <!-- Worker name -->
              <div class="flex items-center gap-2 mb-2">
                <div class="w-7 h-7 bg-indigo-100 rounded-full flex items-center justify-center flex-shrink-0">
                  <i class="fas fa-user text-indigo-500 text-xs"></i>
                </div>
                <span class="font-bold text-gray-800 text-sm">${sess.worker_name || '–'}</span>
                <span class="text-gray-400 text-xs">${sess.worker_phone || ''}</span>
                ${isActive ? `<span class="bg-green-100 text-green-700 text-xs px-2 py-0.5 rounded-full font-medium pulse ml-auto">● LIVE</span>` : ''}
              </div>
              <!-- Job location -->
              ${sess.job_location ? `
                <div class="flex items-start gap-1.5 mb-1.5 ml-9">
                  <i class="fas fa-map-marker-alt text-red-500 mt-0.5 text-xs flex-shrink-0"></i>
                  <p class="text-sm font-semibold text-gray-700">${sess.job_location}</p>
                </div>
              ` : ''}
              <!-- Job description -->
              ${sess.job_description ? `
                <div class="flex items-start gap-1.5 mb-2 ml-9">
                  <i class="fas fa-tools text-blue-400 mt-0.5 text-xs flex-shrink-0"></i>
                  <p class="text-xs text-gray-500">${sess.job_description}</p>
                </div>
              ` : ''}
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
    // Clear previous markers before reloading
    adminMap.eachLayer(layer => {
      if (layer instanceof L.CircleMarker) adminMap.removeLayer(layer)
    })
  }
  // Remove any stale "no sessions" overlay
  document.querySelectorAll('#admin-map > div[style*="pointer-events:none"]').forEach(el => el.remove())

  try {
    const today = new Date().toISOString().split('T')[0]
    const res = await fetch('/api/sessions?date=' + today + '&limit=200')
    const data = await res.json()
    
    const sessions = (data.sessions || []).filter(s => s.clock_in_lat && s.clock_in_lng)
    
    if (sessions.length === 0) {
      // No sessions today — show world view, no pin
      adminMap.setView([20, 0], 2)
      const overlay = document.createElement('div')
      overlay.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(255,255,255,0.9);padding:12px 20px;border-radius:12px;font-size:13px;color:#6b7280;pointer-events:none;z-index:999;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.1)'
      overlay.innerHTML = '<i class="fas fa-map-marker-slash" style="color:#9ca3af;margin-right:6px"></i>No clock-ins recorded today'
      document.getElementById('admin-map').appendChild(overlay)
      return
    }
    
    const bounds = []
    sessions.forEach(s => {
      const color = s.status === 'active' ? '#22c55e' : '#6366f1'
      const m = L.circleMarker([s.clock_in_lat, s.clock_in_lng], {
        color, fillColor: color, fillOpacity: 0.8, radius: 10
      }).addTo(adminMap)
      m.bindPopup(`<b>${s.worker_name}</b><br>${s.worker_phone}<br>In: ${new Date(s.clock_in_time).toLocaleTimeString()}${s.clock_out_time ? '<br>Out: ' + new Date(s.clock_out_time).toLocaleTimeString() : '<br><b class="text-green-600">Currently Working</b>'}`)
      bounds.push([s.clock_in_lat, s.clock_in_lng])
    })
    
    adminMap.fitBounds(bounds, { padding: [50, 50] })
  } catch(e) { console.error(e) }
}

// ── Workers Management ────────────────────────────────────────────────────────
function showAddWorkerModal() { document.getElementById('add-worker-modal').classList.remove('hidden') }
function closeModal() { document.getElementById('add-worker-modal').classList.add('hidden') }

async function addWorker() {
  const name = document.getElementById('modal-name').value.trim()
  const phone = document.getElementById('modal-phone').value.trim()
  const rate = parseFloat(document.getElementById('modal-rate').value) || 15
  const pin = document.getElementById('modal-pin').value.trim() || '0000'
  
  if (!name || !phone) { showAdminToast('Name and phone required', 'error'); return }
  
  try {
    const res = await fetch('/api/workers/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, phone, hourly_rate: rate, pin })
    })
    const data = await res.json()
    if (data.worker) {
      // Update hourly rate if different
      if (rate !== data.worker.hourly_rate) {
        await fetch('/api/workers/' + data.worker.id, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, hourly_rate: rate, role: 'worker', active: 1 })
        })
      }
      closeModal()
      showAdminToast('Worker added successfully!', 'success')
      await loadWorkers()
    }
  } catch(e) { showAdminToast('Error adding worker', 'error') }
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

async function deleteWorker(id, name) {
  if (!confirm(`Remove ${name} from the system?`)) return
  try {
    await fetch('/api/workers/' + id, { method: 'DELETE' })
    showAdminToast(name + ' removed', 'success')
    await loadWorkers()
  } catch(e) { showAdminToast('Error removing worker', 'error') }
}

async function generateInviteLink(id, name) {
  try {
    const res  = await fetch('/api/workers/' + id + '/invite', { method: 'POST' })
    const data = await res.json()
    if (!data.invite_code) { showAdminToast('Could not generate link', 'error'); return }
    const link = window.location.origin + '/invite/' + data.invite_code
    // Show modal with the link
    const existing = document.getElementById('invite-modal')
    if (existing) existing.remove()
    const modal = document.createElement('div')
    modal.id = 'invite-modal'
    modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4'
    modal.style.background = 'rgba(0,0,0,0.55)'
    modal.innerHTML = `
      <div class="bg-white rounded-2xl shadow-2xl max-w-sm w-full p-6 slide-up">
        <div class="flex items-center gap-3 mb-4">
          <div class="w-11 h-11 bg-indigo-100 rounded-xl flex items-center justify-center flex-shrink-0">
            <i class="fas fa-link text-indigo-600 text-lg"></i>
          </div>
          <div>
            <h3 class="font-bold text-gray-800 text-base">Invite Link for ${name}</h3>
            <p class="text-xs text-gray-400">Share this link — one tap and they're in</p>
          </div>
        </div>

        <div class="bg-indigo-50 border border-indigo-200 rounded-xl p-3 mb-4">
          <p class="text-xs font-semibold text-indigo-600 mb-1">Access Code</p>
          <p class="font-mono text-2xl font-bold text-indigo-800 tracking-widest text-center py-1">${data.invite_code}</p>
        </div>

        <div class="bg-gray-50 border border-gray-200 rounded-xl p-3 mb-4">
          <p class="text-xs font-semibold text-gray-500 mb-1">Invite Link</p>
          <p class="text-xs text-gray-700 break-all font-mono">${link}</p>
        </div>

        <div class="space-y-2">
          <button onclick="navigator.clipboard.writeText('${link}').then(()=>showAdminToast('Link copied!','success'))"
            class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-3 rounded-xl text-sm">
            <i class="fas fa-copy mr-2"></i>Copy Link
          </button>
          <button onclick="(()=>{ const txt=encodeURIComponent('Hi ${name}! Tap this link to open your WorkTracker app: ${link}'); window.open('sms:?body='+txt,'_blank') })()"
            class="w-full bg-green-600 hover:bg-green-700 text-white font-semibold py-3 rounded-xl text-sm">
            <i class="fas fa-sms mr-2"></i>Send via SMS
          </button>
          <button onclick="document.getElementById('invite-modal').remove()"
            class="w-full text-gray-500 hover:text-gray-700 py-2 text-sm font-medium">
            Close
          </button>
        </div>
      </div>
    `
    document.body.appendChild(modal)
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove() })
  } catch(e) { showAdminToast('Error generating invite link', 'error') }
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
  a.href = url; a.download = 'worktracker-export-' + new Date().toISOString().split('T')[0] + '.csv'
  a.click()
  showAdminToast('CSV exported!', 'success')
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
function showTab(name) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.add('hidden'))
  document.querySelectorAll('.tab-btn').forEach(t => {
    t.classList.remove('tab-active')
    // Update sidebar icon bg when active
    const icon = t.querySelector('span.w-8')
    if (icon) {
      icon.classList.remove('bg-indigo-600','text-white')
    }
  })
  const tabEl = document.getElementById('tab-' + name)
  if (tabEl) tabEl.classList.remove('hidden')
  const btnEl = document.querySelector('[data-tab="' + name + '"]')
  if (btnEl) btnEl.classList.add('tab-active')
  if (name === 'map') loadMap()
  if (name === 'calendar') loadCalendar()
  if (name === 'settings') loadSettings()
  if (name === 'export') initExportTab()
  if (name === 'overrides') loadOverrides()
  if (name === 'payroll') loadPayrollTab()
  if (name === 'accountant') initAcctTab()
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

    document.getElementById('s-app-name').value = currentSettings.app_name || 'WorkTracker'
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

    // Country dropdown
    const country = currentSettings.country_code || 'CA'
    document.getElementById('s-country').value = country
    updateProvinceList(currentSettings.province_code)

    // Timezone
    const tzSel = document.getElementById('s-timezone')
    if (tzSel) tzSel.value = currentSettings.timezone || 'America/Toronto'

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
    app_host: document.getElementById('s-app-host')?.value?.trim() || ''
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

async function initExportTab() {
  setExportWeek(0)  // default to current week
  document.getElementById('export-week-date').addEventListener('change', updateExportWeekLabel)

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
    const res  = await fetch('/api/export/report?week=' + dateInput.value)
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
