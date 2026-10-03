import { useAppStore } from "../state/store";
import { cx, formatSimTime } from "../lib/format";
import { printReport } from "./ReportPrint";
import type { ReportSite } from "../types/events";
import hud from "./hud.module.css";
import styles from "./ReportPanel.module.css";

const TREND: Record<ReportSite["trend"], { mark: string; label: string; tone?: string }> = {
  up: { mark: "↑", label: "Worse than last survey", tone: "warn" },
  down: { mark: "↓", label: "Better than last survey" },
  same: { mark: "→", label: "About the same" },
  new: { mark: "New", label: "New since last survey", tone: "warn" },
};

function Site({ site, selected }: { site: ReportSite; selected: boolean }) {
  const photo = useAppStore((s) => s.sitePhotos[site.id]);
  const trend = TREND[site.trend];
  const select = () => useAppStore.getState().selectSite(selected ? null : site.id);
  return (
    <li className={cx(styles.site, selected && styles.siteOn)}>
      <button type="button" className={styles.siteHead} onClick={select} aria-expanded={selected}>
        <span className={styles.rank}>{site.rank}</span>
        <span className={cx(styles.score, site.peak_score >= 80 ? styles.heat : styles.warn)}>{site.peak_score}</span>
        <span className={styles.siteMain}>
          <span className={styles.drivers}>{site.drivers.join(", ")}</span>
          <span className={styles.meta}>
            {site.area_ha} ha
            {site.nearest_community && ` · ${site.community_distance_km?.toFixed(1)} km from ${site.nearest_community}`}
          </span>
        </span>
        <span className={cx(styles.trend, trend.tone && styles[trend.tone])} title={trend.label}>
          {trend.mark}
        </span>
      </button>
      {selected && (
        <div className={styles.detail}>
          <p className={styles.action}>
            <span className={hud.label}>Recommended</span> {site.action}
          </p>
          {photo ? (
            <figure className={styles.photo}>
              <img src={photo.url} alt={`Site ${site.rank}`} />
              <figcaption>
                {photo.label} {photo.simulated && <span className={hud.simTag}>SIM</span>}
              </figcaption>
            </figure>
          ) : (
            <p className={styles.meta}>Taking a photo from the map...</p>
          )}
        </div>
      )}
    </li>
  );
}

export function ReportPanel() {
  const zoneId = useAppStore((s) => s.activeZoneId);
  const report = useAppStore((s) => (zoneId ? s.reports[zoneId] : undefined));
  const selected = useAppStore((s) => s.selectedSiteId);
  const close = () => {
    useAppStore.getState().selectSite(null);
    useAppStore.getState().setRightPanel("agent");
  };

  return (
    <section className={cx(hud.panel, styles.panel)} aria-label="Vulnerability report" data-testid="report-panel">
      <div className={hud.header}>
        <h2 className={hud.title}>
          Vulnerability report <span className={hud.simTag}>SIM</span>
        </h2>
        <button type="button" className={styles.link} onClick={close}>
          Back to agent
        </button>
      </div>
      {!report ? (
        <div className={hud.empty}>
          <strong>No report yet</strong>
          A report arrives after each survey: a heatmap, ranked sites, photos and recommended actions.
        </div>
      ) : (
        <div className={cx(styles.body, hud.scroll)}>
          <div className={styles.section}>
            <div className={styles.metaRow}>
              <span className={hud.mono}>{formatSimTime(Date.parse(report.created_at))}</span>
              <span className={cx(styles.badge, report.mode === "template" && styles.badgeFallback)}>
                {report.mode === "asi1" ? "Written by ASI:One" : "Template summary"}
              </span>
            </div>
            <p className={styles.summary}>{report.summary}</p>
            <p className={styles.trendLine}>
              {report.trend.avg_score_change !== null && (
                <span>
                  Average score{" "}
                  <span className={hud.mono}>
                    {report.trend.avg_score_change >= 0 ? "+" : ""}
                    {report.trend.avg_score_change.toFixed(1)}
                  </span>
                </span>
              )}
              <span>{report.trend.new_sites} new sites</span>
              <span>{report.trend.dropped_sites} dropped off</span>
            </p>
            <p className={styles.fuelNote}>Fuel data is simulated. Scores show where to look first, not certainty.</p>
          </div>
          <div className={styles.sitesHead}>
            <span className={hud.label}>Ranked sites</span>
            <span className={hud.label}>Select one to fly there</span>
          </div>
          <ol className={styles.sites}>
            {report.sites.map((site) => (
              <Site key={site.id} site={site} selected={site.id === selected} />
            ))}
          </ol>
          <div className={styles.footer}>
            <button type="button" className={hud.button} onClick={() => void printReport()}>
              Download report
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
