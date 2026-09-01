// Veranstaltungs-Sync CMS → Verwaltungs-DB.
//
// Läuft als GitHub-Action-Job nach jedem Publish auf main (siehe
// .github/workflows/main.yml, Job "sync"): parst content/veranstaltung/*.md,
// filtert (nur Neue anlegen, nur Zukünftiges updaten), normalisiert die
// historisch dreckigen Frontmatter-Werte und schickt EINEN Batch an
// POST ${SYNC_URL}/sync/veranstaltungen. Neu vergebene veranstaltungsIDs
// werden zeilengenau ins Frontmatter zurückgeschrieben (der Workflow
// committet sie anschließend).
//
// Env: SYNC_TOKEN (Pflicht), SYNC_URL (Default https://api.ec-nordbund.de),
//      DRY_RUN=1 (nur validieren/reporten, keine DB-Writes, kein Writeback).
import fs from 'node:fs'
import path from 'node:path'
import matter from 'gray-matter'

const CONTENT_DIR = 'content/veranstaltung'
const SYNC_URL = process.env.SYNC_URL || 'https://api.ec-nordbund.de'
const DRY_RUN = process.env.DRY_RUN === '1'

// briefID → Standard-Empfänger der Info-Mail (Kontaktperson);
// explizites informAnmeldecenter im CMS gewinnt immer.
const INFO_MAIL_BY_BRIEF_ID = {
  1: 'kirke.husberg@ec-nordbund.de;tobias.krahe@ec-nordbund.de',
  2: 'BirgitHerbert@t-online.de',
  3: 'kirke.husberg@ec-nordbund.de',
  4: 'tobias.krahe@ec-nordbund.de',
  5: 'dortje.gaertner@ec-nordbund.de',
}

const report = { created: [], updated: [], adopted: [], skipped: [], errors: [], warnings: [] }

/** YAML-Date | 'YYYY-MM-DD'-String | sonstiges → 'YYYY-MM-DD' oder null */
function toDateStr(v) {
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10)
  if (typeof v === 'string') {
    const m = v.trim().match(/^(\d{4}-\d{2}-\d{2})/)
    if (m) return m[1]
  }
  return null
}

function toInt(v, fallback = null) {
  if (typeof v === 'number' && Number.isInteger(v)) return v
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return parseInt(v, 10)
  return fallback
}

function toBool01(v) {
  return v === true || v === 1 || v === 'true' ? 1 : 0
}

/** preise-Frontmatter → {preisFruehbucher, preisNormal, preisLastMinute,
 *  fruehbucherBis, lastMinuteAb} oder {error} */
function mapPreise(preise, slug) {
  const out = {
    preisFruehbucher: 0,
    preisNormal: 0,
    preisLastMinute: 0,
    fruehbucherBis: null,
    lastMinuteAb: null,
  }
  // false / leer = kostenlose Veranstaltung
  if (!Array.isArray(preise) || preise.length === 0) return out

  const std = { Frühbucher: null, Normal: null, 'Last-Minute': null }
  const nonStd = []
  for (const p of preise) {
    if (!p || typeof p !== 'object') continue
    const label = typeof p.label === 'string' ? p.label.trim() : ''
    if (label === 'frei') {
      std.Normal = { ...p, preis: 0 }
    } else if (label in std) {
      std[label] = p
    } else {
      nonStd.push(p)
    }
  }

  const hasStd = std.Frühbucher || std.Normal || std['Last-Minute']
  if (!hasStd) {
    if (nonStd.length === 1) {
      // z. B. 'Startgeld pro Spieler': als einheitlicher Preis auf alle drei
      const preis = toInt(nonStd[0].preis)
      if (preis === null || preis < 0) return { error: `preise: '${nonStd[0].label}' hat keinen gültigen Betrag` }
      out.preisFruehbucher = out.preisNormal = out.preisLastMinute = preis
      return out
    }
    return { error: 'preise: keine Standard-Labels (Frühbucher/Normal/Last-Minute) erkennbar' }
  }
  if (nonStd.length > 0) {
    report.warnings.push(`${slug}: preise-Einträge mit unbekanntem Label ignoriert (${nonStd.map((p) => p.label).join(', ')})`)
  }

  if (std.Frühbucher) {
    const preis = toInt(std.Frühbucher.preis)
    const bis = toDateStr(std.Frühbucher.ende)
    if (preis === null || preis < 0) return { error: 'preise: Frühbucher ohne gültigen Betrag' }
    if (!bis) return { error: 'preise: Frühbucher braucht ein Ende-Datum (sonst endet er nie)' }
    out.preisFruehbucher = preis
    out.fruehbucherBis = bis
  }
  if (std['Last-Minute']) {
    const preis = toInt(std['Last-Minute'].preis)
    const ab = toDateStr(std['Last-Minute'].begin)
    if (preis === null || preis < 0) return { error: 'preise: Last-Minute ohne gültigen Betrag' }
    if (!ab) return { error: 'preise: Last-Minute braucht ein Beginn-Datum' }
    out.preisLastMinute = preis
    out.lastMinuteAb = ab
  }
  if (std.Normal) {
    const preis = toInt(std.Normal.preis)
    if (preis === null || preis < 0) return { error: 'preise: Normal ohne gültigen Betrag' }
    out.preisNormal = preis
  } else {
    // preisNormal ist NOT NULL: genau ein anderer Standardpreis → übernehmen
    const others = [std.Frühbucher, std['Last-Minute']].filter(Boolean)
    if (others.length === 1) {
      out.preisNormal = toInt(others[0].preis)
    } else {
      return { error: 'preise: Normalpreis fehlt und ist nicht eindeutig ableitbar' }
    }
  }
  // Frühbucher/Last-Minute nicht gesetzt → Normalpreis gilt durchgehend
  if (!std.Frühbucher) out.preisFruehbucher = out.preisNormal
  if (!std['Last-Minute']) out.preisLastMinute = out.preisNormal
  return out
}

