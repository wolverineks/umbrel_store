const baseUrlInput = document.getElementById("baseUrl");
const tokenInput = document.getElementById("token");
const statusEl = document.getElementById("status");
const profileNoteEl = document.getElementById("profile-note");
const profileButtons = {
  prod: document.getElementById("profile-prod"),
  dev: document.getElementById("profile-dev"),
};

let activeProfile = "prod";
let profiles = emptyProfiles();

function setStatus(message, kind = "") {
  statusEl.textContent = message;
  statusEl.className = "status " + kind;
}

function stashFormIntoProfiles() {
  profiles[activeProfile] = {
    baseUrl: normalizeBaseUrl(baseUrlInput.value),
    token: normalizeToken(tokenInput.value),
  };
}

function showProfile(profile) {
  activeProfile = profile === "dev" ? "dev" : "prod";
  baseUrlInput.value = profiles[activeProfile].baseUrl;
  tokenInput.value = profiles[activeProfile].token;
  for (const key of APP_PROFILES) {
    profileButtons[key].classList.toggle("active", key === activeProfile);
  }
  profileNoteEl.textContent = "Active profile: " + APP_PROFILE_LABELS[activeProfile];
}

async function persistSettings({ verify = false } = {}) {
  stashFormIntoProfiles();
  await saveExtensionSettings(activeProfile, profiles);
  if (!verify) return;
  setStatus("Checking token…");
  const response = await chrome.runtime.sendMessage({ type: "verify-ingest-token" });
  if (!response?.ok) {
    throw new Error(response?.error || "invalid ingest token");
  }
}

async function loadSettings() {
  const loaded = await loadExtensionSettings();
  activeProfile = loaded.activeProfile;
  profiles = loaded.profiles;
  showProfile(activeProfile);
}

for (const key of APP_PROFILES) {
  profileButtons[key].addEventListener("click", async () => {
    if (key === activeProfile) return;
    stashFormIntoProfiles();
    showProfile(key);
    try {
      await saveExtensionSettings(activeProfile, profiles);
      setStatus("Active profile: " + APP_PROFILE_LABELS[activeProfile] + ".", "ok");
    } catch (error) {
      setStatus(error.message || String(error), "err");
    }
  });
}

document.getElementById("save").addEventListener("click", async () => {
  if (!normalizeBaseUrl(baseUrlInput.value) || !normalizeToken(tokenInput.value)) {
    setStatus("Set URL and token for " + APP_PROFILE_LABELS[activeProfile] + " first.", "err");
    return;
  }
  try {
    await persistSettings({ verify: true });
    setStatus(APP_PROFILE_LABELS[activeProfile] + " saved. Token verified.", "ok");
  } catch (error) {
    setStatus(error.message || String(error), "err");
  }
});

const extensionVersion = chrome.runtime.getManifest().version;
document.getElementById("version").textContent = "v" + extensionVersion;
const versionFooter = document.getElementById("version-footer");
if (versionFooter) {
  versionFooter.textContent = "Extension v" + extensionVersion;
}
loadSettings();