import type { TFn } from "../i18n/shared";
import { formatTokens } from "../format-tokens";
import { cacheResult, formatCachePercent, summarizeCache, type CacheLogEntry } from "./logs-cache";

export interface CacheDiagnostics {
  astraEffortCache?: { status: string; stateOutcome: string };
  sideChatCache?: { reason: string; phase: string; snapshotOutcome: string; matchedItems: number; inputItems: number };
}

type Props = { log: CacheLogEntry; t: TFn; locale?: string };

export function CacheCell({ log, t, locale }: Props) {
  const cache = cacheResult(log);
  return <span className="logs-stack-end" title={t("logs.cache.definition")}>
    <span className={`logs-cache-outcome logs-cache-${cache.outcome}`}>{t(`logs.cache.${cache.outcome}`)}{cache.ratio !== undefined ? ` · ${formatCachePercent(cache.ratio, locale)}` : ""}</span>
    {cache.read !== undefined && <span className="muted text-caption mono">{t("logs.cache.readTokens", { tokens: formatTokens(cache.read, locale ?? "en") })}</span>}
  </span>;
}

export function CacheSummary({ logs, t, locale }: { logs: readonly CacheLogEntry[]; t: TFn; locale?: string }) {
  const summary = summarizeCache(logs);
  return <section className="logs-cache-summary" aria-label={t("logs.cache.summary")}>
    <dl>
      <div><dt>{t("logs.cache.hitRate")}</dt><dd>{formatCachePercent(summary.hitRate, locale)}</dd></div>
      <div><dt>{t("logs.cache.reuseRate")}</dt><dd>{formatCachePercent(summary.reuseRate, locale)}</dd></div>
      <div><dt>{t("logs.cache.hit")}</dt><dd>{summary.hits.toLocaleString(locale)}</dd></div>
      <div><dt>{t("logs.cache.miss")}</dt><dd>{summary.misses.toLocaleString(locale)}</dd></div>
      <div><dt>{t("logs.cache.unknown")}</dt><dd>{summary.unknown.toLocaleString(locale)}</dd></div>
    </dl>
    <p className="muted text-caption">{t("logs.cache.scope")}</p>
  </section>;
}

function LocalDiagnostics({ log, t }: { log: CacheDiagnostics; t: TFn }) {
  return <>
    {log.astraEffortCache && <div className="log-detail-grid">
      <span className="muted">{t("logs.cache.astra")}</span>
      <code className="log-detail-break">{log.astraEffortCache.status} · {log.astraEffortCache.stateOutcome}</code>
    </div>}
    {log.sideChatCache && <div className="log-detail-grid">
      <span className="muted">{t("logs.cache.sideChat")}</span>
      <code className="log-detail-break">{log.sideChatCache.reason} · {log.sideChatCache.phase} · {log.sideChatCache.snapshotOutcome}</code>
      <span className="muted">{t("logs.cache.matchedItems")}</span>
      <span className="mono">{log.sideChatCache.matchedItems} / {log.sideChatCache.inputItems}</span>
    </div>}
  </>;
}

export function CacheDetails({ log, t, locale }: Props & {
  log: CacheLogEntry & CacheDiagnostics & { attempts?: Array<CacheLogEntry & CacheDiagnostics & { ordinal: number; provider: string; model: string }> };
}) {
  const cache = cacheResult(log);
  const attempts = log.attempts ?? [];
  const diagnostics = [log, ...attempts].some(entry => entry.astraEffortCache || entry.sideChatCache);
  const tokens = (value: number | undefined) => value === undefined ? "—" : value.toLocaleString(locale);
  return <section className="log-detail-section" aria-labelledby="log-detail-cache">
    <h4 id="log-detail-cache" className="log-detail-section-title">{t("logs.cache.label")}</h4>
    <div className="log-detail-grid">
      <span className="muted">{t("logs.cache.outcome")}</span><span>{t(`logs.cache.${cache.outcome}`)}</span>
      <span className="muted">{t("logs.cache.reuseRate")}</span><span className="mono">{formatCachePercent(cache.ratio, locale)}</span>
      <span className="muted">{t("logs.tokens.cacheRead")}</span><span className="mono">{tokens(cache.read)}</span>
      <span className="muted">{t("logs.cache.uncached")}</span><span className="mono">{tokens(cache.uncached)}</span>
      <span className="muted">{t("logs.tokens.cacheWrite")}</span><span className="mono">{tokens(cache.write)}</span>
    </div>
    <p className="log-detail-notes-line muted">{t("logs.cache.definition")}</p>
    {cache.outcome !== "unknown" && <p className="log-detail-notes-line muted">{t("logs.cache.writeNote")}</p>}
    {attempts.length > 0 && <div className="tbl-wrap">
      <table className="tbl">
        <thead><tr><th>{t("logs.cache.attempt")}</th><th>{t("logs.col.provider")}</th><th>{t("logs.col.model")}</th><th>{t("logs.cache.label")}</th></tr></thead>
        <tbody>{attempts.map(attempt => <tr key={attempt.ordinal}>
          <td>{attempt.ordinal}</td><td>{attempt.provider}</td><td>{attempt.model}</td>
          <td><CacheCell log={attempt} t={t} locale={locale} /></td>
        </tr>)}</tbody>
      </table>
    </div>}
    {diagnostics && <details className="logs-cache-diagnostics">
      <summary>{t("logs.cache.local")}</summary>
      <p className="log-detail-notes-line muted">{t("logs.cache.localNote")}</p>
      <LocalDiagnostics log={log} t={t} />
      {attempts.filter(attempt => attempt.astraEffortCache || attempt.sideChatCache).map(attempt => <div key={attempt.ordinal}>
        <p>{t("logs.cache.attempt")} {attempt.ordinal} · {attempt.provider} · {attempt.model}</p>
        <LocalDiagnostics log={attempt} t={t} />
      </div>)}
    </details>}
  </section>;
}
