const defaultApiBaseUrl = process.env.NODE_ENV === "production" ? "" : "http://localhost:4000";
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || defaultApiBaseUrl;

export function getToken() {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("loanconnect_token") || "";
}

export function getUser() {
  if (typeof window === "undefined") return null;
  try {
    return JSON.parse(localStorage.getItem("loanconnect_user") || "null");
  } catch {
    return null;
  }
}

export function saveSession({ token, user }) {
  localStorage.setItem("loanconnect_token", token);
  localStorage.setItem("loanconnect_user", JSON.stringify(user));
}

export function clearSession() {
  localStorage.removeItem("loanconnect_token");
  localStorage.removeItem("loanconnect_user");
}

export function getTrainingToken() {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("loanconnect_training_token") || "";
}

export function getTrainingUser() {
  if (typeof window === "undefined") return null;
  try {
    return JSON.parse(localStorage.getItem("loanconnect_training_user") || "null");
  } catch {
    return null;
  }
}

export function saveTrainingSession({ token, user }) {
  localStorage.setItem("loanconnect_training_token", token);
  localStorage.setItem("loanconnect_training_user", JSON.stringify(user));
}

export function clearTrainingSession() {
  localStorage.removeItem("loanconnect_training_token");
  localStorage.removeItem("loanconnect_training_user");
}

export async function apiFetch(path, options = {}) {
  if (!API_BASE_URL) {
    throw new Error("NEXT_PUBLIC_API_BASE_URL is required for Railway deployment.");
  }

  const headers = new Headers(options.headers || {});
  const token = getToken();

  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(`${API_BASE_URL}${path}`, { ...options, headers });
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const data = isJson ? await res.json() : await res.text();

  if (!res.ok) {
    if (res.status === 401 && typeof window !== "undefined") {
      clearSession();
      window.location.href = "/login";
    }
    const message = typeof data === "object" ? data.error || "Request failed" : data || "Request failed";
    throw new Error(message);
  }

  return data;
}

export async function trainingApiFetch(path, options = {}) {
  if (!API_BASE_URL) {
    throw new Error("NEXT_PUBLIC_API_BASE_URL is required for Railway deployment.");
  }

  const headers = new Headers(options.headers || {});
  const token = getTrainingToken();

  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(`${API_BASE_URL}${path}`, { ...options, headers });
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const data = isJson ? await res.json() : await res.text();

  if (!res.ok) {
    if (res.status === 401 && typeof window !== "undefined") {
      clearTrainingSession();
      window.location.href = "/uploadTestData/login";
    }
    const message = typeof data === "object" ? data.error || "Request failed" : data || "Request failed";
    throw new Error(message);
  }

  return data;
}
