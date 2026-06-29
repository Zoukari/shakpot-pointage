// ============================================
// CONFIG SUPABASE — À REMPLIR PAR ZOUKARI
// ============================================
const SUPABASE_URL = "https://ucuwpfufyjmkwyilvpeo.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_GGUSoyKaqahl2EdiOXkDOw_lJtmSCLS";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const DAY_NAMES = ["Dimanche","Lundi","Mardi","Mercredi","Jeudi","Vendredi","Samedi"];
const DAY_NAMES_SHORT = ["Dim","Lun","Mar","Mer","Jeu","Ven","Sam"];

// ============================================
// STATE
// ============================================
let employees = [];          // tous les employés actifs
let selectedEmployee = null; // employé en cours de pointage (kiosk)
let pinBuffer = "";
let selfieDataUrl = null;
let sigCtx = null;
let sigDrawing = false;
let sigHasStroke = false;

let scheduleShifts = [];     // cache des shifts (rechargé selon la semaine affichée)
let timeLogsCache = [];

// ============================================
// UTILS DATE / HEURE
// ============================================

// Retourne le lundi (00:00) de la semaine contenant `date`, format YYYY-MM-DD
function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0 = dimanche
  const diff = (day === 0 ? -6 : 1 - day);
  d.setDate(d.getDate() + diff);
  d.setHours(0,0,0,0);
  return d;
}
function fmtDate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const dd = String(d.getDate()).padStart(2,"0");
  return `${yyyy}-${mm}-${dd}`;
}
function fmtTimeShort(t) {
  // t = "17:30:00" -> "17h30"
  if (!t) return "";
  const [h,m] = t.split(":");
  return `${h}h${m}`;
}
// Calcule la durée en heures (décimal) entre deux heures "HH:MM", gère le passage minuit
function shiftDurationHours(start, end) {
  if (!start || !end) return 0;
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  let startMin = sh*60+sm;
  let endMin = eh*60+em;
  if (endMin <= startMin) endMin += 24*60; // passe minuit
  return (endMin - startMin) / 60;
}
function fmtHours(h) {
  const sign = h < 0 ? "-" : "";
  h = Math.abs(h);
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return `${sign}${hh}h${String(mm).padStart(2,"0")}`;
}

// ============================================
// MODE SWITCH (Kiosk / Myspace / Admin)
// ============================================
const ADMIN_SECRET_PATH = "admin-skp-2709"; // URL secrète : tonsite.com/#admin-skp-2709

function switchMode(mode) {
  document.getElementById("btnModeKiosk").classList.toggle("active", mode === "kiosk");
  document.getElementById("btnModeMyspace").classList.toggle("active", mode === "myspace");
  document.getElementById("viewKiosk").classList.toggle("active", mode === "kiosk");
  document.getElementById("viewMyspace").classList.toggle("active", mode === "myspace");

  if (mode === "kiosk") {
    document.getElementById("viewAdminLogin").classList.remove("active");
    document.getElementById("viewAdmin").classList.remove("active");
    checkKioskActivation();
    resetKiosk();
  } else if (mode === "myspace") {
    document.getElementById("viewAdminLogin").classList.remove("active");
    document.getElementById("viewAdmin").classList.remove("active");
    myspaceReset();
  } else if (mode === "admin") {
    document.getElementById("viewKiosk").classList.remove("active");
    document.getElementById("viewMyspace").classList.remove("active");
    const isLoggedIn = sessionStorage.getItem("shakpot_admin") === "1";
    document.getElementById("viewAdminLogin").classList.toggle("active", !isLoggedIn);
    document.getElementById("viewAdmin").classList.toggle("active", isLoggedIn);
    if (isLoggedIn) initAdmin();
  }
}

// Vérifie si l'URL contient le hash secret (#admin-skp-2709) pour révéler l'accès admin
function checkSecretAdminAccess() {
  if (window.location.hash.replace("#", "") === ADMIN_SECRET_PATH) {
    document.getElementById("btnModeKiosk").classList.remove("active");
    document.getElementById("viewKiosk").classList.remove("active");
    switchMode("admin");
  }
}

async function getAdminPassword() {
  const { data, error } = await sb.from("app_settings").select("value").eq("key", "admin_password").single();
  if (error || !data) return "shakpot2026"; // fallback si la table n'existe pas encore
  return data.value;
}

// ============================================
// VERROUILLAGE PAR APPAREIL (kiosque)
// ============================================
const DEVICE_STORAGE_KEY = "shakpot_kiosk_device_code";

function getDeviceCode() {
  return localStorage.getItem(DEVICE_STORAGE_KEY);
}

// Génère le code d'activation horaire à partir d'une racine secrète + l'heure actuelle (UTC, arrondie à l'heure).
// Le même calcul est fait dans l'admin pour afficher le code courant — pas besoin de le stocker, il se déduit.
async function computeHourlyActivationCode() {
  const { data, error } = await sb.from("app_settings").select("value").eq("key", "kiosk_secret_root").single();
  const root = (!error && data) ? data.value : "shakpot-secret-2026";
  const hourBucket = Math.floor(Date.now() / 3600000); // change toutes les heures
  const raw = `${root}-${hourBucket}`;
  // hash simple mais suffisant (pas besoin de cryptographie forte ici, juste un code à 4 chiffres pas évident à deviner)
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
  }
  const code = Math.abs(hash) % 10000;
  return String(code).padStart(4, "0");
}

async function checkKioskActivation() {
  const deviceCode = getDeviceCode();

  if (!deviceCode) {
    // Aucun appareil enregistré localement : vérifie s'il existe déjà UN kiosque officiel en base
    const { data: existing } = await sb.from("kiosk_devices").select("id").eq("revoked", false).limit(1);
    if (!existing || existing.length === 0) {
      // Personne ne s'est jamais activé : CET appareil devient automatiquement le kiosque officiel, sans code
      await registerNewDevice(true, "Premier appareil (auto)");
      document.getElementById("kioskActivationCard").style.display = "none";
      document.getElementById("kioskMainCard").style.display = "block";
      return;
    }
    // Un kiosque existe déjà ailleurs : cet appareil doit taper le code d'activation horaire
    document.getElementById("kioskActivationCard").style.display = "block";
    document.getElementById("kioskMainCard").style.display = "none";
    return;
  }

  // Cet appareil a déjà un code stocké : vérifie qu'il n'a pas été révoqué depuis
  const { data: device } = await sb.from("kiosk_devices").select("*").eq("device_code", deviceCode).single();
  if (!device || device.revoked) {
    localStorage.removeItem(DEVICE_STORAGE_KEY);
    document.getElementById("kioskActivationCard").style.display = "block";
    document.getElementById("kioskMainCard").style.display = "none";
    return;
  }

  // Appareil valide : met à jour le "dernier vu" et laisse passer
  await sb.from("kiosk_devices").update({ last_seen_at: new Date().toISOString() }).eq("device_code", deviceCode);
  document.getElementById("kioskActivationCard").style.display = "none";
  document.getElementById("kioskMainCard").style.display = "block";
}

