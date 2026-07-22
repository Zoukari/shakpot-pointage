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
let allShiftsCache = [];     // cache global du planning — rechargé uniquement au besoin

// ============================================
// UTILS DATE / HEURE
// ============================================

// Retourne le dimanche (00:00) de la semaine contenant `date` — la semaine commence le dimanche, finit le samedi
function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0 = dimanche, ... 6 = samedi
  d.setDate(d.getDate() - day);
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
    myspaceReset(); // myspaceReset appelle déjà loadMyspaceEmployees
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
    // Usage unique : on change la racine secrète immédiatement après utilisation
    // pour invalider ce code et en générer un nouveau
    const newRoot = "shakpot-" + Math.random().toString(36).slice(2) + Date.now();
    await sb.from("app_settings").upsert({ key: "kiosk_secret_root", value: newRoot });
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

// Resynchronise amount_paid de toutes les dettes livreur depuis les courses réelles
// À utiliser une fois pour corriger les données historiques
async function resyncAllDebts() {
  if (!confirm("Recalculer automatiquement les montants 'Payé' de toutes les dettes livreur depuis les courses réelles ? Cette opération peut prendre quelques secondes.")) return;
  const { data: debts } = await sb.from("accounting_delivery_debts").select("entry_date");
  if (!debts || debts.length === 0) { showToast("Aucune dette à synchroniser."); return; }
  let count = 0;
  for (const d of debts) {
    await syncDebtPaidForDate(d.entry_date);
    count++;
  }
  showToast(`✓ ${count} jours synchronisés`);
  renderAccountingSummary();
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

let allEmployeesCache = []; // actifs + inactifs, pour résoudre les noms dans les logs

async function loadEmployeesForKiosk() {
  const { data, error } = await sb.from("employees").select("*").eq("active", true).order("full_name");
  if (error) { console.error(error); return; }
  employees = data;

  // Charge aussi les inactifs pour résoudre les noms dans les logs
  const { data: allData } = await sb.from("employees").select("*").order("full_name");
  allEmployeesCache = allData || employees;

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
    await setupChooseTypeStep();
    goToStep("stepChooseType");
  } else {
    document.getElementById("pinError").style.display = "block";
    pinBuffer = "";
    updatePinDisplay();
  }
}

async function setupChooseTypeStep() {
  // Regarde le DERNIER pointage absolu (peu importe la date)
  const { data } = await sb
    .from("time_logs")
    .select("type")
    .eq("employee_id", selectedEmployee.id)
    .order("timestamp", { ascending: false })
    .limit(1);

  const lastType = (data && data.length > 0) ? data[0].type : null;

  const btnIn = document.getElementById("btnChooseIn");
  const btnOut = document.getElementById("btnChooseOut");
  const subtitle = document.getElementById("chooseTypeSubtitle");

  // Réinitialise les styles
  btnIn.disabled = false;
  btnOut.disabled = false;
  btnIn.style.opacity = "1";
  btnOut.style.opacity = "1";
  btnIn.style.background = "var(--green)";
  btnOut.style.background = "var(--red-text)";

  if (lastType === "in") {
    // Dernier pointage = entrée → seule la sortie est disponible
    btnIn.disabled = true;
    btnIn.style.opacity = "0.35";
    btnIn.style.background = "var(--gray)";
    btnIn.style.textDecoration = "line-through";
    subtitle.textContent = "Tu es déjà pointé(e) en arrivée — tu peux uniquement pointer ta sortie.";
  } else if (lastType === "out") {
    // Dernier pointage = sortie → seule l'entrée est disponible
    btnOut.disabled = true;
    btnOut.style.opacity = "0.35";
    btnOut.style.background = "var(--gray)";
    btnOut.style.textDecoration = "line-through";
    subtitle.textContent = "Tu es déjà pointé(e) en sortie — tu peux uniquement pointer ton arrivée.";
  } else {
    subtitle.textContent = "Premier pointage — bienvenue !";
  }
  btnIn.style.textDecoration = lastType === "in" ? "line-through" : "none";
  btnOut.style.textDecoration = lastType === "out" ? "line-through" : "none";
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

  // Redimensionner à 320x240 max pour garder les fichiers légers (~15-25KB)
  const MAX_W = 320, MAX_H = 240;
  const ratio = Math.min(MAX_W / video.videoWidth, MAX_H / video.videoHeight);
  canvas.width = Math.round(video.videoWidth * ratio);
  canvas.height = Math.round(video.videoHeight * ratio);

  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  selfieDataUrl = canvas.toDataURL("image/jpeg", 0.55); // ~15-25KB
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
    const msg = pendingLogType === "in"
      ? `👋 Bonne arrivée, ${selectedEmployee.full_name} !`
      : `🚀 Bonne route, ${selectedEmployee.full_name} !`;
    document.getElementById("doneMessage").textContent = msg.replace(/^[^\s]+\s/, '');
    document.getElementById("doneMessage").className = "status-msg success";
    showToast(msg);
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
  await loadEmployeesForKiosk();
  await loadAllShifts(); // précharge le cache shifts une fois pour toutes
  await renderEmployeeList();
  populateEmployeeFilters();
  setDefaultHoursPeriod();
  // Lance les rendus lourds en parallèle
  await Promise.all([
    renderScheduleGrid(),
    renderHoursTable(),
    renderLogsTable()
  ]);
  try { await renderCurrentHourlyCode(); } catch(e) { const el = document.getElementById("currentHourlyCode"); if (el) el.textContent = "Erreur"; }
  try { await renderDevicesList(); } catch(e) { const list = document.getElementById("devicesList"); if (list) list.innerHTML = `<div class="empty-state" style="color:var(--red-text);">Erreur: ${e.message||e}</div>`; }
  startHourlyCodeRefresh();
  populateChargeEmployeeSelect();
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
  const code = await computeHourlyActivationCode();
  el.textContent = code;
}