function buildEntry(slug, fm) {
  const errs = []

  const begin = toDateStr(fm.begin)
  if (!begin) return { skip: 'begin fehlt/unlesbar' }
  const today = new Date().toISOString().slice(0, 10)

  const rawId = toInt(fm.veranstaltungsID)
  const hasId = rawId !== null && rawId > 0

  if (begin < today) return { skip: `vergangen (begin ${begin})` }

  const verwaltung = fm.verwaltung && typeof fm.verwaltung === 'object' ? fm.verwaltung : null

  if (!hasId) {
    // Create nur mit explizitem Opt-in (ausgefüllter Verwaltung-Abschnitt) —
    // Turniere u. ä. ohne Online-Anmeldung bleiben bewusst draußen
    if (!verwaltung || typeof verwaltung.kurzBezeichnung !== 'string' || !verwaltung.kurzBezeichnung.trim()) {
      return { skip: 'keine veranstaltungsID und Verwaltung-Abschnitt unvollständig (kein kurzBezeichnung) — kein Anlegen' }
    }
  } else if (!verwaltung) {
    // Bestandsschutz: Update erst, wenn der Verwaltung-Abschnitt einmal
    // bewusst gepflegt wurde — sonst würden Plätze/Preise mit Defaults genullt
    return { skip: 'veranstaltungsID vorhanden, aber kein Verwaltung-Abschnitt — kein Update' }
  }

  const title = typeof fm.title === 'string' ? fm.title.trim() : ''
  if (!title) errs.push('title fehlt')
  if (title.length > 50) errs.push(`title ist ${title.length} Zeichen lang (DB-Limit bezeichnung: 50) — bitte kürzen`)

  const veranstaltungsort = typeof fm.veranstaltungsort === 'string' ? fm.veranstaltungsort.trim() : ''
  if (!veranstaltungsort) errs.push('veranstaltungsort fehlt')

  const preise = mapPreise(fm.preise, slug)
  if (preise.error) errs.push(preise.error)

  const kurz = typeof verwaltung?.kurzBezeichnung === 'string' ? verwaltung.kurzBezeichnung.trim() : ''
  if (!/^[A-Za-z0-9]{1,4}$/.test(kurz)) errs.push('verwaltung.kurzBezeichnung fehlt oder ist ungültig (1-4 Zeichen A-Za-z0-9)')

  const anzahlPlaetze = toInt(verwaltung?.anzahlPlaetze)
  const anzahlW = toInt(verwaltung?.anzahlPlaetzeWeiblich)
  const anzahlM = toInt(verwaltung?.anzahlPlaetzeMaennlich)
  if (anzahlPlaetze === null || anzahlW === null || anzahlM === null)
    errs.push('verwaltung.anzahlPlaetze / -Weiblich / -Maennlich müssen gesetzt sein')

  const briefID = toInt(verwaltung?.briefID)
  if (briefID === null || briefID < 1 || briefID > 5) errs.push('verwaltung.briefID (Kontaktperson) fehlt')

  const ende = toDateStr(fm.ende)
  if (ende && ende < begin) errs.push(`ende (${ende}) liegt vor begin (${begin})`)

  if (errs.length > 0) return { errors: errs }

  const informRaw = typeof verwaltung?.informAnmeldecenter === 'string' ? verwaltung.informAnmeldecenter.trim() : ''
  const entry = {
    slug,
    ...(hasId ? { veranstaltungsID: rawId } : {}),
    bezeichnung: title,
    name: title,
    kurzBezeichnung: kurz,
    begin,
    ende,
    veranstaltungsort,
    vOrt: {
      strasse: typeof fm.strasse === 'string' ? fm.strasse.trim() : '',
      plz: String(fm.plz ?? '').trim(),
      ort: typeof fm.ort === 'string' ? fm.ort.trim() : '',
    },
    ort: (typeof fm.ort === 'string' && fm.ort.trim()) || veranstaltungsort,
    ...preise,
    anzahlung: toInt(fm.anzahlung, 0) ?? 0,
    kannVorortBezahltWerden: toBool01(verwaltung.kannVorortBezahltWerden),
    hatGWarteliste: toBool01(verwaltung.hatGWarteliste ?? true),
    anzahlPlaetze,
    anzahlPlaetzeWeiblich: anzahlW,
    anzahlPlaetzeMaennlich: anzahlM,
    minTNAlter: toInt(fm.minAlter, 0) ?? 0,
    maxTNAlter: toInt(fm.maxAlter, 100) ?? 100,
    briefID,
    informAnmeldecenter: informRaw || INFO_MAIL_BY_BRIEF_ID[briefID] || null,
  }
  return { entry }
}

