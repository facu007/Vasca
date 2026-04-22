function apiUrl(path) {
  const p = path.startsWith("/") ? path : `/${path}`;
  if (typeof window !== "undefined" && window.location.protocol === "file:") {
    const meta = document.querySelector('meta[name="vasca-api-origin"]');
    const origin = (meta && meta.content.trim()) || "http://localhost:3000";
    return `${origin.replace(/\/$/, "")}${p}`;
  }
  return p;
}

async function loadServicesPreview() {
  const container = document.getElementById("services-preview");
  if (!container) return;

  try {
    const response = await fetch(apiUrl("/api/services"));
    const data = await response.json();
    container.innerHTML = "";
    for (const service of data.services) {
      const card = document.createElement("a");
      card.className = "service-card";
      card.href = "https://www.instagram.com/vasca.lashes/";
      card.target = "_blank";
      card.rel = "noreferrer";
      card.innerHTML = `
        <h3>${service.name}</h3>
        <p>${service.description || ""}</p>
        <strong>$${service.price_ars.toLocaleString("es-AR")} · ${service.duration_minutes} min</strong><br>
        <small>Ver ejemplos en Instagram</small>
      `;
      container.appendChild(card);
    }
  } catch {
    container.innerHTML = "<p class='section-copy'>No se pudieron cargar los servicios por ahora.</p>";
  }
}

loadServicesPreview();