async function renderDevicesList() {
  const { data: devices, error } = await sb.from("kiosk_devices").select("*").order("activated_at", { ascending: false });
  const list = document.getElementById("devicesList");
  if (error || !devices || devices.length === 0) {
    list.innerHTML = `<div class="empty-state">Aucun appareil enregistré pour l'instant.</div>`;
    return;
  }

  const active = devices.filter(d => !d.revoked);
  const former = devices.filter(d => d.revoked);

  list.innerHTML = active.length === 0
    ? `<div class="empty-state">Aucun appareil actif.</div>`
    : active.map((d, i) => {
    const activatedStr = new Date(d.activated_at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
    const lastSeenStr = d.last_seen_at ? new Date(d.last_seen_at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "—";
    const displayName = d.device_label || `Appareil ${i + 1}`;
    return `
    <div class="emp-list-row">
      <div>
        <span class="emp-name">${displayName}${d.is_primary ? ' <span class="pill green">Principal</span>' : ''}</span>
        <div style="font-size:12px;color:var(--gray);margin-top:3px;">Activé le ${activatedStr} · Dernier pointage : ${lastSeenStr}</div>
      </div>
      <div class="emp-actions">
        <button onclick="renameDevice('${d.id}', '${(d.device_label || '').replace(/'/g, "\\'")}')">Renommer</button>
        <button onclick="revokeDevice('${d.id}')">Déconnecter</button>
      </div>
    </div>`;
  }).join("");

  // Anciens appareils déconnectés
  const formerCard = document.getElementById("formerDevicesCard");
  const formerTable = document.getElementById("formerDevicesTable");
  if (former.length > 0) {
    formerCard.style.display = "block";
    let html = "<tr><th>Nom</th><th>Activé le</th><th>Dernier pointage</th></tr>";
    former.forEach((d, i) => {
      const activatedStr = new Date(d.activated_at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
      const lastSeenStr = d.last_seen_at ? new Date(d.last_seen_at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "—";
      html += `<tr>
        <td>${d.device_label || `Appareil révoqué ${i+1}`}</td>
        <td>${activatedStr}</td>
        <td>${lastSeenStr}</td>
      </tr>`;
    });
    formerTable.innerHTML = html;
  } else {
    formerCard.style.display = "none";
  }
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
  if (tab === "accounting") initAccountingTab();
  if (tab === "settings") renderAdminShoppingList();
}

// ============================================
// EMPLOYEE MANAGEMENT
// ============================================
async function renderEmployeeList() {
  // Employés actifs
  const list = document.getElementById("employeeList");
  if (employees.length === 0) {
    list.innerHTML = `<div class="empty-state">Aucun employé pour l'instant. Clique sur "+ Ajouter un employé".</div>`;
  } else {
    list.innerHTML = employees.map(emp => `
      <div class="emp-list-row">
        <div>
          <span class="emp-name">${emp.full_name}</span>
          <span class="emp-pin">PIN: ${emp.pin_code}</span>
          ${emp.hourly_rate ? `<span class="emp-pin">${emp.hourly_rate}FDJ/h</span>` : ''}
          ${emp.comptabilite_access ? `<span class="pill green" style="margin-left:6px;">Comptabilité</span>` : ''}
          ${emp.caissier_access ? `<span class="pill green" style="margin-left:6px;">Caissier</span>` : ''}
        </div>
        <div class="emp-actions">
          <button onclick="openHistoryModal('${emp.id}')">Historique</button>
          <button onclick="openEmployeeModal('${emp.id}')">Modifier</button>
          <button onclick="deactivateEmployee('${emp.id}')">Désactiver</button>
        </div>
      </div>
    `).join("");
  }

  // Anciens employés (inactifs)
  const { data: former } = await sb.from("employees").select("*").eq("active", false).order("full_name");
  const formerCard = document.getElementById("formerEmployeesCard");
  const formerList = document.getElementById("formerEmployeeList");
  if (former && former.length > 0) {
    formerCard.style.display = "block";
    formerList.innerHTML = former.map(emp => `
      <div class="emp-list-row">
        <div>
          <span class="emp-name" style="color:var(--gray);">${emp.full_name}</span>
          <span class="emp-pin">PIN: ${emp.pin_code}</span>
        </div>
        <div class="emp-actions">
          <button onclick="openHistoryModal('${emp.id}')">Historique</button>
          <button onclick="reactivateEmployee('${emp.id}')">Réactiver</button>
        </div>
      </div>
    `).join("");
  } else {
    formerCard.style.display = "none";
  }
}

function openEmployeeModal(empId) {
  document.getElementById("employeeModalOverlay").classList.add("active");
  if (empId) {
    const emp = employees.find(e => e.id === empId);
    document.getElementById("employeeModalTitle").textContent = "Modifier l'employé";
    document.getElementById("employeeModalId").value = emp.id;
    document.getElementById("employeeModalName").value = emp.full_name;
    document.getElementById("employeeModalPin").value = emp.pin_code;
    document.getElementById("employeeModalRate").value = emp.hourly_rate || "";
    document.getElementById("employeeModalComptabilite").checked = !!emp.comptabilite_access;
    document.getElementById("employeeModalCaissier").checked = !!emp.caissier_access;
    document.getElementById("employeeModalListeCourses").checked = !!emp.liste_courses_access;
  } else {
    document.getElementById("employeeModalTitle").textContent = "Ajouter un employé";
    document.getElementById("employeeModalId").value = "";
    document.getElementById("employeeModalName").value = "";
    document.getElementById("employeeModalPin").value = "";
    document.getElementById("employeeModalRate").value = "";
    document.getElementById("employeeModalComptabilite").checked = false;
    document.getElementById("employeeModalCaissier").checked = false;
    document.getElementById("employeeModalListeCourses").checked = false;
  }
}
function closeEmployeeModal() {
  document.getElementById("employeeModalOverlay").classList.remove("active");
}
async function saveEmployee() {
  const id = document.getElementById("employeeModalId").value;
  const name = document.getElementById("employeeModalName").value.trim();
  const pin = document.getElementById("employeeModalPin").value.trim();
  const rate = document.getElementById("employeeModalRate").value;
  const compta = document.getElementById("employeeModalComptabilite").checked;
  const caissier = document.getElementById("employeeModalCaissier").checked;
  const listeCourses = document.getElementById("employeeModalListeCourses").checked;
  if (!name || !/^\d{4}$/.test(pin)) {
    alert("Merci de renseigner un nom et un code PIN à 4 chiffres.");
    return;
  }
  const payload = {
    full_name: name,
    pin_code: pin,
    hourly_rate: rate ? parseFloat(rate) : null,
    comptabilite_access: compta,
    caissier_access: caissier,
    liste_courses_access: listeCourses
  };
  if (id) {
    const { error } = await sb.from("employees").update(payload).eq("id", id);
    if (error) { alert("Erreur: " + error.message); return; }
  } else {
    const { error } = await sb.from("employees").insert(payload);
    if (error) { alert("Erreur: " + error.message); return; }
  }
  closeEmployeeModal();
  await initAdmin();
}
async function deactivateEmployee(id) {
  if (!confirm("Désactiver cet employé ? Il n'apparaîtra plus au kiosque mais ses données sont conservées.")) return;
  const { error } = await sb.from("employees").update({ active: false }).eq("id", id);
  if (error) { alert("Erreur: " + error.message); return; }
  await initAdmin();
}
async function reactivateEmployee(id) {
  if (!confirm("Réactiver cet employé ? Il réapparaîtra au kiosque.")) return;
  const { error } = await sb.from("employees").update({ active: true }).eq("id", id);
  if (error) { alert("Erreur: " + error.message); return; }
  await initAdmin();
}

// --- Historique mensuel par employé ---
const HISTORY_MONTHS_COUNT = 12; // nombre de mois passés affichés (mois en cours + 11 précédents)

async function openHistoryModal(employeeId) {
  const emp = employees.find(e => e.id === employeeId);
  document.getElementById("historyModalTitle").textContent = `Historique — ${emp ? emp.full_name : ''}`;
  document.getElementById("historyTable").innerHTML = `<tr><td class="empty-state">Calcul en cours…</td></tr>`;
  document.getElementById("historyModalOverlay").classList.add("active");

  const allShifts = await loadAllShifts();
  const now = new Date();
  const rows = [];

  for (let i = 0; i < HISTORY_MONTHS_COUNT; i++) {
    const monthDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const monthStart = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
    const monthEnd = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 1);
    const monthEndExtended = new Date(monthEnd.getTime() + 8 * 3600000); // +13h pour sorties nocturnes

    const { data: logs } = await sb.from("time_logs").select("*")
      .eq("employee_id", employeeId)
      .gte("timestamp", monthStart.toISOString())
      .lt("timestamp", monthEndExtended.toISOString());

    const { data: dayAdjustments } = await sb.from("hours_adjustments").select("*")
      .eq("employee_id", employeeId)
      .eq("period_type", "day")
      .gte("period_date", fmtDate(monthStart))
      .lt("period_date", fmtDate(monthEnd));
    const dayAdjustmentsMap = {};
    (dayAdjustments || []).forEach(a => {
      if (!dayAdjustmentsMap[a.employee_id]) dayAdjustmentsMap[a.employee_id] = {};
      dayAdjustmentsMap[a.employee_id][a.period_date] = parseFloat(a.total_hours);
    });

    const worked = computeWorkedHoursWithAdjustments(employeeId, monthStart, monthEnd, logs || [], dayAdjustmentsMap, allShifts);
    const theoretical = computeTheoreticalHours(employeeId, monthStart, monthEnd, allShifts);

    // On n'affiche pas les mois totalement vides avant l'embauche, sauf le mois en cours
    if (i > 0 && worked === 0 && theoretical === 0) continue;

    rows.push({ monthDate, worked, theoretical });
  }

  const monthNames = ["Janvier","Février","Mars","Avril","Mai","Juin","Juillet","Août","Septembre","Octobre","Novembre","Décembre"];
  let html = "<tr><th>Mois</th><th>Heures travaillées</th><th>Heures prévues</th><th>Écart</th></tr>";
  if (rows.length === 0) {
    html += `<tr><td colspan="4" class="empty-state">Aucune donnée pour l'instant</td></tr>`;
  } else {
    rows.forEach(r => {
      const diff = r.worked - r.theoretical;
      let diffClass = "hours-ok";
      if (diff > 0.05) diffClass = "hours-over";
      else if (diff < -0.05) diffClass = "hours-under";
      const label = `${monthNames[r.monthDate.getMonth()]} ${r.monthDate.getFullYear()}`;
      html += `<tr>
        <td class="emp-col">${label}</td>
        <td>${fmtHours(r.worked)}</td>
        <td>${fmtHours(r.theoretical)}</td>
        <td class="${diffClass}">${diff >= 0 ? "+" : ""}${fmtHours(diff)}</td>
      </tr>`;
    });
  }
  document.getElementById("historyTable").innerHTML = html;
}

function closeHistoryModal() {
  document.getElementById("historyModalOverlay").classList.remove("active");
}

// ============================================
// SCHEDULE (PLANNING) — un seul planning récurrent, pas de notion de semaine
// ============================================
async function loadAllShifts(forceReload = false) {
  if (!forceReload && allShiftsCache.length > 0) return allShiftsCache;
  const { data, error } = await sb.from("schedule_shifts").select("*");
  if (error) { console.error(error); return allShiftsCache; }
  allShiftsCache = data || [];
  return allShiftsCache;
}

// Lundi de la semaine actuellement affichée dans l'onglet Planning (state global, navigable)
let scheduleDisplayedWeekStart = getWeekStart(new Date());

function scheduleWeekShift(deltaWeeks, resetToToday) {
  if (resetToToday) {
    scheduleDisplayedWeekStart = getWeekStart(new Date());
  } else {
    scheduleDisplayedWeekStart = new Date(scheduleDisplayedWeekStart);
    scheduleDisplayedWeekStart.setDate(scheduleDisplayedWeekStart.getDate() + deltaWeeks * 7);
  }
  renderScheduleGrid();
}

async function renderScheduleGrid() {
  scheduleShifts = await loadAllShifts();

  const weekStart = new Date(scheduleDisplayedWeekStart); // dimanche
  const todayStr = fmtDate(new Date());

  // Construit les 7 dates réelles de la semaine affichée, dans l'ordre Dimanche -> Samedi
  const dayOrder = [0,1,2,3,4,5,6];
  const datesForDay = {}; // day_of_week -> Date object
  dayOrder.forEach((day, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    datesForDay[day] = d;
  });

  const weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 6);
  const weekLabelEl = document.getElementById("scheduleWeekLabel");
  if (weekLabelEl) {
    weekLabelEl.textContent =
      `${weekStart.getDate()}/${weekStart.getMonth()+1} → ${weekEnd.getDate()}/${weekEnd.getMonth()+1}/${weekEnd.getFullYear()}`;
  }

  const table = document.getElementById("scheduleTable");
  let html = "<tr><th>Employé</th>";
  dayOrder.forEach(day => {
    const d = datesForDay[day];
    const isToday = fmtDate(d) === todayStr;
    html += `<th class="${isToday ? 'today-col' : ''}">${DAY_NAMES[day]} ${d.getDate()}${isToday ? '<div class="today-badge">Aujourd\'hui</div>' : ''}</th>`;
  });
  html += `<th>Total théorique</th></tr>`;

  employees.forEach(emp => {
    html += `<tr><td class="emp-col">${emp.full_name}</td>`;
    let weekTotal = 0;
    dayOrder.forEach(day => {
      const isToday = fmtDate(datesForDay[day]) === todayStr;
      const todayClass = isToday ? ' today-col' : '';
      const shiftsForDay = scheduleShifts
        .filter(s => s.employee_id === emp.id && s.day_of_week === day)
        .sort((a,b) => a.shift_order - b.shift_order);

      if (shiftsForDay.length === 0) {
        html += `<td class="shift-cell${todayClass}" onclick="openShiftModal('${emp.id}', ${day})">—</td>`;
      } else if (shiftsForDay[0].is_rest) {
        html += `<td class="rest-cell${todayClass}" onclick="openShiftModal('${emp.id}', ${day})">R</td>`;
      } else {
        const lines = shiftsForDay.map(s => {
          const dur = shiftDurationHours(s.start_time, s.end_time);
          weekTotal += dur;
          return `<div class="shift-line">${fmtTimeShort(s.start_time)}–${fmtTimeShort(s.end_time)}</div>`;
        }).join("");
        html += `<td class="shift-cell${todayClass}" onclick="openShiftModal('${emp.id}', ${day})">${lines}</td>`;
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
  allShiftsCache = []; // invalide le cache pour forcer rechargement
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
  let start, end, endStrict;
  if (type === "all") {
    start = new Date(2020, 0, 1);
    end = new Date(2100, 0, 1);
    endStrict = end;
  } else if (type === "day") {
    start = new Date(date);
    // endStrict = minuit du lendemain (pour heures théoriques et ajustements)
    endStrict = new Date(date); endStrict.setDate(endStrict.getDate() + 1);
    // end étendu = lendemain 8h (pour capturer les sorties post-minuit dans la requête SQL)
    end = new Date(date); end.setDate(end.getDate() + 1); end.setHours(8, 0, 0, 0);
  } else if (type === "week") {
    start = getWeekStart(date);
    endStrict = new Date(start); endStrict.setDate(endStrict.getDate() + 7);
    end = new Date(endStrict.getTime() + 8 * 3600000); // +8h pour dernière nuit de la semaine
  } else {
    start = new Date(date.getFullYear(), date.getMonth(), 1);
    endStrict = new Date(date.getFullYear(), date.getMonth() + 1, 1);
    end = new Date(endStrict.getTime() + 8 * 3600000); // +8h pour dernière nuit du mois
  }
  return { start, end, endStrict };
}

function getPeriodRange() {
  return getPeriodRangeFor("hoursPeriodType", "hoursPeriodDate");
}

// Calcule les heures réellement travaillées par employé sur une période, à partir des paires in/out
// Convertit "HH:MM" en Date pour un jour donné (gère le passage minuit : si endTime < startTime, c'est le lendemain)
function timeStrToDate(dayDate, timeStr, isEndOfOvernightShift) {
  const [h, m] = timeStr.split(":").map(Number);
  const d = new Date(dayDate);
  d.setHours(h, m, 0, 0);
  if (isEndOfOvernightShift) d.setDate(d.getDate() + 1); // sortie le lendemain
  return d;
}

// Pour une paire entrée/sortie réelle, trouve le shift prévu le plus proche ce jour-là
// et borne l'entrée et la sortie sur les horaires prévus.
// Retourne les ms comptabilisées (0 si aucun shift trouvé pour ce jour).
function clampPairToShift(realIn, realOut, employeeId, allShifts) {
  const dayDate = new Date(realIn);
  dayDate.setHours(0, 0, 0, 0);
  const dayOfWeek = dayDate.getDay();

  const dayShifts = allShifts.filter(s =>
    s.employee_id === employeeId && s.day_of_week === dayOfWeek && !s.is_rest && s.start_time && s.end_time
  );

  if (dayShifts.length === 0) {
    // Pas de shift prévu ce jour — on compte les heures réelles (cas exceptionnel, jour non planifié)
    return (realOut - realIn);
  }

  let totalMs = 0;
  dayShifts.forEach(shift => {
    const [sh, sm] = shift.start_time.split(":").map(Number);
    const [eh, em] = shift.end_time.split(":").map(Number);
    const isOvernight = (eh * 60 + em) <= (sh * 60 + sm);

    const plannedStart = timeStrToDate(dayDate, shift.start_time, false);
    const plannedEnd = timeStrToDate(dayDate, shift.end_time, isOvernight);

    // Borne : l'entrée comptée ne peut pas être avant l'heure prévue
    const effectiveIn = realIn < plannedStart ? plannedStart : realIn;
    // Borne : la sortie comptée ne peut pas être après l'heure prévue
    const effectiveOut = realOut > plannedEnd ? plannedEnd : realOut;

    if (effectiveOut > effectiveIn) {
      totalMs += (effectiveOut - effectiveIn);
    }
  });

  return totalMs;
}

// Calcule les heures réellement comptabilisées (bornées sur le planning prévu) pour un employé sur une période
function computeWorkedHours(logs, employeeId, start, end, allShifts) {
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
      if (allShifts && allShifts.length > 0) {
        totalMs += clampPairToShift(openIn, t, employeeId, allShifts);
      } else {
        totalMs += (t - openIn);
      }
      openIn = null;
    }
  });

  // Entrée orpheline (pas de sortie) → on compte jusqu'à l'heure de fin prévue du planning
  if (openIn && allShifts && allShifts.length > 0) {
    const dayDate = new Date(openIn); dayDate.setHours(0,0,0,0);
    const dayOfWeek = dayDate.getDay();
    const dayShifts = allShifts.filter(s =>
      s.employee_id === employeeId && s.day_of_week === dayOfWeek && !s.is_rest && s.start_time && s.end_time
    );
    if (dayShifts.length > 0) {
      // Prend le shift le plus proche de l'heure d'entrée
      const shift = dayShifts[0];
      const [eh, em] = shift.end_time.split(":").map(Number);
      const [sh, sm] = shift.start_time.split(":").map(Number);
      const isOvernight = (eh * 60 + em) <= (sh * 60 + sm);
      const plannedEnd = timeStrToDate(dayDate, shift.end_time, isOvernight);
      const now = new Date();
      // On utilise l'heure prévue comme sortie implicite, sauf si elle est dans le futur
      const impliedOut = plannedEnd < now ? plannedEnd : now;
      totalMs += clampPairToShift(openIn, impliedOut, employeeId, allShifts);
    }
  }

  return totalMs / 3600000;
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

// Calcule les heures travaillées sur une période en tenant compte des ajustements JOUR PAR JOUR.
// Pour les shifts qui passent minuit (entrée le soir, sortie après minuit le lendemain),
// on calcule les paires entrée/sortie sur la plage complète, puis on soustrait les jours
// qui ont été corrigés manuellement et on remplace par l'ajustement.
function computeWorkedHoursWithAdjustments(employeeId, start, end, logs, dayAdjustmentsMap, allShifts) {
  const empAdjustments = dayAdjustmentsMap[employeeId] || {};
  const hasAnyAdjustment = Object.keys(empAdjustments).length > 0;

  if (!hasAnyAdjustment) {
    // Aucune correction manuelle : calcul borné sur toute la plage
    return computeWorkedHours(logs, employeeId, start, end, allShifts);
  }

  // Il y a des ajustements : on calcule les vraies heures sur la plage complète,
  // puis on identifie les paires entrée/sortie qui tombent dans des jours ajustés
  // et on les remplace par l'ajustement correspondant.
  const empLogs = logs
    .filter(l => l.employee_id === employeeId)
    .sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));

  let total = 0;
  let openIn = null;
  let openInDate = null;

  empLogs.forEach(log => {
    const t = new Date(log.timestamp);
    if (log.type === "in") {
      openIn = t;
      openInDate = fmtDate(t);
    } else if (log.type === "out" && openIn) {
      if (!empAdjustments[openInDate]) {
        // Pas d'ajustement pour ce jour : calcul borné sur le planning
        total += clampPairToShift(openIn, t, employeeId, allShifts || []) / 3600000;
      }
      openIn = null;
      openInDate = null;
    }
  });

  // Ajoute les ajustements manuels pour les jours qui en ont
  Object.entries(empAdjustments).forEach(([dayStr, hours]) => {
    const dayDate = new Date(dayStr + "T00:00:00");
    if (dayDate >= start && dayDate < end) {
      total += hours;
    }
  });

  return total;
}

async function renderHoursAndLogs() {
  // Lance les deux en parallèle pour éviter d'attendre l'un après l'autre
  await Promise.all([renderHoursTable(), renderLogsTable()]);
}

async function renderHoursTable() {
  const { start, end, endStrict } = getPeriodRange();
  const table = document.getElementById("hoursTable");
  table.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--gray);padding:20px;">Chargement…</td></tr>`;

  // Lancer toutes les requêtes en parallèle (3x plus rapide qu'en séquentiel)
  const [logsRes, shiftsData, adjustmentsRes] = await Promise.all([
    sb.from("time_logs").select("*")
      .gte("timestamp", start.toISOString())
      .lt("timestamp", end.toISOString()),
    loadAllShifts(),
    sb.from("hours_adjustments").select("*")
      .eq("period_type", "day")
      .gte("period_date", fmtDate(start))
      .lt("period_date", fmtDate(endStrict))
  ]);

  if (logsRes.error) { console.error(logsRes.error); return; }
  timeLogsCache = logsRes.data || [];
  const allShifts = shiftsData;

  const dayAdjustmentsMap = {};
  (adjustmentsRes.data || []).forEach(a => {
    if (!dayAdjustmentsMap[a.employee_id]) dayAdjustmentsMap[a.employee_id] = {};
    dayAdjustmentsMap[a.employee_id][a.period_date] = parseFloat(a.total_hours);
  });

  let html = "<tr><th>Employé</th><th>Heures travaillées</th><th>Heures prévues</th><th>Écart</th><th></th></tr>";
  for (const emp of employees) {
    const hasAdjustmentInPeriod = !!dayAdjustmentsMap[emp.id];
    const worked = computeWorkedHoursWithAdjustments(emp.id, start, endStrict, timeLogsCache, dayAdjustmentsMap, allShifts);
    const theoretical = computeTheoreticalHours(emp.id, start, endStrict, allShifts);
    const diff = worked - theoretical;
    let diffClass = diff > 0.05 ? "hours-over" : diff < -0.05 ? "hours-under" : "hours-ok";
    html += `<tr>
      <td class="emp-col">${emp.full_name}</td>
      <td>${fmtHours(worked)}${hasAdjustmentInPeriod ? ' <span class="pill gray" title="Contient des heures corrigées manuellement">corrigé</span>' : ''}</td>
      <td>${fmtHours(theoretical)}</td>
      <td class="${diffClass}">${diff >= 0 ? "+" : ""}${fmtHours(diff)}</td>
      <td>
        <button class="small-link" style="background:none;border:none;" onclick="openAdjustmentModal('${emp.id}', 'day', '${fmtDate(new Date())}')">Corriger un jour</button>
        ${hasAdjustmentInPeriod ? `<button class="small-link" style="background:none;border:none;color:var(--red-text);" onclick="resetHoursForPeriod('${emp.id}', '${fmtDate(start)}', '${fmtDate(endStrict)}')">Réinitialiser</button>` : ''}
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
  const table = document.getElementById("logsTable");
  table.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--gray);padding:20px;">Chargement…</td></tr>`;

  let query = sb.from("time_logs").select("*")
    .gte("timestamp", start.toISOString())
    .lt("timestamp", end.toISOString())
    .order("timestamp", { ascending: false })
    .limit(300);
  if (filterEmp) query = query.eq("employee_id", filterEmp);
  const { data: logs, error } = await query;
  if (error) { console.error(error); return; }

  let html = "<tr><th>Employé</th><th>Type</th><th>Date / heure</th><th>Saisie</th><th>Selfie</th><th>Signature</th><th></th></tr>";
  if (!logs || logs.length === 0) {
    table.innerHTML = html + `<tr><td colspan="7" class="empty-state">Aucun pointage sur cette période</td></tr>`;
    return;
  }
  logs.forEach(log => {
    const emp = allEmployeesCache.find(e => e.id === log.employee_id);
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
      <td>
        <button onclick="editManualLog('${log.id}')" style="border:1px solid var(--rose-light);background:transparent;border-radius:8px;padding:4px 10px;cursor:pointer;">Modifier</button>
        <button onclick="deleteLog('${log.id}')" style="border:1px solid var(--red-bg);background:transparent;border-radius:8px;padding:4px 10px;cursor:pointer;color:var(--red-text);margin-left:4px;">✕</button>
      </td>
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
async function deleteLog(logId) {
  if (!confirm("Supprimer ce pointage ? Cette action est irréversible.")) return;
  const { error } = await sb.from("time_logs").delete().eq("id", logId);
  if (error) { alert("Erreur: " + error.message); return; }
  await renderHoursTable();
  await renderLogsTable();
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
// CHECKLIST CAISSIER
// ============================================
const CHECKLIST_DATA = {
  arrivee: [
    "Nettoyer les vitres (aucune trace)",
    "Allumer la télé",
    "Allumer les LEDs",
    "Compter la caisse et l'ouverture",
    "Nettoyer le sol",
    "Vérifier que la terrasse est propre (tables et chaises)",
    "Publier en story les affiches Shakpot sur Snap et WhatsApp"
  ],
  service: [
    "Récupérer les commandes",
    "Lancer les Kikidrop après 10 min",
    "Lancer dans le groupe des livreurs pour voir qui est dispo",
    "En cas de litige livreur : fermer la fenêtre et changer de livreur",
    "Récupérer les feuilles des courses et les classer par jour dans le porte-vues",
    "Agrafer toutes les courses achetées pendant la soirée",
    "Nettoyer l'extérieur régulièrement après le départ des clients",
    "Vers 20h, lancer la préparation du poulet du lendemain",
    "Si livreur absent : prévenir Kikidrop et Limo que la commande va refroidir",
    "Vérifier le compte des commandes à 250 FDJ (combien garder / donner au livreur)",
    "Avertir si livreur en retard de plus de 15 min + m'avertir",
    "Ne pas répondre aux appels Kikidrop — répondre par message dans le groupe",
    "Écrire toutes les charges",
    "Commande annulée = Remboursement dans le système"
  ],
  fermetureCompta: [
    "Compter les charges",
    "Mettre 1% du CA en bas pour la sadaqa",
    "Mettre à jour les crédits non payés dans le cahier crédits",
    "Imprimer le ticket, le mettre en bas de la caisse, faire commande annulée et agrafer par personne",
    "Mettre à jour la sadaqa et les boissons dans le cahier",
    "Mettre de côté l'argent des commandes Kikidrop après minuit",
    "Kikidrop : montant × 1.18 → mettre dans le système",
    "Limo : calculer le montant, l'annoncer dans le groupe Limo et l'ajouter au système",
    "Compter le cash, WAAFI, CAC, D-MONEY",
    "Vérifier les écarts et les identifier"
  ],
  fermetureCaisse: [
    "Laisser 1 500 FDJ taxi (2 000 FDJ si Hodan ou Balbala) → à ajouter dans les charges",
    "Laisser 2 000 FDJ pour les boissons → à ajouter dans les charges et mettre en bas",
    "Laisser un fond de caisse avant de fermer (sauf commande Kikidrop après minuit → rien)",
    "Fermer la caisse et rouvrir avec le montant réel (si rien → 1 FDJ)"
  ],
  fermetureFin: [
    "Éteindre la télé et remettre sa housse",
    "Appeler le taxi"
  ]
};

function getChecklistStorageKey() {
  return `shakpot_checklist_${fmtDate(new Date())}`;
}

function loadChecklistState() {
  try {
    const saved = localStorage.getItem(getChecklistStorageKey());
    return saved ? JSON.parse(saved) : {};
  } catch(e) { return {}; }
}

function saveChecklistState(state) {
  try {
    // Nettoie les anciennes entrées (garde seulement aujourd'hui et hier)
    const today = fmtDate(new Date());
    for (let key of Object.keys(localStorage)) {
      if (key.startsWith("shakpot_checklist_") && !key.includes(today)) {
        localStorage.removeItem(key);
      }
    }
    localStorage.setItem(getChecklistStorageKey(), JSON.stringify(state));
  } catch(e) {}
}

function renderChecklist() {
  const state = loadChecklistState();

  function buildSection(containerId, items, prefix) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = items.map((item, i) => {
      const key = `${prefix}_${i}`;
      const checked = !!state[key];
      return `<label style="display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-bottom:1px solid var(--rose-light);cursor:pointer;">
        <input type="checkbox" ${checked ? 'checked' : ''} 
          style="width:18px;height:18px;flex-shrink:0;margin-top:2px;accent-color:var(--bordeaux);"
          onchange="toggleChecklistItem('${key}', this.checked)">
        <span style="${checked ? 'text-decoration:line-through;color:var(--gray);' : ''}">${item}</span>
      </label>`;
    }).join("");
  }

  buildSection("checklist-arrivee", CHECKLIST_DATA.arrivee, "arrivee");
  buildSection("checklist-service", CHECKLIST_DATA.service, "service");
  buildSection("checklist-fermeture-compta", CHECKLIST_DATA.fermetureCompta, "fermetureCompta");
  buildSection("checklist-fermeture-caisse", CHECKLIST_DATA.fermetureCaisse, "fermetureCaisse");
  buildSection("checklist-fermeture-fin", CHECKLIST_DATA.fermetureFin, "fermetureFin");
}

function toggleChecklistItem(key, checked) {
  const state = loadChecklistState();
  state[key] = checked;
  saveChecklistState(state);
  const label = event.target.closest("label");
  if (label) {
    const span = label.querySelector("span");
    if (span) span.style.cssText = checked ? "text-decoration:line-through;color:var(--gray);" : "";
  }
  if (checked) showToast("✅ Tâche cochée");
}

function resetChecklist() {
  if (!confirm("Tout décocher ? La checklist repart à zéro.")) return;
  saveChecklistState({});
  renderChecklist();
  showToast("🔄 Checklist remise à zéro");
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
  if (myspacePinBuffer !== myspaceEmployee.pin_code) {
    document.getElementById("myspacePinError").style.display = "block";
    myspacePinBuffer = "";
    myspaceUpdatePinDisplay();
    return;
  }

  document.getElementById("myspaceLogin").style.display = "none";
  document.getElementById("myspaceDashboard").style.display = "block";
  document.getElementById("myspaceTitle").textContent = `Salut ${myspaceEmployee.full_name} 👋`;
  document.getElementById("myspaceHoursPeriodDate").value = fmtDate(new Date());

  // Construire les onglets selon les rôles
  const tabs = [];
  if (!myspaceEmployee.comptabilite_access) {
    tabs.push({ id: "Planning", label: "📅 Planning" });
    tabs.push({ id: "Heures", label: "⏱ Heures" });
    tabs.push({ id: "Pointages", label: "🕐 Pointages" });
  }
  if (myspaceEmployee.caissier_access) tabs.push({ id: "Checklist", label: "📋 Checklist" });
  if (myspaceEmployee.liste_courses_access) tabs.push({ id: "Courses", label: "🛒 Courses" });
  if (myspaceEmployee.comptabilite_access) tabs.push({ id: "Compta", label: "🚚 Mes courses" });

  // Afficher la barre d'onglets
  const tabBar = document.getElementById("myspaceTabBar");
  tabBar.innerHTML = tabs.map((t, i) =>
    `<button class="myspace-tab-btn${i === 0 ? ' active' : ''}" onclick="switchMyspaceTab('${t.id}')">${t.label}</button>`
  ).join("");

  // Activer le premier onglet
  if (tabs.length > 0) switchMyspaceTab(tabs[0].id);
}

function switchMyspaceTab(tabId) {
  // Mettre à jour les boutons
  document.querySelectorAll(".myspace-tab-btn").forEach(btn => {
    btn.classList.toggle("active", btn.textContent.includes(tabId) || btn.onclick?.toString().includes(`'${tabId}'`));
  });
  // Masquer tous les panneaux
  document.querySelectorAll(".myspace-tab-panel").forEach(p => p.classList.remove("active"));
  // Afficher le panneau sélectionné
  const panel = document.getElementById(`myspaceTab${tabId}`);
  if (panel) panel.classList.add("active");

  // Charger le contenu selon l'onglet
  if (tabId === "Planning") renderMyspaceSchedule();
  else if (tabId === "Heures") renderMyspaceHours();
  else if (tabId === "Pointages") renderMyspaceLogs();
  else if (tabId === "Checklist") renderChecklist();
  else if (tabId === "Courses") initMyspaceListeCourses();
  else if (tabId === "Compta") initMyspaceAccounting();
}

function myspaceLogout() {
  myspaceReset();
}

async function renderMyspaceSchedule() {
  const allShifts = await loadAllShifts();
  const myShifts = allShifts.filter(s => s.employee_id === myspaceEmployee.id);

  const weekStart = getWeekStart(new Date());
  const todayStr = fmtDate(new Date());
  const dayOrder = [0,1,2,3,4,5,6];
  const datesForDay = {};
  dayOrder.forEach((day, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    datesForDay[day] = d;
  });

  const table = document.getElementById("myspaceScheduleTable");
  let html = "<tr>" + dayOrder.map(day => {
    const d = datesForDay[day];
    const isToday = fmtDate(d) === todayStr;
    return `<th class="${isToday ? 'today-col' : ''}">${DAY_NAMES[day]} ${d.getDate()}${isToday ? '<div class="today-badge">Aujourd\'hui</div>' : ''}</th>`;
  }).join("") + "<th>Total</th></tr><tr>";
  let weekTotal = 0;
  dayOrder.forEach(day => {
    const isToday = fmtDate(datesForDay[day]) === todayStr;
    const todayClass = isToday ? ' today-col' : '';
    const shiftsForDay = myShifts.filter(s => s.day_of_week === day).sort((a,b) => a.shift_order - b.shift_order);
    if (shiftsForDay.length === 0) {
      html += `<td class="${todayClass}">—</td>`;
    } else if (shiftsForDay[0].is_rest) {
      html += `<td class="rest-cell${todayClass}">R</td>`;
    } else {
      const lines = shiftsForDay.map(s => {
        weekTotal += shiftDurationHours(s.start_time, s.end_time);
        return `<div class="shift-line">${fmtTimeShort(s.start_time)}–${fmtTimeShort(s.end_time)}</div>`;
      }).join("");
      html += `<td class="${todayClass}">${lines}</td>`;
    }
  });
  html += `<td><strong>${fmtHours(weekTotal)}</strong></td></tr>`;
  table.innerHTML = html;
}

async function renderMyspaceHours() {
  const { start, end, endStrict } = getPeriodRangeFor("myspaceHoursPeriodType", "myspaceHoursPeriodDate");
  const endExtended = end; // déjà étendu de +8h dans getPeriodRangeFor

  const { data: logs } = await sb.from("time_logs").select("*")
    .eq("employee_id", myspaceEmployee.id)
    .gte("timestamp", start.toISOString())
    .lt("timestamp", endExtended.toISOString());

  const { data: dayAdjustments } = await sb.from("hours_adjustments").select("*")
    .eq("employee_id", myspaceEmployee.id)
    .eq("period_type", "day")
    .gte("period_date", fmtDate(start))
    .lt("period_date", fmtDate(endStrict));
  const dayAdjustmentsMap = {};
  (dayAdjustments || []).forEach(a => {
    if (!dayAdjustmentsMap[a.employee_id]) dayAdjustmentsMap[a.employee_id] = {};
    dayAdjustmentsMap[a.employee_id][a.period_date] = parseFloat(a.total_hours);
  });

  const allShifts = await loadAllShifts();
  const worked = computeWorkedHoursWithAdjustments(myspaceEmployee.id, start, endStrict, logs || [], dayAdjustmentsMap, allShifts);
  const theoretical = computeTheoreticalHours(myspaceEmployee.id, start, endStrict, allShifts);
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
// COMPTABILITÉ
// ============================================
let receiptDataUrl = null;
let myspaceReceiptDataUrl = null;

function initAccountingTab() {
  const today = fmtDate(new Date());
  document.getElementById("accountingDate").value = today;
  document.getElementById("accountingPeriodDate").value = today;
  document.getElementById("accountingPeriodType").value = "month";
  renderAccountingSummary();
  populateChargeEmployeeSelect();
}

function toggleAccountingEntryType() {
  const type = document.getElementById("accountingEntryType").value;
  ["entryCA","entryCharge","entryCourse","entryBalance","entryDebt"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  });
  if (type === "ca") document.getElementById("entryCA").style.display = "block";
  else if (type === "charge") document.getElementById("entryCharge").style.display = "block";
  else if (type === "course") document.getElementById("entryCourse").style.display = "block";
  else if (type === "balance") {
    document.getElementById("entryBalance").style.display = "block";
    loadMonthBalance();
  }
  else if (type === "debt") document.getElementById("entryDebt").style.display = "block";
}

function onAccountingDateChange() {
  const dateVal = document.getElementById("accountingDate").value;
  document.getElementById("accountingPeriodDate").value = dateVal;
  document.getElementById("accountingPeriodType").value = "day";
  renderAccountingSummary();
}

// Toast de confirmation (message en bas d'écran pendant 2 secondes)
function showToast(message, type = "success") {
  let toast = document.getElementById("globalToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "globalToast";
    toast.style.cssText = `
      position:fixed; bottom:28px; left:50%; transform:translateX(-50%);
      padding:12px 24px; border-radius:999px;
      font-weight:700; font-size:14px; z-index:9999; opacity:0;
      transition: opacity .25s ease; pointer-events:none; white-space:nowrap;
      box-shadow: 0 4px 20px rgba(0,0,0,0.2); color:#fff;
    `;
    document.body.appendChild(toast);
  }
  if (type === "success") toast.style.background = "#22c55e";
  else if (type === "error") toast.style.background = "#ef4444";
  else toast.style.background = "#1a1a2e";
  toast.textContent = message;
  toast.style.opacity = "1";
  clearTimeout(toast._timeout);
  toast._timeout = setTimeout(() => { toast.style.opacity = "0"; }, 2000);
}

function populateChargeEmployeeSelect() {
  const sel = document.getElementById("chargeEmployee");
  if (!sel) return;
  sel.innerHTML = employees.map(e => `<option value="${e.id}" data-rate="${e.hourly_rate || ''}">${e.full_name}${e.hourly_rate ? ' (' + e.hourly_rate + 'FDJ/h)' : ''}</option>`).join("");
}

function toggleChargeFields() {
  const type = document.getElementById("chargeType").value;
  document.getElementById("chargeEmployeeRow").style.display = type === "salaire" ? "block" : "none";
  document.getElementById("chargeAutreRow").style.display = type === "autre" ? "block" : "none";
  if (type === "salaire") onChargeEmployeeChange();
}

async function onChargeEmployeeChange() {
  const sel = document.getElementById("chargeEmployee");
  const empId = sel.value;
  const rate = parseFloat(sel.selectedOptions[0]?.dataset.rate || "0");
  const info = document.getElementById("chargeAutoCalcInfo");
  const amountField = document.getElementById("chargeAmount");
  if (!rate) {
    info.textContent = "Pas de taux horaire configuré pour cet employé — saisie manuelle.";
    return;
  }
  // Calcule le salaire du mois en cours basé sur les heures travaillées
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const monthEndExtended = new Date(monthEnd.getTime() + 8 * 3600000);
  const { data: logs } = await sb.from("time_logs").select("*")
    .eq("employee_id", empId)
    .gte("timestamp", monthStart.toISOString())
    .lt("timestamp", monthEndExtended.toISOString());
  const allShifts = await loadAllShifts();
  const workedH = computeWorkedHours(logs || [], empId, monthStart, monthEnd, allShifts);
  const autoSalary = (workedH * rate).toFixed(2);
  info.textContent = `Calcul auto : ${fmtHours(workedH)} × ${rate}FDJ = ${autoSalary}FDJ`;
  amountField.value = autoSalary;
}

function previewReceiptPhoto(input) {
  if (!input.files[0]) return;
  const reader = new FileReader();
  reader.onload = e => {
    receiptDataUrl = e.target.result;
    document.getElementById("receiptPhotoPreview").innerHTML = `<img src="${receiptDataUrl}" style="max-height:80px;border-radius:8px;">`;
  };
  reader.readAsDataURL(input.files[0]);
}

function previewMyspaceReceipt(input) {
  if (!input.files[0]) return;
  const reader = new FileReader();
  reader.onload = e => {
    myspaceReceiptDataUrl = e.target.result;
    document.getElementById("myspaceReceiptPreview").innerHTML = `<img src="${myspaceReceiptDataUrl}" style="max-height:80px;border-radius:8px;">`;
  };
  reader.readAsDataURL(input.files[0]);
}

async function uploadReceiptPhoto(dataUrl, enteredBy) {
  if (!dataUrl) return null;
  try {
    // Convertit en JPEG via canvas pour uniformiser le format (iOS HEIC, etc.)
    const jpeg = await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        // Réduit à 1200px max pour limiter la taille
        const maxW = 1200;
        const ratio = Math.min(maxW / img.width, maxW / img.height, 1);
        canvas.width = Math.round(img.width * ratio);
        canvas.height = Math.round(img.height * ratio);
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.75));
      };
      img.onerror = () => resolve(dataUrl); // fallback si conversion échoue
      img.src = dataUrl;
    });

    const blob = await (await fetch(jpeg)).blob();
    const fileName = `receipt_${enteredBy}_${Date.now()}.jpg`;
    const { data, error } = await sb.storage.from("receipts").upload(fileName, blob, { contentType: "image/jpeg" });
    if (error) {
      console.error("Upload reçu échoué:", error.message);
      showToast("⚠️ Photo non sauvegardée : " + error.message, "error");
      return null;
    }
    const { data: urlData } = sb.storage.from("receipts").getPublicUrl(fileName);
    return urlData.publicUrl;
  } catch(e) {
    console.error("uploadReceiptPhoto exception:", e);
    return null;
  }
}

async function saveCA() {
  const dateVal = document.getElementById("accountingDate").value;
  const amount = parseFloat(document.getElementById("caAmount").value);
  const status = document.getElementById("caStatus");
  if (!dateVal || isNaN(amount)) { alert("Merci de saisir une date et un montant."); return; }
  const { error } = await sb.from("accounting_revenue").upsert(
    { entry_date: dateVal, amount, entered_by: null },
    { onConflict: "entry_date" }
  );
  if (error) { status.textContent = "Erreur: " + error.message; return; }
  status.textContent = "";
  showToast(`📈 CA enregistré : ${amount.toFixed(0)} FDJ`);
  loadAccountingDay();
  renderAccountingSummary();
}

// Recalcule automatiquement amount_paid dans accounting_delivery_debts
// depuis le total réel des courses du jour — appelé après chaque ajout/modif/suppression de course
async function syncDebtPaidForDate(dateVal) {
  const { data: dayPurchases } = await sb.from("accounting_purchases").select("amount").eq("entry_date", dateVal);
  const autoPaid = (dayPurchases || []).reduce((s, p) => s + parseFloat(p.amount), 0);
  // Met à jour amount_paid seulement si une ligne dette existe pour ce jour
  const { data: existing } = await sb.from("accounting_delivery_debts").select("id").eq("entry_date", dateVal).maybeSingle();
  if (existing) {
    await sb.from("accounting_delivery_debts").update({ amount_paid: autoPaid }).eq("entry_date", dateVal);
  }
}

async function savePurchase() {
  const dateVal = document.getElementById("accountingDate").value;
  const store = document.getElementById("purchaseStore").value.trim();
  const amount = parseFloat(document.getElementById("purchaseAmount").value);
  if (!dateVal || !store || isNaN(amount)) { alert("Merci de remplir le magasin, le montant et la date."); return; }
  const photoUrl = await uploadReceiptPhoto(receiptDataUrl, "admin");
  const { error } = await sb.from("accounting_purchases").insert({ entry_date: dateVal, store_name: store, amount, photo_url: photoUrl, entered_by: null });
  if (error) { alert("Erreur: " + error.message); return; }
  document.getElementById("purchaseStore").value = "";
  document.getElementById("purchaseAmount").value = "";
  document.getElementById("receiptPhotoPreview").textContent = "📷 Appuyer pour prendre/choisir la photo de la facture";
  receiptDataUrl = null;
  await syncDebtPaidForDate(dateVal);
  showToast(`✓ Courses "${store}" ajoutées : ${amount.toFixed(0)} FDJ`);
  loadAccountingDay();
  renderAccountingSummary();
}

async function saveCharge() {
  const dateVal = document.getElementById("accountingDate").value;
  const type = document.getElementById("chargeType").value;
  const amount = parseFloat(document.getElementById("chargeAmount").value);
  const label = type === "autre" ? document.getElementById("chargeLabel").value.trim() : null;
  const empId = type === "salaire" ? document.getElementById("chargeEmployee").value : null;
  if (!dateVal || isNaN(amount)) { alert("Merci de saisir une date et un montant."); return; }
  const { error } = await sb.from("accounting_charges").insert({
    entry_date: dateVal, charge_type: type, amount,
    label: label || null, employee_id: empId || null, entered_by: null
  });
  if (error) { alert("Erreur: " + error.message); return; }
  document.getElementById("chargeAmount").value = "";
  if (label) document.getElementById("chargeLabel").value = "";
  const chargeLabels = { loyer:"Loyer", gaz:"Gaz", electricite:"Électricité", credit:"Crédit", salaire:"Salaire", autre:"Autre" };
  showToast(`💳 Charge ${chargeLabels[type]} — ${amount.toFixed(0)} FDJ enregistrée`);
  loadAccountingDay();
  renderAccountingSummary();
}

async function loadAccountingDay() {
  const dateVal = document.getElementById("accountingDate").value;
  if (!dateVal) return;

  const [purchasesRes, chargesRes, revenueRes] = await Promise.all([
    sb.from("accounting_purchases").select("*").eq("entry_date", dateVal).order("created_at"),
    sb.from("accounting_charges").select("*, employees(full_name)").eq("entry_date", dateVal).order("created_at"),
    sb.from("accounting_revenue").select("*").eq("entry_date", dateVal).maybeSingle()
  ]);

  // Pré-remplir le CA du jour
  if (revenueRes.data) document.getElementById("caAmount").value = revenueRes.data.amount;
  else document.getElementById("caAmount").value = "";
  document.getElementById("caStatus").textContent = "";

  const purchases = purchasesRes.data || [];
  const charges = chargesRes.data || [];
  const chargeLabels = { loyer:"Loyer", gaz:"Gaz", electricite:"Électricité", credit:"Crédit", salaire:"Salaire", autre:"Autre" };

  // Trouver ou créer un conteneur pour le détail du jour
  let dayDetailEl = document.getElementById("adminAccountingDayDetail");
  if (!dayDetailEl) {
    dayDetailEl = document.createElement("div");
    dayDetailEl.id = "adminAccountingDayDetail";
    dayDetailEl.style.marginTop = "20px";
    // On l'insère après le bloc saisie (premier .card dans le panel comptabilité)
    const panel = document.getElementById("adminPanelAccounting");
    if (panel) panel.insertBefore(dayDetailEl, panel.children[1] || null);
  }

  if (purchases.length === 0 && charges.length === 0) {
    dayDetailEl.innerHTML = "";
    return;
  }

  const d = new Date(dateVal).toLocaleDateString("fr-FR", { day: "numeric", month: "long" });
  let html = `<div class="card"><h3>Détail du ${d}</h3>`;

  if (purchases.length > 0) {
    html += `<div style="font-weight:700;color:var(--bordeaux-dark);margin-bottom:8px;">🛒 Courses</div>
    <table><tr><th>Magasin</th><th>Montant</th><th>Facture</th><th></th></tr>`;
    purchases.forEach(p => {
      html += `<tr>
        <td>${p.store_name}</td>
        <td>${parseFloat(p.amount).toFixed(2)} FDJ</td>
        <td>${p.photo_url ? `<img src="${p.photo_url}" style="height:32px;border-radius:6px;cursor:pointer;" onclick="viewPhoto('${p.photo_url}','Facture ${p.store_name}')">` : "—"}</td>
        <td><button onclick="deletePurchase('${p.id}')" style="border:none;background:var(--red-bg);color:var(--red-text);border-radius:8px;padding:4px 10px;cursor:pointer;font-weight:700;">✕</button></td>
      </tr>`;
    });
    html += `</table>`;
  }

  if (charges.length > 0) {
    html += `<div style="font-weight:700;color:var(--bordeaux-dark);margin:14px 0 8px;">💳 Charges</div>
    <table><tr><th>Type</th><th>Détail</th><th>Montant</th><th></th></tr>`;
    charges.forEach(c => {
      const detail = c.charge_type === "salaire" ? (c.employees?.full_name || "—") : (c.label || "—");
      html += `<tr>
        <td>${chargeLabels[c.charge_type] || c.charge_type}</td>
        <td>${detail}</td>
        <td>${parseFloat(c.amount).toFixed(2)} FDJ</td>
        <td><button onclick="deleteCharge('${c.id}')" style="border:none;background:var(--red-bg);color:var(--red-text);border-radius:8px;padding:4px 10px;cursor:pointer;font-weight:700;">✕</button></td>
      </tr>`;
    });
    html += `</table>`;
  }

  html += `</div>`;
  dayDetailEl.innerHTML = html;
}

async function deletePurchase(id) {
  if (!confirm("Supprimer cette ligne de courses ?")) return;
  // Récupère la date avant suppression pour pouvoir re-sync
  const { data: p } = await sb.from("accounting_purchases").select("entry_date").eq("id", id).single();
  await sb.from("accounting_purchases").delete().eq("id", id);
  if (p) await syncDebtPaidForDate(p.entry_date);
  showToast("🗑 Course supprimée");
  loadAccountingDay();
  renderAccountingSummary();
}

async function deleteCharge(id) {
  if (!confirm("Supprimer cette charge ?")) return;
  await sb.from("accounting_charges").delete().eq("id", id);
  showToast("🗑 Charge supprimée");
  loadAccountingDay();
  renderAccountingSummary();
}

function getPeriodRangeFromFields(typeId, dateId) {
  return getPeriodRangeFor(typeId, dateId);
}

async function renderAccountingSummary() {
  const { start, end } = getPeriodRangeFor("accountingPeriodType", "accountingPeriodDate");
  const startStr = fmtDate(start), endStr = fmtDate(end);
  document.getElementById("accountingSummary").innerHTML = `<div style="text-align:center;color:var(--gray);padding:20px;">Chargement…</div>`;

  const [purchasesRes, chargesRes, revenueRes, debtsRes, allDebtsRes] = await Promise.all([
    sb.from("accounting_purchases").select("*").gte("entry_date", startStr).lt("entry_date", endStr).order("entry_date").order("created_at"),
    sb.from("accounting_charges").select("*, employees(full_name)").gte("entry_date", startStr).lt("entry_date", endStr).order("entry_date").order("created_at"),
    sb.from("accounting_revenue").select("*").gte("entry_date", startStr).lt("entry_date", endStr).order("entry_date"),
    sb.from("accounting_delivery_debts").select("*").gte("entry_date", startStr).lt("entry_date", endStr).order("entry_date"),
    sb.from("accounting_delivery_debts").select("amount_given,amount_paid")
  ]);

  const purchases = purchasesRes.data || [];
  const charges = chargesRes.data || [];
  const revenues = revenueRes.data || [];
  const debts = debtsRes.data || [];
  const chargeTypeLabels = { loyer:"Loyer", gaz:"Gaz", electricite:"Électricité", credit:"Crédit", salaire:"Salaire", autre:"Autre" };

  // Regrouper par jour
  const days = new Set([
    ...revenues.map(r => r.entry_date),
    ...purchases.map(p => p.entry_date),
    ...charges.map(c => c.entry_date),
    ...debts.map(d => d.entry_date)
  ]);
  const sortedDays = [...days].sort();

  const purchasesByDay = {};
  purchases.forEach(p => { if (!purchasesByDay[p.entry_date]) purchasesByDay[p.entry_date] = []; purchasesByDay[p.entry_date].push(p); });
  const chargesByDay = {};
  charges.forEach(c => { if (!chargesByDay[c.entry_date]) chargesByDay[c.entry_date] = []; chargesByDay[c.entry_date].push(c); });
  const revenueByDay = {};
  revenues.forEach(r => { revenueByDay[r.entry_date] = r; });
  const debtByDay = {};
  debts.forEach(d => { debtByDay[d.entry_date] = d; });

  // Totaux globaux
  const totalCA = revenues.reduce((s, r) => s + parseFloat(r.amount), 0);
  const totalPurchases = purchases.reduce((s, p) => s + parseFloat(p.amount), 0);
  const totalCharges = charges.reduce((s, c) => s + parseFloat(c.amount), 0);
  const netProfit = totalCA - totalPurchases - totalCharges;
  const totalCumulatedDebt = (allDebtsRes.data || []).reduce((s, d) => s + (parseFloat(d.amount_given) - parseFloat(d.amount_paid)), 0);

  // Résumé global
  let html = `
  <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:18px;">
    <div style="background:var(--green-bg);border-radius:10px;padding:12px;text-align:center;">
      <div style="font-size:11px;color:var(--green);font-weight:700;">📈 CA total</div>
      <div style="font-size:20px;font-weight:800;color:var(--green);">${totalCA.toFixed(0)} FDJ</div>
    </div>
    <div style="background:var(--red-bg);border-radius:10px;padding:12px;text-align:center;">
      <div style="font-size:11px;color:var(--red-text);font-weight:700;">🛒 Courses</div>
      <div style="font-size:20px;font-weight:800;color:var(--red-text);">${totalPurchases.toFixed(0)} FDJ</div>
    </div>
    <div style="background:var(--red-bg);border-radius:10px;padding:12px;text-align:center;">
      <div style="font-size:11px;color:var(--red-text);font-weight:700;">💳 Charges</div>
      <div style="font-size:20px;font-weight:800;color:var(--red-text);">${totalCharges.toFixed(0)} FDJ</div>
    </div>
    <div style="background:${netProfit>=0?'var(--green-bg)':'var(--red-bg)'};border-radius:10px;padding:12px;text-align:center;">
      <div style="font-size:11px;color:${netProfit>=0?'var(--green)':'var(--red-text)'};font-weight:700;">💰 Bénéfice</div>
      <div style="font-size:20px;font-weight:800;color:${netProfit>=0?'var(--green)':'var(--red-text)'};">${netProfit>=0?'+':''}${netProfit.toFixed(0)} FDJ</div>
    </div>
  </div>
  <div style="background:${totalCumulatedDebt>=0?'var(--green-bg)':'var(--red-bg)'};border-radius:10px;padding:12px;text-align:center;margin-bottom:18px;">
    <div style="font-size:11px;color:var(--gray);font-weight:700;">🚚 Dette livreur cumulée (depuis le début)</div>
    <div style="font-size:20px;font-weight:800;color:${totalCumulatedDebt>=0?'var(--green)':'var(--red-text)'};">${totalCumulatedDebt>=0?'+':''}${totalCumulatedDebt.toFixed(0)} FDJ</div>
    <div style="font-size:11px;color:var(--gray);">${totalCumulatedDebt>=0?'Le livreur vous doit':'Vous lui devez'}</div>
  </div>`;

  if (sortedDays.length === 0) {
    html += `<div class="empty-state">Aucune donnée pour cette période.</div>`;
    document.getElementById("accountingSummary").innerHTML = html;
    return;
  }

  // Tableau style Excel
  html += `<div style="overflow-x:auto;">
  <table style="width:100%;border-collapse:collapse;font-size:13px;">
    <thead>
      <tr style="background:var(--bordeaux-dark);color:#fff;">
        <th style="padding:10px 12px;text-align:left;white-space:nowrap;">📅 Date</th>
        <th style="padding:10px 12px;text-align:right;white-space:nowrap;">📈 CA</th>
        <th style="padding:10px 12px;text-align:left;">💳 Charges (motif)</th>
        <th style="padding:10px 12px;text-align:right;white-space:nowrap;">Montant</th>
        <th style="padding:10px 12px;text-align:left;">🛒 Courses (magasin)</th>
        <th style="padding:10px 12px;text-align:right;white-space:nowrap;">Montant</th>
        <th style="padding:10px 12px;text-align:right;white-space:nowrap;">🚚 Donné</th>
      </tr>
    </thead>
    <tbody>`;

  sortedDays.forEach((date, dayIdx) => {
    const rev = revenueByDay[date];
    const dayPurchases = purchasesByDay[date] || [];
    const dayCharges = chargesByDay[date] || [];
    const debt = debtByDay[date];
    const dayCA = rev ? parseFloat(rev.amount) : null;
    const dayGiven = debt ? parseFloat(debt.amount_given) : null;

    const maxRows = Math.max(dayPurchases.length, dayCharges.length, 1);
    const rowBg = dayIdx % 2 === 0 ? "#fff" : "var(--rose-pale)";

    for (let i = 0; i < maxRows; i++) {
      const p = dayPurchases[i];
      const c = dayCharges[i];
      const chargeLabel = c ? (chargeTypeLabels[c.charge_type] || c.charge_type) + (c.charge_type === 'salaire' ? ' — ' + (c.employees?.full_name || '') : c.label ? ' — ' + c.label : '') : '';

      html += `<tr style="background:${rowBg};border-bottom:1px solid var(--rose-light);">`;

      // Colonne date (rowspan sur la 1ère ligne du jour seulement)
      if (i === 0) {
        html += `<td style="padding:8px 12px;font-weight:700;white-space:nowrap;vertical-align:top;" rowspan="${maxRows}">${date}</td>`;
        // CA
        html += `<td style="padding:8px 12px;text-align:right;font-weight:700;color:var(--green);white-space:nowrap;vertical-align:top;" rowspan="${maxRows}">
          ${dayCA !== null ? dayCA.toFixed(0) + ' FDJ' : '—'}
          ${rev ? `<br><span style="font-weight:400;font-size:11px;">
            <button onclick="editCA('${rev.id}','${date}',${rev.amount})" style="border:none;background:none;cursor:pointer;color:var(--gray);">✏</button>
            <button onclick="deleteCA('${rev.id}')" style="border:none;background:none;cursor:pointer;color:var(--red-text);">✕</button>
          </span>` : ''}
        </td>`;
      }

      // Charge
      if (c) {
        html += `<td style="padding:6px 12px;vertical-align:top;">${chargeLabel}</td>
        <td style="padding:6px 12px;text-align:right;white-space:nowrap;vertical-align:top;">
          ${parseFloat(c.amount).toFixed(0)} FDJ
          <button onclick="editCharge('${c.id}','${c.entry_date}',${c.amount})" style="border:none;background:none;cursor:pointer;font-size:11px;color:var(--gray);">✏</button>
          <button onclick="deleteCharge('${c.id}')" style="border:none;background:none;cursor:pointer;font-size:11px;color:var(--red-text);">✕</button>
        </td>`;
      } else {
        html += `<td style="padding:6px 12px;color:var(--gray);">—</td><td></td>`;
      }

      // Course
      if (p) {
        html += `<td style="padding:6px 12px;vertical-align:top;">
          ${p.store_name}
          ${p.photo_url ? `<img src="${p.photo_url}" style="height:18px;border-radius:3px;vertical-align:middle;margin-left:4px;cursor:pointer;" onclick="viewPhoto('${p.photo_url}','Facture — ${p.store_name}')">` : ''}
        </td>
        <td style="padding:6px 12px;text-align:right;white-space:nowrap;vertical-align:top;">
          ${parseFloat(p.amount).toFixed(0)} FDJ
          <button onclick="editPurchase('${p.id}','${p.entry_date}','${p.store_name.replace(/'/g,"\'")}',${p.amount})" style="border:none;background:none;cursor:pointer;font-size:11px;color:var(--gray);">✏</button>
          <button onclick="deletePurchase('${p.id}')" style="border:none;background:none;cursor:pointer;font-size:11px;color:var(--red-text);">✕</button>
        </td>`;
      } else {
        html += `<td style="padding:6px 12px;color:var(--gray);">—</td><td></td>`;
      }

      // Donné livreur (1ère ligne seulement)
      if (i === 0) {
        html += `<td style="padding:8px 12px;text-align:right;white-space:nowrap;font-weight:700;color:var(--bordeaux-dark);vertical-align:top;" rowspan="${maxRows}">
          ${dayGiven !== null ? dayGiven.toFixed(0) + ' FDJ' : '—'}
          ${debt ? `<br><span style="font-weight:400;font-size:11px;">
            <button onclick="editDebt('${debt.id}')" style="border:none;background:none;cursor:pointer;color:var(--gray);">✏</button>
            <button onclick="deleteDebt('${debt.id}')" style="border:none;background:none;cursor:pointer;color:var(--red-text);">✕</button>
          </span>` : ''}
        </td>`;
      }

      html += `</tr>`;
    }

    // Ligne total du jour
    const dayPurchasesTotal = dayPurchases.reduce((s, p) => s + parseFloat(p.amount), 0);
    const dayChargesTotal = dayCharges.reduce((s, c) => s + parseFloat(c.amount), 0);
    const dayProfit = (dayCA||0) - dayPurchasesTotal - dayChargesTotal;
    html += `<tr style="background:var(--rose-pale);border-bottom:2px solid var(--bordeaux);">
      <td colspan="2" style="padding:6px 12px;font-size:11px;color:var(--gray);">Bénéfice : <strong style="color:${dayProfit>=0?'var(--green)':'var(--red-text)'};">${dayProfit>=0?'+':''}${dayProfit.toFixed(0)} FDJ</strong></td>
      <td style="padding:6px 12px;font-size:11px;text-align:right;font-weight:700;color:var(--red-text);">${dayChargesTotal>0?dayChargesTotal.toFixed(0)+' FDJ':''}</td>
      <td></td>
      <td style="padding:6px 12px;font-size:11px;text-align:right;font-weight:700;color:var(--red-text);">${dayPurchasesTotal>0?dayPurchasesTotal.toFixed(0)+' FDJ':''}</td>
      <td></td>
      <td></td>
    </tr>`;
  });

  // Ligne totaux
  html += `<tr style="background:var(--bordeaux-dark);color:#fff;font-weight:800;">
    <td style="padding:10px 12px;">TOTAL</td>
    <td style="padding:10px 12px;text-align:right;">${totalCA.toFixed(0)} FDJ</td>
    <td></td>
    <td style="padding:10px 12px;text-align:right;">${totalCharges.toFixed(0)} FDJ</td>
    <td></td>
    <td style="padding:10px 12px;text-align:right;">${totalPurchases.toFixed(0)} FDJ</td>
    <td style="padding:10px 12px;text-align:right;">${debts.reduce((s,d)=>s+parseFloat(d.amount_given),0).toFixed(0)} FDJ</td>
  </tr>`;

  html += `</tbody></table></div>`;
  document.getElementById("accountingSummary").innerHTML = html;
}




async function editCA(id, date, currentAmount) {
  const val = prompt(`Modifier le CA du ${date} (FDJ) :`, currentAmount);
  if (val === null) return;
  const amount = parseFloat(val);
  if (isNaN(amount)) { alert("Montant invalide."); return; }
  await sb.from("accounting_revenue").update({ amount }).eq("id", id);
  showToast(`📈 CA modifié : ${amount.toFixed(0)} FDJ`);
  loadAccountingDay();
  renderAccountingSummary();
}
async function deleteCA(id) {
  if (!confirm("Supprimer ce CA ?")) return;
  await sb.from("accounting_revenue").delete().eq("id", id);
  showToast("🗑 CA supprimé");
  loadAccountingDay();
  renderAccountingSummary();
}

// --- Modifier courses ---
async function editPurchase(id, date, store, currentAmount) {
  const newStore = prompt(`Magasin (${date}) :`, store);
  if (newStore === null) return;
  const newAmount = prompt(`Montant (FDJ) :`, currentAmount);
  if (newAmount === null) return;
  const amount = parseFloat(newAmount);
  if (isNaN(amount)) { alert("Montant invalide."); return; }
  await sb.from("accounting_purchases").update({ store_name: newStore.trim(), amount }).eq("id", id);
  await syncDebtPaidForDate(date);
  showToast(`✏️ ${newStore} — ${amount.toFixed(0)} FDJ modifié`);
  loadAccountingDay();
  renderAccountingSummary();
}

// --- Modifier charges ---
async function editCharge(id, date, currentAmount) {
  const newAmount = prompt(`Nouveau montant pour cette charge du ${date} (FDJ) :`, currentAmount);
  if (newAmount === null) return;
  const amount = parseFloat(newAmount);
  if (isNaN(amount)) { alert("Montant invalide."); return; }
  await sb.from("accounting_charges").update({ amount }).eq("id", id);
  showToast(`✏️ Charge modifiée : ${amount.toFixed(0)} FDJ`);
  loadAccountingDay();
  renderAccountingSummary();
}

// --- Mon espace comptabilité (employé assigné) ---
async function initMyspaceAccounting() {
  const today = fmtDate(new Date());
  document.getElementById("myspaceAccountingDate").value = today;
  document.getElementById("myspaceDebtPeriodDate").value = today;
  loadMyspaceAccountingDay();
  renderMyspaceDebtSummary();
}

async function renderMyspaceDebtSummary() {
  const { start, end } = getPeriodRangeFor("myspaceDebtPeriodType", "myspaceDebtPeriodDate");
  const startStr = fmtDate(start), endStr = fmtDate(end);

  const [purchasesRes, debtsRes] = await Promise.all([
    sb.from("accounting_purchases").select("*").gte("entry_date", startStr).lt("entry_date", endStr).order("entry_date").order("created_at"),
    sb.from("accounting_delivery_debts").select("*").gte("entry_date", startStr).lt("entry_date", endStr).order("entry_date")
  ]);

  const purchases = purchasesRes.data || [];
  const debts = debtsRes.data || [];
  const el = document.getElementById("myspaceDebtTable");

  if (purchases.length === 0 && debts.length === 0) {
    el.innerHTML = `<div style="text-align:center;color:var(--gray);padding:16px;">Aucune donnée pour cette période.</div>`;
    return;
  }

  const days = new Set([...purchases.map(p => p.entry_date), ...debts.map(d => d.entry_date)]);
  const purchasesByDay = {};
  purchases.forEach(p => { if (!purchasesByDay[p.entry_date]) purchasesByDay[p.entry_date] = []; purchasesByDay[p.entry_date].push(p); });
  const debtByDay = {};
  debts.forEach(d => { debtByDay[d.entry_date] = d; });

  let html = "";
  let totalGiven = 0, totalCourses = 0;

  [...days].sort().forEach(date => {
    const dayPurchases = purchasesByDay[date] || [];
    const debt = debtByDay[date];
    const dayTotal = dayPurchases.reduce((s, p) => s + parseFloat(p.amount), 0);
    const given = debt ? parseFloat(debt.amount_given) : 0;
    const solde = given - dayTotal;
    totalGiven += given;
    totalCourses += dayTotal;

    html += `<div style="border:1px solid var(--rose-light);border-radius:10px;margin-bottom:8px;overflow:hidden;">
      <div style="background:var(--rose-pale);padding:10px 14px;display:flex;justify-content:space-between;align-items:center;">
        <strong>${date}</strong>
        <span style="color:${solde >= 0 ? 'var(--green)' : 'var(--red-text)'};font-weight:700;">${solde >= 0 ? '+' : ''}${solde.toFixed(0)} FDJ</span>
      </div>
      <div style="padding:10px 14px;">
        <!-- Montant reçu modifiable -->
        <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--rose-light);font-size:14px;">
          <span>💵 Reçu</span>
          <span>
            <strong>${given.toFixed(0)} FDJ</strong>
            ${debt ? `
              <button onclick="editMyspaceDebt('${debt.id}')" style="border:none;background:none;cursor:pointer;color:var(--gray);font-size:13px;margin-left:6px;">✏</button>
              <button onclick="deleteMyspaceDebt('${debt.id}','${date}')" style="border:none;background:none;cursor:pointer;color:var(--red-text);font-size:13px;">✕</button>` : ''}
          </span>
        </div>
        <!-- Courses modifiables -->
        ${dayPurchases.map(p => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--rose-light);font-size:13px;color:var(--gray);">
          <span>${p.store_name}</span>
          <span>
            ${parseFloat(p.amount).toFixed(0)} FDJ
            <button onclick="editMyspacePurchase('${p.id}','${p.store_name.replace(/'/g,"\\'")}',${p.amount})" style="border:none;background:none;cursor:pointer;color:var(--gray);font-size:12px;margin-left:4px;">✏</button>
            <button onclick="deleteMyspacePurchaseFromSummary('${p.id}','${date}')" style="border:none;background:none;cursor:pointer;color:var(--red-text);font-size:12px;">✕</button>
          </span>
        </div>`).join("")}
        <div style="display:flex;justify-content:space-between;padding-top:6px;font-size:13px;font-weight:700;color:var(--red-text);">
          <span>🛒 Total courses</span><span>${dayTotal.toFixed(0)} FDJ</span>
        </div>
      </div>
    </div>`;
  });

  const soldeTotal = totalGiven - totalCourses;
  html = `<div style="background:${soldeTotal >= 0 ? 'var(--green-bg)' : 'var(--red-bg)'};border-radius:12px;padding:14px;text-align:center;margin-bottom:14px;">
    <div style="font-size:12px;color:var(--gray);font-weight:700;margin-bottom:4px;">Solde total de la période</div>
    <div style="font-size:26px;font-weight:800;color:${soldeTotal >= 0 ? 'var(--green)' : 'var(--red-text)'};">${soldeTotal >= 0 ? '+' : ''}${soldeTotal.toFixed(0)} FDJ</div>
    <div style="font-size:12px;color:var(--gray);margin-top:2px;">${soldeTotal >= 0 ? '✓ Je dois rendre ce montant' : '⚠ Je suis en déficit'}</div>
  </div>` + html;

  el.innerHTML = html;
}

async function editMyspaceDebt(id) {
  const { data } = await sb.from("accounting_delivery_debts").select("*").eq("id", id).single();
  if (!data) return;
  const newVal = prompt("Montant reçu (FDJ) :", data.amount_given);
  if (newVal === null) return;
  const amount = parseFloat(newVal);
  if (isNaN(amount)) { alert("Montant invalide."); return; }
  await sb.from("accounting_delivery_debts").update({ amount_given: amount }).eq("id", id);
  showToast("✓ Modifié");
  loadMyspaceAccountingDay();
  renderMyspaceDebtSummary();
}

async function deleteMyspaceDebt(id, date) {
  if (!confirm("Supprimer le montant reçu pour ce jour ?")) return;
  await sb.from("accounting_delivery_debts").delete().eq("id", id);
  showToast("✓ Supprimé");
  loadMyspaceAccountingDay();
  renderMyspaceDebtSummary();
}

async function editMyspacePurchase(id, store, amount) {
  const newStore = prompt("Magasin :", store);
  if (newStore === null) return;
  const newAmount = prompt("Montant (FDJ) :", amount);
  if (newAmount === null) return;
  const val = parseFloat(newAmount);
  if (isNaN(val)) { alert("Montant invalide."); return; }
  await sb.from("accounting_purchases").update({ store_name: newStore.trim(), amount: val }).eq("id", id);
  const { data: p } = await sb.from("accounting_purchases").select("entry_date").eq("id", id).maybeSingle();
  if (p) await syncDebtPaidForDate(p.entry_date);
  showToast("✓ Course modifiée");
  loadMyspaceAccountingDay();
  renderMyspaceDebtSummary();
}

async function deleteMyspacePurchaseFromSummary(id, date) {
  if (!confirm("Supprimer cette course ?")) return;
  await sb.from("accounting_purchases").delete().eq("id", id);
  await syncDebtPaidForDate(date);
  showToast("✓ Course supprimée");
  loadMyspaceAccountingDay();
  renderMyspaceDebtSummary();
}

async function loadMyspaceAccountingDay() {
  const dateVal = document.getElementById("myspaceAccountingDate").value;
  if (!dateVal) return;

  const [purchasesRes, debtRes] = await Promise.all([
    sb.from("accounting_purchases").select("*").eq("entry_date", dateVal).order("created_at"),
    sb.from("accounting_delivery_debts").select("*").eq("entry_date", dateVal).maybeSingle()
  ]);

  const purchases = purchasesRes.data || [];
  const debt = debtRes.data;
  const totalCourses = purchases.reduce((s, p) => s + parseFloat(p.amount), 0);
  const given = debt ? parseFloat(debt.amount_given) : 0;
  const solde = given - totalCourses;

  // Pré-remplir le montant donné si déjà saisi
  if (debt) document.getElementById("myspaceDebtGiven").value = debt.amount_given;

  // Récap courses du jour
  const recap = document.getElementById("myspaceDayRecap");
  if (purchases.length === 0) {
    recap.innerHTML = `<div style="color:var(--gray);font-size:13px;text-align:center;padding:12px;">Aucune course saisie pour ce jour.</div>`;
  } else {
    let html = `<div style="font-weight:700;color:var(--bordeaux-dark);margin-bottom:8px;">🛒 Courses saisies</div>`;
    purchases.forEach(p => {
      html += `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--rose-light);font-size:14px;">
        <span>${p.store_name}</span>
        <span style="font-weight:700;">${parseFloat(p.amount).toFixed(0)} FDJ
          <button onclick="deleteMyspacePurchase('${p.id}')" style="border:none;background:none;cursor:pointer;color:var(--red-text);font-size:13px;margin-left:4px;">✕</button>
        </span>
      </div>`;
    });
    html += `<div style="display:flex;justify-content:space-between;padding:8px 0;font-weight:800;font-size:15px;color:var(--bordeaux-dark);">
      <span>Total courses</span><span>${totalCourses.toFixed(0)} FDJ</span>
    </div>`;
    recap.innerHTML = html;
  }

  // Solde livreur
  const summary = document.getElementById("myspaceDebtSummary");
  if (given > 0 || totalCourses > 0) {
    summary.innerHTML = `
      <div style="font-weight:800;color:var(--bordeaux-dark);margin-bottom:12px;">📊 Solde du jour</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">
        <div style="background:var(--rose-pale);border-radius:10px;padding:12px;text-align:center;">
          <div style="font-size:11px;color:var(--gray);font-weight:700;">Reçu</div>
          <div style="font-size:20px;font-weight:800;color:var(--bordeaux-dark);">${given.toFixed(0)} FDJ</div>
        </div>
        <div style="background:var(--rose-pale);border-radius:10px;padding:12px;text-align:center;">
          <div style="font-size:11px;color:var(--gray);font-weight:700;">Dépensé</div>
          <div style="font-size:20px;font-weight:800;color:var(--red-text);">${totalCourses.toFixed(0)} FDJ</div>
        </div>
      </div>
      <div style="background:${solde >= 0 ? 'var(--green-bg)' : 'var(--red-bg)'};border-radius:12px;padding:16px;text-align:center;">
        <div style="font-size:13px;color:${solde >= 0 ? 'var(--green)' : 'var(--red-text)'};font-weight:700;">
          ${solde >= 0 ? '✓ Je dois rendre' : '⚠ Je suis en déficit'}
        </div>
        <div style="font-size:28px;font-weight:800;color:${solde >= 0 ? 'var(--green)' : 'var(--red-text)'};">
          ${solde >= 0 ? '+' : ''}${solde.toFixed(0)} FDJ
        </div>
      </div>`;
  } else {
    summary.innerHTML = "";
  }
}

async function saveMyspacePurchase() {
  const dateVal = document.getElementById("myspaceAccountingDate").value;
  const store = document.getElementById("myspacePurchaseStore").value.trim();
  const amount = parseFloat(document.getElementById("myspacePurchaseAmount").value);
  if (!store || isNaN(amount) || amount <= 0) { alert("Merci de remplir le magasin et un montant valide."); return; }
  const photoUrl = await uploadReceiptPhoto(myspaceReceiptDataUrl, myspaceEmployee.id);
  const { error } = await sb.from("accounting_purchases").insert({
    entry_date: dateVal, store_name: store, amount,
    photo_url: photoUrl, entered_by: myspaceEmployee.id
  });
  if (error) { alert("Erreur: " + error.message); return; }
  document.getElementById("myspacePurchaseStore").value = "";
  document.getElementById("myspacePurchaseAmount").value = "";
  document.getElementById("myspaceReceiptPreview").textContent = "📷 Photo de la facture (optionnel)";
  myspaceReceiptDataUrl = null;
  await syncDebtPaidForDate(dateVal);
  showToast(`🛒 ${store} — ${amount.toFixed(0)} FDJ enregistré`);
  renderMyspaceDebtSummary();
}

async function deleteMyspacePurchase(id) {
  if (!confirm("Supprimer cette course ?")) return;
  const { data: p } = await sb.from("accounting_purchases").select("entry_date").eq("id", id).single();
  await sb.from("accounting_purchases").delete().eq("id", id);
  if (p) await syncDebtPaidForDate(p.entry_date);
  loadMyspaceAccountingDay();
}

async function saveMyspaceCharge() {
  const dateVal = document.getElementById("myspaceAccountingDate").value;
  const type = document.getElementById("myspaceChargeType").value;
  const amount = parseFloat(document.getElementById("myspaceChargeAmount").value);
  const label = type === "autre" ? document.getElementById("myspaceChargeLabel").value.trim() : null;
  const empId = type === "salaire" ? document.getElementById("myspaceChargeEmployee").value : null;
  if (isNaN(amount) || amount <= 0) { alert("Merci de saisir un montant valide."); return; }
  const { error } = await sb.from("accounting_charges").insert({
    entry_date: dateVal, charge_type: type, amount,
    label: label || null, employee_id: empId || null,
    entered_by: myspaceEmployee.id
  });
  if (error) { alert("Erreur: " + error.message); return; }
  document.getElementById("myspaceChargeAmount").value = "";
  if (label) document.getElementById("myspaceChargeLabel").value = "";
  loadMyspaceAccountingDay();
}

async function submitMyspaceDay() {
  const dateVal = document.getElementById("myspaceAccountingDate").value;
  if (!dateVal) return;
  const d = new Date(dateVal).toLocaleDateString("fr-FR", { day: "numeric", month: "long" });
  if (!confirm(`Valider définitivement les informations du ${d} ? Cette action est irréversible depuis cet écran.`)) return;

  const { error } = await sb.from("accounting_submitted_days").insert({
    entry_date: dateVal,
    submitted_by: myspaceEmployee.id
  });
  if (error) { alert("Erreur: " + error.message); return; }
  loadMyspaceAccountingDay(); // rechargera et affichera le message de confirmation
}

// ============================================
// DETTE LIVREUR
// ============================================
function toggleDayDetail(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = el.style.display === "none" ? "block" : "none";
}

async function deleteDebt(id) {
  if (!confirm("Supprimer cette dette livreur ?")) return;
  const { error } = await sb.from("accounting_delivery_debts").delete().eq("id", id);
  if (error) { alert("Erreur: " + error.message); return; }
  showToast("✓ Dette supprimée");
  loadAccountingDay();
  renderAccountingSummary();
}

async function editDebt(id) {
  const { data, error } = await sb.from("accounting_delivery_debts").select("*").eq("id", id).single();
  if (error) { alert("Erreur: " + error.message); return; }
  const newGiven = prompt("Montant donné au livreur (FDJ) :", data.amount_given);
  if (newGiven === null) return;
  const newPaid = prompt("Montant payé par le livreur (FDJ) :", data.amount_paid);
  if (newPaid === null) return;
  const newNote = prompt("Note (optionnel) :", data.note || "");
  const { error: updateError } = await sb.from("accounting_delivery_debts").update({
    amount_given: parseFloat(newGiven) || 0,
    amount_paid: parseFloat(newPaid) || 0,
    note: newNote || null
  }).eq("id", id);
  if (updateError) { alert("Erreur: " + updateError.message); return; }
  showToast("✓ Dette modifiée");
  loadAccountingDay();
  renderAccountingSummary();
}
async function saveDebt() {
  const dateVal = document.getElementById("accountingDate").value;
  const given = parseFloat(document.getElementById("debtGiven").value) || 0;
  const note = document.getElementById("debtNote").value.trim();
  if (given === 0) { alert("Merci de saisir le montant donné au livreur."); return; }

  // Récupère le total des courses du jour pour calculer "Payé" automatiquement
  const { data: dayPurchases } = await sb.from("accounting_purchases").select("amount").eq("entry_date", dateVal);
  const autoPaid = (dayPurchases || []).reduce((s, p) => s + parseFloat(p.amount), 0);

  const { error } = await sb.from("accounting_delivery_debts").upsert({
    entry_date: dateVal, amount_given: given, amount_paid: autoPaid,
    note: note || null, entered_by: null
  }, { onConflict: "entry_date" });
  if (error) { alert("Erreur: " + error.message); return; }
  document.getElementById("debtGiven").value = "";
  document.getElementById("debtNote").value = "";
  const solde = given - autoPaid;
  showToast(`✓ Livreur : donné ${given.toFixed(0)} FDJ, courses ${autoPaid.toFixed(0)} FDJ, solde ${solde >= 0 ? '+' : ''}${solde.toFixed(0)} FDJ`);
  loadAccountingDay();
  renderAccountingSummary();
}

async function saveDebtAnnex() {
  const dateVal = document.getElementById("debtAnnexDate").value;
  const amount = parseFloat(document.getElementById("debtAnnexAmount").value);
  const motif = document.getElementById("debtAnnexMotif").value.trim();
  if (!dateVal || isNaN(amount) || amount === 0) { alert("Merci de remplir la date et le montant."); return; }
  const { error } = await sb.from("accounting_delivery_annex").insert({
    entry_date: dateVal, amount, motif: motif || null, entered_by: null
  });
  if (error) { alert("Erreur: " + error.message); return; }
  document.getElementById("debtAnnexAmount").value = "";
  document.getElementById("debtAnnexMotif").value = "";
  showToast(`✓ Annexe livreur ajoutée : ${amount.toFixed(0)} FDJ`);
  renderAccountingSummary();
}

async function deleteDebtAnnex(id) {
  if (!confirm("Supprimer cette annexe ?")) return;
  await sb.from("accounting_delivery_annex").delete().eq("id", id);
  renderAccountingSummary();
}

async function saveMyspaceDebt() {
  const dateVal = document.getElementById("myspaceAccountingDate").value;
  const given = parseFloat(document.getElementById("myspaceDebtGiven").value) || 0;
  if (given === 0) { alert("Merci de saisir le montant reçu."); return; }
  const { data: dayPurchases } = await sb.from("accounting_purchases").select("amount").eq("entry_date", dateVal);
  const autoPaid = (dayPurchases || []).reduce((s, p) => s + parseFloat(p.amount), 0);
  const { error } = await sb.from("accounting_delivery_debts").upsert({
    entry_date: dateVal, amount_given: given, amount_paid: autoPaid,
    entered_by: myspaceEmployee ? myspaceEmployee.id : null
  }, { onConflict: "entry_date" });
  if (error) { alert("Erreur: " + error.message); return; }
  document.getElementById("myspaceDebtGiven").value = "";
  showToast(`💵 ${given.toFixed(0)} FDJ reçu enregistré`);
  renderMyspaceDebtSummary();
}

// ============================================
// ARGENT DU MOIS (solde de départ)
// ============================================
async function loadMonthBalance() {
  const { start } = getPeriodRangeFor("accountingPeriodType", "accountingPeriodDate");
  const monthStart = new Date(start.getFullYear(), start.getMonth(), 1);
  const prevMonthStart = new Date(start.getFullYear(), start.getMonth() - 1, 1);
  const prevMonthEnd = new Date(start.getFullYear(), start.getMonth(), 1);

  // Calcule le bénéfice net du mois précédent automatiquement
  const prevStartStr = fmtDate(prevMonthStart);
  const prevEndStr = fmtDate(prevMonthEnd);
  const [purchasesRes, chargesRes, revenueRes] = await Promise.all([
    sb.from("accounting_purchases").select("amount").gte("entry_date", prevStartStr).lt("entry_date", prevEndStr),
    sb.from("accounting_charges").select("amount").gte("entry_date", prevStartStr).lt("entry_date", prevEndStr),
    sb.from("accounting_revenue").select("amount").gte("entry_date", prevStartStr).lt("entry_date", prevEndStr)
  ]);
  const totalCA = (revenueRes.data || []).reduce((s, r) => s + parseFloat(r.amount), 0);
  const totalPurchases = (purchasesRes.data || []).reduce((s, p) => s + parseFloat(p.amount), 0);
  const totalCharges = (chargesRes.data || []).reduce((s, c) => s + parseFloat(c.amount), 0);
  // Bénéfice M-1 = CA - courses - charges (dette livreur exclue, c'est un suivi séparé)
  const autoPrevBenefit = totalCA - totalPurchases - totalCharges;
  document.getElementById("monthBalanceAutoAmount").textContent = autoPrevBenefit.toFixed(2) + " FDJ";

  // Récupère la saisie manuelle si elle existe
  const monthStr = fmtDate(monthStart);
  const { data: balance } = await sb.from("accounting_month_balance").select("*").eq("month_date", monthStr).maybeSingle();
  if (balance && balance.manual_override !== null) {
    document.getElementById("monthBalanceManual").value = balance.manual_override;
  } else {
    document.getElementById("monthBalanceManual").value = "";
  }
}

async function saveMonthBalance() {
  const { start } = getPeriodRangeFor("accountingPeriodType", "accountingPeriodDate");
  const monthStart = new Date(start.getFullYear(), start.getMonth(), 1);
  const monthStr = fmtDate(monthStart);
  const manual = parseFloat(document.getElementById("monthBalanceManual").value);
  const { error } = await sb.from("accounting_month_balance").upsert({
    month_date: monthStr,
    manual_override: isNaN(manual) ? null : manual
  }, { onConflict: "month_date" });
  if (error) { alert("Erreur: " + error.message); return; }
  const msg = document.getElementById("monthBalanceMsg");
  msg.textContent = "✓ Enregistré";
  msg.style.color = "var(--green)";
  setTimeout(() => { msg.textContent = ""; }, 3000);
  renderAccountingSummary();
}

// ============================================
// LISTE DE COURSES
// ============================================
let shoppingListCache = [];
let whatsappContactsCache = [];

async function initMyspaceListeCourses() {
  const [itemsRes, contactsRes] = await Promise.all([
    sb.from("shopping_list_items").select("*").eq("active", true).order("category").order("sort_order"),
    sb.from("whatsapp_contacts").select("*").eq("active", true).order("name")
  ]);
  shoppingListCache = itemsRes.data || [];
  whatsappContactsCache = contactsRes.data || [];
  renderShoppingList();
  renderWhatsappContacts();
}

function renderShoppingList() {
  const container = document.getElementById("myspaceCoursesListContainer");
  if (!shoppingListCache.length) {
    container.innerHTML = `<div style="color:var(--gray);text-align:center;padding:16px;">Aucun article dans la liste.</div>`;
    return;
  }
  // Grouper par catégorie
  const byCategory = {};
  shoppingListCache.forEach(item => {
    if (!byCategory[item.category]) byCategory[item.category] = [];
    byCategory[item.category].push(item);
  });

  let html = "";
  Object.entries(byCategory).forEach(([cat, items]) => {
    html += `<div style="margin-bottom:14px;">
      <div style="font-weight:800;color:var(--bordeaux-dark);font-size:14px;margin-bottom:6px;padding-bottom:4px;border-bottom:2px solid var(--rose-light);">${cat}</div>`;
    items.forEach(item => {
      html += `<label style="display:flex;align-items:center;gap:10px;padding:8px 0;cursor:pointer;border-bottom:1px solid var(--rose-pale);">
        <input type="checkbox" id="course_${item.id}" style="width:18px;height:18px;flex-shrink:0;accent-color:var(--bordeaux);">
        <span style="font-size:14px;">${item.name}</span>
      </label>`;
    });
    html += `</div>`;
  });
  container.innerHTML = html;
}

function renderWhatsappContacts() {
  const el = document.getElementById("myspaceWhatsappContacts");
  if (!whatsappContactsCache.length) {
    el.innerHTML = `<div style="color:var(--gray);font-size:13px;">Aucun contact configuré. Demande à l'admin d'en ajouter.</div>`;
    return;
  }
  el.innerHTML = whatsappContactsCache.map(c => `
    <label style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--rose-pale);border-radius:10px;cursor:pointer;">
      <input type="radio" name="whatsappContact" value="${c.phone}" style="accent-color:var(--bordeaux);">
      <span style="font-weight:700;">${c.name}</span>
      <span style="color:var(--gray);font-size:12px;">${c.phone}</span>
    </label>`).join("");
}

function uncheckAllCourses() {
  shoppingListCache.forEach(item => {
    const cb = document.getElementById(`course_${item.id}`);
    if (cb) cb.checked = false;
  });
}

function sendCoursesWhatsApp() {
  const checked = shoppingListCache.filter(item => {
    const cb = document.getElementById(`course_${item.id}`);
    return cb && cb.checked;
  });
  if (checked.length === 0) { alert("Cochez au moins un article avant d'envoyer."); return; }

  const today = new Date().toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
  const byCategory = {};
  checked.forEach(item => {
    if (!byCategory[item.category]) byCategory[item.category] = [];
    byCategory[item.category].push(item.name);
  });

  let msg = `🛒 *Courses du ${today}*\n\n`;
  Object.entries(byCategory).forEach(([cat, items]) => {
    msg += `*${cat}*\n`;
    items.forEach(name => { msg += `• ${name}\n`; });
    msg += "\n";
  });
  msg += `_Envoyé depuis Shakpot Pointage_`;

  // Ouvre WhatsApp sans numéro → l'employé choisit lui-même le destinataire
  const url = `https://api.whatsapp.com/send?text=${encodeURIComponent(msg)}`;
  window.open(url, "_blank");
  showToast("📲 WhatsApp ouvert !");
  uncheckAllCourses();
}