async function registerNewDevice(isPrimary, label) {
  const newDeviceCode = "kiosk_" + Math.random().toString(36).slice(2) + Date.now();
  localStorage.setItem(DEVICE_STORAGE_KEY, newDeviceCode);
  await sb.from("kiosk_devices").insert({
    device_code: newDeviceCode,
    device_label: label || null,
    is_primary: isPrimary
  });
  return newDeviceCode;
}

async function activateKiosk() {
  const code = document.getElementById("kioskActivationCode").value.trim();
  const correctCode = await computeHourlyActivationCode();

  if (code === correctCode && code.length > 0) {
    await registerNewDevice(false, null);
    document.getElementById("kioskActivationError").style.display = "none";
    document.getElementById("kioskActivationCode").value = "";
    checkKioskActivation();
    resetKiosk();
  } else {
    document.getElementById("kioskActivationError").style.display = "block";
  }
}

async function checkAdminLogin() {
  const val = document.getElementById("adminPassword").value;
  const correctPassword = await getAdminPassword();
  if (val === correctPassword) {
    sessionStorage.setItem("shakpot_admin", "1");
    document.getElementById("viewAdminLogin").classList.remove("active");
    document.getElementById("viewAdmin").classList.add("active");
    document.getElementById("adminLoginError").style.display = "none";
    document.getElementById("adminPassword").value = "";
    initAdmin();
  } else {
    document.getElementById("adminLoginError").style.display = "block";
  }
}

async function changeAdminPassword() {
  const newPass = document.getElementById("newAdminPassword").value.trim();
  const confirmPass = document.getElementById("confirmAdminPassword").value.trim();
  const msg = document.getElementById("settingsMsg");

  if (!newPass || newPass.length < 4) {
    msg.textContent = "Le mot de passe doit contenir au moins 4 caractères.";
    msg.className = "status-msg error";
    msg.style.display = "block";
    return;
  }
  if (newPass !== confirmPass) {
    msg.textContent = "Les deux mots de passe ne correspondent pas.";
    msg.className = "status-msg error";
    msg.style.display = "block";
    return;
  }

  const { error } = await sb.from("app_settings").upsert({ key: "admin_password", value: newPass });
  if (error) {
    msg.textContent = "Erreur : " + error.message;
    msg.className = "status-msg error";
  } else {
    msg.textContent = "Mot de passe mis à jour avec succès.";
    msg.className = "status-msg success";
    document.getElementById("newAdminPassword").value = "";
    document.getElementById("confirmAdminPassword").value = "";
  }
  msg.style.display = "block";
}

// ============================================
// KIOSK FLOW
// ============================================
function goToStep(stepId) {
  document.querySelectorAll(".kiosk-step").forEach(s => s.classList.remove("active"));
  document.getElementById(stepId).classList.add("active");
}

async function loadEmployeesForKiosk() {
  const { data, error } = await sb.from("employees").select("*").eq("active", true).order("full_name");
  if (error) { console.error(error); return; }
  employees = data;
  const grid = document.getElementById("employeeGrid");
  grid.innerHTML = "";
  employees.forEach(emp => {
    const tile = document.createElement("div");
    tile.className = "employee-tile";
    tile.textContent = emp.full_name;
    tile.onclick = () => selectEmployee(emp);
    grid.appendChild(tile);
  });
}

function selectEmployee(emp) {
  selectedEmployee = emp;
  pinBuffer = "";
  updatePinDisplay();
  document.getElementById("pinGreeting").innerHTML = `Bonjour <span style="color:var(--bordeaux)">${emp.full_name}</span>`;
  document.getElementById("pinError").style.display = "none";
  goToStep("stepPin");
}

function pinPress(digit) {
  if (pinBuffer.length >= 4) return;
  pinBuffer += digit;
  updatePinDisplay();
  if (pinBuffer.length === 4) {
    setTimeout(checkPin, 150);
  }
}
function pinBackspace() {
  pinBuffer = pinBuffer.slice(0, -1);
  updatePinDisplay();
}
function pinClear() {
  pinBuffer = "";
  updatePinDisplay();
}
function updatePinDisplay() {
  const dots = document.querySelectorAll("#pinDisplay .pin-dot");
  dots.forEach((dot, i) => dot.classList.toggle("filled", i < pinBuffer.length));
}

async function checkPin() {
  if (pinBuffer === selectedEmployee.pin_code) {
    document.getElementById("pinError").style.display = "none";
    goToStep("stepChooseType");
  } else {
    document.getElementById("pinError").style.display = "block";
    pinBuffer = "";
    updatePinDisplay();
  }
}

let pendingLogType = "in";
async function chooseLogType(type) {
  pendingLogType = type;
  document.getElementById("sigTypeLabel").textContent =
    pendingLogType === "in" ? "Pour confirmer ton arrivée" : "Pour confirmer ton départ";
  await startWebcam();
  goToStep("stepSelfie");
}

