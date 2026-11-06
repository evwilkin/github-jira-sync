import { appendFileSync } from 'fs';

// Error collector to store errors with context
class ErrorCollector {
  constructor() {
    this.errors = [];
  }

  addError(context, error) {
    this.errors.push({
      context,
      message: error.message,
      response: error?.response?.data,
      stack: error.stack,
    });
  }

  hasErrors() {
    return this.errors.length > 0;
  }

  logErrors() {
    if (!this.hasErrors()) return;

    this.errors.forEach(({ context, message, response }) => {
      // Keep collected errors on stdout with the rest of the sync log. GitHub
      // Actions can interleave stdout and stderr, making errors appear under a
      // later repository even when they were emitted at the end of this one.
      console.log(`  ${context}: ${message}`);
      if (response) {
        console.log(`  Response: ${JSON.stringify(response)}`);
      }
      console.log('  ==============================================');
    });
  }

  clear() {
    this.errors = [];
  }
}

export const errorCollector = new ErrorCollector();

// Sync stats tracker for end-of-run summary
class SyncStats {
  constructor() {
    this.repoStats = new Map();
  }

  _getRepo(repo) {
    if (!this.repoStats.has(repo)) {
      this.repoStats.set(repo, {
        jiraCreated: 0,
        jiraClosed: 0,
        githubCreated: 0,
        githubClosed: 0,
        githubReopened: 0,
        errors: 0,
        warnings: [],
      });
    }
    return this.repoStats.get(repo);
  }

  setCurrentRepo(repo) {
    this.currentRepo = repo;
  }

  track(event, detail) {
    const repo = this.currentRepo;
    if (!repo) return;
    const stats = this._getRepo(repo);
    if (event === 'warnings') {
      stats.warnings.push(detail);
    } else {
      stats[event] = (stats[event] || 0) + 1;
    }
  }

  hasErrors() {
    return [...this.repoStats.values()].some((stats) => stats.errors > 0);
  }

  printSummary() {
    const activeRepos = [...this.repoStats.entries()]
      .filter(([_, s]) => s.jiraCreated + s.jiraClosed + s.githubCreated + s.githubClosed + s.githubReopened + s.errors + s.warnings.length > 0);

    console.log('\n\n=== SYNC SUMMARY ===\n');

    if (activeRepos.length === 0) {
      console.log('No changes made.\n');
      return;
    }

    const cols = [
      { key: 'jiraCreated',    label: 'Jira Created', width: 12 },
      { key: 'jiraClosed',     label: 'Jira Closed',  width: 11 },
      { key: 'githubCreated',  label: 'GH Created',   width: 10 },
      { key: 'githubClosed',   label: 'GH Closed',    width: 9 },
      { key: 'githubReopened', label: 'GH Reopened',  width: 11 },
      { key: 'errors',         label: 'Errors',       width: 6 },
      { key: 'warnings',      label: 'Warnings',     width: 8 },
    ];

    const repoWidth = Math.max(4, ...activeRepos.map(([r]) => r.length));
    const header = 'Repo'.padEnd(repoWidth) + ' | ' + cols.map(c => c.label.padStart(c.width)).join(' | ');
    const separator = '-'.repeat(repoWidth) + '-|-' + cols.map(c => '-'.repeat(c.width)).join('-|-');

    console.log(header);
    console.log(separator);

    const totals = { jiraCreated: 0, jiraClosed: 0, githubCreated: 0, githubClosed: 0, githubReopened: 0, errors: 0, warnings: 0 };
    for (const [repo, stats] of activeRepos) {
      const vals = cols.map(c => {
        const v = c.key === 'warnings' ? stats.warnings.length : stats[c.key];
        if (c.key === 'warnings') totals.warnings += v;
        else totals[c.key] += v;
        return String(v).padStart(c.width);
      });
      console.log(`${repo.padEnd(repoWidth)} | ${vals.join(' | ')}`);
    }

    console.log(separator);
    const totalVals = cols.map(c => String(totals[c.key]).padStart(c.width));
    console.log(`${'Total'.padEnd(repoWidth)} | ${totalVals.join(' | ')}`);

    // Print warning details grouped by repo, then by message type
    const reposWithWarnings = activeRepos.filter(([_, s]) => s.warnings.length > 0);
    if (reposWithWarnings.length > 0) {
      console.log(`\nWarnings:`);
      for (const [repo, stats] of reposWithWarnings) {
        console.log(`\n  ${repo} (${stats.warnings.length}):`);
        // Group warnings by message
        const grouped = new Map();
        for (const w of stats.warnings) {
          if (typeof w === 'object' && w.message) {
            const keys = grouped.get(w.message) || [];
            keys.push(w.key);
            grouped.set(w.message, keys);
          } else {
            // Fallback for plain string warnings
            const keys = grouped.get(String(w)) || [];
            grouped.set(String(w), keys);
          }
        }
        for (const [message, keys] of grouped) {
          console.log(`    ${message}:`);
          if (keys.length > 0 && keys[0]) {
            console.log(`      ${keys.join(', ')}`);
          }
        }
      }
    }

    console.log('');
  }
}

