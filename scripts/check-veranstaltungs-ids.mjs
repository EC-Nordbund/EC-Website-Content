// CI-Check für die veranstaltungsIDs im Content.
//
// Zwei Regeln:
//
// 1. EINDEUTIG — keine zwei Veranstaltungen dürfen dieselbe
//    veranstaltungsID tragen. Leer ist erlaubt, auch mehrfach. Passiert
//    typischerweise beim Duplizieren im CMS: Decap kopiert das komplette
//    Frontmatter samt ID, und der Sync würde anschließend beide Dateien auf
//    dieselbe DB-Zeile schreiben. Immer ein harter Fehler.
//
// 2. VORHANDEN — jede zukünftige Veranstaltung mit sichtbarer Anmeldung
//    braucht eine ID. Fehlt sie, sendet das Anmeldeformular ID 0 und die
//    Anmeldung landet nirgends. Standardmäßig nur eine Warnung, mit
//    --id-pflicht ein Fehler: neue Veranstaltungen bekommen ihre ID erst
//    vom Sync, deshalb ist diese Regel erst NACH dem Sync-Lauf aussagekräftig.
//
// Aufruf: node ./scripts/check-veranstaltungs-ids.mjs [--id-pflicht]
import fs from 'node:fs'
import path from 'node:path'
import matter from 'gray-matter'

const CONTENT_DIR = 'content/veranstaltung'
const ID_PFLICHT = process.argv.includes('--id-pflicht')

/** YAML-Date | 'YYYY-MM-DD'-String | sonstiges → 'YYYY-MM-DD' oder null */
function toDateStr(v) {
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10)
  if (typeof v === 'string') {
    const m = v.trim().match(/^(\d{4}-\d{2}-\d{2})/)
    if (m) return m[1]
  }
  return null
}

/** Nur positive Ganzzahlen zählen als vergebene ID — wie im Sync-Skript. */
function toId(v) {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) {
    const n = parseInt(v.trim(), 10)
    return n > 0 ? n : null
  }
  return null
}

/**
 * Sichtbarkeit wie auf der Website (pages/veranstaltungen/[id].vue):
 * ohne `visible` gilt die Anmeldung als sichtbar, sobald ein
 * anmeldung-Abschnitt existiert.
 */
function hatSichtbareAnmeldung(fm) {
  const a = fm.anmeldung
  if (!a || typeof a !== 'object') return false
  return a.visible == null ? true : !!a.visible
}

const heute = new Date().toISOString().slice(0, 10)
const proId = new Map()
const ohneId = []
const warnungen = []

for (const datei of fs.readdirSync(CONTENT_DIR).filter((f) => f.endsWith('.md'))) {
  const slug = datei.replace(/\.md$/, '')
  let fm
  try {
    fm = matter(fs.readFileSync(path.join(CONTENT_DIR, datei), 'utf8')).data
  } catch (e) {
    warnungen.push(`${slug}: Frontmatter nicht parsebar (${String(e).split('\n')[0]})`)
    continue
  }

  const id = toId(fm.veranstaltungsID)
  if (id !== null) {
    if (!proId.has(id)) proId.set(id, [])
    proId.get(id).push(slug)
    continue
  }

  const begin = toDateStr(fm.begin)
  if (begin && begin >= heute && hatSichtbareAnmeldung(fm)) {
    ohneId.push({ slug, begin })
  }
}

const doppelt = [...proId.entries()]
  .filter(([, slugs]) => slugs.length > 1)
  .sort((a, b) => a[0] - b[0])

ohneId.sort((a, b) => a.begin.localeCompare(b.begin))

const zeilen = ['# Veranstaltungs-IDs', '']
zeilen.push(`## Doppelte IDs (${doppelt.length})`)
for (const [id, slugs] of doppelt) zeilen.push(`- **${id}** — ${slugs.join(', ')}`)
if (doppelt.length === 0) zeilen.push('- keine')
zeilen.push('')
zeilen.push(
  `## Zukünftig mit Anmeldung, aber ohne ID (${ohneId.length})` +
    (ID_PFLICHT ? '' : ' — nur Hinweis, der Sync vergibt sie gleich')
)
for (const v of ohneId) zeilen.push(`- ${v.slug} (ab ${v.begin})`)
if (ohneId.length === 0) zeilen.push('- keine')
if (warnungen.length > 0) {
  zeilen.push('', `## Warnungen (${warnungen.length})`)
  for (const w of warnungen) zeilen.push(`- ${w}`)
}

const bericht = zeilen.join('\n')
console.log(bericht)
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, bericht + '\n')
}

const fehler = doppelt.length > 0 || (ID_PFLICHT && ohneId.length > 0)
if (fehler) {
  console.error('\nCheck fehlgeschlagen.')
  if (doppelt.length > 0) {
    console.error(
      'Doppelte IDs: in einer der Dateien die veranstaltungsID leeren — der ' +
        'Sync legt dann eine neue Veranstaltung an und traegt sie ein.'
    )
  }
  if (ID_PFLICHT && ohneId.length > 0) {
    console.error(
      'Fehlende IDs: der Sync hat sie nicht vergeben. Meist fehlt der ' +
        'Verwaltung-Abschnitt (kurzBezeichnung), dann laesst der Sync die ' +
        'Veranstaltung bewusst aus — oder die Anmeldung gehoert auf unsichtbar.'
    )
  }
}
process.exit(fehler ? 1 : 0)