// --- Webcam / selfie ---
let webcamStream = null;
async function startWebcam() {
  const video = document.getElementById("kioskWebcam");
  const canvas = document.getElementById("kioskCanvas");
  video.style.display = "block";
  canvas.style.display = "none";
  document.getElementById("btnTakeSelfie").style.display = "inline-block";
  document.getElementById("btnRetakeSelfie").style.display = "none";
  document.getElementById("btnConfirmSelfie").style.display = "none";
  try {
    webcamStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" } });
    video.srcObject = webcamStream;
  } catch (e) {
    console.error("Webcam non disponible", e);
    alert("Impossible d'accéder à la caméra. Vérifie les permissions du navigateur.");
  }
}
function stopWebcam() {
  if (webcamStream) {
    webcamStream.getTracks().forEach(t => t.stop());
    webcamStream = null;
  }
}
function takeSelfie() {
  const video = document.getElementById("kioskWebcam");
  const canvas = document.getElementById("kioskCanvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  selfieDataUrl = canvas.toDataURL("image/jpeg", 0.8);
  video.style.display = "none";
  canvas.style.display = "block";
  stopWebcam();
  document.getElementById("btnTakeSelfie").style.display = "none";
  document.getElementById("btnRetakeSelfie").style.display = "inline-block";
  document.getElementById("btnConfirmSelfie").style.display = "inline-block";
}
function retakeSelfie() {
  startWebcam();
}

// --- Signature canvas ---
function initSignatureCanvas() {
  const canvas = document.getElementById("sigCanvas");
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * 2;
  canvas.height = rect.height * 2;
  sigCtx = canvas.getContext("2d");
  sigCtx.scale(2,2);
  sigCtx.lineWidth = 2.2;
  sigCtx.lineCap = "round";
  sigCtx.strokeStyle = "#1A1414";
  sigHasStroke = false;

  function pos(e) {
    const r = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return { x: clientX - r.left, y: clientY - r.top };
  }
  function start(e) { sigDrawing = true; const p = pos(e); sigCtx.beginPath(); sigCtx.moveTo(p.x, p.y); }
  function move(e) {
    if (!sigDrawing) return;
    e.preventDefault();
    const p = pos(e);
    sigCtx.lineTo(p.x, p.y);
    sigCtx.stroke();
    sigHasStroke = true;
  }
  function end() { sigDrawing = false; }

  canvas.onmousedown = start;
  canvas.onmousemove = move;
  canvas.onmouseup = end;
  canvas.onmouseleave = end;
  canvas.ontouchstart = start;
  canvas.ontouchmove = move;
  canvas.ontouchend = end;
}
function clearSignature() {
  const canvas = document.getElementById("sigCanvas");
  sigCtx.clearRect(0, 0, canvas.width, canvas.height);
  sigHasStroke = false;
}

// override goToStep pour initialiser le canvas de signature au bon moment
const _origGoToStep = goToStep;
goToStep = function(stepId) {
  _origGoToStep(stepId);
  if (stepId === "stepSignature") {
    setTimeout(initSignatureCanvas, 50);
  }
};

async function submitTimeLog() {
  if (!sigHasStroke) {
    alert("Merci de signer avant de valider.");
    return;
  }

  const deviceCode = getDeviceCode();
  if (!deviceCode) {
    alert("Cet appareil n'est pas activé comme kiosque officiel. Demande à l'administrateur de l'activer.");
    checkKioskActivation();
    return;
  }

  const signatureData = document.getElementById("sigCanvas").toDataURL("image/png");

  let selfieUrl = null;
  if (selfieDataUrl) {
    try {
      const blob = await (await fetch(selfieDataUrl)).blob();
      const fileName = `${selectedEmployee.id}_${Date.now()}.jpg`;
      const { data, error } = await sb.storage.from("selfies").upload(fileName, blob, { contentType: "image/jpeg" });
      if (!error) {
        const { data: urlData } = sb.storage.from("selfies").getPublicUrl(fileName);
        selfieUrl = urlData.publicUrl;
      } else {
        console.error("Upload selfie échoué", error);
      }
    } catch (e) { console.error(e); }
  }

  const { error } = await sb.from("time_logs").insert({
    employee_id: selectedEmployee.id,
    type: pendingLogType,
    selfie_url: selfieUrl,
    signature_data: signatureData,
    manual_entry: false,
    device_code: deviceCode
  });

  if (error) {
    console.error(error);
    document.getElementById("doneMessage").textContent = "Erreur lors de l'enregistrement.";
    document.getElementById("doneMessage").className = "status-msg error";
  } else {
    document.getElementById("doneMessage").textContent =
      pendingLogType === "in" ? `Bonne arrivée, ${selectedEmployee.full_name} !` : `Bonne route, ${selectedEmployee.full_name} !`;
    document.getElementById("doneMessage").className = "status-msg success";
  }
  goToStep("stepDone");
}

function resetKiosk() {
  selectedEmployee = null;
  pinBuffer = "";
  selfieDataUrl = null;
  stopWebcam();
  goToStep("stepSelectEmployee");
  loadEmployeesForKiosk();
}

// ============================================
// ADMIN INIT
// ============================================
async function initAdmin() {
  await loadEmployeesForKiosk(); // recharge employees[] (utile aussi pour l'admin)
  renderEmployeeList();
  await renderScheduleGrid();
  populateEmployeeFilters();
  setDefaultHoursPeriod();
  await renderHoursTable();
  await renderLogsTable();
  await renderCurrentHourlyCode();
  await renderDevicesList();
  startHourlyCodeRefresh();
}

let hourlyCodeInterval = null;
function startHourlyCodeRefresh() {
  if (hourlyCodeInterval) clearInterval(hourlyCodeInterval);
  // Recalcule le code affiché toutes les minutes (au cas où l'heure change pendant que l'admin regarde)
  hourlyCodeInterval = setInterval(renderCurrentHourlyCode, 60000);
}
async function renderCurrentHourlyCode() {
  const el = document.getElementById("currentHourlyCode");
  if (!el) return;
  el.textContent = await computeHourlyActivationCode();
}

async function renderDevicesList() {
  const { data: devices, error } = await sb.from("kiosk_devices").select("*").order("activated_at", { ascending: false });
  const list = document.getElementById("devicesList");
  if (error || !devices || devices.length === 0) {
    list.innerHTML = `<div class="empty-state">Aucun appareil enregistré pour l'instant.</div>`;
    return;
  }
  list.innerHTML = devices.map((d, i) => {
    const activatedStr = new Date(d.activated_at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
    const lastSeenStr = d.last_seen_at ? new Date(d.last_seen_at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "—";
    const displayName = d.device_label || `Appareil ${i + 1}`;
    return `
    <div class="emp-list-row">
      <div>
        <span class="emp-name">${displayName}${d.is_primary ? ' <span class="pill green">Principal</span>' : ''}${d.revoked ? ' <span class="pill red">Déconnecté</span>' : ''}</span>
        <div style="font-size:12px;color:var(--gray);margin-top:3px;">Activé le ${activatedStr} · Dernier pointage : ${lastSeenStr}</div>
      </div>
      <div class="emp-actions">
        <button onclick="renameDevice('${d.id}', '${(d.device_label || '').replace(/'/g, "\\'")}')">Renommer</button>
        ${d.revoked ? '' : `<button onclick="revokeDevice('${d.id}')">Déconnecter</button>`}
      </div>
    </div>`;
  }).join("");
}

async function renameDevice(deviceId, currentLabel) {
  const newLabel = prompt("Nom de cet appareil (ex: Tablette comptoir, Téléphone Hasna)", currentLabel || "");
  if (newLabel === null) return; // annulé
  const trimmed = newLabel.trim();
  if (!trimmed) return;
  const { error } = await sb.from("kiosk_devices").update({ device_label: trimmed }).eq("id", deviceId);
  if (error) { alert("Erreur: " + error.message); return; }
  await renderDevicesList();
}

async function revokeDevice(deviceId) {
  if (!confirm("Déconnecter cet appareil ? Il ne pourra plus enregistrer de pointages tant qu'il n'aura pas été réactivé avec un nouveau code.")) return;
  const { error } = await sb.from("kiosk_devices").update({ revoked: true }).eq("id", deviceId);
  if (error) { alert("Erreur: " + error.message); return; }
  await renderDevicesList();
}

function switchAdminTab(tab) {
  document.querySelectorAll(".admin-tabs button").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".admin-panel").forEach(p => p.classList.remove("active"));
  event.target.classList.add("active");
  document.getElementById("adminPanel" + tab.charAt(0).toUpperCase() + tab.slice(1)).classList.add("active");
}

// ============================================
// EMPLOYEE MANAGEMENT
// ============================================
function renderEmployeeList() {
  const list = document.getElementById("employeeList");
  if (employees.length === 0) {
    list.innerHTML = `<div class="empty-state">Aucun employé pour l'instant. Clique sur "+ Ajouter un employé".</div>`;
    return;
  }
  list.innerHTML = employees.map(emp => `
    <div class="emp-list-row">
      <div><span class="emp-name">${emp.full_name}</span><span class="emp-pin">PIN: ${emp.pin_code}</span></div>
      <div class="emp-actions">
        <button onclick="openEmployeeModal('${emp.id}')">Modifier</button>
        <button onclick="deactivateEmployee('${emp.id}')">Désactiver</button>
      </div>
    </div>
  `).join("");
}

function openEmployeeModal(empId) {
  document.getElementById("employeeModalOverlay").classList.add("active");
  if (empId) {
    const emp = employees.find(e => e.id === empId);
    document.getElementById("employeeModalTitle").textContent = "Modifier l'employé";
    document.getElementById("employeeModalId").value = emp.id;
    document.getElementById("employeeModalName").value = emp.full_name;
    document.getElementById("employeeModalPin").value = emp.pin_code;
  } else {
    document.getElementById("employeeModalTitle").textContent = "Ajouter un employé";
    document.getElementById("employeeModalId").value = "";
    document.getElementById("employeeModalName").value = "";
    document.getElementById("employeeModalPin").value = "";
  }
}
function closeEmployeeModal() {
  document.getElementById("employeeModalOverlay").classList.remove("active");
}
async function saveEmployee() {
  const id = document.getElementById("employeeModalId").value;
  const name = document.getElementById("employeeModalName").value.trim();
  const pin = document.getElementById("employeeModalPin").value.trim();
  if (!name || !/^\d{4}$/.test(pin)) {
    alert("Merci de renseigner un nom et un code PIN à 4 chiffres.");
    return;
  }
  if (id) {
    const { error } = await sb.from("employees").update({ full_name: name, pin_code: pin }).eq("id", id);
    if (error) { alert("Erreur: " + error.message); return; }
  } else {
    const { error } = await sb.from("employees").insert({ full_name: name, pin_code: pin });
    if (error) { alert("Erreur: " + error.message); return; }
  }
  closeEmployeeModal();
  await initAdmin();
}
async function deactivateEmployee(id) {
  if (!confirm("Désactiver cet employé ? Il n'apparaîtra plus au kiosque.")) return;
  const { error } = await sb.from("employees").update({ active: false }).eq("id", id);
  if (error) { alert("Erreur: " + error.message); return; }
  await initAdmin();
}

// ============================================
// SCHEDULE (PLANNING) — un seul planning récurrent, pas de notion de semaine
// ============================================
async function loadAllShifts() {
  const { data, error } = await sb.from("schedule_shifts").select("*");
  if (error) { console.error(error); return []; }
  return data;
}

async function renderScheduleGrid() {
  scheduleShifts = await loadAllShifts();

  const table = document.getElementById("scheduleTable");
  let html = "<tr><th>Employé</th>";
  for (let d = 1; d <= 6; d++) html += `<th>${DAY_NAMES[d]}</th>`;
  html += `<th>${DAY_NAMES[0]}</th><th>Total théorique</th></tr>`;

  const dayOrder = [1,2,3,4,5,6,0]; // Lundi -> Dimanche

  employees.forEach(emp => {
    html += `<tr><td class="emp-col">${emp.full_name}</td>`;
    let weekTotal = 0;
    dayOrder.forEach(day => {
      const shiftsForDay = scheduleShifts
        .filter(s => s.employee_id === emp.id && s.day_of_week === day)
        .sort((a,b) => a.shift_order - b.shift_order);

      if (shiftsForDay.length === 0) {
        html += `<td class="shift-cell" onclick="openShiftModal('${emp.id}', ${day})">—</td>`;
      } else if (shiftsForDay[0].is_rest) {
        html += `<td class="rest-cell" onclick="openShiftModal('${emp.id}', ${day})">R</td>`;
      } else {
        const lines = shiftsForDay.map(s => {
          const dur = shiftDurationHours(s.start_time, s.end_time);
          weekTotal += dur;
          return `<div class="shift-line">${fmtTimeShort(s.start_time)}–${fmtTimeShort(s.end_time)}</div>`;
        }).join("");
        html += `<td class="shift-cell" onclick="openShiftModal('${emp.id}', ${day})">${lines}</td>`;
      }
    });
    html += `<td><strong>${fmtHours(weekTotal)}</strong></td></tr>`;
  });

  table.innerHTML = html;
}

// --- Shift edit modal ---
function openShiftModal(employeeId, day) {
  document.getElementById("shiftModalEmployeeId").value = employeeId;
  document.getElementById("shiftModalDay").value = day;

  const emp = employees.find(e => e.id === employeeId);
  document.getElementById("shiftModalTitle").textContent = `${emp.full_name} — ${DAY_NAMES[day]}`;

  const existing = scheduleShifts
    .filter(s => s.employee_id === employeeId && s.day_of_week === day)
    .sort((a,b) => a.shift_order - b.shift_order);

  const isRest = existing.length > 0 && existing[0].is_rest;
  document.getElementById("shiftModalRest").checked = isRest;

  const container = document.getElementById("shiftModalShiftsContainer");
  container.innerHTML = "";

  if (isRest || existing.length === 0) {
    addShiftRow(); // une ligne vide par défaut
  } else {
    existing.forEach(s => addShiftRow(s.start_time, s.end_time));
  }
  toggleRestMode();

  // Checkboxes pour copier vers d'autres jours
  const copyContainer = document.getElementById("copyDaysCheckboxes");
  copyContainer.innerHTML = "";
  for (let d = 0; d <= 6; d++) {
    if (d === day) continue;
    const label = document.createElement("label");
    label.className = "day-checkbox";
    label.innerHTML = `<input type="checkbox" value="${d}"> ${DAY_NAMES_SHORT[d]}`;
    copyContainer.appendChild(label);
  }

  document.getElementById("shiftModalOverlay").classList.add("active");
}
function closeShiftModal() {
  document.getElementById("shiftModalOverlay").classList.remove("active");
}
function addShiftRow(start, end) {
  const container = document.getElementById("shiftModalShiftsContainer");
  const row = document.createElement("div");
  row.className = "shift-row-edit";
  row.innerHTML = `
    <input type="time" class="shift-start" value="${start ? start.slice(0,5) : ''}">
    <span>→</span>
    <input type="time" class="shift-end" value="${end ? end.slice(0,5) : ''}">
    <button onclick="this.parentElement.remove()">✕</button>
  `;
  container.appendChild(row);
}
function toggleRestMode() {
  const isRest = document.getElementById("shiftModalRest").checked;
  document.getElementById("shiftModalShiftsContainer").style.display = isRest ? "none" : "block";
  document.getElementById("addShiftLink").style.display = isRest ? "none" : "block";
}

// Construit la liste des shifts (is_rest / créneaux) à partir du formulaire ouvert
function readShiftFormValues() {
  const isRest = document.getElementById("shiftModalRest").checked;
  if (isRest) {
    return [{ is_rest: true, start_time: null, end_time: null }];
  }
  const rows = document.querySelectorAll("#shiftModalShiftsContainer .shift-row-edit");
  const shifts = [];
  rows.forEach(row => {
    const start = row.querySelector(".shift-start").value;
    const end = row.querySelector(".shift-end").value;
    if (start && end) shifts.push({ is_rest: false, start_time: start, end_time: end });
  });
  return shifts;
}

async function writeShiftsForDay(employeeId, day, shifts) {
  await sb.from("schedule_shifts").delete().eq("employee_id", employeeId).eq("day_of_week", day);
  let order = 1;
  for (const s of shifts) {
    await sb.from("schedule_shifts").insert({
      employee_id: employeeId, day_of_week: day, shift_order: order,
      is_rest: s.is_rest, start_time: s.start_time, end_time: s.end_time
    });
    order++;
  }
}

async function saveShift() {
  const employeeId = document.getElementById("shiftModalEmployeeId").value;
  const day = parseInt(document.getElementById("shiftModalDay").value);
  const shifts = readShiftFormValues();

  if (shifts.length === 0) {
    alert("Merci de renseigner au moins un créneau, ou de cocher 'Jour de repos'.");
    return;
  }

  await writeShiftsForDay(employeeId, day, shifts);

  // Copie vers les autres jours sélectionnés
  const checkedDays = Array.from(document.querySelectorAll("#copyDaysCheckboxes input:checked")).map(cb => parseInt(cb.value));
  for (const targetDay of checkedDays) {
    await writeShiftsForDay(employeeId, targetDay, shifts);
  }

  closeShiftModal();
  await renderScheduleGrid();
}

// ============================================
// HOURS WORKED VS THEORETICAL (admin "Heures travaillées" tab)
// ============================================
function setDefaultHoursPeriod() {
  document.getElementById("hoursPeriodDate").value = fmtDate(new Date());
  document.getElementById("logsPeriodDate").value = fmtDate(new Date());
}

// Généralisée pour accepter n'importe quelle paire d'IDs de champs (type + date)
function getPeriodRangeFor(typeFieldId, dateFieldId) {
  const type = document.getElementById(typeFieldId).value;
  const dateVal = document.getElementById(dateFieldId).value || fmtDate(new Date());
  const date = new Date(dateVal + "T00:00:00");
  let start, end;
  if (type === "all") {
    start = new Date(2020, 0, 1); end = new Date(2100, 0, 1);
  } else if (type === "day") {
    start = new Date(date); end = new Date(date); end.setDate(end.getDate()+1);
  } else if (type === "week") {
    start = getMonday(date); end = new Date(start); end.setDate(end.getDate()+7);
  } else {
    start = new Date(date.getFullYear(), date.getMonth(), 1);
    end = new Date(date.getFullYear(), date.getMonth()+1, 1);
  }
  return { start, end };
}

function getPeriodRange() {
  return getPeriodRangeFor("hoursPeriodType", "hoursPeriodDate");
}

// Calcule les heures réellement travaillées par employé sur une période, à partir des paires in/out
function computeWorkedHours(logs, employeeId, start, end) {
  const empLogs = logs
    .filter(l => l.employee_id === employeeId)
    .sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));

  let totalMs = 0;
  let openIn = null;
  empLogs.forEach(log => {
    const t = new Date(log.timestamp);
    if (log.type === "in") {
      openIn = t;
    } else if (log.type === "out" && openIn) {
      totalMs += (t - openIn);
      openIn = null;
    }
  });
  return totalMs / 3600000; // -> heures décimales
}