export const syncStats = new SyncStats();

// ─── GitHub Actions reporting ───────────────────────────────────────────────
// A run is only green or red, but annotations show yellow warnings on the run page and the job
// summary renders a report there. Neither changes the run's result or sends a notification.

// Workflow commands treat % and newlines specially (and , and : inside properties).
export function escapeWorkflowData(value) {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
function escapeWorkflowProperty(value) {
  return escapeWorkflowData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

// One warning/error per distinct message per repo, with the affected keys listed.
function groupWarnings(warnings) {
  const grouped = new Map();
  for (const w of warnings) {
    const message = typeof w === 'object' && w.message ? w.message : String(w);
    const keys = grouped.get(message) || [];
    if (typeof w === 'object' && w.key) keys.push(w.key);
    grouped.set(message, keys);
  }
  return grouped;
}

export function emitCiAnnotations({ env = process.env, log = console.log } = {}) {
  if (env.GITHUB_ACTIONS !== 'true') return 0;
  let count = 0;
  for (const [repo, stats] of syncStats.repoStats) {
    for (const [message, keys] of groupWarnings(stats.warnings)) {
      const text = keys.length ? `${message}: ${keys.join(', ')}` : message;
      log(`::warning title=${escapeWorkflowProperty(repo)}::${escapeWorkflowData(text)}`);
      count++;
    }
  }
  for (const { context, message } of errorCollector.errors) {
    log(`::error title=${escapeWorkflowProperty('Sync error')}::${escapeWorkflowData(`${context}: ${message}`)}`);
    count++;
  }
  return count;
}

export function buildStepSummaryMarkdown() {
  const rows = [...syncStats.repoStats.entries()].filter(([, s]) =>
    s.jiraCreated + s.jiraClosed + s.githubCreated + s.githubClosed + s.githubReopened + s.errors + s.warnings.length > 0
  );
  const lines = ['## GitHub ↔ Jira sync', ''];
  if (rows.length === 0) {
    lines.push('No creates, closes, reopens, errors or warnings.', '');
  } else {
    lines.push('| Repo | Jira created | Jira closed | GH created | GH closed | GH reopened | Errors | Warnings |', '|---|---:|---:|---:|---:|---:|---:|---:|');
    for (const [repo, s] of rows) {
      lines.push(`| ${repo} | ${s.jiraCreated} | ${s.jiraClosed} | ${s.githubCreated} | ${s.githubClosed} | ${s.githubReopened} | ${s.errors} | ${s.warnings.length} |`);
    }
    lines.push('');
    for (const [repo, s] of rows.filter(([, r]) => r.warnings.length > 0)) {
      lines.push(`### Warnings: ${repo}`, '');
      for (const [message, keys] of groupWarnings(s.warnings)) {
        lines.push(`- ${message}${keys.length ? `: ${keys.join(', ')}` : ''}`);
      }
      lines.push('');
    }
  }
  if (errorCollector.errors.length > 0) {
    lines.push('### Errors', '');
    for (const { context, message } of errorCollector.errors) lines.push(`- ${context}: ${message}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function writeStepSummary({ env = process.env, append = appendFileSync } = {}) {
  if (!env.GITHUB_STEP_SUMMARY) return false;
  append(env.GITHUB_STEP_SUMMARY, buildStepSummaryMarkdown() + '\n');
  return true;
}

export function markRunFailedIfErrors(processRef = process) {
  if (!syncStats.hasErrors()) return false;
  processRef.exitCode = 1;
  return true;
}
