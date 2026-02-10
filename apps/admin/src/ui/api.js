export const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8080";

export async function api(path, { method="GET", token, body } = {}) {
  const res = await fetch(API_URL + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "Authorization": `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(()=> ({}));
  if (!res.ok) throw new Error(data?.error || "Request failed");
  return data;
}