// Calcule les heures théoriques prévues pour un employé sur la période (somme des shifts du planning applicable)
function computeTheoreticalHours(employeeId, start, end, allShifts) {
  let total = 0;
  let cursor = new Date(start);
  while (cursor < end) {
    const dayOfWeek = cursor.getDay();
    const dayShifts = allShifts.filter(s => s.employee_id === employeeId && s.day_of_week === dayOfWeek && !s.is_rest);
    dayShifts.forEach(s => { total += shiftDurationHours(s.start_time, s.end_time); });
    cursor.setDate(cursor.getDate()+1);
  }
  return total;
}

// Calcule les heures travaillées sur une période en tenant compte des ajustements JOUR PAR JOUR :
// pour chaque jour de la période, si un ajustement 'day' existe pour ce jour précis, on l'utilise,
// sinon on calcule à partir des vrais pointages de ce jour. La somme couvre toute la période (jour/semaine/mois).
function computeWorkedHoursWithAdjustments(employeeId, start, end, logs, dayAdjustmentsMap) {
  let total = 0;
  let cursor = new Date(start);
  while (cursor < end) {
    const dayStr = fmtDate(cursor);
    const dayStart = new Date(cursor);
    const dayEnd = new Date(cursor); dayEnd.setDate(dayEnd.getDate()+1);

    if (dayAdjustmentsMap[employeeId] && dayAdjustmentsMap[employeeId][dayStr] !== undefined) {
      total += dayAdjustmentsMap[employeeId][dayStr];
    } else {
      const dayLogs = logs.filter(l => {
        const t = new Date(l.timestamp);
        return t >= dayStart && t < dayEnd;
      });
      total += computeWorkedHours(dayLogs, employeeId, dayStart, dayEnd);
    }
    cursor.setDate(cursor.getDate()+1);
  }
  return total;
}

