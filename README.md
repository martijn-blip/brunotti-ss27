# Brunotti SS27 · Product Data Tool

Webapp voor het beheren van de productdata van de Brunotti SS27-collectie — de vervanging van de oude Excel-workflow. Eén zelfstandig `index.html`-bestand (HTML/CSS/JavaScript, geen build-stap), gehost op GitHub Pages, met Google Drive als primaire opslag via een Google Apps Script-backend.

**Live:** https://martijn-blip.github.io/brunotti-ss27

---

## Architectuur

```
┌─────────────────┐   auto-sync (5s debounce)   ┌──────────────────────┐
│  index.html      │ ──────────────────────────► │  Google Apps Script  │
│  (GitHub Pages)  │ ◄────────────────────────── │  (Web App, doGet/    │
│                  │   load bij opstarten         │   doPost)            │
│  localStorage =  │                              └─────────┬────────────┘
│  lokale cache /  │                                        │
│  offline-vangnet │                              ┌─────────▼────────────┐
└─────────────────┘                              │  Google Drive         │
                                                  │  · latest.json (bron  │
                                                  │    van waarheid)      │
                                                  │  · Backups/ (30 stuks)│
                                                  │  · Google Sheet met   │
                                                  │    tabs per categorie │
                                                  │    + BI_Export-tab    │
                                                  └───────────────────────┘
```

- **Frontend:** `index.html` — alle code in één bestand, één `<script>`-blok. Versienummer wordt automatisch afgeleid uit de changelog-constante (`APP_VERSION = APP_CHANGELOG.find(v => v.active).version`); precies één entry mag `active: true` hebben.
- **Backend:** `backend/Code.gs` in deze repo is de bron; de draaiende kopie staat in het Apps Script-project onder martijnbrunotti@gmail.com. **Bij wijziging: code dáár plakken en de bestaande implementatie bijwerken (Deploy → Manage deployments → potloodje → New version) — nooit een nieuwe implementatie aanmaken, anders verandert de URL.**
- **Data:** Google Drive-map "Brunotti SS27 Sync" met `brunotti_ss27_latest.json` (bron van waarheid), tijdgestempelde backups (max 30), en de Google Sheet "Brunotti SS27 Data" — inclusief de platte `BI_Export`-tab voor Power BI.
- **Sync:** elke wijziging synchroniseert 5 s na de laatste aanpassing automatisch naar Drive (aan/uit in Instellingen). Vóór elke push een conflict-check via het lichte `?action=meta`-endpoint (fallback: `?action=load`). Nieuwere teamversie op Drive → geen stille overschrijving, gebruiker beslist via de handmatige knoppen.

## Ontwikkel-workflow

1. **Haal ALTIJD eerst de actuele versie op als basis:**
   `https://raw.githubusercontent.com/martijn-blip/brunotti-ss27/main/index.html`
   Nooit voortbouwen op een oudere kopie uit een chat, download of lokale map.
2. Wijziging bouwen → **eerst een lokale testversie** aan Martijn leveren (geen push, geen versie-bump).
3. Na akkoord: push naar GitHub (`PUT /repos/martijn-blip/brunotti-ss27/contents/index.html`, base64, met actuele file-SHA), versienummer +0.1, één changelog-entry per release.
4. GitHub Pages deployt automatisch (1-2 min). Verifiëren: versienummer in de app-header na harde refresh (Ctrl+F5).

### Werken met meerdere AI-chats tegelijk

Er wordt vaak in meerdere chats parallel aan deze app gewerkt. **Op 6 juli 2026 is daardoor bijna werk verloren gegaan** (twee chats bouwden allebei een "v2.3" op v2.2). De regels:

- Vóór elke bouwsessie én vóór elke push: actuele `index.html` uit de repo ophalen en daarop voortbouwen.
- Versienummer bepalen uit de changelog van dát bestand (hoogste versie + 0.1) — niet uit de eigen chathistorie.
- Bij twijfel: commitgeschiedenis checken via `GET /repos/martijn-blip/brunotti-ss27/commits`.
- Divergentie tóch ontdekt? Niet overschrijven — three-way merge (git, base = laatste gedeelde commit).

## Bekende valkuilen (duur betaald leergeld)

| Valkuil | Uitleg |
|---|---|
| **CORS bij lokale bestanden** | `fetch()` naar het Apps Script faalt vanaf `file://`. Sync werkt alleen vanaf de GitHub Pages-URL of `http://localhost` (bijv. `python -m http.server`). Lokale testversies: UI en dataflows testen kan, sync end-to-end niet. |
| **`Content-Type: text/plain`** | POST naar Apps Script moet `text/plain` zijn — `application/json` triggert een CORS-preflight die Apps Script niet beantwoordt. |
| **Implementatie bijwerken, niet vervangen** | Nieuwe Apps Script-deployment = nieuwe URL = app kapot. Altijd de bestaande implementatie een nieuwe versie geven. |
| **`parseInt()` op timestamps** | Veroorzaakte een stille bug in de newest-wins-logica. ISO-strings via `new Date(...).getTime()` vergelijken. |
| **Hardcoded versienummers** | Versie altijd afleiden uit de changelog-constante; nooit los in sync-payloads of teksten zetten. |
| **Contents-API >1MB** | `GET /contents/` geeft geen inhoud voor bestanden >1 MB; gebruik `Accept: application/vnd.github.raw` of raw.githubusercontent.com. |
| **Leveranciersnamen inconsistent** | ~36% van de bronbestand-combinaties had naamafwijkingen (afkortingen, typo's, witruimte). De Fabric Info → Leveranciers-resolver met handmatige overrides vangt dit af — voorzichtig uitbreiden. |
| **GitHub Pages cache** | Na een deploy kan de oude versie nog ~10 min geserveerd worden + browsercache. Altijd harde refresh en versienummer in de header checken vóór "de deploy werkt niet" te concluderen. |

## Roadmap

De actuele roadmap leeft **in de app**: Info → 🗺️ Roadmap (afvinkbaar, met prioriteiten). Grote lijnen: ✅ Fase 1 — Drive als primaire opslag (klaar, v2.1) · Fase 2 — oude seizoenen importeren voor cross-seizoen-vergelijking · Fase 3 — inkooplijst koppelen voor marges/aantallen per leverancier per seizoen. Koppelingen: Power BI leest de `BI_Export`-tab van de Google Sheet; Shopify via de CSV-export in het Export-menu.

## Repo-inhoud

| Bestand | Wat |
|---|---|
| `index.html` | De complete app (frontend + embedded data) |
| `backend/Code.gs` | Het Google Apps Script (kopie van de draaiende backend) |
| `README.md` | Dit bestand |
