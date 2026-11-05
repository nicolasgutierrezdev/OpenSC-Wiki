// Formats the JSON output of markdownlint-cli for GitHub Actions:
// colored log lines, annotations, a plain-text report and a job summary.
//
// Usage: node report.js <results.json> <report.txt> [fixes.patch]
// Exits with status 1 if there are problems.

'use strict';

const fs = require('fs');

const [resultsPath, reportPath, patchPath] = process.argv.slice(2);
const env = process.env;

// Job summaries are limited to 1 MiB per step.
const SUMMARY_BUDGET = 900 * 1024;

const ansi = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

// Returns the exit code. Setting process.exitCode instead of calling
// process.exit() lets Node flush stdout, which is asynchronous on pipes.
function main() {
  // markdownlint-cli writes an empty file when there are no problems. Only
  // trust that if it also exited successfully (LINT_STATUS), so a crash is
  // not mistaken for a clean run.
  let results;
  try {
    const text = fs.existsSync(resultsPath) ? fs.readFileSync(resultsPath, 'utf8') : '';
    if (text.trim() === '' && env.LINT_STATUS === '0') {
      results = [];
    } else {
      results = JSON.parse(text);
    }
  } catch (e) {
    console.log(`::error::Could not read markdownlint results from ${resultsPath}: ${e.message}`);
    return 1;
  }
  
  const lintedFiles = fs.readdirSync('.').filter((f) => f.endsWith('.md')).length;
  const fixable = (r) => Boolean(r.fixInfo);
  const rule = (r) => r.ruleNames.join('/');
  const position = (r) => r.lineNumber + (r.errorRange ? `:${r.errorRange[0]}` : '');
  const message = (r) =>
    r.ruleDescription +
    (r.errorDetail ? ` [${r.errorDetail}]` : '') +
    (r.errorContext ? ` [Context: "${r.errorContext}"]` : '');
  
  const byKey = (items, key) => {
    const map = new Map();
    for (const item of items) {
      const k = key(item);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(item);
    }
    return map;
  };
  
  results.sort((a, b) =>
    a.fileName.localeCompare(b.fileName) || a.lineNumber - b.lineNumber);
  const files = byKey(results, (r) => r.fileName);
  const rules = byKey(results, (r) => r.ruleNames[0]);
  const nFixable = results.filter(fixable).length;
  const nManual = results.length - nFixable;
  
  // ---- Plain-text report (artifact) ----------------------------------------
  
  fs.writeFileSync(reportPath, results
    .map((r) => `${r.fileName}:${position(r)} ${r.severity} ${rule(r)} ${message(r)}`)
    .join('\n') + (results.length ? '\n' : ''));
  
  // ---- Colored log and annotations -------------------------------------------
  
  const escapeData = (s) =>
    s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const escapeProperty = (s) =>
    escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
  
  for (const [file, problems] of files) {
    console.log(`\n${ansi.bold}${ansi.cyan}${file}${ansi.reset} ` +
      `${ansi.dim}(${problems.length} problems)${ansi.reset}`);
    for (const r of problems) {
      const tag = fixable(r)
        ? `${ansi.green}fixable${ansi.reset}`
        : `${ansi.red}manual ${ansi.reset}`;
      console.log(`  ${ansi.dim}${position(r).padEnd(8)}${ansi.reset} ${tag} ` +
        `${ansi.yellow}${rule(r)}${ansi.reset} ${message(r)}`);
    }
  }
  // GitHub displays at most 10 error annotations per step; emitting more only
  // clutters the log, so point to the job summary for the rest.
  const MAX_ANNOTATIONS = 10;
  if (results.length > MAX_ANNOTATIONS) {
    console.log(`::notice title=markdownlint::Showing ${MAX_ANNOTATIONS} of ` +
      `${results.length} problems as annotations; the job summary lists all of them.`);
  }
  for (const r of results.slice(0, MAX_ANNOTATIONS)) {
    const props = [`file=${r.fileName}`, `line=${r.lineNumber}`];
    if (r.errorRange) props.push(`col=${r.errorRange[0]}`);
    props.push(`title=${rule(r)}`);
    const level = r.severity === 'warning' ? 'warning' : 'error';
    console.log(`::${level} ${props.map(escapeProperty).join(',')}::${escapeData(message(r))}`);
  }
  
  if (results.length) {
    console.log(`\n${ansi.bold}${ansi.red}markdownlint: ${results.length} problems ` +
      `in ${files.size} of ${lintedFiles} files${ansi.reset} ` +
      `(${ansi.green}${nFixable} fixable${ansi.reset}, ${ansi.red}${nManual} manual${ansi.reset})`);
  } else {
    console.log(`${ansi.bold}${ansi.green}markdownlint: no problems in ${lintedFiles} files${ansi.reset}`);
  }
  
  // ---- Job summary -----------------------------------------------------------
  
  if (!env.GITHUB_STEP_SUMMARY) return results.length ? 1 : 0;
  
  // Escape everything Markdown or HTML could interpret, so file contents
  // shown in table cells cannot break the layout.
  const cell = (s) => String(s)
    .replace(/[\r\n]+/g, ' ')
    .replace(/[&<>|`*_[\]\\~#!@]/g, (c) => `&#${c.charCodeAt(0)};`);
  
  const blobUrl = (file, line) => {
    if (!env.GITHUB_SERVER_URL || !env.GITHUB_REPOSITORY || !env.GITHUB_SHA) return null;
    const path = file.split('/').map(encodeURIComponent).join('/');
    return `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/blob/${env.GITHUB_SHA}/` +
      `${path}?plain=1${line ? `#L${line}` : ''}`;
  };
  const link = (text, url) => (url ? `[${text}](${url})` : text);
  
  // Ten squares: green for auto-fixable, red for manual problems.
  const bar = (problems) => {
    const green = Math.round(10 * problems.filter(fixable).length / problems.length);
    return '🟩'.repeat(green) + '🟥'.repeat(10 - green) +
      ` ${problems.filter(fixable).length} / ${problems.filter((r) => !fixable(r)).length}`;
  };
  
  const out = [];
  
  if (!results.length) {
    out.push(`## 🟢 markdownlint: no problems in ${lintedFiles} files`, '');
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, out.join('\n') + '\n');
    return 0;
  }
  
  out.push(
    `## 🔴 markdownlint: ${results.length} problems in ${files.size} of ${lintedFiles} files`,
    '',
    '| 🔴 Problems | 📄 Files | 🟢 Auto-fixable | 🟥 Manual |',
    '| :-: | :-: | :-: | :-: |',
    `| **${results.length}** | **${files.size}** | **${nFixable}** | **${nManual}** |`,
    '',
  );
  
  const patch = patchPath && fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : '';
  if (nFixable && patch) {
    out.push(
      '> [!TIP]',
      `> **${nFixable} problems can be fixed automatically.** Download the ` +
        '`markdownlint-fixes` artifact and run `git apply markdownlint-fixes.patch`, ' +
        'or see the suggested fixes at the bottom of this summary.',
      '',
    );
  }
  if (nManual) {
    out.push(
      '> [!CAUTION]',
      `> **${nManual} problems have to be fixed by hand.** Each rule links to its ` +
        'documentation with examples.',
      '',
    );
  }
  
  out.push(
    '### Problems by rule',
    '',
    '| Rule | Description | Problems | 🟩 fixable / 🟥 manual |',
    '| :-- | :-- | --: | :-- |',
  );
  for (const [, problems] of [...rules].sort((a, b) => b[1].length - a[1].length)) {
    const r = problems[0];
    out.push(`| ${link(`\`${r.ruleNames[0]}\``, r.ruleInformation)} \`${r.ruleNames[1] || ''}\` ` +
      `| ${cell(r.ruleDescription)} | ${problems.length} | ${bar(problems)} |`);
  }
  
  out.push(
    '',
    '### Problems by file',
    '',
    '| File | Problems | 🟩 fixable / 🟥 manual |',
    '| :-- | --: | :-- |',
  );
  for (const [file, problems] of [...files].sort((a, b) => b[1].length - a[1].length)) {
    out.push(`| ${link(cell(file), blobUrl(file))} | ${problems.length} | ${bar(problems)} |`);
  }
  
  out.push('', '### All problems', '');
  let size = out.join('\n').length + patch.length + 2000;
  let omitted = 0;
  for (const [file, problems] of files) {
    const section = [
      `<details><summary>📄 <b>${cell(file)}</b>: ${problems.length} problems</summary>`,
      '',
      '| | Line | Rule | Problem |',
      '| :-: | --: | :-- | :-- |',
      ...problems.map((r) => `| ${fixable(r) ? '🟢' : '🔴'} ` +
        `| ${link(position(r), blobUrl(file, r.lineNumber))} ` +
        `| ${link(`\`${r.ruleNames[0]}\``, r.ruleInformation)} ` +
        `| ${cell(r.ruleDescription)}` +
        (r.errorDetail ? ` <sub>${cell(r.errorDetail)}</sub>` : '') +
        (r.errorContext ? `<br><code>${cell(r.errorContext)}</code>` : '') + ' |'),
      '',
      '</details>',
      '',
    ].join('\n');
    if (size + section.length > SUMMARY_BUDGET) {
      omitted += problems.length;
      continue;
    }
    size += section.length;
    out.push(section);
  }
  if (omitted) {
    out.push('> [!NOTE]',
      `> ${omitted} problems are not shown here to stay within the job summary size ` +
        'limit; see `markdownlint-report.txt` in the `markdownlint-fixes` artifact.', '');
  }
  out.push('🟢 can be fixed automatically · 🔴 has to be fixed by hand', '');
  
  if (patch) {
    // Tilde fence: the patched pages contain backtick fences themselves.
    out.push(
      '### Suggested fixes',
      '',
      '<details open><summary>Diff produced by <code>markdownlint --fix</code></summary>',
      '',
      '~~~~~~~~~~diff',
      patch.length > SUMMARY_BUDGET - size
        ? patch.slice(0, Math.max(0, SUMMARY_BUDGET - size)) + '\n... (truncated, see artifact)'
        : patch.trimEnd(),
      '~~~~~~~~~~',
      '',
      '</details>',
      '',
    );
  }
  
  fs.appendFileSync(env.GITHUB_STEP_SUMMARY, out.join('\n') + '\n');
  return 1;
}

process.exitCode = main();