async function renderHoursTable() {
  const { start, end } = getPeriodRange();
  const periodType = document.getElementById("hoursPeriodType").value;
  const periodDate = document.getElementById("hoursPeriodDate").value || fmtDate(new Date());
  const refDate = periodType === "week" ? fmtDate(getMonday(new Date(periodDate + "T00:00:00")))
                : periodType === "month" ? periodDate.slice(0,8) + "01"
                : periodDate;

  const { data: logs, error } = await sb
    .from("time_logs")
    .select("*")
    .gte("timestamp", start.toISOString())
    .lt("timestamp", end.toISOString());
  if (error) { console.error(error); return; }
  timeLogsCache = logs;

  const allShifts = await loadAllShifts();

  // On ne récupère QUE les ajustements de type 'day' sur la plage affichée — ce sont eux qui
  // s'additionnent correctement quelle que soit la granularité (jour, semaine ou mois).
  const { data: dayAdjustments } = await sb.from("hours_adjustments").select("*")
    .eq("period_type", "day")
    .gte("period_date", fmtDate(start))
    .lt("period_date", fmtDate(end));
  const dayAdjustmentsMap = {};
  (dayAdjustments || []).forEach(a => {
    if (!dayAdjustmentsMap[a.employee_id]) dayAdjustmentsMap[a.employee_id] = {};
    dayAdjustmentsMap[a.employee_id][a.period_date] = parseFloat(a.total_hours);
  });

  const table = document.getElementById("hoursTable");
  let html = "<tr><th>Employé</th><th>Heures travaillées</th><th>Heures prévues</th><th>Écart</th><th></th></tr>";

  for (const emp of employees) {
    const hasAdjustmentInPeriod = !!dayAdjustmentsMap[emp.id];
    const worked = computeWorkedHoursWithAdjustments(emp.id, start, end, logs, dayAdjustmentsMap);
    const theoretical = computeTheoreticalHours(emp.id, start, end, allShifts);
    const diff = worked - theoretical;
    let diffClass = "hours-ok";
    if (diff > 0.05) diffClass = "hours-over";
    else if (diff < -0.05) diffClass = "hours-under";
    html += `<tr>
      <td class="emp-col">${emp.full_name}</td>
      <td>${fmtHours(worked)}${hasAdjustmentInPeriod ? ' <span class="pill gray" title="Contient des heures corrigées manuellement">corrigé</span>' : ''}</td>
      <td>${fmtHours(theoretical)}</td>
      <td class="${diffClass}">${diff >= 0 ? "+" : ""}${fmtHours(diff)}</td>
      <td>
        <button class="small-link" style="background:none;border:none;" onclick="openAdjustmentModal('${emp.id}', 'day', '${fmtDate(new Date())}')">Corriger un jour</button>
        ${hasAdjustmentInPeriod ? `<button class="small-link" style="background:none;border:none;color:var(--red-text);" onclick="resetHoursForPeriod('${emp.id}', '${fmtDate(start)}', '${fmtDate(end)}')">Réinitialiser</button>` : ''}
      </td>
    </tr>`;
  }
  table.innerHTML = html;
}

