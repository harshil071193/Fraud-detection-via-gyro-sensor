#!/usr/bin/env node
// Builds a single offline index.html with Chart.js, the analysis code and two logs inlined.
// Usage: node build.mjs [logA.json] [logB.json] ["Name A"] ["Name B"]
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SOURCES = {
  a: 'sensor_log_2ec2a361-8a0d-489b-83f4-ef2a02136287_2026-10-01_11-02-44.json',
  b: 'sensor_log_4dc5ebeb-0eea-42fe-90b8-f8bf4ecaf0f0_2026-10-01_10-29-36.json',
};
const [argA, argB, argNameA, argNameB] = process.argv.slice(2);
const logA = resolve(argA || join(here, 'logs/normal.json'));
const logB = resolve(argB || join(here, 'logs/fraud.json'));
const nameA = argNameA || (argA ? 'Log A' : 'Normal inspection');
const nameB = argNameB || (argB ? 'Log B' : 'Intentional fraud');

const read = (p) => readFileSync(p, 'utf8');
const inlineScript = (code) => code.replace(/<\/script/gi, '<\\/script');
const inlineJson = (path) => {
  const json = JSON.parse(read(path));
  if (!Array.isArray(json.continuous_log)) throw new Error(`${path} is not a sensor log (continuous_log missing)`);
  return JSON.stringify(json).replace(/</g, '\\u003c');
};
const attr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const values = {
  STYLES: read(join(here, 'src/styles.css')),
  CHARTJS: inlineScript(read(join(here, 'vendor/chart.umd.min.js'))),
  ENGINE: inlineScript(read(join(here, 'src/engine.js'))),
  APP: inlineScript(read(join(here, 'src/app.js'))),
  LOG_A: inlineJson(logA),
  LOG_B: inlineJson(logB),
  NAME_A: attr(nameA),
  NAME_B: attr(nameB),
  FILE_A: attr(argA ? basename(logA) : DEFAULT_SOURCES.a),
  FILE_B: attr(argB ? basename(logB) : DEFAULT_SOURCES.b),
};

const template = read(join(here, 'src/template.html'));
const html = template.replace(
  /\/\*__(STYLES|CHARTJS|ENGINE|APP)__\*\/|__(LOG_A|LOG_B|NAME_A|NAME_B|FILE_A|FILE_B)__/g,
  (_, block, inline) => values[block || inline],
);

const out = join(here, 'index.html');
writeFileSync(out, html);
console.log(`Wrote ${out} (${(html.length / 1024 / 1024).toFixed(2)} MB)`);
console.log(`  A: ${nameA} <- ${logA}`);
console.log(`  B: ${nameB} <- ${logB}`);