/** veranstaltungsID zeilengenau ins Roh-Frontmatter schreiben (KEIN
 *  gray-matter.stringify — das würde das komplette Frontmatter umformatieren) */
function writeBackId(file, id) {
  const raw = fs.readFileSync(file, 'utf8')
  const lines = raw.split('\n')
  if (lines[0].trim() !== '---') throw new Error(`${file}: kein Frontmatter`)
  const end = lines.indexOf('---', 1)
  const idLine = lines.findIndex(
    (l, i) => i > 0 && i < end && /^veranstaltungsID\s*:/.test(l)
  )
  if (idLine !== -1) {
    lines[idLine] = `veranstaltungsID: ${id}`
  } else {
    lines.splice(1, 0, `veranstaltungsID: ${id}`)
  }
  fs.writeFileSync(file, lines.join('\n'))
}

// ---------------------------------------------------------------------------

if (!process.env.SYNC_TOKEN) {
  console.error('SYNC_TOKEN fehlt')
  process.exit(1)
}

const files = fs.readdirSync(CONTENT_DIR).filter((f) => f.endsWith('.md'))
const entries = []
const fileBySlug = {}

for (const f of files) {
  const slug = f.replace(/\.md$/, '')
  const full = path.join(CONTENT_DIR, f)
  let fm
  try {
    fm = matter(fs.readFileSync(full, 'utf8')).data
  } catch (e) {
    report.warnings.push(`${slug}: Frontmatter nicht parsebar (${String(e).split('\n')[0]}) — übersprungen`)
    continue
  }
  const r = buildEntry(slug, fm)
  if (r.skip) report.skipped.push(`${slug}: ${r.skip}`)
  else if (r.errors) report.errors.push(`${slug}: ${r.errors.join('; ')}`)
  else {
    entries.push(r.entry)
    fileBySlug[slug] = full
  }
}

// Duplikate (bezeichnung, begin) im Batch: beide raus (die API würde sonst
// beide auf dieselbe Zeile adoptieren)
const byKey = {}
for (const e of entries) byKey[`${e.bezeichnung}|${e.begin}`] = (byKey[`${e.bezeichnung}|${e.begin}`] ?? 0) + 1
const deduped = entries.filter((e) => {
  if (byKey[`${e.bezeichnung}|${e.begin}`] > 1) {
    report.errors.push(`${e.slug}: doppeltes (Titel, Beginn)-Paar im Content — nicht gesendet`)
    return false
  }
  return true
})

if (deduped.length > 0) {
  const res = await fetch(`${SYNC_URL}/sync/veranstaltungen`, {
    method: 'POST',
    headers: {
      Authorization: process.env.SYNC_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ dryRun: DRY_RUN, veranstaltungen: deduped }),
  })
  if (!res.ok) {
    console.error(`API-Fehler: HTTP ${res.status} ${await res.text()}`)
    process.exit(1)
  }
  const { results } = await res.json()
  for (const r of results) {
    const line = `${r.slug}: ${r.status}${r.veranstaltungsID ? ` (ID ${r.veranstaltungsID})` : ''}${r.warning ? ` — ${r.warning}` : ''}`
    if (r.status === 'error') {
      report.errors.push(`${r.slug}: ${r.error}${r.context ? ` (${r.context.join('; ')})` : ''}`)
    } else if (r.status === 'created' || r.status === 'adopted') {
      report[r.status === 'created' ? 'created' : 'adopted'].push(line)
      if (!DRY_RUN) writeBackId(fileBySlug[r.slug], r.veranstaltungsID)
    } else {
      report.updated.push(line)
    }
    if (r.warning) report.warnings.push(`${r.slug}: ${r.warning}`)
  }
}

// Report (Konsole + GitHub Step Summary)
const summaryLines = ['# Veranstaltungs-Sync' + (DRY_RUN ? ' (DRY RUN)' : ''), '']
for (const [title, list] of [
  ['Angelegt', report.created],
  ['Aktualisiert', report.updated],
  ['Adoptiert (bestehende DB-Zeile übernommen)', report.adopted],
  ['Übersprungen', report.skipped],
  ['Warnungen', report.warnings],
  ['Fehler', report.errors],
]) {
  summaryLines.push(`## ${title} (${list.length})`)
  for (const l of list) summaryLines.push(`- ${l}`)
  summaryLines.push('')
}
const summary = summaryLines.join('\n')
console.log(summary)
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
}

process.exit(report.errors.length > 0 ? 1 : 0)
