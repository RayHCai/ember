import { captureView } from "../globe/capture";
import { formatSimTime } from "../lib/format";
import { selectActiveZone, useAppStore } from "../state/store";
import "./print.css";

function esc(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/**
 * "Download report": lays the report out on a print-only page (map snapshot,
 * summary, sites table, photos) and opens the system print dialog, where the
 * operator saves it as a PDF.
 */
export async function printReport(): Promise<void> {
  const s = useAppStore.getState();
  const zone = selectActiveZone(s);
  const report = zone ? s.reports[zone.id] : undefined;
  if (!zone || !report || !s.viewer) return;

  const map = captureView(s.viewer, { hideLayers: false });
  const rows = report.sites
    .map(
      (site) => `<tr>
        <td>${site.rank}</td><td class="num">${site.peak_score}</td><td class="num">${site.area_ha} ha</td>
        <td>${esc(site.drivers.join(", "))}</td>
        <td>${esc(site.nearest_community ?? "")}${site.community_distance_km !== null ? `, ${site.community_distance_km.toFixed(1)} km` : ""}</td>
        <td>${esc(site.action)}</td></tr>`,
    )
    .join("");
  const photos = report.sites
    .map((site) => {
      const photo = s.sitePhotos[site.id];
      return photo
        ? `<figure><img src="${photo.url}" alt=""/><figcaption>Site ${site.rank}: ${esc(photo.label)}${photo.simulated ? " (SIM)" : ""}</figcaption></figure>`
        : "";
    })
    .join("");

  let root = document.getElementById("print-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "print-root";
    document.body.appendChild(root);
  }
  root.innerHTML = `
    <header>
      <div class="product">EMBER</div>
      <h1>Vulnerability report: ${esc(zone.name)}</h1>
      <p class="meta">${formatSimTime(Date.parse(report.created_at))} UTC (sim time). Survey ${esc(report.survey_id)}.
        Summary: ${report.mode === "asi1" ? "written by ASI:One" : "template"}.</p>
      <p class="sim">Simulated data: drones, photos and fuel are simulated for this demo.</p>
    </header>
    <img class="map" src="${map}" alt="Map snapshot"/>
    <h2>Summary</h2>
    <p>${esc(report.summary)}</p>
    <h2>Ranked sites</h2>
    <table><thead><tr><th>#</th><th>Score</th><th>Area</th><th>Drivers</th><th>Nearest community</th><th>Action</th></tr></thead>
    <tbody>${rows}</tbody></table>
    ${photos ? `<h2>Photos</h2><div class="photos">${photos}</div>` : ""}`;

  // Let the images decode before the print dialog lays out the page.
  await Promise.all([...root.querySelectorAll("img")].map((img) => img.decode().catch(() => undefined)));
  window.print();
}