// Supprime les pointages ET les ajustements manuels d'un employé sur une plage de dates donnée
async function resetHoursForPeriod(employeeId, startStr, endStr) {
  const emp = employees.find(e => e.id === employeeId);
  if (!confirm(`Supprimer tous les pointages et corrections de ${emp ? emp.full_name : 'cet employé'} sur cette période ? Cette action est irréversible.`)) return;

  const { error: e1 } = await sb.from("time_logs").delete()
    .eq("employee_id", employeeId)
    .gte("timestamp", `${startStr}T00:00:00`)
    .lt("timestamp", `${endStr}T00:00:00`);

  const { error: e2 } = await sb.from("hours_adjustments").delete()
    .eq("employee_id", employeeId)
    .eq("period_type", "day")
    .gte("period_date", startStr)
    .lt("period_date", endStr);

  if (e1 || e2) { alert("Erreur lors de la suppression."); console.error(e1, e2); return; }

  await renderHoursTable();
  await renderLogsTable();
}

// --- Hours adjustment modal ---
function openAdjustmentModal(employeeId, periodType, periodDate) {
  const emp = employees.find(e => e.id === employeeId);
  document.getElementById("adjustmentEmployeeId").value = employeeId;
  document.getElementById("adjustmentPeriodDate").value = periodDate;
  document.getElementById("adjustmentEmployeeName").value = emp ? emp.full_name : "";
  document.getElementById("adjustmentHours").value = "";
  document.getElementById("adjustmentNote").value = "";
  document.getElementById("adjustmentModalOverlay").classList.add("active");
}
function closeAdjustmentModal() {
  document.getElementById("adjustmentModalOverlay").classList.remove("active");
}
async function saveAdjustment() {
  const employeeId = document.getElementById("adjustmentEmployeeId").value;
  const periodDate = document.getElementById("adjustmentPeriodDate").value;
  const hours = parseFloat(document.getElementById("adjustmentHours").value);
  const note = document.getElementById("adjustmentNote").value.trim();

  if (!periodDate) { alert("Merci de choisir une date."); return; }
  if (isNaN(hours) || hours < 0) {
    alert("Merci de saisir un nombre d'heures valide.");
    return;
  }

  const { error } = await sb.from("hours_adjustments").upsert({
    employee_id: employeeId,
    period_type: "day",
    period_date: periodDate,
    total_hours: hours,
    note: note || null
  }, { onConflict: "employee_id,period_type,period_date" });

  if (error) { alert("Erreur: " + error.message); return; }
  closeAdjustmentModal();
  await renderHoursTable();
}

