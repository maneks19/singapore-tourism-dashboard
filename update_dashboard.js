#!/usr/bin/env node
/**
 * Singapore Tourism Dashboard — Data Updater
 *
 * Usage:
 *   node update_dashboard.js <new_data.csv>
 *
 * Drop your latest monthly CSV from STB into Claude and ask:
 *   "Update the dashboard with this new data"
 *
 * Or run this script directly. It will:
 *   1. Read the new CSV
 *   2. Parse and map it to the dashboard's format
 *   3. Merge with existing data (dedup by date+country)
 *   4. Update the HTML file in place
 *   5. Update the header badge with new date range
 *
 * Expected CSV columns (flexible matching):
 *   - Month/Date/Period  → date (YYYY-MM)
 *   - Country            → country name
 *   - Region             → region name
 *   - Arrivals           → total arrivals
 *   - Overnight/Visitors → overnight visitors
 *   - ALOS/Length of Stay → average length of stay
 */

const fs = require('fs');
const path = require('path');

const DASHBOARD = path.join(__dirname, 'singapore_tourism_dashboard.html');

// Country-to-region mapping (fallback if CSV doesn't include region)
const COUNTRY_REGION = {};

function parseCSV(text) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());

  // Flexible column detection
  const colMap = {};
  headers.forEach((h, i) => {
    if (/month|date|period|year.*month/i.test(h)) colMap.date = i;
    if (/^country|market|source/i.test(h)) colMap.country = i;
    if (/^region|area/i.test(h)) colMap.region = i;
    if (/arrival|total.*visitor/i.test(h)) colMap.arrivals = i;
    if (/overnight|staying/i.test(h)) colMap.overnight = i;
    if (/alos|length.*stay|avg.*stay/i.test(h)) colMap.alos = i;
  });

  console.log('Detected columns:', colMap);
  console.log('Headers:', headers);

  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    if (!vals[colMap.date] || !vals[colMap.country]) continue;

    // Parse date — handle "2026-02", "Feb 2026", "2026 Feb", "02/2026" etc.
    let dateStr = vals[colMap.date];
    let year, month;

    const isoMatch = dateStr.match(/^(\d{4})-(\d{1,2})/);
    const slashMatch = dateStr.match(/^(\d{1,2})\/(\d{4})/);
    const monthNames = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
    const nameMatch = dateStr.match(/([a-z]{3})\w*\s*(\d{4})/i) || dateStr.match(/(\d{4})\s*([a-z]{3})/i);

    if (isoMatch) { year = +isoMatch[1]; month = +isoMatch[2]; }
    else if (slashMatch) { month = +slashMatch[1]; year = +slashMatch[2]; }
    else if (nameMatch) {
      const parts = [nameMatch[1], nameMatch[2]];
      const yrPart = parts.find(p => /^\d{4}$/.test(p));
      const moPart = parts.find(p => /^[a-z]/i.test(p));
      year = +yrPart;
      month = monthNames[moPart.slice(0, 3).toLowerCase()];
    }

    if (!year || !month) { console.warn(`Skipping unparseable date: ${dateStr}`); continue; }

    const d = `${year}-${String(month).padStart(2, '0')}`;
    const country = vals[colMap.country];
    const region = colMap.region !== undefined ? vals[colMap.region] : (COUNTRY_REGION[country] || 'Others');
    const arrivals = parseInt((vals[colMap.arrivals] || '0').replace(/[^0-9.-]/g, '')) || 0;
    const overnight = colMap.overnight !== undefined ? parseInt((vals[colMap.overnight] || '0').replace(/[^0-9.-]/g, '')) || 0 : 0;
    const alos = colMap.alos !== undefined ? parseFloat(vals[colMap.alos]) || 0 : 0;

    records.push({ d, y: year, m: month, c: country, r: region, a: arrivals, o: overnight, l: alos });
  }
  return records;
}

function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error('Usage: node update_dashboard.js <new_data.csv>');
    process.exit(1);
  }

  // Read dashboard
  let html = fs.readFileSync(DASHBOARD, 'utf8');

  // Extract existing RAW data
  const rawMatch = html.match(/const RAW=(\[.*?\]);/s);
  if (!rawMatch) { console.error('Could not find RAW data in dashboard'); process.exit(1); }
  const existing = JSON.parse(rawMatch[1]);
  console.log(`Existing records: ${existing.length}`);

  // Build country→region lookup from existing data
  existing.forEach(r => { COUNTRY_REGION[r.c] = r.r; });

  // Parse new CSV
  const csvText = fs.readFileSync(csvPath, 'utf8');
  const newRecords = parseCSV(csvText);
  console.log(`New records parsed: ${newRecords.length}`);

  if (!newRecords.length) { console.error('No valid records found in CSV'); process.exit(1); }

  // Merge: new records override existing ones for same date+country
  const key = r => r.d + '|' + r.c;
  const merged = new Map();
  existing.forEach(r => merged.set(key(r), r));
  let added = 0, updated = 0;
  newRecords.forEach(r => {
    const k = key(r);
    if (merged.has(k)) updated++; else added++;
    merged.set(k, r);
  });

  const all = Array.from(merged.values()).sort((a, b) => a.d.localeCompare(b.d) || a.c.localeCompare(b.c));
  console.log(`Merged total: ${all.length} (${added} added, ${updated} updated)`);

  // Update HTML
  const newRAW = 'const RAW=' + JSON.stringify(all) + ';';
  html = html.replace(/const RAW=\[.*?\];/s, newRAW);

  // Update header badge date range
  const dates = [...new Set(all.map(r => r.d))].sort();
  const first = dates[0], last = dates[dates.length - 1];
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const fmtDate = d => { const [y, m] = d.split('-'); return monthNames[+m - 1] + ' ' + y; };
  html = html.replace(/Jan 2008 — [A-Z][a-z]+ \d{4}/, fmtDate(first) + ' — ' + fmtDate(last));

  // Write back
  fs.writeFileSync(DASHBOARD, html, 'utf8');
  console.log(`\nDashboard updated! Date range: ${fmtDate(first)} — ${fmtDate(last)}`);
}

main();
