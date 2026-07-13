const APP_PROFILES = ["prod", "dev"];

const APP_PROFILE_LABELS = {
  prod: "Production",
  dev: "Development",
};

function normalizeBaseUrl(value) {
  return String(value ?? "").trim().replace(/\/$/, "");
}

function normalizeToken(value) {
  return String(value ?? "").trim();
}

function emptyProfiles() {
  return {
    prod: { baseUrl: "", token: "" },
    dev: { baseUrl: "", token: "" },
  };
}

function normalizeProfiles(raw) {
  const profiles = emptyProfiles();
  for (const key of APP_PROFILES) {
    const entry = raw?.[key];
    profiles[key] = {
      baseUrl: normalizeBaseUrl(entry?.baseUrl),
      token: normalizeToken(entry?.token),
    };
  }
  return profiles;
}

async function loadExtensionSettings() {
  const stored = await chrome.storage.sync.get(["baseUrl", "token", "activeProfile", "profiles"]);
  let profiles = normalizeProfiles(stored.profiles);
  let activeProfile = stored.activeProfile === "dev" ? "dev" : "prod";

  if (!stored.profiles && (stored.baseUrl || stored.token)) {
    profiles.prod = {
      baseUrl: normalizeBaseUrl(stored.baseUrl),
      token: normalizeToken(stored.token),
    };
    await chrome.storage.sync.set({ profiles, activeProfile });
    await chrome.storage.sync.remove(["baseUrl", "token"]);
  }

  return { activeProfile, profiles };
}

async function saveExtensionSettings(activeProfile, profiles) {
  const normalized = normalizeProfiles(profiles);
  const profile = activeProfile === "dev" ? "dev" : "prod";
  await chrome.storage.sync.set({
    activeProfile: profile,
    profiles: normalized,
  });
  return { activeProfile: profile, profiles: normalized };
}

async function getActiveUmbrelSettings() {
  const { activeProfile, profiles } = await loadExtensionSettings();
  const current = profiles[activeProfile];
  const baseUrl = current.baseUrl;
  const token = current.token;
  if (!baseUrl || !token) {
    const label = APP_PROFILE_LABELS[activeProfile];
    throw new Error(
      `Configure Umbrel URL and ingest token for ${label} in the extension popup.`,
    );
  }
  return { baseUrl, token, activeProfile, profileLabel: APP_PROFILE_LABELS[activeProfile] };
}