// ============================================
// DETAILED LOGS TABLE + MANUAL ENTRY
// ============================================
function populateEmployeeFilters() {
  const filterSel = document.getElementById("manualLogEmployeeFilter");
  filterSel.innerHTML = `<option value="">Tous les employés</option>` +
    employees.map(e => `<option value="${e.id}">${e.full_name}</option>`).join("");

  const modalSel = document.getElementById("manualLogEmployee");
  modalSel.innerHTML = employees.map(e => `<option value="${e.id}">${e.full_name}</option>`).join("");
}

async function renderLogsTable() {
  const filterEmp = document.getElementById("manualLogEmployeeFilter").value;
  const { start, end } = getPeriodRangeFor("logsPeriodType", "logsPeriodDate");

  let query = sb.from("time_logs").select("*")
    .gte("timestamp", start.toISOString())
    .lt("timestamp", end.toISOString())
    .order("timestamp", { ascending: false })
    .limit(300);
  if (filterEmp) query = query.eq("employee_id", filterEmp);
  const { data: logs, error } = await query;
  if (error) { console.error(error); return; }

  const table = document.getElementById("logsTable");
  let html = "<tr><th>Employé</th><th>Type</th><th>Date / heure</th><th>Saisie</th><th>Selfie</th><th>Signature</th><th></th></tr>";
  if (!logs || logs.length === 0) {
    table.innerHTML = html + `<tr><td colspan="7" class="empty-state">Aucun pointage sur cette période</td></tr>`;
    return;
  }
  logs.forEach(log => {
    const emp = employees.find(e => e.id === log.employee_id);
    const d = new Date(log.timestamp);
    const dateStr = d.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
    const selfieCell = log.selfie_url
      ? `<img src="${log.selfie_url}" style="width:36px;height:36px;border-radius:8px;object-fit:cover;cursor:pointer;" onclick="viewPhoto('${log.selfie_url}', 'Selfie — ${emp ? emp.full_name : ''}')">`
      : '<span style="color:var(--gray);font-size:12px;">—</span>';
    const sigCell = log.signature_data
      ? `<img src="${log.signature_data}" style="width:50px;height:24px;object-fit:contain;background:#fff;border:1px solid var(--rose-light);border-radius:4px;cursor:pointer;" onclick="viewPhoto('${log.signature_data}', 'Signature — ${emp ? emp.full_name : ''}')">`
      : '<span style="color:var(--gray);font-size:12px;">—</span>';
    html += `<tr>
      <td>${emp ? emp.full_name : "—"}</td>
      <td><span class="pill ${log.type === 'in' ? 'green' : 'red'}">${log.type === 'in' ? 'Entrée' : 'Sortie'}</span></td>
      <td>${dateStr}</td>
      <td>${log.manual_entry ? "Manuelle" : "Kiosque"}</td>
      <td>${selfieCell}</td>
      <td>${sigCell}</td>
      <td><button onclick="editManualLog('${log.id}')" style="border:1px solid var(--rose-light);background:transparent;border-radius:8px;padding:4px 10px;cursor:pointer;">Modifier</button></td>
    </tr>`;
  });
  table.innerHTML = html;
}

function openManualLogModal() {
  document.getElementById("manualLogId").value = "";
  document.getElementById("manualLogEmployee").value = employees[0] ? employees[0].id : "";
  document.getElementById("manualLogType").value = "in";
  const now = new Date();
  document.getElementById("manualLogDate").value = fmtDate(now);
  document.getElementById("manualLogTime").value = now.toTimeString().slice(0,5);
  document.getElementById("manualLogModalOverlay").classList.add("active");
}
function viewPhoto(src, title) {
  document.getElementById("photoModalImg").src = src;
  document.getElementById("photoModalTitle").textContent = title;
  document.getElementById("photoModalOverlay").classList.add("active");
}

async function editManualLog(logId) {
  const { data, error } = await sb.from("time_logs").select("*").eq("id", logId).single();
  if (error) { alert("Erreur: " + error.message); return; }
  document.getElementById("manualLogId").value = data.id;
  document.getElementById("manualLogEmployee").value = data.employee_id;
  document.getElementById("manualLogType").value = data.type;
  const d = new Date(data.timestamp);
  document.getElementById("manualLogDate").value = fmtDate(d);
  document.getElementById("manualLogTime").value = d.toTimeString().slice(0,5);
  document.getElementById("manualLogModalOverlay").classList.add("active");
}
function closeManualLogModal() {
  document.getElementById("manualLogModalOverlay").classList.remove("active");
}
async function saveManualLog() {
  const id = document.getElementById("manualLogId").value;
  const employeeId = document.getElementById("manualLogEmployee").value;
  const type = document.getElementById("manualLogType").value;
  const dateVal = document.getElementById("manualLogDate").value;
  const timeVal = document.getElementById("manualLogTime").value;
  if (!employeeId || !dateVal || !timeVal) { alert("Merci de remplir tous les champs : employé, date et heure."); return; }

  // Construit la date/heure en heure locale (celle du kiosque/admin), puis convertit en ISO pour Supabase
  const localDateTime = new Date(`${dateVal}T${timeVal}:00`);

  const payload = {
    employee_id: employeeId,
    type,
    timestamp: localDateTime.toISOString(),
    manual_entry: true
  };

  if (id) {
    const { error } = await sb.from("time_logs").update(payload).eq("id", id);
    if (error) { alert("Erreur: " + error.message); return; }
  } else {
    const { error } = await sb.from("time_logs").insert(payload);
    if (error) { alert("Erreur: " + error.message); return; }
  }
  closeManualLogModal();
  await renderHoursTable();
  await renderLogsTable();
}

// ============================================
// MY SPACE (employé connecté, lecture seule)
// ============================================
let myspaceEmployee = null;
let myspacePinBuffer = "";

function myspaceReset() {
  myspaceEmployee = null;
  myspacePinBuffer = "";
  document.getElementById("myspaceLogin").style.display = "block";
  document.getElementById("myspaceDashboard").style.display = "none";
  document.getElementById("myspaceStepEmployee").style.display = "block";
  document.getElementById("myspaceStepPin").style.display = "none";
  loadMyspaceEmployees();
}

async function loadMyspaceEmployees() {
  const { data, error } = await sb.from("employees").select("*").eq("active", true).order("full_name");
  if (error) { console.error(error); return; }
  employees = data; // garde le cache global à jour aussi
  const grid = document.getElementById("myspaceEmployeeGrid");
  grid.innerHTML = "";
  data.forEach(emp => {
    const tile = document.createElement("div");
    tile.className = "employee-tile";
    tile.textContent = emp.full_name;
    tile.onclick = () => myspaceSelectEmployee(emp);
    grid.appendChild(tile);
  });
}