// ============================================
// GESTION LISTE DE COURSES (admin)
// ============================================
async function renderAdminShoppingList() {
  const { data: items } = await sb.from("shopping_list_items").select("*").order("category").order("sort_order");
  const { data: contacts } = await sb.from("whatsapp_contacts").select("*").order("name");

  const itemsEl = document.getElementById("adminShoppingListItems");
  const contactsEl = document.getElementById("adminWhatsappContacts");
  if (!itemsEl) return;

  // Articles groupés par catégorie
  const byCategory = {};
  (items || []).forEach(item => {
    if (!byCategory[item.category]) byCategory[item.category] = [];
    byCategory[item.category].push(item);
  });

  let html = "";
  Object.entries(byCategory).forEach(([cat, catItems]) => {
    html += `<div style="margin-bottom:12px;">
      <div style="font-weight:800;color:var(--bordeaux-dark);font-size:13px;margin-bottom:4px;">${cat}</div>`;
    catItems.forEach(item => {
      html += `<div style="display:flex;align-items:center;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--rose-pale);font-size:13px;">
        <span style="${!item.active ? 'text-decoration:line-through;color:var(--gray);' : ''}">${item.name}</span>
        <span>
          <button onclick="toggleShoppingItem('${item.id}',${!item.active})" style="border:none;background:none;cursor:pointer;font-size:12px;color:var(--gray);">${item.active ? '🔕' : '✓'}</button>
          <button onclick="deleteShoppingItem('${item.id}')" style="border:none;background:none;cursor:pointer;font-size:12px;color:var(--red-text);">✕</button>
        </span>
      </div>`;
    });
    html += `</div>`;
  });
  itemsEl.innerHTML = html || `<div style="color:var(--gray);">Aucun article.</div>`;

  // Contacts WhatsApp
  if (contactsEl) {
    contactsEl.innerHTML = (contacts || []).map(c => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--rose-pale);font-size:13px;">
        <span><strong>${c.name}</strong> — ${c.phone}</span>
        <button onclick="deleteWhatsappContact('${c.id}')" style="border:none;background:none;cursor:pointer;color:var(--red-text);">✕</button>
      </div>`).join("") || `<div style="color:var(--gray);">Aucun contact.</div>`;
  }
}

async function addShoppingItem() {
  const cat = document.getElementById("adminNewCategory").value.trim();
  const name = document.getElementById("adminNewItem").value.trim();
  if (!cat || !name) { alert("Merci de remplir la catégorie et l'article."); return; }
  await sb.from("shopping_list_items").insert({ category: cat, name, sort_order: 99 });
  document.getElementById("adminNewItem").value = "";
  showToast(`✓ "${name}" ajouté`);
  renderAdminShoppingList();
}

async function toggleShoppingItem(id, active) {
  await sb.from("shopping_list_items").update({ active }).eq("id", id);
  renderAdminShoppingList();
}

async function deleteShoppingItem(id) {
  if (!confirm("Supprimer cet article ?")) return;
  await sb.from("shopping_list_items").delete().eq("id", id);
  showToast("🗑 Article supprimé");
  renderAdminShoppingList();
}

async function addWhatsappContact() {
  const name = document.getElementById("adminContactName").value.trim();
  const phone = document.getElementById("adminContactPhone").value.trim();
  if (!name || !phone) { alert("Merci de remplir le nom et le numéro."); return; }
  await sb.from("whatsapp_contacts").insert({ name, phone });
  document.getElementById("adminContactName").value = "";
  document.getElementById("adminContactPhone").value = "";
  showToast(`✓ ${name} ajouté`);
  renderAdminShoppingList();
}

async function deleteWhatsappContact(id) {
  if (!confirm("Supprimer ce contact ?")) return;
  await sb.from("whatsapp_contacts").delete().eq("id", id);
  showToast("🗑 Contact supprimé");
  renderAdminShoppingList();
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