function myspaceSelectEmployee(emp) {
  myspaceEmployee = emp;
  myspacePinBuffer = "";
  myspaceUpdatePinDisplay();
  document.getElementById("myspacePinGreeting").innerHTML = `Bonjour <span style="color:var(--bordeaux)">${emp.full_name}</span>`;
  document.getElementById("myspacePinError").style.display = "none";
  document.getElementById("myspaceStepEmployee").style.display = "none";
  document.getElementById("myspaceStepPin").style.display = "block";
}

function myspaceGoBack() {
  document.getElementById("myspaceStepEmployee").style.display = "block";
  document.getElementById("myspaceStepPin").style.display = "none";
}

function myspacePinPress(digit) {
  if (myspacePinBuffer.length >= 4) return;
  myspacePinBuffer += digit;
  myspaceUpdatePinDisplay();
  if (myspacePinBuffer.length === 4) setTimeout(myspaceCheckPin, 150);
}
function myspacePinBackspace() { myspacePinBuffer = myspacePinBuffer.slice(0, -1); myspaceUpdatePinDisplay(); }
function myspacePinClear() { myspacePinBuffer = ""; myspaceUpdatePinDisplay(); }
function myspaceUpdatePinDisplay() {
  const dots = document.querySelectorAll("#myspacePinDisplay .pin-dot");
  dots.forEach((dot, i) => dot.classList.toggle("filled", i < myspacePinBuffer.length));
}

function myspaceCheckPin() {
  if (myspacePinBuffer === myspaceEmployee.pin_code) {
    document.getElementById("myspaceLogin").style.display = "none";
    document.getElementById("myspaceDashboard").style.display = "block";
    document.getElementById("myspaceTitle").textContent = `Salut ${myspaceEmployee.full_name} 👋`;
    document.getElementById("myspaceHoursPeriodDate").value = fmtDate(new Date());
    renderMyspaceSchedule();
    renderMyspaceHours();
    renderMyspaceLogs();
  } else {
    document.getElementById("myspacePinError").style.display = "block";
    myspacePinBuffer = "";
    myspaceUpdatePinDisplay();
  }
}

function myspaceLogout() {
  myspaceReset();
}

async function renderMyspaceSchedule() {
  const allShifts = await loadAllShifts();
  const myShifts = allShifts.filter(s => s.employee_id === myspaceEmployee.id);

  const table = document.getElementById("myspaceScheduleTable");
  const dayOrder = [1,2,3,4,5,6,0];
  let html = "<tr>" + dayOrder.map(d => `<th>${DAY_NAMES[d]}</th>`).join("") + "<th>Total</th></tr><tr>";
  let weekTotal = 0;
  dayOrder.forEach(day => {
    const shiftsForDay = myShifts.filter(s => s.day_of_week === day).sort((a,b) => a.shift_order - b.shift_order);
    if (shiftsForDay.length === 0) {
      html += `<td>—</td>`;
    } else if (shiftsForDay[0].is_rest) {
      html += `<td class="rest-cell">R</td>`;
    } else {
      const lines = shiftsForDay.map(s => {
        weekTotal += shiftDurationHours(s.start_time, s.end_time);
        return `<div class="shift-line">${fmtTimeShort(s.start_time)}–${fmtTimeShort(s.end_time)}</div>`;
      }).join("");
      html += `<td>${lines}</td>`;
    }
  });
  html += `<td><strong>${fmtHours(weekTotal)}</strong></td></tr>`;
  table.innerHTML = html;
}

async function renderMyspaceHours() {
  const { start, end } = getPeriodRangeFor("myspaceHoursPeriodType", "myspaceHoursPeriodDate");

  const { data: logs } = await sb.from("time_logs").select("*")
    .eq("employee_id", myspaceEmployee.id)
    .gte("timestamp", start.toISOString())
    .lt("timestamp", end.toISOString());

  const { data: dayAdjustments } = await sb.from("hours_adjustments").select("*")
    .eq("employee_id", myspaceEmployee.id)
    .eq("period_type", "day")
    .gte("period_date", fmtDate(start))
    .lt("period_date", fmtDate(end));
  const dayAdjustmentsMap = {};
  (dayAdjustments || []).forEach(a => {
    if (!dayAdjustmentsMap[a.employee_id]) dayAdjustmentsMap[a.employee_id] = {};
    dayAdjustmentsMap[a.employee_id][a.period_date] = parseFloat(a.total_hours);
  });

  const allShifts = await loadAllShifts();
  const worked = computeWorkedHoursWithAdjustments(myspaceEmployee.id, start, end, logs || [], dayAdjustmentsMap);
  const theoretical = computeTheoreticalHours(myspaceEmployee.id, start, end, allShifts);
  const diff = worked - theoretical;
  let diffClass = "hours-ok";
  if (diff > 0.05) diffClass = "hours-over";
  else if (diff < -0.05) diffClass = "hours-under";

  document.getElementById("myspaceHoursSummary").innerHTML = `
    <table>
      <tr><th>Heures travaillées</th><th>Heures prévues</th><th>Écart</th></tr>
      <tr>
        <td>${fmtHours(worked)}</td>
        <td>${fmtHours(theoretical)}</td>
        <td class="${diffClass}">${diff >= 0 ? "+" : ""}${fmtHours(diff)}</td>
      </tr>
    </table>`;
}

async function renderMyspaceLogs() {
  const { data: logs, error } = await sb.from("time_logs").select("*")
    .eq("employee_id", myspaceEmployee.id)
    .order("timestamp", { ascending: false })
    .limit(30);
  if (error) { console.error(error); return; }

  const table = document.getElementById("myspaceLogsTable");
  let html = "<tr><th>Type</th><th>Date / heure</th></tr>";
  if (!logs || logs.length === 0) {
    table.innerHTML = html + `<tr><td colspan="2" class="empty-state">Aucun pointage encore</td></tr>`;
    return;
  }
  logs.forEach(log => {
    const d = new Date(log.timestamp);
    const dateStr = d.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
    html += `<tr>
      <td><span class="pill ${log.type === 'in' ? 'green' : 'red'}">${log.type === 'in' ? 'Entrée' : 'Sortie'}</span></td>
      <td>${dateStr}</td>
    </tr>`;
  });
  table.innerHTML = html;
}

// ============================================
// INIT ON LOAD
// ============================================
window.addEventListener("DOMContentLoaded", () => {
  loadEmployeesForKiosk();
  checkKioskActivation();
  checkSecretAdminAccess();
});
window.addEventListener("hashchange", checkSecretAdminAccess);
